import { sql } from 'drizzle-orm';
import { bigint, bigserial, boolean, index, integer, jsonb, pgTable, pgView, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import { sites } from './core';

/**
 * The public projection (HeoPress P05 → P06 task 1.2; design R1, R13–R26): what the public may see,
 * written by the CMS in the same transaction as the content it derives from, and the only data the
 * rendering service's database role can read. A row exists only for public items (published, not
 * deleted, not an internal-only translation source) that have a path; `data` holds only the fields
 * whose definition allows publication (default deny, design R19). The rendering role cannot read
 * the base tables at all.
 *
 * Maintenance is checked by the database: statement triggers on the base tables record what a
 * transaction changed (`lumibase_projection_dirty`); the CMS flushes it before committing. What is
 * left unflushed at commit becomes a rebuild mark for every site depending on it (the site serves a
 * maintenance page until rebuilt), so stale public data is never served (design R26, R38).
 */

/** Active domains, public columns only (no verification token). Read before the site is known: not site-scoped. */
export const publicHosts = pgTable('lumibase_public_hosts', {
  hostname: text('hostname').primaryKey(),
  siteId: text('site_id')
    .notNull()
    .references(() => sites.id, { onDelete: 'cascade' }),
  isPrimary: boolean('is_primary').notNull(),
  entryLocale: text('entry_locale'),
  primaryHostname: text('primary_hostname'),
});

/** A site as rendering needs it: name, languages and the content settings that shape URLs and output. */
export const publicSites = pgTable('lumibase_public_sites', {
  siteId: text('site_id')
    .primaryKey()
    .references(() => sites.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  defaultLanguage: text('default_language').notNull(),
  settings: jsonb('settings').$type<Record<string, unknown>>().notNull(),
  /** HeoPress P07 task 1.4: the public part of the site's SEO / GEO settings (`lumibase_site_seo_settings`). */
  seo: jsonb('seo').$type<Record<string, unknown>>().default({}).notNull(),
  /** HeoPress P07 task 2.12: the site's identity (`lumibase_site_identity`); `{}`: none set. */
  identity: jsonb('identity').$type<Record<string, unknown>>().default({}).notNull(),
  /**
   * HeoPress P07 task 2.9: the site's contributed structured data — `nodes`, the site nodes of its extensions
   * (materialised from their manifests: the rendering service loads no extension), and `diagnostics`; `{}`: none.
   */
  structured: jsonb('structured').$type<Record<string, unknown>>().default({}).notNull(),
  /**
   * HeoPress P12 tasks 2.3–2.5: the content extensions of the site's enabled plugins — their routes, default templates
   * (Classic and Astro) and theme components (`PublicExtensions`, `@heopress/contracts/extensions`); `{}`: none. The
   * rendering engines read this, never a plugin.
   */
  extensions: jsonb('extensions').$type<Record<string, unknown>>().default({}).notNull(),
  /** Set by the first full build; until then (and while a rebuild is pending) the site is not served. */
  builtAt: timestamp('built_at', { withTimezone: true }),
});

/** A public item with a path. No foreign key to the item: a deletion must leave its tombstone first. */
export const publicItems = pgTable(
  'lumibase_public_items',
  {
    itemId: text('item_id').primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    collection: text('collection').notNull(),
    locale: text('locale').notNull(),
    path: text('path').notNull(),
    number: integer('number'),
    /** Public fields only; rich text already sanitised. */
    data: jsonb('data').$type<Record<string, unknown>>().notNull(),
    /** What a list shows: title, excerpt, url, date, image, sponsored. Built from the filtered data. */
    card: jsonb('card').$type<Record<string, unknown>>().notNull(),
    sponsored: boolean('sponsored').default(false).notNull(),
    sponsorName: text('sponsor_name'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    /** Version of the sanitiser that cleaned the rich text (a new version rebuilds). */
    sanitizer: integer('sanitizer').notNull(),
    /** The fields of `data` holding sanitised HTML (rich text): every other value is text, escaped on output. */
    richFields: text('rich_fields').array().default([]).notNull(),
    /**
     * The item's own indexing setting (`seo_robots`, HeoPress P07 task 2.8) as written, whether or not the field
     * is public: the rendering service decides indexing from it and the site's SEO snapshot (`@heopress/seo-geo`).
     */
    seoRobots: text('seo_robots'),
    /**
     * HeoPress P07 task 2.5: the SHA-256 of the item's normalised published content (content title, excerpt, rich-text
     * bodies; `@heopress/seo-geo` `normalizedContent`) and when it last changed — what `dateModified`, the sitemap's
     * `lastmod` and the feeds' update time say. A re-render, a theme or an SEO-field change keeps both. Null hash: a row
     * from before task 2.5, adopted without moving the time at its next refresh.
     */
    contentHash: text('content_hash'),
    contentModifiedAt: timestamp('content_modified_at', { withTimezone: true }),
    /**
     * HeoPress P07 task 2.4: the item's structured-data inputs the system vouches for, taken from the preset's own fields
     * (found by their preset key, whatever the site named them; a site field that merely shares a name is not one):
     * `faq`, the explicit questions and answers. `{}`: none.
     */
    structured: jsonb('structured').$type<Record<string, unknown>>().default({}).notNull(),
    /**
     * HeoPress P13 task 3.2: the row's render version — a new value of the render version sequence every time the row
     * is written or the item's language switch (`lumibase_public_alternates`) changes. A cached item page is valid only
     * while it is unchanged (`staleRenderCacheRows`, `apps/site-classic/src/cache.ts`).
     */
    renderVersion: bigint('render_version', { mode: 'number' })
      .default(sql`nextval('heopress_render_version_seq')`)
      .notNull(),
  },
  (t) => ({
    sitePath: index('public_items_site_locale_path').on(t.siteId, t.locale, t.path),
    /**
     * HeoPress P07 task 4.1 (Codex review of batch 9, rounds 5 and 6): a collection's items — of one language, or of all —
     * newest first, ties by id in code-point order (`COLLATE "C"`, as the renderer compares them) — read backwards with a
     * limit, never a sort of the collection (`llms.txt`'s candidates).
     */
    siteCollectionLocaleRecent: index('public_items_site_collection_locale_recent_c').on(t.siteId, t.collection, t.locale, t.publishedAt, sql`${t.itemId} COLLATE "C"`),
    // Also what `public_items_site_collection` (site, collection, published_at) served: it is this one's prefix (dropped in 0081).
    siteCollectionRecent: index('public_items_site_collection_recent_c').on(t.siteId, t.collection, t.publishedAt, sql`${t.itemId} COLLATE "C"`),
    /**
     * HeoPress P07 task 2.8 (Codex review of batch 12): the items indexed by their own setting
     * (`lumibase_robots_own_index`, migration 0090), newest first — the only candidates of a collection not indexed by
     * default, read without passing the rest (the discovery outputs' bounded scans).
     */
    siteCollectionOwnIndexRecent: index('public_items_site_collection_own_index_c')
      .on(t.siteId, t.collection, t.publishedAt, sql`${t.itemId} COLLATE "C"`)
      .where(sql`public.lumibase_robots_own_index(${t.seoRobots})`),
  }),
);

/** The language switch of an item as the viewing site (`site_id`) may show it. */
export const publicAlternates = pgTable(
  'lumibase_public_alternates',
  {
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    itemId: text('item_id').notNull(),
    locale: text('locale').notNull(),
    url: text('url').notNull(),
    targetItemId: text('target_item_id').notNull(),
  },
  (t) => ({
    // One entry per language (P07 task 2.2: `locale = 'x-default'` names the group's default member, which also has its own entry).
    pk: primaryKey({ columns: [t.siteId, t.itemId, t.locale] }),
  }),
);

/** The last public path of every item that was ever public: what a later deletion leaves a 410 on. */
export const publicPathMemory = pgTable('lumibase_public_path_memory', {
  itemId: text('item_id').primaryKey(),
  siteId: text('site_id')
    .notNull()
    .references(() => sites.id, { onDelete: 'cascade' }),
  locale: text('locale').notNull(),
  path: text('path').notNull(),
  /** The item's last public content hash and modification time (P07 task 2.5): kept while it is unpublished, so a republish of the same content keeps its time. */
  contentHash: text('content_hash'),
  contentModifiedAt: timestamp('content_modified_at', { withTimezone: true }),
});

/** Paths of deleted public items: 410 until the path is used again or becomes a redirect source. */
export const routeTombstones = pgTable(
  'lumibase_route_tombstones',
  {
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    locale: text('locale').notNull(),
    path: text('path').notNull(),
    itemId: text('item_id').notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.siteId, t.locale, t.path] }),
  }),
);

