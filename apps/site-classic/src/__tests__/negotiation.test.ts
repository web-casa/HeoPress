import { describe, expect, it } from 'vitest';
import { defaultSeoSettings } from '@heopress/contracts/schemas';
import { cachedPage, cacheKey, PageCache, type CacheDeps } from '../cache';
import { MARKDOWN_TYPE } from '../discovery';
import { prefersMarkdown, negotiable, negotiatedMarkdown } from '../negotiation';
import type { PublicItemRow } from '../read-port';
import type { PageInput, SiteInfo } from '../view-model';

/**
 * Markdown content negotiation (HeoPress v1.2 P07; spec rendering/markdown-negotiation): the `Accept` rule, the answer a
 * negotiable page gives, and the cache keeping its two representations apart.
 */

const HOST = 'https://a.example.com';

/** The page data of an indexable article page on this host. */
function sample() {
  const site: SiteInfo = { name: 'Site A', defaultLanguage: 'en', settings: {}, seo: defaultSeoSettings() };
  const row = (over: Partial<PublicItemRow> = {}): PublicItemRow => ({
    itemId: 'item-1',
    siteId: 'site-a',
    collection: 'articles',
    locale: 'en',
    path: '/hello',
    number: null,
    data: { title: 'Hello', excerpt: 'An excerpt' },
    card: { url: `${HOST}/hello/`, image: null },
    sponsored: false,
    sponsorName: null,
    publishedAt: new Date('2026-10-01T08:00:00.000Z'),
    updatedAt: new Date('2026-10-02T08:00:00.000Z'),
    sanitizer: 1,
    richFields: [],
    seoRobots: null,
    contentHash: 'hash',
    contentModifiedAt: new Date('2026-10-03T08:00:00.000Z'),
    structured: {},
    renderVersion: 3,
    ...over,
  });
  const page = (over: Partial<PageInput> = {}): PageInput => ({
    type: 'item',
    site,
    locale: 'en',
    path: '/hello/',
    status: 200,
    homeUrl: `${HOST}/`,
    item: row(),
    canonical: `${HOST}/hello/`,
    ...over,
  });
  return { site, row, page };
}

describe('the Accept rule (RFC 9110 media ranges and q-values)', () => {
  const cases: Array<[string | undefined, boolean]> = [
    // Exactly what the backlog's scenarios name.
    ['text/markdown, text/html;q=0.5', true],
    ['text/html;q=0.5, text/markdown;q=0.9', true],
    ['text/markdown', true],
    ['text/markdown;q=0.9', true],
    ['*/*', false],
    // Browsers, HTML-only clients, no header, an empty header.
    ['text/html', false],
    ['text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', false],
    [undefined, false],
    ['', false],
    ['   ', false],
    // Wildcards and ties: the conservative answer is HTML.
    ['text/*', false],
    ['*/*, text/markdown;q=0.5', false],
    ['text/markdown, text/html', false],
    ['text/markdown;q=0.5, text/html;q=0.5', false],
    // A preference that is not a preference.
    ['text/markdown;q=0', false],
    ['text/markdown;q=0, text/html;q=0', false],
    // Markdown is acceptable while HTML is not (no HTML range matches).
    ['application/json, text/markdown;q=0.5', true],
    // Case and other parameters do not change the decision.
    ['TEXT/MARKDOWN', true],
    ['text/markdown; charset=utf-8', true],
    ['Text/Markdown;Charset=UTF-8;Q=0.8, text/html;q=0.4', true],
    ['text/markdown;q="0.9", text/html;q=0.5', true],
    // A malformed q makes that range unusable: never a guess.
    ['text/markdown;q=abc', false],
    ['text/markdown;q=1.5', false],
    ['text/markdown;q=0.1234', false],
    ['text/markdown;q=0.9, text/html;q=0.5', true],
    // The most specific matching range wins, not the greatest q.
    ['text/markdown;q=0.9, text/*;q=0.4, text/html;q=0.8', true],
    ['text/markdown;q=0.1, text/html;q=0.9, */*;q=0.5', false],
  ];
  it.each(cases)('%j → %s', (accept, expected) => {
    expect(prefersMarkdown(accept)).toBe(expected);
  });
});

