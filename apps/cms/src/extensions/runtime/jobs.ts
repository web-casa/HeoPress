/**
 * Plugin scheduled and queued jobs (HeoPress P12 tasks 3.1, 3.2; spec extensions/runtime-extensions "插件定时任务").
 *
 * - **Singleton**: a run holds the lease of its `(site, plugin, job)` row (`lumibase_plugin_jobs`); a second run of
 *   the same job on the same site while it lasts is not started (`busy`). Queued runs also carry the P03 queue's
 *   singleton key, so they wait instead of piling up.
 * - **Limits**: each run has a duration and an outbound request budget (`RunScope`); over either it is terminated,
 *   recorded as `timeout` / `limit`, and the plugin context refuses further calls from it.
 * - **Retries**: a failed run is retried with exponential backoff up to the job's retry cap; then the job waits for
 *   its next schedule.
 * - **Batches**: `ctx.checkpoint(progress)` saves progress during a run; `ctx.continueLater(progress)` ends the batch and
 *   schedules the next one right away. A run cut short by a limit resumes from its last checkpoint.
 * - **Stops**: nothing starts while the site's kill switch (a site freeze) is on or the plugin is disabled, and a run
 *   in progress is stopped when either happens.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { agentFreezes, pluginJobRuns, pluginJobs, sites, type Database } from '@heopress/database';
import { JOB_LIMITS } from '@heopress/contracts/extensions';
import type { QueueProvider } from '@heopress/runtime';
import { formatSafeError } from '@heopress/contracts/utils';
import { runSiteTransaction } from '../../services/rls-transaction';
import { RunLimitError, withRunScope } from './run-scope';
import { isRunnable, grantsPoint, type PluginHost, type PluginJob } from './plugin-host';

const PLUGIN_JOB_QUEUE = 'plugin-jobs';

type JobTrigger = 'schedule' | 'retry' | 'continuation' | 'queue' | 'manual';

export interface JobRunRequest {
  siteId: string;
  extensionName: string;
  jobName: string;
  trigger: JobTrigger;
  payload?: unknown;
}

type JobRunStatus = 'succeeded' | 'continued' | 'failed' | 'timeout' | 'limit' | 'stopped';

export type JobRunOutcome =
  | { status: 'skipped'; reason: 'disabled' | 'kill-switch' | 'unknown-job' | 'busy' }
  | {
      status: JobRunStatus;
      runId: string;
      requests: number;
      error?: string;
      /** A queued run to be queued again after this many ms (its retry or next batch), with the same payload. */
      again?: number;
    };

const STOP_CHECK_MS = 1_000;
/** Lease beyond the run's own limit, for the bookkeeping after it. */
const LEASE_GRACE_MS = 30_000;

/** Whether the site's kill switch (a site-wide freeze, P09) is on. */
async function siteFrozen(db: Database, siteId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: agentFreezes.id })
    .from(agentFreezes)
    .where(and(eq(agentFreezes.siteId, siteId), eq(agentFreezes.scope, 'site'), isNull(agentFreezes.liftedAt)))
    .limit(1);
  return Boolean(row);
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 1000);
}

export interface PluginJobRunnerDeps {
  db: Database;
  host: PluginHost;
  now?: () => Date;
  /** How often a run checks whether the plugin was disabled or the kill switch turned on (ms). */
  stopCheckMs?: number;
}

