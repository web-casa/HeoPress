import { z } from 'zod';

/**
 * A site's SEO / GEO settings (HeoPress P07; spec seo/page-metadata, seo/crawl-discovery,
 * geo/machine-readable-content): indexing defaults, title and description templates, snippet and preview
 * directives, the crawler policy by purpose, discovery switches. Shared by the CMS (validation, the public
 * snapshot the rendering service reads) and Studio (forms). Later P07 tasks give each part its effect;
 * absent parts take the defaults below.
 */

/** Page types a site can set an indexing default for (search and error pages are never indexed). */
export const SEO_PAGE_TYPES = ['home', 'item', 'taxonomy'] as const;
/** The official IndexNow endpoints (P07 task 3.4; indexnow.org): the only places a site's notices are sent. */
const INDEXNOW_ENDPOINTS = [
  'https://api.indexnow.org/indexnow',
  'https://www.bing.com/indexnow',
  'https://yandex.com/indexnow',
  'https://search.seznam.cz/indexnow',
  'https://searchadvisor.naver.com/indexnow',
] as const;

/** The purposes a crawler serves (packages/seo-geo crawler list, P07 task 3.2). */
export const CRAWLER_PURPOSES = ['training', 'search', 'user-fetch'] as const;

const Template = z.string().trim().max(200);
/** A crawler's id (the crawler list's, or a site's own). */
const CrawlerId = z.string().trim().min(1).max(64).regex(/^[a-z0-9][a-z0-9._-]*$/);
const Decision = z.enum(['allow', 'disallow']);

export const SiteSeoSettingsSchema = z
  .object({
    /** `{title}` and `{site}` placeholders; empty: the default (`{title} · {site}`). */
    titleTemplate: Template.default(''),
    descriptionTemplate: Template.default(''),
    /** Indexing defaults: the site, then a collection or page type (the single item's `seo_robots` last). */
    index: z
      .object({
        site: z.boolean().default(true),
        collections: z.record(z.string().trim().min(1).max(64), z.boolean()).default({}),
        pageTypes: z.partialRecord(z.enum(SEO_PAGE_TYPES), z.boolean()).default({}),
      })
      .strict()
      .default({ site: true, collections: {}, pageTypes: {} }),
    /** Snippet and preview directives for indexable pages (`max-image-preview` defaults to `large`). */
    snippet: z
      .object({
        maxSnippet: z.number().int().min(-1).max(100_000).nullable().default(null),
        maxImagePreview: z.enum(['none', 'standard', 'large']).default('large'),
        maxVideoPreview: z.number().int().min(-1).max(100_000).nullable().default(null),
      })
      .strict()
      .default({ maxSnippet: null, maxImagePreview: 'large', maxVideoPreview: null }),
    /** Crawlers by purpose, then by name (the crawler list's ids); ordinary search engines only by name. */
    crawlers: z
      .object({
        purposes: z.partialRecord(z.enum(CRAWLER_PURPOSES), Decision).default({}),
        overrides: z.record(CrawlerId, Decision).default({}),
        contentSignal: z.boolean().default(false),
        /**
         * The site's own crawlers (P07 task 3.2), beside the known list: an id, the product token robots.txt names
         * (letters, digits, `.`, `_`, `-`: never a line break), and a purpose. An id the known list has is the list's.
         */
        custom: z
          .array(
            z
              .object({
                id: CrawlerId,
                userAgent: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, 'a crawler product token: letters, digits, ".", "_", "-"'),
                purpose: z.enum(CRAWLER_PURPOSES),
              })
              .strict(),
          )
          .max(50)
          .default([])
          .refine((list) => new Set(list.map((c) => c.id)).size === list.length, 'each custom crawler needs its own id'),
      })
      .strict()
      .default({ purposes: {}, overrides: {}, contentSignal: false, custom: [] }),
    discovery: z
      .object({
        feeds: z.boolean().default(true),
        llms: z.boolean().default(true),
        markdownCopies: z.boolean().default(true),
        newsSitemap: z.boolean().default(false),
        newsPublicationName: z.string().trim().max(200).default(''),
        indexNow: z.boolean().default(false),
        /** Where IndexNow notices go (P07 task 3.4): one of the official endpoints, never an address of the site's choosing. */
        indexNowEndpoint: z.enum(INDEXNOW_ENDPOINTS).default(INDEXNOW_ENDPOINTS[0]),
        /**
         * The site's IndexNow key (32 hexadecimal digits; served at `/<key>.txt` while IndexNow is on): made by the CMS when
         * IndexNow is first turned on, then kept. Public by design (search engines read it from the site).
         */
        indexNowKey: z.string().regex(/^[0-9a-f]{32}$/).nullable().default(null),
      })
      .strict()
      .default({
        feeds: true,
        llms: true,
        markdownCopies: true,
        newsSitemap: false,
        newsPublicationName: '',
        indexNow: false,
        indexNowEndpoint: 'https://api.indexnow.org/indexnow',
        indexNowKey: null,
      }),
  })
  .strict();

export type SiteSeoSettings = z.infer<typeof SiteSeoSettingsSchema>;

/** An update: the settings and the version they were read at (0: none stored yet; a stale form is refused, not merged). */
export const SiteSeoSettingsUpdateSchema = SiteSeoSettingsSchema.extend({ version: z.number().int().min(0) }).strict();

/** The settings of a site that has none stored. */
export function defaultSeoSettings(): SiteSeoSettings {
  return SiteSeoSettingsSchema.parse({});
}

/**
 * Stored settings (or their public snapshot) with the defaults of what they lack; a document that no longer
 * validates reads as the defaults. A site's snapshot from before P07 (`{}`) therefore reads as the defaults
 * — what a rebuild would write for a site with no settings stored.
 */
export function effectiveSeoSettings(stored: unknown): SiteSeoSettings {
  const parsed = SiteSeoSettingsSchema.safeParse(stored ?? {});
  return parsed.success ? parsed.data : defaultSeoSettings();
}
