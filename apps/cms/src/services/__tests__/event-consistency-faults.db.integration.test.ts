import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import type { SearchProvider } from '@heopress/runtime';
import {
  cdcChangeEvents,
  collections,
  eventConsumers,
  fields,
  itemIdempotencyKeys,
  items,
  roles,
  sites,
  userSites,
  users,
  type Database,
} from '@heopress/database';
import type { AppEnv } from '../../env';
import { itemsRouter } from '../../routes/items';
import { ItemService } from '../item-service';
import { ContentVersionService } from '../content-version-service';
import { searchSyncConsumer } from '../content-indexing-worker';
import { EventConsumerRunner, type EventConsumerDefinition, type ChangeEvent } from '../../modules/events/consumer-runner';
import { registerEventConsumers } from '../../modules/events/consumer-worker';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';

/**
 * Event consistency under faults (HeoPress P04 task 9.2): a committed write
 * whose response was lost is not repeated by the client's retry
 * (Idempotency-Key); a consumer that did its work but died before confirming
 * does not repeat the side effect; events handled out of order never put an
 * older version back; one consumer that keeps failing does not hold back the
 * others.
 */

const SITE = 'site_event_faults_it';
const ADMIN = 'usr_event_faults_admin';

describe.skipIf(!hasDbIntegrationUrl)('event consistency under faults — DB integration', () => {
  let db: Database;
  let raw: postgres.Sql;
  const auth = { type: 'user', userId: ADMIN, email: 'faults@example.test', roles: [], raw: {} } as AppEnv['Variables']['auth'];
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
    db = await connectDbIntegration('event-faults');
    raw = postgres(process.env.DATABASE_URL!, { max: 2, onnotice: () => {} });
  });
  afterAll(async () => {
    if (db) {
      await db.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
      await db.delete(users).where(eq(users.id, ADMIN)).catch(() => undefined);
      await db.execute(sql`DELETE FROM lumibase_event_consumers WHERE name LIKE 'test-faults:%'`);
    }
    await raw?.end({ timeout: 1 });
  });
  beforeEach(async () => {
    await db.delete(sites).where(eq(sites.id, SITE));
    await db.insert(sites).values({ id: SITE, name: 'Event faults IT' });
    await db.insert(users).values({ id: ADMIN, email: 'faults@example.test', status: 'active' }).onConflictDoNothing();
    const [role] = await db.insert(roles).values({ siteId: SITE, name: 'Admin', adminAccess: true, appAccess: true }).returning({ id: roles.id });
    await db.insert(userSites).values({ userId: ADMIN, siteId: SITE, roleId: role!.id });
    const [coll] = await db.insert(collections).values({ siteId: SITE, name: 'articles', label: 'Articles' }).returning({ id: collections.id });
    await db.insert(fields).values({ siteId: SITE, collectionId: coll!.id, name: 'title', type: 'string', interface: 'input' });
  });

  const send = (method: string, path: string, body: unknown, key?: string) =>
    app.request(`/api/v1/items/articles${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) },
      body: JSON.stringify(body),
    });
  const siteEvents = () => db.select().from(cdcChangeEvents).where(eq(cdcChangeEvents.siteId, SITE));

  it('a lost response and a retry with the same Idempotency-Key: one create, one update', async () => {
    const first = await send('POST', '', { data: { title: 'once' } }, 'create-1');
    expect(first.status).toBe(201);
    const created = ((await first.json()) as { data: { id: string } }).data;
    // The response never reached the client; it retries the same request.
    const retry = await send('POST', '', { data: { title: 'once' } }, 'create-1');
    expect(retry.status).toBe(200);
    expect(retry.headers.get('idempotent-replayed')).toBe('true');
    expect(((await retry.json()) as { data: { id: string } }).data.id).toBe(created.id);
    expect(await db.select({ id: items.id }).from(items).where(eq(items.siteId, SITE))).toHaveLength(1);

    const reused = await send('POST', '', { data: { title: 'something else' } }, 'create-1');
    expect(reused.status).toBe(422);

    const edit = await send('PATCH', `/${created.id}`, { data: { title: 'edited' }, expectedVersion: 1 }, 'edit-1');
    expect(edit.status).toBe(200);
    const editRetry = await send('PATCH', `/${created.id}`, { data: { title: 'edited' }, expectedVersion: 1 }, 'edit-1');
    expect(editRetry.status).toBe(200); // not a 409: it is the same, already applied write
    expect(editRetry.headers.get('idempotent-replayed')).toBe('true');
    const [row] = await db.select().from(items).where(eq(items.id, created.id));
    expect(row!.version).toBe(2);
    expect((await siteEvents()).map((e) => e.operation).sort()).toEqual(['create', 'update']);
  });

  it('a consumer that did its work but died before confirming does not repeat the side effect', async () => {
    // The external system: it applies an effect once per idempotency key.
    const effects: string[] = [];
    const seenKeys = new Set<string>();
    const external = (key: string) => {
      if (seenKeys.has(key)) return;
      seenKeys.add(key);
      effects.push(key);
    };
    let calls = 0;
    let dieAfterEffect = true;
    const def: EventConsumerDefinition = {
      name: `test-faults:effects:${Date.now()}`,
      siteId: SITE,
      handle: async (_e, ctx) => {
        calls += 1;
        external(ctx.idempotencyKey);
        if (dieAfterEffect) await new Promise(() => {}); // effect done, process dies before confirming
      },
    };
    const runner = new EventConsumerRunner(db);
    await runner.register(def);
    await new ItemService({ db, siteId: SITE }).create('articles', { data: { title: 'x' } });
    void runner.runOnce(def);
    await new Promise((r) => setTimeout(r, 300));
    dieAfterEffect = false;
    await db.update(eventConsumers).set({ leaseUntil: new Date(Date.now() - 1000) }).where(eq(eventConsumers.name, def.name));
    await new EventConsumerRunner(db).runOnce(def);
    expect(calls).toBe(2); // delivered again (at least once)…
    expect(effects).toHaveLength(1); // …with the same key, so the effect happened once
    expect(seenKeys.size).toBe(1);
  });

  it('events handled out of order never put an older version into the search index', async () => {
    const docs = new Map<string, Record<string, unknown>>();
    const search = {
      configureIndex: async () => {},
      index: async (_index: string, list: Array<Record<string, unknown>>) => {
        for (const d of list) docs.set(String(d.id), d);
      },
      delete: async (_index: string, ids: string[]) => {
        for (const id of ids) docs.delete(id);
      },
    } as unknown as SearchProvider;
    const consumer = searchSyncConsumer({ db, search });
    const svc = new ItemService({ db, siteId: SITE });
    const { id } = (await svc.create('articles', { data: { title: 'v1' } })) as { id: string };
    await svc.patch('articles', id, { data: { title: 'v2' }, expectedVersion: 1 });
    await svc.patch('articles', id, { data: { title: 'v3' }, expectedVersion: 2 });
    const events = (await db.execute(sql`
      SELECT id, site_id, resource, collection, item_id, operation, payload, changed_fields, item_version,
             actor_type, actor_id, source, occurred_at, txid::text AS txid, seq
        FROM lumibase_cdc_change_events WHERE site_id = ${SITE} AND item_id = ${id} ORDER BY seq DESC`)) as unknown as Array<Record<string, unknown>>;
    // Newest first: v3, v2, then the create.
    for (const r of events) {
      await consumer.handle!(
        { ...r, siteId: String(r.site_id), itemId: String(r.item_id), collection: String(r.collection), resource: String(r.resource) } as unknown as ChangeEvent,
        { idempotencyKey: 'k', attempt: 1 },
      );
    }
    expect(JSON.stringify(docs.get(id))).toContain('v3');
  });

  it('one consumer that keeps failing does not hold back another', async () => {
    const good: string[] = [];
    const failing: EventConsumerDefinition = {
      name: `test-faults:failing:${Date.now()}`,
      siteId: SITE,
      maxAttempts: 1000,
      retryBaseMs: 0,
      handle: async () => {
        throw new Error('always down');
      },
    };
    const healthy: EventConsumerDefinition = {
      name: `test-faults:healthy:${Date.now()}`,
      siteId: SITE,
      handle: async (e) => {
        good.push(e.itemId);
      },
    };
    const runner = new EventConsumerRunner(db);
    await runner.register(failing);
    await runner.register(healthy);
    const svc = new ItemService({ db, siteId: SITE });
    const ids: string[] = [];
    for (const t of ['a', 'b', 'c']) ids.push(((await svc.create('articles', { data: { title: t } })) as { id: string }).id);
    const stop = registerEventConsumers({ db, consumers: () => [failing, healthy], tickMs: 50 });
    try {
      const deadline = Date.now() + 5000;
      while (good.length < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    } finally {
      stop();
    }
    expect(good).toEqual(ids);
    const [f] = await db.select().from(eventConsumers).where(and(eq(eventConsumers.name, failing.name)));
    expect(f!.cursorSeq).toBeNull(); // still at its first event
  });
  it('#12 a key whose day has passed is a new request: it creates again (201)', async () => {
    const first = await send('POST', '', { data: { title: 'day one' } }, 'old-key');
    expect(first.status).toBe(201);
    await db
      .update(itemIdempotencyKeys)
      .set({ createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })
      .where(eq(itemIdempotencyKeys.siteId, SITE));
    const again = await send('POST', '', { data: { title: 'day two' } }, 'old-key');
    expect(again.status).toBe(201);
    expect(again.headers.get('idempotent-replayed')).toBeNull();
    expect(await db.select({ id: items.id }).from(items).where(eq(items.siteId, SITE))).toHaveLength(2);
  });

  it('#13 the same keyed PATCH sent twice at once: one write, both answered 200', async () => {
    const created = ((await (await send('POST', '', { data: { title: 'v1' } })).json()) as { data: { id: string } }).data;
    const body = { data: { title: 'together' }, expectedVersion: 1 };
    const [a, b] = await Promise.all([send('PATCH', `/${created.id}`, body, 'same-edit'), send('PATCH', `/${created.id}`, body, 'same-edit')]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const [row] = await db.select().from(items).where(eq(items.id, created.id));
    expect(row!.version).toBe(2);
    expect((await siteEvents()).filter((e) => e.operation === 'update')).toHaveLength(1);
  });

  it('Codex P04-3 #10: the same key sent at once with different bodies — one creates, the other is told the key was reused', async () => {
    const [a, b] = await Promise.all([
      send('POST', '', { data: { title: 'first body' } }, 'race-key'),
      send('POST', '', { data: { title: 'second body' } }, 'race-key'),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 422]);
    const loser = a.status === 422 ? a : b;
    expect(((await loser.json()) as { errors: Array<{ code: string }> }).errors[0]!.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await db.select({ id: items.id }).from(items).where(eq(items.siteId, SITE))).toHaveLength(1);
  });

  it('#4 content versions, crypto-shred and pin release each write their change event', async () => {
    const svc = new ItemService({ db, siteId: SITE });
    const { id } = (await svc.create('articles', { data: { title: 'base' } })) as { id: string };
    const versions = new ContentVersionService({ db, siteId: SITE, userId: null, items: svc });
    await versions.create('articles', id, 'draft-a', 'Draft A');
    await versions.remove('articles', id, 'draft-a');
    const resources = (await siteEvents()).map((e) => `${e.resource}:${e.operation}`);
    expect(resources).toEqual(expect.arrayContaining(['content_version:create', 'content_version:delete']));

    await db.update(items).set({ pinnedFields: ['title'] }).where(eq(items.id, id));
    const before = (await siteEvents()).length;
    await svc.releasePin('articles', id, 'title');
    expect(await siteEvents()).toHaveLength(before + 1);
    await svc.cryptoShred('articles', id);
    const last = (await siteEvents()).filter((e) => e.itemId === id && (e.changedFields as string[] | null)?.includes('$encryption'));
    expect(last).toHaveLength(1);
  });

  it('#6 a consumer stuck inside its handler does not hold back another', async () => {
    const good: string[] = [];
    const stuck: EventConsumerDefinition = {
      name: `test-faults:stuck:${Date.now()}`,
      siteId: SITE,
      handle: () => new Promise(() => {}),
    };
    const healthy: EventConsumerDefinition = {
      name: `test-faults:healthy2:${Date.now()}`,
      siteId: SITE,
      handle: async (e) => {
        good.push(e.itemId);
      },
    };
    const runner = new EventConsumerRunner(db);
    await runner.register(stuck);
    await runner.register(healthy);
    const svc = new ItemService({ db, siteId: SITE });
    const ids: string[] = [];
    for (const t of ['a', 'b']) ids.push(((await svc.create('articles', { data: { title: t } })) as { id: string }).id);
    const stop = registerEventConsumers({ db, consumers: () => [stuck, healthy], tickMs: 50 });
    try {
      const deadline = Date.now() + 5000;
      while (good.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    } finally {
      stop();
    }
    expect(good).toEqual(ids);
  });

  it('#14 search sync starts from the oldest kept event, so items written before it was registered are indexed', async () => {
    const svc = new ItemService({ db, siteId: SITE });
    const { id } = (await svc.create('articles', { data: { title: 'before registration' } })) as { id: string };
    const docs = new Map<string, unknown>();
    const search = {
      configureIndex: async () => {},
      index: async (_i: string, list: Array<Record<string, unknown>>) => {
        for (const d of list) docs.set(String(d.id), d);
      },
      delete: async () => {},
    } as unknown as SearchProvider;
    const consumer = { ...searchSyncConsumer({ db, search }), name: `test-faults:search:${Date.now()}`, siteId: SITE };
    const runner = new EventConsumerRunner(db);
    await runner.register(consumer);
    await runner.runOnce(consumer);
    expect(docs.has(id)).toBe(true);
  });
});
