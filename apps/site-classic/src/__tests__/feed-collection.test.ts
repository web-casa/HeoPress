import { describe, expect, it } from 'vitest';
import { defaultSeoSettings, type SiteSeoSettings } from '@heopress/contracts/schemas';
import type { PublicExtensionRoute } from '@heopress/contracts/extensions';
import { spaceOf } from '@heopress/public-site';
import { discoveryAnswer, type DiscoveryContext } from '../discovery-plan';
import type { PublicItemRow } from '../read-port';

/**
 * The feed answer over fake reads (HeoPress v1.1 P12): the site feed's collection is configurable, a collection feed
 * addresses `pages` and the collections of the site's plugin routes, and the answer still applies the one indexing
 * decision and the `feeds` switch. The document's serialisation (escaping, ordering, cap) is `discovery.test.ts`'s.
 */

const HOST = 'briefing.example.com';
const ORIGIN = `https://${HOST}`;

function row(collection: string, slug: string, opts: { title?: string; published?: string; robots?: string | null; locale?: string } = {}): PublicItemRow {
  const path = collection === 'articles' ? `/${slug}` : `/${slug}`;
  return {
    itemId: `${collection}-${slug}`,
    siteId: 's1',
    collection,
    locale: opts.locale ?? 'en',
    path,
    number: null,
    data: { title: opts.title ?? `${collection} ${slug}`, excerpt: `${collection} excerpt` },
    card: { url: `${ORIGIN}${path}/`, image: null },
    sponsored: false,
    sponsorName: null,
    publishedAt: new Date(opts.published ?? '2026-11-10T08:00:00.000Z'),
    updatedAt: new Date('2026-11-10T08:00:00.000Z'),
    sanitizer: 1,
    richFields: [],
    seoRobots: opts.robots ?? null,
    contentHash: null,
    contentModifiedAt: null,
    structured: {},
    renderVersion: 1,
  };
}

function route(collection: string, title: string): PublicExtensionRoute {
  return { namespace: 'heopress_briefing_daily', id: collection, kind: 'list', path: `/${collection}`, collection, template: 'index', title, pageSize: 20, sitemap: true, llms: true };
}

function context(
  rows: PublicItemRow[],
  opts: { routes?: PublicExtensionRoute[]; feedCollection?: string; feeds?: boolean; locales?: string[]; queryFiltersNoindex?: boolean } = {},
) {
  const calls: Array<{ collection: string; locale: string; offset: number; limit: number }> = [];
  const queryFilters = opts.queryFiltersNoindex ?? true;
  const reads = {
    hosts: async () => [HOST],
    // The database's read: the collection and language, the indexable filter, newest first.
    latest: async (locale: string, collection: string, o: { offset: number; limit: number; listable: { defaultIndexable: boolean } }) => {
      calls.push({ collection, locale, offset: o.offset, limit: o.limit });
      if (!o.listable.defaultIndexable) return [];
      return rows
        .filter((r) => r.collection === collection && r.locale === locale)
        .filter((r) => !queryFilters || !/noindex/i.test(r.seoRobots ?? ''))
        .sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0) || a.itemId.localeCompare(b.itemId))
        .slice(o.offset, o.offset + o.limit);
    },
    itemsByIds: async (ids: string[]) => ids.flatMap((id) => rows.filter((r) => r.itemId === id)),
  } as unknown as DiscoveryContext['reads'];
  const base = defaultSeoSettings();
  const seo: SiteSeoSettings = {
    ...base,
    discovery: { ...base.discovery, feeds: opts.feeds ?? true, feedCollection: opts.feedCollection ?? 'articles' },
  };
  const availableLocales = opts.locales ?? ['en'];
  const site = {
    name: 'Briefing Site',
    defaultLanguage: 'en',
    settings: { availableLocales },
    seo,
    extensions: { hash: 'h', routes: opts.routes ?? [], classic: {}, astro: {} },
  };
  const space = spaceOf('s1', 'en', { availableLocales } as never, [{ hostname: HOST, locale: null, isPrimary: true }]);
  return { calls, ctx: { reads, site, host: HOST, space, now: Date.UTC(2026, 10, 10, 12) } as unknown as DiscoveryContext };
}

const briefings = [route('heopress_briefing_daily__briefings', 'Briefing')];