export class PluginJobRunner {
  constructor(private readonly deps: PluginJobRunnerDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** Whether the plugin may run jobs on the site right now. */
  private async runnable(siteId: string, extensionName: string): Promise<'ok' | 'disabled' | 'kill-switch'> {
    const row = await this.deps.host.row(siteId, extensionName);
    if (!row || !isRunnable(row) || !grantsPoint(row, 'jobs')) return 'disabled';
    if (await siteFrozen(this.deps.db, siteId)) return 'kill-switch';
    return 'ok';
  }

  private async findJob(req: JobRunRequest): Promise<PluginJob | null> {
    const row = await this.deps.host.row(req.siteId, req.extensionName);
    if (!row) return null;
    const loaded = await this.deps.host.load(row);
    return loaded?.jobs.find((j) => j.name === req.jobName) ?? null;
  }

  /** Take the job's lease; null when another run holds it. */
  private async acquire(req: JobRunRequest, job: PluginJob): Promise<{ token: string; progress: unknown; attempts: number } | null> {
    const token = randomUUID();
    const until = new Date(this.now().getTime() + job.durationMs + LEASE_GRACE_MS);
    const rows = (await this.deps.db.execute(sql`
      INSERT INTO lumibase_plugin_jobs (site_id, extension_name, job_name, lease_token, lease_until, updated_at)
      VALUES (${req.siteId}, ${req.extensionName}, ${req.jobName}, ${token}, ${until.toISOString()}::timestamptz, now())
      ON CONFLICT (site_id, extension_name, job_name) DO UPDATE
         SET lease_token = EXCLUDED.lease_token, lease_until = EXCLUDED.lease_until, updated_at = now()
       WHERE lumibase_plugin_jobs.lease_until IS NULL OR lumibase_plugin_jobs.lease_until < now()
      RETURNING progress, attempts`)) as unknown as Array<{ progress: unknown; attempts: number }>;
    const row = rows[0];
    return row ? { token, progress: row.progress ?? null, attempts: Number(row.attempts ?? 0) } : null;
  }

  /** Run one job now (or not, saying why). Never throws for the plugin's failure. */
  async run(req: JobRunRequest): Promise<JobRunOutcome> {
    const state = await this.runnable(req.siteId, req.extensionName);
    if (state !== 'ok') return { status: 'skipped', reason: state };
    const job = await this.findJob(req);
    if (!job) return { status: 'skipped', reason: 'unknown-job' };
    const lease = await this.acquire(req, job);
    if (!lease) return { status: 'skipped', reason: 'busy' };

    const db = this.deps.db;
    const [run] = await runSiteTransaction(db, req.siteId, (tx) =>
      tx
        .insert(pluginJobRuns)
        .values({ siteId: req.siteId, extensionName: req.extensionName, jobName: req.jobName, trigger: req.trigger, status: 'running', attempt: lease.attempts + 1 })
        .returning({ id: pluginJobRuns.id }),
    );
    const runId = run!.id;
    const key = and(eq(pluginJobs.siteId, req.siteId), eq(pluginJobs.extensionName, req.extensionName), eq(pluginJobs.jobName, req.jobName), eq(pluginJobs.leaseToken, lease.token));

    let continuation: { progress: unknown } | null = null;
    let watcher: ReturnType<typeof setInterval> | undefined;
    let status: JobRunStatus;
    let error: string | undefined;
    let requests = 0;
    try {
      const { scope } = await withRunScope({ durationMs: job.durationMs, maxRequests: job.maxRequests, label: `job ${req.extensionName}/${req.jobName}` }, async (scope) => {
        // Disabling the plugin or turning on the kill switch stops the run.
        watcher = setInterval(() => {
          void this.runnable(req.siteId, req.extensionName)
            .then((s) => {
              if (s !== 'ok') scope.stop(new RunLimitError('stopped', s === 'kill-switch' ? 'the site kill switch is on' : 'the plugin was disabled'));
            })
            .catch(() => {});
        }, this.deps.stopCheckMs ?? STOP_CHECK_MS);
        (watcher as unknown as { unref?: () => void }).unref?.();
        await job.run({
          siteId: req.siteId,
          trigger: req.trigger,
          payload: req.payload ?? null,
          progress: lease.progress,
          signal: scope.signal,
          timeLeft: () => scope.timeLeft(),
          checkpoint: async (progress: unknown) => {
            scope.assertActive();
            await db.update(pluginJobs).set({ progress: progress ?? null, updatedAt: new Date() }).where(key);
          },
          continueLater: (progress: unknown) => {
            continuation = { progress: progress ?? null };
          },
        });
        return scope;
      });
      requests = scope.requests;
      status = continuation ? 'continued' : 'succeeded';
    } catch (err) {
      if (err instanceof RunLimitError) status = err.reason;
      else status = 'failed';
      error = errorText(err);
      if (status === 'failed') console.error(`[plugin-jobs] ${req.extensionName}/${req.jobName} on ${req.siteId} failed`, formatSafeError(err));
    } finally {
      clearInterval(watcher);
    }

    // Bookkeeping: progress, next due time, attempts; then release the lease.
    const now = this.now();
    const scheduleNext = job.everyMinutes ? new Date(now.getTime() + job.everyMinutes * 60_000) : null;
    let set: Partial<typeof pluginJobs.$inferInsert>;
    if (status === 'succeeded') {
      set = { progress: null, attempts: 0, nextRunAt: scheduleNext, lastError: null };
    } else if (status === 'continued') {
      set = { progress: (continuation as { progress: unknown } | null)?.progress ?? null, attempts: 0, nextRunAt: new Date(now.getTime() + JOB_LIMITS.continuationDelayMs), lastError: null };
    } else if (status === 'stopped') {
      // Disabled or frozen: no retry; the schedule resumes when it is allowed again (progress kept).
      set = { nextRunAt: scheduleNext, lastError: error ?? null };
    } else {
      const attempts = lease.attempts + 1;
      const retry = attempts <= job.maxRetries;
      set = {
        attempts: retry ? attempts : 0,
        nextRunAt: retry ? new Date(now.getTime() + JOB_LIMITS.retryBaseMs * 2 ** (attempts - 1)) : scheduleNext,
        lastError: error ?? null,
      };
    }
    // A queued run has no schedule: its retry or next batch goes back to the queue with its payload, not to the tick.
    let again: number | undefined;
    if (req.trigger === 'queue') {
      if (set.nextRunAt && (status === 'continued' || (status !== 'succeeded' && status !== 'stopped' && (set.attempts ?? 0) > 0))) {
        again = Math.max(0, set.nextRunAt.getTime() - now.getTime());
      }
      set.nextRunAt = null;
    }
    await db
      .update(pluginJobs)
      .set({ ...set, lastRunAt: now, lastStatus: status, leaseToken: null, leaseUntil: null, updatedAt: new Date() })
      .where(key);
    await runSiteTransaction(db, req.siteId, (tx) =>
      tx.update(pluginJobRuns).set({ status, requests, error: error ?? null, finishedAt: new Date() }).where(and(eq(pluginJobRuns.siteId, req.siteId), eq(pluginJobRuns.id, runId))),
    );
    return { status, runId, requests, ...(error ? { error } : {}), ...(again !== undefined ? { again } : {}) };
  }
}

export interface PluginJobSchedulerDeps {
  db: Database;
  host: PluginHost;
  runner: PluginJobRunner;
  /** Hand a due run to the queue (singleton per job); absent → run it in this process. */
  dispatch?: (req: JobRunRequest) => Promise<void>;
  now?: () => Date;
}

/**
 * Finds due jobs: each scheduled job of every enabled plugin with `ext:jobs` on a site whose kill switch is off, and
 * every job row due for a retry or a continuation.
 */
export class PluginJobScheduler {
  constructor(private readonly deps: PluginJobSchedulerDeps) {}

