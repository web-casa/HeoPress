import { decideIndexing, feedEntry, llmsEntry, pageTypeOfCollection, robotsTxt, sitemapEntry, type SitemapEntry } from '@heopress/seo-geo';
import { htmlToMarkdown, publicUrlOf, textToMarkdown, withSponsoredRel } from '@heopress/public-site';
import {
  absoluteLinks,
  atomXml,
  ATOM_TYPE,
  FEED_SIZE,
  NEWS_MAX,
  NEWS_WINDOW_MS,
  newsLanguage,
  newsSitemapXml,
  rssXml,
  RSS_TYPE,
  sitemapIndexXml,
  sitemapShards,
  fittingEntries,
  sitemapTxt,
  sitemapXml,
  TEXT_TYPE,
  XML_TYPE,
  llmsFullHead,
  llmsTxt,
  pageMarkdown,
  type FullFeedEntry,
} from './discovery';
import type { Listable, PublicItemRow, SiteReads } from './read-port';
import { sameLocale } from '@heopress/contracts/schemas';
import { bodyHtml, discoveryPageOf, titleOf, type SiteInfo } from './view-model';

/**
 * Which discovery file a request asks for and its answer (HeoPress P07 tasks 3.1, 3.3, 3.5, 3.7; spec
 * seo/crawl-discovery). Every file of a host lists that host's pages only — the sitemap protocol's rule; a language
 * domain has its own — and only pages that are indexable and canonical to themselves (`@heopress/seo-geo`). The
 * answers are cached as pages are (keyed by the site's render version: a publication changes the key at once); the
 * news sitemap also expires when its earliest article leaves the 48-hour window.
 */

export type DiscoveryFile =
  | { kind: 'robots' }
  | { kind: 'llms'; full: boolean }
  | { kind: 'root-file'; filename: string }
  | { kind: 'sitemap-index' }
  | { kind: 'sitemap'; shard: number }
  | { kind: 'sitemap-txt' }
  | { kind: 'news-sitemap' }
  | { kind: 'feed'; format: 'rss' | 'atom'; collection: string | null; locale: string | null };

/** Collections with a feed of their own (`/feed/<collection>.xml`); the site's feed (`/feed.xml`) is its articles. */
const FEED_COLLECTIONS = ['pages'] as const;

/** Rows read at a time for a feed or the news sitemap, and how many such pages at most (a bound on one answer's work). */
const SCAN_PAGE = 500;
const SCAN_PAGES = 20;

// The language suffix: any tag the site may name (checked against its languages, exactly as it names them).
const FEED_PATH = /^\/(feed|atom)(?:\/([a-z0-9_-]+))?(?:\.([A-Za-z0-9]{1,8}(?:-[A-Za-z0-9]{1,8})*))?\.xml$/;

/** The discovery file a path names, or null (a system path that is not one: not found). */
export function discoveryFileOf(path: string): DiscoveryFile | null {
  if (path === '/robots.txt') return { kind: 'robots' };
  if (path === '/llms.txt') return { kind: 'llms', full: false };
  if (path === '/llms-full.txt') return { kind: 'llms', full: true };
  if (path === '/sitemap.xml') return { kind: 'sitemap-index' };
  if (path === '/sitemap.txt') return { kind: 'sitemap-txt' };
  if (path === '/news-sitemap.xml') return { kind: 'news-sitemap' };
  const shard = /^\/sitemap-([1-9]\d{0,5})\.xml$/.exec(path);
  if (shard) return { kind: 'sitemap', shard: Number(shard[1]) };
  // Any other one-segment name is a site's root file, if the site has one by that name (task 3.8).
  const root = /^\/([A-Za-z0-9][A-Za-z0-9._-]{0,99}\.[A-Za-z0-9]{1,16})$/.exec(path);
  const feed = FEED_PATH.exec(path);
  // A language tag is at most 35 characters (the settings' rule).
  if (feed && (feed[3]?.length ?? 0) <= 35) {
    const collection = feed[2] ?? null;
    if (collection && !(FEED_COLLECTIONS as readonly string[]).includes(collection)) return null;
    return { kind: 'feed', format: feed[1] === 'atom' ? 'atom' : 'rss', collection, locale: feed[3] ?? null };
  }
  if (root && !feed) return { kind: 'root-file', filename: root[1]! };
  return null;
}

