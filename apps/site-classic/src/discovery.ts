import type { FeedEntry, SitemapEntry } from '@heopress/seo-geo';

/**
 * The discovery files as text (HeoPress P07 tasks 3.1, 3.3, 3.7; spec seo/crawl-discovery): sitemaps (index, shards,
 * `sitemap.txt`), RSS 2.0 and Atom feeds, the news sitemap. The entries come from `@heopress/seo-geo` (only indexable
 * pages canonical to themselves); this module only serialises them, every value escaped.
 */

export const XML_TYPE = 'application/xml; charset=utf-8';
export const TEXT_TYPE = 'text/plain; charset=utf-8';
export const RSS_TYPE = 'application/rss+xml; charset=utf-8';
export const ATOM_TYPE = 'application/atom+xml; charset=utf-8';

/** Entries per sitemap shard (below the protocol's 50,000: smaller files are cheaper to build and to fetch). */
const SITEMAP_SHARD_SIZE = 10_000;
/** Bytes per sitemap shard (below the protocol's 50 MiB, uncompressed). */
const SITEMAP_SHARD_BYTES = 45 * 1024 * 1024;
/** URLs in `sitemap.txt` at most (the protocol's limit for one file). */
const SITEMAP_TXT_MAX = 50_000;
/** Entries in a feed. */
export const FEED_SIZE = 20;
/** Articles in the news sitemap at most (the news sitemap format's limit). */
export const NEWS_MAX = 1000;
/** How long an article stays in the news sitemap after its first publication. */
export const NEWS_WINDOW_MS = 48 * 60 * 60 * 1000;

/**
 * Text as XML character data or an attribute value: the five special characters escaped, and the characters XML 1.0
 * cannot hold (C0 controls but tab, line feed and carriage return; lone surrogates; U+FFFE, U+FFFF) removed.
 */
