import { boolean, foreignKey, index, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex } from 'drizzle-orm/pg-core';
import { nanoid } from 'nanoid';
import { sites } from './core';

/**
 * Content sources (HeoPress P08 tasks 1.1, 1.2, 1.4, 1.5; spec ingest/sources).
 *
 * A source belongs to one site: what to watch (RSS / Atom, sitemap, a list
 * page with CSS selectors, a single URL), when (daily local times in an IANA
 * time zone), how much per run, and on what terms its content may be used.
 *
 * The terms — licence status, usage mode, commercial use, review due date,
 * trust level — are set only by the site's administrators through the
 * source service; nothing fetched from a page or produced by a model writes
 * them. Every change of terms appends a row to `ingest_source_licences`
 * (never updated, never deleted while the source exists), so the evidence
 * behind each state stays readable.
 *
 * Site-isolated (row-level security, `migrations/rls-policies.sql`), except
 * `ingest_schedule`: the scheduler's own state, read across sites to find
 * the due sources (the pattern of `audit_sites` / `link_scans`).
 */
export const ingestSources = pgTable(
  'lumibase_ingest_sources',
  {
    id: text('id').$defaultFn(() => nanoid()).primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** `rss` | `atom` | `sitemap` | `list_page` | `url`. */
    type: text('type').notNull(),
    url: text('url').notNull(),
    /** List pages: `{ item, link, title?, nextPage? }` CSS selectors; null for other types. */
    listSelectors: jsonb('list_selectors').$type<{ item: string; link: string; title?: string; nextPage?: string } | null>(),
    /** Local times of day (`HH:MM`, 24-hour) at which the source runs, in `timezone`. */
    scheduleTimes: text('schedule_times').array().notNull(),
    /** IANA time zone of `schedule_times`, e.g. `Asia/Shanghai`. */
    timezone: text('timezone').notNull(),
    maxItemsPerRun: integer('max_items_per_run').default(20).notNull(),
    /** `unknown` (default) | `licensed` | `own` | `open-license`. */
    licenceStatus: text('licence_status').default('unknown').notNull(),
    /** `discovery_only` (default) | `facts_only` | `licensed_derivative`. */
    usageMode: text('usage_mode').default('discovery_only').notNull(),
    commercialUse: boolean('commercial_use').default(false).notNull(),
    /** After this the terms must be reviewed again; overdue = no derivative use. */
    reviewDueAt: timestamp('review_due_at', { withTimezone: true }),
    /** `low` (default) | `medium` | `high`: set by administrators only. */
    trustLevel: text('trust_level').default('low').notNull(),
    /** What a derived article must credit, e.g. "Source: Example News, with a link". */
    attribution: text('attribution'),
    /** The current licence revision's validity (copied from it; null: open-ended). */
    licenceValidFrom: timestamp('licence_valid_from', { withTimezone: true }),
    licenceValidUntil: timestamp('licence_valid_until', { withTimezone: true }),
    /** The current licence revision (null: none recorded). */
    licenceRevisionId: text('licence_revision_id'),
    /** `active` | `paused`. */
    status: text('status').default('active').notNull(),
    /** `manual` | `failures` (paused by the health check). */
    pausedReason: text('paused_reason'),
    consecutiveFailures: integer('consecutive_failures').default(0).notNull(),
    /** `network` | `timeout` | `access_denied` | `extraction` | `quota` | `other`. */
    lastFailureCategory: text('last_failure_category'),
    lastFailureMessage: text('last_failure_message'),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    siteNameUnique: uniqueIndex('ingest_sources_site_name_unique').on(t.siteId, t.name),
    siteIdUnique: unique('ingest_sources_site_id_unique').on(t.siteId, t.id),
  }),
);

/**
 * Licence revisions of a source: append-only. Each records the terms in
 * effect from then on, the evidence (a contract reference, a licence URL, a
 * note), its scope and validity, and who set it.
 */
export const ingestSourceLicences = pgTable(
  'lumibase_ingest_source_licences',
  {
    id: text('id').$defaultFn(() => nanoid()).primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    sourceId: text('source_id').notNull(),
    licenceStatus: text('licence_status').notNull(),
    usageMode: text('usage_mode').notNull(),
    commercialUse: boolean('commercial_use').notNull(),
    trustLevel: text('trust_level').notNull(),
    evidence: text('evidence'),
    scope: text('scope'),
    validFrom: timestamp('valid_from', { withTimezone: true }),
    validUntil: timestamp('valid_until', { withTimezone: true }),
    reviewDueAt: timestamp('review_due_at', { withTimezone: true }),
    attribution: text('attribution'),
    setBy: text('set_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    sourceFk: foreignKey({
      columns: [t.siteId, t.sourceId],
      foreignColumns: [ingestSources.siteId, ingestSources.id],
      name: 'ingest_source_licences_source_fk',
    }).onDelete('cascade'),
    sourceIdx: index('ingest_source_licences_source_idx').on(t.siteId, t.sourceId, t.createdAt),
  }),
);

/** One row per run of a source: when, what came of it, why it failed. */
export const ingestSourceRuns = pgTable(
  'lumibase_ingest_source_runs',
  {
    id: text('id').$defaultFn(() => nanoid()).primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    sourceId: text('source_id').notNull(),
    /** The scheduled slot this run serves (manual runs: the request time). */
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }).notNull(),
    /** `scheduled` | `manual`. */
    trigger: text('trigger').default('scheduled').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    /** `running` | `succeeded` | `failed` | `skipped`. */
    outcome: text('outcome').default('running').notNull(),
    failureCategory: text('failure_category'),
    message: text('message'),
    itemsFound: integer('items_found').default(0).notNull(),
  },
  (t) => ({
    sourceFk: foreignKey({
      columns: [t.siteId, t.sourceId],
      foreignColumns: [ingestSources.siteId, ingestSources.id],
      name: 'ingest_source_runs_source_fk',
    }).onDelete('cascade'),
    // One run per scheduled slot: a redelivered job finds the slot taken.
    slotUnique: uniqueIndex('ingest_source_runs_slot_unique').on(t.sourceId, t.scheduledFor),
    sourceIdx: index('ingest_source_runs_source_idx').on(t.siteId, t.sourceId, t.startedAt),
  }),
);

/**
 * The scheduler's view of each active source: when it is next due. Read
 * across sites (no row-level security) by the scheduled task; it holds no
 * content, only ids and times. Kept in step with `ingest_sources` by the
 * source service (a paused source has no row).
 */
export const ingestSchedule = pgTable(
  'lumibase_ingest_schedule',
  {
    sourceId: text('source_id').primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }).notNull(),
  },
  (t) => ({
    sourceFk: foreignKey({
      columns: [t.siteId, t.sourceId],
      foreignColumns: [ingestSources.siteId, ingestSources.id],
      name: 'ingest_schedule_source_fk',
    }).onDelete('cascade'),
    dueIdx: index('ingest_schedule_due_idx').on(t.nextRunAt),
  }),
);
