import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { collections, fields, items, permissions, type Database } from '@heopress/database';
import { PermissionService } from '../services/permission-service';
import { createRuntime } from '@heopress/runtime/node';
import app from '../index';
import { setRuntimeFactory } from '../middleware/runtime';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { createCrossSiteFixture, SHARED, type CrossSiteFixture } from './helpers/cross-site-fixture';

/** `GET /site/items/:collection/:id/checks` (HeoPress P07a task 5.4): read rights, field limits, no outbound request. */

const JWT_SECRET = 'publish-checks-secret';

describe.skipIf(!hasDbIntegrationUrl)('pre-publish checks — HTTP', () => {
  let db: Database;
  let fx: CrossSiteFixture;
  let env: Record<string, unknown> = {};
  let runtime: ReturnType<typeof createRuntime>;

  beforeAll(async () => {
    db = await connectDbIntegration('publish-checks');
    env = { ...process.env, JWT_SECRET, HEOPRESS_ENV: 'development' };
    runtime = createRuntime(env);
    setRuntimeFactory(() => runtime);
  });
  beforeEach(async () => {
    fx = await createCrossSiteFixture(db, { prefix: 'pubchk', jwtSecret: JWT_SECRET });
    const site = fx.sites.a;
    const [coll] = await db.select({ id: collections.id }).from(collections).where(and(eq(collections.siteId, site), eq(collections.name, SHARED.collection)));
    await db.insert(fields).values([
      { siteId: site, collectionId: coll!.id, name: 'seo_description', type: 'text', interface: 'textarea' },
      { siteId: site, collectionId: coll!.id, name: 'body', type: 'text', interface: 'wysiwyg' },
    ]);
    await db
      .update(items)
      .set({ data: { title: 'A title that is long enough to pass', seo_description: 'SECRET DESCRIPTION TEXT', body: '<p><a href="https://elsewhere.example.org/">x</a><img src="/i.png"></p>' } })
      .where(eq(items.id, fx.items.a));
  });
  afterAll(async () => {
    setRuntimeFactory(null);
    if (fx) await fx.teardown();
  });

  const get = async (who: 'onlyA' | 'adminA' | 'onlyB', collection: string = SHARED.collection, id = fx.items.a) =>
    app.request(`/api/v1/site/items/${collection}/${id}/checks`, { headers: fx.headers('a', await fx.session(who, 'a')) }, env);
  type Body = { data: { checks: Array<{ id: string; status: string; items?: Array<{ status: string }> }> } };

  it('an editor gets every check; external links are not checked and nothing is fetched', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await get('onlyA');
    expect(res.status, await res.clone().text()).toBe(200);
    const { checks } = ((await res.json()) as Body).data;
    expect(checks.map((c) => c.id)).toEqual(['title', 'description', 'indexing', 'structured_data', 'links', 'images']);
    expect(checks.find((c) => c.id === 'links')!.items).toEqual([{ url: 'https://elsewhere.example.org/', status: 'not_checked' }]);
    expect(checks.find((c) => c.id === 'images')!.status).toBe('warn');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('a field the caller may not read: "no permission", and its text is not in the answer', async () => {
    await db.update(permissions).set({ fields: ['title', 'slug', 'path', 'body'] }).where(and(eq(permissions.siteId, fx.sites.a), eq(permissions.action, 'read'), eq(permissions.collection, SHARED.collection)));
    await PermissionService.bumpVersion(runtime.cache, fx.sites.a);
    const res = await get('onlyA');
    const text = await res.clone().text();
    expect(text).not.toContain('SECRET DESCRIPTION');
    expect(((await res.json()) as Body).data.checks.find((c) => c.id === 'description')!.status).toBe('no_permission');
  });

  it('no read grant, another site, a missing item: the same 404', async () => {
    await db.insert(collections).values({ siteId: fx.sites.a, name: 'locked', label: 'Locked' });
    expect((await get('onlyA', 'locked')).status).toBe(404);
    expect((await get('onlyA', SHARED.collection, 'does-not-exist')).status).toBe(404);
    // B's item asked for on A, and B's person on A.
    expect((await get('onlyA', SHARED.collection, fx.items.b)).status).toBe(404);
    expect([401, 403, 404]).toContain((await get('onlyB')).status);
  });
});
