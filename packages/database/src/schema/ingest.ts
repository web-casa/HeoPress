import { boolean, check, foreignKey, index, integer, jsonb, pgTable, primaryKey, real, text, timestamp, unique, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
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
    /** `rss` | `atom` | `sitemap` | `list_page` | `url` | `plugin` (P12: a plugin adapter, see `adapter`). */
    type: text('type').notNull(),
    url: text('url').notNull(),
    /** HeoPress P12 task 4.1: a `plugin` source's adapter, `<plugin name>#<adapter id>`; null for the built-in types. */
    adapter: text('adapter'),
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
    /**
     * Who manages the source (HeoPress P08 task 1.7): null — the site's people; `research_leads` — created for a
     * primary-source host by research leads, with default terms, never scheduled (its documents come from leads).
     */
    managedBy: text('managed_by'),
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
    /** Discovery (HeoPress P08 task 1.3): URLs listed by the feed / sitemap / list page this run, new ones, and duplicates
     * (already seen URLs, plus fetched pages whose content the site already had). */
    itemsDiscovered: integer('items_discovered').default(0).notNull(),
    itemsNew: integer('items_new').default(0).notNull(),
    itemsDuplicate: integer('items_duplicate').default(0).notNull(),
    /** Why discovery stopped before the end (task 2.8): `max_pages` | `max_items` | `max_bytes` | `max_duration` | `quota` | `cycle` | `fetch_failed:<category>`. */
    stopReason: text('stop_reason'),
    /**
     * Ownership of a running run (HeoPress P08 task 2.7): the worker holding it renews `lease_until`; when the lease
     * lapses another delivery takes the run over and increments `generation`. Every write a worker makes on behalf of
     * the run names the generation it holds, so a worker that lost the run cannot overwrite the new owner's results.
     */
    generation: integer('generation').default(1).notNull(),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
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

/**
 * Raw HTML snapshots (HeoPress P08 tasks 2.3, 2.5, 2.7): one row per site and content hash, registered **before** the
 * object is written to storage (`ingest/snapshots/<site>/<sha256>.html`, outside every public media prefix). A source
 * document references its snapshot by foreign key, so a snapshot in use cannot be removed; one that no document
 * references and that has not been written for longer than the grace period is an orphan, and the sweeper deletes the
 * row and the object. `last_written_at` moves on every write, so a retry inside the grace period keeps it alive.
 */
export const ingestSnapshots = pgTable(
  'lumibase_ingest_snapshots',
  {
    id: text('id').$defaultFn(() => nanoid()).primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    sha256: text('sha256').notNull(),
    storageKey: text('storage_key').notNull(),
    byteSize: integer('byte_size').notNull(),
    contentType: text('content_type').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    lastWrittenAt: timestamp('last_written_at', { withTimezone: true }).defaultNow().notNull(),
    /**
     * Tombstone (HeoPress P13 task 5.1, ADR-0013): when the content was deleted — the object removed, the row kept with
     * its hash so the documents referencing it show what was there (hash, their rule version, this time and the reason).
     * Null while the content is stored. A later fetch of the same content stores it again and clears the tombstone.
     */
    contentDeletedAt: timestamp('content_deleted_at', { withTimezone: true }),
    /** `retention_expired` (past the retention period, only audit references left) | `personal_data_erasure`. */
    deletionReason: text('deletion_reason'),
  },
  (t) => ({
    tombstoneCheck: check(
      'ingest_snapshots_tombstone_check',
      sql`(${t.contentDeletedAt} IS NULL AND ${t.deletionReason} IS NULL) OR (${t.contentDeletedAt} IS NOT NULL AND ${t.deletionReason} IN ('retention_expired', 'personal_data_erasure'))`,
    ),
    siteHashUnique: uniqueIndex('ingest_snapshots_site_hash_unique').on(t.siteId, t.sha256),
    siteIdUnique: unique('ingest_snapshots_site_id_unique').on(t.siteId, t.id),
    writtenIdx: index('ingest_snapshots_written_idx').on(t.siteId, t.lastWrittenAt),
  }),
);

/** What was hidden in a page and taken out of the processed body (HeoPress P08 task 2.6). */
export interface HiddenContentEvidence {
  /** `invisible_chars` | `css_hidden` | `hidden_attribute` | `aria_hidden` | `offscreen` | `tiny_font` | `same_color` | `comment_instruction` | `model_instruction`. */
  kind: string;
  /** Where: a short CSS-like path of the element, or `comment` / `text`. */
  location: string;
  /** The hidden text, cut to 200 characters (for invisible characters: their code points). */
  excerpt: string;
}

/**
 * Source documents (HeoPress P08 task 2.7): one fetched and extracted page, with everything needed to trace it — the
 * source and the terms it had at fetch time, how it was fetched, the raw snapshot and the extraction rule version.
 * Written in one transaction with its fetch attempt, its processing job and its `source_document.create` event.
 * `operation_id` names the fetch (run slot and URL): a retry of the same operation with the same content returns the
 * existing document; with different content it is rejected.
 */
export const ingestSourceDocuments = pgTable(
  'lumibase_ingest_source_documents',
  {
    id: text('id').$defaultFn(() => nanoid()).primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    sourceId: text('source_id').notNull(),
    runId: text('run_id'),
    operationId: text('operation_id').notNull(),
    url: text('url').notNull(),
    /** URL after normalisation for deduplication (task 4.1); until then the URL as fetched. */
    normalizedUrl: text('normalized_url').notNull(),
    finalUrl: text('final_url').notNull(),
    title: text('title').notNull(),
    author: text('author'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    language: text('language'),
    /** The page's declared canonical URL: a candidate only, never followed or adopted here (task 4.3). */
    canonicalCandidate: text('canonical_candidate'),
    /**
     * Near-duplicate check (HeoPress P08 task 4.2): `unique` | `duplicate` | `skipped` (with `near_duplicate_reason`,
     * e.g. no embedding provider). A duplicate names the earlier document, the cosine similarity and the scope:
     * `same_site`, or `cross_site` with the other site in `duplicate_site_id` — never returned to a caller without rights
     * on that site (task 4.3).
     */
    nearDuplicateCheck: text('near_duplicate_check').default('skipped').notNull(),
    nearDuplicateReason: text('near_duplicate_reason'),
    duplicateOf: text('duplicate_of'),
    duplicateSimilarity: real('duplicate_similarity'),
    duplicateScope: text('duplicate_scope'),
    duplicateSiteId: text('duplicate_site_id'),
    /** Event aggregation (task 4.4): the cluster, this document's role in it (`representative` | `supplementary`) and its key entities. */
    eventClusterId: text('event_cluster_id'),
    clusterRole: text('cluster_role'),
    eventEntities: text('event_entities').array().default([]).notNull(),
    /** Sanitised article HTML, hidden content removed. */
    bodyHtml: text('body_html').notNull(),
    bodyText: text('body_text').notNull(),
    /** SHA-256 of the normalised body text. */
    contentHash: text('content_hash').notNull(),
    snapshotId: text('snapshot_id').notNull(),
    extractionRuleVersion: text('extraction_rule_version').notNull(),
    hiddenContent: jsonb('hidden_content').$type<HiddenContentEvidence[]>().default([]).notNull(),
    /** `native` (this fetcher) or a crawl service plugin (task 3.x). */
    fetchMethod: text('fetch_method').notNull(),
    fetchProvider: text('fetch_provider').notNull(),
    httpStatus: integer('http_status'),
    /** The source's terms when the page was fetched (they may change later; P09 checks the current ones). */
    licenceStatus: text('licence_status').notNull(),
    usageMode: text('usage_mode').notNull(),
    commercialUse: boolean('commercial_use').notNull(),
    licenceRevisionId: text('licence_revision_id'),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    sourceFk: foreignKey({
      columns: [t.siteId, t.sourceId],
      foreignColumns: [ingestSources.siteId, ingestSources.id],
      name: 'ingest_source_documents_source_fk',
    }).onDelete('cascade'),
    snapshotFk: foreignKey({
      columns: [t.siteId, t.snapshotId],
      foreignColumns: [ingestSnapshots.siteId, ingestSnapshots.id],
      name: 'ingest_source_documents_snapshot_fk',
    }).onDelete('no action'),
    siteIdUnique: unique('ingest_source_documents_site_id_unique').on(t.siteId, t.id),
    operationUnique: uniqueIndex('ingest_source_documents_operation_unique').on(t.siteId, t.operationId),
    sourceIdx: index('ingest_source_documents_source_idx').on(t.siteId, t.sourceId, t.createdAt),
    urlIdx: index('ingest_source_documents_url_idx').on(t.siteId, t.normalizedUrl),
    snapshotIdx: index('ingest_source_documents_snapshot_idx').on(t.siteId, t.snapshotId),
    contentHashIdx: index('ingest_source_documents_content_hash_idx').on(t.siteId, t.contentHash),
    clusterIdx: index('ingest_source_documents_cluster_idx').on(t.siteId, t.eventClusterId),
  }),
);

/** Every fetch of a URL, succeeded or not (HeoPress P08 tasks 2.2, 2.7): why it failed, how long it took. */
export const ingestFetchAttempts = pgTable(
  'lumibase_ingest_fetch_attempts',
  {
    id: text('id').$defaultFn(() => nanoid()).primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    sourceId: text('source_id').notNull(),
    runId: text('run_id'),
    operationId: text('operation_id').notNull(),
    url: text('url').notNull(),
    finalUrl: text('final_url'),
    fetchMethod: text('fetch_method').notNull(),
    fetchProvider: text('fetch_provider').notNull(),
    /** `succeeded` | `failed` | `duplicate` (the operation already had this document). */
    outcome: text('outcome').notNull(),
    failureCategory: text('failure_category'),
    message: text('message'),
    httpStatus: integer('http_status'),
    bytes: integer('bytes'),
    durationMs: integer('duration_ms'),
    sourceDocumentId: text('source_document_id'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    sourceFk: foreignKey({
      columns: [t.siteId, t.sourceId],
      foreignColumns: [ingestSources.siteId, ingestSources.id],
      name: 'ingest_fetch_attempts_source_fk',
    }).onDelete('cascade'),
    sourceIdx: index('ingest_fetch_attempts_source_idx').on(t.siteId, t.sourceId, t.startedAt),
    operationIdx: index('ingest_fetch_attempts_operation_idx').on(t.siteId, t.operationId),
  }),
);

/**
 * The follow-up processing of a source document (transactional outbox, HeoPress P08 task 2.7): written in the
 * document's transaction, so there is never a job without a document nor a document without its job. A dispatcher
 * hands `pending` rows to the queue and marks them `enqueued`; processing itself is P09.
 */
export const ingestProcessingJobs = pgTable(
  'lumibase_ingest_processing_jobs',
  {
    id: text('id').$defaultFn(() => nanoid()).primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    sourceDocumentId: text('source_document_id').notNull(),
    /** `process` (the body may be processed under the source's usage) | `lead` (discovery only: title and link, never the body; task 1.7). */
    kind: text('kind').default('process').notNull(),
    /** `pending` | `enqueued`. */
    status: text('status').default('pending').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    enqueuedAt: timestamp('enqueued_at', { withTimezone: true }),
  },
  (t) => ({
    documentFk: foreignKey({
      columns: [t.siteId, t.sourceDocumentId],
      foreignColumns: [ingestSourceDocuments.siteId, ingestSourceDocuments.id],
      name: 'ingest_processing_jobs_document_fk',
    }).onDelete('cascade'),
    documentKindUnique: uniqueIndex('ingest_processing_jobs_document_kind_unique').on(t.siteId, t.sourceDocumentId, t.kind),
    pendingIdx: index('ingest_processing_jobs_pending_idx').on(t.status, t.createdAt),
  }),
);

/**
 * Per-host politeness across every worker process (HeoPress P08 task 2.2): a host has up to N slots (its concurrency);
 * a fetch holds one under a lease, and a new fetch may start only when the host's minimum interval has passed since
 * the last start. Global, like `ingest_schedule`: host names and times only, no site data, no row-level security.
 * Taken under a transaction-scoped advisory lock per host, so two processes never take the same slot.
 */
export const ingestHostSlots = pgTable(
  'lumibase_ingest_host_slots',
  {
    host: text('host').notNull(),
    slot: integer('slot').notNull(),
    holder: text('holder'),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    lastStartedAt: timestamp('last_started_at', { withTimezone: true }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.host, t.slot] }),
  }),
);

