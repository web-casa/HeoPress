import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { ensureRenderRole, items, projectionRebuilds, publicItems, renderCache, schema, siteContentSettings, siteDomains, siteRenderVersions, sites, staleRenderCacheRows, type Database } from '@heopress/database';
import { runSiteTransaction } from '../services/rls-transaction';
import { createSiteClassic, type SiteClassic } from '@heopress/site-classic';
import { etagOf, PageCache } from '@heopress/site-classic/cache';
import { renderPort } from '@heopress/site-classic/read-port';
import { ItemService } from '../services/item-service';
import { renderCacheInvalidationConsumer } from '../services/rendering/render-cache-consumer';
import { ContentSettingsService } from '../services/site-network/content-settings-service';
import { upgradeSitePreset } from '../services/site-network/preset-installer';
import { rebuildSiteProjection } from '../services/site-network/public-projection';
import { connectDbIntegration, dbIntegrationUrl, hasDbIntegrationUrl } from './helpers/db-harness';

/**
 * The page cache (HeoPress P06 tasks 3.1–3.3, 7.2; design §4, R8, R9): answers cached at two levels under
 * the site's render version, 304 for an unchanged page, every change visible at once whether the change
 * events are consumed or not, the consumer freeing superseded entries, two sites never crossing, and the
 * change event written in the same transaction as the content (its failure rolls everything back).
 *
 * Needs DATABASE_OWNER_URL (rendering role; a failing outbox trigger).
 */

const A = 'site_p06_cache_a';
const B = 'site_p06_cache_b';
const HOST_A = 'rc-a.example.com';
const HOST_B = 'rc-b.example.com';
const ALIAS_A = 'www.rc-a.example.com';
const RENDER_ROLE = 'heopress_render_it';
const OWNER_URL = process.env.DATABASE_OWNER_URL?.trim() || undefined;

