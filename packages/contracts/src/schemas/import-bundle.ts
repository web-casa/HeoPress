import { z } from 'zod';
import { canonicalLocale } from './locale-tag';

/**
 * The site import bundle (HeoPress P12 task 6.1; spec migration/import-bundle "导入包内容"; design decision 8).
 *
 * A bundle is a directory: `bundle.ndjson` (one record per line, the header first) and the media files it lists
 * under `media/`. Records, by `type`:
 *
 *   - `header`: format, version, where it comes from (`source`, `sourceSite`: the external-ID namespace is
 *     `<source>:<sourceSite>`);
 *   - `site`: site settings (languages, default language, trailing slash, time zone, permalink patterns);
 *   - `collection`: how a source collection maps to a HeoPress collection and its fields;
 *   - `item`: one entry — language, translation group key, internal-only and sponsor markings, publish and update
 *     times, author, categories and tags, the target collection's field values, the old URL path;
 *   - `translationGroup`: the members of a group (by external ID) and its source;
 *   - `redirect`: an old path and where it goes;
 *   - `media`: a file under `media/` with its size, SHA-256 and type;
 *   - `licence`: the source and licence record of an item or a media file;
 *   - `revision` (optional): an earlier state of an item, kept as history only.
 *
 * A HeoPress single-site export (P13 tasks 1.2, 1.6; source `heopress`) adds records only "import as new site" reads
 * (an ordinary import ignores them):
 *
 *   - `collectionSchema`: a collection's definition and fields, and its many-to-one relations, so a new site has the
 *     same schema;
 *   - `relation`: an item's relation field (many-to-one or an id list) by the external IDs it points to — remapped to
 *     the new site's item IDs after the import;
 *   - `theme`: a theme version, its templates and assets as files under `theme/` (sizes and SHA-256 listed);
 *   - `siteConfig`: the site's content and presentation settings (never a domain, a URL or a credential);
 *   - `ingestSource`: a content source and its schedule — imported paused, its terms reset to the defaults;
 *   - `autoPublish`: the auto-publish thresholds — the trust tiers that turn it on are never exported.
 *
 * A bundle never carries secrets or credentials: `findCredentialFields` (also run by the importer) refuses any key
 * that names one and any value that looks like a private key, wherever it is.
 */

export const IMPORT_BUNDLE_FORMAT = 'heopress-import';
export const IMPORT_BUNDLE_VERSION = 1;
/** The file the records are in, inside the bundle directory. */
export const IMPORT_BUNDLE_RECORDS_FILE = 'bundle.ndjson';
/** Where media files are, inside the bundle directory. */
export const IMPORT_BUNDLE_MEDIA_DIR = 'media';
/** Where a single-site export's theme files are (`theme/templates/<name>`, `theme/assets/<path>`). */
export const IMPORT_BUNDLE_THEME_DIR = 'theme';

/** Media types a bundle may carry (no SVG: it can hold scripts). */
export const IMPORT_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'video/mp4', 'video/webm', 'application/pdf'] as const;

const Locale = z
  .string()
  .min(2)
  .max(35)
  .refine((v) => canonicalLocale(v) !== null, { message: 'Use a BCP 47 language tag, e.g. en, zh-CN.' });
/** An identifier of the source system: letters, digits, `.`, `_`, `-`, `/`, `:`, `@`. */
const ExternalId = z
  .string()
  .min(1)
  .max(500)
  .regex(/^[A-Za-z0-9._\-/:@]+$/, 'Use letters, digits and . _ - / : @ only.');
const Slug = z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9-]*$/, 'Use lower-case letters, digits and hyphens.');
const Path = z.string().min(1).max(2000).startsWith('/');
const Timestamp = z.iso.datetime({ offset: true });
const Name = z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/, 'Use lower-case letters, digits and underscores.');