/**
 * Discovery cursor of a source (HeoPress P08 task 2.8): how far pagination / backfill got. The **attempt** cursor moves
 * when a page is about to be fetched; the **success** cursor only after that page's links were all registered — a
 * failure never moves it. Both are written only by the run's current owner (generation checked in the same
 * transaction), so a worker that lost its run cannot overwrite the new owner's progress.
 */
export interface DiscoveryCursor {
  /** The page (normalised URL). */
  page: string;
  /** The next page to continue from (null: the end was reached). */
  next: string | null;
  /** True when the run reached pages it had already seen, or the last page: nothing left to backfill. */
  caughtUp: boolean;
}

export const ingestSourceCursors = pgTable(
  'lumibase_ingest_source_cursors',
  {
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    sourceId: text('source_id').notNull(),
    attemptCursor: jsonb('attempt_cursor').$type<DiscoveryCursor | null>(),
    attemptRunId: text('attempt_run_id'),
    attemptAt: timestamp('attempt_at', { withTimezone: true }),
    successCursor: jsonb('success_cursor').$type<DiscoveryCursor | null>(),
    successRunId: text('success_run_id'),
    successAt: timestamp('success_at', { withTimezone: true }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.siteId, t.sourceId] }),
    sourceFk: foreignKey({
      columns: [t.siteId, t.sourceId],
      foreignColumns: [ingestSources.siteId, ingestSources.id],
      name: 'ingest_source_cursors_source_fk',
    }).onDelete('cascade'),
  }),
);

