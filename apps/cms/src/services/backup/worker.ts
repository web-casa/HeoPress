import { asc, eq } from 'drizzle-orm';
import { backupDrills, type Database } from '@heopress/database';
import type { KeyProvider, StorageProvider } from '@heopress/runtime';
import { queuedBackups, runBackup, type BackupDeps, type BackupKindRequest, type BackupRow } from './backup-service';
import { backupConfigFromEnv, type BackupConfig } from './config';
import { runRestoreDrill, type DrillRow } from './drill';
import { BackupBusyError } from './lock';
import { instanceMediaSource, profileMediaSource } from './media-backup';
import { pruneBackups, type PruneResult } from './retention';
import { deletionLedgerSinkFromEnv } from '../retention/deletion-ledger';

/**
 * The backup worker (HeoPress P13 tasks 1.1, 1.3): what the scheduler runs.
 *
 *   - `scheduled('full' | 'auto')`: the daily full backup and the hourly incremental (`auto`: a full one when there is
 *     no usable base), then retention (ADR-0013) — never before a backup succeeded, so a failing backup never costs
 *     an older one;
 *   - `drill()`: the weekly restore drill;
 *   - `tick()`: what was asked for from Studio or the API (queued backups and drills), one at a time.
 *
 * The serving process wires it only when a backup target is configured (`HEOPRESS_BACKUP_TARGET`).
 */

export interface BackupWorkerDeps {
  db: Database;
  env: Record<string, string | undefined>;
  storage: StorageProvider;
  keys: KeyProvider;
  app: { version: string; gitSha: string };
  /** The production database the application uses (the drill refuses to restore into it). */
  productionDatabaseUrl: string;
}

export interface BackupWorker {
  config: BackupConfig;
  /** A backup now, then retention; `manual` when an operator runs it (the command line). */
  scheduled(kind: BackupKindRequest, trigger?: 'schedule' | 'manual'): Promise<{ backup: BackupRow; prune?: PruneResult }>;
  drill(trigger?: 'schedule' | 'manual'): Promise<DrillRow>;
  tick(): Promise<{ backups: number; drills: number }>;
}

export function createBackupWorker(deps: BackupWorkerDeps): BackupWorker {
  const config = backupConfigFromEnv(deps.env);
  const backupDeps: BackupDeps = {
    db: deps.db,
    config,
    env: deps.env,
    app: deps.app,
    mediaSources: [instanceMediaSource(deps.storage), profileMediaSource(deps.db, { keys: deps.keys, defaultStorage: deps.storage, storageDir: deps.env.HEOPRESS_STORAGE_DIR?.trim() || undefined })],
  };
  const prune = (backup: BackupRow) =>
    backup.status === 'succeeded' ? pruneBackups({ db: deps.db, target: config.target, databaseUrl: config.databaseUrl }, config.retention) : Promise.resolve(undefined);
  const drillDeps = { db: deps.db, config, productionDatabaseUrl: deps.productionDatabaseUrl, ledgerSink: deletionLedgerSinkFromEnv(deps.env, deps.storage) };
  return {
    config,
    async scheduled(kind, trigger = 'schedule') {
      const backup = await runBackup(backupDeps, { kind, trigger });
      const pruned = await prune(backup).catch((err: unknown) => {
        if (err instanceof BackupBusyError) return undefined;
        throw err;
      });
      return pruned ? { backup, prune: pruned } : { backup };
    },
    drill: (trigger = 'schedule') => runRestoreDrill(drillDeps, { trigger }),
    async tick() {
      let b = 0;
      let d = 0;
      for (const row of await queuedBackups(deps.db)) {
        const done = await runBackup(backupDeps, { kind: row.kind === 'incremental' ? 'incremental' : 'full', trigger: 'manual', requestedBy: row.requestedBy, queuedId: row.id });
        await prune(done).catch(() => undefined);
        b++;
      }
      const drills = await deps.db.select().from(backupDrills).where(eq(backupDrills.status, 'queued')).orderBy(asc(backupDrills.createdAt));
      for (const row of drills) {
        await runRestoreDrill(drillDeps, { trigger: 'manual', requestedBy: row.requestedBy, queuedId: row.id, ...(row.backupId ? { backupId: row.backupId } : {}) });
        d++;
      }
      return { backups: b, drills: d };
    },
  };
}
