import type { Database } from '@heopress/database';
import type { StorageProvider } from '@heopress/runtime';
import { runBackupPruners, type BackupPruneResult } from './backup-pruner';
import type { RetentionPolicy } from './policy';
import { redactExpiredRunRecords } from './run-record-retention';
import { purgeExpiredSnapshots, type SnapshotRetentionResult } from './snapshot-retention';

/**
 * The daily data-retention job (HeoPress P13 task 5.1): snapshots, AI run record bodies and backups under one policy.
 * Access details (`crawl-hits-purge`, hourly) and confirmed change events (the change-feed maintenance) keep their own
 * schedules and read their periods from the same policy. A part that failed for some site fails the run once every
 * part was tried, so the scheduled slot is recorded failed.
 */
export interface DataRetentionResult {
  snapshots: SnapshotRetentionResult;
  runRecords: { redacted: number; failedSites: number };
  backups: BackupPruneResult;
}

export async function runDataRetention(deps: {
  db: Database;
  storage: StorageProvider;
  policy: RetentionPolicy;
  now?: () => Date;
}): Promise<DataRetentionResult> {
  const now = deps.now ?? (() => new Date());
  const snapshots = await purgeExpiredSnapshots({ db: deps.db, storage: deps.storage, snapshotDays: deps.policy.snapshotDays, now });
  const runRecords = await redactExpiredRunRecords({ db: deps.db, aiRunBodyDays: deps.policy.aiRunBodyDays, now });
  const backups = await runBackupPruners({ daily: deps.policy.backupDaily, weekly: deps.policy.backupWeekly }, now());
  const result = { snapshots, runRecords, backups };
  const failed = snapshots.failedSites + runRecords.failedSites + backups.pruners.filter((p) => p.error).length;
  if (failed > 0) {
    throw Object.assign(new Error(`data retention failed in ${failed} part(s)`), { result });
  }
  return result;
}
