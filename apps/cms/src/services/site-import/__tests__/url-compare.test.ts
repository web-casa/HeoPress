import { describe, expect, it } from 'vitest';
import { collectOldUrls, compareUrls, pageFacts, parseUrlList, type FetchAnswer, type PageFetcher } from '../url-compare';

/** HeoPress P12 task 7.3: URL comparison against local fixtures (no network). */

const page = (title: string, canonical: string, alternates: Record<string, string> = {}) =>
  `<!doctype html><html><head><title>${title}</title><link rel="canonical" href="${canonical}">${Object.entries(alternates)
    .map(([l, h]) => `<link rel="alternate" hreflang="${l}" href="${h}">`)
    .join('')}</head><body><h1>${title}</h1><title>not this</title></body></html>`;
const site = (pages: Record<string, FetchAnswer>): PageFetcher => async (url) => pages[new URL(url).pathname] ?? { status: 404, body: 'not found' };

const OLD = site({
  '/blog/post/': { status: 200, body: page('Choosing a VPS', 'https://www.example.com/blog/post/', { en: 'https://www.example.com/blog/post/', 'zh-cn': 'https://www.example.com/zh/blog/post/' }) },
  '/zh/blog/post/': { status: 200, body: page('如何选择 VPS', 'https://www.example.com/zh/blog/post/') },
  '/2021/moved/': { status: 200, body: page('Moved', 'https://www.example.com/2021/moved/') },
  '/about/': { status: 200, body: page('About', 'https://www.example.com/about/') },
  '/gone/': { status: 200, body: page('Gone', 'https://www.example.com/gone/') },
});
const NEW = site({
  '/blog/post/': { status: 200, body: page('Choosing a VPS', 'https://preview.example.com/blog/post/', { en: '/blog/post/', 'zh-CN': '/zh/blog/post/' }) },
  '/zh/blog/post/': { status: 200, body: page('如何选择 VPS', '/zh/blog/post/') },
  '/2021/moved/': { status: 301, location: '/blog/moved/', body: '' },
  '/blog/moved/': { status: 200, body: page('Moved', '/blog/moved/') },
  '/about/': { status: 200, body: page('About us', '/about/') },
});
const URLS = ['/blog/post/', '/zh/blog/post/', '/2021/moved/', '/about/', '/gone/'].map((p) => `https://www.example.com${p}`);

describe('URL comparison (task 7.3)', () => {
  it('spec "旧链接丢失": a 404 without a redirect is reported and the site is not switchable', async () => {
    const r = await compareUrls({ oldUrls: URLS, newBase: 'https://preview.example.com', fetchOld: OLD, fetchNew: NEW });
    expect(r.checked).toBe(5);
    expect(r.differences.map((d) => [d.path, d.kind, d.new])).toEqual([
      ['/about/', 'title', 'About us'],
      ['/gone/', 'status', '404 (no redirect)'],
    ]);
    expect(r.switchable).toBe(false);
    // A page that now answers through a redirect, at its new canonical path, is fine; hreflang compared by path.
    expect(r.pages.find((p) => p.path === '/2021/moved/')!.new.redirects).toEqual(['https://preview.example.com/blog/moved/']);
  });

  it('switchable once every difference is explained (per URL or per kind); an unexplained one keeps it blocked', async () => {
    const partly = await compareUrls({ oldUrls: URLS, newBase: 'https://preview.example.com', fetchOld: OLD, fetchNew: NEW, explanations: { '/about/#title': 'Renamed on purpose' } });
    expect(partly.unexplained).toBe(1);
    expect(partly.switchable).toBe(false);
    const all = await compareUrls({ oldUrls: URLS, newBase: 'https://preview.example.com', fetchOld: OLD, fetchNew: NEW, explanations: { '/about/#title': 'Renamed on purpose', '/gone/': 'Retired page' } });
    expect(all.switchable).toBe(true);
    expect(all.differences.map((d) => d.explained)).toEqual(['Renamed on purpose', 'Retired page']);
  });

  it('canonical and hreflang differences are reported', async () => {
    const bad = site({
      '/blog/post/': { status: 200, body: page('Choosing a VPS', '/blog/other/', { en: '/blog/post/' }) },
    });
    const r = await compareUrls({ oldUrls: [URLS[0]!], newBase: 'https://preview.example.com', fetchOld: OLD, fetchNew: bad });
    expect(r.differences.map((d) => [d.kind, d.old, d.new])).toEqual([
      ['canonical', '/blog/post/', '/blog/other/'],
      ['hreflang', 'zh-cn=/zh/blog/post/', 'zh-cn=(none)'],
    ]);
  });

  it('sitemaps, sitemap indexes and plain lists', async () => {
    expect(parseUrlList('# list\nhttps://www.example.com/a/\n\nhttps://www.example.com/b/')).toEqual({ urls: ['https://www.example.com/a/', 'https://www.example.com/b/'], sitemaps: [] });
    const index = '<?xml version="1.0"?><sitemapindex><sitemap><loc>https://www.example.com/s1.xml</loc></sitemap></sitemapindex>';
    const fetchOld = site({ '/s1.xml': { status: 200, body: '<urlset><url><loc>https://www.example.com/x/?a=1&amp;b=2</loc></url></urlset>' } });
    expect(await collectOldUrls(index, fetchOld)).toEqual(['https://www.example.com/x/?a=1&b=2']);
    expect(pageFacts('<title> A  B </title>')).toEqual({ title: 'A B', canonical: null, hreflang: {} });
  });
});
