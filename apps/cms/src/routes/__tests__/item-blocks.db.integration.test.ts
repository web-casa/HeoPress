import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { collections, fields, items, roles, sites, userSites, users, type Database } from '@heopress/database';
import type { AppEnv } from '../../env';
import { ItemService } from '../../services/item-service';
import { itemsRouter } from '../items';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';

/**
 * Blocks with stable IDs, through the API (HeoPress P04 tasks 4.1, 4.2; spec
 * content/block-identity): saving assigns IDs that survive edits, a copy gets
 * a new ID, and one block can be replaced by its ID — version-checked, with
 * every other block and ID unchanged.
 */

const SITE = 'site_blocks_it';
const ADMIN = 'usr_blocks_admin';

type AuthVar = AppEnv['Variables']['auth'];
type ItemBody = { data: { version: number; data: { body: string; faq: Array<Record<string, unknown>> } } };
type ErrorBody = { errors: Array<{ code: string }> };

const ids = (html: string) => [...html.matchAll(/data-block-id="([^"]+)"/g)].map((m) => m[1]!);

describe.skipIf(!hasDbIntegrationUrl)('stable block IDs — DB integration', () => {
  let db: Database;
  const auth = { type: 'user', userId: ADMIN, email: 'blocks@example.test', roles: [], raw: {} } as AuthVar;
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
    db = await connectDbIntegration('item-blocks');
  });
  afterAll(async () => {
    if (!db) return;
    await db.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
    await db.delete(users).where(eq(users.id, ADMIN)).catch(() => undefined);
  });

  let itemId = '';
  const req = (method: string, path: string, body?: unknown) =>
    app.request(`/api/v1/items/articles/${itemId}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const read = async () => ((await (await req('GET', '')).json()) as ItemBody).data;

  beforeEach(async () => {
    await db.delete(sites).where(eq(sites.id, SITE));
    await db.insert(sites).values({ id: SITE, name: 'Blocks IT' });
    await db.insert(users).values({ id: ADMIN, email: 'blocks@example.test', status: 'active' }).onConflictDoNothing();
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
      { siteId: SITE, collectionId: coll!.id, name: 'title', type: 'string', interface: 'input' },
      { siteId: SITE, collectionId: coll!.id, name: 'body', type: 'text', interface: 'wysiwyg' },
      { siteId: SITE, collectionId: coll!.id, name: 'faq', type: 'json', interface: 'repeater' },
    ]);
    const created = await new ItemService({ db, siteId: SITE }).create('articles', {
      data: { title: 't', body: '<p>One</p><p>Two</p><p>Three</p>', faq: [{ q: 'a' }, { q: 'b' }] },
    });
    itemId = (created as { id: string }).id;
  });

  it('saving assigns IDs; editing text keeps them; a copied block gets a new one', async () => {
    const first = await read();
    const before = ids(first.data.body);
    expect(before).toHaveLength(3);
    expect(first.data.faq.map((r) => r._blockId)).toEqual([expect.any(String), expect.any(String)]);

    const edited = first.data.body.replace('>Two<', '>Two, edited<');
    const copy = edited.match(/<p data-block-id="[^"]+">One<\/p>/)![0];
    const res = await req('PATCH', '', { data: { body: edited.replace(copy, copy + copy) }, expectedVersion: first.version });
    expect(res.status).toBe(200);
    const after = ids((await read()).data.body);
    expect(after).toHaveLength(4);
    expect(after[0]).toBe(before[0]);
    expect(after[1]).not.toBe(before[0]); // the copy
    expect(after.slice(2)).toEqual(before.slice(1)); // edited "Two" kept its ID
  });

  it('an agent replaces one paragraph by its ID: only that block changes', async () => {
    const item = await read();
    const [a, b, c] = ids(item.data.body);
    const res = await req('PATCH', `/blocks/body/${b}`, { block: '<p>Two, by the agent</p>', expectedVersion: item.version });
    expect(res.status).toBe(200);
    const now = await read();
    expect(ids(now.data.body)).toEqual([a, b, c]);
    expect(now.data.body).toBe(item.data.body.replace(`<p data-block-id="${b}">Two</p>`, `<p data-block-id="${b}">Two, by the agent</p>`));
    expect(now.data.faq).toEqual(item.data.faq);
  });

  it('repeater rows are blocks too', async () => {
    const item = await read();
    const row = item.data.faq[1]!;
    const res = await req('PATCH', `/blocks/faq/${row._blockId}`, { block: { q: 'b2' }, expectedVersion: item.version });
    expect(res.status).toBe(200);
    expect((await read()).data.faq).toEqual([item.data.faq[0], { q: 'b2', _blockId: row._blockId }]);
  });

  it('an old version is a 409; a missing version 428; an unknown ID 404; another block’s ID 400', async () => {
    const item = await read();
    const [a, b] = ids(item.data.body);
    await req('PATCH', '', { data: { title: 'moved on' }, expectedVersion: item.version });
    const stale = await req('PATCH', `/blocks/body/${a}`, { block: '<p>x</p>', expectedVersion: item.version });
    expect(stale.status).toBe(409);
    expect((await req('PATCH', `/blocks/body/${a}`, { block: '<p>x</p>' })).status).toBe(428);
    const v = (await read()).version;
    const missing = await req('PATCH', '/blocks/body/b_unknown', { block: '<p>x</p>', expectedVersion: v });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as ErrorBody).errors[0]!.code).toBe('BLOCK_NOT_FOUND');
    const foreign = await req('PATCH', `/blocks/body/${a}`, { block: `<p data-block-id="${b}">x</p>`, expectedVersion: v });
    expect(foreign.status).toBe(400);
    expect(((await foreign.json()) as ErrorBody).errors[0]!.code).toBe('DUPLICATE_BLOCK_ID');
    expect((await req('PATCH', `/blocks/title/${a}`, { block: 'x', expectedVersion: v })).status).toBe(400);
  });

  it('a duplicated ID in stored content cannot be targeted', async () => {
    // Content written before IDs were enforced (or by hand) may repeat an ID.
    await db.update(items).set({ data: { body: '<p data-block-id="b_dup">1</p><p data-block-id="b_dup">2</p>' } }).where(eq(items.id, itemId));
    const v = (await read()).version;
    const res = await req('PATCH', '/blocks/body/b_dup', { block: '<p>x</p>', expectedVersion: v });
    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrorBody).errors[0]!.code).toBe('DUPLICATE_BLOCK_ID');
  });
});
