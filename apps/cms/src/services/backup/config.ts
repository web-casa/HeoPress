import path from 'node:path';
import { S3StorageProvider } from '@heopress/runtime/docker';
import { LocalDirTarget, ObjectStoreTarget, type BackupTarget } from './target';
import { retentionPolicyFromEnv } from '../retention/policy';

/**
 * Backup settings (HeoPress P13 task 1.1; docs/zh-CN/operations/backup-restore.md). All from the environment of the worker
 * that runs backups; nothing here is ever written to a backup or a log.
 *
 *   HEOPRESS_BACKUP_TARGET              `local:/var/lib/heopress/backups` (or an absolute path), or `s3`
 *   HEOPRESS_BACKUP_S3_BUCKET, _ENDPOINT, _REGION, _PREFIX, _FORCE_PATH_STYLE, _ACCESS_KEY_ID, _SECRET_ACCESS_KEY
 *   HEOPRESS_BACKUP_DATABASE_URL        a role that may back up the whole database (replication for basebackup; owner
 *                                       or superuser for dump); default DATABASE_OWNER_URL, then DATABASE_URL
 *   HEOPRESS_BACKUP_METHOD              `basebackup` (daily full + hourly incremental, default) or `dump` (full only)
 *   HEOPRESS_BACKUP_ENCRYPTION_KEY_FILE a 32-byte key kept apart from the backups; unset: not encrypted
 *   HEOPRESS_BACKUP_CONFIG_FILES        configuration files to include (comma-separated; only when encrypted)
 *   HEOPRESS_BACKUP_DRILL_DATABASE_URL  where a dump drill creates its temporary database (a role with CREATEDB);
 *                                       default: the backup role's server, database `postgres`
 *   HEOPRESS_BACKUP_SCHEDULE            `off` stops the scheduled backups and drills (manual ones still run)
 *   HEOPRESS_BACKUP_FULL_CRON, _INCREMENTAL_CRON, _DRILL_CRON   schedules (node-cron, with seconds)
 *   HEOPRESS_BACKUP_MAX_CHAIN           incrementals after a full before the next full is required (default 48)
 *   HEOPRESS_RETENTION_BACKUP_DAILY, HEOPRESS_RETENTION_BACKUP_WEEKLY   retention (ADR-0013: 14 and 8; read by the
 *                                       data-retention policy, `retentionPolicyFromEnv`)
 *   HEOPRESS_PG_BIN_DIR                 the PostgreSQL 18 programs
 */

type BackupMethod = 'basebackup' | 'dump';

export interface BackupConfig {
  target: BackupTarget;
  databaseUrl: string;
  method: BackupMethod;
  keyFile: string | null;
  configFiles: string[];
  drillDatabaseUrl: string | null;
  pgBinDir: string | null;
  maxChain: number;
  schedule: { enabled: boolean; full: string; incremental: string; drill: string };
  retention: { daily: number; weekly: number };
}

export class BackupConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupConfigError';
  }
}

type Env = Record<string, string | undefined>;

const str = (env: Env, k: string) => {
  const v = env[k]?.trim();
  return v ? v : null;
};

function int(env: Env, k: string, dflt: number, min: number, max: number): number {
  const v = str(env, k);
  if (v === null) return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new BackupConfigError(`${k} must be a whole number from ${min} to ${max}.`);
  return n;
}

/** Whether backups are configured at all (a target is named). */
export function backupsConfigured(env: Env): boolean {
  return str(env, 'HEOPRESS_BACKUP_TARGET') !== null;
}

function backupTargetFromEnv(env: Env): BackupTarget {
  const raw = str(env, 'HEOPRESS_BACKUP_TARGET');
  if (!raw) throw new BackupConfigError('HEOPRESS_BACKUP_TARGET is not set.');
  if (raw === 's3') {
    const bucket = str(env, 'HEOPRESS_BACKUP_S3_BUCKET');
    const accessKeyId = str(env, 'HEOPRESS_BACKUP_S3_ACCESS_KEY_ID');
    const secretAccessKey = str(env, 'HEOPRESS_BACKUP_S3_SECRET_ACCESS_KEY');
    if (!bucket || !accessKeyId || !secretAccessKey) throw new BackupConfigError('An s3 backup target needs HEOPRESS_BACKUP_S3_BUCKET, _ACCESS_KEY_ID and _SECRET_ACCESS_KEY.');
    const prefix = str(env, 'HEOPRESS_BACKUP_S3_PREFIX') ?? 'heopress-backups';
    const fps = str(env, 'HEOPRESS_BACKUP_S3_FORCE_PATH_STYLE');
    const storage = new S3StorageProvider({
      bucket,
      accessKeyId,
      secretAccessKey,
      endpoint: str(env, 'HEOPRESS_BACKUP_S3_ENDPOINT') ?? undefined,
      region: str(env, 'HEOPRESS_BACKUP_S3_REGION') ?? undefined,
      ...(fps ? { forcePathStyle: fps === 'true' || fps === '1' } : {}),
    });
    return new ObjectStoreTarget(storage, { description: `s3:${bucket}/${prefix}`, prefix });
  }
  const dir = raw.startsWith('local:') ? raw.slice('local:'.length) : raw;
  if (!path.isAbsolute(dir)) throw new BackupConfigError('A local backup target must be an absolute path (local:/var/lib/heopress/backups).');
  return new LocalDirTarget(dir);
}

export function backupConfigFromEnv(env: Env): BackupConfig {
  const databaseUrl = str(env, 'HEOPRESS_BACKUP_DATABASE_URL') ?? str(env, 'DATABASE_OWNER_URL') ?? str(env, 'DATABASE_URL');
  if (!databaseUrl) throw new BackupConfigError('HEOPRESS_BACKUP_DATABASE_URL (or DATABASE_URL) is not set.');
  const method = (str(env, 'HEOPRESS_BACKUP_METHOD') ?? 'basebackup') as BackupMethod;
  if (method !== 'basebackup' && method !== 'dump') throw new BackupConfigError('HEOPRESS_BACKUP_METHOD is basebackup or dump.');
  const keyFile = str(env, 'HEOPRESS_BACKUP_ENCRYPTION_KEY_FILE');
  const configFiles = (str(env, 'HEOPRESS_BACKUP_CONFIG_FILES') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const f of configFiles) if (!path.isAbsolute(f)) throw new BackupConfigError('HEOPRESS_BACKUP_CONFIG_FILES lists absolute paths.');
  const schedule = str(env, 'HEOPRESS_BACKUP_SCHEDULE');
  const policy = retentionPolicyFromEnv(env);
  return {
    target: backupTargetFromEnv(env),
    databaseUrl,
    method,
    keyFile,
    configFiles,
    drillDatabaseUrl: str(env, 'HEOPRESS_BACKUP_DRILL_DATABASE_URL'),
    pgBinDir: str(env, 'HEOPRESS_PG_BIN_DIR'),
    maxChain: int(env, 'HEOPRESS_BACKUP_MAX_CHAIN', 48, 1, 1000),
    schedule: {
      enabled: schedule !== 'off' && schedule !== 'false',
      full: str(env, 'HEOPRESS_BACKUP_FULL_CRON') ?? '0 30 2 * * *',
      incremental: str(env, 'HEOPRESS_BACKUP_INCREMENTAL_CRON') ?? '0 15 * * * *',
      drill: str(env, 'HEOPRESS_BACKUP_DRILL_CRON') ?? '0 0 4 * * 0',
    },
    // The instance's retention policy (P13 task 5.1): an invalid value falls back to the default, as for every job.
    retention: { daily: policy.backupDaily, weekly: policy.backupWeekly },
  };
}
