import { and, asc, eq, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { allSiteIds, inScope, translationJobs, type Database, type TranslationJobRow, type TranslationJobSegmentResult } from '@heopress/database';
import type { KeyProvider, QueueProvider } from '@heopress/runtime';
import { formatSafeError } from '@heopress/contracts/utils';
import { nanoid } from 'nanoid';
import type { TranslationGlossaryTerm } from '@heopress/contracts/schemas';
import type { TranslationGateway } from './llm/translation-router';
import { TranslationServiceRouter } from './llm/translation-router';
import type { TranslationResult, TranslationService } from './llm/translation-service';
import { loadGlossary } from './pipeline/block-translation';
import { decideTranslationJobFailure } from './translation-job-policy';
import {
  TRANSLATION_JOBS_QUEUE,
  TRANSLATION_JOB_RUN_JOB,
  enqueueTranslationJobRun,
  translationJobCallKey,
  type TranslationJobMessage,
} from './translation-job-service';

/**
 * The durable translation job worker (HeoPress v1.4, spec `ai/translation-jobs`; design decisions 3–6).
 *
 * One message is one attempted run. The consumer:
 *
 *   1. claims the row with an atomic conditional UPDATE (only `queued`-and-due or `running`-with-an-expired-lease rows
 *      can be claimed) and takes a lease with an owner token;
 *   2. renews the lease while it runs and aborts the translation when the lease is gone or the job was cancelled;
 *   3. runs the site's translation service with a **stable** ledger call key for the current business attempt, so a
 *      recovery replays the answers the site already paid for;
 *   4. writes the per-segment outcome and settles the job — only while it still holds the lease and the row is still
 *      `running`, so a cancelled job cannot be resurrected;
 *   5. on failure applies `translation-job-policy.ts`: a deferral reschedules without spending a business retry, a
 *      transient failure spends one with exponential backoff, a permanent failure ends the job at once.
 *
 * Delivery is at least once, so two messages for the same job are harmless: the second claim finds the row `running`
 * under a live lease and does nothing. The worker never throws out of the handler, because a pg-boss retry would
 * compete with the job's own retry ledger; the periodic sweep is the recovery path for a lost message or a dead worker.
 */

/** A lease covers both dual-model calls (2 × the gateway's 120 s deadline) plus their grace. */
const TRANSLATION_JOB_LEASE_MS = 5 * 60_000;
/** Renew (and check for a cancellation) this often while a job runs. */
const TRANSLATION_JOB_HEARTBEAT_MS = 30_000;
/** Jobs one site's sweep pass re-enqueues at most. */
const TRANSLATION_JOB_SWEEP_LIMIT = 50;
/** The error code of a job that was claimed too many times without ever finishing. */
const TRANSLATION_JOB_EXECUTION_LIMIT = 'EXECUTION_LIMIT';

export interface TranslationJobWorkerDeps {
  /** The process's root handle (the worker runs across sites); every statement is taken in the job's site scope. */
  db: Database;
  queue?: QueueProvider;
  gateway: TranslationGateway;
  /** Opens the selected plugin service's secrets, when the site uses one. */
  keys?: KeyProvider;
  env?: Record<string, unknown>;
  now?: () => Date;
  /** Tests: the translator of a site (default: the site's selected service through the translation router). */
  translatorFor?: (siteId: string) => TranslationService;
  /** Tests and operations: shorter lease/heartbeat for a fast suite (defaults: 5 min / 30 s). */
  leaseMs?: number;
  heartbeatMs?: number;
  hooks?: {
    /**
     * Test seam: runs after the translation returned and before the job settles. A throw here is the same as the
     * process dying at that point — nothing is settled, the lease runs out, and the sweep resumes the job.
     */
    beforeSettle?: (input: { job: TranslationJobRow; result: TranslationResult }) => Promise<void> | void;
  };
}

export interface TranslationJobRunOptions {
  /** The queue's own shutdown signal: stop at a safe point and leave the job to the lease expiry. */
  signal?: AbortSignal;
}

interface Heartbeat {
  stop: () => Promise<void>;
}

/** Claim `jobId` for the next run, or null when it is not due / already leased / out of executions. */
async function claimJob(
  db: Database,
  siteId: string,
  jobId: string,
  at: Date,
  leaseMs: number,
): Promise<{ row: TranslationJobRow; token: string } | null> {
  const token = nanoid();
  const [row] = await db
    .update(translationJobs)
    .set({
      status: 'running',
      leaseOwner: token,
      leaseUntil: sql`now() + make_interval(secs => ${leaseMs / 1000})` as unknown as Date,
      startedAt: sql`COALESCE(${translationJobs.startedAt}, now())` as unknown as Date,
      // A crash recovery counts towards the hard bound; an ordinary pickup (first run, retry, deferral) does not.
      executions: sql`${translationJobs.executions} + CASE WHEN ${translationJobs.status} = 'running' THEN 1 ELSE 0 END` as unknown as number,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(translationJobs.siteId, siteId),
        eq(translationJobs.id, jobId),
        or(
          and(
            eq(translationJobs.status, 'queued'),
            or(isNull(translationJobs.nextAttemptAt), lte(translationJobs.nextAttemptAt, at)),
          ),
          and(
            eq(translationJobs.status, 'running'),
            lt(translationJobs.executions, translationJobs.maxExecutions),
            or(isNull(translationJobs.leaseUntil), lt(translationJobs.leaseUntil, at)),
          ),
        ),
      ),
    )
    .returning();
  return row ? { row, token } : null;
}

/** Keep the lease alive, and abort the translation when the job was cancelled or the lease was taken away. */
function startHeartbeat(
  db: Database,
  siteId: string,
  jobId: string,
  token: string,
  leaseMs: number,
  heartbeatMs: number,
  controller: AbortController,
): Heartbeat {
  let stopped = false;
  let inFlight: Promise<void> = Promise.resolve();
  const timer = setInterval(() => {
    inFlight = inFlight
      .then(async () => {
        if (stopped) return;
        const rows = await db
          .update(translationJobs)
          .set({
            leaseUntil: sql`now() + make_interval(secs => ${leaseMs / 1000})` as unknown as Date,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(translationJobs.siteId, siteId),
              eq(translationJobs.id, jobId),
              eq(translationJobs.status, 'running'),
              eq(translationJobs.leaseOwner, token),
            ),
          )
          .returning({ cancelRequestedAt: translationJobs.cancelRequestedAt });
        // No row: the job was cancelled (the route settled it) or another execution took the lease. Either way this
        // execution must stop calling.
        if (rows.length === 0 || rows[0]!.cancelRequestedAt !== null) controller.abort();
      })
      .catch(() => undefined);
  }, heartbeatMs);
  timer.unref?.();
  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}

/** The per-segment outcome of a successful translation, and the counters that summarise it. */
function segmentResultsOf(job: TranslationJobRow, result: TranslationResult): {
  results: TranslationJobSegmentResult[];
  counters: { translated: number; revised: number; unverified: number; rejected: number };
} {
  const textById = new Map(result.segments.map((segment) => [segment.id, segment.text]));
  const provenanceById = new Map((result.verification?.segments ?? []).map((segment) => [segment.id, segment]));
  const results = job.segments.map((segment) => {
    const provenance = provenanceById.get(segment.id);
    const output = textById.get(segment.id);
    return {
      id: segment.id,
      text: output ?? segment.text,
      // The single-model and plugin paths have no review phase: their text is translated, not verified.
      state: provenance?.state ?? (result.verification ? 'unverified' : 'translated'),
      findings: provenance?.findings ?? [],
      ...(provenance?.reason ? { reason: provenance.reason } : {}),
    } satisfies TranslationJobSegmentResult;
  });
  const countOf = (state: TranslationJobSegmentResult['state']) => results.filter((entry) => entry.state === state).length;
  return {
    results,
    counters: {
      translated: results.length,
      revised: countOf('revised'),
      unverified: countOf('unverified'),
      rejected: countOf('rejected_verification'),
    },
  };
}

/** The site's glossary as the translation service takes it (the stored row's shape differs by design). */
async function glossaryFor(db: Database, siteId: string, from: string, to: string): Promise<TranslationGlossaryTerm[]> {
  const terms = await loadGlossary(db, siteId, from, to);
  return terms.map((term) => ({ source: term.term, target: term.translation, rule: term.rule }));
}

async function settleSucceeded(
  db: Database,
  siteId: string,
  jobId: string,
  token: string,
  result: TranslationResult,
  outcome: ReturnType<typeof segmentResultsOf>,
  at: Date,
): Promise<TranslationJobRow | null> {
  const [row] = await db
    .update(translationJobs)
    .set({
      status: 'succeeded',
      results: outcome.results,
      segmentsTranslated: outcome.counters.translated,
      segmentsRevised: outcome.counters.revised,
      segmentsUnverified: outcome.counters.unverified,
      segmentsRejected: outcome.counters.rejected,
      serviceId: result.engine,
      draftProvider: result.provider,
      draftModel: result.model,
      reviewProvider: result.verification?.review.provider ?? null,
      reviewModel: result.verification?.review.model ?? null,
      lastErrorCode: null,
      nextAttemptAt: null,
      leaseUntil: null,
      leaseOwner: null,
      finishedAt: at,
      updatedAt: at,
    })
    .where(
      and(
        eq(translationJobs.siteId, siteId),
        eq(translationJobs.id, jobId),
        eq(translationJobs.status, 'running'),
        eq(translationJobs.leaseOwner, token),
      ),
    )
    .returning();
  return row ?? null;
}

async function settleFailed(
  db: Database,
  siteId: string,
  jobId: string,
  token: string,
  row: TranslationJobRow,
  err: unknown,
  at: Date,
): Promise<TranslationJobRow | null> {
  const decision = decideTranslationJobFailure(
    { attempts: row.attempts, maxAttempts: row.maxAttempts },
    err,
    at,
  );
  const [settled] = await db
    .update(translationJobs)
    .set({
      status: decision.action === 'fail' ? 'failed' : 'queued',
      attempts: decision.attempts,
      nextAttemptAt: decision.action === 'fail' ? null : decision.nextAttemptAt,
      lastErrorCode: decision.code,
      leaseUntil: null,
      leaseOwner: null,
      finishedAt: decision.action === 'fail' ? at : null,
      updatedAt: at,
    })
    .where(
      and(
        eq(translationJobs.siteId, siteId),
        eq(translationJobs.id, jobId),
        eq(translationJobs.status, 'running'),
        eq(translationJobs.leaseOwner, token),
      ),
    )
    .returning();
  return settled ?? null;
}

/**
 * Run one job. Returns the settled row, or null when the message found nothing to do (not due, already leased,
 * cancelled, or the lease was lost). A test hook may throw after the translation: the row then stays `running` and the
 * lease expiry resumes it — no settlement, no lost work, no second charge.
 */
export async function runTranslationJob(
  deps: TranslationJobWorkerDeps,
  message: TranslationJobMessage,
  opts: TranslationJobRunOptions = {},
): Promise<TranslationJobRow | null> {
  // A shutdown already asked this run to stop: take no lease, leave the job to the next delivery or the sweep.
  if (opts.signal?.aborted) return null;
  const { siteId, jobId } = message;
  const at = deps.now?.() ?? new Date();
  const leaseMs = deps.leaseMs ?? TRANSLATION_JOB_LEASE_MS;
  const db = inScope(deps.db, { site: siteId });

  const claim = await claimJob(db, siteId, jobId, at, leaseMs);
  if (!claim) return null;
  const { row, token } = claim;

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  if (opts.signal?.aborted) controller.abort();

  const heartbeat = startHeartbeat(
    db,
    siteId,
    jobId,
    token,
    leaseMs,
    deps.heartbeatMs ?? TRANSLATION_JOB_HEARTBEAT_MS,
    controller,
  );

  let result: TranslationResult | null = null;
  let failure: unknown = null;
  try {
    const translator =
      deps.translatorFor?.(siteId) ??
      new TranslationServiceRouter({ db, gateway: deps.gateway, keys: deps.keys, env: deps.env });
    const glossary = await glossaryFor(db, siteId, row.sourceLocale, row.targetLocale);
    result = await translator.translate({
      siteId,
      sourceLocale: row.sourceLocale,
      targetLocale: row.targetLocale,
      segments: row.segments,
      glossary,
      callKey: translationJobCallKey(row),
      origin: { kind: 'translation_job', id: jobId },
      signal: controller.signal,
    });
  } catch (err) {
    failure = err;
  } finally {
    await heartbeat.stop();
    opts.signal?.removeEventListener('abort', onAbort);
  }

  if (failure !== null || result === null) {
    // Cancelled or lease lost: the row already says what happened (the route settled the cancellation; a lost lease
    // belongs to whoever took it). Never write over it.
    if (controller.signal.aborted) return null;
    const settled = await settleFailed(db, siteId, jobId, token, row, failure, at);
    if (settled?.status === 'queued' && settled.nextAttemptAt) {
      await enqueueTranslationJobRun(deps.queue, siteId, jobId, settled.nextAttemptAt.getTime() - at.getTime()).catch(
        (err: unknown) => console.warn('[translation-jobs] re-enqueue failed; the sweep will retry', { siteId, jobId, err: formatSafeError(err) }),
      );
    }
    return settled;
  }

  // A throw here is a simulated process death: no settlement, the lease expires, the sweep resumes the job.
  await deps.hooks?.beforeSettle?.({ job: row, result });
  return settleSucceeded(db, siteId, jobId, token, result, segmentResultsOf(row, result), at);
}

export interface TranslationJobSweepResult {
  /** Jobs re-enqueued because they are due or their lease expired. */
  enqueued: number;
  /** Jobs ended because they had been claimed `maxExecutions` times. */
  failed: number;
}

/**
 * The recovery path, once a minute: each site's due jobs are re-enqueued (a lost message, a subscription nobody
 * restarted, a lease left behind by a dead worker) and a job that exhausted its lease acquisitions ends with
 * `EXECUTION_LIMIT` instead of being recovered forever. Runs per site, in that site's scope — the table itself is
 * never read across sites.
 */
export async function sweepDueTranslationJobs(
  deps: TranslationJobWorkerDeps,
  at: Date = deps.now?.() ?? new Date(),
): Promise<TranslationJobSweepResult> {
  let enqueued = 0;
  let failed = 0;
  for (const siteId of await allSiteIds(deps.db)) {
    const db = inScope(deps.db, { site: siteId });
    const due = await db
      .select({
        id: translationJobs.id,
        status: translationJobs.status,
        executions: translationJobs.executions,
        maxExecutions: translationJobs.maxExecutions,
      })
      .from(translationJobs)
      .where(
        and(
          eq(translationJobs.siteId, siteId),
          or(
            and(
              eq(translationJobs.status, 'queued'),
              or(isNull(translationJobs.nextAttemptAt), lte(translationJobs.nextAttemptAt, at)),
            ),
            and(
              eq(translationJobs.status, 'running'),
              or(isNull(translationJobs.leaseUntil), lt(translationJobs.leaseUntil, at)),
            ),
          ),
        ),
      )
      .orderBy(asc(translationJobs.createdAt), asc(translationJobs.id))
      .limit(TRANSLATION_JOB_SWEEP_LIMIT);

    for (const job of due) {
      // Only a job whose lease keeps expiring is out of recoveries; a queued job (a retry, a deferral) is not.
      if (job.status === 'running' && job.executions >= job.maxExecutions) {
        const ended = await db
          .update(translationJobs)
          .set({
            status: 'failed',
            lastErrorCode: TRANSLATION_JOB_EXECUTION_LIMIT,
            nextAttemptAt: null,
            leaseUntil: null,
            leaseOwner: null,
            finishedAt: at,
            updatedAt: at,
          })
          .where(
            and(
              eq(translationJobs.siteId, siteId),
              eq(translationJobs.id, job.id),
              or(eq(translationJobs.status, 'queued'), eq(translationJobs.status, 'running')),
            ),
          )
          .returning({ id: translationJobs.id });
        if (ended.length > 0) failed += 1;
        continue;
      }
      try {
        await enqueueTranslationJobRun(deps.queue, siteId, job.id, 0);
        enqueued += 1;
      } catch (err) {
        console.warn('[translation-jobs] sweep enqueue failed', { siteId, jobId: job.id, err: formatSafeError(err) });
      }
    }
  }
  return { enqueued, failed };
}

/**
 * The worker role's registration: one consumer for the registered queue. The handler never throws — a pg-boss retry
 * would compete with the job's own retry ledger — so a thrown handler-level failure is logged and the row's lease is
 * left to the sweep.
 */
export function registerTranslationJobWorker(deps: TranslationJobWorkerDeps): void {
  deps.queue?.process<TranslationJobMessage>(TRANSLATION_JOBS_QUEUE, async (job) => {
    if (job.name !== TRANSLATION_JOB_RUN_JOB) return;
    const data = job.data;
    if (!data || typeof data.siteId !== 'string' || typeof data.jobId !== 'string') return;
    try {
      await runTranslationJob(deps, { siteId: data.siteId, jobId: data.jobId }, { signal: job.signal });
    } catch (err) {
      console.error('[translation-jobs] run failed', { siteId: data.siteId, jobId: data.jobId, err: formatSafeError(err) });
    }
  });
}