export function xmlText(s: string): string {
  return s
    .replace(/[^\x09\x0a\x0d\x20-퟿-�\u{10000}-\u{10ffff}]/gu, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const XML_DECL = '<?xml version="1.0" encoding="UTF-8"?>\n';

/** The sitemap index: one `<sitemap>` per shard (and the news sitemap), each with its newest `lastmod`. */
export function sitemapIndexXml(sitemaps: Array<{ loc: string; lastmod: string | null }>): string {
  const body = sitemaps
    .map((s) => `<sitemap><loc>${xmlText(s.loc)}</loc>${s.lastmod ? `<lastmod>${xmlText(s.lastmod)}</lastmod>` : ''}</sitemap>`)
    .join('\n');
  return `${XML_DECL}<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</sitemapindex>\n`;
}

/** One page's `<url>` element: its real `lastmod` and its indexable language alternates (`xhtml:link`). */
function urlXml(e: SitemapEntry): string {
  const alts = e.alternates.map((a) => `<xhtml:link rel="alternate" hreflang="${xmlText(a.locale)}" href="${xmlText(a.url)}"/>`).join('');
  return `<url><loc>${xmlText(e.loc)}</loc>${e.lastmod ? `<lastmod>${xmlText(e.lastmod)}</lastmod>` : ''}${alts}</url>`;
}

const URLSET_OPEN = `${XML_DECL}<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n`;
const URLSET_CLOSE = '</urlset>\n';

/** A sitemap shard. */
export function sitemapXml(entries: SitemapEntry[]): string {
  const body = entries.map(urlXml).join('\n');
  return `${URLSET_OPEN}${body}${body ? '\n' : ''}${URLSET_CLOSE}`;
}

/**
 * Entries that fit a shard (Codex review of batch 8): one larger than a shard on its own (`maxBytes`, with the urlset
 * around it) loses its language alternates; one still larger (its address alone) is left out — a shard never passes the
 * byte limit.
 */
export function fittingEntries(entries: SitemapEntry[], maxBytes = SITEMAP_SHARD_BYTES): SitemapEntry[] {
  const room = maxBytes - (Buffer.byteLength(URLSET_OPEN) + Buffer.byteLength(URLSET_CLOSE) + 1);
  return entries.flatMap((e) => {
    if (Buffer.byteLength(urlXml(e)) + 1 <= room) return [e];
    const bare = { ...e, alternates: [] };
    return Buffer.byteLength(urlXml(bare)) + 1 <= room ? [bare] : [];
  });
}

/**
 * The shards of a host's entries (P07 tasks 3.1, 3.6): in order, each at most `maxEntries` entries and at most
 * `maxBytes` bytes as a file (the protocol allows 50,000 and 50 MiB; pages with many language alternates fill the bytes
 * first). Each shard is `[start, end)`. The entries are `fittingEntries`' (none larger than a shard on its own).
 */
export function sitemapShards(entries: SitemapEntry[], maxEntries = SITEMAP_SHARD_SIZE, maxBytes = SITEMAP_SHARD_BYTES): Array<[number, number]> {
  const frame = Buffer.byteLength(URLSET_OPEN) + Buffer.byteLength(URLSET_CLOSE) + 1;
  const shards: Array<[number, number]> = [];
  let start = 0;
  let bytes = frame;
  for (let i = 0; i < entries.length; i++) {
    const size = Buffer.byteLength(urlXml(entries[i]!)) + 1;
    if (i > start && (i - start >= maxEntries || bytes + size > maxBytes)) {
      shards.push([start, i]);
      start = i;
      bytes = frame;
    }
    bytes += size;
  }
  shards.push([start, entries.length]);
  return shards;
}

/** `sitemap.txt`: one absolute URL per line (no XML; at most `SITEMAP_TXT_MAX`). */
export function sitemapTxt(urls: string[]): string {
  return urls
    .slice(0, SITEMAP_TXT_MAX)
    .map((u) => `${u.replace(/[\r\n]/g, '')}\n`)
    .join('');
}

/** A feed's entry with its full text (sanitised HTML, links absolute) and its language. */
export interface FullFeedEntry extends FeedEntry {
  html: string;
  author?: string | null;
}

export interface FeedInfo {
  /** The feed's own address (absolute). */
  self: string;
  /** The page the feed is about (the language's home, absolute). */
  home: string;
  title: string;
  description: string;
  language: string;
  /** Whom the feed is by: the site's identity, else the site. */
  author: string;
  /** When the feed last changed: its newest entry's update, else the site's build. */
  updated: string;
}

/** RFC 822 / RFC 1123 date (RSS 2.0). */
function rfc822(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toUTCString();
}

/** RSS 2.0 with the full text (`content:encoded`) and the feed's own address (`atom:link rel="self"`). */
export function rssXml(feed: FeedInfo, entries: FullFeedEntry[]): string {
  const items = entries
    .map((e) => {
      const date = rfc822(e.published ?? e.updated);
      return [
        '<item>',
        `<title>${xmlText(e.title)}</title>`,
        `<link>${xmlText(e.url)}</link>`,
        `<guid isPermaLink="true">${xmlText(e.id)}</guid>`,
        date ? `<pubDate>${date}</pubDate>` : '',
        e.summary ? `<description>${xmlText(e.summary)}</description>` : '',
        e.author ? `<dc:creator>${xmlText(e.author)}</dc:creator>` : '',
        `<content:encoded>${xmlText(e.html)}</content:encoded>`,
        '</item>',
      ].join('');
    })
    .join('\n');
  const built = rfc822(feed.updated);
  return [
    XML_DECL,
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">\n',
    '<channel>',
    `<title>${xmlText(feed.title)}</title>`,
    `<link>${xmlText(feed.home)}</link>`,
    `<description>${xmlText(feed.description || feed.title)}</description>`,
    `<language>${xmlText(feed.language)}</language>`,
    built ? `<lastBuildDate>${built}</lastBuildDate>` : '',
    `<atom:link href="${xmlText(feed.self)}" rel="self" type="application/rss+xml"/>`,
    '\n',
    items,
    items ? '\n' : '',
    '</channel>\n</rss>\n',
  ].join('');
}

/** Atom (RFC 4287): the feed's id is its own address, each entry's its page's; the full text as `html` content. */
export function atomXml(feed: FeedInfo, entries: FullFeedEntry[]): string {
  const items = entries
    .map((e) => {
      const updated = e.updated ?? e.published ?? feed.updated;
      return [
        '<entry>',
        `<id>${xmlText(e.id)}</id>`,
        `<title>${xmlText(e.title)}</title>`,
        `<link rel="alternate" type="text/html" href="${xmlText(e.url)}"/>`,
        e.published ? `<published>${xmlText(e.published)}</published>` : '',
        `<updated>${xmlText(updated)}</updated>`,
        e.author ? `<author><name>${xmlText(e.author)}</name></author>` : '',
        e.summary ? `<summary>${xmlText(e.summary)}</summary>` : '',
        `<content type="html">${xmlText(e.html)}</content>`,
        '</entry>',
      ].join('');
    })
    .join('\n');
  return [
    XML_DECL,
    `<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="${xmlText(feed.language)}">\n`,
    `<id>${xmlText(feed.self)}</id>`,
    `<title>${xmlText(feed.title)}</title>`,
    feed.description ? `<subtitle>${xmlText(feed.description)}</subtitle>` : '',
    `<updated>${xmlText(feed.updated)}</updated>`,
    `<author><name>${xmlText(feed.author)}</name></author>`,
    `<link rel="self" type="application/atom+xml" href="${xmlText(feed.self)}"/>`,
    `<link rel="alternate" type="text/html" href="${xmlText(feed.home)}"/>`,
    '\n',
    items,
    items ? '\n' : '',
    '</feed>\n',
  ].join('');
}

export interface NewsEntry {
  loc: string;
  title: string;
  /** The article's first publication (W3C datetime). */
  published: string;
  /** The article's language as the news sitemap names it (ISO 639; `zh-cn` / `zh-tw` for Chinese). */
  language: string;
}

/** The news sitemap: articles first published in the last 48 hours, with the publication's name and language. */
export function newsSitemapXml(publication: string, entries: NewsEntry[]): string {
  const body = entries
    .map(
      (e) =>
        `<url><loc>${xmlText(e.loc)}</loc><news:news><news:publication><news:name>${xmlText(publication)}</news:name><news:language>${xmlText(e.language)}</news:language></news:publication><news:publication_date>${xmlText(e.published)}</news:publication_date><news:title>${xmlText(e.title)}</news:title></news:news></url>`,
    )
    .join('\n');
  return `${XML_DECL}<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">\n${body}${body ? '\n' : ''}</urlset>\n`;
}

/**
 * A locale as the news sitemap names a language: its ISO 639 code, lower case — `zh-cn` and `zh-tw` for Chinese
 * (simplified for `zh`, `zh-Hans`, `zh-CN`, `zh-SG`; traditional for `zh-Hant`, `zh-TW`, `zh-HK`, `zh-MO`).
 */
export function newsLanguage(locale: string): string {
  const parts = locale.toLowerCase().split(/[-_]/);
  if (parts[0] === 'zh') return parts.some((p) => ['hant', 'tw', 'hk', 'mo'].includes(p)) ? 'zh-tw' : 'zh-cn';
  return parts[0] ?? locale.toLowerCase();
}

/**
 * Rich text with its links absolute (feeds are read away from the site): every `href` and `src` resolved against the
 * page's address. The HTML is the projection's sanitised rich text, whose attribute values are quoted.
 */
export function absoluteLinks(html: string, base: string): string {
  return html.replace(/\b(href|src)=("([^"]*)"|'([^']*)')/gi, (whole, attr: string, _q, dq: string | undefined, sq: string | undefined) => {
    const raw = (dq ?? sq ?? '').replace(/&amp;/g, '&');
    let url: string;
    try {
      url = new URL(raw, base).toString();
    } catch {
      return whole;
    }
    return `${attr}="${url.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`;
  });
}