export const ImportHeaderSchema = z.strictObject({
  type: z.literal('header'),
  format: z.literal(IMPORT_BUNDLE_FORMAT),
  version: z.literal(IMPORT_BUNDLE_VERSION),
  /** The kind of source: `astro`, later `wordpress`, `heopress` (P13 single-site export). */
  source: Slug,
  /** The source site, as the operator names it (no real domain needed). */
  sourceSite: Slug,
  generatedAt: Timestamp.optional(),
  generator: z.string().max(200).optional(),
});

const ImportSiteSchema = z.strictObject({
  type: z.literal('site'),
  settings: z.strictObject({
    name: z.string().max(200).optional(),
    defaultLocale: Locale,
    locales: z.array(Locale).min(1).max(50),
    trailingSlash: z.enum(['always', 'never']).optional(),
    timezone: z.string().max(64).optional(),
    /** HeoPress collection → permalink pattern (`/blog/:slug`). */
    permalinks: z.record(Name, z.string().min(2).max(200)).optional(),
    /** Language → path prefix (`zh-CN` → `zh`). */
    localePrefixes: z.record(z.string(), z.string().max(32)).optional(),
  }),
});

const ImportCollectionSchema = z.strictObject({
  type: z.literal('collection'),
  /** The source's collection name. */
  source: z.string().min(1).max(200),
  /** The HeoPress collection items go into. */
  collection: Name,
  /** Source field → HeoPress field. */
  fields: z.record(z.string().max(200), Name).optional(),
});

export const ImportItemSchema = z.strictObject({
  type: z.literal('item'),
  externalId: ExternalId,
  collection: Name,
  locale: Locale,
  /** Items sharing a key are one translation group (a `translationGroup` record may name the source). */
  translationKey: ExternalId.optional(),
  /** `published`: live on the old site — imported as a draft and published when its batch is activated. */
  status: z.enum(['published', 'draft']),
  /** A translation source never published (needs a translation key). */
  internalOnly: z.boolean().optional(),
  sponsored: z.boolean().optional(),
  sponsorName: z.string().max(200).optional(),
  publishedAt: Timestamp.optional(),
  updatedAt: Timestamp.optional(),
  author: z.string().max(200).optional(),
  categories: z.array(z.string().max(200)).max(100).optional(),
  tags: z.array(z.string().max(200)).max(200).optional(),
  /** Field values of the target collection (`title`, `slug`, `body`, …). Rich text is HTML. */
  data: z.record(Name, z.unknown()),
  /** The item's path on the old site (with the language prefix), for path changes and URL comparison. */
  legacyPath: Path.optional(),
  /** Where it came from, relative to the source root (reports only). */
  sourceFile: z.string().max(1000).optional(),
  /** What the converter could not convert as is (unknown components, expressions, missing images): in the dry-run report. */
  notes: z.array(z.string().max(1000)).max(200).optional(),
});

const ImportTranslationGroupSchema = z.strictObject({
  type: z.literal('translationGroup'),
  key: ExternalId,
  /** The member the others translate (default: the member in the site's default language). */
  source: ExternalId.optional(),
  members: z.array(ExternalId).min(1).max(100),
});

const ImportRedirectSchema = z.strictObject({
  type: z.literal('redirect'),
  from: Path,
  to: z.string().min(1).max(2000),
  status: z.union([z.literal(301), z.literal(302), z.literal(307), z.literal(308)]).optional(),
  /** Where the rule came from (`_redirects`, `astro.config`, `mapping`). */
  origin: z.string().max(200).optional(),
});

const ImportMediaSchema = z.strictObject({
  type: z.literal('media'),
  /** Referenced from rich text and fields as `heopress-media:<id>`. */
  id: ExternalId,
  /** Relative to the bundle's `media/` directory. */
  path: z.string().min(1).max(1000),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  mimeType: z.enum(IMPORT_MEDIA_TYPES),
  alt: z.string().max(1000).optional(),
});

