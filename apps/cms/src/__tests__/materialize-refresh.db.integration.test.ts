import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '@heopress/database';
import type { Job, QueueProvider } from '@heopress/runtime';
import { createRuntime } from '@heopress/runtime/node';
import app from '../index';
import { setRuntimeFactory } from '../middleware/runtime';
import { MATERIALIZE_REFRESH_QUEUE, registerMaterializeRefreshWorker } from '../services/materialize-worker';
import { connectDbFixtures, connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { createCrossSiteFixture, type CrossSiteFixture } from './helpers/cross-site-fixture';

/**
 * Materialized collections follow their content through the queue (HeoPress P14 task 5.3; spec
 * platform/infrastructure-adapters "物化集合随内容刷新"). With a queue the item service only queues
 * `materialize-refresh` jobs, which nothing consumed before: the materialized table stayed as it was. Here the API
 * writes through the real app, the queue records what it is given, and the worker's registered handler receives each
 * recorded job, as a broker would deliver it.
 */

const JWT_SECRET = 'materialize-refresh-secret';

interface Recorded {
  queue: string;
  name: string;
  data: unknown;
}

function recordingQueue() {
  const jobs: Recorded[] = [];
  const handlers = new Map<string, (job: Job<unknown>) => Promise<void>>();
  const queue: QueueProvider = {
    enqueue: async (queueName, name, data) => {
      jobs.push({ queue: queueName, name, data });
      return `job_${jobs.length}`;
    },
    process: (queueName, handler) => {
      handlers.set(queueName, handler as (job: Job<unknown>) => Promise<void>);
    },
    getStatus: async () => null,
  };
  /** Hand every recorded job of `queueName` to its registered handler, then forget them. */
  const deliver = async (queueName: string): Promise<number> => {
    const handler = handlers.get(queueName);
    if (!handler) throw new Error(`no consumer registered for ${queueName}`);
    const due = jobs.filter((j) => j.queue === queueName);
    for (const [i, j] of due.entries()) await handler({ id: `d${i}`, name: j.name, data: j.data, status: 'active', attempt: 1 });
    jobs.splice(0, jobs.length, ...jobs.filter((j) => j.queue !== queueName));
    return due.length;
  };
  return { jobs, queue, deliver };
}

describe.skipIf(!hasDbIntegrationUrl)('materialize-refresh: the worker refreshes a materialized collection after a write', () => {
  let db: Database;
  let fixtures: Database;
  let fx: CrossSiteFixture;
  let env: Record<string, unknown> = {};
  const rec = recordingQueue();

  beforeAll(async () => {
    db = await connectDbIntegration('materialize-refresh');
    fixtures = await connectDbFixtures('materialize-refresh');
    env = { ...process.env, JWT_SECRET };
    const runtime = createRuntime(env);
    setRuntimeFactory(() => ({ ...runtime, queue: rec.queue }));
    registerMaterializeRefreshWorker({ db, queue: rec.queue });
    fx = await createCrossSiteFixture(fixtures, { prefix: 'matrefresh', jwtSecret: JWT_SECRET });
  });
  afterAll(async () => {
    setRuntimeFactory(null);
    if (fx) await fx.teardown();
  });

  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(
      `/api/v1${path}`,
      { method, headers: { ...fx.headers('a', await fx.session('adminA', 'a')), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
      env,
    );

  const materialized = async (table: string) =>
    (await fixtures.execute(sql`SELECT id, data FROM ${sql.identifier(table)} ORDER BY id`)) as unknown as Array<{ id: string; data: Record<string, unknown> }>;

  it('an update queues a refresh, and the worker rewrites the table with the change', async () => {
    expect((await call('POST', '/collections', { name: 'matrefresh_notes' })).status).toBe(201);
    const created = await call('POST', '/items/matrefresh_notes', { data: { title: 'before' } });
    expect(created.status).toBe(201);
    const item = ((await created.json()) as { data: { id: string; version: number } }).data;

    const mat = await call('POST', '/materialize', { collection: 'matrefresh_notes', target: 'matrefresh_flat', refreshStrategy: 'auto' });
    expect(mat.status).toBe(201);
    const { id } = ((await mat.json()) as { data: { id: string } }).data;
    const table = `mat_${id.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 59)}`;
    expect((await call('POST', `/materialize/${id}/refresh`)).status).toBe(200);
    expect((await materialized(table)).map((r) => r.data['title'])).toEqual(['before']);
    rec.jobs.length = 0;

    const patched = await call('PATCH', `/items/matrefresh_notes/${item.id}`, { data: { title: 'after' } }, { 'If-Match': `"${item.version}"` });
    expect(patched.status).toBe(200);
    const second = await call('POST', '/items/matrefresh_notes', { data: { title: 'second' } });
    expect(second.status).toBe(201);

    // The writes only queued refreshes: the table is unchanged until the worker runs.
    expect(rec.jobs.filter((j) => j.queue === MATERIALIZE_REFRESH_QUEUE).length).toBeGreaterThanOrEqual(2);
    expect((await materialized(table)).map((r) => r.data['title'])).toEqual(['before']);

    expect(await rec.deliver(MATERIALIZE_REFRESH_QUEUE)).toBeGreaterThanOrEqual(2);
    expect((await materialized(table)).map((r) => r.data['title']).sort()).toEqual(['after', 'second']);
    const [row] = (await fixtures.execute(
      sql`SELECT row_count, status, last_refreshed_at IS NOT NULL AS refreshed FROM lumibase_materialized_collections WHERE id = ${id}`,
    )) as unknown as Array<{ row_count: number; status: string; refreshed: boolean }>;
    expect(row).toEqual({ row_count: 2, status: 'idle', refreshed: true });

    // A job delivered again (at least once) leaves the same table; a job for a deleted materialization is skipped.
    const again = { config: { id, siteId: fx.sites.a } };
    await rec.queue.enqueue(MATERIALIZE_REFRESH_QUEUE, 'refresh', again);
    await rec.deliver(MATERIALIZE_REFRESH_QUEUE);
    expect((await materialized(table)).map((r) => r.data['title']).sort()).toEqual(['after', 'second']);
    expect((await call('DELETE', `/materialize/${id}`)).status).toBe(204);
    await rec.queue.enqueue(MATERIALIZE_REFRESH_QUEUE, 'refresh', again);
    await expect(rec.deliver(MATERIALIZE_REFRESH_QUEUE)).resolves.toBe(1);
  });

  it('a job for another site\'s materialization id refreshes nothing', async () => {
    const mat = await call('POST', '/collections', { name: 'matrefresh_other' });
    expect(mat.status).toBe(201);
    const made = await call('POST', '/materialize', { collection: 'matrefresh_other', target: 'matrefresh_other_flat', refreshStrategy: 'auto' });
    const { id } = ((await made.json()) as { data: { id: string } }).data;
    rec.jobs.length = 0;
    // Site b names site a's materialization: read in site b's scope, it does not exist.
    await rec.queue.enqueue(MATERIALIZE_REFRESH_QUEUE, 'refresh', { config: { id, siteId: fx.sites.b } });
    await rec.deliver(MATERIALIZE_REFRESH_QUEUE);
    const [row] = (await fixtures.execute(
      sql`SELECT last_refreshed_at IS NULL AS never FROM lumibase_materialized_collections WHERE id = ${id}`,
    )) as unknown as Array<{ never: boolean }>;
    expect(row?.never).toBe(true);
  });
});
