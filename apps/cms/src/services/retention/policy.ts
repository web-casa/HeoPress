/**
 * Retention periods (HeoPress P13 task 5.1; spec ops/data-retention "默认保留期限"; ADR-0013).
 *
 * One instance-wide configuration for every retention job, read from the environment; an unset or invalid value falls
 * back to the ADR-0013 default (never to "keep forever" and never to "delete now"):
 *
 * | Data | Default | Variable |
 * |---|---|---|
 * | Raw fetch snapshots | 90 days | `HEOPRESS_RETENTION_SNAPSHOT_DAYS` |
 * | AI run record bodies (prompts, full outputs) | 90 days | `HEOPRESS_RETENTION_AI_RUN_BODY_DAYS` |
 * | Access details (AI crawler hits, IP hash) | 7 days | `HEOPRESS_RETENTION_ACCESS_DETAIL_DAYS` |
 * | Change events confirmed by every consumer | 30 days | `HEOPRESS_RETENTION_CHANGE_EVENT_DAYS` (a site's own `cdc_feed.retentionDays` wins) |
 * | Backups | 14 daily, 8 weekly | `HEOPRESS_RETENTION_BACKUP_DAILY`, `HEOPRESS_RETENTION_BACKUP_WEEKLY` |
 */

export interface RetentionPolicy {
  snapshotDays: number;
  aiRunBodyDays: number;
  accessDetailDays: number;
  changeEventDays: number;
  backupDaily: number;
  backupWeekly: number;
}

export const DEFAULT_RETENTION_POLICY: Readonly<RetentionPolicy> = Object.freeze({
  snapshotDays: 90,
  aiRunBodyDays: 90,
  accessDetailDays: 7,
  changeEventDays: 30,
  backupDaily: 14,
  backupWeekly: 8,
});

const SETTINGS: ReadonlyArray<{ key: keyof RetentionPolicy; env: string; min: number; max: number }> = [
  { key: 'snapshotDays', env: 'HEOPRESS_RETENTION_SNAPSHOT_DAYS', min: 1, max: 3650 },
  { key: 'aiRunBodyDays', env: 'HEOPRESS_RETENTION_AI_RUN_BODY_DAYS', min: 1, max: 3650 },
  { key: 'accessDetailDays', env: 'HEOPRESS_RETENTION_ACCESS_DETAIL_DAYS', min: 1, max: 90 },
  // The change feed's own bound (`CdcFeedSettingsSchema.retentionDays`).
  { key: 'changeEventDays', env: 'HEOPRESS_RETENTION_CHANGE_EVENT_DAYS', min: 1, max: 90 },
  // At least one backup of each kind is always kept (the latest successful backup is kept regardless).
  { key: 'backupDaily', env: 'HEOPRESS_RETENTION_BACKUP_DAILY', min: 1, max: 366 },
  { key: 'backupWeekly', env: 'HEOPRESS_RETENTION_BACKUP_WEEKLY', min: 0, max: 520 },
];

function parseBounded(raw: string | undefined, min: number, max: number): number | null {
  if (raw == null || raw.trim() === '') return null;
  if (!/^\d+$/.test(raw.trim())) return null;
  const n = Number.parseInt(raw.trim(), 10);
  return n >= min && n <= max ? n : null;
}

/** The instance's retention policy: each value from its variable when valid, otherwise the default. */
export function retentionPolicyFromEnv(env: Record<string, string | undefined> = process.env): RetentionPolicy {
  const policy: RetentionPolicy = { ...DEFAULT_RETENTION_POLICY };
  for (const s of SETTINGS) {
    const value = parseBounded(env[s.env], s.min, s.max);
    if (value !== null) policy[s.key] = value;
  }
  return policy;
}

/** Variables that are set but not valid (reported once at start, so an operator's typo does not pass silently). */
export function invalidRetentionSettings(env: Record<string, string | undefined> = process.env): string[] {
  return SETTINGS.filter((s) => env[s.env] != null && env[s.env]!.trim() !== '' && parseBounded(env[s.env], s.min, s.max) === null).map(
    (s) => `${s.env} (expected an integer ${s.min}–${s.max}; using ${DEFAULT_RETENTION_POLICY[s.key]})`,
  );
}

export const DAY_MS = 86_400_000;