const ImportLicenceSchema = z.strictObject({
  type: z.literal('licence'),
  /** The item (external ID) or media (`media:<id>`) the record is about. */
  subject: z.string().min(1).max(600),
  licence: z.enum(['own', 'licensed', 'open-license', 'unknown']),
  attribution: z.string().max(1000).optional(),
  sourceUrl: z.url({ protocol: /^https?$/ }).optional(),
  note: z.string().max(2000).optional(),
});

const ImportRevisionSchema = z.strictObject({
  type: z.literal('revision'),
  externalId: ExternalId,
  at: Timestamp,
  data: z.record(Name, z.unknown()),
  note: z.string().max(1000).optional(),
});

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const ThemeFile = z.string().min(1).max(500);

const ImportCollectionSchemaRecord = z.strictObject({
  type: z.literal('collectionSchema'),
  collection: Name,
  /** The collection's settings (label, icon, singleton, versioning, …). */
  meta: z.record(z.string().max(64), z.unknown()).optional(),
  fields: z
    .array(
      z.strictObject({
        name: Name,
        type: z.string().min(1).max(64),
        interface: z.string().min(1).max(64),
        /** The rest of the field's definition (label, options, validation, …). */
        definition: z.record(z.string().max(64), z.unknown()).optional(),
      }),
    )
    .max(500),
  /** Many-to-one relations of the collection's fields. */
  relations: z.array(z.strictObject({ field: Name, collection: Name })).max(200).optional(),
});

const ImportRelationSchema = z.strictObject({
  type: z.literal('relation'),
  /** The item whose field this is. */
  externalId: ExternalId,
  field: Name,
  /** The items it points to (external IDs of this bundle). */
  targets: z.array(ExternalId).max(1000),
  /** An id list (`true`) or a single id. */
  many: z.boolean(),
});

const ImportThemeSchema = z.strictObject({
  type: z.literal('theme'),
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  /** The site's active version. */
  active: z.boolean(),
  templates: z.array(z.strictObject({ name: ThemeFile, size: z.number().int().nonnegative(), sha256: Sha256 })).min(1).max(200),
  assets: z.array(z.strictObject({ path: ThemeFile, contentType: z.string().min(1).max(100), size: z.number().int().nonnegative(), sha256: Sha256 })).max(200),
});

const ImportSiteConfigSchema = z.strictObject({
  type: z.literal('siteConfig'),
  /** Content settings (locale strategy and prefixes, sponsor disclosure, site type, …). */
  content: z.record(z.string().max(64), z.unknown()),
  /** Presentation (display title, descriptor, appearance, branding). */
  site: z.record(z.string().max(64), z.unknown()),
});

const ImportIngestSourceSchema = z.strictObject({
  type: z.literal('ingestSource'),
  name: z.string().min(1).max(200),
  sourceType: z.string().min(1).max(32),
  url: z.url({ protocol: /^https?$/ }),
  adapter: z.string().max(300).optional(),
  listSelectors: z.record(z.string().max(32), z.string().max(500)).optional(),
  scheduleTimes: z.array(z.string().regex(/^\d{2}:\d{2}$/)).max(48),
  timezone: z.string().min(1).max(64),
  maxItemsPerRun: z.number().int().positive().max(10_000).optional(),
});

const ImportAutoPublishSchema = z.strictObject({
  type: z.literal('autoPublish'),
  settings: z.record(z.string().max(64), z.unknown()),
});

export const ImportRecordSchema = z.discriminatedUnion('type', [
  ImportHeaderSchema,
  ImportSiteSchema,
  ImportCollectionSchema,
  ImportItemSchema,
  ImportTranslationGroupSchema,
  ImportRedirectSchema,
  ImportMediaSchema,
  ImportLicenceSchema,
  ImportRevisionSchema,
  ImportCollectionSchemaRecord,
  ImportRelationSchema,
  ImportThemeSchema,
  ImportSiteConfigSchema,
  ImportIngestSourceSchema,
  ImportAutoPublishSchema,
]);

