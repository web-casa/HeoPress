import { afterEach, describe, expect, it } from 'vitest';
import { BUILTIN_THEME } from '../theme/builtin.ts';
import { RenderPool, type RenderJob } from '../theme/pool.ts';
import { sampleSystemContent, sampleViewModels } from '../theme/samples.ts';

/**
 * The rendering pool with real worker threads (HeoPress P06 tasks 2.2, 2.6; design R3, R21, R33, R37;
 * spec "死循环", "恶意标题与超时模板"): a runaway template is stopped by terminating its worker, other sites
 * keep being served, admission is fair between sites, oversized jobs are refused.
 */

const vms = sampleViewModels();
const top = BUILTIN_THEME['partials/top']!;
const bottom = BUILTIN_THEME['partials/bottom']!;
/** Busy for a while without allocating: a million iterations. */
const SLOW = { ...BUILTIN_THEME, home: `${top}{% for i in (1..1000) %}{% for j in (1..1000) %}{% for k in (1..100) %}{% endfor %}{% endfor %}{% endfor %}${bottom}` };

let pool: RenderPool | null = null;
afterEach(async () => {
  await pool?.close();
  pool = null;
});

const job = (siteId: string, templates: Record<string, string> = BUILTIN_THEME, versionId = 'builtin:test'): RenderJob => ({
  siteId,
  versionId,
  templates,
  entry: 'home',
  vm: vms.home,
  system: sampleSystemContent(true),
});

