import { afterAll, describe, expect, it } from 'vitest';
import { BUILTIN_THEME, BUILTIN_THEME_ID, RenderPool } from '@heopress/public-site';
import type { PublicItemRow } from '../read-port';
import { buildPage, type PageInput } from '../view-model';

/**
 * The SEO head slot (HeoPress P07 task 1.2; spec seo/page-metadata): the classic engine serialises the head the SEO data
 * layer describes — the canonical, the hreflang alternates, the social metadata and the JSON-LD graph in the rendered
 * HTML are exactly the data layer's objects (`buildPage(...).system.head`), and stay as the snapshot records them.
 */

const HOST = 'head.example.com';
const at = new Date('2026-10-01T08:00:00Z');

const row = (over: Partial<PublicItemRow>): PublicItemRow =>
  ({
    itemId: 'it_post',
    siteId: 'site_head',
    collection: 'articles',
    locale: 'en',
    path: '/hello',
    number: null,
    data: { title: 'Hello <world>', slug: 'hello', excerpt: 'An excerpt & more.', body: '<p>Body.</p>' },
    card: { url: `https://${HOST}/hello/`, image: `https://${HOST}/media/hello.jpg` },
    sponsored: false,
    sponsorName: null,
    publishedAt: at,
    updatedAt: at,
    sanitizer: 1,
    richFields: ['body'],
    seoRobots: null,
    contentHash: null,
    contentModifiedAt: new Date('2026-10-02T09:30:00Z'),
    structured: {},
    ...over,
  }) as PublicItemRow;

const page: PageInput = {
  type: 'item',
  site: {
    name: 'Head Site',
    defaultLanguage: 'en',
    settings: { availableLocales: ['en', 'zh-CN'], siteType: 'blog' },
    identity: { kind: 'organization', name: 'Head Org', sameAs: ['https://social.example.com/head'] } as never,
    origin: `https://${HOST}/`,
  },
  locale: 'en',
  path: '/hello',
  status: 200,
  homeUrl: `https://${HOST}/`,
  item: row({}),
  canonical: `https://${HOST}/hello/`,
  alternates: [
    { locale: 'en', url: `https://${HOST}/hello/` },
    { locale: 'zh-CN', url: `https://${HOST}/zh/hello/` },
    { locale: 'x-default', url: `https://${HOST}/hello/` },
  ],
  related: { category: row({ itemId: 'it_cat', collection: 'categories', path: '/category/news', data: { name: 'News', slug: 'news' }, card: { url: `https://${HOST}/category/news/` } }) },
};

/** What a head says, read back from the HTML. */
function readHead(html: string) {
  const head = /<head>([\s\S]*?)<\/head>/.exec(html)?.[1] ?? '';
  const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  const scripts = [...head.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]!) as unknown);
  return {
    title: unescape(/<title>([^<]*)<\/title>/.exec(head)?.[1] ?? ''),
    canonical: /<link rel="canonical" href="([^"]*)">/.exec(head)?.[1] ?? null,
    robots: /<meta name="robots" content="([^"]*)">/.exec(head)?.[1] ?? null,
    alternates: [...head.matchAll(/<link rel="alternate" hreflang="([^"]*)" href="([^"]*)">/g)].map((m) => ({ locale: m[1]!, url: m[2]! })),
    meta: [...head.matchAll(/<meta (property|name)="([^"]*)" content="([^"]*)">/g)]
      // The theme's own `viewport` aside.
      .filter((m) => m[2] !== 'robots' && m[2] !== 'description' && m[2] !== 'viewport')
      .map((m) => (m[1] === 'property' ? { property: m[2]!, content: unescape(m[3]!) } : { name: m[2]!, content: unescape(m[3]!) })),
    jsonLd: scripts,
  };
}

describe('the SEO head slot (task 1.2)', () => {
  const pool = new RenderPool();
  afterAll(() => pool.close());

  it('an article: canonical, hreflang, social metadata and JSON-LD in the HTML are the data layer\'s objects', async () => {
    const { vm, system } = buildPage(page);
    const head = system.head!;
    const html = await pool.render({ siteId: 'site_head', versionId: BUILTIN_THEME_ID, templates: BUILTIN_THEME, assets: [], entry: 'item', vm, system });
    const read = readHead(html);
    expect(read.title).toBe(head.title);
    expect(read.canonical).toBe(head.canonical);
    expect(read.robots).toBe(head.robots);
    expect(read.alternates).toEqual(head.alternates);
    expect(read.meta).toEqual(head.meta.map((m) => (m.property ? { property: m.property, content: m.content } : { name: m.name, content: m.content })));
    expect(read.jsonLd).toEqual([head.jsonLd]);
    // The image-bearing social metadata (Codex review of batch 12): present, and as the data layer says.
    expect(read.meta).toContainEqual({ property: 'og:image', content: `https://${HOST}/media/hello.jpg` });
    expect(read.meta).toContainEqual({ name: 'twitter:card', content: 'summary_large_image' });
    // As recorded: a change of what the head says is a reviewed change of this snapshot.
    expect(read).toMatchSnapshot();
  });

  it('a page not indexed: no canonical, no alternates; the graph describes the site only — as the data layer says', async () => {
    const hidden = { ...page, item: row({ seoRobots: 'noindex,follow' }) };
    const { vm, system } = buildPage(hidden);
    const head = system.head!;
    const read = readHead(await pool.render({ siteId: 'site_head', versionId: BUILTIN_THEME_ID, templates: BUILTIN_THEME, assets: [], entry: 'item', vm, system }));
    expect(head.canonical).toBeNull();
    expect(read.canonical).toBeNull();
    expect(read.alternates).toEqual([]);
    expect(read.robots).toBe(head.robots);
    expect(read.jsonLd).toEqual([head.jsonLd]);
    expect(read).toMatchSnapshot();
  });
});
