import { eq } from 'drizzle-orm';
import { backups, type Database } from '@heopress/database';
import { loadManifest, listBackups, type BackupRow } from './backup-service';
import { withBackupLock } from './lock';
import { backupDir, blobPath } from './manifest';
import type { BackupTarget } from './target';
import { planBackupRetention, registerBackupPruner, type BackupCatalogEntry, type BackupPruner, type BackupRetentionPolicy } from '../retention/backup-pruner';

/**
 * Backup retention (HeoPress P13 tasks 1.1, 1.5; spec ops/backup-restore "保留策略"; ADR-0013: 14 daily, 8 weekly).
 *
 * The plan is the data-retention module's (`planBackupRetention`, P13 task 5.1): the newest successful backup of each
 * of the `daily` most recent days and of each of the `weekly` most recent ISO weeks (UTC), always the latest successful
 * backup, every backup still queued or running, and — closed over the chain — every backup a kept one depends on (its
 * parent, up to the full backup). Everything else may go, failed backups included. Pruning removes those backups'
 * files, marks their rows `removed`, and then removes the media blobs no kept manifest names. It runs under the backup
 * lock: never while a backup is being written.
 *
 * The daily data-retention job prunes through the pruner registered at start (`registerBackupsPruner`); a backup run
 * (scheduled, or `heopress backup run`) prunes after it succeeds, and `heopress backup prune` on demand.
 */

/** The catalogue as the retention plan reads it: removed backups left out; a queued one counts as running (kept). */
export function retentionEntries(rows: readonly BackupRow[]): BackupCatalogEntry[] {
  return rows
    .filter((r) => r.status !== 'removed')
    .map((r) => ({ id: r.id, takenAt: r.startedAt ?? r.createdAt, status: r.status === 'queued' ? 'running' : (r.status as BackupCatalogEntry['status']), dependsOn: r.parentId }));
}

export interface PruneResult {
  removed: string[];
  blobsRemoved: number;
  /** Why the media blobs were not collected (a kept manifest could not be read), when they were not. */
  blobsSkipped?: string;
}

/** Remove what the policy no longer keeps (never a backup a kept one depends on), then unreferenced media blobs. */
export async function pruneBackups(deps: { db: Database; target: BackupTarget; databaseUrl: string }, policy: BackupRetentionPolicy): Promise<PruneResult> {
  return withBackupLock(deps.databaseUrl, async () => {
    const rows = await listBackups(deps.db);
    const plan = planBackupRetention(retentionEntries(rows), policy);
    const removed: string[] = [];
    for (const id of plan.remove) {
      await deps.target.remove(`${backupDir(id)}/`);
      await deps.db.update(backups).set({ status: 'removed', removedAt: new Date() }).where(eq(backups.id, id));
      removed.push(id);
    }
    // Media blobs: keep every blob a kept, successful backup names.
    const keep = new Set(plan.keep);
    const keptOk = rows.filter((r) => r.status === 'succeeded' && keep.has(r.id));
    const referenced = new Set<string>();
    try {
      for (const r of keptOk) for (const e of (await loadManifest(deps.target, r.id)).media.entries) referenced.add(blobPath(e.blob));
    } catch (err) {
      return { removed, blobsRemoved: 0, blobsSkipped: `A kept manifest could not be read: ${err instanceof Error ? err.message : String(err)}` };
    }
    let blobsRemoved = 0;
    for (const p of await deps.target.list('media/')) {
      if (referenced.has(p)) continue;
      await deps.target.remove(p);
      blobsRemoved++;
    }
    return { removed, blobsRemoved };
  });
}

/** The pruner the data-retention job runs (`registerBackupPruner`, P13 task 5.1). */
function backupPruner(deps: { db: Database; target: BackupTarget; databaseUrl: string }): BackupPruner {
  return {
    name: 'backups',
    async prune(policy: BackupRetentionPolicy, _now: Date): Promise<{ removed: string[] }> {
      const r = await pruneBackups(deps, policy);
      return { removed: r.removed };
    },
  };
}

/** Register the backup pruner with the data-retention job (at start, when a backup target is configured). */
export function registerBackupsPruner(deps: { db: Database; target: BackupTarget; databaseUrl: string }): () => void {
  return registerBackupPruner(backupPruner(deps));
}
