import { sql } from 'drizzle-orm';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Database } from '@heopress/database';
import type { AppEnv } from '../../env';
import { withDb } from '../db';
import { withRls } from '../rls';
import { withTenant } from '../tenant';
import {
  connectDbFixtures,
  connectDbIntegration,
  DbFixturesBoundByRlsError,
  hasDbIntegrationUrl,
} from '../../__tests__/helpers/db-harness';

/**
 * Development mode isolates sites like production (HeoPress P14 task 1.3, spec `platform/tenant-isolation`
 * "开发环境跨站读取"): with `HEOPRESS_ENV=development`, a request of site A reads none of site B's rows — the request
 * chain (`withTenant` → `withDb` → `withRls`) scopes every statement, and the handler writes no site condition.
 *
 * The owner (fixtures) creates a probe table under a site policy — the policies of the registry are installed by a
 * later migration — and the requests run as the application role.
 */
const TABLE = `heopress_rls_dev_probe_${process.pid}`;
const probe = pgTable(TABLE, { id: text('id').primaryKey(), siteId: text('site_id').notNull(), body: text('body') });

describe.skipIf(!hasDbIntegrationUrl)('development mode: cross-site reads are refused (P14 task 1.3)', () => {
  let db: Database;
  let fixtures: Database;

  beforeAll(async () => {
    db = await connectDbIntegration('rls-dev');
    fixtures = await connectDbFixtures('rls-dev');
    const role = new URL(process.env.DATABASE_URL!).username;
    await fixtures.execute(sql.raw(`CREATE TABLE ${TABLE} (id text PRIMARY KEY, site_id text NOT NULL, body text)`));
    await fixtures.execute(sql.raw(`ALTER TABLE ${TABLE} ENABLE ROW LEVEL SECURITY`));
    await fixtures.execute(sql.raw(`CREATE POLICY site_isolation ON ${TABLE} USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id())`));
    await fixtures.execute(sql.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${TABLE} TO "${role}"`));
    // The owner writes both sites' rows without a scope (ENABLE without FORCE).
    await fixtures.insert(probe).values([
      { id: 'dev-a', siteId: 'site-dev-a', body: 'A' },
      { id: 'dev-b', siteId: 'site-dev-b', body: 'B' },
    ]);
  });

  afterAll(async () => {
    if (fixtures) await fixtures.execute(sql.raw(`DROP TABLE IF EXISTS ${TABLE}`));
  });

  function app(): Hono<AppEnv> {
    const a = new Hono<AppEnv>();
    a.use('*', async (c, next) => {
      c.set('db', db);
      await next();
    });
    a.use('*', withTenant(), withDb(), withRls());
    // No site condition on purpose: only the scope keeps site B's rows out.
    a.get('/rows', async (c) => c.json({ data: await c.get('db').select().from(probe) }));
    a.get('/rows/:id', async (c) => {
      const rows = await c.get('db').execute(sql`SELECT id FROM ${probe} WHERE id = ${c.req.param('id')}`);
      return rows.length > 0 ? c.json({ data: rows[0] }) : c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
    });
    return a;
  }

  it('with HEOPRESS_ENV=development, site A reads only its own rows and never site B’s', async () => {
    vi.stubEnv('HEOPRESS_ENV', 'development');
    try {
      const env = { HEOPRESS_ENV: 'development' };
      const list = await app().request('/rows', { headers: { 'x-heopress-site': 'site-dev-a' } }, env);
      expect(list.status).toBe(200);
      expect(((await list.json()) as { data: Array<{ id: string }> }).data.map((r) => r.id)).toEqual(['dev-a']);
      const other = await app().request('/rows/dev-b', { headers: { 'x-heopress-site': 'site-dev-a' } }, env);
      expect(other.status).toBe(404);
      const own = await app().request('/rows/dev-b', { headers: { 'x-heopress-site': 'site-dev-b' } }, env);
      expect(own.status).toBe(200);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('the application role without a scope gets the "no site scope" error, not an empty result', async () => {
    await expect(db.execute(sql`SELECT id FROM ${probe}`)).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('connectDbFixtures refuses a connection that row-level security binds', async () => {
    vi.stubEnv('DATABASE_OWNER_URL', process.env.DATABASE_URL!);
    try {
      await expect(connectDbFixtures('rls-dev-bound')).rejects.toThrow(DbFixturesBoundByRlsError);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
