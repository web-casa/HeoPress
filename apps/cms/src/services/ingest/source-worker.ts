import { and, asc, eq, isNull, lt, lte, or, sql } from 'drizzle-orm';
import type { FailureCategory } from '@heopress/contracts/schemas';
import { ingestSchedule, ingestSourceRuns, ingestSources, sites, type Database } from '@heopress/database';
import type { QueueProvider } from '@heopress/runtime';
import { runSiteTransaction } from '../rls-transaction';
import { nextRunAfter } from './schedule';
import { failureThreshold, recordRunResult, type RunResult, type RunStats } from './source-service';

/**
 * Scheduled source runs (HeoPress P08 task 1.4; spec ingest/sources "按计划采集").
 *
 * Every minute `scheduleDueSources` takes the due rows of `ingest_schedule`
 * (across sites; ids and times only) and, per source in its site's scope:
 * moves the row to the source's next local time (compare-and-set on the old
 * time, so two schedulers never claim the same slot) and enqueues one job
 * with singleton key `ingest-source:<id>` — at most one run of a source is
 * active at a time. Slots missed while the process was down are not replayed
 * one by one: the next run is the first scheduled time after now.
 *
 * The job (`processSourceJob`) records a run row — unique per source and
 * slot, so a redelivered job does nothing — calls the source runner, and
 * records the result with the health rules (`recordRunResult`). The runner
 * is pluggable: discovery and fetching (tasks 1.3, 2.x) install theirs with
 * `setSourceRunner`; until then it finds nothing.
 */

const INGEST_QUEUE = 'ingest-sources';

export interface SourceJobPayload {
  siteId: string;
  sourceId: string;
  /** The slot this run serves (ISO). */
  scheduledFor: string;
}

/** What a runner gets: the source as configured, the cap and a way to stop. */
export interface SourceRunContext {
  siteId: string;
  source: typeof ingestSources.$inferSelect;
  runId: string;
  /** The run's generation this worker holds: writes on the run's behalf name it (stale owners are refused). */
  generation: number;
  /** The slot the run serves (ISO): with the URL it names each fetch operation. */
  scheduledFor: string;
  maxItems: number;
  signal?: AbortSignal;
}

/** A runner's failure with its category (anything else thrown counts as `other`). */
export class SourceRunError extends Error {
  constructor(
    readonly category: FailureCategory,
    message: string,
    readonly stats?: RunStats,
  ) {
    super(message);
  }
}

export type SourceRunner = (ctx: SourceRunContext) => Promise<{ itemsFound: number; stats?: RunStats }>;

const noopRunner: SourceRunner = async () => ({ itemsFound: 0 });
let runner: SourceRunner = noopRunner;

/** Install the runner later slices provide (null: back to the no-op). */
export function setSourceRunner(next: SourceRunner | null): void {
  runner = next ?? noopRunner;
}

export interface IngestWorkerDeps {
  db: Database;
  queue?: QueueProvider;
  now?: () => Date;
  threshold?: number;
}

/** Enqueue a run for every source due at `now`. Returns the jobs enqueued. */
export async function scheduleDueSources(deps: IngestWorkerDeps, opts: { limit?: number } = {}): Promise<SourceJobPayload[]> {
  if (!deps.queue) return [];
  const queue = deps.queue;
  const now = deps.now?.() ?? new Date();
  const due = await deps.db
    .select()
    .from(ingestSchedule)
    .where(lte(ingestSchedule.nextRunAt, now))
    .orderBy(asc(ingestSchedule.nextRunAt))
    .limit(opts.limit ?? 200);
  const out: SourceJobPayload[] = [];
  for (const slot of due) {
    const job = await runSiteTransaction(
      deps.db,
      slot.siteId,
      async (tx) => {
        const [source] = await tx
          .select()
          .from(ingestSources)
          .where(and(eq(ingestSources.siteId, slot.siteId), eq(ingestSources.id, slot.sourceId)));
        if (!source || source.status !== 'active') {
          await tx.delete(ingestSchedule).where(and(eq(ingestSchedule.sourceId, slot.sourceId), eq(ingestSchedule.nextRunAt, slot.nextRunAt)));
          return null;
        }
        const next = nextRunAfter(source.scheduleTimes, source.timezone, now);
        const claimed = await tx
          .update(ingestSchedule)
          .set({ nextRunAt: next })
          .where(and(eq(ingestSchedule.sourceId, slot.sourceId), eq(ingestSchedule.nextRunAt, slot.nextRunAt)))
          .returning({ sourceId: ingestSchedule.sourceId });
        if (!claimed.length) return null; // another scheduler took this slot
        await tx.update(ingestSources).set({ nextRunAt: next }).where(and(eq(ingestSources.siteId, slot.siteId), eq(ingestSources.id, slot.sourceId)));
        const payload: SourceJobPayload = { siteId: slot.siteId, sourceId: slot.sourceId, scheduledFor: slot.nextRunAt.toISOString() };
        // Enqueued before the claim commits: if the commit fails the slot stays due and the next tick enqueues it again,
        // where the run row's (source, slot) key turns the extra job into a no-op.
        await queue.enqueue<SourceJobPayload>(INGEST_QUEUE, 'run-source', payload, { singletonKey: `ingest-source:${slot.sourceId}` });
        return payload;
      },
      { retry: false },
    );
    if (job) out.push(job);
  }
  return out;
}

