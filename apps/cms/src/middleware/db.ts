// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { createDb, schema } from '@heopress/database';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { MiddlewareHandler } from 'hono';
import postgres from 'postgres';
import type { AppEnv } from '../env';

/**
 * Attach a per-request Drizzle client to the Hono context.
 *
 * Resolution order:
 * 1. In local development: a short-lived pool per request (upstream behaviour,
 *    originally a Wrangler workaround; revisit with the P03 infrastructure work).
 * 2. Otherwise the RuntimeContext's DatabaseProvider (`c.get('runtime')`).
 * 3. Fallback: `DATABASE_URL`.
 */
export const withDb = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  if (c.get('db')) {
    await next();
    return;
  }

  const isDev = c.env.HEOPRESS_ENV === 'development' || process.env.HEOPRESS_ENV === 'development';

  if (isDev) {
    const dbUrl = c.env.DATABASE_URL || process.env.DATABASE_URL || 'postgresql://heopress:heopress@localhost:5432/heopress';
    const sql = postgres(dbUrl, {
      max: 10,
      idle_timeout: 0.1,
      prepare: false,
    });
    const db = drizzle(sql, { schema });
    c.set('db', db);
    await next();
    return;
  }

  // Prefer RuntimeContext if available (set by withRuntime middleware).
  const runtime = c.get('runtime');
  if (runtime) {
    // DatabaseProvider.getConnection() returns a postgres.Sql instance.
    // Cast required because
    // the interface types it as `unknown` to avoid coupling to postgres-js.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sql = runtime.database.getConnection() as any;
    const db = drizzle(sql, { schema });
    c.set('db', db);
    await next();
    return;
  }

  // Fallback: no runtime on this context (e.g. a test mounting a router directly).
  const databaseUrl = c.env.DATABASE_URL || process.env.DATABASE_URL;
  if (!databaseUrl) {
    return c.json({ error: 'Database connection is not configured. Set DATABASE_URL.' }, 500);
  }
  c.set('db', createDb(databaseUrl));
  await next();
};
