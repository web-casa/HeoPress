import { boolean, foreignKey, index, integer, pgTable, text, timestamp, unique, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { items } from './cms';
import { sites } from './core';
import { ingestSourceDocuments } from './ingest';

/**
 * What happens to ingested content after it is registered (HeoPress P08 tasks 1.6, 1.7, 2.9; spec ingest/sources
 * "授权失效后的已发布内容", "研究线索", ingest/crawling "来源媒体处理"). Every table is site-isolated (row-level
 * security, `migrations/rls-policies.sql`).
 */

/**
 * Per-site ingestion settings set by the site's administrators: what happens to published derivative content when a
 * source's licence lapses (`hide`, the default: off the public site and into the review queue; `flag`: stays public,
 * queued for review), and the primary-source allow-list research leads are made from (`host[/path-prefix][*]`
 * patterns, e.g. `example.com/releases/`, `*.example.org/docs/`).
 */
export const ingestSiteSettings = pgTable('lumibase_ingest_site_settings', {
  siteId: text('site_id')
    .primaryKey()
    .references(() => sites.id, { onDelete: 'cascade' }),
  licenceLapsePolicy: text('licence_lapse_policy').default('hide').notNull(),
  primarySourcePatterns: text('primary_source_patterns').array().default(sql`'{}'::text[]`).notNull(),
  updatedBy: text('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Provenance of content (task 1.6): this item was derived from that source document by that operation (`translate`,
 * `rewrite`, `extract_facts`). Written by the processing pipeline (P09) when it creates the item. A source document
 * that content derives from cannot be deleted (no cascade from the document), so neither can its source.
 */
export const contentProvenance = pgTable(
  'lumibase_content_provenance',
  {
    id: text('id').$defaultFn(() => nanoid()).primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    itemId: text('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    sourceDocumentId: text('source_document_id').notNull(),
    sourceId: text('source_id').notNull(),
    /** The usage operation the item needed (`translate` | `rewrite` | `extract_facts` | `use_as_lead`). */
    operation: text('operation').notNull(),
    /**
     * HeoPress P13 task 5.1: the source document's snapshot was erased under a personal-data deletion request while
     * this content was still waiting for review — the source is missing and the content went back to review.
     */
    sourceMissingAt: timestamp('source_missing_at', { withTimezone: true }),
    sourceMissingReason: text('source_missing_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    documentFk: foreignKey({
      columns: [t.siteId, t.sourceDocumentId],
      foreignColumns: [ingestSourceDocuments.siteId, ingestSourceDocuments.id],
      name: 'content_provenance_document_fk',
    }).onDelete('restrict'),
    itemDocumentUnique: uniqueIndex('content_provenance_item_document_unique').on(t.siteId, t.itemId, t.sourceDocumentId),
    sourceIdx: index('content_provenance_source_idx').on(t.siteId, t.sourceId),
  }),
);

/**
 * The licence review queue (task 1.6): one row per item whose source's licence lapsed (expired, review overdue,
 * revoked). `action` is what the sweep did under the site's policy: `hidden` (status, editorial state and hold before
 * it are kept to restore them) or `flagged`. `open` until a person resolves it: `restored` (public again, only once the
 * licence is effective) or `dismissed` (stays as it is).
 */
export const licenceLapseReviews = pgTable(
  'lumibase_licence_lapse_reviews',
  {
    id: text('id').$defaultFn(() => nanoid()).primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    itemId: text('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    sourceId: text('source_id').notNull(),
    /** The source's licence revision that lapsed: a review is opened once per item, source and revision. */
    licenceRevisionId: text('licence_revision_id'),
    /** `licence_expired` | `review_overdue` | `licence_not_started` | `licence_unknown` | `revoked`. */
    reason: text('reason').notNull(),
    /** `hidden` | `flagged`. */
    action: text('action').notNull(),
    previousStatus: text('previous_status').notNull(),
    previousEditorialState: text('previous_editorial_state'),
    previousHold: boolean('previous_hold').default(false).notNull(),
    /** `open` | `restored` | `dismissed`. */
    state: text('state').default('open').notNull(),
    detectedAt: timestamp('detected_at', { withTimezone: true }).defaultNow().notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedBy: text('resolved_by'),
  },
  (t) => ({
    openUnique: uniqueIndex('licence_lapse_reviews_open_unique').on(t.siteId, t.itemId).where(sql`${t.state} = 'open'`),
    stateIdx: index('licence_lapse_reviews_state_idx').on(t.siteId, t.state, t.detectedAt),
  }),
);

/**
 * Research leads (task 1.7): an outbound link of a discovery-only source's document that matches the site's
 * primary-source allow-list. The chain is kept (origin source → origin document → link). The target is fetched as a
 * source document of its **own** source (`lead_source_id`: an existing source of the site on that host, or one managed
 * for the host with default terms) — never under the origin source's terms. `pending` → `queued` (a fetch job exists)
 * → the fetch's outcome is on the discovered URL.
 */
export const ingestResearchLeads = pgTable(
  'lumibase_ingest_research_leads',
  {
    id: text('id').$defaultFn(() => nanoid()).primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    originSourceId: text('origin_source_id').notNull(),
    originDocumentId: text('origin_document_id').notNull(),
    url: text('url').notNull(),
    normalizedUrl: text('normalized_url').notNull(),
    matchedPattern: text('matched_pattern').notNull(),
    leadSourceId: text('lead_source_id'),
    discoveredUrlId: text('discovered_url_id'),
    /** `pending` | `queued` | `refused`. */
    status: text('status').default('pending').notNull(),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    originFk: foreignKey({
      columns: [t.siteId, t.originDocumentId],
      foreignColumns: [ingestSourceDocuments.siteId, ingestSourceDocuments.id],
      name: 'ingest_research_leads_document_fk',
    }).onDelete('cascade'),
    documentUrlUnique: uniqueIndex('ingest_research_leads_document_url_unique').on(t.siteId, t.originDocumentId, t.normalizedUrl),
    statusIdx: index('ingest_research_leads_status_idx').on(t.siteId, t.status, t.createdAt),
  }),
);

/**
 * Licence of one media item (task 2.9), separate from its article's: evidence, attribution, the uses allowed
 * (`copy` lets the pipeline download and keep it) and validity. Without a record a media item is never copied.
 */
export const ingestMediaLicences = pgTable(
  'lumibase_ingest_media_licences',
  {
    id: text('id').$defaultFn(() => nanoid()).primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    /** The media URL, normalised. */
    url: text('url').notNull(),
    evidence: text('evidence').notNull(),
    attribution: text('attribution'),
    allowedUses: text('allowed_uses').array().notNull(),
    validUntil: timestamp('valid_until', { withTimezone: true }),
    setBy: text('set_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    siteUrlUnique: uniqueIndex('ingest_media_licences_site_url_unique').on(t.siteId, t.url),
  }),
);

/**
 * Downloaded source media (task 2.9): one row per site and SHA-256 of the bytes — the same image from two documents,
 * or a retry, is one row. The object (`ingest/media/<site>/<sha256>.<ext>`) is content-addressed; the format comes
 * from the bytes, never from the URL or the response headers.
 */
export const ingestMedia = pgTable(
  'lumibase_ingest_media',
  {
    id: text('id').$defaultFn(() => nanoid()).primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    sha256: text('sha256').notNull(),
    storageKey: text('storage_key').notNull(),
    /** `png` | `jpeg` | `gif` | `webp`. */
    format: text('format').notNull(),
    byteSize: integer('byte_size').notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    licenceId: text('licence_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    siteHashUnique: uniqueIndex('ingest_media_site_hash_unique').on(t.siteId, t.sha256),
    siteIdUnique: unique('ingest_media_site_id_unique').on(t.siteId, t.id),
  }),
);

/**
 * Which media a source document references (task 2.9), and what became of each: `pending` (to be processed),
 * `unlicensed` (no licence evidence: not downloaded, the original URL kept for a person to handle), `stored`
 * (`media_id`), `failed` (`reason`; a later pass retries technical failures). One image failing never touches the
 * document or the other images.
 */
export const ingestDocumentMedia = pgTable(
  'lumibase_ingest_document_media',
  {
    id: text('id').$defaultFn(() => nanoid()).primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    documentId: text('document_id').notNull(),
    position: integer('position').notNull(),
    url: text('url').notNull(),
    normalizedUrl: text('normalized_url').notNull(),
    status: text('status').default('pending').notNull(),
    reason: text('reason'),
    attempts: integer('attempts').default(0).notNull(),
    mediaId: text('media_id'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    documentFk: foreignKey({
      columns: [t.siteId, t.documentId],
      foreignColumns: [ingestSourceDocuments.siteId, ingestSourceDocuments.id],
      name: 'ingest_document_media_document_fk',
    }).onDelete('cascade'),
    mediaFk: foreignKey({
      columns: [t.siteId, t.mediaId],
      foreignColumns: [ingestMedia.siteId, ingestMedia.id],
      name: 'ingest_document_media_media_fk',
    }).onDelete('restrict'),
    documentUrlUnique: uniqueIndex('ingest_document_media_document_url_unique').on(t.siteId, t.documentId, t.normalizedUrl),
    statusIdx: index('ingest_document_media_status_idx').on(t.siteId, t.status),
  }),
);
