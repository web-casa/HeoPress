import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { and, desc, eq, ne } from 'drizzle-orm';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { backupDrills, backups, schema, type Database } from '@heopress/database';
import { LocalFileStorageProvider } from '@heopress/runtime/docker';
import { workDir } from './backup-service';
import type { BackupConfig } from './config';
import { loadBackupKey } from './crypto';
import { rowCounts } from './database-backup';
import { withBackupLock } from './lock';
import { backupDir, type BackupManifest } from './manifest';
import { notifyInstanceAdministrator } from './notify';
import { openObject } from './objects';
import { describeConn, findPgTool, parsePgUrl, redactConn, runTool, withDatabase } from './pg-tools';
import { renderSmoke, type SmokeResult } from './render-smoke';
import { materializeDatabase, resolveChain, restoreDump, restoreMedia } from './restore';
import { replayDeletionLedger, type DeletionLedgerEntry, type DeletionLedgerSink } from '../retention/deletion-ledger';

/**
 * The automatic restore drill (HeoPress P13 tasks 1.3, 1.5; spec ops/backup-restore "自动恢复演练", "一致备份与隔离恢复").
 *
 * "A backup exists" is not "it restores": every week the latest backup is restored into a temporary environment and
 * checked — the chain and each manifest, every database and configuration object and every media object against its
 * SHA-256, the database restored into a temporary database (dump) or a temporary server (base backup, combined and
 * verified), the row counts against the manifest, the deletion ledger replayed on the copy (as a restore must before
 * writes open: erased personal data does not come back, and every record can be deleted again), and a read-only
 * rendering smoke test. The result is recorded
 * (`lumibase_backup_drills`), and a failure is reported to the instance administrator with what failed.
 *
 * Isolation: the restored copy never meets production. The temporary server listens on a private socket only (no
 * TCP); a temporary database is a new database, never the production one; restored media go to a temporary directory;
 * no worker, queue or scheduler runs against the copy, the production keys are never given to it (sealed credentials
 * stay sealed), and outbound requests are refused for the drill's duration — any attempt fails the drill. The external
 * deletion ledger is read before that (it may be in the object store) and only read: the replay writes to the copy.
 */

export interface DrillDeps {
  db: Database;
  config: BackupConfig;
  /** The production database the application uses: the drill refuses to restore into it. */
  productionDatabaseUrl: string;
  /** The external deletion ledger (`deletionLedgerSinkFromEnv`): read, then replayed on the copy. Null: the table only. */
  ledgerSink?: DeletionLedgerSink | null;
  /** The smoke test (default: the Classic renderer). */
  smoke?: (db: Database) => Promise<SmokeResult>;
}

interface DrillCheck {
  name: 'manifest' | 'objects' | 'media' | 'database' | 'row_counts' | 'ledger_replay' | 'render_smoke' | 'isolation';
  status: 'passed' | 'failed' | 'skipped';
  detail?: string;
}

interface DrillFailure {
  check: DrillCheck['name'];
  object?: string;
  message: string;
}

export interface DrillReport {
  backupId: string | null;
  chain: string[];
  method: string | null;
  startedAt: string;
  finishedAt: string;
  checks: DrillCheck[];
  failures: DrillFailure[];
  rowCounts?: { tables: number; exact: boolean; differences: Array<{ table: string; expected: number; restored: number | null }> };
  smoke?: SmokeResult;
  media?: { objects: number; restored: number };
  /** The deletion ledger's replay on the copy. */
  ledger?: { records: number; deletedAgain: number; alreadyAbsent: number; failed: number; sources: string[] };
  /** Where the copy was restored (without credentials). */
  restoredInto?: string;
  networkAttempts: string[];
}

export type DrillRow = typeof backupDrills.$inferSelect;

/** Ask for a drill now: a `queued` row the worker's backup tick takes up. */
export async function requestDrill(db: Database, input: { requestedBy: string | null; backupId?: string | null }): Promise<DrillRow> {
  const [row] = await db.insert(backupDrills).values({ status: 'queued', trigger: 'manual', requestedBy: input.requestedBy, backupId: input.backupId ?? null }).returning();
  return row!;
}

