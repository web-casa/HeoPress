// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { schema, scopedDatabase, type Database } from '@heopress/database';
import type { AppEnv } from '../../env';
import { withRls } from '../rls';

/**
 * `withRls` (HeoPress P14 task 1.3): the request's handle must be scoped to the request's site, in every environment;
 * otherwise the request fails closed. No database: the pool is never queried (postgres.js connects lazily).
 */
const pool = postgres('postgres://probe@127.0.0.1:1/probe', { max: 1 });
const root = drizzle(pool, { schema }) as unknown as Database;

function buildApp(opts: { siteId: string | undefined; db: unknown }): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    if (opts.siteId !== undefined) c.set('siteId', opts.siteId);
    c.set('db', opts.db as Database);
    await next();
  });
  app.use('*', withRls());
  app.all('*', (c) => c.json({ ok: true }, 200));
  return app;
}

describe('withRls — the request handle is scoped to the request site, or the request fails closed', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('passes a handle scoped to the request site', async () => {
    const res = await buildApp({ siteId: 'site-a', db: scopedDatabase(root, { site: 'site-a' }) }).request('/x');
    expect(res.status).toBe(200);
  });

  it.each([
    ['an unscoped pool', () => root],
    ['another site’s handle', () => scopedDatabase(root, { site: 'site-b' })],
    ['the platform scope', () => scopedDatabase(root, { platform: true })],
    ['a stand-in that is not a database', () => ({})],
  ])('rejects %s with 503 RLS_UNAVAILABLE', async (_label, db) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await buildApp({ siteId: 'site-a', db: db() }).request('/x');
    expect(res.status).toBe(503);
    expect(((await res.json()) as { errors: { code: string }[] }).errors[0]?.code).toBe('RLS_UNAVAILABLE');
  });

  it('development mode skips nothing: an unscoped handle is still refused', async () => {
    vi.stubEnv('HEOPRESS_ENV', 'development');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await buildApp({ siteId: 'site-a', db: root }).request('/x', {}, { HEOPRESS_ENV: 'development' });
    expect(res.status).toBe(503);
  });

  it('passes through when the request has no site (nothing to scope)', async () => {
    const res = await buildApp({ siteId: undefined, db: root }).request('/x');
    expect(res.status).toBe(200);
  });
});