export type SourceJobOutcome = 'skipped' | 'duplicate' | 'succeeded' | 'failed' | 'paused' | 'stale';

/** How long a run's lease lasts without renewal (the worker renews it every third of this). */
const RUN_LEASE_MS = 5 * 60_000;

/**
 * Start (or take over) the run of a slot. A redelivered job finds the slot's run: finished → `duplicate`; running
 * under a live lease → `duplicate` (its owner is still at work); running under a lapsed lease → taken over with the
 * next generation, so the previous owner's late writes are refused (HeoPress P08 task 2.7).
 */
async function claimRun(
  deps: IngestWorkerDeps,
  payload: SourceJobPayload,
  leaseMs: number,
): Promise<null | 'duplicate' | { source: typeof ingestSources.$inferSelect; runId: string; generation: number }> {
  const now = deps.now?.() ?? new Date();
  return runSiteTransaction(deps.db, payload.siteId, async (tx) => {
    const [source] = await tx
      .select()
      .from(ingestSources)
      .where(and(eq(ingestSources.siteId, payload.siteId), eq(ingestSources.id, payload.sourceId)));
    if (!source || source.status !== 'active') return null;
    const leaseUntil = new Date(now.getTime() + leaseMs);
    const [run] = await tx
      .insert(ingestSourceRuns)
      .values({ siteId: payload.siteId, sourceId: payload.sourceId, scheduledFor: new Date(payload.scheduledFor), startedAt: now, leaseUntil })
      .onConflictDoNothing({ target: [ingestSourceRuns.sourceId, ingestSourceRuns.scheduledFor] })
      .returning({ id: ingestSourceRuns.id, generation: ingestSourceRuns.generation });
    if (run) return { source, runId: run.id, generation: run.generation };
    const [taken] = await tx
      .update(ingestSourceRuns)
      .set({ generation: sql`${ingestSourceRuns.generation} + 1`, leaseUntil, startedAt: now })
      .where(
        and(
          eq(ingestSourceRuns.siteId, payload.siteId),
          eq(ingestSourceRuns.sourceId, payload.sourceId),
          eq(ingestSourceRuns.scheduledFor, new Date(payload.scheduledFor)),
          eq(ingestSourceRuns.outcome, 'running'),
          or(isNull(ingestSourceRuns.leaseUntil), lt(ingestSourceRuns.leaseUntil, now)),
        ),
      )
      .returning({ id: ingestSourceRuns.id, generation: ingestSourceRuns.generation });
    return taken ? { source, runId: taken.id, generation: taken.generation } : 'duplicate';
  });
}

/** Renew a run's lease; false when the run is no longer this generation's (taken over or finished). */
async function renewRunLease(deps: IngestWorkerDeps, siteId: string, runId: string, generation: number, leaseMs = RUN_LEASE_MS): Promise<boolean> {
  const now = deps.now?.() ?? new Date();
  const rows = await runSiteTransaction(deps.db, siteId, (tx) =>
    tx
      .update(ingestSourceRuns)
      .set({ leaseUntil: new Date(now.getTime() + leaseMs) })
      .where(and(eq(ingestSourceRuns.siteId, siteId), eq(ingestSourceRuns.id, runId), eq(ingestSourceRuns.generation, generation), eq(ingestSourceRuns.outcome, 'running')))
      .returning({ id: ingestSourceRuns.id }),
  );
  return rows.length > 0;
}

