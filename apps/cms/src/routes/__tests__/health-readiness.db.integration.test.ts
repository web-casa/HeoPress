import path from 'node:path';
import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Database } from '@heopress/database';
import type { AppEnv } from '../../env';
import {
  connectDbIntegration,
  dbIntegrationUrl,
  hasDbIntegrationUrl,
} from '../../__tests__/helpers/db-harness';
import { healthRouter } from '../health';
import { createWorkerHealthApp, databaseReadinessProbe } from '../../worker-health';

/**
 * Liveness and readiness against a real PostgreSQL (P01 `platform/runtime-baseline`).
 *
 * Three database states, each through the real health router of the web role
 * and the health app of the worker role:
 * 1. database unreachable -> live 200, ready 503 (web names `database` unhealthy);
 * 2. reachable but no migrations applied -> ready 503 (web names `migrations`);
 * 3. fully migrated -> ready 200.
 * Plus the capability extensions (P03 task 1.2) on a database that has only
 * pg_trgm: vector search enabled -> 503 naming the vector extension; disabled
 * -> 200; zhparser missing -> 200 with Chinese search on pg_trgm.
 *
 * Only the database is real. Cache, search, storage and queue are stubbed healthy
 * so the outcome isolates the database and migration checks.
 */

const TOKEN = 'health-readiness-token';
const MIGRATIONS_FOLDER = path.resolve(__dirname, '../../../../../packages/database/drizzle');

function appWithDatabase(sql: Sql, env: Record<string, string> = {}): Hono<AppEnv> {
  const inner = new Hono<AppEnv>();
  inner.use('*', async (c, next) => {
    c.set('runtime', {
      runtime: 'docker',
      database: { getConnection: () => sql, close: async () => {} },
      cache: { get: async () => 'ok', set: async () => {}, delete: async () => {} },
      search: { getIndex: async () => { throw new Error('index_not_found'); } },
      storage: { list: async () => [] },
      queue: { enqueue: async () => 'job_1' },
    } as never);
    await next();
  });
  inner.route('/health', healthRouter);
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.env = { ...(c.env ?? {}), METRICS_TOKEN: TOKEN, ...env } as AppEnv['Bindings'];
    await next();
  });
  app.route('/', inner);
  return app;
}

async function ready(app: Hono<AppEnv>) {
  const res = await app.request('/health/ready', { headers: { authorization: `Bearer ${TOKEN}` } });
  return {
    status: res.status,
    body: (await res.json()) as {
      status: string;
      services: Record<string, string>;
      capabilities?: { missing: string[]; notices: string[]; chineseSearch: string };
    },
  };
}