describe('the site feed follows discovery.feedCollection', () => {
  it('defaults to articles', async () => {
    const { ctx } = context([row('articles', 'a1', { title: 'Article one' }), row('heopress_briefing_daily__briefings', 'b1', { title: 'Briefing one' })], { routes: briefings });
    const rss = (await discoveryAnswer({ kind: 'feed', format: 'rss', collection: null, locale: null }, ctx))!;
    expect(rss.contentType).toBe('application/rss+xml; charset=utf-8');
    expect(rss.body).toContain(`${ORIGIN}/a1/`);
    expect(rss.body).not.toContain(`${ORIGIN}/b1/`);
  });

  it('lists the configured collection instead', async () => {
    const { ctx } = context([row('articles', 'a1', { title: 'Article one' }), row('heopress_briefing_daily__briefings', 'b1', { title: 'Briefing one' })], {
      routes: briefings,
      feedCollection: 'heopress_briefing_daily__briefings',
    });
    const rss = (await discoveryAnswer({ kind: 'feed', format: 'rss', collection: null, locale: null }, ctx))!;
    expect(rss.body).toContain(`${ORIGIN}/b1/`);
    expect(rss.body).not.toContain(`${ORIGIN}/a1/`);
    // The site feed's collection has one address: it is not repeated as a collection feed.
    expect(await discoveryAnswer({ kind: 'feed', format: 'rss', collection: 'heopress_briefing_daily__briefings', locale: null }, ctx)).toBeNull();
    expect(await discoveryAnswer({ kind: 'feed', format: 'rss', collection: 'briefings', locale: null }, ctx)).toBeNull();
  });
});

describe('collection feeds: pages and plugin collections', () => {
  it('a plugin collection is addressed by its local name; the machine name is not a second address', async () => {
    const { ctx } = context([row('heopress_briefing_daily__briefings', 'b1', { title: 'Briefing one' })], { routes: briefings });
    const rss = (await discoveryAnswer({ kind: 'feed', format: 'rss', collection: 'briefings', locale: null }, ctx))!;
    expect(rss.body).toContain(`${ORIGIN}/b1/`);
    expect(rss.body).toContain('<title>Briefing Site · Briefing</title>');
    // One address per feed: the machine name does not answer when the local name is the address.
    expect(await discoveryAnswer({ kind: 'feed', format: 'rss', collection: 'heopress_briefing_daily__briefings', locale: null }, ctx)).toBeNull();
    // The atom format follows, with its own self address.
    const atom = (await discoveryAnswer({ kind: 'feed', format: 'atom', collection: 'briefings', locale: null }, ctx))!;
    expect(atom.contentType).toBe('application/atom+xml; charset=utf-8');
    expect(atom.body).toContain(`<id>${ORIGIN}/atom/briefings.xml</id>`);
  });

  it('a local name two plugins share is ambiguous: only the machine names answer', async () => {
    const routes = [
      { ...route('acme__terms', 'Terms'), namespace: 'acme' },
      { ...route('beta__terms', 'Terms'), namespace: 'beta' },
    ];
    const { ctx } = context([row('acme__terms', 'a', { title: 'Acme term' }), row('beta__terms', 'b', { title: 'Beta term' })], { routes });
    expect(await discoveryAnswer({ kind: 'feed', format: 'rss', collection: 'terms', locale: null }, ctx)).toBeNull();
    expect((await discoveryAnswer({ kind: 'feed', format: 'rss', collection: 'acme__terms', locale: null }, ctx))!.body).toContain(`${ORIGIN}/a/`);
    expect((await discoveryAnswer({ kind: 'feed', format: 'rss', collection: 'beta__terms', locale: null }, ctx))!.body).toContain(`${ORIGIN}/b/`);
  });

  it('pages keeps its collection feed; an unknown collection is not one', async () => {
    const { ctx } = context([row('pages', 'about', { title: 'About' }), row('users', 'u1', { title: 'A user' })]);
    expect((await discoveryAnswer({ kind: 'feed', format: 'rss', collection: 'pages', locale: null }, ctx))!.body).toContain(`${ORIGIN}/about/`);
    expect(await discoveryAnswer({ kind: 'feed', format: 'rss', collection: 'users', locale: null }, ctx)).toBeNull();
    expect(await discoveryAnswer({ kind: 'feed', format: 'rss', collection: 'articles', locale: null }, ctx)).toBeNull();
  });

  it('another language: the language is exact, the collection is the same', async () => {
    const { ctx } = context([row('heopress_briefing_daily__briefings', 'b1', { title: 'English' }), row('heopress_briefing_daily__briefings', 'b2', { title: '中文', locale: 'zh-CN' })], {
      routes: briefings,
      locales: ['en', 'zh-CN'],
    });
    expect((await discoveryAnswer({ kind: 'feed', format: 'rss', collection: 'briefings', locale: 'zh-CN' }, ctx))!.body).toContain('中文');
    expect(await discoveryAnswer({ kind: 'feed', format: 'rss', collection: 'briefings', locale: 'zh-cn' }, ctx)).toBeNull();
    expect(await discoveryAnswer({ kind: 'feed', format: 'rss', collection: 'briefings', locale: 'en' }, ctx)).toBeNull();
  });
});

