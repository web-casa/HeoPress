import type { SiteSeoSettings } from '@heopress/contracts/schemas';

/**
 * The indexing decision (HeoPress P07 tasks 2.3, 2.8, 2.11; spec seo/page-metadata "默认收录策略",
 * "单页不收录", "摘要与预览指令"): one result per page, used by the page itself and by every discovery
 * output (sitemap, feeds, llms, Markdown copies, the language switch, IndexNow).
 *
 * The defaults apply in order — the site, its page type, its collection — then the item's own setting
 * (`seo_robots`), then the system's hard limits: search results and error pages are never indexed.
 */

/** The kinds of public page (the theme's page types). */
export type SeoPageType = 'home' | 'item' | 'taxonomy' | 'search' | 'error';

/** Collections whose items are list pages (a category, tag or author lists its articles): the `taxonomy` page type. */
export const TAXONOMY_COLLECTIONS: ReadonlySet<string> = new Set(['categories', 'tags', 'authors']);

/** The page type of an item's own page. */
export function pageTypeOfCollection(collection: string): 'item' | 'taxonomy' {
  return TAXONOMY_COLLECTIONS.has(collection) ? 'taxonomy' : 'item';
}

/** Pages the system never lets be indexed, whatever the settings say. */
const NEVER_INDEXED: ReadonlySet<SeoPageType> = new Set(['search', 'error']);

/** An item's own indexing setting: `null` where it sets nothing (the defaults apply). */
export interface ItemRobots {
  index: boolean | null;
  follow: boolean | null;
}

/**
 * Read an item's `seo_robots` value: comma-separated `index` / `noindex` / `follow` / `nofollow`. The preset's
 * default value `index,follow` sets nothing — it is what every item was created with before the defaults
 * existed — so a page follows its site, page type and collection; `index` alone indexes the page whatever
 * the defaults (a tag page indexed on a site that indexes no tag pages).
 */
export function parseItemRobots(value: unknown): ItemRobots {
  if (typeof value !== 'string') return { index: null, follow: null };
  // ASCII case and white space only, exactly as the database reads the value (`lumibase_robots_tokens`, migration 0090:
  // the discovery scans select candidate rows by it; Codex review of batch 12).
  const tokens = new Set(
    value
      .replace(/[A-Z]/g, (c) => c.toLowerCase())
      .split(',')
      .map((t) => t.replace(/^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g, ''))
      .filter(Boolean),
  );
  if (tokens.size === 2 && tokens.has('index') && tokens.has('follow')) return { index: null, follow: null };
  return {
    index: tokens.has('noindex') ? false : tokens.has('index') ? true : null,
    follow: tokens.has('nofollow') ? false : tokens.has('follow') ? true : null,
  };
}

export interface IndexingInput {
  settings: SiteSeoSettings;
  pageType: SeoPageType;
  /** The item's collection (item and taxonomy pages). */
  collection?: string | null;
  /** The item's `seo_robots` value. */
  itemRobots?: unknown;
}

export interface IndexingResult {
  indexable: boolean;
  follow: boolean;
  /** The robots directives of the page (`meta robots`; `X-Robots-Tag` when not indexable). */
  robots: string;
  /** Which layer decided `indexable` (diagnostics, the settings page's explanations). */
  decidedBy: 'site' | 'page_type' | 'collection' | 'item' | 'system';
}

export function decideIndexing(input: IndexingInput): IndexingResult {
  const { settings, pageType, collection } = input;
  let indexable = settings.index.site;
  let decidedBy: IndexingResult['decidedBy'] = 'site';
  const byType = pageType === 'home' || pageType === 'item' || pageType === 'taxonomy' ? settings.index.pageTypes[pageType] : undefined;
  if (byType !== undefined) {
    indexable = byType;
    decidedBy = 'page_type';
  }
  const byCollection = collection ? settings.index.collections[collection] : undefined;
  if (byCollection !== undefined) {
    indexable = byCollection;
    decidedBy = 'collection';
  }
  const own = parseItemRobots(input.itemRobots);
  if (own.index !== null) {
    indexable = own.index;
    decidedBy = 'item';
  }
  if (NEVER_INDEXED.has(pageType)) {
    indexable = false;
    decidedBy = 'system';
  }
  const follow = own.follow ?? true;
  return { indexable, follow, robots: robotsDirectives(settings, indexable, follow), decidedBy };
}

/**
 * The robots directives: a page not indexed says only that (`noindex` before any snippet directive: they
 * would have nothing to apply to); an indexed one carries the site's snippet and preview directives
 * (`max-image-preview` is always present, `large` by default).
 */
export function robotsDirectives(settings: SiteSeoSettings, indexable: boolean, follow: boolean): string {
  if (!indexable) return follow ? 'noindex' : 'noindex, nofollow';
  const out: string[] = [];
  if (!follow) out.push('nofollow');
  const s = settings.snippet;
  if (s.maxSnippet !== null) out.push(`max-snippet:${s.maxSnippet}`);
  out.push(`max-image-preview:${s.maxImagePreview}`);
  if (s.maxVideoPreview !== null) out.push(`max-video-preview:${s.maxVideoPreview}`);
  return out.join(', ');
}
