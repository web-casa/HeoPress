import { readFile } from 'node:fs/promises';
import path from 'node:path';
import postgres from 'postgres';
import { findPgTool, parsePgUrl, pgEnv, runTool } from './pg-tools';

/**
 * The database part of a backup (HeoPress P13 tasks 1.1, 1.5; design "恢复链、导入与升级补充").
 *
 * - `basebackup`: a physical copy with `pg_basebackup` (plain format, WAL streamed into it). A full one each day, and
 *   incrementals against the previous backup's `backup_manifest` (PostgreSQL 17+). An incremental needs
 *   `summarize_wal = on`, `wal_level` replica or logical and a role with REPLICATION; without them it fails, and says
 *   which is missing (`incrementalPrerequisites`). Restoring needs the whole chain (`pg_combinebackup`).
 * - `dump`: `pg_dump` (custom format) of the database, full only — the small-VPS option. Row counts are taken in the
 *   same snapshot (`pg_export_snapshot`), so a drill can compare them exactly.
 */

type Sql = postgres.Sql | postgres.TransactionSql;

export interface DatabaseInfo {
  serverVersion: string;
  systemIdentifier: string | null;
  startLsn: string | null;
  rowCounts: Record<string, number>;
  rowCountsExact: boolean;
  recoveryPoint: string;
}

function connect(url: string): postgres.Sql {
  return postgres(url, { max: 1, prepare: false, onnotice: () => {}, connect_timeout: 15, idle_timeout: 5 });
}

/** Row count of every user table (`schema.table`). */
export async function rowCounts(sql: Sql): Promise<Record<string, number>> {
  const tables = await sql<{ s: string; t: string }[]>`
    SELECT schemaname AS s, tablename AS t FROM pg_tables
     WHERE schemaname NOT IN ('pg_catalog', 'information_schema') AND schemaname NOT LIKE 'pg\\_%'
     ORDER BY 1, 2`;
  const out: Record<string, number> = {};
  for (const { s, t } of tables) {
    const [row] = await sql.unsafe<{ n: string }[]>(`SELECT count(*)::text AS n FROM "${s.replace(/"/g, '""')}"."${t.replace(/"/g, '""')}"`);
    out[`${s}.${t}`] = Number(row?.n ?? 0);
  }
  return out;
}

async function serverInfo(sql: Sql): Promise<{ serverVersion: string; major: number; systemIdentifier: string | null }> {
  const [v] = await sql<{ v: string; n: string }[]>`SELECT current_setting('server_version') AS v, current_setting('server_version_num') AS n`;
  let systemIdentifier: string | null = null;
  try {
    const [s] = await sql<{ id: string }[]>`SELECT system_identifier::text AS id FROM pg_control_system()`;
    systemIdentifier = s?.id ?? null;
  } catch {
    systemIdentifier = null;
  }
  return { serverVersion: v!.v, major: Math.floor(Number(v!.n) / 10000), systemIdentifier };
}

/** What stops an incremental backup on this server and role (empty: nothing). */
export async function incrementalPrerequisites(databaseUrl: string): Promise<string[]> {
  const sql = connect(databaseUrl);
  try {
    const problems: string[] = [];
    const { major } = await serverInfo(sql);
    if (major < 17) problems.push(`PostgreSQL ${major} has no incremental backups (17 or later).`);
    const [s] = await sql<{ summarize: string; level: string }[]>`SELECT current_setting('summarize_wal', true) AS summarize, current_setting('wal_level') AS level`;
    if (s?.summarize !== 'on') problems.push('summarize_wal is off (set summarize_wal = on).');
    if (s?.level !== 'replica' && s?.level !== 'logical') problems.push(`wal_level is ${s?.level ?? 'unknown'} (replica or logical is needed).`);
    const [r] = await sql<{ ok: boolean }[]>`SELECT (rolreplication OR rolsuper) AS ok FROM pg_roles WHERE rolname = current_user`;
    if (!r?.ok) problems.push('The backup role has no REPLICATION privilege.');
    return problems;
  } finally {
    await sql.end({ timeout: 2 });
  }
}

/**
 * `pg_basebackup` into `dir` (which must not exist yet); an incremental when `incrementalManifest` (the parent's
 * `backup_manifest`) is given.
 */
export async function takeBasebackup(opts: { databaseUrl: string; dir: string; label: string; pgBinDir: string | null; incrementalManifest?: string }): Promise<DatabaseInfo> {
  const sql = connect(opts.databaseUrl);
  let info: Awaited<ReturnType<typeof serverInfo>>;
  let counts: Record<string, number>;
  try {
    info = await serverInfo(sql);
    counts = await sql.begin('ISOLATION LEVEL REPEATABLE READ READ ONLY', (tx) => rowCounts(tx));
  } finally {
    await sql.end({ timeout: 2 });
  }
  const bin = await findPgTool('pg_basebackup', opts.pgBinDir);
  const args = ['-D', opts.dir, '-Fp', '-X', 'stream', '-c', 'fast', '--no-password', '-l', opts.label.slice(0, 100)];
  if (opts.incrementalManifest) args.push(`--incremental=${opts.incrementalManifest}`);
  await runTool(bin, args, { env: pgEnv(parsePgUrl(opts.databaseUrl)), timeoutMs: 6 * 60 * 60 * 1000 });
  const label = await readFile(path.join(opts.dir, 'backup_label'), 'utf8').catch(() => '');
  const startLsn = /START WAL LOCATION: ([0-9A-F]+\/[0-9A-F]+)/i.exec(label)?.[1] ?? null;
  return {
    serverVersion: info.serverVersion,
    systemIdentifier: info.systemIdentifier,
    startLsn,
    rowCounts: counts,
    rowCountsExact: false,
    recoveryPoint: new Date().toISOString(),
  };
}

/** `pg_dump` (custom format) to `file`, with row counts from the same snapshot. */
export async function takeDump(opts: { databaseUrl: string; file: string; pgBinDir: string | null }): Promise<DatabaseInfo> {
  const bin = await findPgTool('pg_dump', opts.pgBinDir);
  const sql = connect(opts.databaseUrl);
  try {
    const info = await serverInfo(sql);
    return await sql.begin('ISOLATION LEVEL REPEATABLE READ READ ONLY', async (tx) => {
      const [snap] = await tx<{ id: string; lsn: string | null }[]>`SELECT pg_export_snapshot() AS id, pg_current_wal_lsn()::text AS lsn`;
      const counts = await rowCounts(tx);
      const at = new Date().toISOString();
      await runTool(bin, ['--format=custom', `--snapshot=${snap!.id}`, '--no-password', '--file', opts.file], {
        env: pgEnv(parsePgUrl(opts.databaseUrl)),
        timeoutMs: 6 * 60 * 60 * 1000,
      });
      return { serverVersion: info.serverVersion, systemIdentifier: info.systemIdentifier, startLsn: snap!.lsn, rowCounts: counts, rowCountsExact: true, recoveryPoint: at };
    });
  } finally {
    await sql.end({ timeout: 2 });
  }
}
