import { describe, expect, it } from 'vitest';
import { defaultSeoSettings, SiteSeoSettingsSchema, type SiteSeoSettings } from '@heopress/contracts/schemas';
import { applyTemplate, decideIndexing, feedEntry, llmsEntry, pageHead, parseItemRobots, sitemapEntry, type IndexingResult } from '../index';

const settings = (over: Record<string, unknown> = {}): SiteSeoSettings => SiteSeoSettingsSchema.parse(over);

describe('the indexing decision (tasks 2.3, 2.8, 2.11)', () => {
  it('site → page type → collection → the item, then the system limits', () => {
    const s = settings({ index: { site: true, pageTypes: { taxonomy: false }, collections: { categories: true } } });
    expect(decideIndexing({ settings: s, pageType: 'item', collection: 'articles' })).toMatchObject({ indexable: true, decidedBy: 'site' });
    // Tag pages: not indexed by their page type; one tag page indexed on its own.
    expect(decideIndexing({ settings: s, pageType: 'taxonomy', collection: 'tags' })).toMatchObject({ indexable: false, decidedBy: 'page_type', robots: 'noindex' });
    expect(decideIndexing({ settings: s, pageType: 'taxonomy', collection: 'tags', itemRobots: 'index' })).toMatchObject({ indexable: true, decidedBy: 'item' });
    // The collection is more specific than the page type.
    expect(decideIndexing({ settings: s, pageType: 'taxonomy', collection: 'categories' })).toMatchObject({ indexable: true, decidedBy: 'collection' });
    // A site not indexed: everything follows, unless the item says otherwise.
    const closed = settings({ index: { site: false } });
    expect(decideIndexing({ settings: closed, pageType: 'home' }).indexable).toBe(false);
    expect(decideIndexing({ settings: closed, pageType: 'item', itemRobots: 'index' }).indexable).toBe(true);
    // Search results and error pages: never, whatever the settings and the item.
    for (const pageType of ['search', 'error'] as const) {
      expect(decideIndexing({ settings: s, pageType, itemRobots: 'index' })).toMatchObject({ indexable: false, decidedBy: 'system' });
    }
  });

  it('the item setting: the preset default sets nothing; noindex and nofollow are its own', () => {
    expect(parseItemRobots('index,follow')).toEqual({ index: null, follow: null });
    expect(parseItemRobots(undefined)).toEqual({ index: null, follow: null });
    expect(parseItemRobots('noindex,follow')).toEqual({ index: false, follow: true });
    expect(parseItemRobots('index,nofollow')).toEqual({ index: true, follow: false });
    expect(parseItemRobots(' NOINDEX , NOFOLLOW ')).toEqual({ index: false, follow: false });
    const s = settings({ index: { collections: { articles: false } } });
    // The preset default does not override the collection's default.
    expect(decideIndexing({ settings: s, pageType: 'item', collection: 'articles', itemRobots: 'index,follow' }).indexable).toBe(false);
    expect(decideIndexing({ settings: defaultSeoSettings(), pageType: 'item', itemRobots: 'noindex,nofollow' }).robots).toBe('noindex, nofollow');
  });

  it('snippet and preview directives: max-image-preview large by default; noindex wins over them', () => {
    expect(decideIndexing({ settings: defaultSeoSettings(), pageType: 'item' }).robots).toBe('max-image-preview:large');
    const s = settings({ snippet: { maxSnippet: 120, maxImagePreview: 'standard', maxVideoPreview: -1 } });
    expect(decideIndexing({ settings: s, pageType: 'item' }).robots).toBe('max-snippet:120, max-image-preview:standard, max-video-preview:-1');
    expect(decideIndexing({ settings: s, pageType: 'item', itemRobots: 'index,nofollow' }).robots).toBe('nofollow, max-snippet:120, max-image-preview:standard, max-video-preview:-1');
    expect(decideIndexing({ settings: s, pageType: 'item', itemRobots: 'noindex,follow' }).robots).toBe('noindex');
  });
});