describe('indexing and the feeds switch', () => {
  it('noindex and draft entries are absent; the published one is there', async () => {
    const { ctx } = context(
      [
        row('heopress_briefing_daily__briefings', 'published', { title: 'Published briefing', published: '2026-11-10T09:00:00.000Z' }),
        row('heopress_briefing_daily__briefings', 'hidden', { title: 'Hidden briefing', robots: 'noindex,follow', published: '2026-11-10T10:00:00.000Z' }),
      ],
      { routes: briefings },
    );
    const rss = (await discoveryAnswer({ kind: 'feed', format: 'rss', collection: 'briefings', locale: null }, ctx))!;
    expect(rss.body).toContain('Published briefing');
    expect(rss.body).not.toContain('Hidden briefing');
    // A draft never reaches the public projection, so the read does not return it either; the feed stays a valid empty channel.
    expect((await discoveryAnswer({ kind: 'feed', format: 'rss', collection: 'briefings', locale: null }, context([], { routes: briefings }).ctx))!.body).toContain('<channel>');
  });

  it('the entry decision excludes noindex even when a read returns such a row (defence in depth)', async () => {
    // The database read filters noindex already; the answer must not trust that alone, because a new read path or a
    // projection change must not silently leak a noindex item into the feed.
    const { ctx } = context([row('heopress_briefing_daily__briefings', 'hidden', { title: 'Hidden briefing', robots: 'noindex,follow' })], {
      routes: briefings,
      queryFiltersNoindex: false,
    });
    const rss = (await discoveryAnswer({ kind: 'feed', format: 'rss', collection: 'briefings', locale: null }, ctx))!;
    expect(rss.body).not.toContain('Hidden briefing');
    expect(rss.body).not.toContain(`${ORIGIN}/hidden/`);
  });

  it('feeds off: every feed is not found, not empty', async () => {
    const { ctx } = context([row('heopress_briefing_daily__briefings', 'b1', { title: 'Briefing one' })], { routes: briefings, feeds: false });
    for (const file of [
      { kind: 'feed', format: 'rss', collection: null, locale: null },
      { kind: 'feed', format: 'atom', collection: null, locale: null },
      { kind: 'feed', format: 'rss', collection: 'briefings', locale: null },
      { kind: 'feed', format: 'atom', collection: 'pages', locale: null },
    ] as const) {
      expect(await discoveryAnswer(file, ctx), JSON.stringify(file)).toBeNull();
    }
  });

  it('newest first and at most twenty entries', async () => {
    const rows = Array.from({ length: 25 }, (_, i) =>
      row('heopress_briefing_daily__briefings', `b${String(i).padStart(2, '0')}`, { title: `Briefing ${i}`, published: `2026-11-10T${String(i).padStart(2, '0')}:00:00.000Z` }),
    );
    const { ctx } = context(rows, { routes: briefings });
    const rss = (await discoveryAnswer({ kind: 'feed', format: 'rss', collection: 'briefings', locale: null }, ctx))!;
    const titles = [...rss.body.matchAll(/<item><title>([^<]+)<\/title><link>([^<]+)<\/link>/g)].map((m) => [m[1], m[2]] as const);
    expect(titles).toHaveLength(20);
    expect(titles[0]).toEqual(['Briefing 24', `${ORIGIN}/b24/`]);
    expect(titles[19]).toEqual(['Briefing 5', `${ORIGIN}/b05/`]);
  });
});
