import { and, asc, eq, lte } from 'drizzle-orm';
import type { FailureCategory } from '@heopress/contracts/schemas';
import { ingestSchedule, ingestSourceRuns, ingestSources, type Database } from '@heopress/database';
import type { QueueProvider } from '@heopress/runtime';
import { runSiteTransaction } from '../rls-transaction';
import { nextRunAfter } from './schedule';
import { failureThreshold, recordRunResult, type RunResult } from './source-service';

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
interface SourceRunContext {
  siteId: string;
  source: typeof ingestSources.$inferSelect;
  runId: string;
  maxItems: number;
  signal?: AbortSignal;
}

/** A runner's failure with its category (anything else thrown counts as `other`). */
export class SourceRunError extends Error {
  constructor(
    readonly category: FailureCategory,
    message: string,
  ) {
    super(message);
  }
}

export type SourceRunner = (ctx: SourceRunContext) => Promise<{ itemsFound: number }>;

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

export type SourceJobOutcome = 'skipped' | 'duplicate' | 'succeeded' | 'failed' | 'paused';

/** Run one source for one slot. */
export async function processSourceJob(deps: IngestWorkerDeps, payload: SourceJobPayload, signal?: AbortSignal): Promise<SourceJobOutcome> {
  const now = () => deps.now?.() ?? new Date();
  const started = await runSiteTransaction(deps.db, payload.siteId, async (tx) => {
    const [source] = await tx
      .select()
      .from(ingestSources)
      .where(and(eq(ingestSources.siteId, payload.siteId), eq(ingestSources.id, payload.sourceId)));
    if (!source || source.status !== 'active') return null;
    const [run] = await tx
      .insert(ingestSourceRuns)
      .values({ siteId: payload.siteId, sourceId: payload.sourceId, scheduledFor: new Date(payload.scheduledFor), startedAt: now() })
      .onConflictDoNothing({ target: [ingestSourceRuns.sourceId, ingestSourceRuns.scheduledFor] })
      .returning({ id: ingestSourceRuns.id });
    return run ? { source, runId: run.id } : 'duplicate';
  });
  if (started === null) return 'skipped';
  if (started === 'duplicate') return 'duplicate';

  let result: RunResult;
  try {
    const { itemsFound } = await runner({ siteId: payload.siteId, source: started.source, runId: started.runId, maxItems: started.source.maxItemsPerRun, signal });
    result = { outcome: 'succeeded', itemsFound: Math.min(Math.max(0, itemsFound), started.source.maxItemsPerRun) };
  } catch (err) {
    result = err instanceof SourceRunError ? { outcome: 'failed', category: err.category, message: err.message } : { outcome: 'failed', category: 'other', message: err instanceof Error ? err.message : String(err) };
  }
  const { paused } = await runSiteTransaction(deps.db, payload.siteId, (tx) =>
    recordRunResult(tx, { siteId: payload.siteId, sourceId: payload.sourceId, runId: started.runId, result, now: now(), threshold: deps.threshold ?? failureThreshold() }),
  );
  return paused ? 'paused' : result.outcome;
}

/** Long-lived consumer (Docker / Node). */
export function registerIngestWorker(deps: IngestWorkerDeps): void {
  deps.queue?.process<SourceJobPayload>(INGEST_QUEUE, async (job) => {
    await processSourceJob(deps, job.data, job.signal);
  });
}
