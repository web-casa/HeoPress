import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import { nanoid } from 'nanoid';
import { sites, users } from './core';
import { items } from './cms';

/**
 * Site import (HeoPress P12 tasks 6.1–6.4; spec migration/import-bundle).
 *
 * - `lumibase_import_batches`: one per import of a bundle into a site. `planned` after a dry run (its report and
 *   report hash), `imported` once written (items are drafts, nothing public), `activated` when a person published it,
 *   `superseded` when a later import of the same namespace replaced it before activation.
 * - `lumibase_import_external_ids`: what each external ID (`<source>:<sourceSite>` namespace) became on the site, with
 *   the hash of the record last imported and the item version that import left — a re-import writes only what
 *   changed, and never over a person's later edit.
 * - `lumibase_import_batch_items`: the items a batch makes public on activation, each pinned to the version the
 *   import left, with the safety issues found when it was imported. Kept after activation: the "historical import"
 *   marking of the item.
 */
export const importBatches = pgTable(
  'lumibase_import_batches',
  {
    id: text('id').primaryKey().$defaultFn(() => nanoid()),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    /** `<source>:<sourceSite>`. */
    namespace: text('namespace').notNull(),
    bundleHash: text('bundle_hash').notNull(),
    reportHash: text('report_hash').notNull(),
    status: text('status').default('planned').notNull(),
    report: jsonb('report').$type<Record<string, unknown>>().notNull(),
    /** What activation found the last time it was tried (blocking reasons, SEO notes). */
    activationReport: jsonb('activation_report').$type<Record<string, unknown>>(),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    importedAt: timestamp('imported_at', { withTimezone: true }),
    activatedBy: text('activated_by').references(() => users.id, { onDelete: 'set null' }),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
  },
  (t) => ({
    siteCreated: index('import_batches_site_created').on(t.siteId, t.createdAt),
    statusValid: check('import_batches_status_valid', sql`${t.status} IN ('planned', 'imported', 'activated', 'superseded')`),
  }),
);

export const importExternalIds = pgTable(
  'lumibase_import_external_ids',
  {
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    namespace: text('namespace').notNull(),
    /** `item` | `media` | `group`. */
    kind: text('kind').notNull(),
    externalId: text('external_id').notNull(),
    /** The item, file or translation group id. */
    targetId: text('target_id').notNull(),
    recordHash: text('record_hash').notNull(),
    /** Items: the version the last import left. */
    targetVersion: integer('target_version'),
    batchId: text('batch_id').references(() => importBatches.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.siteId, t.namespace, t.kind, t.externalId] }),
    kindValid: check('import_external_ids_kind_valid', sql`${t.kind} IN ('item', 'media', 'group')`),
  }),
);

export const importBatchItems = pgTable(
  'lumibase_import_batch_items',
  {
    batchId: text('batch_id')
      .notNull()
      .references(() => importBatches.id, { onDelete: 'cascade' }),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    itemId: text('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    externalId: text('external_id').notNull(),
    collection: text('collection').notNull(),
    pinnedVersion: integer('pinned_version').notNull(),
    /** Safety problems found when the item was imported (markup removed by the sanitiser, …). */
    safetyIssues: jsonb('safety_issues').$type<string[]>().default(sql`'[]'::jsonb`).notNull(),
    /** The bundle marked it internal only (never activated). */
    internalOnly: boolean('internal_only').default(false).notNull(),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.batchId, t.itemId] }),
    item: index('import_batch_items_item').on(t.itemId),
  }),
);
