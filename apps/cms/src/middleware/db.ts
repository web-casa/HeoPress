// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { createDb, databaseScope, schema, scopedDatabase, type Database, type DatabaseScope } from '@heopress/database';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { Context, MiddlewareHandler } from 'hono';
import type postgres from 'postgres';
import type { AppEnv } from '../env';

/**
 * Attach the request's database handle to the Hono context (HeoPress P14 task 1.3, ADR-0023, design D1.4).
 *
 * The handle is scoped (`scopedDatabase`): after `withTenant`, every statement of `c.get('db')` runs in the request
 * site's scope — the scope the row-level security policies read, set inside each statement's own transaction, never on
 * the session; `withDb({ scope: 'platform' })` (the instance routes) gives the platform scope instead. Without a site
 * (routes that find their site later, or none) the handle is the unscoped pool: a statement on a site-isolated table
 * then fails with `heopress: no site scope` until the route scopes it (`scopedDatabase`, `runSiteTransaction`).
 *
 * The pool is the RuntimeContext's (`c.get('runtime')`); without a runtime (a test mounting a router directly),
 * `DATABASE_URL`. Every environment takes the same path: there is no development shortcut.
 */
const roots = new WeakMap<object, Database>();

function rootDatabase(c: Context<AppEnv>): Database | null {
  const runtime = c.get('runtime');
  if (runtime) {
    // DatabaseProvider.getConnection() returns the process's postgres.js pool (typed `unknown` to keep the runtime
    // interface free of postgres-js); one Drizzle handle per pool.
    const sql = runtime.database.getConnection() as postgres.Sql;
    let db = roots.get(sql);
    if (!db) roots.set(sql, (db = drizzle(sql, { schema }) as unknown as Database));
    return db;
  }
  const databaseUrl = c.env?.DATABASE_URL || process.env.DATABASE_URL;
  return databaseUrl ? createDb(databaseUrl) : null;
}

/** Whether `db` is a Drizzle postgres-js handle that can be scoped (not a unit test's stand-in). */
function scopable(db: unknown): db is Database {
  const client = (db as { $client?: { unsafe?: unknown; begin?: unknown } } | null)?.$client;
  return typeof client?.unsafe === 'function' && typeof client?.begin === 'function';
}

/** The scope a request's handle should have: the platform's, the request site's, or none yet. */
function requestScope(c: Context<AppEnv>, platform: boolean): DatabaseScope | null {
  if (platform) return { platform: true };
  const siteId = c.get('siteId');
  return siteId ? { site: siteId } : null;
}

export const withDb =
  (opts: { scope?: 'site' | 'platform' } = {}): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    const base = c.get('db') ?? rootDatabase(c);
    if (!base) {
      return c.json({ error: 'Database connection is not configured. Set DATABASE_URL.' }, 500);
    }
    const scope = requestScope(c, opts.scope === 'platform');
    c.set('db', scope && scopable(base) ? scopedDatabase(base, scope) : base);
    await next();
  };

/** Whether the request's handle runs in `siteId`'s scope (what `withRls` asserts). */
export function hasSiteScope(db: unknown, siteId: string): boolean {
  const scope = databaseScope(db);
  return scope !== null && 'site' in scope && scope.site === siteId;
}