describe('RenderPool', () => {
  it('renders in a worker', async () => {
    pool = new RenderPool({ workers: 1 });
    const html = await pool.render(job('a'));
    expect(html).toContain('<title>Sample</title>');
    expect(html).not.toContain('heopress-slot');
  });

  it('start-up is not render time: a cold worker gets its first job only once loaded (CI, batch 8)', async () => {
    // Loading the engine, schema and parser can take seconds on a busy machine; the render timeout must not include it.
    pool = new RenderPool({ workers: 1 });
    const first = pool.render(job('a'));
    expect(pool.running()).toEqual({});
    expect(pool.queued()).toEqual({ a: 1 });
    await expect(first).resolves.toContain('<title>Sample</title>');
  });

  it('a worker slower to load than the render timeout still serves its first job', async () => {
    // A long admission wait and test timeout: only the render timeout is under test (a busy runner loads slowly).
    pool = new RenderPool({ workers: 1, timeoutMs: 300, queueTimeoutMs: 20_000, workerUrl: new URL('./fixtures/slow-start-worker.ts', import.meta.url) });
    await expect(pool.render(job('a'))).resolves.toContain('<title>Sample</title>');
  }, 30_000);

  it('a worker that never becomes ready is replaced; its jobs time out in the queue; close() still returns', async () => {
    pool = new RenderPool({ workers: 1, startupTimeoutMs: 200, queueTimeoutMs: 700, workerUrl: new URL('./fixtures/never-ready-worker.ts', import.meta.url) });
    await expect.poll(() => pool!.threadIds().length).toBe(1);
    const first = pool.threadIds()[0];
    await expect(pool.render(job('a'))).rejects.toMatchObject({ code: 'RENDER_QUEUE_FULL' });
    await expect.poll(() => pool!.threadIds().some((id) => id !== first), { timeout: 3000 }).toBe(true);
    await pool.close();
    // Closed while a worker is starting: no worker is started afterwards (no watchdog or restart timer left).
    await new Promise((r) => setTimeout(r, 500));
    expect(pool.threadIds()).toEqual([]);
    pool = null;
  });

  it('a runaway template is terminated at the timeout; the other site is served meanwhile and after', async () => {
    // The engine's own limit raised: the pool's wall clock is what stops the loop (minutes long otherwise).
    pool = new RenderPool({ workers: 2, timeoutMs: 1500, renderLimitMs: 600_000 });
    await Promise.all([pool.render(job('warm')), pool.render(job('warm2'))]);
    const before = pool.threadIds();
    const started = Date.now();
    const slow = pool.render(job('a', SLOW, 'slow:1'));
    const b = await pool.render(job('b'));
    expect(b).toContain('<title>Sample</title>');
    await expect(slow).rejects.toMatchObject({ code: 'RENDER_TIMEOUT' });
    expect(Date.now() - started).toBeLessThan(5000);
    // Terminated, not abandoned: one worker thread was replaced by a new one.
    await expect.poll(() => pool!.threadIds().length).toBe(2);
    const after = pool.threadIds();
    expect(after.filter((id) => !before.includes(id))).toHaveLength(1);
    // The replacement worker serves the next jobs.
    for (let i = 0; i < 3; i++) await expect(pool.render(job('a'))).resolves.toContain('<title>');
  });

  it('a theme rule failure is an error with a message, no stack', async () => {
    pool = new RenderPool({ workers: 1 });
    const bad = { ...BUILTIN_THEME, home: `${top}<a href="javascript:alert(1)">x</a>${bottom}` };
    const err = (await pool.render(job('a', bad, 'bad:1')).catch((e: unknown) => e)) as { code: string; message: string };
    expect(err.code).toBe('THEME_RULE');
    expect(err.message).toMatch(/scheme not allowed/);
    expect(err.message).not.toMatch(/\n|\.ts:\d+/);
  });

  it('fair admission: a site filling the queue does not keep another out; its own newest jobs are refused', async () => {
    pool = new RenderPool({ workers: 1, timeoutMs: 5000, maxQueued: 6, queueTimeoutMs: 20_000 });
    const results: Array<Promise<string>> = [];
    for (let i = 0; i < 10; i++) results.push(pool.render(job('a', SLOW, 'slow:2')));
    const b = pool.render(job('b'));
    const settled = await Promise.allSettled([...results, b]);
    const bResult = settled[settled.length - 1]!;
    expect(bResult.status).toBe('fulfilled');
    const refusedA = settled.slice(0, -1).filter((r) => r.status === 'rejected' && (r.reason as { code: string }).code === 'RENDER_QUEUE_FULL');
    expect(refusedA.length).toBeGreaterThan(0);
  }, 30_000);

  it('turns: with both sites queued, workers alternate between them', async () => {
    pool = new RenderPool({ workers: 1, maxQueued: 40 });
    const order: string[] = [];
    const all: Array<Promise<unknown>> = [];
    for (let i = 0; i < 4; i++) all.push(pool.render(job('a')).then(() => order.push('a')));
    for (let i = 0; i < 4; i++) all.push(pool.render(job('b')).then(() => order.push('b')));
    await Promise.all(all);
    // The first is a's (it arrived first); then they alternate rather than a's four first.
    expect(order.slice(0, 4).filter((s) => s === 'b').length).toBeGreaterThanOrEqual(1);
  });

  it('per-site concurrency: one site never holds more than two workers', async () => {
    pool = new RenderPool({ workers: 4, maxQueued: 40 });
    // All four workers loaded first: the sampling below is about scheduling, not start-up.
    await expect.poll(() => pool!.readyWorkers(), { timeout: 20_000 }).toBe(4);
    const jobs = Array.from({ length: 6 }, () => pool!.render(job('a', SLOW, 'slow:3')).catch(() => 'stopped'));
    const b = pool.render(job('b'));
    // Sampled over a second: four workers, six jobs of a waiting, yet never more than two of them running.
    let max = 0;
    for (let i = 0; i < 50; i++) {
      max = Math.max(max, pool.running().a ?? 0);
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(max).toBe(2);
    await expect(b).resolves.toContain('<title>');
    await Promise.all(jobs);
  }, 30_000);

  it('admission refuses the newcomer without evicting anyone when evictions would not make room', async () => {
    const size = (j: RenderJob) => Buffer.byteLength(JSON.stringify([j.templates, j.vm, j.system]));
    const small = job('b');
    const J = size(small);
    const big: RenderJob = { ...job('a'), vm: { ...vms.home, list: Array.from({ length: 12 }, (_, i) => ({ ...vms.home.list[0]!, id: `x${i}` })) } };
    expect(size(big)).toBeGreaterThan(1.3 * J);
    pool = new RenderPool({ workers: 1, maxQueued: 10, maxQueuedBytes: 2 * J + 10, maxJobBytes: 10 * J, queueTimeoutMs: 20_000 });
    await expect.poll(() => pool!.readyWorkers(), { timeout: 20_000 }).toBe(1);
    const busy = pool.render(job('z', SLOW, 'slow:4')).catch(() => 'stopped');
    await expect.poll(() => pool!.running().z ?? 0).toBe(1);
    const a1 = pool.render(job('a')).catch((e: { code: string }) => e.code);
    const b1 = pool.render(small).catch((e: { code: string }) => e.code);
    expect(pool.queued()).toEqual({ a: 1, b: 1 });
    await expect(pool.render(big)).rejects.toMatchObject({ code: 'RENDER_QUEUE_FULL' });
    // b was not sacrificed for a job that still could not fit.
    expect(pool.queued()).toEqual({ a: 1, b: 1 });
    await Promise.all([busy, a1, b1]);
  }, 30_000);

  it('close() waits for a worker still being terminated', async () => {
    pool = new RenderPool({ workers: 1, timeoutMs: 200, renderLimitMs: 600_000 });
    const slow = pool.render(job('a', SLOW, 'slow:5')).catch((e: { code: string }) => e.code);
    await expect(slow).resolves.toBe('RENDER_TIMEOUT');
    const closing = pool.close();
    // A second caller gets the same shutdown, not an early answer.
    expect(pool.close()).toBe(closing);
    pool = null;
    await expect(closing).resolves.toBeUndefined();
  });

  it('a job larger than the per-job limit is refused at once', async () => {
    pool = new RenderPool({ workers: 1, maxJobBytes: 10_000 });
    const big = { ...vms.home, list: Array.from({ length: 200 }, (_, i) => ({ ...vms.home.list[0]!, id: `c${i}` })) };
    await expect(pool.render({ ...job('a'), vm: big })).rejects.toMatchObject({ code: 'RENDER_TOO_LARGE' });
  });
});
