import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import {
  activity,
  apiKeyPolicies,
  apiKeys,
  collections,
  fields,
  items,
  permissions,
  policies,
  releaseItems,
  releases,
  rolePolicies,
  roles,
  sites,
  userSites,
  users,
  type Database,
} from '@heopress/database';
import type { AppEnv } from '../../env';
import { ItemService } from '../../services/item-service';
import { ReleaseService } from '../../services/release-service';
import { ContentVersionService } from '../../services/content-version-service';
import { sweepDuePublish } from '../../services/scheduler-worker';
import { itemsRouter } from '../items';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';

/**
 * Hold (HeoPress P04 tasks 2.1, 2.2; spec content/write-concurrency
 * "Hold 阻止所有发布路径"): a held item is published by no path — a manual
 * save, an agent, Releases, scheduled publishing, promoting a branch — and only
 * a person with publish permission releases the hold (API keys, agents and
 * people without publish permission get 403).
 */

const SITE = 'site_hold_it';
const ADMIN = 'usr_hold_admin';
const WRITER = 'usr_hold_writer';
const KEY = 'key_hold_admin';

type AuthVar = AppEnv['Variables']['auth'];
type ErrorBody = { errors: Array<{ code: string }> };

describe.skipIf(!hasDbIntegrationUrl)('Hold blocks every publish path — DB integration', () => {
  let db: Database;
  let currentAuth: AuthVar;

  const humanAdmin = { type: 'user', userId: ADMIN, email: 'hold-admin@example.test', roles: [], raw: {} } as AuthVar;
  // May update titles only: not allowed to set `status`, so not allowed to publish.
  const writer = { type: 'user', userId: WRITER, email: 'hold-writer@example.test', roles: [], raw: {} } as AuthVar;
  const apiKey = { type: 'api_key', apiKeyId: KEY, apiKey: { id: KEY }, raw: {} } as unknown as AuthVar;

  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    (c as unknown as { env: Record<string, unknown> }).env = {};
    c.set('db', db);
    c.set('siteId', SITE);
    c.set('auth', currentAuth);
    c.set('runtime', { cache: undefined, search: undefined, queue: undefined } as unknown as AppEnv['Variables']['runtime']);
    await next();
  });
  app.route('/api/v1/items', itemsRouter);

  beforeAll(async () => {
    db = await connectDbIntegration('item-hold');
  });
  afterAll(async () => {
    if (!db) return;
    await db.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
    await db.delete(users).where(eq(users.id, ADMIN)).catch(() => undefined);
    await db.delete(users).where(eq(users.id, WRITER)).catch(() => undefined);
  });

  let itemId = '';
  const svc = () => new ItemService({ db, siteId: SITE });
  const url = (suffix = '') => `/api/v1/items/articles/${itemId}${suffix}`;
  const call = (method: string, path: string, body: unknown) =>
    app.request(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const version = async () => (await db.select({ v: items.version }).from(items).where(eq(items.id, itemId)))[0]!.v;
  const row = async () => (await db.select().from(items).where(eq(items.id, itemId)))[0]!;

  beforeEach(async () => {
    currentAuth = humanAdmin;
    await db.delete(sites).where(eq(sites.id, SITE));
    await db.insert(sites).values({ id: SITE, name: 'Hold IT' });
    await db
      .insert(users)
      .values([
        { id: ADMIN, email: 'hold-admin@example.test', status: 'active' },
        { id: WRITER, email: 'hold-writer@example.test', status: 'active' },
      ])
      .onConflictDoNothing();
    const [adminRole, writerRole] = await db
      .insert(roles)
      .values([
        { siteId: SITE, name: 'Admin', adminAccess: true, appAccess: true },
        { siteId: SITE, name: 'Writer', adminAccess: false, appAccess: true },
      ])
      .returning({ id: roles.id });
    await db.insert(userSites).values([
      { userId: ADMIN, siteId: SITE, roleId: adminRole!.id },
      { userId: WRITER, siteId: SITE, roleId: writerRole!.id },
    ]);
    const [writerPolicy, keyPolicy] = await db
      .insert(policies)
      .values([
        { siteId: SITE, name: 'Hold writer', key: 'hold-writer', adminAccess: false, appAccess: true },
        { siteId: SITE, name: 'Hold key', key: 'hold-key', adminAccess: true, appAccess: true },
      ])
      .returning({ id: policies.id });
    await db.insert(permissions).values([
      { siteId: SITE, policyId: writerPolicy!.id, collection: 'articles', action: 'read', fields: ['*'] },
      { siteId: SITE, policyId: writerPolicy!.id, collection: 'articles', action: 'update', fields: ['title'] },
    ]);
    await db.insert(rolePolicies).values({ roleId: writerRole!.id, policyId: writerPolicy!.id });
    await db.insert(apiKeys).values({ id: KEY, siteId: SITE, name: 'hold key', prefix: 'lbk_hold', tokenHash: 'fixture-not-a-credential' });
    await db.insert(apiKeyPolicies).values({ siteId: SITE, apiKeyId: KEY, policyId: keyPolicy!.id, priority: 0 });

    const [coll] = await db
      .insert(collections)
      .values({ siteId: SITE, name: 'articles', label: 'Articles' })
      .returning({ id: collections.id });
    await db.insert(fields).values([{ siteId: SITE, collectionId: coll!.id, name: 'title', type: 'string', interface: 'input' }]);
    itemId = ((await svc().create('articles', { data: { title: 'draft' } })) as { id: string }).id;
  });

  async function hold() {
    const res = await call('POST', url('/hold'), { expectedVersion: await version() });
    expect(res.status).toBe(200);
  }

  it('setting a hold is version-checked and recorded', async () => {
    expect((await call('POST', url('/hold'), {})).status).toBe(428);
    expect((await call('POST', url('/hold'), { expectedVersion: 7 })).status).toBe(409);
    await hold();
    const r = await row();
    expect(r.hold).toBe(true);
    expect(r.version).toBe(2);
    const log = await db.select().from(activity).where(and(eq(activity.itemId, itemId), eq(activity.action, 'hold.set')));
    expect(log).toHaveLength(1);
  });

  it('manual publish: refused with 409 ITEM_HELD, nothing written; drafts can still be edited', async () => {
    await hold();
    const res = await call('PATCH', url(), { status: 'published', expectedVersion: 2 });
    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrorBody).errors[0]!.code).toBe('ITEM_HELD');
    expect((await row()).status).toBe('draft');
    expect((await call('PATCH', url(), { data: { title: 'still a draft' }, expectedVersion: 2 })).status).toBe(200);
  });

  it('a held published item: its live content cannot change, but it can be unpublished', async () => {
    expect((await call('PATCH', url(), { status: 'published', expectedVersion: 1 })).status).toBe(200);
    await hold();
    const edit = await call('PATCH', url(), { data: { title: 'live edit' }, expectedVersion: 3 });
    expect(((await edit.json()) as ErrorBody).errors[0]!.code).toBe('ITEM_HELD');
    expect((await call('PATCH', url(), { status: 'draft', expectedVersion: 3 })).status).toBe(200);
  });

  it('an agent cannot publish a held item either', async () => {
    await hold();
    const agent = svc();
    agent.setProvenance({ authorType: 'agent', runId: null });
    await expect(agent.patch('articles', itemId, { status: 'published', expectedVersion: 2 })).rejects.toMatchObject({
      code: 'ITEM_HELD',
    });
  });

  it('Releases: the held item is reported as blocked and stays a draft', async () => {
    await hold();
    const [rel] = await db.insert(releases).values({ siteId: SITE, name: 'Hold release' }).returning({ id: releases.id });
    await db.insert(releaseItems).values({
      siteId: SITE,
      releaseId: rel!.id,
      collection: 'articles',
      itemId,
      targetStatus: 'published',
    });
    const service = new ReleaseService({ db, siteId: SITE, userId: ADMIN });
    const result = await service.publish(rel!.id);
    expect(JSON.stringify(result)).toContain('ITEM_HELD');
    expect((await row()).status).toBe('draft');
  });

  it('scheduled publishing skips a held item, records it once, and publishes after release', async () => {
    await db.update(items).set({ publishAt: new Date(Date.now() - 60_000) }).where(eq(items.id, itemId));
    await hold();
    expect(await sweepDuePublish({ db })).toBe(0);
    expect(await sweepDuePublish({ db })).toBe(0);
    expect((await row()).status).toBe('draft');
    const skipped = await db
      .select()
      .from(activity)
      .where(and(eq(activity.itemId, itemId), eq(activity.action, 'publish.skipped_hold')));
    expect(skipped).toHaveLength(1);

    expect((await call('DELETE', url('/hold'), { expectedVersion: await version() })).status).toBe(200);
    expect(await sweepDuePublish({ db })).toBe(1);
    expect((await row()).status).toBe('published');
  });

  it('promoting a content branch onto a held published item is refused', async () => {
    expect((await call('PATCH', url(), { status: 'published', expectedVersion: 1 })).status).toBe(200);
    const versions = new ContentVersionService({ db, siteId: SITE, userId: ADMIN, items: svc() });
    await versions.create('articles', itemId, 'branch', 'Branch');
    await versions.update('articles', itemId, 'branch', { data: { title: 'from branch' } });
    await hold();
    await expect(versions.promote('articles', itemId, 'branch', await version())).rejects.toMatchObject({ code: 'ITEM_HELD' });
    expect((await row()).data).toEqual({ title: 'draft' });
  });

  it('releasing: an API key, an agent and a person without publish permission get 403; a publisher may', async () => {
    await hold();
    const v = await version();

    currentAuth = apiKey;
    const byKey = await call('DELETE', url('/hold'), { expectedVersion: v });
    expect(byKey.status).toBe(403);
    expect(((await byKey.json()) as ErrorBody).errors[0]!.code).toBe('HOLD_RELEASE_REQUIRES_PERSON');

    currentAuth = writer;
    const byWriter = await call('DELETE', url('/hold'), { expectedVersion: v });
    expect(byWriter.status).toBe(403);
    expect(((await byWriter.json()) as ErrorBody).errors[0]!.code).toBe('HOLD_RELEASE_REQUIRES_PUBLISH');

    const agent = svc().withPermissionContext({ userId: ADMIN, siteId: SITE, roleId: null, ip: null, headers: {}, principal: 'user' });
    agent.setProvenance({ authorType: 'agent', runId: null });
    await expect(agent.setHold('articles', itemId, false, v)).rejects.toMatchObject({ code: 'HOLD_RELEASE_REQUIRES_PERSON', status: 403 });
    expect((await row()).hold).toBe(true);

    currentAuth = humanAdmin;
    expect((await call('DELETE', url('/hold'), { expectedVersion: v })).status).toBe(200);
    expect((await row()).hold).toBe(false);
  });
});
