import type { JsonLdGraph } from './structured-data.ts';
import type { SiteSeoSettings } from '@heopress/contracts/schemas';
import type { IndexingResult, SeoPageType } from './indexing.ts';

/**
 * A page's head as data (HeoPress P07 tasks 1.1, 2.1; spec seo/page-metadata "绝对且自指的 canonical"): the
 * title and description from the site's templates, the absolute canonical, the robots directives, the
 * language alternates and the social metadata. The rendering service serialises it; nothing here is markup
 * (values are plain text, escaped where they are written).
 */

/** The title template when the site has none: the page's title, then the site's name. */
export const DEFAULT_TITLE_TEMPLATE = '{title} · {site}';
/** The description template when the site has none: the page's description as it is. */
export const DEFAULT_DESCRIPTION_TEMPLATE = '{description}';

export interface HeadMeta {
  /** `name="…"` (`twitter:*`) or `property="…"` (Open Graph). */
  name?: string;
  property?: string;
  content: string;
}

export interface PageHead {
  title: string;
  description: string;
  /** Absolute; only on an indexable page. */
  canonical: string | null;
  robots: string;
  /** The same directives as a response header, when the page is not indexable (any response type can carry it). */
  xRobotsTag: string | null;
  alternates: Array<{ locale: string; url: string }>;
  /** The page's language feeds (P07 task 3.3): RSS and Atom, absolute; none when the site turned feeds off. */
  feeds?: Array<{ type: 'rss' | 'atom'; url: string; title: string }>;
  /** The page's Markdown copy (P07 task 4.2), absolute; only an indexable page canonical to itself, while copies are on. */
  markdown?: string;
  meta: HeadMeta[];
  /** The page's one JSON-LD graph (P07 tasks 2.4, 2.12; `structuredData`), or null. */
  jsonLd: JsonLdGraph | null;
}

export interface HeadInput {
  settings: SiteSeoSettings;
  siteName: string;
  pageType: SeoPageType;
  locale: string;
  /** The page's own absolute address on the site's primary host; null when it has none (an error page). */
  url: string | null;
  /** The page's title: the item's, the search query, the status code; empty on the home page. */
  title: string;
  /** The item's `seo_title`: used as the whole title when set (no template). */
  seoTitle?: unknown;
  /** The item's description: `seo_description`, else its excerpt (the caller's order). */
  description?: string | null;
  /** The item's `canonical_url`: an absolute http(s) URL replaces the page's own address. */
  canonicalUrl?: unknown;
  /** An absolute http(s) image URL for social previews. */
  image?: string | null;
  publishedAt?: string | null;
  modifiedAt?: string | null;
  indexing: IndexingResult;
  alternates?: Array<{ locale: string; url: string }>;
  /** The page's language feeds, absolute (declared on every page while the site's feeds are on). */
  feeds?: Array<{ type: 'rss' | 'atom'; url: string; title: string }>;
  /** The page's Markdown copy, absolute (an article's or page's, `site-classic` decides which). */
  markdown?: string | null;
  /** The page's structured data (`structuredData`), serialised as its one JSON-LD script. */
  jsonLd?: JsonLdGraph | null;
}

const text = (v: unknown): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');

/** An absolute http(s) URL, or null. */
export function absoluteUrl(v: unknown): string | null {
  const s = text(v);
  if (!/^https?:\/\//i.test(s)) return null;
  try {
    const u = new URL(s);
    return u.hostname ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Fill `{title}`, `{site}`, `{description}` (each once per occurrence; unknown placeholders stay as written). */
export function applyTemplate(template: string, values: { title?: string; site?: string; description?: string }): string {
  return template.replace(/\{(title|site|description)\}/g, (_m, key: 'title' | 'site' | 'description') => values[key] ?? '').replace(/\s+/g, ' ').trim();
}

export function pageTitle(input: Pick<HeadInput, 'settings' | 'siteName' | 'pageType' | 'title' | 'seoTitle'>): string {
  const site = text(input.siteName);
  if (input.pageType === 'home') return site;
  const own = text(input.seoTitle);
  if (own && (input.pageType === 'item' || input.pageType === 'taxonomy')) return own;
  const title = text(input.title);
  if (!title) return site;
  return applyTemplate(input.settings.titleTemplate || DEFAULT_TITLE_TEMPLATE, { title, site }) || site;
}

export function pageDescription(input: Pick<HeadInput, 'settings' | 'siteName' | 'title' | 'description'>): string {
  const description = text(input.description);
  // No description: none, rather than a template around nothing.
  if (!description) return '';
  return applyTemplate(input.settings.descriptionTemplate || DEFAULT_DESCRIPTION_TEMPLATE, { description, title: text(input.title), site: text(input.siteName) });
}

/** `zh-CN` → `zh_CN` (Open Graph locales use an underscore). */
const ogLocale = (locale: string): string => locale.replaceAll('-', '_');

export function pageHead(input: HeadInput): PageHead {
  const { indexing } = input;
  const title = pageTitle(input);
  const description = pageDescription(input);
  const own = absoluteUrl(input.url);
  const canonical = indexing.indexable && own ? (absoluteUrl(input.canonicalUrl) ?? own) : null;
  const image = absoluteUrl(input.image);
  const isArticle = input.pageType === 'item';
  const meta: HeadMeta[] = [
    { property: 'og:type', content: isArticle ? 'article' : 'website' },
    { property: 'og:title', content: title },
    ...(description ? [{ property: 'og:description', content: description }] : []),
    ...(canonical ? [{ property: 'og:url', content: canonical }] : []),
    { property: 'og:site_name', content: text(input.siteName) },
    { property: 'og:locale', content: ogLocale(input.locale) },
    ...(image ? [{ property: 'og:image', content: image }] : []),
    ...(isArticle && input.publishedAt ? [{ property: 'article:published_time', content: input.publishedAt }] : []),
    ...(isArticle && input.modifiedAt ? [{ property: 'article:modified_time', content: input.modifiedAt }] : []),
    { name: 'twitter:card', content: image ? 'summary_large_image' : 'summary' },
  ];
  return {
    title,
    description,
    canonical,
    robots: indexing.robots,
    xRobotsTag: indexing.indexable ? null : indexing.robots,
    alternates: input.alternates ?? [],
    ...(input.settings.discovery.feeds && input.feeds?.length ? { feeds: input.feeds.filter((f) => absoluteUrl(f.url)) } : {}),
    // Declared only for a page that is indexable and canonical to itself (the copy names it as canonical).
    ...(input.settings.discovery.markdownCopies && indexing.indexable && input.markdown && absoluteUrl(input.markdown) && canonical === absoluteUrl(input.url)
      ? { markdown: absoluteUrl(input.markdown)! }
      : {}),
    meta,
    jsonLd: input.jsonLd ?? null,
  };
}
