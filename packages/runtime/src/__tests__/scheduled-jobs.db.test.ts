import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { runScheduledSlot } from '../leader-lock';
import { PG_URL, connectRuntimeDb, likeDrizzle } from './helpers/pg';

/**
 * Scheduled jobs on PostgreSQL (P03 task 3.2; spec "定时任务单次执行"):
 * one claim per (schedule_key, scheduled_at) across workers, an advisory lock
 * held for as long as the job's work runs, and a crashed slot that is never
 * run a second time.
 */

const run = promisify(execFile);
const CHILD = path.resolve(__dirname, 'fixtures/schedule-child.ts');
const HANG_CHILD = path.resolve(__dirname, 'fixtures/schedule-hang-child.ts');

async function eventuallySucceeds(check: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met');
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe.skipIf(!PG_URL)('scheduled jobs (PostgreSQL)', () => {
  let sql: postgres.Sql;

  beforeAll(async () => {
    sql = await connectRuntimeDb(10);
    await sql`CREATE TABLE IF NOT EXISTS heopress_test_schedule_effects (slot text NOT NULL, pid int NOT NULL)`;
  });

  beforeEach(async () => {
    await sql`TRUNCATE lumibase_schedule_runs, heopress_test_schedule_effects`;
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`DROP TABLE IF EXISTS heopress_test_schedule_effects`;
    await sql.end({ timeout: 1 });
  });

  /**
   * A slot on yesterday's date (UTC) at the given time: always in the past and within the 7 days the scheduler keeps
   * run rows (it deletes older ones after each run — a fixed date in the past made these tests fail once it was a week old).
   */
  const DAY = Math.floor(Date.now() / 86_400_000) * 86_400_000 - 86_400_000;
  const slotAt = (h: number, m: number, sec: number) => new Date(DAY + ((h * 60 + m) * 60 + sec) * 1000);

  const rows = () => sql<{ schedule_key: string; status: string }[]>`
    SELECT schedule_key, status FROM lumibase_schedule_runs ORDER BY scheduled_at`;

  it('two worker processes reaching the same slots run each slot exactly once', async () => {
    // Five whole-second slots (cron's finest grain), starting once both
    // processes are up.
    const base = Math.ceil((Date.now() + 3000) / 1000) * 1000;
    const slots = Array.from({ length: 5 }, (_, i) => new Date(base + i * 1000).toISOString());
    const spawnWorker = () =>
      run(process.execPath, ['--import', 'tsx', CHILD, 'race-job', ...slots], {
        cwd: path.resolve(__dirname, '../..'),
        env: process.env,
      });
    const [a, b] = await Promise.all([spawnWorker(), spawnWorker()]);
    const outcomes = [...JSON.parse(a.stdout), ...JSON.parse(b.stdout)] as string[];
    expect(outcomes.filter((o) => o === 'succeeded')).toHaveLength(5);
    expect(outcomes.filter((o) => o === 'claimed-elsewhere')).toHaveLength(5);
    const effects = await sql<{ slot: string; n: number }[]>`
      SELECT slot, count(*)::int AS n FROM heopress_test_schedule_effects GROUP BY slot`;
    expect(effects).toHaveLength(5);
    expect(effects.every((e) => e.n === 1)).toBe(true);
    expect((await rows()).map((r) => r.status)).toEqual(Array(5).fill('succeeded'));
  }, 60_000);

  it('holds the lock until awaited work resolves, so the next slot is an overlap', async () => {
    let release!: () => void;
    const work = new Promise<void>((r) => (release = r));
    const first = runScheduledSlot('slow-job', slotAt(0, 0, 0), async () => work, { sql });
    await new Promise((r) => setTimeout(r, 100));
    expect(await runScheduledSlot('slow-job', slotAt(0, 1, 0), async () => {}, { sql })).toBe('overlap');
    release();
    expect(await first).toBe('succeeded');
    expect(await runScheduledSlot('slow-job', slotAt(0, 2, 0), async () => {}, { sql })).toBe('succeeded');
    expect((await rows()).map((r) => r.status)).toEqual(['succeeded', 'skipped_overlap', 'succeeded']);
  });

  it('control: a function that does not await its work releases the lock at once', async () => {
    // Why serve.ts registrations must be async (serve-cron-await.test.ts).
    let release!: () => void;
    const work = new Promise<void>((r) => (release = r));
    await runScheduledSlot('void-job', slotAt(1, 0, 0), () => {
      void work;
    }, { sql });
    expect(await runScheduledSlot('void-job', slotAt(1, 1, 0), async () => {}, { sql })).toBe('succeeded');
    release();
  });

  it('a worker process killed mid-slot frees the lock, and its slot is not run again', async () => {
    const slot = slotAt(2, 0, 0);
    const child = spawn(process.execPath, ['--import', 'tsx', HANG_CHILD, 'crash-job', slot.toISOString()], {
      cwd: path.resolve(__dirname, '../..'),
      env: process.env,
    });
    await new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (d: Buffer) => d.toString().includes('inside') && resolve());
      child.once('exit', () => reject(new Error('child exited before running the job')));
    });
    child.kill('SIGKILL'); // a real crash: no cleanup runs
    await new Promise((r) => child.once('exit', r));

    // The session died with the process, so its advisory lock is gone, and
    // nobody renews its lease any more…
    await eventuallySucceeds(async () =>
      (await sql<{ live: boolean }[]>`
        SELECT COALESCE(lease_until > now(), false) AS live FROM lumibase_schedule_runs
         WHERE schedule_key = 'crash-job' AND scheduled_at = ${slot.toISOString()}::timestamptz`)[0]?.live === false,
    );
    let ranNext = false;
    expect(await runScheduledSlot('crash-job', new Date(slot.getTime() + 60_000), async () => { ranNext = true; }, { sql })).toBe('succeeded');
    expect(ranNext).toBe(true);
    // …but the crashed slot itself is never run again.
    let reran = false;
    expect(await runScheduledSlot('crash-job', slot, async () => { reran = true; }, { sql })).toBe('claimed-elsewhere');
    expect(reran).toBe(false);
    expect((await rows()).map((r) => r.status)).toEqual(['running', 'succeeded']);
  }, 30_000);

  it('records its outcome even when the pool has a single connection (Codex review 2, #6)', async () => {
    const one = likeDrizzle(postgres(PG_URL!, { max: 1, onnotice: () => {}, prepare: false }));
    try {
      const outcome = await Promise.race([
        runScheduledSlot('tiny-pool-job', slotAt(4, 0, 0), async () => {}, { sql: one }),
        new Promise((r) => setTimeout(() => r('hung'), 5000)),
      ]);
      expect(outcome).toBe('succeeded');
    } finally {
      await one.end({ timeout: 1 });
    }
  });

  it('tells the job to stop when its lock connection dies (Codex review 2, #3)', async () => {
    const own = likeDrizzle(postgres(PG_URL!, { max: 2, onnotice: () => {}, prepare: false, connection: { application_name: 'heopress-lock-owner' } }));
    let aborted: unknown = null;
    const running = runScheduledSlot(
      'lost-lock-job',
      slotAt(5, 0, 0),
      (signal) =>
        new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => {
            aborted = signal.reason;
            resolve();
          });
        }),
      { sql: own, lockCheckMs: 100 },
    );
    await new Promise((r) => setTimeout(r, 300));
    await sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'heopress-lock-owner'`;
    await running;
    expect(String(aborted)).toMatch(/lock lost/);
    await own.end({ timeout: 1 }).catch(() => {});
  }, 15_000);

  it('a job that keeps running after losing its lock still blocks the next slot (Codex review 3, #2)', async () => {
    const own = likeDrizzle(postgres(PG_URL!, { max: 3, onnotice: () => {}, prepare: false, connection: { application_name: 'heopress-stubborn' } }));
    const slot = slotAt(6, 0, 0);
    let finishWork!: () => void;
    // Ignores its signal, like most production jobs.
    const running = runScheduledSlot('stubborn-job', slot, () => new Promise<void>((r) => (finishWork = r)), { sql: own, lockCheckMs: 100 });
    await new Promise((r) => setTimeout(r, 300));
    await sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'heopress-stubborn'`;
    await new Promise((r) => setTimeout(r, 600)); // several renewals through the reconnected pool

    let overlapped = false;
    expect(await runScheduledSlot('stubborn-job', new Date(slot.getTime() + 60_000), async () => { overlapped = true; }, { sql })).toBe('overlap');
    expect(overlapped).toBe(false);

    finishWork();
    await running;
    expect(await runScheduledSlot('stubborn-job', new Date(slot.getTime() + 120_000), async () => {}, { sql })).toBe('succeeded');
    await own.end({ timeout: 1 }).catch(() => {});
  }, 15_000);

  it('signals the job when renewals hang, without piling them up (Codex review 4, #7)', async () => {
    let renewals = 0;
    const hanging = new Proxy(sql, {
      apply(targetFn, thisArg, args: [TemplateStringsArray, ...unknown[]]) {
        const text = args[0]?.join?.('') ?? '';
        if (text.includes("AND status = 'running' AND lease_until > now()")) {
          renewals += 1;
          return new Promise(() => {}); // never answers
        }
        return Reflect.apply(targetFn, thisArg, args);
      },
    }) as typeof sql;
    let aborted: unknown = null;
    const started = Date.now();
    await runScheduledSlot(
      'hanging-renewal-job',
      slotAt(7, 0, 0),
      (signal) =>
        new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => {
            aborted = signal.reason;
            resolve();
          });
        }),
      { sql: hanging, lockCheckMs: 50 },
    );
    expect(String(aborted)).toMatch(/lease lost/);
    expect(Date.now() - started).toBeLessThan(1000); // lease is 150 ms
    expect(renewals).toBe(1); // one hung renewal, not one per tick
  });

  it('truncates the slot to the second, so workers with slightly different clocks agree', async () => {
    const ran: number[] = [];
    const at = slotAt(3, 0, 0).getTime();
    expect(await runScheduledSlot('clock-job', new Date(at + 120), async () => { ran.push(1); }, { sql })).toBe('succeeded');
    expect(await runScheduledSlot('clock-job', new Date(at + 870), async () => { ran.push(2); }, { sql })).toBe('claimed-elsewhere');
    expect(ran).toEqual([1]);
  });
});