  async tick(): Promise<JobRunRequest[]> {
    const now = this.deps.now?.() ?? new Date();
    const started: JobRunRequest[] = [];
    const siteRows = await this.deps.db.select({ id: sites.id }).from(sites);
    for (const { id: siteId } of siteRows) {
      const rows = await this.deps.host.enabledRows(siteId, 'jobs');
      if (rows.length === 0) continue;
      if (await siteFrozen(this.deps.db, siteId)) continue;
      for (const row of rows) {
        const loaded = await this.deps.host.load(row);
        if (!loaded) continue;
        const state = await this.deps.db
          .select()
          .from(pluginJobs)
          .where(and(eq(pluginJobs.siteId, siteId), eq(pluginJobs.extensionName, row.name)));
        const byName = new Map(state.map((s) => [s.jobName, s]));
        // Scheduled jobs only: a queued job runs from the queue, its retries and batches too.
        for (const job of loaded.jobs.filter((j) => j.everyMinutes !== null)) {
          const s = byName.get(job.name);
          // A scheduled job seen for the first time is due now.
          if (!s && job.everyMinutes) {
            await this.deps.db
              .insert(pluginJobs)
              .values({ siteId, extensionName: row.name, jobName: job.name, nextRunAt: now })
              .onConflictDoNothing();
          }
          const due = s ? s.nextRunAt !== null && s.nextRunAt <= now : true;
          const leased = s?.leaseUntil ? s.leaseUntil > now : false;
          if (!due || leased) continue;
          const trigger: JobTrigger = s?.progress != null && s.lastStatus === 'continued' ? 'continuation' : (s?.attempts ?? 0) > 0 ? 'retry' : 'schedule';
          const req: JobRunRequest = { siteId, extensionName: row.name, jobName: job.name, trigger };
          started.push(req);
          if (this.deps.dispatch) await this.deps.dispatch(req);
          else void this.deps.runner.run(req).catch(() => {});
        }
      }
    }
    return started;
  }
}

/** The P03 queue as the plugin jobs' transport: one active run per job and site, the others wait. */
export function queueJobDispatcher(queue: QueueProvider): (req: JobRunRequest) => Promise<void> {
  return async (req) => {
    await queue.enqueue(PLUGIN_JOB_QUEUE, 'run', req, {
      singletonKey: `plugin:${req.siteId}:${req.extensionName}:${req.jobName}`,
      attempts: 1,
    });
  };
}

/** `ctx.jobs.enqueue` through the queue. */
export function queueJobEnqueuer(queue: QueueProvider | undefined) {
  if (!queue) return undefined;
  const dispatch = queueJobDispatcher(queue);
  return (job: { siteId: string; extensionName: string; jobName: string; payload: unknown }) =>
    dispatch({ ...job, trigger: 'queue' });
}

/** The worker side of the queue: run, and put a busy run back for later. */
export function registerPluginJobWorker(queue: QueueProvider, runner: PluginJobRunner): void {
  queue.process<JobRunRequest>(PLUGIN_JOB_QUEUE, async (job) => {
    const outcome = await runner.run(job.data);
    if (job.data.trigger !== 'queue') return;
    const delay = outcome.status === 'skipped' ? (outcome.reason === 'busy' ? 5_000 : null) : (outcome.again ?? null);
    if (delay === null) return;
    await queue.enqueue(PLUGIN_JOB_QUEUE, 'run', job.data, {
      singletonKey: `plugin:${job.data.siteId}:${job.data.extensionName}:${job.data.jobName}`,
      attempts: 1,
      delay,
    });
  });
}