const indexed: IndexingResult = decideIndexing({ settings: defaultSeoSettings(), pageType: 'item' });
const notIndexed: IndexingResult = decideIndexing({ settings: defaultSeoSettings(), pageType: 'item', itemRobots: 'noindex,follow' });

describe('the page head (tasks 1.1, 2.1)', () => {
  const base = { settings: defaultSeoSettings(), siteName: 'Site Alpha', locale: 'en', indexing: indexed };

  it('an article: template title, description, absolute self canonical, social metadata', () => {
    const head = pageHead({
      ...base,
      pageType: 'item',
      url: 'https://example.com/2026/10/hello/',
      title: 'Hello',
      description: 'A first post.',
      image: 'https://example.com/media/a.jpg',
      publishedAt: '2026-10-01T00:00:00.000Z',
      modifiedAt: '2026-10-02T00:00:00.000Z',
    });
    expect(head).toMatchObject({ title: 'Hello · Site Alpha', description: 'A first post.', canonical: 'https://example.com/2026/10/hello/', robots: 'max-image-preview:large', xRobotsTag: null });
    expect(head.meta).toEqual([
      { property: 'og:type', content: 'article' },
      { property: 'og:title', content: 'Hello · Site Alpha' },
      { property: 'og:description', content: 'A first post.' },
      { property: 'og:url', content: 'https://example.com/2026/10/hello/' },
      { property: 'og:site_name', content: 'Site Alpha' },
      { property: 'og:locale', content: 'en' },
      { property: 'og:image', content: 'https://example.com/media/a.jpg' },
      { property: 'article:published_time', content: '2026-10-01T00:00:00.000Z' },
      { property: 'article:modified_time', content: '2026-10-02T00:00:00.000Z' },
      { name: 'twitter:card', content: 'summary_large_image' },
    ]);
  });

  it('a list page and the home page: website type, the site name on the home page', () => {
    const list = pageHead({ ...base, pageType: 'taxonomy', url: 'https://example.com/tag/news/?page=2', title: 'News', locale: 'zh-CN' });
    expect(list).toMatchObject({ title: 'News · Site Alpha', canonical: 'https://example.com/tag/news/?page=2' });
    expect(list.meta).toContainEqual({ property: 'og:type', content: 'website' });
    expect(list.meta).toContainEqual({ property: 'og:locale', content: 'zh_CN' });
    expect(pageHead({ ...base, pageType: 'home', url: 'https://example.com/', title: '', locale: 'zh-Hant-TW' }).meta).toContainEqual({ property: 'og:locale', content: 'zh_Hant_TW' });
    const home = pageHead({ ...base, pageType: 'home', url: 'https://example.com/', title: '' });
    expect(home).toMatchObject({ title: 'Site Alpha', description: '', canonical: 'https://example.com/' });
    expect(home.meta).toContainEqual({ name: 'twitter:card', content: 'summary' });
  });

  it('templates: the site\'s own, the item\'s SEO title as a whole, no template around an empty description', () => {
    const s = settings({ titleTemplate: '{site} — {title}', descriptionTemplate: '{description} ({site})' });
    const head = pageHead({ ...base, settings: s, pageType: 'item', url: 'https://example.com/a/', title: 'A', description: 'About A' });
    expect(head).toMatchObject({ title: 'Site Alpha — A', description: 'About A (Site Alpha)' });
    expect(pageHead({ ...base, settings: s, pageType: 'item', url: 'https://example.com/a/', title: 'A', seoTitle: 'The A, explained' }).title).toBe('The A, explained');
    expect(pageHead({ ...base, settings: s, pageType: 'item', url: 'https://example.com/a/', title: 'A', description: '  ' }).description).toBe('');
    expect(applyTemplate('{title} {unknown} {site}', { title: 'T', site: 'S' })).toBe('T {unknown} S');
  });

  it('canonical: the item\'s absolute override; none on a page not indexed, which carries X-Robots-Tag', () => {
    const over = pageHead({ ...base, pageType: 'item', url: 'https://example.com/a/', title: 'A', canonicalUrl: 'https://example.org/original/' });
    expect(over.canonical).toBe('https://example.org/original/');
    for (const bad of ['/relative/', 'javascript:alert(1)', 'ftp://example.org/x', '']) {
      expect(pageHead({ ...base, pageType: 'item', url: 'https://example.com/a/', title: 'A', canonicalUrl: bad }).canonical, bad).toBe('https://example.com/a/');
    }
    const hidden = pageHead({ ...base, indexing: notIndexed, pageType: 'item', url: 'https://example.com/a/', title: 'A', canonicalUrl: 'https://example.org/x/' });
    expect(hidden).toMatchObject({ canonical: null, robots: 'noindex', xRobotsTag: 'noindex' });
    expect(hidden.meta.some((m) => m.property === 'og:url')).toBe(false);
  });
});

