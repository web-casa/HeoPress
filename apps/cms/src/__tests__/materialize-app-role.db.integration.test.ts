import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scopedDatabase, type Database } from '@heopress/database';
import { createRuntime } from '@heopress/runtime/node';
import app from '../index';
import { setRuntimeFactory } from '../middleware/runtime';
import { connectDbFixtures, connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { createCrossSiteFixture, type CrossSiteFixture } from './helpers/cross-site-fixture';

/**
 * Materialized collections under the application role (HeoPress P13, security review S-5; P14 task 2.1, ADR-0024):
 * the runtime connects as a role that owns none of the application tables, has no TRIGGER on them and creates no
 * database object. An `auto` materialization is created without a database trigger on `lumibase_items` (the item
 * service queues its refreshes); its physical table is created, emptied and dropped by the owner's entries
 * (`heopress_materialize_create|truncate|drop`), belongs to the owner and has row-level security.
 */

const JWT_SECRET = 'materialize-app-role-secret';

const rows = <T>(r: unknown) => r as T[];
/** The PostgreSQL error behind Drizzle's wrapper. */
async function failure(p: Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await p;
  } catch (err) {
    const e = (err as { cause?: unknown }).cause ?? err;
    return e as { code?: string; message: string };
  }
  throw new Error('expected the statement to fail');
}

describe.skipIf(!hasDbIntegrationUrl)('materialized collections as the application role', () => {
  let db: Database;
  let fixtures: Database;
  let fx: CrossSiteFixture;
  let env: Record<string, unknown> = {};

  beforeAll(async () => {
    db = await connectDbIntegration('materialize-app-role');
    fixtures = await connectDbFixtures('materialize-app-role');
    env = { ...process.env, JWT_SECRET };
    const runtime = createRuntime(env);
    setRuntimeFactory(() => runtime);
    fx = await createCrossSiteFixture(fixtures, { prefix: 'matrole', jwtSecret: JWT_SECRET });
  });
  afterAll(async () => {
    setRuntimeFactory(null);
    if (fx) await fx.teardown();
    await fixtures?.execute(sql`DELETE FROM lumibase_materialized_collections WHERE id LIKE 'matrole%'`);
  });

  const call = async (method: string, path: string, body?: unknown) =>
    app.request(
      `/api/v1${path}`,
      { method, headers: fx.headers('a', await fx.session('adminA', 'a')), ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
      env,
    );
  const matTables = async () =>
    rows<{ n: number }>(await fixtures.execute(sql`SELECT count(*)::int AS n FROM pg_class WHERE relname LIKE 'mat\\_%'`))[0]!.n;

  it('creates an auto materialization without a trigger; the entries create, refresh and drop the owner\'s table', async () => {
    expect((await call('POST', '/collections', { name: 'matrole_notes' })).status).toBe(201);
    expect((await call('POST', '/items/matrole_notes', { data: { title: 'one' } })).status).toBe(201);

    const created = await call('POST', '/materialize', { collection: 'matrole_notes', target: 'matrole_flat', refreshStrategy: 'auto' });
    expect(created.status).toBe(201);
    const { data } = (await created.json()) as { data: { id: string } };
    const table = `mat_${data.id.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 59)}`;

    const triggers = await db.execute(sql`SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid = 'lumibase_items'::regclass AND tgname LIKE 'trg_mat_refresh_%'`);
    expect(rows<{ n: number }>(triggers)[0]?.n).toBe(0);
    const shape = rows<{ mine: boolean; rls: boolean; force: boolean; policies: string[] }>(
      await db.execute(sql`
        SELECT pg_get_userbyid(c.relowner) = current_user AS mine, c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
               ARRAY(SELECT policyname::text FROM pg_policies p WHERE p.tablename = c.relname ORDER BY 1) AS policies
          FROM pg_class c WHERE c.relname = ${table}`),
    );
    expect(shape).toEqual([{ mine: false, rls: true, force: false, policies: ['site_isolation'] }]);

    const refreshed = await call('POST', `/materialize/${data.id}/refresh`);
    expect(refreshed.status).toBe(200);
    expect(((await refreshed.json()) as { data: { rowCount: number } }).data.rowCount).toBe(1);
    // A second refresh empties the table through the entry first: still one row.
    const again = await call('POST', `/materialize/${data.id}/refresh`);
    expect(((await again.json()) as { data: { rowCount: number } }).data.rowCount).toBe(1);
    // The other site's scope sees none of it.
    const seenByB = await scopedDatabase(db, { site: fx.sites.b }).execute(sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)}`);
    expect(rows<{ n: number }>(seenByB)[0]?.n).toBe(0);

    expect((await call('DELETE', `/materialize/${data.id}`)).status).toBe(204);
    const left = await db.execute(sql`SELECT to_regclass(${table}) IS NULL AS gone`);
    expect(rows<{ gone: boolean }>(left)[0]?.gone).toBe(true);
  });

  it('the entries refuse an id that is invalid, unknown or another site\'s, and create nothing; the role creates nothing itself', async () => {
    // Another site's materialization, and one whose id leaves nothing of a table name.
    await fixtures.execute(sql`
      INSERT INTO lumibase_materialized_collections (id, site_id, collection, target)
      VALUES ('matrole_b_only', ${fx.sites.b}, 'notes', 'b_flat'), ('!!!', ${fx.sites.a}, 'notes', 'bad_flat')
      ON CONFLICT (id) DO NOTHING`);
    const before = await matTables();
    const inA = scopedDatabase(db, { site: fx.sites.a });
    for (const fn of ['heopress_materialize_create', 'heopress_materialize_truncate', 'heopress_materialize_drop']) {
      const call = (id: string | null) => inA.execute(sql`SELECT ${sql.raw(`public.${fn}`)}(${id})`);
      expect((await failure(call('matrole_b_only'))).code, `${fn}: another site's`).toBe('42704');
      expect((await failure(call('matrole_none'))).code, `${fn}: unknown`).toBe('42704');
      expect((await failure(call(null))).code, `${fn}: null`).toBe('22023');
      expect((await failure(call('x'.repeat(129)))).code, `${fn}: too long`).toBe('22023');
      expect((await failure(call('!!!'))).code, `${fn}: nothing usable`).toBe('22023');
      // Without a site scope the entry cannot tell whose it is.
      expect((await failure(db.execute(sql`SELECT ${sql.raw(`public.${fn}`)}(${'matrole_b_only'})`))).message).toMatch(/no site scope/);
    }
    expect(await matTables()).toBe(before);
    await fixtures.execute(sql`DELETE FROM lumibase_materialized_collections WHERE id IN ('matrole_b_only', '!!!')`);

    expect((await failure(db.execute(sql`CREATE TABLE public.mat_by_hand (id int)`))).code).toBe('42501');
    expect((await failure(db.execute(sql`CREATE FUNCTION public.matrole_f() RETURNS int LANGUAGE sql AS 'SELECT 1'`))).code).toBe('42501');
  });
});
