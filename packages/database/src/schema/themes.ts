import { customType, foreignKey, index, integer, jsonb, pgTable, pgView, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { nanoid } from 'nanoid';
import { sites } from './core';

/**
 * Site themes (HeoPress P06 tasks 2.3, 2.4, 2.7; design §5, R6, R23, R34): immutable versions of Liquid
 * templates and their assets, one active version per site.
 *
 *   - A version and its assets are created in one transaction and sealed (`heopress_seal_theme_version`,
 *     migration 0032): after that its templates, asset manifest, content hash and assets never change; a
 *     version that was ever published is never deleted. A change is a new version.
 *   - Assets live in the database (≤ 2 MB each, ≤ 20 MB per version, SHA-256 checked): the rendering
 *     service needs no storage credentials, and reads only published versions of its own site.
 *   - `checks` records the pre-publication checks (static and smoke rendering) for the version's content
 *     hash and the checker's version; activation requires them current and passing.
 *   - `lumibase_site_themes` is the site's pointer: publishing, switching and rolling back move it, under
 *     the site's settings row lock, with the render version raised in the same transaction.
 */

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

export interface ThemeAssetEntry {
  path: string;
  sha256: string;
  contentType: string;
  size: number;
}

export interface ThemeChecks {
  /** The checker's version (`THEME_CHECKS_VERSION`): older checks are redone before activation. */
  validator: number;
  /** The content hash the checks ran on. */
  contentHash: string;
  /** Static checks and smoke rendering passed (without explicit disclosure). */
  ok: boolean;
  /** Smoke rendering also passed with explicit sponsor disclosure on (the disclosure slots are there). */
  disclosureOk: boolean;
  issues: Array<{ template: string; message: string }>;
  checkedAt: string;
}

export const themes = pgTable(
  'lumibase_themes',
  {
    id: text('id').$defaultFn(() => nanoid()).primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    siteName: uniqueIndex('themes_site_name_unique').on(t.siteId, t.name),
  }),
);

export const themeVersions = pgTable(
  'lumibase_theme_versions',
  {
    id: text('id').$defaultFn(() => nanoid()).primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    themeId: text('theme_id')
      .notNull()
      .references(() => themes.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    templates: jsonb('templates').$type<Record<string, string>>().notNull(),
    assets: jsonb('assets').$type<ThemeAssetEntry[]>().notNull(),
    contentHash: text('content_hash'),
    sealedAt: timestamp('sealed_at', { withTimezone: true }),
    checks: jsonb('checks').$type<ThemeChecks>(),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
  },
  (t) => ({
    themeNumber: uniqueIndex('theme_versions_theme_number_unique').on(t.themeId, t.number),
    // The target of the (version, site) foreign keys: an asset or a pointer belongs to its version's site.
    idSite: uniqueIndex('theme_versions_id_site_unique').on(t.id, t.siteId),
    bySite: index('theme_versions_site').on(t.siteId),
  }),
);

export const themeAssets = pgTable(
  'lumibase_theme_assets',
  {
    versionId: text('version_id')
      .notNull()
      .references(() => themeVersions.id, { onDelete: 'cascade' }),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    sha256: text('sha256').notNull(),
    contentType: text('content_type').notNull(),
    bytes: bytea('bytes').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.versionId, t.path] }),
    byHash: index('theme_assets_version_sha').on(t.versionId, t.sha256),
    versionSite: foreignKey({ name: 'theme_assets_version_site_fk', columns: [t.versionId, t.siteId], foreignColumns: [themeVersions.id, themeVersions.siteId] }).onDelete('cascade'),
  }),
);

export const siteThemes = pgTable(
  'lumibase_site_themes',
  {
    siteId: text('site_id')
      .primaryKey()
      .references(() => sites.id, { onDelete: 'cascade' }),
    themeVersionId: text('theme_version_id')
      .notNull()
      .references(() => themeVersions.id),
    version: integer('version').default(1).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // Only a version of the site itself (migration 0033 also requires it to be published).
    versionSite: foreignKey({ name: 'site_themes_version_site_fk', columns: [t.themeVersionId, t.siteId], foreignColumns: [themeVersions.id, themeVersions.siteId] }),
  }),
);

/**
 * What the rendering role reads (migration 0032; not managed by drizzle-kit), both limited to the current
 * site (`app.site_id`): the site's active version, and the assets of its published versions.
 */
export const renderThemes = pgView('lumibase_render_themes', {
  siteId: text('site_id').notNull(),
  versionId: text('version_id').notNull(),
  templates: jsonb('templates').$type<Record<string, string>>().notNull(),
  assets: jsonb('assets').$type<ThemeAssetEntry[]>().notNull(),
}).existing();

export const renderThemeAssets = pgView('lumibase_render_theme_assets', {
  path: text('path').notNull(),
  versionId: text('version_id').notNull(),
  sha256: text('sha256').notNull(),
  contentType: text('content_type').notNull(),
  bytes: bytea('bytes').notNull(),
}).existing();