/**
 * A line of Markdown text (a title, a description, a link's text): one line, and everything Markdown would read as syntax
 * or raw HTML escaped — `<` and `>` included (Codex review of batch 9: a title `<img …>` stays text).
 */
const mdLine = (s: string) =>
  s
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\\`*_[\]<>|#]/g, (c) => `\\${c}`);
/** A link destination inside `( )`. */
const mdUrl = (u: string) => u.replace(/[ ()]/g, (c) => ({ ' ': '%20', '(': '%28', ')': '%29' })[c]!);

export interface LlmsInfo {
  title: string;
  summary: string;
  pages: Array<{ title: string; url: string; description: string }>;
  recent: Array<{ title: string; url: string; description: string }>;
  /** Discovery files to name (feeds, sitemap, the full text): label and absolute address. */
  links: Array<{ label: string; url: string }>;
}

/** `llms.txt` (llmstxt.org): the site's name, a summary, its important pages, its recent content and its discovery files. */
export function llmsTxt(info: LlmsInfo): string {
  const item = (e: { title: string; url: string; description: string }) => `- [${mdLine(e.title) || mdLine(e.url)}](${mdUrl(e.url)})${e.description ? `: ${mdLine(e.description)}` : ''}`;
  const parts = [`# ${mdLine(info.title)}`, `> ${mdLine(info.summary)}`];
  if (info.pages.length) parts.push(['## Pages', ...info.pages.map(item)].join('\n'));
  if (info.recent.length) parts.push(['## Recent', ...info.recent.map(item)].join('\n'));
  if (info.links.length) parts.push(['## Optional', ...info.links.map((l) => `- [${mdLine(l.label)}](${mdUrl(l.url)})`)].join('\n'));
  return `${parts.join('\n\n')}\n`;
}

/** The head of `llms-full.txt`: the site's name and summary escaped as in `llms.txt`, and what follows. */
export function llmsFullHead(info: { title: string; summary: string; origin: string }): string {
  return `# ${mdLine(info.title)}\n\n> ${mdLine(info.summary)}\n\n(Full text of ${info.origin}/ — pages, then the newest articles.)\n`;
}

/** One page in Markdown: its title, description, address and dates, then its body (a Markdown copy, a part of `llms-full.txt`). */
export function pageMarkdown(page: { title: string; description: string; url: string; published: string | null; modified: string | null; body: string }): string {
  const meta = [`- URL: <${page.url.replace(/[<>\s]/g, (c) => encodeURIComponent(c))}>`];
  if (page.published) meta.push(`- Published: ${page.published}`);
  if (page.modified) meta.push(`- Modified: ${page.modified}`);
  const parts = [`# ${mdLine(page.title)}`];
  if (page.description) parts.push(`> ${mdLine(page.description)}`);
  parts.push(meta.join('\n'));
  if (page.body.trim()) parts.push(page.body.trim());
  return `${parts.join('\n\n')}\n`;
}

export const MARKDOWN_TYPE = 'text/markdown; charset=utf-8';

/** The copy's address of a page's address (shared with the CMS's audit, P07 task 5.1). */
export { markdownUrlOf } from '@heopress/public-site';
