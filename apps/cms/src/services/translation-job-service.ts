import { and, count, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  translationJobs,
  type Database,
  type TranslationJobRow,
  type TranslationJobSegment,
  type TranslationJobStatus,
} from '@heopress/database';
import type { QueueProvider } from '@heopress/runtime';
import { AuditLogger } from '../modules/audit/logger';
import { runSiteTransaction, type SiteTransaction } from './rls-transaction';

/**
 * Durable translation jobs: creation, reads, operator retry/cancel, and the queue enqueue path (HeoPress v1.4, spec
 * `ai/translation-jobs`; design decisions 2, 3 and 7).
 *
 * The worker (`translation-job-worker.ts`) owns the lease, execution and retry policy; this module owns everything an
 * operator and the API see. Mutations run in the site's transaction and write their audit row in it, so a job and the
 * record of who asked for it can never disagree. Reads always carry the site condition; the table's row-level policy
 * enforces the same boundary underneath.
 */

/** The queue every task run is enqueued to (registered in `packages/runtime/src/queue-registry.ts`). */
export const TRANSLATION_JOBS_QUEUE = 'translation-jobs';
/** The one message a translation job consumer handles. */
export const TRANSLATION_JOB_RUN_JOB = 'translation:job.run';

/** The job payload: never the segments, so a queue row cannot outlive a deleted job's content. */
export interface TranslationJobMessage {
  siteId: string;
  jobId: string;
}

/** Default business retry budget of a new job. */
const TRANSLATION_JOB_MAX_ATTEMPTS = 3;
/** Default hard bound on crash recoveries (a job that dies on every run must end). */
const TRANSLATION_JOB_MAX_EXECUTIONS = 5;

export class TranslationJobNotFoundError extends Error {
  constructor(id: string) {
    super(`Translation job ${id} not found.`);
    this.name = 'TranslationJobNotFoundError';
  }
}

/** The job is not in a state the operation allows (`TRANSLATION_JOB_NOT_RETRYABLE`, `TRANSLATION_JOB_TERMINAL`). */
export class TranslationJobStateError extends Error {
  constructor(
    readonly code: 'TRANSLATION_JOB_NOT_RETRYABLE' | 'TRANSLATION_JOB_TERMINAL',
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'TranslationJobStateError';
  }
}

/** Who is changing the job; the audit row keeps exactly this and no translation text. */
export interface TranslationJobActor {
  email: string | null;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
  /** The authenticated user's id; null for a system actor. */
  userId: string | null;
}

export interface CreateTranslationJobInput {
  sourceLocale: string;
  targetLocale: string;
  segments: TranslationJobSegment[];
}

export interface ListTranslationJobsFilter {
  status?: TranslationJobStatus;
  /** The **target** locale (`target_locale`), the language the operator asked the translation for. */
  locale?: string;
  limit: number;
  offset: number;
}

/** One segment as the API shows it: the request, and what it became. */
interface TranslationJobSegmentView extends TranslationJobSegment {
  output: string | null;
  state: string | null;
  findings: string[];
  reason: string | null;
}

export interface TranslationJobResource {
  id: string;
  siteId: string;
  status: TranslationJobStatus;
  sourceLocale: string;
  targetLocale: string;
  attempts: number;
  maxAttempts: number;
  executions: number;
  maxExecutions: number;
  callEpoch: number;
  nextAttemptAt: string | null;
  lastErrorCode: string | null;
  serviceId: string | null;
  draftProvider: string | null;
  draftModel: string | null;
  reviewProvider: string | null;
  reviewModel: string | null;
  counters: {
    translated: number;
    revised: number;
    unverified: number;
    rejected: number;
  };
  segments: TranslationJobSegmentView[];
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  cancelRequestedAt: string | null;
}

/**
 * The ledger call key of the job's current business attempt (design decision 3). Stable across crash recoveries and
 * deferrals of the same attempt, advanced by a business retry (`attempts`) and by an explicit operator retry
 * (`callEpoch`). The dual-model service appends `:draft` / `:review`, so each phase replays its own recorded answer.
 */
export function translationJobCallKey(job: Pick<TranslationJobRow, 'id' | 'attempts' | 'callEpoch'>): string {
  return `translation-job:${job.id}:a${job.attempts}:e${job.callEpoch}`;
}

const iso = (value: Date | null): string | null => value?.toISOString() ?? null;

