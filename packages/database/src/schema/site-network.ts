import { sql } from 'drizzle-orm';
import { boolean, check, date, index, integer, jsonb, pgTable, pgView, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { nanoid } from 'nanoid';
import { sites } from './core';
import { collections, items } from './cms';

/**
 * The site network model (HeoPress P05, spec content/site-network-model).
 *
 * - `lumibase_site_presets`: which preset (and version) a site has installed;
 *   the preset itself is defined in code, its collections and fields carry
 *   `meta.preset`.
 * - `lumibase_site_content_settings`: one row per site, created with the
 *   site (and back-filled for existing sites): languages, time zone, site
 *   type, URL policy, per-collection permalink patterns, the cross-site
 *   translation switch and the sponsored-content policy. Writers that depend
 *   on it lock this row first (design §0 lock order).
 * - `lumibase_item_numbers`: the last item number per site and collection.
 */
export const sitePresets = pgTable(
  'lumibase_site_presets',
  {
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    preset: text('preset').notNull(),
    version: integer('version').notNull(),
    installedAt: timestamp('installed_at', { withTimezone: true }).defaultNow().notNull(),
    upgradedAt: timestamp('upgraded_at', { withTimezone: true }),
    /**
     * HeoPress P07 task 2.4: what the last install or upgrade added and what it skipped and why (a site field of the
     * same name is never overwritten) — kept, so the skips stay visible after the worker's site-wide upgrade.
     */
    report: jsonb('report').$type<Record<string, unknown>>(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.siteId, t.preset] }),
  }),
);

export const siteContentSettings = pgTable(
  'lumibase_site_content_settings',
  {
    siteId: text('site_id')
      .primaryKey()
      .references(() => sites.id, { onDelete: 'cascade' }),
    /** BCP 47 tags, always including `sites.default_language`. */
    availableLocales: jsonb('available_locales').$type<string[]>().default(sql`'[]'::jsonb`).notNull(),
    /** IANA time zone the permalink dates follow. */
    timezone: text('timezone').default('UTC').notNull(),
    /** `blog` | `news` | `docs` | `catalog` | `other`. */
    siteType: text('site_type').default('blog').notNull(),
    /** `always` | `never`. */
    trailingSlash: text('trailing_slash').default('always').notNull(),
    /** `subdirectory` | `subdomain` | `domain`. */
    localeStrategy: text('locale_strategy').default('subdirectory').notNull(),
    /** `default_at_root` | `all_prefixed`. */
    localePrefixMode: text('locale_prefix_mode').default('default_at_root').notNull(),
    /** locale → path prefix (subdirectory strategy). */
    localePrefixes: jsonb('locale_prefixes').$type<Record<string, string>>().default(sql`'{}'::jsonb`).notNull(),
    /** collection name → permalink pattern, e.g. `/:year/:month/:day/:slug`. */
    permalinks: jsonb('permalinks').$type<Record<string, string>>().default(sql`'{}'::jsonb`).notNull(),
    /** Both sites must turn it on before their items share a translation group (ADR-0009). */
    allowCrossSiteTranslations: boolean('allow_cross_site_translations').default(false).notNull(),
    /** Sponsored content (ADR-0016): show a disclosure; mark links `rel="sponsored"`. */
    sponsorDisclosure: boolean('sponsor_disclosure').default(true).notNull(),
    sponsorRel: boolean('sponsor_rel').default(true).notNull(),
    sponsorPolicyVersion: integer('sponsor_policy_version').default(1).notNull(),
    version: integer('version').default(1).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    trailingSlashValid: check('site_content_settings_trailing_slash_valid', sql`${t.trailingSlash} IN ('always', 'never')`),
    localeStrategyValid: check('site_content_settings_locale_strategy_valid', sql`${t.localeStrategy} IN ('subdirectory', 'subdomain', 'domain')`),
    localePrefixModeValid: check('site_content_settings_locale_prefix_mode_valid', sql`${t.localePrefixMode} IN ('default_at_root', 'all_prefixed')`),
  }),
);

/**
 * A site's SEO / GEO settings (HeoPress P07 task 1.4): the document `SiteSeoSettingsSchema` validates
 * (`@heopress/contracts`), versioned for conditional updates. The rendering service never reads it: the
 * public projection copies its public part into `lumibase_public_sites.seo`.
 */
