/**
 * The upgrade's backups from the backup module (HeoPress P13 tasks 2.1b, 2.3b; spec ops/upgrades "安全升级流程",
 * "升级写入冻结与数据不丢失"; backup module: `services/backup`, P13 1.x).
 *
 * - `takeBackup`: a full backup of the configured target and key (`runBackup`), always with the dump method — a dump
 *   restores in place, a base backup needs a server started on its data directory. It is a backup like any other:
 *   in the catalogue, under retention, restorable with `heopress backup restore`.
 * - `restoreCopy`: the dump into the rehearsal database (`pg_restore`, owners and privileges kept: the roles are on
 *   the same server).
 * - `restoreProduction`: the dump into a new database next to production, with production's database-level owner,
 *   locale, privileges and settings; then the two are swapped by renaming, so production is never half restored: if
 *   anything fails before the swap, production is as it was. After the swap the deletion ledger is replayed on it
 *   (P13 task 5.2) and a failed record fails the restore (writes stay closed). The catalogue row of the backup itself,
 *   `running` in its own dump, is set to what the backup recorded. The replaced database is kept, connections refused,
 *   until `verifyProduction` passes, then dropped.
 *   Before the swap, every table of the new database is counted against the manifest (exact for a dump): nobody
 *   uses that database yet, so the counts are the restore's alone (production keeps serving reads during
 *   maintenance, and reads write — rate limits, caches, visit counts — so production's own counts move).
 * - `verifyProduction`: production is the database that was restored and checked, and its migration history is the
 *   backup's.
 *
 * Restoring production needs the owner role to create, rename and drop databases (the owner of the Compose
 * deployment's database is its superuser). Media are not restored: an upgrade does not change them.
 */
import { rm } from 'node:fs/promises';
import postgres from 'postgres';
import type { Database } from '@heopress/database';
import type { KeyProvider, StorageProvider } from '@heopress/runtime';
import { runBackup, workDir, type BackupDeps } from '../../backup/backup-service';
import { backupConfigFromEnv } from '../../backup/config';
import { loadBackupKey } from '../../backup/crypto';
import { rowCounts } from '../../backup/database-backup';
import { replayLedgerAfterRestore } from '../../backup/ledger-replay';
import { findPgTool, parsePgUrl, pgEnv, redactConn, runTool, withDatabase } from '../../backup/pg-tools';
import type { BackupManifest } from '../../backup/manifest';
import { materializeDatabase, resolveChain } from '../../backup/restore';
import { instanceMediaSource, profileMediaSource } from '../../backup/media-backup';
import { deletionLedgerSinkFromEnv, type DeletionLedgerSink } from '../../retention/deletion-ledger';
import type { UpgradeBackupProvider, UpgradeBackupRef } from '../ports';

export interface BackupModuleProviderDeps {
  /** What the backup worker uses (`createBackupWorker`'s dependencies); the method is forced to `dump`. */
  backup: BackupDeps;
  /** The owner connection of production. */
  productionDatabaseUrl: string;
  /** Where the media are, for the deletion ledger replay. */
  storage: StorageProvider;
  /** The external deletion ledger (`deletionLedgerSinkFromEnv`). */
  ledgerSink: DeletionLedgerSink | null;
}

const RESTORE_TIMEOUT_MS = 6 * 60 * 60 * 1000;

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;
const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;

function admin(url: string): postgres.Sql {
  return postgres(url, { max: 1, prepare: false, onnotice: () => {}, fetch_types: false, connect_timeout: 15 });
}

/** `pg_restore` a dump into an empty database, keeping owners and privileges. */
async function pgRestore(file: string, databaseUrl: string, pgBinDir: string | null): Promise<void> {
  const conn = parsePgUrl(databaseUrl);
  await runTool(await findPgTool('pg_restore', pgBinDir), ['--exit-on-error', '--no-password', '-d', conn.database, file], { env: pgEnv(conn), timeoutMs: RESTORE_TIMEOUT_MS });
}

export class BackupModuleUpgradeProvider implements UpgradeBackupProvider {
  readonly name: string;
  /** By backup id: the database a restore replaced (dropped once the restore verifies) and the one it put in place. */
  private readonly restored = new Map<string, { replaced: string; oid: number }>();

  constructor(private readonly deps: BackupModuleProviderDeps) {
    this.name = `backup module (${deps.backup.config.target.description})`;
  }