describe('discovery entries (task 1.1)', () => {
  const page = { url: 'https://example.com/a/', title: 'A', description: 'About A', publishedAt: '2026-10-01T00:00:00.000Z', modifiedAt: '2026-10-02T00:00:00.000Z', indexing: indexed };

  it('an article is listed with its times; a page not indexed is in none of them', () => {
    expect(sitemapEntry(page)).toEqual({ loc: 'https://example.com/a/', lastmod: '2026-10-02T00:00:00.000Z', alternates: [] });
    expect(feedEntry(page)).toEqual({ id: 'https://example.com/a/', url: 'https://example.com/a/', title: 'A', summary: 'About A', published: '2026-10-01T00:00:00.000Z', updated: '2026-10-02T00:00:00.000Z' });
    expect(llmsEntry(page)).toEqual({ title: 'A', url: 'https://example.com/a/', description: 'About A' });
    for (const entry of [sitemapEntry, feedEntry, llmsEntry]) expect(entry({ ...page, indexing: notIndexed })).toBeNull();
  });

  it('list and home pages: listed without times when they have none; a relative address never', () => {
    const home = { url: 'https://example.com/', title: 'Site Alpha', indexing: decideIndexing({ settings: defaultSeoSettings(), pageType: 'home' }) };
    expect(sitemapEntry(home)).toEqual({ loc: 'https://example.com/', lastmod: null, alternates: [] });
    const tags = decideIndexing({ settings: settings({ index: { pageTypes: { taxonomy: false } } }), pageType: 'taxonomy' });
    expect(sitemapEntry({ url: 'https://example.com/tag/x/', title: 'x', indexing: tags })).toBeNull();
    expect(sitemapEntry({ ...page, url: '/a/' })).toBeNull();
  });
});

describe('list pages in the discovery outputs (task 2.7)', () => {
  it('a search result page is never indexable, so it has no sitemap, feed or llms entry, whatever the settings and the setting of an item', () => {
    for (const s of [settings(), settings({ index: { site: false } })]) {
      const indexing = decideIndexing({ settings: s, pageType: 'search', itemRobots: 'index' });
      expect(indexing.indexable).toBe(false);
      const page = { url: 'https://example.com/search/?q=x', title: 'x', indexing };
      expect([sitemapEntry(page), feedEntry(page), llmsEntry(page)]).toEqual([null, null, null]);
    }
  });
});

describe('a page canonical to another address in the discovery outputs (Codex review of batch 4b)', () => {
  it('is a declared duplicate: no sitemap, feed or llms entry; canonical to itself, it is listed', () => {
    const indexing = decideIndexing({ settings: settings(), pageType: 'item' });
    const page = { url: 'https://example.com/a/', title: 'A', indexing };
    for (const canonical of ['https://example.org/original/', 'https://example.com/b/']) {
      expect([sitemapEntry({ ...page, canonical }), feedEntry({ ...page, canonical }), llmsEntry({ ...page, canonical })]).toEqual([null, null, null]);
    }
    for (const canonical of [undefined, null, 'https://example.com/a/']) {
      expect(sitemapEntry({ ...page, canonical })?.loc).toBe('https://example.com/a/');
      expect(feedEntry({ ...page, canonical })?.url).toBe('https://example.com/a/');
      expect(llmsEntry({ ...page, canonical })?.url).toBe('https://example.com/a/');
    }
  });
});