export const siteSeoSettings = pgTable('lumibase_site_seo_settings', {
  siteId: text('site_id')
    .primaryKey()
    .references(() => sites.id, { onDelete: 'cascade' }),
  settings: jsonb('settings').$type<Record<string, unknown>>().default(sql`'{}'::jsonb`).notNull(),
  version: integer('version').default(1).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Whom a site speaks for (HeoPress P07 task 2.12): the document `SiteIdentitySchema` validates (`@heopress/contracts`),
 * versioned for conditional updates. The rendering service never reads it: the public projection copies it into
 * `lumibase_public_sites.identity`.
 */
export const siteIdentity = pgTable('lumibase_site_identity', {
  siteId: text('site_id')
    .primaryKey()
    .references(() => sites.id, { onDelete: 'cascade' }),
  identity: jsonb('identity').$type<Record<string, unknown>>().notNull(),
  version: integer('version').default(1).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * HeoPress P07 task 3.8: files a site serves at its root (search engine verification files, `ads.txt`, …), written by
 * its administrators — one per name, text only, the type derived from the name (`root-files.ts` in the CMS checks the
 * name, the size and that the system does not answer the name itself). The rendering service reads them through the
 * view `lumibase_render_root_files` (migration 0075), in one site's scope.
 */
export const siteRootFiles = pgTable(
  'lumibase_site_root_files',
  {
    id: text('id').primaryKey().$defaultFn(() => nanoid()),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    filename: text('filename').notNull(),
    contentType: text('content_type').notNull(),
    content: text('content').notNull(),
    sha256: text('sha256').notNull(),
    size: integer('size').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    siteFilename: uniqueIndex('site_root_files_site_filename').on(t.siteId, t.filename),
  }),
);

/**
 * HeoPress P07 task 3.4: sites waiting for their IndexNow pass. The event consumer writes one row per change event that
 * may change a site's public URLs (`event_id` unique: an event delivered twice is queued once), the reconciliation job one
 * per site and period; the worker takes a site's due rows (`FOR UPDATE SKIP LOCKED`, then a lease), works out what changed
 * from the public projection and the state below, and deletes them (or puts them off after a failure). A system table:
 * read across sites by the worker, no site-scoped policy.
 */
export const indexNowQueue = pgTable(
  'lumibase_indexnow_queue',
  {
    id: text('id').primaryKey().$defaultFn(() => nanoid()),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    eventId: text('event_id').notNull(),
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    leasedUntil: timestamp('leased_until', { withTimezone: true }),
    attempts: integer('attempts').default(0).notNull(),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    eventId: uniqueIndex('indexnow_queue_event').on(t.eventId),
    due: index('indexnow_queue_due').on(t.dueAt),
  }),
);

/**
 * What IndexNow was last told of each of a site's URLs (P07 task 3.4): its content fingerprint when it was pushed as
 * there. A URL no longer listable (deleted, not indexed, moved away from) is pushed once more and its row goes.
 */
export const indexNowState = pgTable(
  'lumibase_indexnow_state',
  {
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    fingerprint: text('fingerprint').notNull(),
    pushedAt: timestamp('pushed_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.siteId, t.url] }) }),
);

/**
 * A site's IndexNow status (P07 task 3.4): when its state was first recorded (the baseline: what was public when IndexNow
 * was turned on is not pushed), and its last pass.
 */
export const indexNowSites = pgTable('lumibase_indexnow_sites', {
  siteId: text('site_id')
    .primaryKey()
    .references(() => sites.id, { onDelete: 'cascade' }),
  seededAt: timestamp('seeded_at', { withTimezone: true }),
  lastRunAt: timestamp('last_run_at', { withTimezone: true }),
  lastStatus: text('last_status'),
  lastError: text('last_error'),
  pushedUrls: integer('pushed_urls').default(0).notNull(),
  /** One worker at a time works on a site's IndexNow pass (a lease, not a held transaction: the pass sends requests). */
  leasedUntil: timestamp('leased_until', { withTimezone: true }),
  /**
   * Whose lease it is (Codex review of batch 8): renewed before each request and released by its holder only — a worker
   * whose lease ran out and was taken stops, and never clears its successor's.
   */
  leaseToken: text('lease_token'),
});

/** What the rendering role reads of the root files (migration 0075; not managed by drizzle-kit): the current site's. */
export const renderRootFiles = pgView('lumibase_render_root_files', {
  siteId: text('site_id').notNull(),
  filename: text('filename').notNull(),
  contentType: text('content_type').notNull(),
  content: text('content').notNull(),
  sha256: text('sha256').notNull(),
}).existing();

export const itemNumbers = pgTable(
  'lumibase_item_numbers',
  {
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    collectionId: text('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    last: integer('last').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.siteId, t.collectionId] }),
  }),
);

/**
 * Content routes (HeoPress P05 tasks 1.3, 1.6; design B): the path of every
 * item of a collection with a permalink pattern, one row per item, kept in
 * the item's own write transaction. A path is unique per site and language;
 * drafts hold theirs too. Paths are stored in their internal form: no
 * language prefix, no trailing slash (`/2019/03/22/my-post`, `/10`).
 */
export const contentRoutes = pgTable(
  'lumibase_content_routes',
  {
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    itemId: text('item_id')
      .primaryKey()
      .references(() => items.id, { onDelete: 'cascade' }),
    collectionId: text('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    locale: text('locale').notNull(),
    path: text('path').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pathUnique: uniqueIndex('content_routes_site_locale_path_unique').on(t.siteId, t.locale, t.path),
  }),
);

/**
 * Redirects (HeoPress P05 tasks 1.3, 1.7, 1.8; design R6, R33–R37).
 *
 * `scope = 'content'`: a path of one language (no prefix), matched after the
 * route table missed; `scope = 'url'`: an external path (prefix included,
 * `locale` empty), matched before the language is recognised (a prefix that
 * was renamed). `match`: `exact`, or `prefix` (segment boundary, suffix
 * kept). The resolver applies them by priority until none matches and
 * answers one 301 (design R33).
 */
export const redirects = pgTable(
  'lumibase_redirects',
  {
    id: text('id').$defaultFn(() => nanoid()).primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    scope: text('scope').default('content').notNull(),
    /** The source's language (content scope); empty for the URL scope. */
    locale: text('locale').default('').notNull(),
    fromPath: text('from_path').notNull(),
    match: text('match').default('exact').notNull(),
    toPath: text('to_path').notNull(),
    /** The target's language (content scope); empty for the URL scope. */
    toLocale: text('to_locale').default('').notNull(),
    status: integer('status').default(301).notNull(),
    /** `slug_change` | `import` | `manual` | `prefix_change`. */
    source: text('source').notNull(),
    importId: text('import_id'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    sourceUnique: uniqueIndex('redirects_site_scope_locale_from_match_unique').on(t.siteId, t.scope, t.locale, t.fromPath, t.match),
    scopeValid: check('redirects_scope_valid', sql`${t.scope} IN ('content', 'url')`),
    matchValid: check('redirects_match_valid', sql`${t.match} IN ('exact', 'prefix')`),
    statusValid: check('redirects_status_valid', sql`${t.status} IN (301, 302, 307, 308)`),
  }),
);

/**
 * A site's editorial profile, versioned (HeoPress P05 tasks 2.1–2.3; design
 * C): every save is a new draft version (numbered under the site's content
 * settings lock); publishing one makes it the version in effect and the
 * previous one `superseded`. At most one `published` version per site.
 * Versions are never edited after they are written.
 */
export const editorialProfileVersions = pgTable(
  'lumibase_editorial_profile_versions',
  {
    id: text('id').$defaultFn(() => nanoid()).primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    /** Audience, tone, glossary, citation policy, structure, quality and publish rules, forbidden topics. */
    content: jsonb('content').$type<Record<string, unknown>>().notNull(),
    /** `draft` | `published` | `superseded`. */
    status: text('status').default('draft').notNull(),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    publishedBy: text('published_by'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
  },
  (t) => ({
    siteVersionUnique: uniqueIndex('editorial_profile_versions_site_version_unique').on(t.siteId, t.version),
    onePublished: uniqueIndex('editorial_profile_versions_one_published').on(t.siteId).where(sql`${t.status} = 'published'`),
    statusValid: check('editorial_profile_versions_status_valid', sql`${t.status} IN ('draft', 'published', 'superseded')`),
    versionPositive: check('editorial_profile_versions_version_positive', sql`${t.version} > 0`),
  }),
);

/**
 * Translation groups (HeoPress P05 tasks 4.1–4.5; design D, R1, R9, R18,
 * R24): the language versions of one piece of content, possibly on
 * different sites. `site_id` is the site that created the group; `site_ids`
 * every site with a member (kept under the group row's lock), which is what
 * lets a member site see the group row (its RLS policy). `source_item_id`
 * is the source member's item (null: no source, after the source was
 * deleted); `source_epoch` grows every time a source is set. `version` grows
 * on every member change: member writes give the version they saw.
 */
export const translationGroups = pgTable(
  'lumibase_translation_groups',
  {
    id: text('id').$defaultFn(() => nanoid()).primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    siteIds: text('site_ids').array().notNull(),
    sourceItemId: text('source_item_id'),
    sourceEpoch: integer('source_epoch').default(1).notNull(),
    /**
     * The member the group's `x-default` alternate names (HeoPress P07 task 2.2): output on every member page only
     * while it is a published, indexable member; cleared when it leaves the group or its item is removed.
     */
    xDefaultItemId: text('x_default_item_id').references(() => items.id, { onDelete: 'set null' }),
    version: integer('version').default(1).notNull(),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // A hard delete of an item clears the x-default naming it (ON DELETE SET NULL) without scanning the groups.
    xDefault: index('translation_groups_x_default').on(t.xDefaultItemId),
  }),
);

/**
 * A translation group's members: one row per item (an item is in at most one
 * group). `locale` follows the item's language in the item's own write
 * transaction. At most one `source` per group. `internal_only` (source
 * only): the item is a translation source that is never published.
 */
export const translationGroupMembers = pgTable(
  'lumibase_translation_group_members',
  {
    itemId: text('item_id')
      .primaryKey()
      .references(() => items.id, { onDelete: 'cascade' }),
    groupId: text('group_id')
      .notNull()
      .references(() => translationGroups.id, { onDelete: 'cascade' }),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    collectionId: text('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    locale: text('locale').notNull(),
    /** `source` | `translation`. */
    role: text('role').default('translation').notNull(),
    internalOnly: boolean('internal_only').default(false).notNull(),
    joinedBy: text('joined_by'),
    joinedAt: timestamp('joined_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    groupLocale: index('translation_group_members_group_locale').on(t.groupId, t.locale),
    oneSource: uniqueIndex('translation_group_members_one_source').on(t.groupId).where(sql`${t.role} = 'source'`),
    roleValid: check('translation_group_members_role_valid', sql`${t.role} IN ('source', 'translation')`),
    internalOnlySource: check('translation_group_members_internal_only_source', sql`NOT ${t.internalOnly} OR ${t.role} = 'source'`),
  }),
);

/**
 * Shared field sync intents (HeoPress P05 task 4.6; design D, R3, R4, R14, R24): a source item's save
 * that changed shared fields leaves one intent per other member, in the same transaction; the
 * `shared-field-sync` consumer applies it as the person (or key) who saved, with their permissions
 * on the member's site at that moment. `site_id` is the member's (target) site. One intent per
 * target, source, source epoch and source version; a newer one supersedes the target's unfinished
 * ones. `values` is the source's shared field values at that version.
 */
export const sharedFieldSyncs = pgTable(
  'lumibase_shared_field_syncs',
  {
    id: text('id').$defaultFn(() => nanoid()).primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    groupId: text('group_id')
      .notNull()
      .references(() => translationGroups.id, { onDelete: 'cascade' }),
    sourceItemId: text('source_item_id').notNull(),
    sourceEpoch: integer('source_epoch').notNull(),
    sourceVersion: integer('source_version').notNull(),
    targetItemId: text('target_item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    fields: text('fields').array().notNull(),
    values: jsonb('values').$type<Record<string, unknown>>().notNull(),
    /** Who saved the source: `user` | `api_key` | `agent` | `system`, and its ID. */
    triggerType: text('trigger_type').notNull(),
    triggerId: text('trigger_id'),
    /** `pending` | `applied` | `blocked_permission` | `blocked_hold` | `superseded`. */
    status: text('status').default('pending').notNull(),
    reason: text('reason'),
    notifiedAt: timestamp('notified_at', { withTimezone: true }),
    resolvedBy: text('resolved_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => ({
    intentUnique: uniqueIndex('shared_field_syncs_intent_unique').on(t.targetItemId, t.sourceItemId, t.sourceEpoch, t.sourceVersion),
    groupStatus: index('shared_field_syncs_group_status').on(t.groupId, t.status),
    statusValid: check(
      'shared_field_syncs_status_valid',
      sql`${t.status} IN ('pending', 'applied', 'blocked_permission', 'blocked_hold', 'superseded')`,
    ),
  }),
);

/**
 * Translation block maps (HeoPress P05 tasks 5.1–5.4; spec i18n/translation-freshness; design E,
 * R7, R9, R17): which source block a translation block was made from. A key is `<field>#<block ID>`
 * (`seo_title#$` and the like for whole SEO fields). `source_hash` / `target_hash` are the normalised
 * hashes when the mapping was written or accepted; a source block that changed, went or moved makes
 * the mapping `stale` (only a person's acceptance clears it). `human_edited` is sticky: a person's
 * edit of the target block sets it, nothing automatic clears it. `site_id` is the target's site.
 */
export const translationBlockMap = pgTable(
  'lumibase_translation_block_map',
  {
    id: text('id').$defaultFn(() => nanoid()).primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    groupId: text('group_id')
      .notNull()
      .references(() => translationGroups.id, { onDelete: 'cascade' }),
    sourceItemId: text('source_item_id').notNull(),
    sourceKey: text('source_key').notNull(),
    sourceHash: text('source_hash').notNull(),
    targetItemId: text('target_item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    targetKey: text('target_key').notNull(),
    targetHash: text('target_hash').notNull(),
    stale: boolean('stale').default(false).notNull(),
    /** `changed` | `deleted` | `moved` | `source_changed` | `source_removed`. */
    staleReason: text('stale_reason'),
    humanEdited: boolean('human_edited').default(false).notNull(),
    mappedBy: text('mapped_by'),
    mappedAt: timestamp('mapped_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    targetUnique: uniqueIndex('translation_block_map_target_unique').on(t.targetItemId, t.targetKey),
    bySource: index('translation_block_map_source').on(t.sourceItemId),
    reasonValid: check(
      'translation_block_map_reason_valid',
      sql`${t.staleReason} IS NULL OR ${t.staleReason} IN ('changed', 'deleted', 'moved', 'source_changed', 'source_removed')`,
    ),
  }),
);

/**
 * The block order of a source field when its mappings were last written or accepted (design R7):
 * what "moved" is judged against. `site_id` is the source's site.
 */
export const translationSourceBaselines = pgTable(
  'lumibase_translation_source_baselines',
  {
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    sourceItemId: text('source_item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    field: text('field').notNull(),
    blockOrder: text('block_order').array().notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.sourceItemId, t.field] }),
  }),
);

/**
 * HeoPress P07 task 5.3 (spec seo/link-graph): the site's internal link graph — one row per link, where it is and where it
 * points. `origin` `auto`: found in a public item's rich text (`source_item_id`, `field`, `position`: its place among the
 * field's links), from the public projection only (a draft's links never count); `manual`: registered by an administrator
 * (navigation the content does not hold; `source_label` says where). The target is kept as written (`target_url`, absolute,
 * without its fragment) and in the site's content space (`target_locale`, `target_path`; null when no language of the site
 * answers there): what it points to now is worked out when a report is made, so a target that goes away needs no refresh of
 * the pages linking to it. An item's edges are replaced as a whole when it changes; a full scan stamps every public item's
 * edges and only when it has finished removes the edges it did not stamp (a failed scan leaves the graph as it was).
 */
export const linkEdges = pgTable(
  'lumibase_link_edges',
  {
    id: text('id').primaryKey().$defaultFn(() => nanoid()),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    origin: text('origin').notNull(),
    sourceItemId: text('source_item_id'),
    sourceLabel: text('source_label'),
    field: text('field'),
    position: integer('position').default(0).notNull(),
    href: text('href').notNull(),
    targetUrl: text('target_url').notNull(),
    targetLocale: text('target_locale'),
    targetPath: text('target_path'),
    fragment: text('fragment'),
    anchorText: text('anchor_text').default('').notNull(),
    refreshedAt: timestamp('refreshed_at', { withTimezone: true }).defaultNow().notNull(),
    createdBy: text('created_by'),
  },
  (t) => ({
    bySource: index('link_edges_site_source').on(t.siteId, t.sourceItemId),
    byTarget: index('link_edges_site_target').on(t.siteId, t.targetLocale, t.targetPath),
    origin: check('link_edges_origin', sql`${t.origin} IN ('auto', 'manual')`),
  }),
);

/**
 * A site's full link scan (P07 task 5.3): batches of public items in id order, `cursor` the last one done — a scan that
 * fails or is interrupted goes on from there; `started_at` is what its clean-up compares (edges not stamped since were not
 * found again). `rerun`: asked for again while running (it starts over once finished). A system table: the worker reads it
 * across sites (a lease, as IndexNow's), the edges themselves are written in the site's scope.
 */
export const linkScans = pgTable('lumibase_link_scans', {
  siteId: text('site_id')
    .primaryKey()
    .references(() => sites.id, { onDelete: 'cascade' }),
  status: text('status').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  cursor: text('cursor'),
  processed: integer('processed').default(0).notNull(),
  rerun: boolean('rerun').default(false).notNull(),
  attempts: integer('attempts').default(0).notNull(),
  retryAt: timestamp('retry_at', { withTimezone: true }),
  lastError: text('last_error'),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  leasedUntil: timestamp('leased_until', { withTimezone: true }),
  leaseToken: text('lease_token'),
});

/**
 * HeoPress P07 task 5.1 (spec seo/site-audit): a site's audit issues — what its last audit found, one row per problem, by
 * rule (stable ids, `site-audit.ts`), severity and fingerprint (the same problem keeps its row and its first sighting
 * across runs; a problem no longer found is removed, so a site with nothing left to fix has no rows). `item_ids`: the pages
 * concerned (what a reader must be able to read to see the issue); `admin_only`: about what only administrators see
 * (registered links, the site's own structured data).
 */
export const auditIssues = pgTable(
  'lumibase_audit_issues',
  {
    id: text('id').primaryKey().$defaultFn(() => nanoid()),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    rule: text('rule').notNull(),
    severity: text('severity').notNull(),
    fingerprint: text('fingerprint').notNull(),
    itemIds: text('item_ids').array().default([]).notNull(),
    adminOnly: boolean('admin_only').default(false).notNull(),
    evidence: jsonb('evidence').$type<Record<string, unknown>>().notNull(),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).defaultNow().notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    fingerprint: uniqueIndex('audit_issues_site_fingerprint').on(t.siteId, t.fingerprint),
    byRule: index('audit_issues_site_rule').on(t.siteId, t.rule),
    severity: check('audit_issues_severity', sql`${t.severity} IN ('error', 'warning', 'notice')`),
  }),
);

/**
 * A site's audit runs (P07 task 5.1): asked for (`requested_at`: an administrator, or the daily check), the last run and
 * what it came to. A system table: the worker reads it across sites; the issues are written in the site's scope.
 */
export const auditSites = pgTable('lumibase_audit_sites', {
  siteId: text('site_id')
    .primaryKey()
    .references(() => sites.id, { onDelete: 'cascade' }),
  requestedAt: timestamp('requested_at', { withTimezone: true }),
  lastRunAt: timestamp('last_run_at', { withTimezone: true }),
  status: text('status'),
  issues: integer('issues').default(0).notNull(),
  truncated: boolean('truncated').default(false).notNull(),
  lastError: text('last_error'),
  leasedUntil: timestamp('leased_until', { withTimezone: true }),
  /** Whose run it is (Codex review of batch 10b, round 1): renewed as it goes; its results are kept only while it holds it. */
  leaseToken: text('lease_token'),
});

/**
 * HeoPress P07 tasks 6.1, 6.4 (spec analytics/ai-traffic): the AI traffic of a site — one row per request of a known
 * crawler or a visit an AI assistant referred, kept 7 days. Written only through `lumibase_record_crawl_hit` (migration
 * 0088, the rendering role's only write; reconciled by `lumibase_crawl_traffic_reconcile`, migration 0089): what it was (`kind`: `crawler` or `referral`; `agent`: the crawler's or the
 * assistant's id; their operator; the crawler's purpose), what it asked for (`resource`: a page, its Markdown copy,
 * `llms.txt`, `robots.txt`, a sitemap, a feed, another file; `path`: without the query) and an hash of the visitor's
 * address (keyed and changed every day by the rendering process, never the address). No User-Agent, referrer or query.
 */
export const crawlHits = pgTable(
  'lumibase_crawl_hits',
  {
    // A text id, not a sequence: `TRUNCATE … RESTART IDENTITY CASCADE` from the sites (the test suites) must not need to own one.
    id: text('id').primaryKey().default(sql`gen_random_uuid()::text`),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    at: timestamp('at', { withTimezone: true }).defaultNow().notNull(),
    kind: text('kind').notNull(),
    agent: text('agent').notNull(),
    operator: text('operator').notNull(),
    purpose: text('purpose'),
    resource: text('resource').notNull(),
    path: text('path').notNull(),
    ipHash: text('ip_hash'),
    status: integer('status').notNull(),
  },
  (t) => ({
    bySiteAt: index('crawl_hits_site_at').on(t.siteId, t.at),
    kind: check('crawl_hits_kind', sql`${t.kind} IN ('crawler', 'referral')`),
  }),
);

/** The day totals of a site's AI traffic (P07 task 6.2): kept when the details go. One row per day, agent, resource and path. */
export const crawlDaily = pgTable(
  'lumibase_crawl_daily',
  {
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    day: date('day').notNull(),
    kind: text('kind').notNull(),
    agent: text('agent').notNull(),
    operator: text('operator').notNull(),
    purpose: text('purpose').default('').notNull(),
    resource: text('resource').notNull(),
    path: text('path').notNull(),
    hits: integer('hits').default(0).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.siteId, t.day, t.kind, t.agent, t.resource, t.path] }),
    byDay: index('crawl_daily_site_day').on(t.siteId, t.day),
  }),
);

