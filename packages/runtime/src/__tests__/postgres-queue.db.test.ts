import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';

import { PgBossQueueProvider } from '../adapters/postgres/queue';
import type { Job } from '../interfaces';
import { PG_URL, eventually } from './helpers/pg';

/**
 * Durable queue on PostgreSQL (P03 task 3.1; spec
 * platform/infrastructure-adapters "持久化任务队列"): the QueueProvider
 * contract (round trip, status, retries with backoff, delay, priority), at
 * most one active job per singleton key, and a job queued before a restart
 * runs exactly once afterwards. Needs a migrated database (pgboss schema).
 * Each case uses its own queue name, so no reset is needed.
 */

const providers: PgBossQueueProvider[] = [];
const make = () => {
  const q = new PgBossQueueProvider(PG_URL!, { pollingIntervalSeconds: 0.5, max: 3 });
  providers.push(q);
  return q;
};
const queueName = (label: string) => `test-${label}-${randomUUID().slice(0, 8)}`;

describe.skipIf(!PG_URL)('PgBossQueueProvider (PostgreSQL)', () => {
  afterAll(async () => {
    await Promise.all(providers.map((p) => p.close()));
  });

  it('delivers the job name and data, and reports status', async () => {
    const queue = make();
    const name = queueName('roundtrip');
    const seen: Job<{ siteId: string }>[] = [];
    const id = await queue.enqueue(name, 'index-item', { siteId: 'site-a' });
    expect((await queue.getStatus(name, id))?.status).toBe('waiting');
    queue.process<{ siteId: string }>(name, async (job) => {
      seen.push(job);
    });
    await eventually(async () => seen.length === 1, 10_000);
    expect(seen[0]).toMatchObject({ id, name: 'index-item', data: { siteId: 'site-a' }, attempt: 1 });
    await eventually(async () => (await queue.getStatus(name, id))?.status === 'completed', 10_000);
    expect(await queue.getStatus(name, 'b9c7e3a0-0000-4000-8000-000000000000')).toBeNull();
  }, 20_000);

  it('retries a failed job with backoff, then marks it failed after the last attempt', async () => {
    const queue = make();
    const okName = queueName('retry-ok');
    const attempts: number[] = [];
    queue.process(okName, async (job) => {
      attempts.push(job.attempt ?? 0);
      if (attempts.length === 1) throw new Error('transient');
    });
    await queue.enqueue(okName, 'flaky', {}, { attempts: 3, backoff: { type: 'fixed', delay: 1000 } });
    await eventually(async () => attempts.length === 2, 15_000);
    expect(attempts).toEqual([1, 2]);

    const failName = queueName('retry-fail');
    let tries = 0;
    queue.process(failName, async () => {
      tries += 1;
      throw new Error('always');
    });
    const id = await queue.enqueue(failName, 'doomed', {}, { attempts: 2, backoff: { type: 'fixed', delay: 1000 } });
    await eventually(async () => (await queue.getStatus(failName, id))?.status === 'failed', 15_000);
    expect(tries).toBe(2);
  }, 40_000);

  it('pause waits for the active job and fetches nothing until resume (HeoPress P13 upgrade write freeze)', async () => {
    const queue = make();
    const name = queueName('pause');
    const ran: string[] = [];
    let finishActive: () => void = () => {};
    queue.process<{ n: string }>(name, async (job) => {
      ran.push(job.data.n);
      if (job.data.n === 'first') await new Promise<void>((r) => (finishActive = r));
    });
    await queue.enqueue(name, 'job', { n: 'first' });
    await eventually(async () => ran.length === 1, 10_000);
    let paused = false;
    const pausing = queue.pause().then(() => (paused = true));
    await new Promise((r) => setTimeout(r, 300));
    expect(paused).toBe(false); // still waiting for the active job
    finishActive();
    await pausing;
    const id = await queue.enqueue(name, 'job', { n: 'second' });
    await new Promise((r) => setTimeout(r, 1500));
    expect(ran).toEqual(['first']);
    expect((await queue.getStatus(name, id))?.status).toBe('waiting');
    await queue.resume();
    await eventually(async () => ran.length === 2, 10_000);
    expect(ran).toEqual(['first', 'second']);
  }, 30_000);

  it('a worker registered while paused starts only on resume', async () => {
    const queue = make();
    await queue.pause();
    const name = queueName('paused-register');
    const ran: string[] = [];
    queue.process(name, async () => void ran.push('x'));
    await queue.enqueue(name, 'job', {});
    await new Promise((r) => setTimeout(r, 1500));
    expect(ran).toEqual([]);
    await queue.resume();
    await eventually(async () => ran.length === 1, 10_000);
  }, 30_000);

  it('drains a backlog without waiting a polling interval per job', async () => {
    // A long polling interval: one job per interval would take 40 × 5 s.
    const queue = new PgBossQueueProvider(PG_URL!, { pollingIntervalSeconds: 5, max: 3 });
    providers.push(queue);
    const name = queueName('backlog');
    for (let i = 0; i < 40; i += 1) await queue.enqueue(name, 'index', { i });
    let done = 0;
    const started = Date.now();
    queue.process(name, async () => {
      done += 1;
    });
    await eventually(async () => done === 40, 25_000);
    // First fetch, plus at most one interval before the worker id is known.
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 30_000);

  it('holds a delayed job until its delay has passed', async () => {
    const queue = make();
    const name = queueName('delay');
    let ranAt = 0;
    const enqueuedAt = Date.now();
    await queue.enqueue(name, 'later', {}, { delay: 2000 });
    queue.process(name, async () => {
      ranAt = Date.now();
    });
    await eventually(async () => ranAt > 0, 10_000);
    expect(ranAt - enqueuedAt).toBeGreaterThanOrEqual(1900);
  }, 15_000);

  it('runs a high-priority job before a low-priority one queued earlier', async () => {
    const queue = make();
    const name = queueName('priority');
    const order: string[] = [];
    await queue.enqueue(name, 'low', {}, { priority: 'low' });
    await queue.enqueue(name, 'high', {}, { priority: 'high' });
    queue.process(name, async (job) => {
      order.push(job.name);
    });
    await eventually(async () => order.length === 2, 10_000);
    expect(order).toEqual(['high', 'low']);
  }, 15_000);

  it('runs at most one job per singleton key at a time, across workers', async () => {
    const a = make();
    const b = make();
    const name = queueName('singleton');
    let active = 0;
    let maxActive = 0;
    let done = 0;
    let otherKeyOverlapped = false;
    const handler = async (job: Job<{ key: string }>) => {
      if (job.data.key === 'site-b') {
        if (active > 0) otherKeyOverlapped = true;
        done += 1;
        return;
      }
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 800));
      active -= 1;
      done += 1;
    };
    for (const q of [a, b]) q.process<{ key: string }>(name, handler);
    for (let i = 0; i < 3; i++) await a.enqueue(name, 'ingest', { key: 'site-a' }, { singletonKey: 'ingest:site-a' });
    await a.enqueue(name, 'ingest', { key: 'site-b' }, { singletonKey: 'ingest:site-b' });
    await eventually(async () => done === 4, 20_000);
    expect(maxActive).toBe(1);
    // A different key is not held back by site-a's running job.
    expect(otherKeyOverlapped).toBe(true);
  }, 30_000);

  // Supervision every second, heartbeat 10 s (pg-boss's minimum): a job whose
  // heartbeat goes stale is failed and retried within ~11 s, so both cases
  // below run with reclamation really active (Codex review 3, #9).
  const heartbeatOpts = { pollingIntervalSeconds: 0.5, max: 3, heartbeatSeconds: 10, superviseIntervalSeconds: 1 };

  it('a live worker\'s job that runs past several heartbeat periods is not handed to another worker (Codex review 2, #4)', async () => {
    const a = new PgBossQueueProvider(PG_URL!, heartbeatOpts);
    const b = new PgBossQueueProvider(PG_URL!, heartbeatOpts);
    providers.push(a, b);
    const name = queueName('long');
    const starts: number[] = [];
    const handler = async () => {
      starts.push(Date.now());
      await new Promise((r) => setTimeout(r, 25_000)); // 2.5 heartbeat periods, ~25 supervision passes
    };
    a.process(name, handler);
    b.process(name, handler);
    const id = await a.enqueue(name, 'long-run', {}, { attempts: 3 });
    await eventually(async () => (await a.getStatus(name, id))?.status === 'completed', 45_000);
    expect(starts).toHaveLength(1);
  }, 60_000);

  it('control: a job whose worker stopped renewing it is reclaimed and run elsewhere', async () => {
    const dead = new PgBossQueueProvider(PG_URL!, heartbeatOpts);
    const live = new PgBossQueueProvider(PG_URL!, heartbeatOpts);
    providers.push(dead, live);
    const name = queueName('orphan');
    const id = await dead.enqueue(name, 'orphaned', {}, { attempts: 3, backoff: { type: 'fixed', delay: 0 } });
    // Claim the job the way a worker does, then never renew it: a worker that died.
    const boss = (dead as unknown as { boss: { fetch: (n: string) => Promise<Array<{ id: string }>> } }).boss;
    const claimed = await boss.fetch(name);
    expect(claimed.map((j) => j.id)).toEqual([id]);
    const runs: string[] = [];
    live.process(name, async (job) => {
      runs.push(job.id);
    });
    await eventually(async () => runs.length === 1, 30_000);
    expect(runs).toEqual([id]);
  }, 45_000);

  it('a job queued before a restart runs exactly once after it', async () => {
    const name = queueName('restart');
    const before = new PgBossQueueProvider(PG_URL!, { pollingIntervalSeconds: 0.5, max: 2 });
    const id = await before.enqueue(name, 'survives', { n: 1 });
    await before.close(); // the process stops before any worker took the job

    const after = make();
    const runs: string[] = [];
    after.process(name, async (job) => {
      runs.push(job.id);
    });
    await eventually(async () => runs.length === 1, 10_000);
    await new Promise((r) => setTimeout(r, 1500)); // no second delivery
    expect(runs).toEqual([id]);
  }, 20_000);
});
