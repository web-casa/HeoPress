import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { nanoid } from 'nanoid';
import { sites } from './core';

/**
 * Data retention and deletion (HeoPress P13 tasks 5.1, 5.2; spec ops/data-retention; ADR-0013). Both tables are
 * site-isolated (row-level security, `migrations/rls-policies.sql`).
 */

/**
 * Retention holds (task 5.1): an open dispute about an object keeps it past its retention period. Today the target is a
 * raw fetch snapshot (`ingest_snapshot`); the retention job skips a snapshot while it has an open hold and takes it up
 * again once the hold is released. A personal-data deletion request does not wait for holds.
 */
export const retentionHolds = pgTable(
  'lumibase_retention_holds',
  {
    id: text('id').$defaultFn(() => nanoid()).primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    /** `ingest_snapshot`. */
    targetKind: text('target_kind').notNull(),
    targetId: text('target_id').notNull(),
    /** Why the object is kept (the dispute, a complaint reference); no personal data. */
    reason: text('reason').notNull(),
    openedBy: text('opened_by'),
    openedAt: timestamp('opened_at', { withTimezone: true }).defaultNow().notNull(),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    releasedBy: text('released_by'),
  },
  (t) => ({
    targetKindCheck: check('retention_holds_target_kind_check', sql`${t.targetKind} IN ('ingest_snapshot')`),
    openIdx: index('retention_holds_open_idx').on(t.siteId, t.targetKind, t.targetId).where(sql`${t.releasedAt} IS NULL`),
  }),
);

/**
 * The deletion ledger (task 5.2): one row per object a personal-data deletion request removed — identifiers and time
 * only, never content. Restoring a backup brings back an older database, so the ledger is also appended to a store
 * outside the database (`services/retention/deletion-ledger.ts`); after a restore, and before writes open, the restore
 * flow replays the union of both, deleting again whatever came back and writing the missing rows here.
 *
 * `site_id` has no foreign key on purpose: deleting a site must not delete the record of what was erased in it (a backup
 * from before the site's deletion still holds that data).
 */
export const deletionLedger = pgTable(
  'lumibase_deletion_ledger',
  {
    id: text('id').$defaultFn(() => nanoid()).primaryKey(),
    siteId: text('site_id').notNull(),
    /** The erasure request that deleted the object. */
    requestId: text('request_id').notNull(),
    /** `item` | `ingest_snapshot`. */
    objectKind: text('object_kind').notNull(),
    /** The object's container: the collection name of an item; null for a snapshot. */
    objectScope: text('object_scope'),
    objectId: text('object_id').notNull(),
    /** `hard_delete` | `crypto_shred` (items) | `tombstone` (snapshots: content removed, hash kept). */
    action: text('action').notNull(),
    erasedAt: timestamp('erased_at', { withTimezone: true }).notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    objectKindCheck: check('deletion_ledger_object_kind_check', sql`${t.objectKind} IN ('item', 'ingest_snapshot')`),
    actionCheck: check('deletion_ledger_action_check', sql`${t.action} IN ('hard_delete', 'crypto_shred', 'tombstone')`),
    objectUnique: uniqueIndex('deletion_ledger_object_unique').on(t.siteId, t.requestId, t.objectKind, t.objectId),
    erasedIdx: index('deletion_ledger_erased_idx').on(t.siteId, t.erasedAt),
  }),
);