describe.skipIf(!hasDbIntegrationUrl)('health readiness — DB integration', () => {
  let harnessDb: Database | undefined;
  let migrated: Sql | undefined;
  let empty: Sql | undefined;
  let unreachable: Sql | undefined;
  let trgmOnly: Sql | undefined;
  let admin: Sql | undefined;
  // Creating scratch databases needs the owner role; the suites themselves
  // run as the application role, which may not (P03 task 7.1).
  const adminUrl = process.env.DATABASE_OWNER_URL?.trim() || dbIntegrationUrl!;
  const emptyDbName = `heopress_health_${process.pid}_${Date.now()}`;
  const trgmDbName = `heopress_health_trgm_${process.pid}_${Date.now()}`;

  beforeAll(async () => {
    harnessDb = await connectDbIntegration('health-readiness');
    migrated = postgres(dbIntegrationUrl!, { max: 1, onnotice: () => {} });
    admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE "${emptyDbName}"`);
    const emptyUrl = new URL(adminUrl);
    emptyUrl.pathname = `/${emptyDbName}`;
    empty = postgres(emptyUrl.toString(), { max: 1, onnotice: () => {} });
    // Fully migrated, but with pg_trgm as the only extension (what a stock
    // postgres:18 server offers): the migrator runs without the optional ones.
    await admin.unsafe(`CREATE DATABASE "${trgmDbName}"`);
    const trgmUrl = new URL(adminUrl);
    trgmUrl.pathname = `/${trgmDbName}`;
    trgmOnly = postgres(trgmUrl.toString(), { max: 1, onnotice: () => {} });
    await trgmOnly.unsafe('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    await migrate(drizzle(trgmOnly), { migrationsFolder: MIGRATIONS_FOLDER });
    const deadUrl = new URL(dbIntegrationUrl!);
    deadUrl.hostname = '127.0.0.1';
    deadUrl.port = '1';
    unreachable = postgres(deadUrl.toString(), { max: 1, connect_timeout: 1 });
  });

  afterAll(async () => {
    await empty?.end({ timeout: 1 });
    await trgmOnly?.end({ timeout: 1 });
    await unreachable?.end({ timeout: 1 });
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${emptyDbName}" WITH (FORCE)`);
      await admin.unsafe(`DROP DATABASE IF EXISTS "${trgmDbName}" WITH (FORCE)`);
      await admin.end({ timeout: 1 });
    }
    await migrated?.end({ timeout: 1 });
    await (harnessDb as unknown as { $client?: { end?: () => Promise<void> } } | undefined)?.$client?.end?.();
  });

  it('database unreachable: liveness 200, readiness 503 naming the database', async () => {
    const app = appWithDatabase(unreachable!);
    const live = await app.request('/health/live');
    expect(live.status).toBe(200);
    const { status, body } = await ready(app);
    expect(status).toBe(503);
    expect(body.services.database).toBe('unhealthy');
  });

  it('migrations not applied: readiness 503 with migrations unhealthy', async () => {
    const { status, body } = await ready(appWithDatabase(empty!));
    expect(status).toBe(503);
    expect(body.services).toMatchObject({ database: 'healthy', migrations: 'unhealthy' });
  });

  it('fully migrated: readiness 200', async () => {
    const { status, body } = await ready(appWithDatabase(migrated!));
    expect(body.services).toMatchObject({ database: 'healthy', migrations: 'healthy' });
    expect(status).toBe(200);
  });

  describe('capability extensions (pg_trgm only)', () => {
    it('vector search enabled: readiness 503 naming the vector extension', async () => {
      const { status, body } = await ready(appWithDatabase(trgmOnly!, { HEOPRESS_VECTOR_SEARCH: 'true' }));
      expect(status).toBe(503);
      expect(body.services).toMatchObject({ migrations: 'healthy', extensions: 'unhealthy' });
      expect(body.capabilities?.missing.join(' ')).toMatch(/vector extension/);
      expect(await databaseReadinessProbe(trgmOnly! as never, undefined, { vectorSearch: true })())
        .toEqual({ database: true, migrations: true, extensions: false });
    });

    it('vector search disabled: readiness 200 without the vector extension', async () => {
      const { status, body } = await ready(appWithDatabase(trgmOnly!));
      expect(body.services).toMatchObject({ migrations: 'healthy', extensions: 'healthy' });
      expect(status).toBe(200);
      expect((await createWorkerHealthApp(databaseReadinessProbe(trgmOnly! as never)).request('/health/ready')).status).toBe(200);
    });

    it('zhparser missing: ready, with Chinese search on pg_trgm and a notice', async () => {
      const { status, body } = await ready(appWithDatabase(trgmOnly!));
      expect(status).toBe(200);
      expect(body.capabilities?.chineseSearch).toBe('trgm');
      expect(body.capabilities?.notices.join(' ')).toMatch(/zhparser/);
    });
  });

  describe('worker role', () => {
    const worker = (sql: Sql) => createWorkerHealthApp(databaseReadinessProbe(sql as never));

    it('database unreachable: liveness 200, readiness 503', async () => {
      const app = worker(unreachable!);
      expect((await app.request('/health/live')).status).toBe(200);
      expect((await app.request('/health/ready')).status).toBe(503);
    });

    it('migrations not applied: readiness 503', async () => {
      expect(await databaseReadinessProbe(empty! as never)()).toEqual({ database: true, migrations: false, extensions: false });
      expect((await worker(empty!).request('/health/ready')).status).toBe(503);
    });

    it('fully migrated: readiness 200', async () => {
      expect(await databaseReadinessProbe(migrated! as never)()).toEqual({ database: true, migrations: true, extensions: true });
      expect((await worker(migrated!).request('/health/ready')).status).toBe(200);
    });
  });
});
