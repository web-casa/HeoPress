#!/usr/bin/env -S npx tsx
/**
 * `heopress backup` — backups, restore and single-site export (HeoPress P13 tasks 1.1–1.6; guide
 * docs/zh-CN/operations/backup-restore.md).
 *
 *   heopress backup run [--kind full|incremental|auto]        take a backup now (HEOPRESS_BACKUP_* configuration)
 *   heopress backup list                                       the catalogue, newest first
 *   heopress backup verify <id> [--key-file <file>]            chain, manifests and every object hash, nothing restored
 *   heopress backup drill [<id>]                               the restore drill now (default: the latest backup)
 *   heopress backup prune                                      retention (HEOPRESS_RETENTION_BACKUP_DAILY / _WEEKLY)
 *   heopress backup restore <id> [--key-file <file>] [--database-url <url> | --data-dir <dir>] [--media-dir <dir>]
 *   heopress backup finish-restore <id> --database-url <url> [--key-file <file>] [--media-dir <dir>]
 *   heopress backup export-site --site <id> --actor <userId> --out <dir>
 *   heopress backup import-site --bundle <dir> --site <newId> --name <name> --actor <userId> [--media-public-url <url>]
 *
 * `restore` puts a dump into the empty database `--database-url` names, or writes a base backup chain, combined and
 * verified, to `--data-dir` (start PostgreSQL on it, then run `finish-restore`); media go to `--media-dir/<store>/`.
 * Before writes may open, the deletion ledger is replayed on the restored database (P13 task 5.2): with a dump right
 * after the restore, with a base backup by `finish-restore` once PostgreSQL runs on it. A record that cannot be deleted
 * again exits 2 with `writesMayOpen: false`: keep the application stopped (writes closed) until it is resolved. The
 * replay works on the media in `--media-dir` when given (restored there), otherwise on the configured storage. The key
 * is given with `--key-file` (or HEOPRESS_BACKUP_ENCRYPTION_KEY_FILE), never read from the backup.
 */

export {};

import { mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { schema, type Database } from '@heopress/database';
import { createRuntime } from '@heopress/runtime/node';
import { LocalFileStorageProvider } from '@heopress/runtime/docker';
import { listBackups, loadManifest, workDir } from '../src/services/backup/backup-service';
import { backupConfigFromEnv } from '../src/services/backup/config';
import { loadBackupKey } from '../src/services/backup/crypto';
import { listDrills, type DrillReport } from '../src/services/backup/drill';
import { materializeDatabase, resolveChain, restoreDump, restoreMedia, verifyBackup } from '../src/services/backup/restore';
import { replayLedgerAfterRestore } from '../src/services/backup/ledger-replay';
import { deletionLedgerSinkFromEnv } from '../src/services/retention/deletion-ledger';
import { createBackupWorker } from '../src/services/backup/worker';
import { BundleInvalidError } from '../src/services/site-import/bundle-reader';
import { exportSite } from '../src/services/site-export/export-service';
import { importAsNewSite } from '../src/services/site-export/import-new-site';
import { resolveBuildMetadata } from '../src/routes/system';

const [command, ...rest] = process.argv.slice(2);
const flag = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const positional = () => rest.find((a, i) => !a.startsWith('--') && !rest[i - 1]?.startsWith('--'));
const need = (name: string) => {
  const v = flag(name);
  if (!v) {
    console.error(`--${name} is required.`);
    process.exit(1);
  }
  return v;
};
const print = (v: unknown) => console.log(JSON.stringify(v, null, 2));
const env = process.env as Record<string, string | undefined>;

async function withDb<T>(fn: (db: Database, runtime: ReturnType<typeof createRuntime>) => Promise<T>): Promise<T> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required.');
    process.exit(1);
  }
  const client = postgres(url, { max: 4, onnotice: () => {} });
  const db = drizzle(client, { schema }) as unknown as Database;
  const runtime = createRuntime(process.env);
  try {
    return await fn(db, runtime);
  } finally {
    await runtime.queue.close?.().catch(() => undefined);
    await runtime.database.close().catch(() => undefined);
    await client.end({ timeout: 2 });
  }
}

