import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '@heopress/database';
import { createRuntime } from '@heopress/runtime/node';
import app from '../index';
import { setRuntimeFactory } from '../middleware/runtime';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { createCrossSiteFixture, type CrossSiteFixture } from './helpers/cross-site-fixture';

/**
 * Materialized collections under the application role (HeoPress P13, security review S-5): the runtime connects as a
 * role that owns none of the application tables and has no TRIGGER on them. An `auto` materialization is created
 * without a database trigger on `lumibase_items` (the item service queues its refreshes); its physical table belongs
 * to the connection's role, so refreshing (TRUNCATE) and deleting (DROP TABLE) work.
 */

const JWT_SECRET = 'materialize-app-role-secret';

describe.skipIf(!hasDbIntegrationUrl)('materialized collections as the application role', () => {
  let db: Database;
  let fx: CrossSiteFixture;
  let env: Record<string, unknown> = {};

  beforeAll(async () => {
    db = await connectDbIntegration('materialize-app-role');
    env = { ...process.env, JWT_SECRET, HEOPRESS_ENV: 'development' };
    const runtime = createRuntime(env);
    setRuntimeFactory(() => runtime);
    fx = await createCrossSiteFixture(db, { prefix: 'matrole', jwtSecret: JWT_SECRET });
  });
  afterAll(async () => {
    setRuntimeFactory(null);
    if (fx) await fx.teardown();
  });

  const call = async (method: string, path: string, body?: unknown) =>
    app.request(
      `/api/v1${path}`,
      { method, headers: fx.headers('a', await fx.session('adminA', 'a')), ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
      env,
    );

  it('creates an auto materialization without a trigger, then refreshes and deletes its own table', async () => {
    expect((await call('POST', '/collections', { name: 'matrole_notes' })).status).toBe(201);
    expect((await call('POST', '/items/matrole_notes', { data: { title: 'one' } })).status).toBe(201);

    const created = await call('POST', '/materialize', { collection: 'matrole_notes', target: 'matrole_flat', refreshStrategy: 'auto' });
    expect(created.status).toBe(201);
    const { data } = (await created.json()) as { data: { id: string } };
    const table = `mat_${data.id.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 59)}`;

    const triggers = await db.execute(sql`SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid = 'lumibase_items'::regclass AND tgname LIKE 'trg_mat_refresh_%'`);
    expect((triggers as unknown as Array<{ n: number }>)[0]?.n).toBe(0);
    const owner = await db.execute(sql`SELECT pg_get_userbyid(relowner) = current_user AS mine FROM pg_class WHERE relname = ${table}`);
    expect((owner as unknown as Array<{ mine: boolean }>)[0]?.mine).toBe(true);

    const refreshed = await call('POST', `/materialize/${data.id}/refresh`);
    expect(refreshed.status).toBe(200);
    expect(((await refreshed.json()) as { data: { rowCount: number } }).data.rowCount).toBe(1);

    expect((await call('DELETE', `/materialize/${data.id}`)).status).toBe(204);
    const left = await db.execute(sql`SELECT to_regclass(${table}) IS NULL AS gone`);
    expect((left as unknown as Array<{ gone: boolean }>)[0]?.gone).toBe(true);
  });
});