describe.skipIf(!hasDbIntegrationUrl)('page cache — DB integration', () => {
  let db: Database;
  let owner: postgres.Sql;
  let renderClient: postgres.Sql;
  let renderDb: Database;
  let renderUrl: string;
  let service: SiteClassic;
  /**
   * Level-2 writes happen after the answer, in the background (`void cache.store(…)`): every write a renderer starts is
   * tracked here, so a test waits for exactly those writes instead of a fixed pause — which a loaded run outlasted (the
   * row was not there yet), and which let a late write of one test land in the next one (a row in "never cached").
   */
  const writes = new Set<Promise<void>>();
  let storeSpy: MockInstance<PageCache['store']> | undefined;
  const settle = async () => {
    while (writes.size) await Promise.allSettled([...writes]);
  };

  beforeAll(async () => {
    const store = PageCache.prototype.store;
    storeSpy = vi.spyOn(PageCache.prototype, 'store').mockImplementation(function (this: PageCache, ...args) {
      const write = store.apply(this, args);
      writes.add(write);
      const done = () => void writes.delete(write);
      write.then(done, done);
      return write;
    });
    expect(OWNER_URL, 'DATABASE_OWNER_URL is required').toBeDefined();
    db = await connectDbIntegration('render-cache');
    owner = postgres(OWNER_URL!, { max: 1, onnotice: () => {} });
    const password = randomBytes(18).toString('hex');
    await owner.begin((tx) => ensureRenderRole(tx, { role: RENDER_ROLE, password }));
    const url = new URL(dbIntegrationUrl!);
    url.username = RENDER_ROLE;
    url.password = password;
    renderUrl = url.toString();
    renderClient = postgres(renderUrl, { max: 4, onnotice: () => {} });
    renderDb = drizzle(renderClient, { schema }) as unknown as Database;
    service = createSiteClassic({ db: renderDb, sweepIntervalMs: 0 });
  });
  // No write of one test lands in the next.
  afterEach(settle);
  afterAll(async () => {
    await settle();
    storeSpy?.mockRestore();
    await db?.delete(sites).where(inArray(sites.id, [A, B]));
    await service?.close();
    await renderClient?.end({ timeout: 2 });
    await owner?.end({ timeout: 2 });
  });

  beforeEach(async () => {
    await db.delete(sites).where(inArray(sites.id, [A, B]));
    await db.insert(sites).values([
      { id: A, name: 'Cache Alpha', defaultLanguage: 'en' },
      { id: B, name: 'Cache Beta', defaultLanguage: 'en' },
    ]);
    for (const id of [A, B]) await upgradeSitePreset(db, id);
    await db.insert(siteDomains).values([
      { siteId: A, hostname: HOST_A, kind: 'custom', status: 'active', isPrimary: true, verifiedAt: new Date() },
      { siteId: A, hostname: ALIAS_A, kind: 'custom', status: 'active', verifiedAt: new Date() },
      { siteId: B, hostname: HOST_B, kind: 'custom', status: 'active', isPrimary: true, verifiedAt: new Date() },
    ]);
    for (const id of [A, B]) {
      const [r] = await db.select().from(siteContentSettings).where(eq(siteContentSettings.siteId, id));
      await new ContentSettingsService({ db, siteId: id, actor: { userId: null } }).update({
        availableLocales: r!.availableLocales, timezone: r!.timezone, siteType: 'blog', trailingSlash: 'always', localeStrategy: 'subdirectory',
        localePrefixMode: 'default_at_root', localePrefixes: {}, permalinks: { articles: '/:slug', pages: '/:slug' }, allowCrossSiteTranslations: false,
        sponsorDisclosure: true, sponsorRel: true, version: r!.version,
      } as never);
    }
    for (const id of [A, B]) await rebuildSiteProjection(db, id);
  });

  const svc = (siteId: string) => new ItemService({ db, siteId });
  const article = (siteId: string, slug: string, title = `Title ${slug}`) =>
    svc(siteId).create('articles', { data: { title, slug, locale: 'en' }, status: 'published' }) as Promise<{ id: string; version: number }>;
  const versionOf = async (id: string) => (await db.select({ v: items.version }).from(items).where(eq(items.id, id)))[0]!.v;
  const get = async (host: string, path: string, headers: Record<string, string> = {}, app = service.app) => {
    const res = await app.request(path, { headers: { host, ...headers } });
    return { status: res.status, body: await res.text(), headers: res.headers };
  };
  const rows = (siteId: string) => db.select().from(renderCache).where(eq(renderCache.siteId, siteId));
  const renderVersion = async (siteId: string) => (await db.select({ v: siteRenderVersions.version }).from(siteRenderVersions).where(eq(siteRenderVersions.siteId, siteId)))[0]?.v ?? 0;
  /** Rows that can no longer be served (P13 task 3.2), read in the site's scope. */
  const staleRows = (siteId: string) => runSiteTransaction(db, siteId, (tx) => tx.select({ key: renderCache.key }).from(renderCache).where(staleRenderCacheRows(siteId)));

  it('task 3.1: the second request is a hit, at both levels; a matching If-None-Match is 304', async () => {
    await article(A, 'hello');
    const first = await get(HOST_A, '/hello/');
    expect(first).toMatchObject({ status: 200 });
    expect(first.headers.get('x-cache')).toBe('miss');
    expect(first.headers.get('cache-control')).toContain('must-revalidate');
    const etag = first.headers.get('etag')!;
    expect(etag).toMatch(/^W\/"/);
    const second = await get(HOST_A, '/hello/');
    expect(second.headers.get('x-cache')).toBe('hit');
    expect(second.body).toBe(first.body);
    await settle();
    expect((await rows(A)).length).toBeGreaterThan(0);
    // Another renderer process (an empty level 1) hits level 2.
    const other = createSiteClassic({ db: renderDb, sweepIntervalMs: 0 });
    try {
      const fromL2 = await get(HOST_A, '/hello/', {}, other.app);
      expect(fromL2.headers.get('x-cache')).toBe('hit-shared');
      // and keeps it: the next answer is from its own level 1.
      expect((await get(HOST_A, '/hello/', {}, other.app)).headers.get('x-cache')).toBe('hit');
      expect(fromL2.body).toBe(first.body);
    } finally {
      await other.close();
    }
    const notModified = await get(HOST_A, '/hello/', { 'if-none-match': etag });
    expect(notModified.status).toBe(304);
    expect(notModified.body).toBe('');
    expect((await get(HOST_A, '/hello/', { 'if-none-match': 'W/"other"' })).status).toBe(200);
  });

  it('HeoPress P07 task 1.3: a stored answer\'s type and representation headers are replayed on 200, HEAD and 304', async () => {
    await article(A, 'envelope');
    expect((await get(HOST_A, '/envelope/')).status).toBe(200);
    // The shared write happens after the answer: waited for.
    await settle();
    expect((await rows(A)).length).toBeGreaterThan(0);
    // The stored entry made an XML or plain-text answer with a robots header and a canonical link (what discovery files will be).
    const headers = { 'x-robots-tag': 'noindex', link: `<https://${HOST_A}/envelope/>; rel="canonical"` };
    for (const [contentType, body] of [['application/xml; charset=utf-8', '<urlset/>'], ['text/plain; charset=utf-8', 'User-agent: *']] as const) {
      const updated = await db
        .update(renderCache)
        .set({ contentType, headers, etag: 'W/"stale"', body })
        .where(eq(renderCache.siteId, A))
        .returning({ key: renderCache.key });
      expect(updated.length).toBeGreaterThan(0);
      // The entity tag is recomputed from what was read, not taken from the row.
      const etag = etagOf(200, body, null, contentType, headers);
      const other = createSiteClassic({ db: renderDb, sweepIntervalMs: 0 });
      try {
        const full = await get(HOST_A, '/envelope/', {}, other.app);
        expect(full.headers.get('x-cache')).toBe('hit-shared');
        expect(full.headers.get('content-type')).toBe(contentType);
        expect(full.body).toBe(body);
        const head = await other.app.request('/envelope/', { method: 'HEAD', headers: { host: HOST_A } });
        const notModified = await get(HOST_A, '/envelope/', { 'if-none-match': etag }, other.app);
        expect(notModified.status).toBe(304);
        for (const res of [full, { headers: head.headers }, notModified]) {
          expect(res.headers.get('x-robots-tag')).toBe('noindex');
          expect(res.headers.get('link')).toBe(headers.link);
          expect(res.headers.get('etag')).toBe(etag);
        }
        expect(head.headers.get('content-type')).toBe(contentType);
        expect(await head.text()).toBe('');
        expect(notModified.headers.get('content-type')).toBeNull();
      } finally {
        await other.close();
      }
    }
    // A row a renderer would not have written (a header outside the allowed set) is a miss, and is rendered again.
    await db.update(renderCache).set({ headers: { 'set-cookie': 'x=1' } }).where(eq(renderCache.siteId, A));
    const other = createSiteClassic({ db: renderDb, sweepIntervalMs: 0 });
    try {
      const fresh = await get(HOST_A, '/envelope/', {}, other.app);
      expect(fresh.headers.get('x-cache')).toBe('miss');
      expect(fresh.headers.get('set-cookie')).toBeNull();
      expect(fresh.headers.get('content-type')).toContain('text/html');
    } finally {
      await other.close();
    }
  });

  it('tasks 3.2/3.3: publish, edit, unpublish and delete show at once with no consumer running; the consumer frees superseded entries', async () => {
    await get(HOST_A, '/');
    const a = await article(A, 'fresh', 'Fresh news');
    const home = await get(HOST_A, '/');
    expect(home.headers.get('x-cache')).toBe('miss');
    expect(home.body).toContain('Fresh news');
    await svc(A).patch('articles', a.id, { data: { title: 'Edited news' }, expectedVersion: await versionOf(a.id) });
    expect((await get(HOST_A, '/fresh/')).body).toContain('Edited news');
    await svc(A).patch('articles', a.id, { status: 'draft', expectedVersion: await versionOf(a.id) });
    expect((await get(HOST_A, '/fresh/')).status).toBe(404);
    expect((await get(HOST_A, '/')).body).not.toContain('Edited news');
    await svc(A).softDelete('articles', a.id);
    // Public once, then deleted (after being unpublished): 410 (design R22).
    expect((await get(HOST_A, '/fresh/')).status).toBe(410);
    await settle();
    // Entries made under older versions exist; the consumer (its handler, here) removes them and keeps the current ones.
    expect((await staleRows(A)).length).toBeGreaterThan(0);
    const kept = (await rows(A)).length - (await staleRows(A)).length;
    await renderCacheInvalidationConsumer({ db }).handle!({ siteId: A, resource: 'item', itemId: a.id } as never, {} as never);
    expect(await staleRows(A)).toEqual([]);
    expect((await rows(A)).length).toBe(kept);
    // The renderer's sweep does the same for any site.
    await get(HOST_B, '/');
    await settle();
    await article(B, 'bump');
    expect(await new PageCache(renderDb).sweep()).toBeGreaterThan(0);
    expect(await staleRows(B)).toEqual([]);
  });

  describe('HeoPress P13 task 3.2: a publication invalidates the pages it changes, not the whole site', () => {
    const cacheOf = async (path: string, app = service.app) => (await get(HOST_A, path, {}, app)).headers.get('x-cache');
    /** Every page the tests read, warm: rendered once, then answered from this process. */
    const warm = async (paths: string[]) => {
      for (const p of paths) await get(HOST_A, p);
      await settle();
      for (const p of paths) expect(await cacheOf(p), p).toBe('hit');
    };

    it('a new article: its page, the lists, feeds and sitemaps are made anew at once (no consumer); the other articles stay cached', async () => {
      await article(A, 'first', 'First story');
      await article(A, 'second', 'Second story');
      for (let i = 0; i < 10; i++) await article(A, `filler-${i}`);
      // A 404 where the new article will be, kept in this process.
      expect((await get(HOST_A, '/third/')).status).toBe(404);
      const lists = ['/', '/?page=2', '/feed.xml', '/atom.xml', '/sitemap-1.xml', '/sitemap.txt', '/llms.txt'];
      await warm(['/first/', '/second/', ...lists]);
      expect(await cacheOf('/third/')).toBe('hit');

      await article(A, 'third', 'Third story');
      // The new article's address: 200 (not the cached 404).
      const third = await get(HOST_A, '/third/');
      expect(third.status).toBe(200);
      expect(third.body).toContain('Third story');
      // Every list and discovery file that lists it: made anew, and lists it.
      for (const p of lists) {
        const res = await get(HOST_A, p);
        expect(res.headers.get('x-cache'), p).toBe('miss');
      }
      expect((await get(HOST_A, '/')).body).toContain('Third story');
      expect((await get(HOST_A, '/feed.xml')).body).toContain(`https://${HOST_A}/third/`);
      expect((await get(HOST_A, '/sitemap.txt')).body).toContain(`https://${HOST_A}/third/`);
      // The other articles' pages: still answered from the cache, at both levels.
      expect(await cacheOf('/first/')).toBe('hit');
      expect(await cacheOf('/second/')).toBe('hit');
      const other = createSiteClassic({ db: renderDb, sweepIntervalMs: 0 });
      try {
        expect(await cacheOf('/first/', other.app)).toBe('hit-shared');
      } finally {
        await other.close();
      }
      // Neither the consumer nor the sweep removes them: they are not stale.
      await renderCacheInvalidationConsumer({ db }).handle!({ siteId: A, resource: 'item' } as never, {} as never);
      await new PageCache(renderDb).sweep();
      const fresh = createSiteClassic({ db: renderDb, sweepIntervalMs: 0 });
      try {
        expect(await cacheOf('/second/', fresh.app)).toBe('hit-shared');
      } finally {
        await fresh.close();
      }
      // Site B is untouched.
      expect(await staleRows(B)).toEqual([]);
    });

    it('an article edited, unpublished, deleted: its own page is never served stale, at either level; the others stay cached', async () => {
      const a = await article(A, 'story', 'Original title');
      await article(A, 'bystander', 'Bystander');
      await warm(['/story/', '/bystander/', '/']);
      const other = createSiteClassic({ db: renderDb, sweepIntervalMs: 0 });
      try {
        expect(await cacheOf('/story/', other.app)).toBe('hit-shared');
        await svc(A).patch('articles', a.id, { data: { title: 'Edited title' }, expectedVersion: await versionOf(a.id) });
        for (const app of [service.app, other.app]) {
          const res = await get(HOST_A, '/story/', {}, app);
          // Never this process's former copy: made anew (or, in the second process, the shared row the first just made).
          expect(res.headers.get('x-cache')).toMatch(app === service.app ? /^miss$/ : /^(miss|hit-shared)$/);
          expect(res.body).toContain('Edited title');
          expect(res.body).not.toContain('Original title');
          expect((await get(HOST_A, '/', {}, app)).body).toContain('Edited title');
          expect(await cacheOf('/bystander/', app)).toMatch(/^hit/);
        }
        await settle();
        await svc(A).patch('articles', a.id, { status: 'draft', expectedVersion: await versionOf(a.id) });
        for (const app of [service.app, other.app]) {
          expect((await get(HOST_A, '/story/', {}, app)).status).toBe(404);
          expect((await get(HOST_A, '/', {}, app)).body).not.toContain('Edited title');
        }
        await svc(A).softDelete('articles', a.id);
        for (const app of [service.app, other.app]) expect((await get(HOST_A, '/story/', {}, app)).status).toBe(410);
        expect(await cacheOf('/bystander/')).toBe('hit');
      } finally {
        await other.close();
      }
    });

    it('a change of the whole site (its name) or of a category makes every page anew', async () => {
      // Categories get public pages (a permalink), so an article page names its category.
      const [r] = await db.select().from(siteContentSettings).where(eq(siteContentSettings.siteId, A));
      await new ContentSettingsService({ db, siteId: A, actor: { userId: null } }).update({
        availableLocales: r!.availableLocales, timezone: r!.timezone, siteType: 'blog', trailingSlash: 'always', localeStrategy: 'subdirectory',
        localePrefixMode: 'default_at_root', localePrefixes: {}, permalinks: { articles: '/:slug', pages: '/:slug', categories: '/category/:slug' }, allowCrossSiteTranslations: false,
        sponsorDisclosure: true, sponsorRel: true, version: r!.version,
      } as never);
      const cat = (await svc(A).create('categories', { data: { name: 'Guides', slug: 'guides' }, status: 'published' })) as { id: string; version: number };
      await svc(A).create('articles', { data: { title: 'Filed', slug: 'filed', locale: 'en', primary_category: cat.id }, status: 'published' });
      await article(A, 'plain', 'Plain');
      await warm(['/filed/', '/plain/']);
      expect((await get(HOST_A, '/filed/')).body).toContain('Guides');
      // The category an article page names (its breadcrumb).
      await svc(A).patch('categories', cat.id, { data: { name: 'Handbooks' }, expectedVersion: cat.version });
      const filed = await get(HOST_A, '/filed/');
      expect(filed.headers.get('x-cache')).toBe('miss');
      expect(filed.body).toContain('Handbooks');
      expect(filed.body).not.toContain('Guides');
      expect(await cacheOf('/plain/')).toBe('miss');
      await warm(['/filed/', '/plain/']);
      // The site's name (a site-wide change: the whole projection rebuilt).
      await db.update(sites).set({ name: 'Renamed Alpha' }).where(eq(sites.id, A));
      await rebuildSiteProjection(db, A);
      for (const p of ['/filed/', '/plain/']) {
        const res = await get(HOST_A, p);
        expect(res.headers.get('x-cache'), p).toBe('miss');
        expect(res.body, p).toContain('Renamed Alpha');
      }
    });

    it('a cache hit reads nothing through the page-data connections (its own lookup pool)', async () => {
      await article(A, 'pooled', 'Pooled');
      await get(HOST_A, '/pooled/');
      await settle();
      // A renderer whose page-data connections fail: a hit is still answered, from the shared level and then its own.
      const broken = new Proxy(renderDb, {
        get: (target, prop, receiver) => (prop === 'transaction' ? () => Promise.reject(new Error('page-data pool unavailable')) : Reflect.get(target, prop, receiver)),
      });
      const other = createSiteClassic({ db: broken, lookupDb: renderDb, sweepIntervalMs: 0, traffic: false });
      try {
        expect(await cacheOf('/pooled/', other.app)).toBe('hit-shared');
        expect(await cacheOf('/pooled/', other.app)).toBe('hit');
        // A miss needs them.
        expect((await get(HOST_A, '/never-rendered/', {}, other.app)).status).toBe(500);
      } finally {
        await other.close();
      }
    });

    it('P13 Phase Gate: the lookup binds its values — hostile ones are data, the scope setting ends with the statement', async () => {
      await article(A, 'bound', 'Bound');
      await get(HOST_A, '/bound/');
      await settle();
      const [stored] = await db.select({ key: renderCache.key }).from(renderCache).where(eq(renderCache.siteId, A));
      expect(stored).toBeDefined();
      // One connection: the setting check below runs where the lookups ran.
      const one = postgres(renderUrl, { max: 1, onnotice: () => {} });
      const port = renderPort(drizzle(one, { schema }) as unknown as Database);
      try {
        const real = await port.lookup(A, stored!.key, { builtin: 'builtin', shared: true, itemId: null });
        expect(real.state.version).toBeGreaterThan(0);
        expect(real.stored).not.toBeNull();
        const scope = async () => (await one`SELECT current_setting('app.site_id', true) AS v`)[0]!.v as string | null;
        expect([null, '']).toContain(await scope());
        const hostile = [
          `${A}'; DROP TABLE lumibase_render_cache; --`,
          `' OR '1'='1`,
          `${A}\\'); SELECT pg_sleep(5); --`,
          `$$; DELETE FROM lumibase_render_cache; $$`,
          `${A} `,
        ];
        for (const value of hostile) {
          const site = await port.lookup(value, stored!.key, { builtin: 'builtin', shared: true, itemId: value });
          // Another site id: nothing of A — no versions, no shared row, the built-in theme.
          expect(site.state).toMatchObject({ version: 0, structureVersion: 0, themeVersion: 'builtin' });
          expect(site.stored).toBeNull();
          const key = await port.lookup(A, value, { builtin: 'builtin', shared: true, itemId: value });
          expect(key.stored).toBeNull();
          expect(key.itemVersion).toBeNull();
          expect(key.state.version).toBe(real.state.version);
          expect([null, '']).toContain(await scope());
        }
        // Nothing was run: the shared row is still there.
        expect((await db.select({ key: renderCache.key }).from(renderCache).where(eq(renderCache.key, stored!.key))).length).toBe(1);
      } finally {
        await one.end({ timeout: 2 });
      }
    });
  });

  it('a deleted once-public page: 410 at once, cached as 410', async () => {
    const a = await article(A, 'gone');
    expect((await get(HOST_A, '/gone/')).status).toBe(200);
    await svc(A).softDelete('articles', a.id);
    const gone = await get(HOST_A, '/gone/');
    expect(gone.status).toBe(410);
    expect(gone.headers.get('x-cache')).toBe('miss');
    expect((await get(HOST_A, '/gone/')).headers.get('x-cache')).toBe('hit');
  });

  it('R9: parameters that change nothing share the entry; a 301 keeps the request’s own query', async () => {
    await article(A, 'q');
    await get(HOST_A, '/');
    expect((await get(HOST_A, '/?utm_source=x')).headers.get('x-cache')).toBe('hit');
    expect((await get(HOST_A, '/?page=2')).status).toBe(404);
    expect((await get(HOST_A, '/?page=abc')).status).toBe(404);
    const r1 = await get(ALIAS_A, '/q/?ref=1');
    expect(r1.status).toBe(301);
    expect(r1.headers.get('location')).toBe(`https://${HOST_A}/q/?ref=1`);
    const r2 = await get(ALIAS_A, '/q/?ref=2');
    expect(r2.headers.get('x-cache')).toBe('hit');
    expect(r2.headers.get('location')).toBe(`https://${HOST_A}/q/?ref=2`);
    expect((await get(ALIAS_A, '/q/')).headers.get('location')).toBe(`https://${HOST_A}/q/`);
  });

  it('Codex review: encoded search paths keyed by query; level 2 holds only content-bounded answers; one sweep at a time', async () => {
    await article(A, 'alpha', 'Alpha piece');
    await article(A, 'beta', 'Beta piece');
    const a1 = await get(HOST_A, '/%73earch/?q=alpha');
    const b1 = await get(HOST_A, '/%73earch/?q=beta');
    expect(a1.body).toContain('Alpha piece');
    expect(b1.body).toContain('Beta piece');
    expect(b1.body).not.toContain('Alpha piece');
    // Answers any request can create (404s, alias redirects, search results) stay out of the shared table.
    for (let i = 0; i < 5; i++) await get(HOST_A, `/missing-${i}/`);
    await get(ALIAS_A, '/alpha/');
    await settle();
    const stored = await rows(A);
    expect(stored.every((r) => r.status === 200 || r.status === 410)).toBe(true);
    expect(stored.some((r) => r.body.includes('Beta piece') && r.body.includes('type="search"'))).toBe(false);
    // Superseded rows to sweep (the home page lists every article; the article's own page stays valid); another process
    // sweeping holds the fleet-wide lock: this sweep does nothing.
    await get(HOST_A, '/alpha/');
    await get(HOST_A, '/');
    await settle();
    await article(A, 'bump');
    await owner.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(${0x72656e64})`;
      expect(await new PageCache(renderDb).sweep()).toBe(0);
    });
    expect(await new PageCache(renderDb).sweep()).toBeGreaterThan(0);
  });

  it('Codex review round 2: query-keyed answers shared only when bounded by content; every site gets its sweep turn', async () => {
    for (let i = 0; i < 11; i++) await article(A, `p${i}`);
    // An article ignores ?page: those answers stay in this process.
    for (const n of [5, 6, 7]) expect((await get(HOST_A, `/p1/?page=${n}`)).status).toBe(200);
    // A list page that exists is shared.
    expect((await get(HOST_A, '/?page=2')).status).toBe(200);
    await settle();
    const stored = await rows(A);
    expect(stored.filter((r) => r.body.includes('Title p1') && !r.body.includes('Title p0')).length).toBeLessThanOrEqual(1);
    expect(stored.some((r) => r.body.includes('rel="prev"'))).toBe(true);
    // Superseded rows on both sites; a sweep with room for one batch takes one site, the next sweep the other.
    await get(HOST_B, '/');
    await settle();
    expect((await rows(B)).length).toBeGreaterThan(0);
    await article(A, 'bump-a');
    await article(B, 'bump-b');
    const superseded = async () => {
      const out: string[] = [];
      for (const site of [A, B]) if ((await staleRows(site)).length) out.push(site);
      return out;
    };
    expect(await superseded()).toEqual([A, B]);
    // (Other sites' rows may be in the table too: the sweeper takes its turns across all of them.)
    const sweeper = new PageCache(renderDb);
    await sweeper.sweep({ maxBatches: 1 });
    expect((await superseded()).length).toBeGreaterThan(0);
    for (let i = 0; i < 50 && (await superseded()).length; i++) await sweeper.sweep({ maxBatches: 1 });
    expect(await superseded()).toEqual([]);
  });

  it('a site deleted and created again under the same id never meets its former cache entries (versions never repeat)', async () => {
    await article(A, 'old-life', 'Former life');
    expect((await get(HOST_A, '/')).body).toContain('Former life');
    // The former life's entry is stored before the site goes.
    await settle();
    const before = await renderVersion(A);
    await db.delete(sites).where(eq(sites.id, A));
    await db.insert(sites).values({ id: A, name: 'Cache Alpha', defaultLanguage: 'en' });
    await upgradeSitePreset(db, A);
    await db.insert(siteDomains).values({ siteId: A, hostname: HOST_A, kind: 'custom', status: 'active', isPrimary: true, verifiedAt: new Date() });
    await rebuildSiteProjection(db, A);
    expect(await renderVersion(A)).toBeGreaterThan(before);
    const home = await get(HOST_A, '/');
    expect(home.headers.get('x-cache')).toBe('miss');
    expect(home.body).not.toContain('Former life');
  });

  it('task 7.2: two sites, the same path, concurrent requests never cross', async () => {
    await article(A, 'same', 'Alpha same');
    await article(B, 'same', 'Beta same');
    const results = await Promise.all(Array.from({ length: 24 }, (_, i) => get(i % 2 ? HOST_A : HOST_B, '/same/')));
    results.forEach((r, i) => {
      expect(r.status).toBe(200);
      expect(r.body).toContain(i % 2 ? 'Alpha same' : 'Beta same');
      expect(r.body).not.toContain(i % 2 ? 'Beta same' : 'Alpha same');
    });
  });

  it('503 and errors are never cached', async () => {
    await db.insert(projectionRebuilds).values({ siteId: A, reason: 'test' });
    const r = await get(HOST_A, '/');
    expect(r.status).toBe(503);
    expect(r.headers.get('cache-control')).toBe('no-store');
    await settle();
    expect(await rows(A)).toEqual([]);
  });

  it('task 3.3: a failed change event rolls back the content, the projection and the render version together', async () => {
    const before = await renderVersion(A);
    await owner.unsafe(`CREATE OR REPLACE FUNCTION heopress_test_fail_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.site_id = '${A}' THEN RAISE EXCEPTION 'outbox unavailable'; END IF; RETURN NEW; END $$`);
    await owner.unsafe(`CREATE TRIGGER heopress_test_fail_outbox BEFORE INSERT ON lumibase_cdc_change_events FOR EACH ROW EXECUTE FUNCTION heopress_test_fail_outbox()`);
    try {
      await expect(article(A, 'never')).rejects.toThrow();
    } finally {
      await owner.unsafe(`DROP TRIGGER heopress_test_fail_outbox ON lumibase_cdc_change_events`);
      await owner.unsafe(`DROP FUNCTION heopress_test_fail_outbox()`);
    }
    expect(await db.select().from(items).where(eq(items.siteId, A))).toEqual([]);
    expect(await db.select().from(publicItems).where(eq(publicItems.siteId, A))).toEqual([]);
    expect(await renderVersion(A)).toBe(before);
    expect((await get(HOST_A, '/never/')).status).toBe(404);
  });
});