describe('the negotiated answer', () => {
  it('is the page Markdown with the copy\'s headers plus Vary: Accept', () => {
    const { page, row } = sample();
    const answer = negotiatedMarkdown(page({ item: row({ data: { title: 'Hello', excerpt: 'An excerpt', body: '<h2>Part</h2><p>Hello <strong>world</strong>.</p>' }, richFields: ['body'] }) }));
    expect(answer).not.toBeNull();
    expect(answer!.contentType).toBe('text/markdown; charset=utf-8');
    expect(answer!.headers).toEqual({ 'X-Robots-Tag': 'noindex', Link: `<${HOST}/hello/>; rel="canonical"`, Vary: 'Accept' });
    expect(answer!.body).toMatch(new RegExp(`^# Hello\n\n> An excerpt\n\n- URL: <${HOST.replace(/\./g, '\\.')}/hello/>\n- Published: 2026-10-01T08:00:00\\.000Z\n- Modified: 2026-10-03T08:00:00\\.000Z\n\n## Part\n\nHello \\*\\*world\\*\\*\\.\n$`));
  });

  it('negotiates only an indexable item page canonical to itself', () => {
    const { page, row } = sample();
    expect(negotiatedMarkdown(page())).not.toBeNull();
    expect(negotiable(page())).toBe(true);
    expect(negotiatedMarkdown(page({ item: row({ seoRobots: 'noindex,follow' }) }))).toBeNull();
    expect(negotiatedMarkdown(page({ item: row({ data: { title: 'Hello', canonical_url: 'https://example.org/original/' } }) }))).toBeNull();
    expect(negotiatedMarkdown(page({ type: 'home' }))).toBeNull();
    expect(negotiatedMarkdown(page({ type: 'taxonomy' }))).toBeNull();
    expect(negotiatedMarkdown(page({ item: null }))).toBeNull();
    expect(negotiatedMarkdown(page({ canonical: null }))).toBeNull();
    // A page that is not listed answers one representation only, so it does not vary.
    expect(negotiable(page({ item: row({ seoRobots: 'noindex,follow' }) }))).toBe(false);
  });
});

describe('the cache keeps the two representations apart (v1.2 P07)', () => {
  const deps: CacheDeps = { siteVersion: 1, structureVersion: 1, themeVersion: 't', item: { id: 'item-1', version: 3 } };
  const base = { mode: 'public' as const, siteId: 'site-a', host: 'a.example.com', path: '/hello/', query: new URLSearchParams() };
  const html = cachedPage(200, '<html>Hello</html>', null, { headers: { Vary: 'Accept' } });
  const markdown = cachedPage(200, '# Hello\n', null, { contentType: MARKDOWN_TYPE, headers: { 'X-Robots-Tag': 'noindex', Link: `<${HOST}/hello/>; rel="canonical"`, Vary: 'Accept' } });
  const htmlKey = cacheKey({ ...base, variant: 'html' });
  const markdownKey = cacheKey({ ...base, variant: 'markdown' });

  it('the representation is part of the key', () => {
    expect(htmlKey).not.toBe(markdownKey);
  });

  it('HTML cached first is never served for Markdown', () => {
    const cache = new PageCache({} as never);
    cache.remember(htmlKey, html, deps);
    cache.remember(markdownKey, markdown, deps);
    expect(cache.local(htmlKey)?.page).toEqual(html);
    expect(cache.local(markdownKey)?.page).toEqual(markdown);
    expect(cache.local(markdownKey)?.page.contentType).toBe(MARKDOWN_TYPE);
  });

  it('Markdown cached first is never served for HTML', () => {
    const cache = new PageCache({} as never);
    cache.remember(markdownKey, markdown, deps);
    cache.remember(htmlKey, html, deps);
    expect(cache.local(htmlKey)?.page).toEqual(html);
    expect(cache.local(htmlKey)?.page.contentType).toBe('text/html; charset=utf-8');
    expect(cache.local(markdownKey)?.page).toEqual(markdown);
  });
});
