import { describe, expect, it } from 'vitest';
import {
  absoluteLinks,
  atomXml,
  newsLanguage,
  newsSitemapXml,
  rssXml,
  fittingEntries,
  sitemapIndexXml,
  sitemapShards,
  sitemapTxt,
  sitemapXml,
  xmlText,
  type FullFeedEntry,
} from '../discovery';
import { discoveryFileOf, feedPath } from '../discovery-plan';
import { schemaErrors } from './xml-schemas';

/** The discovery files' serialisation (HeoPress P07 tasks 3.1, 3.3, 3.7): valid against their schemas, every value escaped. */
const BASE = 'https://example.com';
const entry = (i: number) => ({ loc: `${BASE}/post-${i}/`, lastmod: '2026-10-03T08:00:00.000Z', alternates: [{ locale: 'en', url: `${BASE}/post-${i}/` }, { locale: 'zh-CN', url: `${BASE}/zh/post-${i}/` }, { locale: 'x-default', url: `${BASE}/post-${i}/` }] });
const feed = { self: `${BASE}/feed.xml`, home: `${BASE}/`, title: 'Tom & Jerry <news>', description: 'All "the" news', language: 'en', author: 'Example Ltd', updated: '2026-10-03T08:00:00.000Z' };
const items: FullFeedEntry[] = [
  { id: `${BASE}/a/`, url: `${BASE}/a/`, title: 'A </title> & more', summary: 'Sum <b>', published: '2026-10-01T08:00:00.000Z', updated: '2026-10-03T08:00:00.000Z', html: '<p>Body &amp; <a href="https://example.com/x/">x</a></p>' },
  { id: `${BASE}/b/`, url: `${BASE}/b/`, title: 'B', summary: '', published: null, updated: null, html: '' },
];

