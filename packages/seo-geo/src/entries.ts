import type { IndexingResult } from './indexing.ts';
import { absoluteUrl } from './head.ts';

/**
 * A page's entries in the discovery outputs (HeoPress P07 task 1.1): the sitemap, the feeds and `llms.txt`
 * list a page only when it is indexable (spec seo/page-metadata "统一收录资格") — every output asks the same
 * `IndexingResult`, so none can disagree with the page. The serialisation (XML, text) is the rendering
 * service's; later tasks (3.1, 3.3, 4.1) add what each format needs.
 */

export interface DiscoveryPage {
  /** The page's absolute address on the primary host. */
  url: string;
  title: string;
  description?: string | null;
  publishedAt?: string | null;
  /** When its content last changed (task 2.5 makes this the real content time). */
  modifiedAt?: string | null;
  indexing: IndexingResult;
  /**
   * The page's canonical as its head says it (the item's absolute `canonical_url` override, else its own address).
   * A page canonical to another address is a declared duplicate: it is listed nowhere (Codex review of batch 4b).
   */
  canonical?: string | null;
  /** The indexable language alternates (task 2.2). */
  alternates?: Array<{ locale: string; url: string }>;
}

export interface SitemapEntry {
  loc: string;
  lastmod: string | null;
  alternates: Array<{ locale: string; url: string }>;
}

export interface FeedEntry {
  id: string;
  url: string;
  title: string;
  summary: string;
  published: string | null;
  updated: string | null;
}

export interface LlmsEntry {
  title: string;
  url: string;
  description: string;
}

/** The page's address when it may be listed: indexable, with an absolute address, canonical to itself. */
function listable(page: DiscoveryPage): string | null {
  if (!page.indexing.indexable) return null;
  const url = absoluteUrl(page.url);
  if (!url) return null;
  if (page.canonical && absoluteUrl(page.canonical) !== url) return null;
  return url;
}

export function sitemapEntry(page: DiscoveryPage): SitemapEntry | null {
  const loc = listable(page);
  if (!loc) return null;
  return { loc, lastmod: page.modifiedAt ?? page.publishedAt ?? null, alternates: page.alternates ?? [] };
}

export function feedEntry(page: DiscoveryPage): FeedEntry | null {
  const url = listable(page);
  if (!url) return null;
  return { id: url, url, title: page.title, summary: page.description ?? '', published: page.publishedAt ?? null, updated: page.modifiedAt ?? page.publishedAt ?? null };
}

export function llmsEntry(page: DiscoveryPage): LlmsEntry | null {
  const url = listable(page);
  if (!url) return null;
  return { title: page.title, url, description: page.description ?? '' };
}