/**
 * Every URL discovery found for a site (HeoPress P08 tasks 1.3, 4.1), keyed by its normalised form: a URL is fetched
 * once per site, whichever source finds it first; a tracking-parameter variant is the same URL.
 * `queued` → `fetched` | `duplicate` (the content was already there) | `refused` (outbound boundary, scheme or
 * credentials) | `failed`.
 */
export const ingestDiscoveredUrls = pgTable(
  'lumibase_ingest_discovered_urls',
  {
    id: text('id').$defaultFn(() => nanoid()).primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    sourceId: text('source_id').notNull(),
    normalizedUrl: text('normalized_url').notNull(),
    url: text('url').notNull(),
    title: text('title'),
    runId: text('run_id'),
    status: text('status').default('queued').notNull(),
    reason: text('reason'),
    sourceDocumentId: text('source_document_id'),
    discoveredAt: timestamp('discovered_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    sourceFk: foreignKey({
      columns: [t.siteId, t.sourceId],
      foreignColumns: [ingestSources.siteId, ingestSources.id],
      name: 'ingest_discovered_urls_source_fk',
    }).onDelete('cascade'),
    siteUrlUnique: uniqueIndex('ingest_discovered_urls_site_url_unique').on(t.siteId, t.normalizedUrl),
    sourceIdx: index('ingest_discovered_urls_source_idx').on(t.siteId, t.sourceId, t.discoveredAt),
  }),
);

