import type { ThemeCard, ThemePageType, ThemeViewModel } from '@heopress/contracts/theme';
import { defaultSeoSettings } from '@heopress/contracts/schemas';
import { decideIndexing, pageHead, type PageHead } from '@heopress/seo-geo';
import type { SystemContent } from './postprocess.ts';

/**
 * Sample page data for every page type (HeoPress P06 tasks 2.4, 2.7): a theme version is rendered with
 * these before publication — a sponsored item and a sponsored card included, hostile strings in titles —
 * and must pass the same post-processing rules as live pages.
 */

const HOST = 'https://sample.example.com';

const card = (id: string, sponsored = false): ThemeCard => ({
  id,
  title: `Sample ${id} </script><img src=x onerror=alert(1)>`,
  excerpt: 'An excerpt with "quotes" & <tags>.',
  url: `${HOST}/${id}/`,
  publishedAt: '2026-10-01T08:00:00.000Z',
  sponsored,
});

function base(type: ThemePageType, over: Partial<ThemeViewModel> = {}): ThemeViewModel {
  return {
    site: { name: 'Sample site', locale: 'en', locales: ['en', 'zh-CN'], homeUrl: `${HOST}/` },
    page: { type, locale: 'en', path: '/', status: type === 'error' ? 404 : 200, query: type === 'search' ? 'sample' : null },
    item: null,
    list: [],
    pagination: null,
    alternates: [],
    nav: [{ label: 'Home', url: `${HOST}/` }],
    seo: { title: 'Sample', description: 'A sample page', canonical: `${HOST}/`, robots: type === 'search' || type === 'error' ? 'noindex' : null },
    ...over,
  };
}

const sponsoredItem = {
  id: 'sample-item',
  collection: 'articles',
  title: 'A sponsored sample </title><script>alert(1)</script>',
  url: `${HOST}/sample-item/`,
  locale: 'en',
  publishedAt: '2026-10-01T08:00:00.000Z',
  fields: { excerpt: 'Excerpt', slug: 'sample-item', tags: ['t1'] },
  sponsor: { sponsored: true, name: 'Acme' },
};

const list = [card('one'), card('two', true), card('three')];
const pagination = { page: 2, prevUrl: `${HOST}/`, nextUrl: `${HOST}/?page=3` };

export function sampleViewModels(): Record<ThemePageType, ThemeViewModel> {
  return {
    home: base('home', { list, pagination }),
    item: base('item', {
      page: { type: 'item', locale: 'en', path: '/sample-item/', status: 200, query: null },
      item: sponsoredItem,
      alternates: [
        { locale: 'en', url: `${HOST}/sample-item/` },
        { locale: 'zh-CN', url: `${HOST}/zh/sample-item/` },
      ],
    }),
    taxonomy: base('taxonomy', {
      page: { type: 'taxonomy', locale: 'en', path: '/category/sample/', status: 200, query: null },
      item: { ...sponsoredItem, id: 'sample-term', collection: 'categories', title: 'Sample category', url: `${HOST}/category/sample/`, sponsor: { sponsored: false, name: null }, fields: { description: 'About it' } },
      list,
      pagination,
    }),
    search: base('search', { list }),
    error: base('error'),
  };
}

export function sampleSystemContent(disclosureRequired: boolean): SystemContent {
  return {
    bodies: { 'sample-item': '<p>Body with <a href="https://elsewhere.example.org/">a link</a>.</p>' },
    disclosureRequired,
    disclosures: { 'sample-item': 'Sponsored by Acme', two: 'Sponsored' },
  };
}

/**
 * The head of each sample page from the SEO data layer (HeoPress P07 task 1.2): hostile strings in the title and
 * description, a social image, language alternates — what the output contract's sample serialises.
 */
export function sampleHead(type: ThemePageType): PageHead {
  const settings = defaultSeoSettings();
  return pageHead({
    settings,
    siteName: 'Sample site',
    pageType: type,
    locale: 'en',
    url: type === 'error' ? null : `${HOST}/${type === 'home' ? '' : 'sample-item/'}`,
    title: type === 'error' ? '404' : type === 'search' ? 'sample' : 'A sample </title><script>alert(1)</script>',
    description: 'A description with "quotes" & <tags>.',
    image: `${HOST}/media/sample.jpg`,
    publishedAt: type === 'item' ? '2026-10-01T08:00:00.000Z' : null,
    indexing: decideIndexing({ settings, pageType: type }),
    alternates: [
      { locale: 'en', url: `${HOST}/sample-item/` },
      { locale: 'zh-CN', url: `${HOST}/zh/sample-item/` },
    ],
  });
}