/**
 * A site's render versions, raised in the same transaction as the change (values of one sequence: they only grow and
 * never repeat). `version` rises with every change of the site's public output. `structureVersion` (HeoPress P13 task
 * 3.2) rises only with a change that can alter any page of the site — settings, domains, theme, redirects, root files,
 * collections and fields, extensions, and the categories and authors article pages name — not with a change of an
 * article alone: then only `version` and the item's own `lumibase_public_items.render_version` rise, and cached pages
 * of other articles stay valid.
 */
export const siteRenderVersions = pgTable('lumibase_site_render_versions', {
  siteId: text('site_id')
    .primaryKey()
    .references(() => sites.id, { onDelete: 'cascade' }),
  version: bigint('version', { mode: 'number' }).default(1).notNull(),
  structureVersion: bigint('structure_version', { mode: 'number' }).default(1).notNull(),
});

/** What a transaction changed in the base tables, until flushed (written by triggers only). */
export const projectionDirty = pgTable(
  'lumibase_projection_dirty',
  {
    seq: bigserial('seq', { mode: 'number' }).primaryKey(),
    txid: bigint('txid', { mode: 'number' }).notNull(),
    siteId: text('site_id'),
    tableName: text('table_name').notNull(),
    op: text('op').notNull(),
    objectId: text('object_id'),
    old: jsonb('old').$type<Record<string, unknown>>(),
    new: jsonb('new').$type<Record<string, unknown>>(),
  },
  (t) => ({
    byTx: index('projection_dirty_txid').on(t.txid),
  }),
);