/** The stored row as the API returns it, with every requested segment paired with its outcome. */
export function translationJobResource(row: TranslationJobRow): TranslationJobResource {
  const results = new Map(row.results.map((result) => [result.id, result]));
  return {
    id: row.id,
    siteId: row.siteId,
    status: row.status as TranslationJobStatus,
    sourceLocale: row.sourceLocale,
    targetLocale: row.targetLocale,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    executions: row.executions,
    maxExecutions: row.maxExecutions,
    callEpoch: row.callEpoch,
    nextAttemptAt: iso(row.nextAttemptAt),
    lastErrorCode: row.lastErrorCode,
    serviceId: row.serviceId,
    draftProvider: row.draftProvider,
    draftModel: row.draftModel,
    reviewProvider: row.reviewProvider,
    reviewModel: row.reviewModel,
    counters: {
      translated: row.segmentsTranslated,
      revised: row.segmentsRevised,
      unverified: row.segmentsUnverified,
      rejected: row.segmentsRejected,
    },
    segments: row.segments.map((segment) => {
      const result = results.get(segment.id);
      return {
        id: segment.id,
        text: segment.text,
        output: result?.text ?? null,
        state: result?.state ?? null,
        findings: result?.findings ?? [],
        reason: result?.reason ?? null,
      };
    }),
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    startedAt: iso(row.startedAt),
    finishedAt: iso(row.finishedAt),
    cancelRequestedAt: iso(row.cancelRequestedAt),
  };
}

/** The audit metadata of a job: never the segments or their translations. */
function translationJobAuditFields(row: TranslationJobRow): Record<string, unknown> {
  return {
    id: row.id,
    status: row.status,
    sourceLocale: row.sourceLocale,
    targetLocale: row.targetLocale,
    segments: row.segments.length,
    attempts: row.attempts,
    ...(row.lastErrorCode ? { errorCode: row.lastErrorCode } : {}),
  };
}

/** Enqueue one run message; `delayMs` is honoured by the queue (0 = run now). */
export async function enqueueTranslationJobRun(
  queue: Pick<QueueProvider, 'enqueue'> | undefined,
  siteId: string,
  jobId: string,
  delayMs = 0,
): Promise<void> {
  if (!queue) return;
  await queue.enqueue<TranslationJobMessage>(TRANSLATION_JOBS_QUEUE, TRANSLATION_JOB_RUN_JOB, { siteId, jobId }, {
    delay: Math.max(0, Math.trunc(delayMs)),
  });
}

export interface TranslationJobServiceDeps {
  db: Database;
  siteId: string;
  queue?: QueueProvider;
  now?: () => Date;
}

export class TranslationJobService {
  constructor(private readonly deps: TranslationJobServiceDeps) {}

