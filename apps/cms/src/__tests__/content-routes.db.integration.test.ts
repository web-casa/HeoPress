import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { auditLog, cdcChangeEvents, collections, contentRoutes, items, redirects, siteContentSettings, sites, systemState, type Database } from '@heopress/database';
import { ItemService } from '../services/item-service';
import { sweepDuePublish } from '../services/scheduler-worker';
import { ContentSettingsService } from '../services/site-network/content-settings-service';
import { upgradeSitePreset } from '../services/site-network/preset-installer';
import { readAdminSegment } from '../services/site-network/reserved-paths';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';

/**
 * Content routes and redirects (HeoPress P05 tasks 1.3, 1.6; spec
 * content/site-network-model "固定链接"): paths from per-collection
 * patterns, unique per site and language (409 naming the occupant), a 301
 * when a published item's path moves — chains flattened to one hop, no
 * loops —, paths freed on delete, rebuilt (all or nothing) when a pattern,
 * the time zone or a category's slug changes, kept clear of language
 * prefixes; scheduled publishing records the first publish time and an
 * item that cannot be published is skipped and recorded; item numbers.
 */

const SITE = 'site_p05_routes_it';
const OWNER_URL = process.env.DATABASE_OWNER_URL?.trim() || undefined;

describe.skipIf(!hasDbIntegrationUrl)('content routes — DB integration', () => {
  let db: Database;

  beforeAll(async () => {
    db = await connectDbIntegration('content-routes');
  });
  beforeEach(async () => {
    await db.delete(sites).where(eq(sites.id, SITE));
    await db.insert(sites).values({ id: SITE, name: 'Routes', defaultLanguage: 'en' });
    await upgradeSitePreset(db, SITE);
    await settings({ permalinks: { articles: '/:year/:month/:day/:slug', pages: '/:slug', categories: '/category/:slug' }, availableLocales: ['en', 'zh-CN'] });
  });
  afterAll(async () => {
    await db?.delete(sites).where(eq(sites.id, SITE));
  });

  const svc = () => new ItemService({ db, siteId: SITE });
  const contentSettings = () => new ContentSettingsService({ db, siteId: SITE, actor: { userId: null } });
  async function settings(over: Record<string, unknown>) {
    const [r] = await db.select().from(siteContentSettings).where(eq(siteContentSettings.siteId, SITE));
    return contentSettings().update({
      availableLocales: r!.availableLocales,
      timezone: r!.timezone,
      siteType: 'blog',
      trailingSlash: r!.trailingSlash as 'always',
      localeStrategy: r!.localeStrategy as 'subdirectory',
      localePrefixMode: r!.localePrefixMode as 'default_at_root',
      localePrefixes: r!.localePrefixes,
      permalinks: r!.permalinks,
      allowCrossSiteTranslations: false,
      sponsorDisclosure: true,
      sponsorRel: true,
      version: r!.version,
      ...over,
    } as never);
  }
  const article = (slug: string, extra: Record<string, unknown> = {}, status = 'published') =>
    svc().create('articles', { data: { title: slug, slug, locale: 'en', ...extra }, status }) as Promise<{ id: string; version: number }>;
  const routeOf = async (id: string) => (await db.select().from(contentRoutes).where(eq(contentRoutes.itemId, id)))[0] ?? null;
  const rules = async () =>
    (await db.select().from(redirects).where(eq(redirects.siteId, SITE))).map((r) => `${r.locale}:${r.fromPath} -> ${r.toLocale}:${r.toPath}`).sort();
  const codeOf = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code ?? String(e));

  /** Wait until `n` sessions of this database wait on a lock (seen from the owner connection). */
  const waiting = async (sql: postgres.Sql | postgres.TransactionSql, n: number) => {
    let queued = 0;
    for (let i = 0; i < 100 && queued < n; i++) {
      const [r] = await sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()`;
      queued = r!.n;
      if (queued < n) await new Promise((res) => setTimeout(res, 50));
    }
    if (queued < n) throw new Error(`only ${queued} of ${n} writes queued`);
  };
  const routeLockKey = `heopress:routes:${SITE}`;

  it('a slug that cannot be a path segment is refused; a published item needs its path', async () => {
    expect(await codeOf(article('a/b'))).toBe('INVALID_SLUG');
    expect(await codeOf(article('a?b', {}, 'draft'))).toBe('INVALID_SLUG');
    expect(await codeOf(article('   '))).toBe('PATH_REQUIRED');
    const draft = await article('   ', {}, 'draft');
    expect(await routeOf(draft.id)).toBeNull();
    const live = await article('fine');
    const path = (await routeOf(live.id))!.path;
    expect(await codeOf(svc().patch('articles', live.id, { data: { slug: 'x#y' }, expectedVersion: live.version }))).toBe('INVALID_SLUG');
    expect(await codeOf(svc().patch('articles', live.id, { data: { slug: ' ' }, expectedVersion: live.version }))).toBe('PATH_REQUIRED');
    expect(await routeOf(live.id)).toMatchObject({ path });
    expect(await codeOf(svc().create('pages', { data: { title: 'u', slug: '_private', locale: 'en' } }))).toBe('PATH_RESERVED');
  });

  it.skipIf(!OWNER_URL)('two items swapping paths queue on the site\'s route lock and both get a 409 — no deadlock', async () => {
    await settings({ permalinks: { pages: '/:slug' } });
    const a = (await svc().create('pages', { data: { title: 'A', slug: 'a', locale: 'en' } })) as { id: string; version: number };
    const b = (await svc().create('pages', { data: { title: 'B', slug: 'b', locale: 'en' } })) as { id: string; version: number };
    const owner = postgres(OWNER_URL!, { max: 1, onnotice: () => {} });
    try {
      // Hold the route lock: both writes must queue on it (without it they interleave and can deadlock on the unique key).
      await owner`SELECT pg_advisory_lock(hashtextextended(${routeLockKey}, 0))`;
      const toB = codeOf(svc().patch('pages', a.id, { data: { slug: 'b' }, expectedVersion: a.version }));
      const toA = codeOf(svc().patch('pages', b.id, { data: { slug: 'a' }, expectedVersion: b.version }));
      await waiting(owner, 2);
      await owner`SELECT pg_advisory_unlock(hashtextextended(${routeLockKey}, 0))`;
      expect([await toB, await toA]).toEqual(['PATH_TAKEN', 'PATH_TAKEN']);
    } finally {
      await owner.end({ timeout: 1 });
    }
    expect(await routeOf(a.id)).toMatchObject({ path: '/a' });
    expect(await routeOf(b.id)).toMatchObject({ path: '/b' });
  });

  it.skipIf(!OWNER_URL)('a hard delete waits for a settings change (a running rebuild) instead of pulling items from under it', async () => {
    const a = await article('gone');
    const owner = postgres(OWNER_URL!, { max: 1, onnotice: () => {} });
    try {
      let deleted: Promise<unknown> | undefined;
      await owner.begin(async (sql) => {
        await sql`SELECT 1 FROM lumibase_site_content_settings WHERE site_id = ${SITE} FOR UPDATE`;
        deleted = svc().hardDelete('articles', a.id);
        await waiting(sql, 1);
      });
      expect(await deleted!).toBe(true);
    } finally {
      await owner.end({ timeout: 1 });
    }
  });

  it('collections swapping patterns: the redirects come from the state before, as one set — no self-loop, chains retargeted', async () => {
    await settings({ permalinks: { articles: '/a/:slug', pages: '/b/:slug', categories: '/category/:slug' } });
    const art = await article('s0');
    await svc().patch('articles', art.id, { data: { slug: 's' }, expectedVersion: art.version });
    const page = (await svc().create('pages', { data: { title: 'P', slug: 's', locale: 'en' }, status: 'published' })) as { id: string };
    // A page renamed u → v (rule /b/u → /b/v), and a draft article u, which will take /b/u.
    const renamed = (await svc().create('pages', { data: { title: 'U', slug: 'u', locale: 'en' }, status: 'published' })) as { id: string; version: number };
    await svc().patch('pages', renamed.id, { data: { slug: 'v' }, expectedVersion: renamed.version });
    const draft = await article('u', {}, 'draft');
    expect(await rules()).toEqual(['en:/a/s0 -> en:/a/s', 'en:/b/u -> en:/b/v']);
    await settings({ permalinks: { articles: '/b/:slug', pages: '/a/:slug', categories: '/category/:slug' } });
    expect(await routeOf(art.id)).toMatchObject({ path: '/b/s' });
    expect(await routeOf(page.id)).toMatchObject({ path: '/a/s' });
    expect(await routeOf(draft.id)).toMatchObject({ path: '/b/u' });
    // /a/s and /b/s are held again (by the other item) and /b/u by the draft: no rule from them; the chains follow.
    expect(await rules()).toEqual(['en:/a/s0 -> en:/b/s', 'en:/b/v -> en:/a/v']);
  });

  it('a category slug a before hook sets moves the articles too', async () => {
    await settings({ permalinks: { articles: '/:category/:slug', pages: '/:slug', categories: '/category/:slug' } });
    const cat = (await svc().create('categories', { data: { name: 'Guides', slug: 'guides' }, status: 'published' })) as { id: string; version: number };
    const a = await article('setup', { primary_category: cat.id });
    // The request only renames the category; an extension's before hook changes its slug.
    const service = svc();
    (service as unknown as { getHookDispatcher: () => Promise<unknown> }).getHookDispatcher = async () => ({
      dispatch: async (event: string, ctx: Record<string, unknown>) => (event === 'items.update.before' ? { ...ctx, patch: { slug: 'how-to' } } : ctx),
    });
    await service.patch('categories', cat.id, { data: { name: 'How-to' }, expectedVersion: cat.version });
    expect(await routeOf(a.id)).toMatchObject({ path: '/how-to/setup' });
  });

  it('a rebuild keeps languages apart: same paths in two languages, each chain follows its own item', async () => {
    await settings({ permalinks: { articles: '/a/:slug', pages: '/:slug', categories: '/category/:slug' } });
    const en = await article('s0');
    const zh = await article('s0', { locale: 'zh-CN' });
    await svc().patch('articles', en.id, { data: { slug: 's' }, expectedVersion: en.version });
    await svc().patch('articles', zh.id, { data: { slug: 's' }, expectedVersion: zh.version });
    expect(await rules()).toEqual(['en:/a/s0 -> en:/a/s', 'zh-CN:/a/s0 -> zh-CN:/a/s']);
    await settings({ permalinks: { articles: '/b/:slug', pages: '/:slug', categories: '/category/:slug' } });
    expect(await routeOf(zh.id)).toMatchObject({ locale: 'zh-CN', path: '/b/s' });
    expect(await rules()).toEqual(['en:/a/s -> en:/b/s', 'en:/a/s0 -> en:/b/s', 'zh-CN:/a/s -> zh-CN:/b/s', 'zh-CN:/a/s0 -> zh-CN:/b/s']);
  });

  it('a rebuild past one write chunk (1,001 moved articles, each with an old rule) moves them all', async () => {
    await settings({ permalinks: { articles: '/a/:slug', pages: '/:slug', categories: '/category/:slug' } });
    const [coll] = await db.select({ id: collections.id }).from(collections).where(and(eq(collections.siteId, SITE), eq(collections.name, 'articles')));
    const N = 1001;
    const rows = Array.from({ length: N }, (_, i) => ({
      id: `bulk-${i}`,
      siteId: SITE,
      collectionId: coll!.id,
      data: { title: `t${i}`, slug: `s${i}`, locale: 'en' },
      status: 'published',
      number: 10_000 + i,
      publishedAt: new Date(),
      publishedAtSource: 'recorded',
    }));
    for (let i = 0; i < N; i += 500) {
      await db.insert(items).values(rows.slice(i, i + 500));
      await db.insert(contentRoutes).values(rows.slice(i, i + 500).map((r, j) => ({ siteId: SITE, itemId: r.id, collectionId: coll!.id, locale: 'en', path: `/a/s${i + j}` })));
      await db.insert(redirects).values(rows.slice(i, i + 500).map((_, j) => ({ siteId: SITE, scope: 'content', locale: 'en', fromPath: `/old/${i + j}`, match: 'exact', toPath: `/a/s${i + j}`, toLocale: 'en', source: 'slug_change' })));
    }
    await settings({ permalinks: { articles: '/b/:slug', pages: '/:slug', categories: '/category/:slug' } });
    const routes = await db.select().from(contentRoutes).where(eq(contentRoutes.siteId, SITE));
    expect(routes.filter((r) => r.path.startsWith('/b/'))).toHaveLength(N);
    const all = await db.select().from(redirects).where(eq(redirects.siteId, SITE));
    expect(all).toHaveLength(2 * N);
    expect(all.every((r) => r.toPath.startsWith('/b/'))).toBe(true);
    expect(all.find((r) => r.fromPath === '/old/1000')).toMatchObject({ toPath: '/b/s1000' });
  });

  it('a first publish time whose date path is taken is refused: date, version and audit unchanged', async () => {
    await settings({ permalinks: { articles: '/:year/:slug', pages: '/:slug', categories: '/category/:slug' } });
    const holder = (await svc().create('articles', { data: { title: 'h', slug: 'same', locale: 'en' }, status: 'published', publishedAt: new Date('2019-05-05T00:00:00Z') })) as { id: string };
    void holder;
    const mover = await article('same');
    const before = (await db.select().from(items).where(eq(items.id, mover.id)))[0]!;
    expect(await codeOf(svc().setPublishedAt('articles', mover.id, { publishedAt: new Date('2019-06-01T00:00:00Z'), expectedVersion: mover.version }))).toBe('PATH_TAKEN');
    const after = (await db.select().from(items).where(eq(items.id, mover.id)))[0]!;
    expect(after).toMatchObject({ version: before.version, publishedAtSource: 'recorded' });
    expect(after.publishedAt!.getTime()).toBe(before.publishedAt!.getTime());
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.siteId, SITE), eq(auditLog.event, 'item_published_at_set')));
    expect(audits.map((a) => (a.metadata as { itemId: string }).itemId)).not.toContain(mover.id);
  });

  it('the admin path is read from the instance state (in a transaction rolled back after)', async () => {
    const rolledBack = new Error('rollback');
    const seen = await db
      .transaction(async (tx) => {
        await tx.insert(systemState).values({ id: 'singleton', adminPath: '/routes-admin-it' }).onConflictDoUpdate({ target: systemState.id, set: { adminPath: '/routes-admin-it/x' } });
        const segment = await readAdminSegment(tx as never);
        throw Object.assign(rolledBack, { segment });
      })
      .catch((e: { segment?: string }) => e.segment);
    expect(seen).toBe('routes-admin-it');
  });

  it('switching to the subdirectory strategy checks every prefix against existing paths', async () => {
    await settings({ localeStrategy: 'domain', localePrefixes: { 'zh-CN': 'zh' } });
    await svc().create('pages', { data: { title: 'Zh', slug: 'zh', locale: 'en' } });
    expect(await codeOf(settings({ localeStrategy: 'subdirectory' }))).toBe('PREFIX_CONFLICT');
  });

  it('an administrator sets or confirms the first publish time: audited, and a live item\'s date path moves with a 301', async () => {
    const imported = (await svc().create('articles', { data: { title: 'WP', slug: 'wp-post', locale: 'en' }, status: 'published', publishedAt: new Date('2019-01-05T08:00:00Z') })) as { id: string };
    let row = (await db.select().from(items).where(eq(items.id, imported.id)))[0]!;
    expect(row).toMatchObject({ publishedAtSource: 'set' });
    expect(await routeOf(imported.id)).toMatchObject({ path: '/2019/01/05/wp-post' });

    const live = await article('dated');
    const before = (await routeOf(live.id))!.path;
    const set = await svc().setPublishedAt('articles', live.id, { publishedAt: new Date('2018-02-03T12:00:00Z'), expectedVersion: live.version });
    expect(set).toMatchObject({ publishedAtSource: 'set', version: live.version + 1 });
    expect(await routeOf(live.id)).toMatchObject({ path: '/2018/02/03/dated' });
    expect(await rules()).toEqual([`en:${before} -> en:/2018/02/03/dated`]);
    expect(await codeOf(svc().setPublishedAt('articles', live.id, { publishedAt: null, expectedVersion: live.version }))).toBe('VERSION_CONFLICT');

    const old = await article('estimated-one', {}, 'draft');
    await db.update(items).set({ publishedAtSource: 'unknown', createdAt: new Date('2017-07-07T00:00:00Z') }).where(eq(items.id, old.id));
    const pub = (await svc().patch('articles', old.id, { status: 'published', expectedVersion: old.version })) as { version: number };
    await svc().setPublishedAt('articles', old.id, { publishedAt: null, expectedVersion: pub.version });
    row = (await db.select().from(items).where(eq(items.id, old.id)))[0]!;
    expect(row).toMatchObject({ publishedAtSource: 'set' });
    expect(row.publishedAt!.toISOString()).toBe('2017-07-07T00:00:00.000Z');
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.siteId, SITE), eq(auditLog.event, 'item_published_at_set')));
    expect(audits).toHaveLength(3);
  });

  it('items get their paths; a page and an article cannot share one; other languages are separate', async () => {
    const a = await article('hello');
    const today = new Date();
    const ymd = `/${today.getUTCFullYear()}/${String(today.getUTCMonth() + 1).padStart(2, '0')}/${String(today.getUTCDate()).padStart(2, '0')}`;
    expect(await routeOf(a.id)).toMatchObject({ locale: 'en', path: `${ymd}/hello` });
    const page = (await svc().create('pages', { data: { title: 'About', slug: 'about', locale: 'en' } })) as { id: string };
    expect(await routeOf(page.id)).toMatchObject({ path: '/about' });
    // Drafts hold their path too.
    const err = await svc().create('pages', { data: { title: 'About 2', slug: 'about', locale: 'en' } }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'PATH_TAKEN', status: 409 });
    expect(String((err as Error).message)).toContain(page.id);
    const zh = (await svc().create('pages', { data: { title: '关于', slug: 'about', locale: 'zh-CN' } })) as { id: string };
    expect(await routeOf(zh.id)).toMatchObject({ locale: 'zh-CN', path: '/about' });
  });

  it('a published item\'s new slug leaves a 301 from the old path; chains stay one hop; going back leaves no loop', async () => {
    await settings({ permalinks: { pages: '/:slug' } });
    const p = (await svc().create('pages', { data: { title: 'P', slug: 'old', locale: 'en' }, status: 'published' })) as { id: string; version: number };
    let v = p.version;
    const rename = async (slug: string) => {
      const r = (await svc().patch('pages', p.id, { data: { slug }, expectedVersion: v })) as { version: number };
      v = r.version;
    };
    await rename('mid');
    expect(await rules()).toEqual(['en:/old -> en:/mid']);
    await rename('new');
    expect(await rules()).toEqual(['en:/mid -> en:/new', 'en:/old -> en:/new']);
    await rename('old');
    expect(await rules()).toEqual(['en:/mid -> en:/old', 'en:/new -> en:/old']);
    expect(await routeOf(p.id)).toMatchObject({ path: '/old' });
    // A new item at a redirected path answers there: the rule from it goes.
    await svc().create('pages', { data: { title: 'M', slug: 'mid', locale: 'en' } });
    expect(await rules()).toEqual(['en:/new -> en:/old']);
  });

  it('a draft\'s slug change leaves no redirect; deleting an item frees its path', async () => {
    await settings({ permalinks: { pages: '/:slug' } });
    const d = (await svc().create('pages', { data: { title: 'D', slug: 'draft-a', locale: 'en' } })) as { id: string; version: number };
    await svc().patch('pages', d.id, { data: { slug: 'draft-b' }, expectedVersion: d.version });
    expect(await rules()).toEqual([]);
    await svc().softDelete('pages', d.id);
    expect(await routeOf(d.id)).toBeNull();
    expect(await codeOf(svc().create('pages', { data: { title: 'D2', slug: 'draft-b', locale: 'en' } }))).toBe('ok');
  });

  it('numbers: one per item and collection, in order; a numeric pattern without a trailing slash', async () => {
    await settings({ permalinks: { articles: '/:id', pages: '/:slug' }, trailingSlash: 'never' });
    const first = await article('one');
    const second = await article('two');
    const rows = await db.select({ id: items.id, number: items.number }).from(items).where(and(eq(items.siteId, SITE)));
    const n = (id: string) => rows.find((r) => r.id === id)!.number!;
    expect(n(second.id)).toBe(n(first.id) + 1);
    expect(await routeOf(second.id)).toMatchObject({ path: `/${n(second.id)}` });
    const bulk = await svc().bulk('articles', 'create', [{ title: 'b1', slug: 'b1', locale: 'en' }, { title: 'b2', slug: 'b2', locale: 'en' }]);
    const all = await db.select({ id: items.id, number: items.number }).from(items).where(eq(items.siteId, SITE));
    const bn = bulk.map((r) => all.find((x) => x.id === r.id)!.number!);
    expect(bn).toEqual([n(second.id) + 1, n(second.id) + 2]);
  });

  it('a pattern change moves the paths of the collection — all or nothing — and live items leave their 301s', async () => {
    const a = await article('moving');
    const draft = await article('quiet', {}, 'draft');
    const before = (await routeOf(a.id))!.path;
    await settings({ permalinks: { articles: '/news/:slug', pages: '/:slug', categories: '/category/:slug' } });
    expect(await routeOf(a.id)).toMatchObject({ path: '/news/moving' });
    expect(await routeOf(draft.id)).toMatchObject({ path: '/news/quiet' });
    expect(await rules()).toEqual([`en:${before} -> en:/news/moving`]);
    // Renderers learn which addresses moved: a route event per moved item (design H).
    const routeEvents = await db.select().from(cdcChangeEvents).where(and(eq(cdcChangeEvents.siteId, SITE), eq(cdcChangeEvents.resource, 'content_route')));
    expect(routeEvents.map((e) => e.itemId).sort()).toEqual([a.id, draft.id].sort());
    // Two articles that would collide under a new pattern: refused, nothing changes.
    await svc().create('pages', { data: { title: 'x', slug: 'moving', locale: 'en' } });
    const err = await settings({ permalinks: { articles: '/:slug', pages: '/:slug', categories: '/category/:slug' } }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'ROUTE_CONFLICT' });
    expect(await routeOf(a.id)).toMatchObject({ path: '/news/moving' });
    const [s] = await db.select().from(siteContentSettings).where(eq(siteContentSettings.siteId, SITE));
    expect(s!.permalinks).toMatchObject({ articles: '/news/:slug' });
  });

  it('a category\'s new slug moves the paths of its articles', async () => {
    await settings({ permalinks: { articles: '/:category/:slug', pages: '/:slug', categories: '/category/:slug' } });
    const cat = (await svc().create('categories', { data: { name: 'Guides', slug: 'guides' }, status: 'published' })) as { id: string; version: number };
    const a = await article('setup', { primary_category: cat.id });
    expect(await routeOf(a.id)).toMatchObject({ path: '/guides/setup' });
    await svc().patch('categories', cat.id, { data: { slug: 'how-to' }, expectedVersion: cat.version });
    expect(await routeOf(a.id)).toMatchObject({ path: '/how-to/setup' });
    expect(await rules()).toEqual(expect.arrayContaining(['en:/guides/setup -> en:/how-to/setup']));
  });

  it('paths stay clear of language prefixes, both ways', async () => {
    await svc().create('pages', { data: { title: 'Zh page', slug: 'zh', locale: 'en' } });
    const err = await settings({ localePrefixes: { 'zh-CN': 'zh' } }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'PREFIX_CONFLICT' });
    await settings({ localePrefixes: { 'zh-CN': 'cn' } });
    expect(await codeOf(svc().create('pages', { data: { title: 'Cn page', slug: 'cn', locale: 'en' } }))).toBe('PATH_RESERVED');
    expect(await codeOf(svc().create('pages', { data: { title: 'Api', slug: 'api', locale: 'en' } }))).toBe('PATH_RESERVED');
  });

  it('first publish time: recorded once, kept on re-publish; history unknown → the creation time, estimated', async () => {
    const d = await article('later', {}, 'draft');
    let row = (await db.select().from(items).where(eq(items.id, d.id)))[0]!;
    expect(row.publishedAt).toBeNull();
    const pub = (await svc().patch('articles', d.id, { status: 'published', expectedVersion: d.version })) as { version: number };
    row = (await db.select().from(items).where(eq(items.id, d.id)))[0]!;
    expect(row.publishedAtSource).toBe('recorded');
    const first = row.publishedAt!.getTime();
    const unpub = (await svc().patch('articles', d.id, { status: 'draft', expectedVersion: pub.version })) as { version: number };
    await svc().patch('articles', d.id, { status: 'published', expectedVersion: unpub.version });
    row = (await db.select().from(items).where(eq(items.id, d.id)))[0]!;
    expect(row.publishedAt!.getTime()).toBe(first);
    const old = await article('old-unknown', {}, 'draft');
    await db.update(items).set({ publishedAtSource: 'unknown', createdAt: new Date('2019-01-02T00:00:00Z') }).where(eq(items.id, old.id));
    await svc().patch('articles', old.id, { status: 'published', expectedVersion: old.version });
    row = (await db.select().from(items).where(eq(items.id, old.id)))[0]!;
    expect(row).toMatchObject({ publishedAtSource: 'estimated' });
    expect(row.publishedAt!.toISOString()).toBe('2019-01-02T00:00:00.000Z');
    expect(await routeOf(old.id)).toMatchObject({ path: '/2019/01/02/old-unknown' });
  });

  it('scheduled publishing: the date path follows the first publish; an item whose path is taken is skipped and recorded', async () => {
    await settings({ permalinks: { articles: '/:slug', pages: '/:slug', categories: '/category/:slug' } });
    const due = await article('due-a', {}, 'draft');
    const blocked = await article('due-b', {}, 'draft');
    await db.update(items).set({ publishAt: new Date(Date.now() - 60_000) }).where(eq(items.siteId, SITE));
    // Another item takes due-b's future path while due-b waits.
    const owner = await article('owner', {}, 'draft');
    await db.update(contentRoutes).set({ path: '/parked' }).where(eq(contentRoutes.itemId, blocked.id));
    await db.update(contentRoutes).set({ path: '/due-b' }).where(eq(contentRoutes.itemId, owner.id));
    const published = await sweepDuePublish({ db });
    expect(published).toBeGreaterThanOrEqual(1);
    const [a] = await db.select().from(items).where(eq(items.id, due.id));
    expect(a).toMatchObject({ status: 'published', publishedAtSource: 'recorded' });
    const [b] = await db.select().from(items).where(eq(items.id, blocked.id));
    expect(b!.status).toBe('draft');
    const failures = await db.select().from(auditLog).where(and(eq(auditLog.siteId, SITE), eq(auditLog.event, 'scheduled_publish_failed')));
    expect(failures.map((f) => f.metadata)).toEqual([expect.objectContaining({ itemId: blocked.id, code: 'PATH_TAKEN' })]);
  });
});