export type ImportHeader = z.infer<typeof ImportHeaderSchema>;
export type ImportSite = z.infer<typeof ImportSiteSchema>;
export type ImportCollection = z.infer<typeof ImportCollectionSchema>;
export type ImportItem = z.infer<typeof ImportItemSchema>;
export type ImportTranslationGroup = z.infer<typeof ImportTranslationGroupSchema>;
export type ImportRedirect = z.infer<typeof ImportRedirectSchema>;
export type ImportMedia = z.infer<typeof ImportMediaSchema>;
export type ImportLicence = z.infer<typeof ImportLicenceSchema>;
export type ImportRevision = z.infer<typeof ImportRevisionSchema>;
export type ImportCollectionSchemaRecord = z.infer<typeof ImportCollectionSchemaRecord>;
export type ImportRelation = z.infer<typeof ImportRelationSchema>;
export type ImportTheme = z.infer<typeof ImportThemeSchema>;
export type ImportSiteConfig = z.infer<typeof ImportSiteConfigSchema>;
export type ImportIngestSource = z.infer<typeof ImportIngestSourceSchema>;
export type ImportAutoPublish = z.infer<typeof ImportAutoPublishSchema>;
export type ImportRecord = z.infer<typeof ImportRecordSchema>;

/** The JSON Schema of one bundle line (`docs/schemas/heopress.import-bundle.v1.schema.json` is this, committed). */
export function importRecordJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(ImportRecordSchema, { io: 'input', target: 'draft-2020-12' }) as Record<string, unknown>;
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://heopress.example/schemas/heopress.import-bundle.v1.schema.json',
    title: 'HeoPress import bundle record (one line of bundle.ndjson)',
    ...Object.fromEntries(Object.entries(schema).filter(([k]) => k !== '$schema')),
  };
}

/** A media reference in rich text or a field value. */
export const IMPORT_MEDIA_REF_PREFIX = 'heopress-media:';

const CREDENTIAL_WORDS = new Set(['secret', 'secrets', 'password', 'passwd', 'passphrase', 'pwd', 'token', 'tokens', 'credential', 'credentials', 'apikey', 'apikeys', 'bearer', 'cookie', 'cookies', 'session']);
const CREDENTIAL_PAIRS: Array<[string, string]> = [
  ['api', 'key'],
  ['access', 'key'],
  ['private', 'key'],
  ['secret', 'key'],
  ['signing', 'key'],
  ['client', 'secret'],
  ['auth', 'key'],
  ['connection', 'string'],
  ['database', 'url'],
  ['webhook', 'secret'],
];
const CREDENTIAL_VALUES: RegExp[] = [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i];

/** The words of a key: `apiKey`, `api_key`, `API-KEY` → `api`, `key`. */
function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Whether a key names a secret or credential. */
export function isCredentialKey(key: string): boolean {
  const words = keyWords(key);
  if (words.some((w) => CREDENTIAL_WORDS.has(w))) return true;
  for (let i = 0; i + 1 < words.length; i++) {
    if (CREDENTIAL_PAIRS.some(([a, b]) => words[i] === a && words[i + 1] === b)) return true;
  }
  return false;
}

/**
 * Every place in `value` that carries, or names, a secret or credential: a key that names one (`apiKey`,
 * `smtp_password`, `client-secret`), or a string value that looks like a private key or a URL with a password.
 * Paths are dotted (`settings.smtp.password`, `data.items[2].token`).
 */
export function findCredentialFields(value: unknown, path = ''): string[] {
  const out: string[] = [];
  const walk = (v: unknown, p: string, depth: number) => {
    if (depth > 32) return;
    if (typeof v === 'string') {
      if (CREDENTIAL_VALUES.some((re) => re.test(v))) out.push(p || '(value)');
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${p}[${i}]`, depth + 1));
      return;
    }
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        const here = p ? `${p}.${k}` : k;
        if (isCredentialKey(k)) out.push(here);
        else walk(x, here, depth + 1);
      }
    }
  };
  walk(value, path, 0);
  return out;
}