describe('sitemaps (task 3.1)', () => {
  it('a shard and the index pass the sitemap schema; values are escaped', async () => {
    const shard = sitemapXml([entry(1), { loc: `${BASE}/?a=1&b=<2>`, lastmod: null, alternates: [] }]);
    expect(shard).toContain('<loc>https://example.com/?a=1&amp;b=&lt;2&gt;</loc>');
    expect(await schemaErrors(shard, 'sitemap.xsd')).toEqual([]);
    expect(await schemaErrors(sitemapXml([]), 'sitemap.xsd')).toEqual([]);
    const index = sitemapIndexXml([{ loc: `${BASE}/sitemap-1.xml`, lastmod: '2026-10-03T08:00:00.000Z' }, { loc: `${BASE}/news-sitemap.xml`, lastmod: null }]);
    expect(await schemaErrors(index, 'sitemap.xsd')).toEqual([]);
    // The schema does reject what the protocol does not allow.
    expect((await schemaErrors(sitemapXml([{ loc: '/relative/', lastmod: 'yesterday', alternates: [] }]), 'sitemap.xsd')).length).toBeGreaterThan(0);
  });

  it('language alternates on other hosts are kept: hreflang is bidirectional across hosts (only <loc> is the host\'s own)', async () => {
    const xml = sitemapXml([{ loc: `${BASE}/a/`, lastmod: null, alternates: [{ locale: 'en', url: `${BASE}/a/` }, { locale: 'fr', url: 'https://fr.example.org/a/' }] }]);
    expect(xml).toContain('<xhtml:link rel="alternate" hreflang="fr" href="https://fr.example.org/a/"/>');
    expect(await schemaErrors(xml, 'sitemap.xsd')).toEqual([]);
  });

  it('a full shard of 10,000 entries with alternates is valid', async () => {
    const xml = sitemapXml(Array.from({ length: 10_000 }, (_, i) => entry(i)));
    expect(await schemaErrors(xml, 'sitemap.xsd')).toEqual([]);
  }, 60_000);

  it('task 3.6: shards hold at most N entries and M bytes; heavy pages fill the bytes first; every shard is valid', async () => {
    const heavy = (i: number) => ({
      loc: `${BASE}/heavy-${i}/`,
      lastmod: '2026-10-03T08:00:00.000Z',
      // Letters only: valid language tags (`aa`, `ba`, …).
      alternates: Array.from({ length: 40 }, (_, k) => ({ locale: String.fromCharCode(97 + (k % 26), 97 + Math.floor(k / 26)), url: `${BASE}/l${k}/heavy-${i}/${'p'.repeat(60)}` })),
    });
    const entries = Array.from({ length: 300 }, (_, i) => heavy(i));
    const maxBytes = 200_000;
    const shards = sitemapShards(entries, 10_000, maxBytes);
    expect(shards.length).toBeGreaterThan(1);
    // Contiguous, in order, every entry once.
    expect(shards[0]![0]).toBe(0);
    for (let i = 1; i < shards.length; i++) expect(shards[i]![0]).toBe(shards[i - 1]![1]);
    expect(shards[shards.length - 1]![1]).toBe(entries.length);
    for (const [from, to] of shards) {
      const xml = sitemapXml(entries.slice(from, to));
      expect(Buffer.byteLength(xml)).toBeLessThanOrEqual(maxBytes);
      expect(await schemaErrors(xml, 'sitemap.xsd')).toEqual([]);
    }
    // By count when the entries are light; one entry larger than a shard still gets its own.
    expect(sitemapShards(Array.from({ length: 25 }, (_, i) => entry(i)), 10, 10_000_000)).toEqual([[0, 10], [10, 20], [20, 25]]);
    expect(sitemapShards([heavy(1), heavy(2)], 10, 100)).toEqual([[0, 1], [1, 2]]);
    // An entry larger than a shard loses its alternates (Codex review of batch 8); one whose address alone is too large goes.
    const fitted = fittingEntries([heavy(1), entry(2)], 1000);
    expect(fitted.map((e) => [e.loc, e.alternates.length])).toEqual([[`${BASE}/heavy-1/`, 0], [`${BASE}/post-2/`, 3]]);
    for (const [from, to] of sitemapShards(fitted, 10, 1000)) expect(Buffer.byteLength(sitemapXml(fitted.slice(from, to)))).toBeLessThanOrEqual(1000);
    expect(fittingEntries([{ loc: `${BASE}/${'x'.repeat(2000)}/`, lastmod: null, alternates: [] }], 1000)).toEqual([]);
    expect(sitemapShards([])).toEqual([[0, 0]]);
    // Schema validation of every shard: slower on a CI runner than the default 5 s.
  }, 60_000);

  it('sitemap.txt: one URL per line, nothing else', () => {
    expect(sitemapTxt([`${BASE}/a/`, `${BASE}/b\n/`])).toBe(`${BASE}/a/\n${BASE}/b/\n`);
  });

  it('characters XML cannot hold are removed', () => {
    expect(xmlText('a\u0000b\u0008c\ud800d￿')).toBe('abcd');
  });
});

