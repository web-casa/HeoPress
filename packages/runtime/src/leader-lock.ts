// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
/**
 * Scheduled jobs that run once per slot across all workers (HeoPress P03
 * task 3.2; design "故障语义"; spec "定时任务单次执行").
 *
 * Every worker runs the same node-cron schedules. When a slot fires:
 *   1. The worker claims it by inserting `(schedule_key, scheduled_at)` into
 *      `lumibase_schedule_runs`. The primary key admits one row, so exactly
 *      one worker gets the slot; the others skip it. `scheduled_at` is the
 *      slot's planned time (node-cron's `ctx.date`), truncated to the second,
 *      so workers agree on it whatever their clocks say about "now".
 *   2. The winner takes a session-level `pg_try_advisory_lock` for the job on
 *      a reserved connection and, holding it, checks that no earlier slot of
 *      the job is still `running` with a live lease (`lease_until`). Either
 *      way it fails, the slot is recorded `skipped_overlap`. Otherwise it
 *      takes the lease itself, still under the lock, so two slots can never
 *      both pass the check.
 *   3. While the job runs, the lease is renewed through the pool every
 *      `lockCheckMs`; it lasts three intervals. If the lock connection dies
 *      but the process lives on, the lease keeps the next slot out until the
 *      job really ends — the job does not have to notice. If the process
 *      dies, renewals stop and the lease lapses.
 *   4. The outcome is recorded (`succeeded` / `failed`) and the lease ended.
 *
 * A worker that crashes mid-slot leaves the row `running`. The slot is not
 * run again, so its side effects cannot happen twice; work that must not be
 * lost is put on the durable queue, whose handlers are idempotent.
 *
 * Replaces the upstream Redis `SET NX PX` lock, which without Redis ran every
 * job on every replica.
 */
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';

export interface ScheduledJobOptions {
  /** Connection pool; the job holds one reserved connection while it runs. */
  sql: postgres.Sql;
  /** Recorded as the slot's owner (default: HOSTNAME + random suffix). */
  instanceId?: string;
  /** How often the lease is renewed and the lock checked while the job runs (default 5000 ms); the lease lasts three intervals. */
  lockCheckMs?: number;
  /** Told of each run's result (HeoPress P07a: one system event per run). A failing report never fails the run. */
  report?: ScheduledJobReport;
}

export type ScheduledRunOutcome = 'succeeded' | 'failed' | 'claimed-elsewhere' | 'overlap';

/**
 * What a scheduled run came to (HeoPress P07a task 11.1). A job returns it — or nothing, meaning succeeded — or throws
 * (failed). `incomplete`: it did what it could and work is left for the next slot; `skipped`: an earlier run of the
 * job had not finished. `sites`: how many sites ended in each state, for jobs that work site by site.
 */
export interface ScheduledJobResult {
  status: 'succeeded' | 'failed' | 'incomplete' | 'skipped';
  reason?: string;
  sites?: Record<string, number>;
}

/** Told of every run this worker executed or skipped (not of slots another worker took). */
export type ScheduledJobReport = (scheduleKey: string, result: ScheduledJobResult & { startedAt: Date; finishedAt: Date }) => Promise<void> | void;

const defaultInstanceId = (() => {
  const host = process.env.HOSTNAME || process.env.COMPUTERNAME || 'local';
  return `${host}:${randomUUID().slice(0, 8)}`;
})();

/** Planned slot time, truncated to the second. */
function slotOf(date: Date): Date {
  return new Date(Math.floor(date.getTime() / 1000) * 1000);
}

/**
 * Claim and run one slot of a scheduled job. Never throws.
 *
 * Claim, lock and outcome run on one reserved connection, so a full pool
 * cannot leave a finished job unable to record itself (Codex review 2, #6).
 * If that connection dies while `fn` runs, the lease (renewed through the
 * pool) still keeps the next slot from overlapping (Codex review 3, #2), and
 * `fn` receives an AbortSignal so it can stop early if it wants to. Only if
 * this process can no longer reach the database at all does the lease lapse
 * while `fn` may still be running; the signal fires then as well.
 */