  private get siteId(): string {
    return this.deps.siteId;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private tx<T>(fn: (tx: SiteTransaction) => Promise<T>) {
    return runSiteTransaction(this.deps.db, this.siteId, fn);
  }

  private audit(
    tx: SiteTransaction,
    actor: TranslationJobActor,
    event: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    return new AuditLogger({ db: tx as unknown as Database, siteId: this.siteId }).writeInTransaction(tx, {
      siteId: this.siteId,
      event,
      actorEmail: actor.email,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
      metadata,
    });
  }

  /**
   * Create a `queued` job and enqueue its first run after the transaction commits. An enqueue failure is logged and
   * swallowed: the row is the durable record, and the sweep picks it up within a minute (design decision 7).
   */
  async create(input: CreateTranslationJobInput, actor: TranslationJobActor): Promise<TranslationJobRow> {
    const created = await this.tx(async (tx) => {
      const [row] = await tx
        .insert(translationJobs)
        .values({
          siteId: this.siteId,
          sourceLocale: input.sourceLocale,
          targetLocale: input.targetLocale,
          segments: input.segments,
          status: 'queued',
          attempts: 0,
          maxAttempts: TRANSLATION_JOB_MAX_ATTEMPTS,
          executions: 0,
          maxExecutions: TRANSLATION_JOB_MAX_EXECUTIONS,
          nextAttemptAt: this.now(),
          createdBy: actor.userId,
        })
        .returning();
      await this.audit(tx, actor, 'translation_job.created', translationJobAuditFields(row!));
      return row!;
    });
    await this.enqueueRun(created.id, 0);
    return created;
  }

  async list(filter: ListTranslationJobsFilter): Promise<{ rows: TranslationJobRow[]; total: number }> {
    const where = and(
      eq(translationJobs.siteId, this.siteId),
      filter.status ? eq(translationJobs.status, filter.status) : undefined,
      filter.locale ? eq(translationJobs.targetLocale, filter.locale) : undefined,
    );
    const [rows, totalRow] = await Promise.all([
      this.deps.db
        .select()
        .from(translationJobs)
        .where(where)
        .orderBy(desc(translationJobs.createdAt), desc(translationJobs.id))
        .limit(filter.limit)
        .offset(filter.offset),
      this.deps.db.select({ value: count() }).from(translationJobs).where(where),
    ]);
    return { rows, total: totalRow[0]?.value ?? 0 };
  }

  async get(id: string): Promise<TranslationJobRow | null> {
    const [row] = await this.deps.db
      .select()
      .from(translationJobs)
      .where(and(eq(translationJobs.siteId, this.siteId), eq(translationJobs.id, id)))
      .limit(1);
    return row ?? null;
  }

  /**
   * An operator's explicit retry of a `failed` or `cancelled` job: a fresh call-key epoch (so the retry really
   * translates instead of replaying the answered calls), a fresh business budget and a fresh execution bound.
   */
  async retry(id: string, actor: TranslationJobActor): Promise<TranslationJobRow> {
    const retried = await this.tx(async (tx) => {
      const [row] = await tx
        .update(translationJobs)
        .set({
          status: 'queued',
          attempts: 0,
          executions: 0,
          callEpoch: sql`${translationJobs.callEpoch} + 1` as unknown as number,
          nextAttemptAt: this.now(),
          lastErrorCode: null,
          results: [],
          segmentsTranslated: 0,
          segmentsRevised: 0,
          segmentsUnverified: 0,
          segmentsRejected: 0,
          serviceId: null,
          draftProvider: null,
          draftModel: null,
          reviewProvider: null,
          reviewModel: null,
          leaseUntil: null,
          leaseOwner: null,
          cancelRequestedAt: null,
          startedAt: null,
          finishedAt: null,
          updatedAt: this.now(),
        })
        .where(
          and(
            eq(translationJobs.siteId, this.siteId),
            eq(translationJobs.id, id),
            inArray(translationJobs.status, ['failed', 'cancelled']),
          ),
        )
        .returning();
      if (!row) return null;
      await this.audit(tx, actor, 'translation_job.retried', translationJobAuditFields(row));
      return row;
    });
    if (!retried) await this.refuseRetry(id);
    await this.enqueueRun(retried!.id, 0);
    return retried!;
  }

  private async refuseRetry(id: string): Promise<never> {
    const current = await this.get(id);
    if (!current) throw new TranslationJobNotFoundError(id);
    throw new TranslationJobStateError(
      'TRANSLATION_JOB_NOT_RETRYABLE',
      `Only a failed or cancelled translation job can be retried (this one is ${current.status}).`,
    );
  }

  /**
   * Cancel a `queued` or `running` job. The running execution notices at its next lease renewal and stops calling;
   * its settlement is conditioned on still holding the lease and the row still being `running`, so it cannot overwrite
   * the cancellation. Cancelling an already cancelled job is idempotent.
   */
  async cancel(id: string, actor: TranslationJobActor): Promise<TranslationJobRow> {
    const cancelled = await this.tx(async (tx) => {
      const [row] = await tx
        .update(translationJobs)
        .set({
          status: 'cancelled',
          cancelRequestedAt: this.now(),
          lastErrorCode: 'CANCELLED',
          nextAttemptAt: null,
          leaseUntil: null,
          leaseOwner: null,
          finishedAt: this.now(),
          updatedAt: this.now(),
        })
        .where(
          and(
            eq(translationJobs.siteId, this.siteId),
            eq(translationJobs.id, id),
            inArray(translationJobs.status, ['queued', 'running']),
          ),
        )
        .returning();
      if (!row) return null;
      await this.audit(tx, actor, 'translation_job.cancelled', translationJobAuditFields(row));
      return row;
    });
    if (cancelled) return cancelled;

    const current = await this.get(id);
    if (!current) throw new TranslationJobNotFoundError(id);
    if (current.status === 'cancelled') return current;
    throw new TranslationJobStateError(
      'TRANSLATION_JOB_TERMINAL',
      `A ${current.status} translation job cannot be cancelled.`,
    );
  }

  private async enqueueRun(jobId: string, delayMs: number): Promise<void> {
    try {
      await enqueueTranslationJobRun(this.deps.queue, this.siteId, jobId, delayMs);
    } catch (err) {
      // The row is the durable record; the sweep re-enqueues due jobs. Never fail a committed mutation for this.
      console.warn('[translation-jobs] enqueue failed; the sweep will retry', {
        siteId: this.siteId,
        jobId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
