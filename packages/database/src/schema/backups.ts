import { sql } from 'drizzle-orm';
import { bigint, boolean, check, foreignKey, index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { nanoid } from 'nanoid';
import { sites } from './core';

/**
 * Backups, restore drills and single-site exports (HeoPress P13 tasks 1.1–1.6; spec ops/backup-restore).
 *
 * - `lumibase_backups`: the catalogue of instance backups (database, media, configuration). The files themselves are in
 *   the backup target (a local directory or object storage), under `backups/<id>/` with a manifest; a row says where
 *   and how far the run got. An incremental names its `parent` (the backup it was taken against) and its chain's
 *   `base` (the full backup): restoring it needs every backup of that chain, so a parent cannot be removed while a
 *   backup depends on it (the foreign key, and the retention plan before it). Instance-level: no site, never read by
 *   a site-scoped request (the instance administrator's routes only).
 * - `lumibase_backup_drills`: each restore drill (weekly, or asked for) and its report: what was checked, what failed.
 * - `lumibase_site_exports`: single-site logical exports (the P12 import bundle format), in the backup target under
 *   `exports/<site>/<id>/`. Site-isolated.
 */
export const backups = pgTable(
  'lumibase_backups',
  {
    id: text('id').primaryKey(),
    /** `full` | `incremental`. */
    kind: text('kind').notNull(),
    /** `basebackup` (pg_basebackup, full and incremental) | `dump` (pg_dump, full only). */
    method: text('method').notNull(),
    /** `queued` | `running` | `succeeded` | `failed` | `removed`. */
    status: text('status').default('queued').notNull(),
    /** `schedule` | `manual`. */
    trigger: text('trigger').default('schedule').notNull(),
    parentId: text('parent_id'),
    baseId: text('base_id'),
    /** Where the backup is (`local:<dir>`, `s3:<bucket>/<prefix>`): never a credential. */
    target: text('target'),
    manifestSha256: text('manifest_sha256'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    objectCount: integer('object_count'),
    mediaObjects: integer('media_objects'),
    mediaNew: integer('media_new'),
    encrypted: boolean('encrypted').default(false).notNull(),
    keyId: text('key_id'),
    /** The recovery point: when the database copy is consistent (the backup's end). */
    recoveryPoint: timestamp('recovery_point', { withTimezone: true }),
    error: text('error'),
    requestedBy: text('requested_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    removedAt: timestamp('removed_at', { withTimezone: true }),
  },
  (t) => ({
    parentFk: foreignKey({ name: 'backups_parent_fk', columns: [t.parentId], foreignColumns: [t.id] }).onDelete('restrict'),
    baseFk: foreignKey({ name: 'backups_base_fk', columns: [t.baseId], foreignColumns: [t.id] }).onDelete('restrict'),
    created: index('backups_created').on(t.createdAt),
    status: index('backups_status').on(t.status),
    kindValid: check('backups_kind_valid', sql`${t.kind} IN ('full', 'incremental')`),
    methodValid: check('backups_method_valid', sql`${t.method} IN ('basebackup', 'dump')`),
    statusValid: check('backups_status_valid', sql`${t.status} IN ('queued', 'running', 'succeeded', 'failed', 'removed')`),
    chainValid: check('backups_chain_valid', sql`(${t.kind} = 'full' AND ${t.parentId} IS NULL) OR (${t.kind} = 'incremental' AND ${t.parentId} IS NOT NULL AND ${t.baseId} IS NOT NULL)`),
  }),
);

export const backupDrills = pgTable(
  'lumibase_backup_drills',
  {
    id: text('id').$defaultFn(() => nanoid()).primaryKey(),
    /** The backup restored (null until the drill picked one: the latest successful). */
    backupId: text('backup_id'),
    /** `queued` | `running` | `passed` | `failed`. */
    status: text('status').default('queued').notNull(),
    trigger: text('trigger').default('schedule').notNull(),
    report: jsonb('report').$type<Record<string, unknown>>(),
    requestedBy: text('requested_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => ({
    created: index('backup_drills_created').on(t.createdAt),
    statusValid: check('backup_drills_status_valid', sql`${t.status} IN ('queued', 'running', 'passed', 'failed')`),
  }),
);

export const siteExports = pgTable(
  'lumibase_site_exports',
  {
    id: text('id').$defaultFn(() => nanoid()).primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    /** `queued` | `running` | `succeeded` | `failed`. */
    status: text('status').default('queued').notNull(),
    /** Where the bundle directory is (`HEOPRESS_SITE_EXPORT_DIR/<site>/<id>`). */
    location: text('location'),
    /** SHA-256 of the bundle's records file. */
    bundleHash: text('bundle_hash'),
    items: integer('items'),
    media: integer('media'),
    /** What was left out and why (secrets, other sites' members, unsupported media). */
    report: jsonb('report').$type<Record<string, unknown>>(),
    error: text('error'),
    requestedBy: text('requested_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => ({
    siteCreated: index('site_exports_site_created').on(t.siteId, t.createdAt),
    statusValid: check('site_exports_status_valid', sql`${t.status} IN ('queued', 'running', 'succeeded', 'failed')`),
  }),
);
