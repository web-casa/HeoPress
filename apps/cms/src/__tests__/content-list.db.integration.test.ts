import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { collections, contentReviews, items, type Database } from '@heopress/database';
import { createRuntime } from '@heopress/runtime/node';
import app from '../index';
import { setRuntimeFactory } from '../middleware/runtime';
import { __resetPermissionProcessCacheForTests } from '../services/permission-service';
import type { ContentRow } from '../services/studio/content-list';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { createCrossSiteFixture, SHARED, type CrossSiteFixture } from './helpers/cross-site-fixture';

/** The review workspace's lists and decisions (HeoPress P07a tasks 5.3, 5.5). */

const JWT_SECRET = 'content-list-secret';

describe.skipIf(!hasDbIntegrationUrl)('review workspace — lists and decisions', () => {
  let db: Database;
  let fx: CrossSiteFixture;
  let env: Record<string, unknown> = {};
  let articles = '';

  beforeAll(async () => {
    db = await connectDbIntegration('content-list');
    env = { ...process.env, JWT_SECRET, HEOPRESS_ENV: 'development' };
    const runtime = createRuntime(env);
    setRuntimeFactory(() => runtime);
  });
  beforeEach(async () => {
    fx = await createCrossSiteFixture(db, { prefix: 'conlist', jwtSecret: JWT_SECRET });
    __resetPermissionProcessCacheForTests();
    const site = fx.sites.a;
    articles = (await db.select({ id: collections.id }).from(collections).where(and(eq(collections.siteId, site), eq(collections.name, SHARED.collection))))[0]!.id;
    await db.update(collections).set({ meta: { editorialWorkflow: true } }).where(eq(collections.id, articles));
    const [locked] = await db.insert(collections).values({ siteId: site, name: 'locked', label: 'Locked' }).returning({ id: collections.id });
    const mk = (title: string, extra: Partial<typeof items.$inferInsert> = {}) =>
      db.insert(items).values({ siteId: site, collectionId: articles, status: 'draft', data: { title, locale: 'en' }, ...extra }).returning({ id: items.id }).then((r) => r[0]!.id);
    const pending = await mk('Waiting one', { editorialState: 'in_review', userCreated: fx.users.onlyA.id });
    await db.insert(contentReviews).values({ siteId: site, itemId: pending, status: 'pending', requestedBy: fx.users.onlyA.id });
    await mk('Sent back to me', { editorialState: 'rejected', userCreated: fx.users.onlyA.id });
    await mk('Live one', { status: 'published', publishedAt: new Date() });
    await mk('Later one', { publishAt: new Date(Date.now() + 86_400_000) });
    await mk('Chinese draft', { data: { title: 'Chinese draft', locale: 'zh-CN' } });
    await db.insert(items).values({ siteId: site, collectionId: locked!.id, status: 'draft', data: { title: 'Secret locked' } });
  });
  afterAll(async () => {
    setRuntimeFactory(null);
    if (fx) await fx.teardown();
  });

  const list = async (who: 'onlyA' | 'adminA', query: string) => {
    const res = await app.request(`/api/v1/studio/content/items?${query}`, { headers: { ...fx.headers('a', await fx.session(who, 'a')), 'x-heopress-client': 'studio' } }, env);
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()) as { data: ContentRow[]; meta: { counts: Record<string, number>; nextCursor: string | null } };
  };
  const titles = (rows: ContentRow[]) => rows.map((r) => r.title).sort();

  it('views with counts, readable collections only', async () => {
    const r = await list('adminA', 'view=pending');
    expect(titles(r.data)).toEqual(['Waiting one']);
    expect(r.meta.counts).toMatchObject({ pending: 1, published: 1, scheduled: 1 });
    expect(titles((await list('adminA', 'view=drafts')).data)).toEqual(['Chinese draft', 'Hello from A', 'Secret locked', 'Sent back to me']);
    // The editor cannot read "locked".
    const editor = await list('onlyA', 'view=drafts');
    expect(JSON.stringify(editor)).not.toContain('Secret locked');
  });

  it('the inbox: reviews the caller may decide, and its own items sent back', async () => {
    expect(titles((await list('adminA', 'view=inbox')).data)).toEqual(['Waiting one']);
    // The editor has no review right: only what was sent back to it.
    expect(titles((await list('onlyA', 'view=inbox')).data)).toEqual(['Sent back to me']);
    expect(titles((await list('onlyA', 'view=mine')).data)).toEqual(['Sent back to me', 'Waiting one']);
  });

  it('filters by collection, author, language and title', async () => {
    expect(titles((await list('adminA', `view=drafts&locale=zh-CN`)).data)).toEqual(['Chinese draft']);
    expect(titles((await list('adminA', `view=mine&author=${fx.users.onlyA.id}`)).data)).toEqual([]);
    expect(titles((await list('adminA', `view=pending&author=${fx.users.onlyA.id}`)).data)).toEqual(['Waiting one']);
    expect(titles((await list('adminA', 'view=drafts&q=chinese')).data)).toEqual(['Chinese draft']);
    expect(titles((await list('adminA', 'view=drafts&collection=locked')).data)).toEqual(['Secret locked']);
  });

  it('task 5.5: sending back needs a reason; approve then publish that fails stays approved', async () => {
    const [waiting] = await db.select({ id: items.id, version: items.version }).from(items).where(and(eq(items.siteId, fx.sites.a), eq(items.editorialState, 'in_review')));
    const headers = { ...fx.headers('a', await fx.session('adminA', 'a')) };
    const reject = await app.request(`/api/v1/editorial/${SHARED.collection}/${waiting!.id}/reject`, { method: 'POST', headers, body: JSON.stringify({ reason: '  ' }) }, env);
    expect(reject.status).toBe(400);
    const approve = await app.request(`/api/v1/editorial/${SHARED.collection}/${waiting!.id}/approve`, { method: 'POST', headers, body: '{}' }, env);
    expect(approve.status, await approve.clone().text()).toBe(200);
    // Held items are published by no path: the publish step fails.
    await db.update(items).set({ hold: true } as never).where(eq(items.id, waiting!.id));
    const [now] = await db.select({ version: items.version }).from(items).where(eq(items.id, waiting!.id));
    const publish = await app.request(`/api/v1/items/${SHARED.collection}/${waiting!.id}`, { method: 'PATCH', headers, body: JSON.stringify({ status: 'published', expectedVersion: now!.version }) }, env);
    expect(publish.status).toBeGreaterThanOrEqual(400);
    const [after] = await db.select({ state: items.editorialState, status: items.status }).from(items).where(eq(items.id, waiting!.id));
    expect(after).toEqual({ state: 'approved', status: 'draft' });
    // The history shows the submission and the approval.
    const history = await app.request(`/api/v1/studio/content/items/${SHARED.collection}/${waiting!.id}/history`, { headers: { ...headers, 'x-heopress-client': 'studio' } }, env);
    const entries = ((await history.json()) as { data: Array<{ kind: string }> }).data.map((e) => e.kind);
    expect(entries).toEqual(['approved', 'submitted']);
  });

  it('spec "退回": sent back with a reason, the item is the author\'s draft again and the author reads the reason', async () => {
    const [waiting] = await db.select({ id: items.id }).from(items).where(and(eq(items.siteId, fx.sites.a), eq(items.editorialState, 'in_review')));
    const admin = fx.headers('a', await fx.session('adminA', 'a'));
    const res = await app.request(`/api/v1/editorial/${SHARED.collection}/${waiting!.id}/reject`, { method: 'POST', headers: admin, body: JSON.stringify({ reason: '补充数据来源' }) }, env);
    expect(res.status, await res.clone().text()).toBe(200);
    const [after] = await db.select({ state: items.editorialState, status: items.status }).from(items).where(eq(items.id, waiting!.id));
    expect(after).toEqual({ state: 'rejected', status: 'draft' });
    // The author (who may read the item) sees the reason in the history, and the item in its inbox.
    const history = await app.request(`/api/v1/studio/content/items/${SHARED.collection}/${waiting!.id}/history`, { headers: { ...fx.headers('a', await fx.session('onlyA', 'a')), 'x-heopress-client': 'studio' } }, env);
    expect(history.status).toBe(200);
    expect(((await history.json()) as { data: Array<{ kind: string; reason: string | null }> }).data[0]).toMatchObject({ kind: 'rejected', reason: '补充数据来源' });
    expect(titles((await list('onlyA', 'view=inbox')).data)).toContain('Waiting one');
  });
});