/**
 * The distinct paths of a site's day of AI traffic (P07 task 6.4, Codex review of batch 11): what the day's 10,000-path
 * bound counts — paths, whichever crawler or assistant read them (`(not found)` and `(other)` are not counted).
 */
export const crawlDailyPaths = pgTable(
  'lumibase_crawl_daily_paths',
  {
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    day: date('day').notNull(),
    path: text('path').notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.siteId, t.day, t.path] }) }),
);

/**
 * HeoPress P07 task 3.9 (spec seo/crawl-discovery "线上可达性体检"): a site's online reachability checks — asked for by an
 * administrator (`requested_at`, with the deployment platform the advice is written for and the verified hosts to check,
 * none: the site's own), the last run and what it came to. A system table, as `lumibase_audit_sites`: the worker reads it
 * across sites; the report is written in the site's scope (`lumibase_reachability_reports`).
 */
export const reachabilitySites = pgTable(
  'lumibase_reachability_sites',
  {
    siteId: text('site_id')
      .primaryKey()
      .references(() => sites.id, { onDelete: 'cascade' }),
    requestedAt: timestamp('requested_at', { withTimezone: true }),
    platform: text('platform').default('vps').notNull(),
    hosts: text('hosts').array(),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    status: text('status'),
    lastError: text('last_error'),
    leasedUntil: timestamp('leased_until', { withTimezone: true }),
    /** Whose run it is: renewed as it goes; its report is kept only while it holds it. */
    leaseToken: text('lease_token'),
  },
  (t) => ({
    platform: check('reachability_sites_platform', sql`${t.platform} IN ('vps', 'cloudflare', 'cloudflare-pages', 'vercel', 'netlify')`),
  }),
);

/**
 * The last reachability report of a site (P07 task 3.9): what each request expected and what the site's verified domains
 * answered, the simulated AI crawler requests (marked simulated), the AI crawler traffic hints and the platform's fix
 * advice — one row per site, replaced by each run. Site-isolated (row-level security).
 */
export const reachabilityReports = pgTable('lumibase_reachability_reports', {
  siteId: text('site_id')
    .primaryKey()
    .references(() => sites.id, { onDelete: 'cascade' }),
  report: jsonb('report').$type<Record<string, unknown>>().notNull(),
  errors: integer('errors').default(0).notNull(),
  warnings: integer('warnings').default(0).notNull(),
  finishedAt: timestamp('finished_at', { withTimezone: true }).defaultNow().notNull(),
});
