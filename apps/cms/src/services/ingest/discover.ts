import { gunzipSync } from 'node:zlib';
import { DOMParser, parseHTML } from 'linkedom';
import { IngestFetchError } from './failure';

/**
 * Parsing what discovery fetches (HeoPress P08 task 1.3; spec ingest/sources, design pipeline step 2): RSS 2.0 and
 * Atom feeds, XML sitemaps (`urlset` and `sitemapindex`, optionally gzip-compressed) and list pages read with the
 * source's CSS selectors. Parsers only extract links; they never fetch. Every link they return is resolved against
 * the document's URL and is still an untrusted URL: the fetcher checks it at the outbound boundary like any other.
 *
 * XML is parsed by linkedom (htmlparser2 in XML mode), which expands no external or custom entities.
 */

export interface DiscoveredLink {
  url: string;
  title: string | null;
  publishedAt: Date | null;
}

export interface DiscoveredPage {
  links: DiscoveredLink[];
  /** The next page of the same listing (list page "next", Atom `rel="next"`). */
  next: string | null;
  /** Child sitemaps of a sitemap index. */
  children: string[];
}

type XmlElement = { localName: string; textContent: string | null; getAttribute(name: string): string | null; children: ArrayLike<XmlElement> };

/** The local name without a namespace prefix, lower-cased (`atom:link` → `link`). */
const local = (el: XmlElement) => {
  const n = el.localName.toLowerCase();
  const i = n.indexOf(':');
  return i >= 0 ? n.slice(i + 1) : n;
};

function childrenOf(el: XmlElement): XmlElement[] {
  return Array.from(el.children);
}

function descendants(root: XmlElement, name: string): XmlElement[] {
  const out: XmlElement[] = [];
  const walk = (el: XmlElement) => {
    for (const c of childrenOf(el)) {
      if (local(c) === name) out.push(c);
      walk(c);
    }
  };
  walk(root);
  return out;
}

const child = (el: XmlElement, name: string) => childrenOf(el).find((c) => local(c) === name) ?? null;
const text = (el: XmlElement | null) => el?.textContent?.trim() || null;

function resolve(href: string | null, base: string): string | null {
  if (!href) return null;
  try {
    return new URL(href.trim(), base).href;
  } catch {
    return null;
  }
}

function date(v: string | null): Date | null {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t);
}

function parseXml(body: string): XmlElement {
  const doc = new DOMParser().parseFromString(body, 'text/xml') as unknown as { documentElement: XmlElement | null };
  if (!doc.documentElement) throw new IngestFetchError('extraction', 'the document is not XML');
  return doc.documentElement;
}

/** Decompress a gzip body (by magic bytes), capped. */
export function maybeGunzip(body: Buffer, maxBytes: number): Buffer {
  if (body.length < 2 || body[0] !== 0x1f || body[1] !== 0x8b) return body;
  try {
    return gunzipSync(body, { maxOutputLength: maxBytes });
  } catch (err) {
    throw new IngestFetchError('extraction', `compressed document could not be read: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** RSS 2.0 (`rss > channel > item`, also RSS 1.0 `item`) and Atom (`feed > entry`). */
export function parseFeed(body: string, base: string): DiscoveredPage {
  const root = parseXml(body);
  const kind = local(root);
  const links: DiscoveredLink[] = [];
  let next: string | null = null;
  if (kind === 'feed') {
    for (const l of childrenOf(root).filter((c) => local(c) === 'link')) {
      if (l.getAttribute('rel') === 'next') next = resolve(l.getAttribute('href'), base);
    }
    for (const entry of childrenOf(root).filter((c) => local(c) === 'entry')) {
      const ls = childrenOf(entry).filter((c) => local(c) === 'link');
      const pick = ls.find((l) => (l.getAttribute('rel') ?? 'alternate') === 'alternate') ?? ls[0];
      const url = resolve(pick?.getAttribute('href') ?? null, base);
      if (!url) continue;
      links.push({ url, title: text(child(entry, 'title')), publishedAt: date(text(child(entry, 'published')) ?? text(child(entry, 'updated'))) });
    }
  } else if (kind === 'rss' || kind === 'rdf') {
    for (const item of descendants(root, 'item')) {
      const link = child(item, 'link');
      const guid = child(item, 'guid');
      const href = text(link) ?? link?.getAttribute('href') ?? (guid && guid.getAttribute('ispermalink') !== 'false' ? text(guid) : null);
      const url = resolve(href, base);
      if (!url) continue;
      links.push({ url, title: text(child(item, 'title')), publishedAt: date(text(child(item, 'pubdate')) ?? text(child(item, 'date'))) });
    }
  } else {
    throw new IngestFetchError('extraction', `not a feed (root element <${kind}>)`);
  }
  return { links, next, children: [] };
}

/** `urlset` → page URLs; `sitemapindex` → child sitemaps. */
export function parseSitemap(body: string, base: string): DiscoveredPage {
  const root = parseXml(body);
  const kind = local(root);
  if (kind === 'urlset') {
    const links: DiscoveredLink[] = [];
    for (const u of childrenOf(root).filter((c) => local(c) === 'url')) {
      const url = resolve(text(child(u, 'loc')), base);
      if (url) links.push({ url, title: null, publishedAt: date(text(child(u, 'lastmod'))) });
    }
    return { links, next: null, children: [] };
  }
  if (kind === 'sitemapindex') {
    const children = childrenOf(root)
      .filter((c) => local(c) === 'sitemap')
      .map((s) => resolve(text(child(s, 'loc')), base))
      .filter((u): u is string => !!u);
    return { links: [], next: null, children };
  }
  throw new IngestFetchError('extraction', `not a sitemap (root element <${kind}>)`);
}

export interface ListSelectors {
  item: string;
  link: string;
  title?: string;
  nextPage?: string;
}

/** A list page read with the source's selectors: each `item` gives a `link` (its `href`) and optionally a `title`. */
export function parseListPage(html: string, base: string, selectors: ListSelectors): DiscoveredPage {
  const { document } = parseHTML(html);
  const links: DiscoveredLink[] = [];
  let items: Element[];
  try {
    items = Array.from(document.querySelectorAll(selectors.item));
  } catch {
    throw new IngestFetchError('extraction', `invalid item selector "${selectors.item}"`);
  }
  for (const item of items) {
    const a = item.matches?.(selectors.link) ? item : item.querySelector(selectors.link);
    const url = resolve(a?.getAttribute('href') ?? null, base);
    if (!url) continue;
    const titleEl = selectors.title ? item.querySelector(selectors.title) : a;
    links.push({ url, title: titleEl?.textContent?.trim() || null, publishedAt: null });
  }
  let next: string | null = null;
  if (selectors.nextPage) {
    next = resolve(document.querySelector(selectors.nextPage)?.getAttribute('href') ?? null, base);
  } else {
    next = resolve(document.querySelector('link[rel="next"], a[rel="next"]')?.getAttribute('href') ?? null, base);
  }
  return { links, next, children: [] };
}