const worker = (db: Database, runtime: ReturnType<typeof createRuntime>) => {
  const build = resolveBuildMetadata();
  return createBackupWorker({ db, env, storage: runtime.storage, keys: runtime.keys, app: { version: build.version, gitSha: build.gitSha }, productionDatabaseUrl: process.env.DATABASE_URL ?? '' });
};
/** Media restored into `<media-dir>/<store>/`, one provider per store. */
const mediaStores = (mediaDir: string) => {
  const stores = new Map<string, LocalFileStorageProvider>();
  return (store: string) => {
    let s = stores.get(store);
    if (!s) {
      s = new LocalFileStorageProvider(path.join(mediaDir, store.replace(/[^A-Za-z0-9_-]/g, '_')));
      stores.set(store, s);
    }
    return s;
  };
};
/** Replay the deletion ledger on a restored database; writes stay closed (exit 2) when a record failed. */
const replayLedger = async (databaseUrl: string, mediaDir: string | undefined) => {
  const runtime = createRuntime(process.env);
  try {
    const storage = mediaDir ? mediaStores(mediaDir)('default') : runtime.storage;
    const r = await replayLedgerAfterRestore({ databaseUrl, storage, sink: deletionLedgerSinkFromEnv(env, runtime.storage) });
    if (!r.writesMayOpen) process.exitCode = 2;
    return {
      writesMayOpen: r.writesMayOpen,
      deletedAgain: r.report.deletedAgain,
      alreadyAbsent: r.report.alreadyAbsent,
      failed: r.report.records.filter((x) => x.outcome === 'failed').map((x) => ({ siteId: x.siteId, kind: x.objectKind, id: x.objectId, error: x.error })),
      rowsRestored: r.report.rowsRestored,
      sources: r.report.sources,
    };
  } finally {
    await runtime.queue.close?.().catch(() => undefined);
    await runtime.database.close().catch(() => undefined);
  }
};
const keyOf = async () => {
  const file = flag('key-file') ?? env.HEOPRESS_BACKUP_ENCRYPTION_KEY_FILE;
  return file ? loadBackupKey(file) : null;
};