/** A scheduled job: returns its result, nothing (succeeded), or throws (failed). */
export type ScheduledJobFn = (signal: AbortSignal) => void | ScheduledJobResult | Promise<void | ScheduledJobResult>;

export async function runScheduledSlot(
  scheduleKey: string,
  scheduledAt: Date,
  fn: ScheduledJobFn,
  options: ScheduledJobOptions,
): Promise<ScheduledRunOutcome> {
  const startedAt = new Date();
  const report = async (result: ScheduledJobResult) => {
    if (!options.report) return;
    try {
      await options.report(scheduleKey, { ...result, startedAt, finishedAt: new Date() });
    } catch (err) {
      console.error(`[schedule] ${scheduleKey}: could not record the run:`, message(err));
    }
  };
  const { sql } = options;
  const owner = options.instanceId ?? defaultInstanceId;
  // As text: the pool is shared with Drizzle, whose driver replaces
  // postgres.js's timestamp serializer, so a Date parameter would not bind.
  const slot = slotOf(scheduledAt).toISOString();
  const lockKey = `heopress:schedule:${scheduleKey}`;
  const checkMs = options.lockCheckMs ?? 5000;
  const leaseMs = checkMs * 3;

  let conn: postgres.ReservedSql;
  try {
    conn = await sql.reserve();
  } catch (err) {
    console.warn(`[schedule] no connection for ${scheduleKey} — skipping this slot:`, message(err));
    return 'claimed-elsewhere';
  }

  // After its session died, a reserved connection may throw synchronously or
  // never answer; bookkeeping must neither crash nor hang, so it is bounded
  // and, once the lock is known lost, goes through the pool instead.
  let connDead = false;
  const quietly = async (run: () => PromiseLike<unknown>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        run(),
        new Promise((resolve) => {
          timer = setTimeout(resolve, 2000);
        }),
      ]);
    } catch {
      /* best effort */
    } finally {
      clearTimeout(timer);
    }
  };
  const finish = (status: string, error: string | null = null) =>
    quietly(() => (connDead ? sql : conn)`
      UPDATE lumibase_schedule_runs SET status = ${status}, finished_at = now(), error = ${error}, lease_until = NULL
       WHERE schedule_key = ${scheduleKey} AND scheduled_at = ${slot}::timestamptz`);

  let locked = false;
  let watchdog: ReturnType<typeof setInterval> | undefined;
  try {
    const claimed = await conn`
      INSERT INTO lumibase_schedule_runs (schedule_key, scheduled_at, owner, status)
      VALUES (${scheduleKey}, ${slot}::timestamptz, ${owner}, 'running')
      ON CONFLICT DO NOTHING
      RETURNING 1`;
    if (claimed.length === 0) return 'claimed-elsewhere';

    const rows = await conn<{ locked: boolean; pid: number }[]>`
      SELECT pg_try_advisory_lock(hashtextextended(${lockKey}, 0)) AS locked, pg_backend_pid() AS pid`;
    locked = rows[0]?.locked === true;
    const lockPid = rows[0]?.pid;
    if (!locked) {
      await finish('skipped_overlap');
      await report({ status: 'skipped', reason: 'an earlier run had not finished' });
      return 'overlap';
    }
    // Under the lock: an earlier slot whose runner lost the lock but still
    // renews its lease is running; take the lease only if there is none.
    // Lease times are measured from when a statement was *sent*: the
    // database starts the lease no earlier, so a slow answer can only make
    // our view more conservative (Codex review 4, #7).
    let leaseFrom = Date.now();
    const leased = await conn`
      UPDATE lumibase_schedule_runs SET lease_until = now() + make_interval(secs => ${leaseMs / 1000})
       WHERE schedule_key = ${scheduleKey} AND scheduled_at = ${slot}::timestamptz
         AND NOT EXISTS (
           SELECT 1 FROM lumibase_schedule_runs o
            WHERE o.schedule_key = ${scheduleKey} AND o.scheduled_at <> ${slot}::timestamptz
              AND o.status = 'running' AND o.lease_until > now())
       RETURNING 1`;
    if (leased.length === 0) {
      await finish('skipped_overlap');
      await report({ status: 'skipped', reason: 'an earlier run had not finished' });
      return 'overlap';
    }

    // Three independent checks per tick, none waiting for another:
    //   - renew the lease through the pool, at most one renewal in flight,
    //     and only while it is still live (an expired lease is never revived);
    //   - expiry: if no renewal sent within the last lease period succeeded,
    //     the lease may be gone — signal the job, whatever queries hang;
    //   - lock: does the session that took the advisory lock still hold it?
    const lost = new AbortController();
    const signalLost = (why: string) => {
      if (lost.signal.aborted) return;
      console.error(`[schedule] ${scheduleKey}: ${why}; signalling the job to stop`);
      connDead = true;
      lost.abort(new Error(`scheduled job ${why}`));
    };
    let renewing = false;
    let checkingLock = false;
    watchdog = setInterval(() => {
      if (Date.now() - leaseFrom >= leaseMs) signalLost('lease lost');
      // Keep renewing after a signal too: the job may not stop at once, and
      // its live lease is what keeps the next slot out (Codex review 3, #2).
      if (!renewing) {
        renewing = true;
        const sent = Date.now();
        void sql`
          UPDATE lumibase_schedule_runs SET lease_until = now() + make_interval(secs => ${leaseMs / 1000})
           WHERE schedule_key = ${scheduleKey} AND scheduled_at = ${slot}::timestamptz
             AND status = 'running' AND lease_until > now()
           RETURNING 1`.then(
          (rows) => {
            if (rows.length > 0) leaseFrom = Math.max(leaseFrom, sent);
            else signalLost('lease lost');
          },
          () => {
            /* not renewed; the expiry check decides */
          },
        ).finally(() => {
          renewing = false;
        });
      }
      if (!checkingLock && !lost.signal.aborted) {
        checkingLock = true;
        void sql<{ held: boolean }[]>`
          SELECT EXISTS (SELECT 1 FROM pg_locks
                          WHERE locktype = 'advisory' AND granted AND pid = ${lockPid ?? -1}) AS held`.then(
          (held) => {
            if (held[0]?.held === false) signalLost('lock lost');
          },
          () => {
            /* cannot tell; check again next time */
          },
        ).finally(() => {
          checkingLock = false;
        });
      }
    }, checkMs);
    watchdog.unref?.();

    try {
      const result = (await fn(lost.signal)) ?? { status: 'succeeded' as const };
      if (result.status === 'failed') {
        await finish('failed', (result.reason ?? 'failed').slice(0, 2000));
        await report(result);
        console.error(`[schedule] ${scheduleKey} failed:`, result.reason ?? 'failed');
        return 'failed';
      }
      await finish('succeeded');
      await report(result);
      return 'succeeded';
    } catch (err) {
      await finish('failed', message(err).slice(0, 2000));
      await report({ status: 'failed', reason: message(err).slice(0, 2000) });
      console.error(`[schedule] ${scheduleKey} failed:`, message(err));
      return 'failed';
    }
  } catch (err) {
    await finish('failed', message(err).slice(0, 2000));
    await report({ status: 'failed', reason: message(err).slice(0, 2000) });
    console.error(`[schedule] ${scheduleKey} could not run:`, message(err));
    return 'failed';
  } finally {
    if (watchdog) clearInterval(watchdog);
    if (locked && !connDead) await quietly(() => conn`SELECT pg_advisory_unlock(hashtextextended(${lockKey}, 0))`);
    // Housekeeping: a week of history per job is enough to audit missed slots.
    await quietly(() => (connDead ? sql : conn)`
      DELETE FROM lumibase_schedule_runs
       WHERE schedule_key = ${scheduleKey} AND scheduled_at < now() - interval '7 days'`);
    try {
      conn.release();
    } catch {
      /* already gone */
    }
  }
}

/**
 * Wrap a node-cron callback so each slot runs on exactly one worker:
 * `cron.schedule(expr, scheduledJob('audit-rotation', fn, { sql }))`.
 */
export function scheduledJob(
  scheduleKey: string,
  fn: ScheduledJobFn,
  options: ScheduledJobOptions,
): (ctx?: { date?: Date }) => void {
  return (ctx) => {
    void runScheduledSlot(scheduleKey, ctx?.date ?? new Date(), fn, options);
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
