import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq, inArray } from 'drizzle-orm';
import { collections, fields, items, roles, sites, userSites, users, type Database } from '@heopress/database';
import type { AppEnv } from '../../env';
import { ItemService } from '../../services/item-service';
import { itemsRouter } from '../items';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';

/**
 * Bulk operations report each entry (HeoPress P04 task 3.2; spec
 * content/write-concurrency "批量操作逐条结果"): publishing five articles of
 * which one is already published, one held, one stale and one invalid gives
 * succeeded, unchanged, blocked, conflict and failed — and the one that
 * succeeded is published.
 */

const SITE = 'site_bulk_results_it';
const ADMIN = 'usr_bulk_results_admin';

type AuthVar = AppEnv['Variables']['auth'];
type BulkBody = {
  data: Array<{ index: number; id: string | null; status: string; code?: string }>;
  meta: Record<string, number>;
};

describe.skipIf(!hasDbIntegrationUrl)('bulk operations report each entry — DB integration', () => {
  let db: Database;
  const auth = { type: 'user', userId: ADMIN, email: 'bulk@example.test', roles: [], raw: {} } as AuthVar;
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    (c as unknown as { env: Record<string, unknown> }).env = {};
    c.set('db', db);
    c.set('siteId', SITE);
    c.set('auth', auth);
    c.set('runtime', { cache: undefined, search: undefined, queue: undefined } as unknown as AppEnv['Variables']['runtime']);
    await next();
  });
  app.route('/api/v1/items', itemsRouter);

  beforeAll(async () => {
    db = await connectDbIntegration('item-bulk-results');
  });
  afterAll(async () => {
    if (!db) return;
    await db.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
    await db.delete(users).where(eq(users.id, ADMIN)).catch(() => undefined);
  });

  const svc = () => new ItemService({ db, siteId: SITE });
  const bulk = (op: string, entries: unknown[]) =>
    app.request('/api/v1/items/articles/bulk', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op, items: entries }),
    });
  const make = async (title: string) => ((await svc().create('articles', { data: { title } })) as { id: string }).id;

  beforeEach(async () => {
    await db.delete(sites).where(eq(sites.id, SITE));
    await db.insert(sites).values({ id: SITE, name: 'Bulk results IT' });
    await db.insert(users).values({ id: ADMIN, email: 'bulk@example.test', status: 'active' }).onConflictDoNothing();
    const [role] = await db
      .insert(roles)
      .values({ siteId: SITE, name: 'Admin', adminAccess: true, appAccess: true })
      .returning({ id: roles.id });
    await db.insert(userSites).values({ userId: ADMIN, siteId: SITE, roleId: role!.id });
    const [coll] = await db
      .insert(collections)
      .values({ siteId: SITE, name: 'articles', label: 'Articles' })
      .returning({ id: collections.id });
    await db.insert(fields).values([
      { siteId: SITE, collectionId: coll!.id, name: 'title', type: 'string', interface: 'input', required: true },
    ]);
  });

  it('publishing five articles: succeeded, unchanged, blocked, conflict, failed — in order', async () => {
    const [fresh, alreadyLive, held, stale, invalid] = await Promise.all(['a', 'b', 'c', 'd', 'e'].map(make));
    await svc().patch('articles', alreadyLive!, { status: 'published', expectedVersion: 1 });
    await svc().setHold('articles', held!, true, 1);
    await svc().patch('articles', stale!, { data: { title: 'edited meanwhile' }, expectedVersion: 1 });

    const res = await bulk('publish', [
      { id: fresh, expectedVersion: 1 },
      { id: alreadyLive, expectedVersion: 2 },
      { id: held, expectedVersion: 2 },
      { id: stale, expectedVersion: 1 },
      { id: invalid }, // no version: refused before anything is written
    ]);
    expect(res.status).toBe(207);
    const body = (await res.json()) as BulkBody;
    expect(body.data.map((r) => [r.id, r.status, r.code])).toEqual([
      [fresh, 'succeeded', undefined],
      [alreadyLive, 'unchanged', 'ALREADY_PUBLISHED'],
      [held, 'blocked', 'ITEM_HELD'],
      [stale, 'conflict', 'VERSION_CONFLICT'],
      [invalid, 'failed', 'VERSION_REQUIRED'],
    ]);
    expect(body.meta).toEqual({ succeeded: 1, unchanged: 1, blocked: 1, conflict: 1, failed: 1 });

    const rows = await db
      .select({ id: items.id, status: items.status })
      .from(items)
      .where(inArray(items.id, [fresh!, held!, stale!, invalid!]));
    const status = Object.fromEntries(rows.map((r) => [r.id, r.status]));
    expect(status).toEqual({ [fresh!]: 'published', [held!]: 'draft', [stale!]: 'draft', [invalid!]: 'draft' });
  });

  it('a failing entry does not undo the others; all fine is 200', async () => {
    const [a, b] = await Promise.all(['a', 'b'].map(make));
    const mixed = await bulk('update', [
      { id: a, title: 'updated', expectedVersion: 1 },
      { id: b, title: { not: 'a string' }, expectedVersion: 1 }, // wrong type
      { id: 'missing', title: 'x', expectedVersion: 1 },
    ]);
    expect(mixed.status).toBe(207);
    const body = (await mixed.json()) as BulkBody;
    expect(body.data.map((r) => r.status)).toEqual(['succeeded', 'failed', 'failed']);
    expect(body.data[2]!.code).toBe('NOT_FOUND');
    expect((await db.select({ data: items.data }).from(items).where(eq(items.id, a!)))[0]!.data).toEqual({ title: 'updated' });

    const ok = await bulk('update', [{ id: b, title: 'fine', expectedVersion: 1 }]);
    expect(ok.status).toBe(200);
  });

  it('bulk create reports invalid entries and still creates the valid ones', async () => {
    const res = await bulk('create', [{ title: 'one' }, { title: { not: 'a string' } }, { title: 'three' }]);
    expect(res.status).toBe(207);
    const body = (await res.json()) as BulkBody;
    expect(body.data.map((r) => [r.index, r.status])).toEqual([
      [0, 'succeeded'],
      [1, 'failed'],
      [2, 'succeeded'],
    ]);
    const created = await db.select({ id: items.id }).from(items).where(eq(items.siteId, SITE));
    expect(created).toHaveLength(2);
  });
});
