import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { graphql } from 'graphql';
import { and, eq } from 'drizzle-orm';
import { collections, fields, items, roles, scopedDatabase, sites, userSites, users, type Database } from '@heopress/database';
import type { AppEnv } from '../../env';
import { buildSiteSchema } from '../../graphql/schema-builder';
import { ItemService } from '../../services/item-service';
import { SchemaService } from '../../services/schema-service';
import { itemsRouter } from '../items';
import { connectDbFixtures, connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';

/**
 * Deletes over REST and GraphQL name the version they are based on (HeoPress P14 task 6.2; spec
 * content/write-concurrency "基于版本的条件删除", design D6). REST reads `If-Match`, the query parameter
 * `expectedVersion` (proxies may drop a DELETE body) or `expectedVersion` in a JSON body; sources that disagree are a
 * 400. No version is a 428, a stale one a 409 with the current version — and the item stays.
 *
 * The routes run as the application role on the site's scoped handle; the data is prepared and the stored rows are
 * checked through the owner's fixtures connection (HeoPress P14 task 1.4).
 */

const SITE = 'site_delete_version_route_it';
const ADMIN = 'usr_delete_version_route_admin';

type ErrorBody = { errors: Array<{ code: string; meta?: { currentVersion?: number } }> };

describe.skipIf(!hasDbIntegrationUrl)('version-checked deletes over REST and GraphQL — DB integration', () => {
  let db: Database;
  let fixtures: Database;

  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    (c as unknown as { env: Record<string, unknown> }).env = {};
    c.set('db', db);
    c.set('siteId', SITE);
    c.set('auth', { userId: ADMIN, email: 'delete-version-admin@example.test', roles: ['admin'], raw: { dev: true } } as AppEnv['Variables']['auth']);
    c.set('runtime', { cache: undefined, search: undefined, queue: undefined } as unknown as AppEnv['Variables']['runtime']);
    await next();
  });
  app.route('/api/v1/items', itemsRouter);

  beforeAll(async () => {
    db = scopedDatabase(await connectDbIntegration('delete-version-route'), { site: SITE });
    fixtures = await connectDbFixtures('delete-version-route');
  });
  afterAll(async () => {
    await fixtures?.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
    await fixtures?.delete(users).where(eq(users.id, ADMIN)).catch(() => undefined);
  });

  const svc = () => new ItemService({ db, siteId: SITE });
  const row = async (id: string) => (await fixtures.select().from(items).where(and(eq(items.siteId, SITE), eq(items.id, id))))[0]!;
  const create = async () => (await svc().create('articles', { data: { title: 'v1' } })) as { id: string; version: number };
  const del = (id: string, init: { query?: string; headers?: Record<string, string>; body?: unknown } = {}) =>
    app.request(`/api/v1/items/articles/${id}${init.query ?? ''}`, {
      method: 'DELETE',
      headers: { ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) },
      ...(init.body !== undefined ? { body: typeof init.body === 'string' ? init.body : JSON.stringify(init.body) } : {}),
    });
  const codeOf = async (res: Response) => ((await res.json()) as ErrorBody).errors[0];

  beforeEach(async () => {
    await fixtures.delete(sites).where(eq(sites.id, SITE));
    await fixtures.insert(sites).values({ id: SITE, name: 'Delete version route IT' });
    await fixtures.insert(users).values({ id: ADMIN, email: 'delete-version-admin@example.test', status: 'active' }).onConflictDoNothing();
    const [adminRole] = await fixtures.insert(roles).values({ siteId: SITE, name: 'Admin', adminAccess: true, appAccess: true }).returning({ id: roles.id });
    await fixtures.insert(userSites).values({ userId: ADMIN, siteId: SITE, roleId: adminRole!.id });
    const [coll] = await fixtures.insert(collections).values({ siteId: SITE, name: 'articles', label: 'Articles' }).returning({ id: collections.id });
    await fixtures.insert(fields).values({ siteId: SITE, collectionId: coll!.id, name: 'title', type: 'string', interface: 'input' });
  });

  it('If-Match, the query parameter or the JSON body: each deletes at the version it names', async () => {
    const viaHeader = await create();
    const viaQuery = await create();
    const viaBody = await create();
    const viaAll = await create();
    expect((await del(viaHeader.id, { headers: { 'if-match': '"1"' } })).status).toBe(204);
    expect((await del(viaQuery.id, { query: '?expectedVersion=1' })).status).toBe(204);
    expect((await del(viaBody.id, { body: { expectedVersion: 1 } })).status).toBe(204);
    expect((await del(viaAll.id, { headers: { 'if-match': 'W/"1"' }, query: '?expectedVersion=1', body: { expectedVersion: 1 } })).status).toBe(204);
    for (const { id } of [viaHeader, viaQuery, viaBody, viaAll]) expect((await row(id)).deletedAt).not.toBeNull();
  });

  it('no version: 428 VERSION_REQUIRED, the item stays', async () => {
    const { id } = await create();
    const res = await del(id);
    expect(res.status).toBe(428);
    expect(await codeOf(res)).toMatchObject({ code: 'VERSION_REQUIRED' });
    expect((await row(id)).deletedAt).toBeNull();
  });

  it('a stale version: 409 VERSION_CONFLICT with the current version, the edit stands', async () => {
    const { id } = await create();
    await svc().patch('articles', id, { data: { title: 'edited' }, expectedVersion: 1 });
    const res = await del(id, { query: '?expectedVersion=1' });
    expect(res.status).toBe(409);
    expect(await codeOf(res)).toMatchObject({ code: 'VERSION_CONFLICT', meta: { currentVersion: 2 } });
    expect(await row(id)).toMatchObject({ version: 2, deletedAt: null, data: { title: 'edited' } });
  });

  it('sources that disagree, or a malformed version: 400 BAD_PRECONDITION, nothing deleted', async () => {
    const { id } = await create();
    const cases = [
      { headers: { 'if-match': '"1"' }, query: '?expectedVersion=2' },
      { query: '?expectedVersion=1', body: { expectedVersion: 2 } },
      { headers: { 'if-match': '"2"' }, body: { expectedVersion: 1 } },
      { query: '?expectedVersion=abc' },
      { query: '?expectedVersion=0' },
      { body: { expectedVersion: '1' } },
      { body: '{not json' },
      { headers: { 'if-match': 'latest' } },
    ];
    for (const c of cases) {
      const res = await del(id, c);
      expect(res.status, JSON.stringify(c)).toBe(400);
      expect(await codeOf(res)).toMatchObject({ code: 'BAD_PRECONDITION' });
    }
    expect(await row(id)).toMatchObject({ version: 1, deletedAt: null });
  });

  it('GraphQL: delete_<collection> takes expectedVersion; a stale one is a VERSION_CONFLICT and changes nothing', async () => {
    const schemaService = new SchemaService({ db, siteId: SITE });
    const schema = await buildSiteSchema(schemaService);
    const run = (source: string) => graphql({ schema, source, contextValue: { siteId: SITE, userId: null, items: svc(), schema: schemaService } });

    const { id } = await create();
    await svc().patch('articles', id, { data: { title: 'edited' }, expectedVersion: 1 });
    const stale = await run(`mutation { delete_articles(id: "${id}", expectedVersion: 1) }`);
    expect(stale.errors?.[0]?.extensions).toMatchObject({ code: 'VERSION_CONFLICT', status: 409, currentVersion: 2 });
    expect((await row(id)).deletedAt).toBeNull();

    const missing = await run(`mutation { delete_articles(id: "${id}") }`);
    expect(missing.errors?.[0]?.message).toMatch(/expectedVersion/);
    expect((await row(id)).deletedAt).toBeNull();

    const ok = await run(`mutation { delete_articles(id: "${id}", expectedVersion: 2) }`);
    expect(ok.errors).toBeUndefined();
    expect(ok.data?.delete_articles).toBe(true);
    expect((await row(id)).deletedAt).not.toBeNull();
  });
});
