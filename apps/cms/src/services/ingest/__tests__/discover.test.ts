import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { maybeGunzip, parseFeed, parseListPage, parseSitemap } from '../discover';
import { IngestFetchError } from '../failure';
import { entitiesFromList, eventFingerprint, extractEntities, sameEvent } from '../event-cluster';
import { normalizeUrl, trackingParamsFromEnv } from '../url-normalize';

/**
 * Discovery parsers, URL normalisation and event fingerprints (HeoPress P08 tasks 1.3, 4.1, 4.3, 4.4) on recorded,
 * synthetic samples (`fixtures/discovery`).
 */

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', 'discovery', name), 'utf8');

describe('discovery parsers', () => {
  it('RSS 2.0: item links (relative resolved, guid permalink), titles, dates; items without a link skipped', () => {
    const page = parseFeed(fixture('rss.xml'), 'https://news.example.com/feed.xml');
    expect(page.links.map((l) => l.url)).toEqual([
      'https://news.example.com/2026/harbour-season?utm_source=rss&utm_medium=feed',
      'https://news.example.com/2026/market-day',
      'https://news.example.com/2026/guid-only',
    ]);
    expect(page.links[1]!.title).toBe('Market <b>day</b> moves');
    expect(page.links[0]!.publishedAt?.toISOString()).toBe('2026-10-26T08:00:00.000Z');
    expect(page.links[1]!.publishedAt?.toISOString()).toBe('2026-10-25T09:30:00.000Z');
    expect(page.next).toBeNull();
  });

  it('Atom: the alternate link of each entry, relative links resolved, rel="next" as the next page', () => {
    const page = parseFeed(fixture('atom.xml'), 'https://blog.example.com/atom.xml');
    expect(page.links.map((l) => l.url)).toEqual(['https://blog.example.com/posts/release-notes', 'https://blog.example.com/posts/second']);
    expect(page.next).toBe('https://blog.example.com/atom.xml?page=2');
  });

  it('sitemap index → child sitemaps; urlset → page URLs; gzip bodies decompressed with a cap', () => {
    expect(parseSitemap(fixture('sitemap-index.xml'), 'https://docs.example.com/sitemap.xml').children).toEqual([
      'https://docs.example.com/sitemap-news.xml.gz',
      'https://docs.example.com/sitemap-pages.xml',
    ]);
    const gz = gzipSync(Buffer.from(fixture('sitemap-urlset.xml')));
    const urls = parseSitemap(maybeGunzip(gz, 1024 * 1024).toString('utf8'), 'https://docs.example.com/x').links.map((l) => l.url);
    expect(urls).toEqual(['https://docs.example.com/guide/Install', 'https://docs.example.com/guide/install', 'https://docs.example.com/item?id=1', 'https://docs.example.com/item?id=2']);
    // A small gzip bomb is refused, not expanded.
    expect(() => maybeGunzip(gzipSync(Buffer.alloc(2 * 1024 * 1024)), 64 * 1024)).toThrow(IngestFetchError);
  });

  it('list page: items by CSS selector, link and title per item, the next page by rel="next" or a selector', () => {
    const html = fixture('list-page.html');
    const page = parseListPage(html, 'https://archive.example.com/archive', { item: 'li.post', link: 'a.more', title: '.t' });
    expect(page.links).toEqual([
      { url: 'https://archive.example.com/stories/first', title: 'First story', publishedAt: null },
      { url: 'https://other.example.com/stories/second', title: 'Second story', publishedAt: null },
    ]);
    expect(page.next).toBe('https://archive.example.com/archive?page=2');
    expect(parseListPage(html, 'https://archive.example.com/archive', { item: 'li.post', link: 'a.more', nextPage: 'a.older' }).next).toBe('https://archive.example.com/archive?page=2');
  });

  it('a document of the wrong kind is an extraction failure', () => {
    expect(() => parseFeed('<html><body>hi</body></html>', 'https://e.example.com/')).toThrow(/not a feed/);
    expect(() => parseSitemap(fixture('rss.xml'), 'https://e.example.com/')).toThrow(/not a sitemap/);
  });
});

