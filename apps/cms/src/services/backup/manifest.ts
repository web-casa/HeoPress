import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * The backup manifest (HeoPress P13 task 1.1; spec ops/backup-restore "带清单的定时备份"): what a backup holds and how
 * to check it — database version, application version, each site's content repository commit, every object with its
 * size and SHA-256 (as stored, and of the content when encrypted), every media object, and the chain it belongs to.
 *
 * Stored as `backups/<id>/manifest.json` (canonical JSON), with `manifest.json.sha256` beside it, and when encrypted
 * `manifest.json.mac` (HMAC under the backup key): corruption is found without the key, tampering with it.
 */

export const BACKUP_FORMAT = 'heopress-backup';
export const BACKUP_FORMAT_VERSION = 1;

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

const BackupObjectSchema = z.strictObject({
  /** Relative to the backup's directory (`database/base/1/1259`, `config/instance.json`). */
  path: z.string().min(1).max(2000),
  role: z.enum(['database', 'config']),
  size: z.number().int().nonnegative(),
  sha256: Sha256,
  storedSize: z.number().int().nonnegative(),
  storedSha256: Sha256,
  parts: z.number().int().positive(),
});

const MediaEntrySchema = z.strictObject({
  /** `default` (the instance storage) or `profile:<id>` (a site's storage profile). */
  store: z.string().min(1).max(200),
  /** The object key in that store. */
  key: z.string().min(1).max(2000),
  /** The site the object belongs to (profile objects), when known. */
  siteId: z.string().max(200).optional(),
  size: z.number().int().nonnegative(),
  sha256: Sha256,
  contentType: z.string().max(200).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  /** The blob (`media/<xx>/<blob>`) holding the content. */
  blob: z.string().regex(/^[0-9a-f]{64}$/),
  storedSize: z.number().int().nonnegative(),
  storedSha256: Sha256,
  parts: z.number().int().positive(),
  /** Change hint (a profile object's update time and size): unchanged objects are not read again. */
  version: z.string().max(200).optional(),
  /** Gone from the store during the backup: the previous backup's copy is kept. */
  carried: z.literal(true).optional(),
});

const BackupManifestSchema = z.strictObject({
  format: z.literal(BACKUP_FORMAT),
  version: z.literal(BACKUP_FORMAT_VERSION),
  id: z.string().min(1).max(200),
  kind: z.enum(['full', 'incremental']),
  method: z.enum(['basebackup', 'dump']),
  createdAt: z.string(),
  finishedAt: z.string(),
  /** The backup this one was taken against (incremental), the chain's full backup, and the chain from it to this one. */
  parent: z.string().nullable(),
  base: z.string().nullable(),
  chain: z.array(z.string()).min(1),
  app: z.strictObject({ version: z.string().max(200), gitSha: z.string().max(200) }),
  database: z.strictObject({
    serverVersion: z.string().max(200),
    systemIdentifier: z.string().max(100).nullable(),
    /** When the copy is consistent. */
    recoveryPoint: z.string(),
    startLsn: z.string().max(100).nullable(),
    /** Row count of every table. Exact for `dump` (same snapshot); taken at the start for `basebackup`. */
    rowCounts: z.record(z.string(), z.number().int().nonnegative()),
    rowCountsExact: z.boolean(),
  }),
  contentRepos: z.array(z.strictObject({ siteId: z.string(), commit: z.string().nullable() })),
  objects: z.array(BackupObjectSchema),
  media: z.strictObject({ entries: z.array(MediaEntrySchema), newBlobs: z.number().int().nonnegative() }),
  encryption: z.strictObject({ algorithm: z.literal('AES-256-GCM-STREAM'), keyId: z.string().regex(/^[0-9a-f]{16}$/) }).nullable(),
  warnings: z.array(z.string().max(2000)),
});

export type BackupObject = z.infer<typeof BackupObjectSchema>;
export type MediaEntry = z.infer<typeof MediaEntrySchema>;
export type BackupManifest = z.infer<typeof BackupManifestSchema>;

/** Stable JSON: keys sorted at every level. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** The bytes a manifest is stored as. */
export function encodeManifest(m: BackupManifest): Buffer {
  return Buffer.from(`${canonicalJson(BackupManifestSchema.parse(m))}\n`, 'utf8');
}

export class ManifestInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestInvalidError';
  }
}

/** Parse stored manifest bytes, checking them against the recorded SHA-256. */
export function decodeManifest(bytes: Buffer, recordedSha256: string): BackupManifest {
  if (sha256Hex(bytes) !== recordedSha256.trim()) throw new ManifestInvalidError('The manifest does not match its recorded SHA-256.');
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new ManifestInvalidError('The manifest is not JSON.');
  }
  const parsed = BackupManifestSchema.safeParse(value);
  if (!parsed.success) throw new ManifestInvalidError(`The manifest is not a HeoPress backup manifest: ${parsed.error.issues[0]?.message ?? 'invalid'}.`);
  return parsed.data;
}

export const backupDir = (id: string) => `backups/${id}`;
export const blobPath = (blob: string) => `media/${blob.slice(0, 2)}/${blob}`;
