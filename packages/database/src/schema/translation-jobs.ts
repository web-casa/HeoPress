import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { nanoid } from 'nanoid';
import { sites } from './core';

/**
 * Durable translation jobs (HeoPress v1.4, spec `ai/translation-jobs`).
 *
 * A job is the persistent form of one translation request: the site's language pair, the segments it asked to
 * translate, its status, what the translation service produced per segment, and the retry state that keeps a
 * rate-limited model, a budget deferral or a worker restart from losing the work. The synchronous
 * `POST /api/v1/tm/translate` is unchanged; a job is what an operator uses when the answer must outlive the request.
 *
 * `attempts` counts **business retries only**: a deferral (`LlmDeferredError`) reschedules the job without touching it
 * (spec `ai/cost-control`). `executions` counts leases taken, so a job that is killed on every run ends at
 * `max_executions` instead of being recovered forever. `attempts` also selects the ledger call key, which is why it is
 * a column rather than a log line: the same business attempt must replay the calls it already paid for.
 *
 * `results` holds one entry per requested segment on success (`state` is `verified`, `revised`,
 * `rejected_verification`, `unverified`, or `translated` for the single-model and plugin paths, which have no review
 * phase). A job whose reviewer failed still succeeds: the drafted text is kept and marked `unverified`, exactly as
 * the translation service reports it.
 */

export type TranslationJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

/** One requested segment, in request order. */
export interface TranslationJobSegment {
  id: string;
  text: string;
}

/** One segment's final state (the first four are the dual-model service's; `translated` is the other engines'). */
export type TranslationJobSegmentState = 'verified' | 'revised' | 'rejected_verification' | 'unverified' | 'translated';

/** What one segment ended as; written only when the job succeeds. */
export interface TranslationJobSegmentResult {
  id: string;
  text: string;
  state: TranslationJobSegmentState;
  findings: string[];
  reason?: string;
}

const id = () => text('id').$defaultFn(() => nanoid()).primaryKey();

export const translationJobs = pgTable(
  'lumibase_translation_jobs',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    sourceLocale: text('source_locale').notNull(),
    targetLocale: text('target_locale').notNull(),
    /** The request: `[{ id, text }]`, in request order. */
    segments: jsonb('segments').$type<TranslationJobSegment[]>().notNull(),
    /** Per-segment outcome; empty until the job succeeds. */
    results: jsonb('results').$type<TranslationJobSegmentResult[]>().default([]).notNull(),
    status: text('status').default('queued').notNull(),
    /** Business retries spent (a deferral never counts). */
    attempts: integer('attempts').default(0).notNull(),
    maxAttempts: integer('max_attempts').default(3).notNull(),
    /**
     * Crash recoveries: leases taken over after they expired. It bounds a job that dies on every run without charging
     * the business retry budget, and it does not count an ordinary pickup (a first run, a retry or a deferral).
     */
    executions: integer('executions').default(0).notNull(),
    maxExecutions: integer('max_executions').default(5).notNull(),
    /**
     * Operator retry generation. A business attempt's ledger call key is `translation-job:<id>:a<attempts>:e<epoch>`
     * (design decision 3): a crash recovery and a deferral keep both parts, a transient retry advances `attempts`, and
     * an explicit operator retry advances this epoch so the retry really translates again instead of replaying the
     * answered calls. It is not retry state; it is call identity.
     */
    callEpoch: integer('call_epoch').default(0).notNull(),
    /** Null means "due now"; a terminal job has no next attempt. */
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    /** The last failure/deferral/cancellation code; the reason is this column, not a log line. */
    lastErrorCode: text('last_error_code'),
    /** The engine that answered (`llm`, `heopress:dual-model`, `plugin:<plugin>`). */
    serviceId: text('service_id'),
    draftProvider: text('draft_provider'),
    draftModel: text('draft_model'),
    reviewProvider: text('review_provider'),
    reviewModel: text('review_model'),
    segmentsTranslated: integer('segments_translated').default(0).notNull(),
    segmentsRevised: integer('segments_revised').default(0).notNull(),
    segmentsUnverified: integer('segments_unverified').default(0).notNull(),
    segmentsRejected: integer('segments_rejected').default(0).notNull(),
    /** Execution lease: the owner token may settle the job while it holds the lease. */
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    leaseOwner: text('lease_owner'),
    /** Set by an operator cancellation; the running execution aborts at its next lease renewal. */
    cancelRequestedAt: timestamp('cancel_requested_at', { withTimezone: true }),
    createdBy: text('created_by'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    /** The due scan: one site's queued jobs by their next attempt. */
    dueIdx: index('translation_jobs_due_idx').on(t.siteId, t.status, t.nextAttemptAt),
    /** The lease sweep and the list's newest-first order. */
    createdIdx: index('translation_jobs_created_idx').on(t.siteId, t.createdAt),
    statusCheck: check(
      'translation_jobs_status_check',
      sql`${t.status} IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')`,
    ),
  }),
);

/** A stored translation job. */
export type TranslationJobRow = typeof translationJobs.$inferSelect;
/** A job to insert. */
export type NewTranslationJob = typeof translationJobs.$inferInsert;