describe('feeds (task 3.3)', () => {
  it('RSS 2.0 and Atom pass their schemas, with the full text escaped and absolute links', async () => {
    const rss = rssXml(feed, items);
    expect(await schemaErrors(rss, 'rss.xsd')).toEqual([]);
    expect(rss).toContain('<content:encoded>&lt;p&gt;Body &amp;amp; &lt;a href=&quot;https://example.com/x/&quot;&gt;x&lt;/a&gt;&lt;/p&gt;</content:encoded>');
    expect(rss).toContain('<pubDate>Thu, 01 Oct 2026 08:00:00 GMT</pubDate>');
    const atom = atomXml(feed, items);
    expect(await schemaErrors(atom, 'atom.xsd')).toEqual([]);
    expect(atom).toContain('<title>A &lt;/title&gt; &amp; more</title>');
    // An entry without dates takes the feed's.
    expect(atom).toContain('<id>https://example.com/b/</id><title>B</title><link rel="alternate" type="text/html" href="https://example.com/b/"/><updated>2026-10-03T08:00:00.000Z</updated>');
    expect(await schemaErrors(rssXml(feed, []), 'rss.xsd')).toEqual([]);
    expect(await schemaErrors(atomXml(feed, []), 'atom.xsd')).toEqual([]);
  });

  it('links in the full text are made absolute against the page', () => {
    expect(absoluteLinks('<p><a href="/x/?a=1&amp;b=2">x</a><img src="../i.png"><a href="https://other.example.org/">o</a><a href="mailto:a@example.com">m</a></p>', `${BASE}/blog/post/`)).toBe(
      '<p><a href="https://example.com/x/?a=1&amp;b=2">x</a><img src="https://example.com/blog/i.png"><a href="https://other.example.org/">o</a><a href="mailto:a@example.com">m</a></p>',
    );
  });

  it('feed paths: the site, a collection, a language; nothing else', () => {
    expect(discoveryFileOf('/feed.xml')).toEqual({ kind: 'feed', format: 'rss', collection: null, locale: null });
    // One address per feed: no `/rss.xml` alias, no collection feed of the articles (the site's feed is).
    // `/rss.xml` is no feed: a root file by that name is looked for (a name the system keeps: there is none, so not found).
    expect(discoveryFileOf('/rss.xml')).toEqual({ kind: 'root-file', filename: 'rss.xml' });
    expect(discoveryFileOf('/feed/articles.xml')).toBeNull();
    // Any language tag a site may name (checked against its languages when answered).
    expect(discoveryFileOf('/feed.x-private.xml')).toEqual({ kind: 'feed', format: 'rss', collection: null, locale: 'x-private' });
    expect(discoveryFileOf('/feed.de-DE-u-co-phonebk-kf-upper-kn-true.xml')).toMatchObject({ locale: 'de-DE-u-co-phonebk-kf-upper-kn-true' });
    expect(discoveryFileOf(`/feed.${'a-'.repeat(18)}a.xml`)).toBeNull();
    expect(discoveryFileOf('/atom/pages.zh-Hant-TW.xml')).toEqual({ kind: 'feed', format: 'atom', collection: 'pages', locale: 'zh-Hant-TW' });
    expect(discoveryFileOf('/atom/pages.zh-CN.xml')).toEqual({ kind: 'feed', format: 'atom', collection: 'pages', locale: 'zh-CN' });
    expect(discoveryFileOf('/feed/users.xml')).toBeNull();
    expect(discoveryFileOf('/feed')).toBeNull();
    // Not a shard: looked for as a root file (a reserved name: none exists, so not found).
    expect(discoveryFileOf('/sitemap-0.xml')).toEqual({ kind: 'root-file', filename: 'sitemap-0.xml' });
    expect(discoveryFileOf('/sitemap-3.xml')).toEqual({ kind: 'sitemap', shard: 3 });
    expect(feedPath('atom', 'pages', 'ja')).toBe('/atom/pages.ja.xml');
    expect(discoveryFileOf(feedPath('rss', null, 'zh-CN'))).toEqual({ kind: 'feed', format: 'rss', collection: null, locale: 'zh-CN' });
  });
});

describe('news sitemap (task 3.7)', () => {
  it('passes the sitemap and news schemas; the language as the format names it', async () => {
    const xml = newsSitemapXml('Tom & Jerry', [{ loc: `${BASE}/a/`, title: 'A & B', published: '2026-10-01T08:00:00.000Z', language: newsLanguage('en-GB') }]);
    expect(await schemaErrors(xml, 'sitemap.xsd')).toEqual([]);
    expect(xml).toContain('<news:name>Tom &amp; Jerry</news:name><news:language>en</news:language>');
    expect(['zh', 'zh-CN', 'zh-Hans', 'zh-SG'].map(newsLanguage)).toEqual(['zh-cn', 'zh-cn', 'zh-cn', 'zh-cn']);
    expect(['zh-TW', 'zh-Hant', 'zh-HK'].map(newsLanguage)).toEqual(['zh-tw', 'zh-tw', 'zh-tw']);
  });
});
