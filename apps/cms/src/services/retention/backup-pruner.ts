/**
 * Backup retention (HeoPress P13 task 5.1; spec ops/data-retention "默认保留期限", ops/backup-restore "保留策略").
 *
 * The retention job owns *when* and *how many* (the policy: 14 daily, 8 weekly by default); the backup module owns the
 * catalogue and the deletion. It plugs in with `registerBackupPruner` at start; the data-retention job then calls every
 * registered pruner with the policy. Until a pruner is registered the job prunes no backups (and says so in its result).
 *
 * `planBackupRetention` is the selection a pruner can use: it keeps the newest successful backup of each of the
 * `daily` most recent days and of each of the `weekly` most recent ISO weeks (UTC), always the latest successful
 * backup, every backup still running, and — closed transitively — every backup a kept one depends on (the base and
 * earlier incrementals of its chain). Everything else, failed backups included, may be removed.
 */

export interface BackupRetentionPolicy {
  daily: number;
  weekly: number;
}

export interface BackupCatalogEntry {
  id: string;
  takenAt: Date;
  /** `running` is never removed; `failed` is removed unless a kept backup depends on it. */
  status: 'succeeded' | 'failed' | 'running';
  /** The backup this one needs to be restored (an incremental's parent); null for a full backup. */
  dependsOn?: string | null;
}

export interface BackupRetentionPlan {
  keep: string[];
  remove: string[];
}

function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** ISO 8601 week of a UTC date, `YYYY-Www`. */
function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function planBackupRetention(entries: readonly BackupCatalogEntry[], policy: BackupRetentionPolicy): BackupRetentionPlan {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const keep = new Set<string>();
  const ok = entries.filter((e) => e.status === 'succeeded').sort((a, b) => b.takenAt.getTime() - a.takenAt.getTime() || (a.id < b.id ? 1 : -1));
  if (ok[0]) keep.add(ok[0].id);
  const newestPer = (bucket: (d: Date) => string, count: number) => {
    const seen = new Set<string>();
    for (const e of ok) {
      const b = bucket(e.takenAt);
      if (seen.has(b)) continue;
      if (seen.size >= count) break;
      seen.add(b);
      keep.add(e.id);
    }
  };
  newestPer(utcDay, Math.max(0, policy.daily));
  newestPer(isoWeek, Math.max(0, policy.weekly));
  for (const e of entries) if (e.status === 'running') keep.add(e.id);
  // A kept backup's whole chain stays restorable.
  for (const id of [...keep]) {
    let parent = byId.get(id)?.dependsOn ?? null;
    const guard = new Set<string>([id]);
    while (parent && !guard.has(parent)) {
      guard.add(parent);
      keep.add(parent);
      parent = byId.get(parent)?.dependsOn ?? null;
    }
  }
  return {
    keep: entries.filter((e) => keep.has(e.id)).map((e) => e.id),
    remove: entries.filter((e) => !keep.has(e.id)).map((e) => e.id),
  };
}

export interface BackupPruner {
  /** Shown in the retention job's result and logs, e.g. `local`, `s3`. */
  readonly name: string;
  /** Remove the backups the policy no longer keeps; never one a kept backup depends on. Returns the removed ids. */
  prune(policy: BackupRetentionPolicy, now: Date): Promise<{ removed: string[] }>;
}

const pruners = new Map<string, BackupPruner>();

/** Register (or replace, by name) a backup pruner. Returns the function that unregisters it. */
export function registerBackupPruner(pruner: BackupPruner): () => void {
  pruners.set(pruner.name, pruner);
  return () => {
    if (pruners.get(pruner.name) === pruner) pruners.delete(pruner.name);
  };
}

export interface BackupPruneResult {
  /** False when no backup module registered a pruner: no backup was pruned. */
  registered: boolean;
  /** `error` is the error's name only: a pruner's message may carry paths or bucket names. */
  pruners: Array<{ name: string; removed: string[]; error?: string }>;
}

/** Run every registered pruner with the policy; one failing pruner does not stop the others. */
export async function runBackupPruners(policy: BackupRetentionPolicy, now: Date): Promise<BackupPruneResult> {
  const out: BackupPruneResult = { registered: pruners.size > 0, pruners: [] };
  for (const p of pruners.values()) {
    try {
      const { removed } = await p.prune(policy, now);
      out.pruners.push({ name: p.name, removed });
    } catch (err) {
      out.pruners.push({ name: p.name, removed: [], error: err instanceof Error ? err.name : 'error' });
    }
  }
  return out;
}
