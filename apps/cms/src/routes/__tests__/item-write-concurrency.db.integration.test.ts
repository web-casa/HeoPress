import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { collections, fields, items, roles, sites, userSites, users, type Database } from '@heopress/database';
import type { AppEnv } from '../../env';
import { ItemService } from '../../services/item-service';
import { itemsRouter } from '../items';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';

/**
 * Version-checked updates (HeoPress P04 task 1.1; spec content/write-concurrency
 * "基于版本的条件更新"): two clients that read the same version — the second
 * save gets 409 with the current version and the changed fields, and nothing
 * of it is written; an update without a version gets 428; the check is atomic
 * under truly concurrent saves.
 */

const SITE = 'site_write_conc_it';
const ADMIN = 'usr_write_conc_admin';

type AuthVar = AppEnv['Variables']['auth'];
type ItemBody = { data: { id: string; version: number; data: Record<string, unknown>; status: string } };
type ErrorBody = { errors: Array<{ code: string; meta?: { currentVersion: number; changedFields: string[] } }> };

describe.skipIf(!hasDbIntegrationUrl)('item updates are version-checked — DB integration', () => {
  let db: Database;
  const auth = { userId: ADMIN, email: 'write-conc@example.test', roles: ['admin'], raw: { dev: true } } as AuthVar;

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
    db = await connectDbIntegration('item-write-concurrency');
  });
  afterAll(async () => {
    if (!db) return;
    await db.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
    await db.delete(users).where(eq(users.id, ADMIN)).catch(() => undefined);
  });

  let itemId = '';
  const url = () => `/api/v1/items/articles/${itemId}`;

  beforeEach(async () => {
    await db.delete(sites).where(eq(sites.id, SITE));
    await db.insert(sites).values({ id: SITE, name: 'Write concurrency IT' });
    await db.insert(users).values({ id: ADMIN, email: 'write-conc@example.test', status: 'active' }).onConflictDoNothing();
    const [adminRole] = await db
      .insert(roles)
      .values({ siteId: SITE, name: 'Admin', adminAccess: true, appAccess: true })
      .returning({ id: roles.id });
    await db.insert(userSites).values({ userId: ADMIN, siteId: SITE, roleId: adminRole!.id });
    const [coll] = await db
      .insert(collections)
      .values({ siteId: SITE, name: 'articles', label: 'Articles' })
      .returning({ id: collections.id });
    await db.insert(fields).values([
      { siteId: SITE, collectionId: coll!.id, name: 'title', type: 'string', interface: 'input' },
      { siteId: SITE, collectionId: coll!.id, name: 'body', type: 'text', interface: 'input' },
    ]);
    const created = await new ItemService({ db, siteId: SITE }).create('articles', { data: { title: 'v1', body: 'b1' } });
    itemId = (created as { id: string }).id;
  });

  const send = (method: 'PATCH' | 'PUT', body: unknown, headers: Record<string, string> = {}) =>
    app.request(url(), { method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  async function stored() {
    const [row] = await db.select().from(items).where(eq(items.id, itemId));
    return row!;
  }

  it('a new item starts at version 1, and a read carries it as an ETag', async () => {
    const res = await app.request(url());
    expect(res.status).toBe(200);
    expect(((await res.json()) as ItemBody).data.version).toBe(1);
    expect(res.headers.get('etag')).toBe('"1"');
  });

  it('two clients on version 1: the first save wins, the second gets 409 and writes nothing', async () => {
    const first = await send('PATCH', { data: { title: 'from A' }, expectedVersion: 1 });
    expect(first.status).toBe(200);
    expect(((await first.json()) as ItemBody).data.version).toBe(2);
    expect(first.headers.get('etag')).toBe('"2"');

    const second = await send('PATCH', { data: { body: 'from B' }, status: 'published', expectedVersion: 1 });
    expect(second.status).toBe(409);
    const err = ((await second.json()) as ErrorBody).errors[0]!;
    expect(err.code).toBe('VERSION_CONFLICT');
    expect(err.meta).toEqual({ currentVersion: 2, changedFields: ['title'] });

    const row = await stored();
    expect(row.version).toBe(2);
    expect(row.data).toEqual({ title: 'from A', body: 'b1' });
    expect(row.status).toBe('draft');
  });

  it('If-Match carries the version as well (weak form accepted); a mismatch with the body is a 400', async () => {
    const ok = await send('PATCH', { data: { title: 'via header' } }, { 'if-match': '"1"' });
    expect(ok.status).toBe(200);
    const weak = await send('PATCH', { data: { title: 'via weak header' } }, { 'if-match': 'W/"2"' });
    expect(weak.status).toBe(200);
    const stale = await send('PATCH', { data: { title: 'stale' } }, { 'if-match': '"2"' });
    expect(stale.status).toBe(409);
    const mixed = await send('PATCH', { data: { title: 'x' }, expectedVersion: 3 }, { 'if-match': '"2"' });
    expect(mixed.status).toBe(400);
    const garbage = await send('PATCH', { data: { title: 'x' } }, { 'if-match': '*' });
    expect(garbage.status).toBe(400);
    expect((await stored()).data).toEqual({ title: 'via weak header', body: 'b1' });
  });

  it('an update without a version is refused with 428 (PATCH and PUT), content unchanged', async () => {
    const patch = await send('PATCH', { data: { title: 'blind' } });
    expect(patch.status).toBe(428);
    expect(((await patch.json()) as ErrorBody).errors[0]!.code).toBe('VERSION_REQUIRED');
    const put = await send('PUT', { data: { title: 'blind' } });
    expect(put.status).toBe(428);
    const row = await stored();
    expect(row.version).toBe(1);
    expect(row.data).toEqual({ title: 'v1', body: 'b1' });
  });

  it('PUT is version-checked like PATCH', async () => {
    expect((await send('PUT', { data: { title: 'replaced' }, expectedVersion: 1 })).status).toBe(200);
    expect((await send('PUT', { data: { title: 'again' }, expectedVersion: 1 })).status).toBe(409);
    expect((await stored()).data).toMatchObject({ title: 'replaced' });
  });

  it('truly concurrent saves on one version: exactly one succeeds', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => send('PATCH', { data: { title: `writer ${i}` }, expectedVersion: 1 })),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(7);
    const row = await stored();
    expect(row.version).toBe(2);
    // One revision for the one write that happened.
    const revs = await new ItemService({ db, siteId: SITE }).listRevisions('articles', itemId);
    expect(revs.filter((r) => r.itemVersion === 2)).toHaveLength(1);
  });

  it('reverting a revision is version-checked too', async () => {
    await send('PATCH', { data: { title: 'v2' }, expectedVersion: 1 });
    const [rev] = await new ItemService({ db, siteId: SITE }).listRevisions('articles', itemId);
    const revert = (body: unknown) =>
      app.request(`${url()}/revert/${rev!.id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect((await revert({})).status).toBe(428);
    expect((await revert({ expectedVersion: 1 })).status).toBe(409);
    expect((await revert({ expectedVersion: 2 })).status).toBe(200);
    expect((await stored()).version).toBe(3);
  });
});