try {
  switch (command) {
    case 'run': {
      const kind = (flag('kind') ?? 'full') as 'full' | 'incremental' | 'auto';
      if (!['full', 'incremental', 'auto'].includes(kind)) throw new Error('--kind is full, incremental or auto.');
      await withDb(async (db, runtime) => {
        const r = await worker(db, runtime).scheduled(kind, 'manual');
        print(r);
        if (r.backup.status !== 'succeeded') process.exitCode = 2;
      });
      break;
    }
    case 'list':
      await withDb(async (db) => print({ backups: await listBackups(db, { limit: 100 }), drills: await listDrills(db, 20) }));
      break;
    case 'verify': {
      const id = positional() ?? need('id');
      const r = await verifyBackup(backupConfigFromEnv(env).target, id, await keyOf());
      print(r);
      if (r.failures.length) process.exitCode = 2;
      break;
    }
    case 'drill':
      await withDb(async (db, runtime) => {
        const w = worker(db, runtime);
        const id = positional();
        const { runRestoreDrill } = await import('../src/services/backup/drill');
        const row = id ? await runRestoreDrill({ db, config: w.config, productionDatabaseUrl: process.env.DATABASE_URL ?? '' }, { backupId: id, trigger: 'manual' }) : await w.drill('manual');
        const report = row.report as unknown as DrillReport;
        print({ id: row.id, status: row.status, backupId: row.backupId, checks: report.checks, failures: report.failures });
        if (row.status !== 'passed') process.exitCode = 2;
      });
      break;
    case 'prune':
      await withDb(async (db) => {
        const config = backupConfigFromEnv(env);
        const { pruneBackups } = await import('../src/services/backup/retention');
        print(await pruneBackups({ db, target: config.target, databaseUrl: config.databaseUrl }, config.retention));
      });
      break;
    case 'restore': {
      const id = positional() ?? need('id');
      const config = backupConfigFromEnv(env);
      const key = await keyOf();
      const chain = await resolveChain(config.target, id, key);
      const out: Record<string, unknown> = { chain: chain.map((m) => m.id) };
      const dataDir = flag('data-dir') ? path.resolve(flag('data-dir')!) : undefined;
      const databaseUrl = flag('database-url');
      const mediaDir = flag('media-dir');
      if (dataDir && (await readdir(dataDir).catch(() => [])).length > 0) throw new Error('--data-dir must be empty.');
      // Next to the data directory (the same file system, so the result moves into place), or a temporary directory.
      const work = dataDir ? await mkdtemp(`${dataDir}.restore-`) : await workDir('hprs-');
      let restoredDump = false;
      try {
        const db = await materializeDatabase(config.target, chain, key, work, config.pgBinDir);
        if (db.kind === 'dump') {
          if (!databaseUrl) throw new Error('A dump backup restores into --database-url (an empty database).');
          await restoreDump(db.file, databaseUrl, config.pgBinDir);
          out.database = 'restored';
          restoredDump = true;
        } else {
          if (!dataDir) throw new Error('A base backup restores into --data-dir (an empty or new directory).');
          await rm(dataDir, { recursive: true, force: true });
          await rename(db.dataDir, dataDir);
          out.dataDir = dataDir;
          out.next = 'Start PostgreSQL 18 on the data directory (as its owner), then run `heopress backup finish-restore <id> --database-url <url>` (the deletion ledger replay) before opening writes.';
        }
      } finally {
        await rm(work, { recursive: true, force: true });
      }
      if (mediaDir) {
        const r = await restoreMedia(config.target, chain.at(-1)!, key, mediaStores(mediaDir));
        out.media = r;
        if (r.failures.length) process.exitCode = 2;
      }
      // A dump is a running database already: the ledger is replayed now, on the restored media when given.
      if (restoredDump) out.deletionLedger = await replayLedger(databaseUrl!, mediaDir);
      print(out);
      break;
    }
    case 'finish-restore': {
      const id = positional() ?? need('id');
      const config = backupConfigFromEnv(env);
      const m = await loadManifest(config.target, id, await keyOf());
      print({ backup: m.id, deletionLedger: await replayLedger(need('database-url'), flag('media-dir')) });
      break;
    }
    case 'export-site':
      await withDb(async (db, runtime) => {
        const out = need('out');
        await mkdir(out, { recursive: true, mode: 0o700 });
        print(await exportSite({ db, keys: runtime.keys, defaultStorage: runtime.storage, storageDir: env.HEOPRESS_STORAGE_DIR?.trim() || undefined }, { siteId: need('site'), actor: { userId: need('actor') }, dir: out }));
      });
      break;
    case 'import-site':
      await withDb(async (db, runtime) => {
        const mediaPublicBaseUrl = flag('media-public-url');
        print(
          await importAsNewSite(
            { db, keys: runtime.keys, defaultStorage: runtime.storage, storageDir: env.HEOPRESS_STORAGE_DIR?.trim() || undefined },
            { dir: need('bundle'), siteId: need('site'), name: need('name'), actor: { userId: need('actor') }, ...(mediaPublicBaseUrl ? { mediaPublicBaseUrl } : {}) },
          ),
        );
      });
      break;
    default:
      console.error('Usage: heopress backup run | list | verify | drill | prune | restore | finish-restore | export-site | import-site (see docs/zh-CN/operations/backup-restore.md)');
      process.exit(1);
  }
} catch (err) {
  if (err instanceof BundleInvalidError) print({ ok: false, problems: err.problems });
  else console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
