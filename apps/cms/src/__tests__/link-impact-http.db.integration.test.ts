import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { collections, items, linkEdges, publicItems, siteDomains, type Database } from '@heopress/database';
import { createRuntime } from '@heopress/runtime/node';
import app from '../index';
import { setRuntimeFactory } from '../middleware/runtime';
import { runSiteTransaction } from '../services/rls-transaction';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { createCrossSiteFixture, SHARED, type CrossSiteFixture } from './helpers/cross-site-fixture';
import type { LinkImpact } from '../services/site-network/link-impact';

/**
 * Change impact over HTTP (HeoPress P07 task 5.5; Codex review): what a caller is shown is what it may read; a redirect is
 * an administrator's; links are updated only in the pages the caller may update; malformed parameters are refused.
 */

const JWT_SECRET = 'link-impact-secret';
const HOST = 'linki-a.example.com';

describe.skipIf(!hasDbIntegrationUrl)('change impact — HTTP', () => {
  let db: Database;
  let fx: CrossSiteFixture;
  let env: Record<string, unknown> = {};
  let pageId: string;

  beforeAll(async () => {
    db = await connectDbIntegration('link-impact-http');
    env = { ...process.env, JWT_SECRET, HEOPRESS_ENV: 'development' };
    const runtime = createRuntime(env);
    setRuntimeFactory(() => runtime);
  });
  beforeEach(async () => {
    fx = await createCrossSiteFixture(db, { prefix: 'linki', jwtSecret: JWT_SECRET });
    const a = fx.sites.a;
    await db.insert(siteDomains).values({ siteId: a, hostname: HOST, kind: 'custom', status: 'active', isPrimary: true, verifiedAt: new Date() });
    pageId = await runSiteTransaction(db, a, async (tx) => {
      // A page (of a collection the fixture's editor may not read) and the fixture's article both link to the target.
      const [coll] = await tx.insert(collections).values({ siteId: a, name: 'pages', label: 'Pages' }).returning({ id: collections.id });
      const [page] = await tx.insert(items).values({ siteId: a, collectionId: coll!.id, status: 'published', data: { title: '<a href="/target/">t</a>' } }).returning({ id: items.id });
      await tx.update(items).set({ status: 'published', data: { title: '<a href="/target/">t</a>', slug: SHARED.slug } }).where(eq(items.id, fx.items.a));
      return page!.id;
    });
    // The public rows and the graph as the projection and the graph hold them (written after the base tables' commit).
    await runSiteTransaction(db, a, async (tx) => {
      const row = (itemId: string, collection: string, path: string) => ({
        itemId,
        siteId: a,
        collection,
        locale: 'en',
        path,
        data: { title: path },
        card: { url: `https://${HOST}${path}/` },
        updatedAt: new Date(),
        sanitizer: 1,
        richFields: ['title'],
      });
      await tx.insert(publicItems).values([row('linki_target', 'articles', '/target'), row(pageId, 'pages', '/page'), row(fx.items.a, 'articles', '/article')]);
      for (const source of [pageId, fx.items.a]) {
        await tx.insert(linkEdges).values({ siteId: a, origin: 'auto', sourceItemId: source, field: 'title', href: '/target/', targetUrl: `https://${HOST}/target/`, targetLocale: 'en', targetPath: '/target' });
      }
    });
  });
  afterAll(async () => {
    setRuntimeFactory(null);
    if (fx) await fx.teardown();
  });

  const call = (path: string, method: string, headers: Record<string, string>, body?: unknown) =>
    app.request(path, { method, headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env);

  it('the editor sees the article it may read, not the page; a redirect is refused it; malformed parameters are a 400', async () => {
    const editor = fx.headers('a', await fx.session('onlyA', 'a'));
    const res = await call('/api/v1/site/links/impact/linki_target', 'GET', editor);
    expect(res.status, await res.clone().text()).toBe(200);
    const data = ((await res.json()) as { data: LinkImpact }).data;
    expect(data.links.map((l) => l.source.kind === 'item' && l.source.itemId)).toEqual([fx.items.a]);
    expect(JSON.stringify(data)).not.toContain(pageId);
    const admin = ((await (await call('/api/v1/site/links/impact/linki_target', 'GET', fx.headers('a', await fx.session('adminA', 'a')))).json()) as { data: LinkImpact }).data;
    expect(admin.pages).toBe(2);
    expect((await call('/api/v1/site/links/impact/linki_target/redirect', 'POST', editor, { to: `https://${HOST}/article/` })).status).toBe(403);
    for (const q of ['?limit=abc', '?depth=1.5', '?limit=-1']) expect((await call(`/api/v1/site/links/impact/linki_target${q}`, 'GET', editor)).status, q).toBe(400);
    expect((await call('/api/v1/site/links/impact/nope', 'GET', editor)).status).toBe(404);
  });

  it('links are updated in the pages the caller may update; the others are reported, unchanged', async () => {
    const editor = fx.headers('a', await fx.session('onlyA', 'a'));
    const res = await call('/api/v1/site/links/impact/linki_target/update-links', 'POST', editor, { to: `https://${HOST}/article/`, sources: [fx.items.a, pageId] });
    expect(res.status, await res.clone().text()).toBe(200);
    const data = ((await res.json()) as { data: { updated: Array<{ itemId: string }>; skipped: Array<{ itemId: string; reason: string }> } }).data;
    expect(data.updated.map((u) => u.itemId)).toEqual([fx.items.a]);
    expect(data.skipped).toEqual([{ itemId: pageId, reason: 'forbidden' }]);
    const [page] = await runSiteTransaction(db, fx.sites.a, (tx) => tx.select({ data: items.data }).from(items).where(eq(items.id, pageId)));
    expect((page!.data as { title: string }).title).toBe('<a href="/target/">t</a>');
    const [article] = await runSiteTransaction(db, fx.sites.a, (tx) => tx.select({ data: items.data }).from(items).where(eq(items.id, fx.items.a)));
    expect((article!.data as { title: string }).title).toBe(`<a href="https://${HOST}/article/">t</a>`);
  });
});