  private key(): Promise<Buffer | null> {
    const { config } = this.deps.backup;
    return config.keyFile ? loadBackupKey(config.keyFile, config.target.localRoot) : Promise.resolve(null);
  }

  async takeBackup(): Promise<UpgradeBackupRef> {
    const deps: BackupDeps = { ...this.deps.backup, config: { ...this.deps.backup.config, method: 'dump' } };
    const row = await runBackup(deps, { kind: 'full', trigger: 'manual', requestedBy: null });
    if (row.status !== 'succeeded') throw new Error(`backup ${row.id} failed: ${row.error ?? 'no reason recorded'}`);
    return { id: row.id, takenAt: (row.finishedAt ?? new Date()).toISOString(), ...(row.manifestSha256 ? { manifestSha256: row.manifestSha256 } : {}) };
  }

  /** The dump of a backup, materialised in a work directory the caller removes. */
  private async dumpOf(id: string): Promise<{ file: string; work: string; manifest: BackupManifest }> {
    const { config } = this.deps.backup;
    const key = await this.key();
    const chain = await resolveChain(config.target, id, key);
    const work = await workDir('hpup-');
    try {
      const db = await materializeDatabase(config.target, chain, key, work, config.pgBinDir);
      if (db.kind !== 'dump') throw new Error(`backup ${id} is a base backup: an upgrade restores dumps only`);
      return { file: db.file, work, manifest: chain.at(-1)! };
    } catch (err) {
      await rm(work, { recursive: true, force: true });
      throw err;
    }
  }