/** A feed's path: `/feed.xml`, `/atom/pages.ja.xml` (the language only when it is not the host's). */
export function feedPath(format: 'rss' | 'atom', collection: string | null, locale: string | null): string {
  return `/${format === 'atom' ? 'atom' : 'feed'}${collection ? `/${collection}` : ''}${locale ? `.${locale}` : ''}.xml`;
}

export interface DiscoveryAnswer {
  body: string;
  contentType: string;
  /** Representation headers (a root file's). */
  headers?: Record<string, string>;
  /** When the answer stops being true whatever the site's version (ms). */
  expiresAt?: number | null;
}

export interface DiscoveryContext {
  reads: SiteReads;
  site: SiteInfo;
  /** The host the request came to (its pages are listed). */
  host: string;
  space: Parameters<typeof publicUrlOf>[0];
  now: number;
  /**
   * The host's sitemap entries already made for this site version (`app.ts` keeps a few): every shard, the index and
   * `sitemap.txt` of one version share one computation.
   */
  memo?: { get(): Promise<SitemapEntry[]> | undefined; set(entries: Promise<SitemapEntry[]>): void };
  /** The site's public item count for this version (`app.ts` keeps it per version; else read). */
  itemCount?: () => Promise<number>;
}

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
};

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

const locales = (site: SiteInfo): string[] =>
  Array.isArray(site.settings.availableLocales) && site.settings.availableLocales.length ? (site.settings.availableLocales as string[]) : [site.defaultLanguage];

/** The host's sitemap entries in a stable order, made once per site version (`ctx.memo`). */
function sitemapEntries(ctx: DiscoveryContext): Promise<SitemapEntry[]> {
  const known = ctx.memo?.get();
  if (known) return known;
  const made = buildSitemapEntries(ctx);
  ctx.memo?.set(made);
  return made;
}