/** The exact reasons of background refreshes (migrations 0056, 0060 and 0071 write them): never a prefix, so a new one is listed here. */
export const BACKGROUND_REFRESH_REASONS = ['refresh: language switch indexing', 'refresh: content modified time', 'refresh: structured data'] as const;

/**
 * Sites whose projection must be rebuilt (unflushed writes, design R26): not served until done — unless the reason is
 * one of `BACKGROUND_REFRESH_REASONS` (P07): a background refresh of a consistent projection, during which the
 * rendering service keeps serving the site. Any other reason, an unknown one included, is maintenance (503).
 */
export const projectionRebuilds = pgTable(
  'lumibase_projection_rebuilds',
  {
    seq: bigserial('seq', { mode: 'number' }).primaryKey(),
    siteId: text('site_id').notNull(),
    reason: text('reason').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    bySite: index('projection_rebuilds_site').on(t.siteId),
  }),
);

/**
 * The redirects the rendering role reads (migration 0030; not managed by drizzle-kit): public columns of
 * the current site only (`app.site_id`), nothing outside a site scope.
 */
export const renderRedirects = pgView('lumibase_render_redirects', {
  id: text('id').notNull(),
  siteId: text('site_id').notNull(),
  scope: text('scope').notNull(),
  locale: text('locale').notNull(),
  fromPath: text('from_path').notNull(),
  match: text('match').notNull(),
  toPath: text('to_path').notNull(),
  toLocale: text('to_locale').notNull(),
  status: integer('status').notNull(),
}).existing();

/**
 * Rendered pages (HeoPress P06 tasks 3.1–3.3; design §4, R8, R9; P13 task 3.2): the second level of the rendering
 * service's page cache, written and read by the rendering role. One row per answer address — a hash of the site, host,
 * path and normalised query — holding the render versions it was made under. A row is served only while they are
 * current (`staleRenderCacheRows` is the opposite): the theme version and the site's `structure_version`, and then
 *
 *   - an article's page (`item_id` set): that item's `render_version` — a change of another article leaves it valid;
 *   - any other answer (lists, discovery files, 410): the site's `version`, which every change raises.
 *
 * Every one of those versions is raised in the transaction of the change, so a row made from older data is never read
 * again, whether the change events arrive or not; the `render-cache-invalidation` consumer and the renderer's sweep
 * delete such rows. Public pages only, keyed per site: not site-scoped by row-level security (cross-site sweeps).
 */
export const renderCache = pgTable(
  'lumibase_render_cache',
  {
    key: text('key').primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    /** The site's `version` the answer was made under (every answer: the newer one replaces an older one). */
    siteVersion: bigint('site_version', { mode: 'number' }).notNull(),
    /** The site's `structure_version` the answer was made under. */
    structureVersion: bigint('structure_version', { mode: 'number' }).default(0).notNull(),
    /** The theme version it was rendered with (the built-in theme's id when the site has none). */
    themeVersion: text('theme_version').default('').notNull(),
    /** An article's page: the item and its `render_version` the page was made from. Null: any other answer. */
    itemId: text('item_id'),
    itemVersion: bigint('item_version', { mode: 'number' }),
    status: integer('status').notNull(),
    body: text('body').notNull(),
    etag: text('etag').notNull(),
    /** A 301's target without the request's query (the request's own query is appended when served). */
    location: text('location'),
    /** HeoPress P07 task 1.3: the answer's type and the representation headers the system generated for it. */
    contentType: text('content_type').default('text/html; charset=utf-8').notNull(),
    headers: jsonb('headers').$type<Record<string, string>>().default({}).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => ({
    bySiteVersion: index('render_cache_site_version').on(t.siteId, t.siteVersion),
    byExpiry: index('render_cache_expires').on(t.expiresAt),
  }),
);

/**
 * The condition of a site's level-2 rows that can no longer be served (HeoPress P13 task 3.2): made under an older
 * theme or structure version, or — an article's page — under another version of its item (or the item is no longer
 * public), or — any other answer — under an older site version. Read in the site's scope (the versions and the items
 * are under the optional row-level security). The consumer, the reconciliation and the renderer's sweep delete these.
 */
export function staleRenderCacheRows(siteId: string) {
  return sql`${renderCache.siteId} = ${siteId} AND (
    ${renderCache.structureVersion} < coalesce((SELECT ${siteRenderVersions.structureVersion} FROM ${siteRenderVersions} WHERE ${siteRenderVersions.siteId} = ${siteId}), 0)
    OR (${renderCache.itemId} IS NULL AND ${renderCache.siteVersion} < coalesce((SELECT ${siteRenderVersions.version} FROM ${siteRenderVersions} WHERE ${siteRenderVersions.siteId} = ${siteId}), 0))
    OR (${renderCache.itemId} IS NOT NULL AND ${renderCache.itemVersion} IS DISTINCT FROM (SELECT ${publicItems.renderVersion} FROM ${publicItems} WHERE ${publicItems.siteId} = ${siteId} AND ${publicItems.itemId} = ${renderCache.itemId})))`;
}