/**
 * Event clusters (HeoPress P08 task 4.4): reports of the same event in one site — the same key entities within a time
 * window. One representative document goes to processing; the others are supplementary references on it.
 */
export const ingestEventClusters = pgTable(
  'lumibase_ingest_event_clusters',
  {
    id: text('id').$defaultFn(() => nanoid()).primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    /** SHA-256 (first 32 hex) of the representative's sorted strong entities. */
    fingerprint: text('fingerprint').notNull(),
    entities: text('entities').array().notNull(),
    representativeDocumentId: text('representative_document_id').notNull(),
    memberCount: integer('member_count').default(1).notNull(),
    /** The event time window seen so far (published time, or fetch time without one). */
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    windowIdx: index('ingest_event_clusters_window_idx').on(t.siteId, t.lastSeenAt),
  }),
);

/**
 * The deployment-wide near-duplicate index (HeoPress P08 tasks 4.2, 4.3): one row per source document with its body
 * embedding and content hash — **no text, title or URL**. Global (no row-level security) so the internal duplicate
 * check can compare across the sites of one deployment; it is read only by `near-duplicate.ts`, and what it finds is
 * shown to a caller only after a live permission check on the other site.
 */
export const ingestDedupIndex = pgTable(
  'lumibase_ingest_dedup_index',
  {
    documentId: text('document_id').primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    contentHash: text('content_hash').notNull(),
    embeddingModel: text('embedding_model').notNull(),
    embedding: real('embedding').array().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    documentFk: foreignKey({
      columns: [t.siteId, t.documentId],
      foreignColumns: [ingestSourceDocuments.siteId, ingestSourceDocuments.id],
      name: 'ingest_dedup_index_document_fk',
    }).onDelete('cascade'),
    modelIdx: index('ingest_dedup_index_model_idx').on(t.embeddingModel, t.createdAt),
  }),
);