/** Its language homes that are indexable, then its pages by language and path. */
async function buildSitemapEntries(ctx: DiscoveryContext): Promise<SitemapEntry[]> {
  const host = ctx.host.toLowerCase();
  const out: SitemapEntry[] = [];
  const homeIndexing = decideIndexing({ settings: ctx.site.seo!, pageType: 'home', collection: null });
  if (homeIndexing.indexable) {
    for (const locale of locales(ctx.site)) {
      const home = publicUrlOf(ctx.space, locale, '/');
      if (home && /^https:\/\//.test(home) && hostOf(home) === host) out.push({ loc: home, lastmod: null, alternates: [] });
    }
  }
  // The plugin list routes' pages (P12 task 2.5: discovery contributions through the core): in each language that has
  // items to list, when the route lists them and the page is indexable by the same decision as its head.
  const routes = ctx.site.extensions?.routes ?? [];
  for (const route of routes) {
    if (route.kind !== 'list' || !route.sitemap) continue;
    if (!decideIndexing({ settings: ctx.site.seo!, pageType: 'taxonomy', collection: route.collection }).indexable) continue;
    for (const locale of locales(ctx.site)) {
      if ((await ctx.reads.collectionItems(locale, route.collection, { offset: 0, limit: 1 })).length === 0) continue;
      const url = publicUrlOf(ctx.space, locale, route.path);
      if (url && /^https:\/\//.test(url) && hostOf(url) === host) out.push({ loc: url, lastmod: null, alternates: [] });
    }
  }
  // A plugin item route that keeps its pages out of the sitemap (`sitemap: false`).
  const unlisted = new Set(routes.filter((r) => r.kind === 'item' && !r.sitemap).map((r) => r.collection));
  const [rows, alternates] = await Promise.all([ctx.reads.sitemapItems(), ctx.reads.allAlternates()]);
  for (const row of rows) {
    if (unlisted.has(row.collection)) continue;
    const entry = sitemapEntry(discoveryPageOf(ctx.site, row, alternates.get(row.itemId) ?? []));
    if (entry && hostOf(entry.loc) === host) out.push(entry);
  }
  return fittingEntries(out);
}

const newest = (entries: SitemapEntry[]): string | null => entries.reduce<string | null>((m, e) => (e.lastmod && (!m || e.lastmod > m) ? e.lastmod : m), null);

/** Whether a collection's pages are indexable by default (the site, page type and collection defaults). */
function listable(site: SiteInfo, collection: string): Listable {
  return { defaultIndexable: decideIndexing({ settings: site.seo!, pageType: pageTypeOfCollection(collection), collection }).indexable };
}

/**
 * The news sitemap's articles on this host: the newest eligible ones of the window — read newest first, a page at a
 * time, only rows whose own setting can let them be indexed, at most `SCAN_PAGES` pages — and when the answer stops
 * being true: the oldest one listed leaving the window, or the next one entering it (published later than now).
 */
async function newsEntries(ctx: DiscoveryContext) {
  const host = ctx.host.toLowerCase();
  const filter = listable(ctx.site, 'articles');
  const since = new Date(ctx.now - NEWS_WINDOW_MS);
  const entries: Array<{ row: PublicItemRow; loc: string; published: Date }> = [];
  for (let page = 0; page < SCAN_PAGES && entries.length < NEWS_MAX; page++) {
    const rows = await ctx.reads.articlesBetween(since, new Date(ctx.now), { host, offset: page * SCAN_PAGE, limit: SCAN_PAGE, listable: filter });
    for (const row of rows) {
      if (entries.length >= NEWS_MAX) break;
      const entry = sitemapEntry(discoveryPageOf(ctx.site, row));
      if (entry && hostOf(entry.loc) === host) entries.push({ row, loc: entry.loc, published: row.publishedAt! });
    }
    if (rows.length < SCAN_PAGE) break;
  }
  const next = await ctx.reads.nextPublication(new Date(ctx.now), { host, listable: filter });
  const leaves = entries.length ? entries[entries.length - 1]!.published.getTime() + NEWS_WINDOW_MS : null;
  const ends = [leaves, next?.getTime() ?? null].filter((t): t is number => t !== null);
  return { entries, expiresAt: ends.length ? Math.min(...ends) : null };
}

/** Pages and articles in `llms.txt` at most; pieces in `llms-full.txt` at most, and its bytes. */
const LLMS_PAGES = 50;
const LLMS_RECENT = 30;
const LLMS_FULL_ITEMS = 200;
const LLMS_FULL_BYTES = 5 * 1024 * 1024;
/** Whole rows read at a time for `llms-full.txt`. */
const LLMS_FULL_READ = 20;

/** Rows `llms.txt` looks at per list at most, however many collections and languages (Codex review of batch 9, rounds 3–7). */
const LLMS_SCAN = 2000;
/** Rows taken by one read at most (each read takes as many as are still wanted, doubling while too few are listed). */
const LLMS_READ = 200;
/**
 * Streams (collections, or collections × the host's languages) a list reads at most, the first by name (Codex review of
 * batch 9, round 8: each read merges at most `LLMS_STREAMS × LLMS_READ` keys). A site past it lists from those only.
 */
const LLMS_STREAMS = 100;

/** The site's languages whose addresses are on `host` (its own, under every language strategy). */
function localesOn(ctx: DiscoveryContext, host: string): string[] {
  return locales(ctx.site).filter((l) => {
    const home = publicUrlOf(ctx.space, l, '/');
    return home !== null && hostOf(home) === host;
  });
}

type Listed = { row: PublicItemRow; entry: NonNullable<ReturnType<typeof llmsEntry>> };

/**
 * The newest `count` listed items of `collections` on the host, newest first across them (Codex review of batch 9,
 * rounds 6 and 7): each collection (in each of the host's languages when the host does not serve them all) is a stream;
 * one statement per read merges them in the database (time, then id in code-point order) and takes the newest rows — as
 * many as are still wanted, doubling while too few of them are listed. At most `LLMS_SCAN` rows are taken in all, in a
 * handful of statements, whatever the number of collections and languages (fewer listed then).
 */
async function newestListed(ctx: DiscoveryContext, collections: string[], count: number, listed: (row: PublicItemRow) => Listed | null): Promise<Listed[]> {
  const host = ctx.host.toLowerCase();
  const all = locales(ctx.site);
  const own = localesOn(ctx, host);
  // A host serving every language reads each collection once; otherwise each of its languages apart.
  const scopes: Array<string | null> = own.length === all.length ? [null] : own;
  const streams = collections
    .flatMap((collection) => scopes.map((locale) => ({ collection, locale, skip: 0, listable: listable(ctx.site, collection) })))
    .slice(0, LLMS_STREAMS);
  const out: Listed[] = [];
  let taken = 0;
  let size = Math.max(1, count);
  while (out.length < count && taken < LLMS_SCAN && streams.length > 0) {
    const limit = Math.min(size, LLMS_READ, LLMS_SCAN - taken);
    const rows = await ctx.reads.llmsNewest({ streams, perStream: limit, limit });
    for (const row of rows) {
      streams[row.stream]!.skip++;
      taken++;
      const found = out.length < count ? listed(row) : null;
      if (found) out.push(found);
    }
    if (rows.length < limit) break;
    size = Math.max(size * 2, count - out.length);
  }
  return out;
}

/**
 * The host's listable item pages (task 4.1): `llmsEntry` of each (indexable, canonical to itself), on this host — every
 * collection whose pages are items (Codex review of batch 9: not only `pages` and `articles`), in the languages this host
 * serves (round 5). The newest listed pages (shown by title) and the newest listed articles, each list reading at most
 * `LLMS_SCAN` rows through the collections' recency indexes (rounds 2–6: never the whole site). Without the bodies.
 */
async function llmsEntries(ctx: DiscoveryContext, want: { pages: number; articles: number | ((pages: number) => number) }) {
  const host = ctx.host.toLowerCase();
  // A plugin item route that keeps its pages out of `llms.txt` (`llms: false`, P12 task 2.5).
  const unlisted = new Set((ctx.site.extensions?.routes ?? []).filter((r) => r.kind === 'item' && !r.llms).map((r) => r.collection));
  const collections = (await ctx.reads.publicCollections()).filter((c) => pageTypeOfCollection(c) === 'item' && !unlisted.has(c));
  const listed = (row: PublicItemRow): Listed | null => {
    const entry = llmsEntry(discoveryPageOf(ctx.site, row));
    return entry && hostOf(entry.url) === host ? { row, entry } : null;
  };
  const others = collections.filter((c) => c !== 'articles');
  const pages = (await newestListed(ctx, others, want.pages, listed)).sort((a, b) =>
    a.entry.title < b.entry.title ? -1 : a.entry.title > b.entry.title ? 1 : a.entry.url < b.entry.url ? -1 : a.entry.url > b.entry.url ? 1 : a.row.itemId < b.row.itemId ? -1 : 1,
  );
  // `articles` counts what is left once the pages are in (round 3: no list read that cannot be shown).
  const count = typeof want.articles === 'number' ? want.articles : want.articles(pages.length);
  const articles = count > 0 && collections.includes('articles') ? await newestListed(ctx, ['articles'], count, listed) : [];
  return { pages, articles };
}

function llmsHeader(ctx: DiscoveryContext) {
  const identity = ctx.site.identity?.name;
  return {
    title: ctx.site.name,
    summary: identity && identity !== ctx.site.name ? `${ctx.site.name}, by ${identity}.` : `${ctx.site.name}.`,
  };
}

/** `llms.txt` (task 4.1): the site, its pages, its recent articles, and its discovery files (feeds, sitemap, full text). */
async function llms(ctx: DiscoveryContext, origin: string): Promise<string> {
  const seo = ctx.site.seo!;
  const { pages, articles } = await llmsEntries(ctx, { pages: LLMS_PAGES, articles: LLMS_RECENT });
  const links: Array<{ label: string; url: string }> = [];
  if (seo.discovery.feeds) links.push({ label: 'RSS feed', url: `${origin}${feedPath('rss', null, null)}` }, { label: 'Atom feed', url: `${origin}${feedPath('atom', null, null)}` });
  links.push({ label: 'Sitemap', url: `${origin}/sitemap.xml` });
  if (seo.discovery.newsSitemap) links.push({ label: 'News sitemap', url: `${origin}/news-sitemap.xml` });
  links.push({ label: 'Full text', url: `${origin}/llms-full.txt` });
  return llmsTxt({
    ...llmsHeader(ctx),
    pages: pages.map((p) => p.entry),
    recent: articles.map((a) => a.entry),
    links,
  });
}

/** A page's body as Markdown: rich text converted, plain text as paragraphs. */
export function markdownBodyOf(row: PublicItemRow, url: string): string {
  const body = typeof row.data.body === 'string' ? row.data.body : '';
  if (!body) return '';
  return row.richFields.includes('body') ? htmlToMarkdown(body, url) : textToMarkdown(body);
}

/**
 * `llms-full.txt` (task 4.1): the header of `llms.txt`, then each listable page and article (pages first, then the newest
 * articles) in Markdown — at most `LLMS_FULL_ITEMS` pieces and `LLMS_FULL_BYTES` bytes, whole pieces only.
 */
async function llmsFull(ctx: DiscoveryContext, origin: string): Promise<string> {
  const { pages, articles } = await llmsEntries(ctx, { pages: LLMS_FULL_ITEMS, articles: (pages) => LLMS_FULL_ITEMS - pages });
  // The site's name and summary escaped as in `llms.txt` (Codex review of batch 9, round 2).
  const head = llmsFullHead({ ...llmsHeader(ctx), origin });
  const chosen = [...pages, ...articles].slice(0, LLMS_FULL_ITEMS);
  const parts = [head];
  let bytes = Buffer.byteLength(head);
  // A few whole rows at a time (bodies are large), each entry made again from its whole row; whole pieces until the cap.
  for (let i = 0; i < chosen.length; i += LLMS_FULL_READ) {
    const whole = await ctx.reads.itemsByIds(chosen.slice(i, i + LLMS_FULL_READ).map((c) => c.row.itemId));
    for (const row of whole) {
      const entry = llmsEntry(discoveryPageOf(ctx.site, row));
      if (!entry) continue;
      const piece = `\n---\n\n${pageMarkdown({
        title: entry.title,
        description: entry.description,
        url: entry.url,
        published: row.publishedAt?.toISOString() ?? null,
        modified: row.contentModifiedAt?.toISOString() ?? null,
        body: markdownBodyOf(row, entry.url),
      })}`;
      const size = Buffer.byteLength(piece);
      if (bytes + size > LLMS_FULL_BYTES) return parts.join('');
      parts.push(piece);
      bytes += size;
    }
  }
  return parts.join('');
}

/** The answer to a discovery file on this host, or null (not found: no such shard, a file the site turned off). */
export async function discoveryAnswer(file: DiscoveryFile, ctx: DiscoveryContext): Promise<DiscoveryAnswer | null> {
  const seo = ctx.site.seo!;
  const origin = `https://${ctx.host}`;
  switch (file.kind) {
    case 'root-file': {
      // The IndexNow key file (task 3.4): the key itself at `/<key>.txt`, while IndexNow is on — on every host of the site
      // (each host's notices name their own `keyLocation`). A root file never takes this name (the CMS refuses it).
      const key = seo.discovery.indexNow ? seo.discovery.indexNowKey : null;
      if (key && file.filename === `${key}.txt`) return { body: key, contentType: TEXT_TYPE };
      const found = await ctx.reads.rootFile(file.filename);
      if (!found) return null;
      // Its type comes from its name (checked when it was written); never sniffed, and a sandbox if opened as a page.
      return { body: found.content, contentType: found.contentType, headers: { 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'" } };
    }
    case 'robots':
      // The crawler policy (task 3.2), the sitemaps of this host and its default language's feeds (tasks 3.1, 3.3, 3.7).
      return {
        body: robotsTxt({
          settings: seo,
          origin,
          newsSitemap: seo.discovery.newsSitemap,
          feeds: seo.discovery.feeds ? [`${origin}${feedPath('rss', null, null)}`, `${origin}${feedPath('atom', null, null)}`] : [],
        }),
        contentType: TEXT_TYPE,
      };
    case 'sitemap-index': {
      const entries = await sitemapEntries(ctx);
      const list = sitemapShards(entries).map(([from, to], i) => ({ loc: `${origin}/sitemap-${i + 1}.xml`, lastmod: newest(entries.slice(from, to)) }));
      if (seo.discovery.newsSitemap) list.push({ loc: `${origin}/news-sitemap.xml`, lastmod: null });
      return { body: sitemapIndexXml(list), contentType: XML_TYPE };
    }
    case 'sitemap': {
      // Past what the site could fill (every shard holds an entry at least: its public items and language homes): not
      // found, without reading them.
      const count = await (ctx.itemCount ? ctx.itemCount() : ctx.reads.publicItemCount());
      if (file.shard > Math.max(1, count + locales(ctx.site).length)) return null;
      const entries = await sitemapEntries(ctx);
      const shards = sitemapShards(entries);
      // Shard 1 always exists (an empty site has an empty one); past the last, not found.
      const range = shards[file.shard - 1];
      if (!range) return null;
      return { body: sitemapXml(entries.slice(range[0], range[1])), contentType: XML_TYPE };
    }
    case 'llms': {
      if (!seo.discovery.llms) return null;
      return file.full ? { body: await llmsFull(ctx, origin), contentType: TEXT_TYPE } : { body: await llms(ctx, origin), contentType: TEXT_TYPE };
    }
    case 'sitemap-txt':
      return { body: sitemapTxt((await sitemapEntries(ctx)).map((e) => e.loc)), contentType: TEXT_TYPE };
    case 'news-sitemap': {
      if (!seo.discovery.newsSitemap) return null;
      const { entries, expiresAt } = await newsEntries(ctx);
      const publication = seo.discovery.newsPublicationName || ctx.site.name;
      return {
        body: newsSitemapXml(
          publication,
          entries.map((e) => ({ loc: e.loc, title: titleOf(e.row), published: e.published.toISOString(), language: newsLanguage(e.row.locale) })),
        ),
        contentType: XML_TYPE,
        expiresAt,
      };
    }
    case 'feed': {
      if (!seo.discovery.feeds) return null;
      // One address per feed (Codex review of batch 6): the language comes from the path alone — none for the site's
      // default language, else exactly as the site names it (another spelling, or the default named, is not found) — so
      // no two paths make the same answer and multiply the cached ones.
      // (Languages compared as languages: a default stored as `zh-cn` is the site's `zh-CN`.)
      const available = locales(ctx.site);
      const locale = file.locale
        ? available.find((l) => l === file.locale && !sameLocale(l, ctx.site.defaultLanguage))
        : (available.find((l) => sameLocale(l, ctx.site.defaultLanguage)) ?? ctx.site.defaultLanguage);
      if (!locale) return null;
      const collection = file.collection ?? 'articles';
      const hosts = await ctx.reads.hosts();
      const author = ctx.site.identity?.name || ctx.site.name;
      // Newest first, a page at a time, until the feed is full or the collection ends — only rows whose own setting can let
      // them be indexed (`listable`, in the query), so pages not indexed never crowd out older ones that are; at most
      // `SCAN_PAGES` pages (what is left to skip then is pages canonical to another address). The rows are read without
      // their rich text; the bodies of the entries kept are read after.
      const filter = listable(ctx.site, collection);
      const picked: string[] = [];
      for (let page = 0; page < SCAN_PAGES && picked.length < FEED_SIZE; page++) {
        const rows = await ctx.reads.latest(locale, collection, { offset: page * SCAN_PAGE, limit: SCAN_PAGE, listable: filter });
        for (const row of rows) {
          if (picked.length >= FEED_SIZE) break;
          if (feedEntry(discoveryPageOf(ctx.site, row))) picked.push(row.itemId);
        }
        if (rows.length < SCAN_PAGE) break;
      }
      // Each entry made again from its whole row (a summary may be rich text the scan left out).
      const entries: FullFeedEntry[] = (await ctx.reads.itemsByIds(picked)).flatMap((row) => {
        const entry = feedEntry(discoveryPageOf(ctx.site, row));
        if (!entry) return [];
        const body = row.sponsored && ctx.site.settings.sponsorRel === true ? withSponsoredRel(bodyHtml(row), hosts) : bodyHtml(row);
        return [{ ...entry, html: absoluteLinks(body, entry.url) }];
      });
      const home = publicUrlOf(ctx.space, locale, '/') ?? `${origin}/`;
      const self = `${origin}${feedPath(file.format, file.collection, file.locale)}`;
      const updated = entries.reduce<string | null>((m, e) => {
        const t = e.updated ?? e.published;
        return t && (!m || t > m) ? t : m;
      }, null);
      const info = {
        self,
        home: /^https?:\/\//.test(home) ? home : `${origin}${home}`,
        title: file.collection && file.collection !== 'articles' ? `${ctx.site.name} · ${collection}` : ctx.site.name,
        description: ctx.site.name,
        language: locale,
        author,
        // No entry: the epoch (an answer that is the same until the site changes).
        updated: updated ?? iso(new Date(0))!,
      };
      return file.format === 'atom' ? { body: atomXml(info, entries), contentType: ATOM_TYPE } : { body: rssXml(info, entries), contentType: RSS_TYPE };
    }
  }
}
