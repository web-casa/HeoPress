import { describe, expect, it } from 'vitest';
import { fetchWordPressRest, type WordPressRestResponse } from '../rest';
import { convertWxr } from '../convert';

/**
 * The REST source (v1.1): the same `WxrDocument` as WXR, so the converter and its report are shared. The fake request
 * answers like a WordPress site: pages of posts, pages, categories, tags, users and media.
 */

const BASE = 'https://example.test';

function fakeRequest(pages: Record<string, unknown[][]>, headers: Record<string, number> = {}): (url: string) => Promise<WordPressRestResponse> {
  return async (url) => {
    const parsed = new URL(url);
    const collection = parsed.pathname.split('/').pop()!;
    const page = Number(parsed.searchParams.get('page') ?? '1');
    const body = pages[collection]?.[page - 1] ?? [];
    return { body, totalPages: headers[collection] };
  };
}

const users = [[{ id: 1, name: 'Alice', slug: 'alice' }]];
const categories = [[{ id: 10, name: 'News', slug: 'news' }]];
const tags = [[{ id: 20, name: 'Launch', slug: 'launch' }]];
const posts = [
  [
    {
      id: 101,
      slug: 'hello-world',
      status: 'publish',
      date_gmt: '2026-11-01T10:00:00',
      modified_gmt: '2026-11-02T11:30:00',
      title: { rendered: 'Hello &amp; welcome' },
      content: { rendered: '<p>Body</p>' },
      excerpt: { rendered: '<p>Short</p>' },
      author: 1,
      categories: [10],
      tags: [20],
    },
    { id: 102, slug: 'draft-one', status: 'draft', title: { rendered: 'Draft' }, content: { rendered: '<p>D</p>' } },
  ],
  [{ id: 103, slug: 'second-page', status: 'publish', title: { rendered: 'Second' }, content: { rendered: '<p>S</p>' } }],
];
const pageItems = [[{ id: 201, slug: 'about', status: 'publish', title: { rendered: 'About' }, content: { rendered: '<p>A</p>' } }]];
const media = [[{ id: 301, source_url: 'https://example.test/wp-content/uploads/2026/11/logo.png', media_type: 'image' }]];

describe('fetchWordPressRest', () => {
  it('reads every collection into the WXR document shape and reports what REST cannot give', async () => {
    const { document, report } = await fetchWordPressRest({
      baseUrl: BASE,
      request: fakeRequest({ users, categories, tags, posts, pages: pageItems, media }, { posts: 2 }),
    });
    expect(report.collections).toEqual({ post: 3, page: 1 });
    expect(report.seoNotExposed).toBe(true);
    expect(report.mediaWithoutFile).toBe(0);
    expect(document.authors).toEqual([{ login: 'alice', displayName: 'Alice' }]);
    expect(document.categories).toEqual([{ nicename: 'news', name: 'News' }]);
    expect(document.tags).toEqual([{ nicename: 'launch', name: 'Launch' }]);
    const hello = document.items.find((i) => i.postId === '101')!;
    expect(hello).toMatchObject({ title: 'Hello & welcome', postName: 'hello-world', status: 'publish', creator: 'Alice', content: '<p>Body</p>' });
    expect(hello.terms.map((t) => t.name)).toEqual(['News', 'Launch']);
    expect(document.items.find((i) => i.postId === '102')!.status).toBe('draft');
    expect(document.items.find((i) => i.postId === '201')!.postType).toBe('page');
    expect(document.items.find((i) => i.postId === '301')).toMatchObject({
      postType: 'attachment',
      attachedFile: '2026/11/logo.png',
      attachmentUrl: 'https://example.test/wp-content/uploads/2026/11/logo.png',
    });
  });

  it('feeds the same converter: items, terms and media become bundle records', async () => {
    const { document } = await fetchWordPressRest({
      baseUrl: BASE,
      request: fakeRequest({ users, categories, tags, posts, pages: pageItems, media }, { posts: 2 }),
    });
    const { records, report } = convertWxr(document, {
      sourceSite: 'rest-site',
      defaultLocale: 'en-US',
      permalinkStructure: '/%postname%/',
      readMedia: () => Buffer.from('x'),
      generatedAt: '2026-11-09T00:00:00.000Z',
    });
    const items = records.filter((r) => r.type === 'item') as Array<{ externalId: string; status: string; categories?: string[] }>;
    expect(items.map((i) => i.externalId)).toEqual(['wordpress:rest-site:101', 'wordpress:rest-site:102', 'wordpress:rest-site:103', 'wordpress:rest-site:201']);
    expect(items[0]!.categories).toEqual(['News']);
    expect(records.some((r) => r.type === 'media')).toBe(true);
    // REST does not expose SEO plugin fields: the report says so instead of inventing them.
    expect(report.seo.items).toBe(0);
    expect(report.seo.missing).toEqual(['101', '102', '103', '201']);
  });

  it('reports media whose URL is not under wp-content/uploads', async () => {
    const { report } = await fetchWordPressRest({
      baseUrl: BASE,
      request: fakeRequest({ users, categories, tags, posts, pages: pageItems, media: [[{ id: 302, source_url: 'https://cdn.example.test/x.png' }]] }),
    });
    expect(report.mediaWithoutFile).toBe(1);
  });

  it('refuses an answer that is not a list', async () => {
    await expect(
      fetchWordPressRest({ baseUrl: BASE, request: async () => ({ body: { code: 'rest_no_route' } }) }),
    ).rejects.toThrow(/not a list/);
  });
});