export async function listDrills(db: Database, limit = 20): Promise<DrillRow[]> {
  return db.select().from(backupDrills).orderBy(desc(backupDrills.createdAt)).limit(limit);
}

/** Refuse outbound requests while `fn` runs; every attempt is recorded. */
async function withoutNetwork<T>(attempts: string[], fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    let host = 'unknown';
    try {
      host = new URL(url).host;
    } catch {
      /* keep unknown */
    }
    attempts.push(host);
    throw new Error('A restore drill makes no outbound requests.');
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

/** Two connections point at the same database (host, port and name). */
function sameDatabase(a: string, b: string): boolean {
  try {
    return describeConn(parsePgUrl(a)) === describeConn(parsePgUrl(b));
  } catch {
    return false;
  }
}

/** A temporary PostgreSQL server on a restored data directory: a private socket, no TCP, read-only sessions. */
async function startTemporaryServer(dataDir: string, work: string, pgBinDir: string | null): Promise<{ socketDir: string; port: number; stop: () => Promise<void> }> {
  const pgCtl = await findPgTool('pg_ctl', pgBinDir);
  const socketDir = path.join(work, 's');
  await mkdir(socketDir, { mode: 0o700 });
  const hba = path.join(work, 'pg_hba.conf');
  await writeFile(hba, 'local all all trust\n', { mode: 0o600 });
  const port = 20000 + Math.floor(Math.random() * 30000);
  const options = [
    "-c listen_addresses=''",
    `-c unix_socket_directories=${socketDir}`,
    `-p ${port}`,
    `-c hba_file=${hba}`,
    '-c archive_mode=off',
    '-c summarize_wal=off',
    "-c shared_preload_libraries=''",
    '-c max_wal_senders=0',
    '-c default_transaction_read_only=on',
    '-c ssl=off',
    '-c logging_collector=off',
  ].join(' ');
  const env = { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C', TZ: 'UTC' };
  await runTool(pgCtl, ['-D', dataDir, '-w', '-t', '300', '-l', path.join(work, 'server.log'), '-o', options, 'start'], { env, timeoutMs: 320_000 });
  return {
    socketDir,
    port,
    stop: async () => {
      await runTool(pgCtl, ['-D', dataDir, '-m', 'immediate', '-w', 'stop'], { env, timeoutMs: 60_000 }).catch(() => undefined);
    },
  };
}

/**
 * Run a drill on `backupId` (default: the latest successful backup). Resolves with the drill row, `passed` or
 * `failed`, its report attached.
 */
export async function runRestoreDrill(deps: DrillDeps, req: { backupId?: string; trigger: 'schedule' | 'manual'; requestedBy?: string | null; queuedId?: string }): Promise<DrillRow> {
  const { db, config } = deps;
  const startedAt = new Date();
  const drillId: string = req.queuedId ?? (await db.insert(backupDrills).values({ status: 'running', trigger: req.trigger, requestedBy: req.requestedBy ?? null, startedAt }).returning())[0]!.id;
  if (req.queuedId) await db.update(backupDrills).set({ status: 'running', startedAt }).where(eq(backupDrills.id, drillId));

  const report: DrillReport = { backupId: null, chain: [], method: null, startedAt: startedAt.toISOString(), finishedAt: '', checks: [], failures: [], networkAttempts: [] };
  const check = (name: DrillCheck['name'], status: DrillCheck['status'], detail?: string) => report.checks.push({ name, status, ...(detail ? { detail } : {}) });
  const fail = (c: DrillCheck['name'], message: string, object?: string) => report.failures.push({ check: c, message: redactConn(message), ...(object ? { object } : {}) });

  // The external ledger, read before the drill's isolation starts (an object-store ledger is a network read).
  let ledger: { name: string; entries: DeletionLedgerEntry[] } | null = null;
  let ledgerError: string | null = null;
  if (deps.ledgerSink) {
    try {
      ledger = { name: deps.ledgerSink.name, entries: await deps.ledgerSink.readAll() };
    } catch (err) {
      ledgerError = err instanceof Error ? err.message : String(err);
    }
  }

  const work = await workDir('hpdr-');
  try {
    await withBackupLock(config.databaseUrl, () =>
      withoutNetwork(report.networkAttempts, async () => {
        // Nothing else runs under the lock: another `running` drill was interrupted.
        await db
          .update(backupDrills)
          .set({ status: 'failed', report: { interrupted: true }, finishedAt: new Date() })
          .where(and(eq(backupDrills.status, 'running'), ne(backupDrills.id, drillId)));
        let backupId = req.backupId ?? null;
        if (!backupId) {
          const [latest] = await db.select({ id: backups.id }).from(backups).where(eq(backups.status, 'succeeded')).orderBy(desc(backups.createdAt)).limit(1);
          backupId = latest?.id ?? null;
        }
        if (!backupId) {
          check('manifest', 'failed', 'There is no successful backup to restore.');
          fail('manifest', 'There is no successful backup to restore.');
          return;
        }
        report.backupId = backupId;
        const key = config.keyFile ? await loadBackupKey(config.keyFile, config.target.localRoot) : null;

        // 1. The chain and its manifests.
        let chain: BackupManifest[];
        try {
          chain = await resolveChain(config.target, backupId, key);
        } catch (err) {
          check('manifest', 'failed', err instanceof Error ? err.message : String(err));
          fail('manifest', err instanceof Error ? err.message : String(err));
          return;
        }
        const last = chain.at(-1)!;
        report.chain = chain.map((m) => m.id);
        report.method = last.method;
        check('manifest', 'passed', `${chain.length} manifest(s)`);

        // 2. Configuration objects (database objects are checked as they are restored below).
        let objectFailures = 0;
        for (const m of chain) {
          for (const o of m.objects.filter((x) => x.role === 'config')) {
            try {
              for await (const _ of await openObject(config.target, `${backupDir(m.id)}/${o.path}`, o, key)) void _;
            } catch (err) {
              objectFailures++;
              fail('objects', err instanceof Error ? err.message : String(err), `${m.id}/${o.path}`);
            }
          }
        }

        // 3. Media, into temporary storage.
        const mediaDir = path.join(work, 'media');
        const stores = new Map<string, LocalFileStorageProvider>();
        const media = await restoreMedia(config.target, last, key, (store) => {
          let s = stores.get(store);
          if (!s) {
            s = new LocalFileStorageProvider(path.join(mediaDir, store.replace(/[^A-Za-z0-9_-]/g, '_')));
            stores.set(store, s);
          }
          return s;
        });
        report.media = { objects: last.media.entries.length, restored: media.restored };
        for (const f of media.failures) fail('media', f.message, `${f.store}/${f.key}`);
        check('media', media.failures.length ? 'failed' : 'passed', `${media.restored} of ${last.media.entries.length} object(s) restored`);

        // 4. The database, into a temporary database or server.
        let restoredDb: { db: Database; close: () => Promise<void> } | null = null;
        // A writable session on the copy, for the ledger replay only.
        let openWritable: (() => { db: Database; ready?: PromiseLike<unknown>; close: () => Promise<void> }) | null = null;
        let cleanup: (() => Promise<void>) | null = null;
        try {
          const materialized = await materializeDatabase(config.target, chain, key, path.join(work, 'db'), config.pgBinDir);
          check('objects', objectFailures ? 'failed' : 'passed', `${chain.reduce((n, m) => n + m.objects.length, 0)} object(s)`);
          if (materialized.kind === 'dump') {
            const maintenance = config.drillDatabaseUrl ?? withDatabase(config.databaseUrl, 'postgres');
            const name = `heopress_drill_${randomBytes(6).toString('hex')}`;
            const url = withDatabase(maintenance, name);
            if (sameDatabase(url, deps.productionDatabaseUrl)) throw new Error('The drill database would be the production database.');
            const admin = postgres(maintenance, { max: 1, prepare: false, onnotice: () => {} });
            try {
              await admin.unsafe(`CREATE DATABASE "${name}"`);
            } finally {
              await admin.end({ timeout: 2 });
            }
            cleanup = async () => {
              const a = postgres(maintenance, { max: 1, prepare: false, onnotice: () => {} });
              await a.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => undefined);
              await a.end({ timeout: 2 });
            };
            await restoreDump(materialized.file, url, config.pgBinDir);
            report.restoredInto = `temporary database ${describeConn(parsePgUrl(url))}`;
            const client = postgres(url, { max: 2, prepare: false, onnotice: () => {}, connection: { default_transaction_read_only: true } });
            restoredDb = { db: drizzle(client, { schema }) as unknown as Database, close: () => client.end({ timeout: 2 }) };
            openWritable = () => {
              const c = postgres(url, { max: 2, prepare: false, onnotice: () => {} });
              return { db: drizzle(c, { schema }) as unknown as Database, close: () => c.end({ timeout: 2 }) };
            };
          } else {
            const server = await startTemporaryServer(materialized.dataDir, work, config.pgBinDir);
            cleanup = server.stop;
            const conn = parsePgUrl(config.databaseUrl);
            report.restoredInto = 'temporary server (private socket, no TCP)';
            const socket = path.join(server.socketDir, `.s.PGSQL.${server.port}`);
            const client = postgres({ path: socket, user: conn.user, database: conn.database, max: 2, prepare: false, onnotice: () => {} });
            restoredDb = { db: drizzle(client, { schema }) as unknown as Database, close: () => client.end({ timeout: 2 }) };
            openWritable = () => {
              // The server's sessions are read-only by default: one connection, made writable for the replay.
              const c = postgres({ path: socket, user: conn.user, database: conn.database, max: 1, prepare: false, onnotice: () => {} });
              const ready = c`SET default_transaction_read_only = off`;
              return { db: drizzle(c, { schema }) as unknown as Database, ready, close: () => c.end({ timeout: 2 }) };
            };
          }
          check('database', 'passed', report.restoredInto);

          // 5. Row counts.
          const restored = await rowCounts(postgresOf(restoredDb.db));
          const differences: NonNullable<DrillReport['rowCounts']>['differences'] = [];
          for (const [table, expected] of Object.entries(last.database.rowCounts)) {
            const got = restored[table] ?? null;
            if (got === expected) continue;
            differences.push({ table, expected, restored: got });
            // A base backup's counts were taken at its start (the copy is consistent at its end, its files checked by
            // pg_verifybackup): only a missing table fails, the rest is reported as moved during the backup.
            if (last.database.rowCountsExact || got === null) fail('row_counts', `${table}: ${got === null ? 'missing' : got} rows restored, ${expected} expected.`, table);
          }
          report.rowCounts = { tables: Object.keys(last.database.rowCounts).length, exact: last.database.rowCountsExact, differences: differences.slice(0, 200) };
          check('row_counts', report.failures.some((f) => f.check === 'row_counts') ? 'failed' : 'passed', `${report.rowCounts.tables} table(s)${differences.length ? `, ${differences.length} moved during the backup` : ''}`);

          // 6. The deletion ledger, replayed on the copy as a restore does before writes open (P13 task 5.2).
          if (ledgerError !== null) {
            fail('ledger_replay', `The deletion ledger could not be read: ${ledgerError}`);
            check('ledger_replay', 'failed');
          } else {
            const w = openWritable!();
            try {
              await w.ready;
              const entries = ledger?.entries ?? [];
              const sink: DeletionLedgerSink | null = ledger
                ? {
                    name: ledger.name,
                    readAll: async () => entries,
                    append: async () => {
                      throw new Error('A restore drill does not write the deletion ledger.');
                    },
                  }
                : null;
              let ledgerStorage = stores.get('default');
              if (!ledgerStorage) {
                ledgerStorage = new LocalFileStorageProvider(path.join(mediaDir, 'default'));
                stores.set('default', ledgerStorage);
              }
              const r = await replayDeletionLedger({ db: w.db, storage: ledgerStorage, sink });
              report.ledger = { records: r.records.length, deletedAgain: r.deletedAgain, alreadyAbsent: r.alreadyAbsent, failed: r.failed, sources: r.sources };
              for (const rec of r.records.filter((x) => x.outcome === 'failed')) {
                fail('ledger_replay', `Could not be deleted again (${rec.error ?? 'error'}): after a restore, writes must stay closed.`, `${rec.siteId}/${rec.objectKind}/${rec.objectId}`);
              }
              check('ledger_replay', r.failed ? 'failed' : 'passed', `${r.records.length} record(s): ${r.deletedAgain} deleted again, ${r.alreadyAbsent} already absent`);
            } catch (err) {
              // A driver error carries the server's reason as its cause.
              const cause = err instanceof Error && err.cause instanceof Error ? `: ${err.cause.message}` : '';
              fail('ledger_replay', `${err instanceof Error ? err.message.split('\n')[0] : String(err)}${cause}`);
              check('ledger_replay', 'failed');
            } finally {
              await w.close().catch(() => undefined);
            }
          }

          // 7. Read-only rendering.
          try {
            report.smoke = await (deps.smoke ?? renderSmoke)(restoredDb.db);
            if (!report.smoke.ok) fail('render_smoke', `Pages failed to render: ${report.smoke.pages.filter((p) => p.status >= 400).map((p) => `${p.host}${p.path} ${p.status}`).join(', ')}`);
            check('render_smoke', report.smoke.ok ? 'passed' : 'failed', report.smoke.note ?? `${report.smoke.pages.length} page(s)`);
          } catch (err) {
            fail('render_smoke', err instanceof Error ? err.message : String(err));
            check('render_smoke', 'failed');
          }
        } catch (err) {
          if (!report.checks.some((c) => c.name === 'objects')) check('objects', 'failed');
          fail('database', err instanceof Error ? err.message : String(err));
          check('database', 'failed', err instanceof Error ? err.message.slice(0, 300) : undefined);
        } finally {
          await restoredDb?.close().catch(() => undefined);
          await cleanup?.();
        }
      }),
    );
  } catch (err) {
    fail('manifest', err instanceof Error ? err.message : String(err));
  } finally {
    await rm(work, { recursive: true, force: true });
  }

  if (report.networkAttempts.length) {
    fail('isolation', `Outbound requests were attempted (and refused): ${[...new Set(report.networkAttempts)].join(', ')}.`);
    check('isolation', 'failed');
  } else check('isolation', 'passed', 'No outbound request; nothing ran against production.');
  report.finishedAt = new Date().toISOString();
  const passed = report.failures.length === 0;
  const [row] = await db
    .update(backupDrills)
    .set({ status: passed ? 'passed' : 'failed', backupId: report.backupId, report: report as unknown as Record<string, unknown>, finishedAt: new Date() })
    .where(eq(backupDrills.id, drillId))
    .returning();
  if (!passed) {
    const first = report.failures.slice(0, 5).map((f) => `${f.check}${f.object ? ` (${f.object})` : ''}: ${f.message}`);
    await notifyInstanceAdministrator(db, {
      event: 'backup_drill_failed',
      subject: `Restore drill failed for backup ${report.backupId ?? '(none)'}`,
      message: `${report.failures.length} problem(s). ${first.join(' | ')}`,
      data: { drillId, backupId: report.backupId, failures: report.failures.slice(0, 20) },
    });
  }
  return row!;
}

/** The postgres.js client under a drizzle database made here. */
function postgresOf(db: Database): postgres.Sql {
  return (db as unknown as { $client: postgres.Sql }).$client;
}