describe('URL normalisation (task 4.1, 4.3)', () => {
  it('lower-cases scheme and host, drops the default port and the fragment, removes configured tracking parameters', () => {
    expect(normalizeUrl('HTTPS://News.Example.COM:443/2026/Story?utm_source=x&utm_medium=y&fbclid=abc#top')).toBe('https://news.example.com/2026/Story');
    expect(normalizeUrl('http://news.example.com:80/a?gclid=1&page=2&mc_cid=3')).toBe('http://news.example.com/a?page=2');
    expect(normalizeUrl('https://news.example.com:8443/a')).toBe('https://news.example.com:8443/a');
  });

  it('keeps path case, functional parameters, their order and encoding, and trailing-slash semantics', () => {
    expect(normalizeUrl('https://e.example.com/A')).not.toBe(normalizeUrl('https://e.example.com/a'));
    expect(normalizeUrl('https://e.example.com/item?id=1')).not.toBe(normalizeUrl('https://e.example.com/item?id=2'));
    expect(normalizeUrl('https://e.example.com/news')).not.toBe(normalizeUrl('https://e.example.com/news/'));
    expect(normalizeUrl('https://e.example.com/s?q=a+b&lang=en&utm_campaign=z')).toBe('https://e.example.com/s?q=a+b&lang=en');
    // A parameter merely *named* like a tracking prefix is only removed when configured.
    expect(normalizeUrl('https://e.example.com/s?utmost=1')).toBe('https://e.example.com/s?utmost=1');
  });

  it('only http(s) URLs; extra tracking parameters from the environment', () => {
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeUrl('ftp://e.example.com/x')).toBeNull();
    const params = trackingParamsFromEnv({ HEOPRESS_INGEST_TRACKING_PARAMS: 'ref, src_*' });
    expect(normalizeUrl('https://e.example.com/a?ref=home&src_feed=1&id=7', params)).toBe('https://e.example.com/a?id=7');
    expect(normalizeUrl('https://e.example.com/a?ref=home')).toBe('https://e.example.com/a?ref=home');
  });
});

describe('event fingerprints (task 4.4)', () => {
  const lead = 'The project published the release on Tuesday with faster queries and a new storage engine.';

  it('extracts versions, proper nouns (spacing-insensitive) and numbers; ignores sentence-initial common words', () => {
    const e = extractEntities('ExampleDB 5.2 Released With Faster Queries', lead);
    expect(e.versions).toEqual(['v:5.2']);
    expect(e.strong).toContain('n:exampledb');
    expect(extractEntities('Example DB v5.2 is out', '').strong).toEqual(expect.arrayContaining(['n:exampledb', 'v:5.2']));
    expect(extractEntities('Today we ship', '').strong).toEqual([]);
    expect(eventFingerprint(e)).toMatch(/^[0-9a-f]{32}$/);
    expect(entitiesFromList(e.all)).toEqual(e);
  });

  it('three reports of the same release are one event; another version, or only the product name, is not', () => {
    const a = extractEntities('ExampleDB 5.2 Released With Faster Queries', lead);
    const b = extractEntities('Example DB 5.2 is out: what changed', 'Version 5.2 of Example DB arrives with a rewritten planner.');
    const c = extractEntities('Hands-on with ExampleDB v5.2', 'We tried the new release of ExampleDB this week.');
    expect(sameEvent(a, b)).toBe(true);
    expect(sameEvent(a, c)).toBe(true);
    expect(sameEvent(b, c)).toBe(true);
    expect(sameEvent(a, extractEntities('ExampleDB 5.3 Released', 'ExampleDB 5.3 brings replication.'))).toBe(false);
    expect(sameEvent(a, extractEntities('ExampleDB Raises Funding', 'The company behind the database raised money.'))).toBe(false);
  });
});