/** Run one source for one slot. */
export async function processSourceJob(
  deps: IngestWorkerDeps & { leaseMs?: number },
  payload: SourceJobPayload,
  signal?: AbortSignal,
): Promise<SourceJobOutcome> {
  const now = () => deps.now?.() ?? new Date();
  const leaseMs = deps.leaseMs ?? RUN_LEASE_MS;
  const started = await claimRun(deps, payload, leaseMs);
  if (started === null) return 'skipped';
  if (started === 'duplicate') return 'duplicate';

  // Keep the lease while the runner works; stop the runner when the run is lost.
  const lost = new AbortController();
  const runSignal = signal ? AbortSignal.any([signal, lost.signal]) : lost.signal;
  const heartbeat = setInterval(() => {
    renewRunLease(deps, payload.siteId, started.runId, started.generation, leaseMs)
      .then((ok) => {
        if (!ok) lost.abort(new Error('the run was taken over by another worker'));
      })
      .catch(() => undefined);
  }, Math.max(1000, Math.floor(leaseMs / 3)));
  heartbeat.unref?.();

  let result: RunResult;
  try {
    const { itemsFound, stats } = await runner({
      siteId: payload.siteId,
      source: started.source,
      runId: started.runId,
      generation: started.generation,
      scheduledFor: payload.scheduledFor,
      maxItems: started.source.maxItemsPerRun,
      signal: runSignal,
    });
    result = { outcome: 'succeeded', itemsFound: Math.min(Math.max(0, itemsFound), started.source.maxItemsPerRun), stats };
  } catch (err) {
    result = err instanceof SourceRunError ? { outcome: 'failed', category: err.category, message: err.message, stats: err.stats } : { outcome: 'failed', category: 'other', message: err instanceof Error ? err.message : String(err) };
  } finally {
    clearInterval(heartbeat);
  }
  const { paused, stale } = await runSiteTransaction(deps.db, payload.siteId, (tx) =>
    recordRunResult(tx, {
      siteId: payload.siteId,
      sourceId: payload.sourceId,
      runId: started.runId,
      generation: started.generation,
      result,
      now: now(),
      threshold: deps.threshold ?? failureThreshold(),
    }),
  );
  if (stale) return 'stale';
  return paused ? 'paused' : result.outcome;
}

/**
 * Runs left `running` whose lease lapsed more than `graceMs` ago and that no redelivery took over (the job is gone):
 * failed as `timeout` and counted towards the source's health. Every site in turn. Returns the run ids.
 */
export async function sweepAbandonedRuns(deps: IngestWorkerDeps & { graceMs?: number }): Promise<string[]> {
  const now = deps.now?.() ?? new Date();
  const cutoff = new Date(now.getTime() - (deps.graceMs ?? 30 * 60_000));
  const siteRows = await deps.db.select({ id: sites.id }).from(sites);
  const out: string[] = [];
  for (const { id: siteId } of siteRows) {
    const runs = await runSiteTransaction(deps.db, siteId, (tx) =>
      tx
        .select({ id: ingestSourceRuns.id, sourceId: ingestSourceRuns.sourceId, generation: ingestSourceRuns.generation })
        .from(ingestSourceRuns)
        .where(and(eq(ingestSourceRuns.siteId, siteId), eq(ingestSourceRuns.outcome, 'running'), lt(ingestSourceRuns.leaseUntil, cutoff)))
        .limit(200),
    );
    for (const r of runs) {
      const { stale } = await runSiteTransaction(deps.db, siteId, (tx) =>
        recordRunResult(tx, {
          siteId,
          sourceId: r.sourceId,
          runId: r.id,
          generation: r.generation,
          result: { outcome: 'failed', category: 'timeout', message: 'the worker running this source stopped responding' },
          now,
          threshold: deps.threshold ?? failureThreshold(),
        }),
      );
      if (!stale) out.push(r.id);
    }
  }
  return out;
}

/** Long-lived consumer (Docker / Node). */
export function registerIngestWorker(deps: IngestWorkerDeps): void {
  deps.queue?.process<SourceJobPayload>(INGEST_QUEUE, async (job) => {
    await processSourceJob(deps, job.data, job.signal);
  });
}