  async restoreCopy(backup: UpgradeBackupRef, target: { databaseUrl: string }): Promise<void> {
    const { file, work } = await this.dumpOf(backup.id);
    try {
      await pgRestore(file, target.databaseUrl, this.deps.backup.config.pgBinDir);
    } catch (err) {
      throw new Error(redactConn(err instanceof Error ? err.message : String(err)));
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  async restoreProduction(backup: UpgradeBackupRef): Promise<void> {
    const prodUrl = this.deps.productionDatabaseUrl;
    const prod = parsePgUrl(prodUrl).database;
    const suffix = backup.id.replace(/[^A-Za-z0-9]/g, '').slice(-12).toLowerCase();
    const fresh = `${prod.slice(0, 40)}_hprs_${suffix}`;
    const replaced = `${prod.slice(0, 40)}_hpold_${suffix}`;
    const { file, work, manifest } = await this.dumpOf(backup.id);
    const server = admin(withDatabase(prodUrl, 'postgres'));
    try {
      // 1. The new database, as production is: owner, locale, connection limit.
      const [p] = await server<Array<{ oid: number; owner: string; enc: string; collate: string; ctype: string; provider: string; locale: string | null; connlimit: number; acl: string | null }>>`
        SELECT d.oid::int AS oid, pg_get_userbyid(d.datdba) AS owner, pg_encoding_to_char(d.encoding) AS enc, d.datcollate AS collate,
               d.datctype AS ctype, d.datlocprovider::text AS provider, d.datlocale AS locale, d.datconnlimit AS connlimit, d.datacl::text AS acl
          FROM pg_database d WHERE d.datname = ${prod}`;
      if (!p) throw new Error(`production database ${prod} not found`);
      await server.unsafe(`DROP DATABASE IF EXISTS ${ident(fresh)} WITH (FORCE)`);
      const locale =
        p.provider === 'i' ? `LOCALE_PROVIDER icu ICU_LOCALE ${literal(p.locale ?? '')}` : p.provider === 'b' ? `LOCALE_PROVIDER builtin BUILTIN_LOCALE ${literal(p.locale ?? '')}` : 'LOCALE_PROVIDER libc';
      await server.unsafe(
        `CREATE DATABASE ${ident(fresh)} WITH TEMPLATE template0 OWNER ${ident(p.owner)} ENCODING ${literal(p.enc)} LC_COLLATE ${literal(p.collate)} LC_CTYPE ${literal(p.ctype)} ${locale} CONNECTION LIMIT ${p.connlimit}`,
      );
      try {
        // 2. The dump, then production's database-level privileges and settings.
        await pgRestore(file, withDatabase(prodUrl, fresh), this.deps.backup.config.pgBinDir);
        if (p.acl !== null) {
          await server.unsafe(`REVOKE ALL ON DATABASE ${ident(fresh)} FROM PUBLIC`);
          const grants = await server<Array<{ grantee: string; privilege: string; grantable: boolean }>>`
            SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(a.grantee)) END AS grantee, a.privilege_type AS privilege,
                   a.is_grantable AS grantable
              FROM pg_database d, aclexplode(d.datacl) a WHERE d.datname = ${prod}`;
          for (const g of grants) await server.unsafe(`GRANT ${g.privilege} ON DATABASE ${ident(fresh)} TO ${g.grantee}${g.grantable ? ' WITH GRANT OPTION' : ''}`);
        }
        const settings = await server<Array<{ role: string | null; name: string; value: string }>>`
          SELECT CASE WHEN s.setrole = 0 THEN NULL ELSE pg_get_userbyid(s.setrole) END AS role, split_part(c, '=', 1) AS name, substr(c, strpos(c, '=') + 1) AS value
            FROM pg_db_role_setting s, unnest(s.setconfig) c WHERE s.setdatabase = ${p.oid}`;
        for (const s of settings) {
          await server.unsafe(`ALTER ${s.role ? `ROLE ${ident(s.role)} IN ` : ''}DATABASE ${ident(fresh)} SET ${ident(s.name)} TO ${literal(s.value)}`);
        }
        // 3. Every table against the manifest, while nobody uses the new database.
        const fresher = admin(withDatabase(prodUrl, fresh));
        try {
          const counts = await rowCounts(fresher);
          const differences = countDifferences(manifest, counts);
          if (differences.length > 0) throw new Error(`the restored database does not match backup ${backup.id}: ${differences.slice(0, 5).join('; ')}`);
        } finally {
          await fresher.end({ timeout: 5 });
        }
        // 4. The backup's own catalogue row is `running` in its dump: what the backup recorded when it finished.
        const recorded = admin(prodUrl);
        try {
          const [row] = await recorded<Array<Record<string, unknown>>>`
            SELECT status, manifest_sha256, size_bytes, object_count, media_objects, media_new, recovery_point, finished_at, error
              FROM lumibase_backups WHERE id = ${backup.id}`;
          if (row) {
            const restored = admin(withDatabase(prodUrl, fresh));
            try {
              await restored`
                UPDATE lumibase_backups SET status = ${row.status as string}, manifest_sha256 = ${row.manifest_sha256 as string | null},
                       size_bytes = ${row.size_bytes as string | null}, object_count = ${row.object_count as number | null},
                       media_objects = ${row.media_objects as number | null}, media_new = ${row.media_new as number | null},
                       recovery_point = ${row.recovery_point as Date | null}, finished_at = ${row.finished_at as Date | null}, error = ${row.error as string | null}
                 WHERE id = ${backup.id}`;
            } finally {
              await restored.end({ timeout: 5 });
            }
          }
        } finally {
          await recorded.end({ timeout: 5 });
        }
      } catch (err) {
        await server.unsafe(`DROP DATABASE IF EXISTS ${ident(fresh)} WITH (FORCE)`).catch(() => undefined);
        throw err;
      }

      // 5. The swap: production refuses new sessions, its sessions end, and the names change.
      await server.unsafe(`DROP DATABASE IF EXISTS ${ident(replaced)} WITH (FORCE)`);
      await server.unsafe(`ALTER DATABASE ${ident(prod)} ALLOW_CONNECTIONS false`);
      try {
        for (let attempt = 1; ; attempt++) {
          await server`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${prod} AND pid <> pg_backend_pid()`;
          try {
            await server.unsafe(`ALTER DATABASE ${ident(prod)} RENAME TO ${ident(replaced)}`);
            break;
          } catch (err) {
            if (attempt >= 40 || !/being accessed by other users/.test((err as Error).message)) throw err;
            await new Promise((r) => setTimeout(r, 50));
          }
        }
      } catch (err) {
        await server.unsafe(`ALTER DATABASE ${ident(prod)} ALLOW_CONNECTIONS true`).catch(() => undefined);
        await server.unsafe(`DROP DATABASE IF EXISTS ${ident(fresh)} WITH (FORCE)`).catch(() => undefined);
        throw err;
      }
      try {
        await server.unsafe(`ALTER DATABASE ${ident(fresh)} RENAME TO ${ident(prod)}`);
      } catch (err) {
        await server.unsafe(`ALTER DATABASE ${ident(replaced)} RENAME TO ${ident(prod)}`).catch(() => undefined);
        await server.unsafe(`ALTER DATABASE ${ident(prod)} ALLOW_CONNECTIONS true`).catch(() => undefined);
        throw err;
      }
      const [now] = await server<Array<{ oid: number }>>`SELECT oid::int AS oid FROM pg_database WHERE datname = ${prod}`;
      this.restored.set(backup.id, { replaced, oid: now!.oid });

      // 6. Before writes may open: the deletion ledger, on the restored database.
      const replay = await replayLedgerAfterRestore({ databaseUrl: prodUrl, storage: this.deps.storage, sink: this.deps.ledgerSink });
      if (!replay.writesMayOpen) {
        throw new Error(`the deletion ledger replay failed for ${replay.report.failed} record(s): writes must stay closed until they are deleted again`);
      }
    } catch (err) {
      throw new Error(redactConn(err instanceof Error ? err.message : String(err)));
    } finally {
      await server.end({ timeout: 5 });
      await rm(work, { recursive: true, force: true });
    }
  }

  async verifyProduction(backup: UpgradeBackupRef): Promise<{ ok: boolean; problems: string[] }> {
    const { config } = this.deps.backup;
    const manifest = (await resolveChain(config.target, backup.id, await this.key())).at(-1)!;
    const prodUrl = this.deps.productionDatabaseUrl;
    const prod = parsePgUrl(prodUrl).database;
    const done = this.restored.get(backup.id);
    const problems: string[] = [];
    const server = admin(withDatabase(prodUrl, 'postgres'));
    const sql = admin(prodUrl);
    try {
      const [now] = await server<Array<{ oid: number }>>`SELECT oid::int AS oid FROM pg_database WHERE datname = ${prod}`;
      if (!done) problems.push(`production was not restored from ${backup.id} by this run`);
      else if (now?.oid !== done.oid) problems.push(`production is not the database restored from ${backup.id}`);
      const [h] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`;
      const expected = manifest.database.rowCounts['drizzle.__drizzle_migrations'];
      if (expected !== undefined && h?.n !== expected) problems.push(`production has ${h?.n ?? 0} migrations applied, the backup ${expected}`);
      if (problems.length === 0 && done) {
        await server.unsafe(`DROP DATABASE IF EXISTS ${ident(done.replaced)} WITH (FORCE)`);
        this.restored.delete(backup.id);
      } else if (done) {
        problems.push(`the replaced database is kept as ${done.replaced} (connections refused)`);
      }
    } finally {
      await sql.end({ timeout: 5 });
      await server.end({ timeout: 5 });
    }
    return { ok: problems.length === 0, problems };
  }
}

/** Tables whose row count differs from the manifest, or that one side lacks (exact counts only: a dump's). */
export function countDifferences(manifest: Pick<BackupManifest, 'database'>, counts: Record<string, number>): string[] {
  const out: string[] = [];
  for (const [table, expected] of Object.entries(manifest.database.rowCounts)) {
    const got = counts[table];
    if (got === undefined) out.push(`${table} is missing`);
    else if (got !== expected && manifest.database.rowCountsExact) out.push(`${table} has ${got} rows, the backup ${expected}`);
  }
  for (const table of Object.keys(counts)) if (!(table in manifest.database.rowCounts)) out.push(`${table} is not in the backup`);
  return out;
}

/** The provider as the backup worker is configured (`HEOPRESS_BACKUP_*`, the same media sources and deletion ledger). */
export function backupModuleProviderFromEnv(deps: {
  env: Record<string, string | undefined>;
  db: Database;
  storage: StorageProvider;
  keys: KeyProvider;
  app: { version: string; gitSha: string };
  productionDatabaseUrl: string;
}): BackupModuleUpgradeProvider {
  const config = backupConfigFromEnv(deps.env);
  return new BackupModuleUpgradeProvider({
    backup: {
      db: deps.db,
      config,
      env: deps.env,
      app: deps.app,
      mediaSources: [
        instanceMediaSource(deps.storage),
        profileMediaSource(deps.db, { keys: deps.keys, defaultStorage: deps.storage, storageDir: deps.env.HEOPRESS_STORAGE_DIR?.trim() || undefined }),
      ],
    },
    productionDatabaseUrl: deps.productionDatabaseUrl,
    storage: deps.storage,
    ledgerSink: deletionLedgerSinkFromEnv(deps.env, deps.storage),
  });
}
