import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { databaseScope, schema, scopedDatabase, type Database } from '@heopress/database';
import type { AppEnv } from '../../env';
import { hasSiteScope, withDb } from '../db';

/**
 * `withDb` (HeoPress P14 task 1.3, design D1.4): after `withTenant` the request handle is scoped to the request site;
 * the instance routes get the platform scope; without a site the handle is the unscoped pool. The same in every
 * environment — no per-request pool in development. No database: postgres.js connects lazily, nothing is queried.
 */
const pool = postgres('postgres://probe@127.0.0.1:1/probe', { max: 1 });

function app(opts: { siteId?: string; preset?: unknown; scope?: 'site' | 'platform'; runtime?: boolean }) {
  const seen: { db?: unknown } = {};
  const a = new Hono<AppEnv>();
  a.use('*', async (c, next) => {
    if (opts.siteId) c.set('siteId', opts.siteId);
    if (opts.preset) c.set('db', opts.preset as Database);
    if (opts.runtime !== false) c.set('runtime', { database: { getConnection: () => pool } } as unknown as AppEnv['Variables']['runtime']);
    await next();
  });
  a.use('*', withDb(opts.scope ? { scope: opts.scope } : {}));
  a.all('*', (c) => {
    seen.db = c.get('db');
    return c.json({ ok: true });
  });
  return { a, seen };
}

describe('withDb — a scoped handle per request', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('scopes the runtime pool to the request site, one handle per site', async () => {
    const one = app({ siteId: 'site-a' });
    await one.a.request('/x');
    expect(databaseScope(one.seen.db)).toEqual({ site: 'site-a' });
    expect(hasSiteScope(one.seen.db, 'site-a')).toBe(true);
    expect(hasSiteScope(one.seen.db, 'site-b')).toBe(false);
    const two = app({ siteId: 'site-a' });
    await two.a.request('/x');
    expect(two.seen.db).toBe(one.seen.db);
  });

  it('the instance routes get the platform scope', async () => {
    const { a, seen } = app({ siteId: 'site-a', scope: 'platform' });
    await a.request('/x');
    expect(databaseScope(seen.db)).toEqual({ platform: true });
    expect(hasSiteScope(seen.db, 'site-a')).toBe(false);
  });

  it('without a site, the unscoped pool', async () => {
    const { a, seen } = app({});
    await a.request('/x');
    expect(databaseScope(seen.db)).toBeNull();
    expect(typeof (seen.db as { select?: unknown }).select).toBe('function');
  });

  it('a handle set earlier (a test, an outer route) is scoped to the request site', async () => {
    const preset = drizzle(postgres('postgres://probe@127.0.0.1:1/probe', { max: 1 }), { schema }) as unknown as Database;
    const { a, seen } = app({ siteId: 'site-b', preset, runtime: false });
    await a.request('/x');
    expect(seen.db).toBe(scopedDatabase(preset, { site: 'site-b' }));
  });

  it('development mode takes the same path: scoped, on the runtime pool', async () => {
    vi.stubEnv('HEOPRESS_ENV', 'development');
    const { a, seen } = app({ siteId: 'site-a' });
    await a.request('/x', {}, { HEOPRESS_ENV: 'development' });
    expect(databaseScope(seen.db)).toEqual({ site: 'site-a' });
  });

  it('a stand-in that is not a postgres-js handle is passed on unchanged', async () => {
    const stub = { select: () => [] };
    const { a, seen } = app({ siteId: 'site-a', preset: stub });
    await a.request('/x');
    expect(seen.db).toBe(stub);
  });

  it('no runtime and no DATABASE_URL: 500', async () => {
    vi.stubEnv('DATABASE_URL', '');
    const { a } = app({ siteId: 'site-a', runtime: false });
    const res = await a.request('/x', {}, {});
    expect(res.status).toBe(500);
  });
});
