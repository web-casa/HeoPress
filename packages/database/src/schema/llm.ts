import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { nanoid } from 'nanoid';
import { sites } from './core';

/**
 * Model providers, routing and the per-attempt ledger (HeoPress P04 tasks
 * 7.1–7.6, spec platform/llm-providers; design "模型提供方实施方案").
 *
 * Everything is per site (`site_id NOT NULL`, RLS). A site configures its
 * own OpenAI-compatible providers and, per task type, the ordered list of
 * them (the failover order); without a list the instance default from the
 * environment is used. Every network attempt of every AI capability has a
 * ledger row (`lumibase_llm_attempts`) belonging to a logical call
 * (`lumibase_llm_calls`), whose candidate chain is frozen when it is made.
 *
 * Money is integer micro-units (a millionth of the site's currency).
 */

/** A provider a site configured. Secrets are sealed with the instance KEK, AAD bound to the id. */
export const llmProviders = pgTable(
  'lumibase_llm_providers',
  {
    id: text('id').$defaultFn(() => nanoid()).primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** P04: `openai_compatible` only. */
    kind: text('kind').notNull(),
    baseUrl: text('base_url').notNull(),
    model: text('model').notNull(),
    secretCiphertext: text('secret_ciphertext'),
    /** Declared by the administrator: `{ tools: boolean, json: boolean, maxContext: number | null }`. */
    capabilities: jsonb('capabilities').notNull(),
    /** Last probe: per capability `{ ok, at, error? }`; null until probed. */
    probe: jsonb('probe'),
    /** `per_1m_tokens` (input/output prices) or `per_request` (request price). */
    pricingKind: text('pricing_kind').notNull(),
    inputPriceMicros: bigint('input_price_micros', { mode: 'number' }),
    outputPriceMicros: bigint('output_price_micros', { mode: 'number' }),
    requestPriceMicros: bigint('request_price_micros', { mode: 'number' }),
    currency: text('currency').notNull(),
    timeoutMs: integer('timeout_ms').default(60_000).notNull(),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    /** Soft delete: the ledger keeps referring to it. */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    siteNameUnique: uniqueIndex('llm_providers_site_name_unique').on(t.siteId, t.name).where(sql`${t.deletedAt} IS NULL`),
    siteIdUnique: unique('llm_providers_site_id_unique').on(t.siteId, t.id),
    kindCheck: check('llm_providers_kind_check', sql`${t.kind} = 'openai_compatible'`),
    pricingCheck: check(
      'llm_providers_pricing_check',
      // Explicit non-nulls: a NULL price makes the comparison NULL, which a CHECK would accept.
      sql`(${t.pricingKind} = 'per_1m_tokens' AND ${t.inputPriceMicros} IS NOT NULL AND ${t.outputPriceMicros} IS NOT NULL
            AND ${t.inputPriceMicros} >= 0 AND ${t.outputPriceMicros} >= 0)
       OR (${t.pricingKind} = 'per_request' AND ${t.requestPriceMicros} IS NOT NULL AND ${t.requestPriceMicros} >= 0)`,
    ),
    timeoutCheck: check('llm_providers_timeout_check', sql`${t.timeoutMs} > 0`),
  }),
);

/** Per task type, the ordered providers to try (position 0 first). */
export const llmRoutes = pgTable(
  'lumibase_llm_routes',
  {
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    taskType: text('task_type').notNull(),
    position: integer('position').notNull(),
    providerId: text('provider_id').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.siteId, t.taskType, t.position] }),
    providerFk: foreignKey({
      columns: [t.siteId, t.providerId],
      foreignColumns: [llmProviders.siteId, llmProviders.id],
      name: 'llm_routes_provider_fk',
    }),
    positionCheck: check('llm_routes_position_check', sql`${t.position} >= 0`),
  }),
);

/** The site's currency (locked once it has ledger entries) and monthly budget. */
export const llmSiteSettings = pgTable('lumibase_llm_site_settings', {
  siteId: text('site_id')
    .primaryKey()
    .references(() => sites.id, { onDelete: 'cascade' }),
  currency: text('currency').notNull(),
  /** Null: no budget. */
  monthlyBudgetMicros: bigint('monthly_budget_micros', { mode: 'number' }),
  budgetTimezone: text('budget_timezone').default('UTC').notNull(),
  /**
   * HeoPress P09 task 4.5: an optional daily model budget (null: none), counted per day in the site's time zone
   * (`lumibase_site_content_settings.timezone`); once used up, calls are deferred to the next local day.
   */
  dailyBudgetMicros: bigint('daily_budget_micros', { mode: 'number' }),
  /** HeoPress P09 task 4.6: how many source documents may enter processing per local day (null: no limit). */
  dailyProcessingLimit: integer('daily_processing_limit'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * A logical call: what the caller asked for once (`call_key`), its frozen
 * candidate chain and deadline, its terminal state and the winning result.
 * The terminal state and result never change once written.
 */
export const llmCalls = pgTable(
  'lumibase_llm_calls',
  {
    id: text('id').$defaultFn(() => nanoid()).primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    callKey: text('call_key').notNull(),
    taskType: text('task_type').notNull(),
    originKind: text('origin_kind').notNull(),
    originId: text('origin_id'),
    /**
     * HeoPress P09 task 4.7: the AI capability that made the call (`chat`, `ingest_embedding`, `translate`,
     * `rewrite`, `write`, `seo_copy`, `workbench_trial`, `flow`, `fact_check`, …). Null on calls made before P09.
     */
    capability: text('capability'),
    requestDigest: text('request_digest').notNull(),
    /** Ordered candidates with source, reference, base URL, protocol, model and price snapshots. */
    candidates: jsonb('candidates').notNull(),
    deadlineAt: timestamp('deadline_at', { withTimezone: true }).notNull(),
    /** `open` | `completed` | `failed`. */
    status: text('status').notNull(),
    terminalReason: text('terminal_reason'),
    cancelRequestedAt: timestamp('cancel_requested_at', { withTimezone: true }),
    ownerId: text('owner_id'),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    winnerAttemptId: text('winner_attempt_id'),
    /** The winning response (content, tool calls, provider and model actually used). */
    result: jsonb('result'),
    version: integer('version').default(0).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    callKeyUnique: unique('llm_calls_site_call_key_unique').on(t.siteId, t.callKey),
    siteIdUnique: unique('llm_calls_site_id_unique').on(t.siteId, t.id),
    statusCheck: check('llm_calls_status_check', sql`${t.status} IN ('open', 'completed', 'failed')`),
    terminalCheck: check(
      'llm_calls_terminal_check',
      sql`(${t.status} = 'open' AND ${t.terminalReason} IS NULL AND ${t.winnerAttemptId} IS NULL AND ${t.result} IS NULL)
       OR (${t.status} = 'completed' AND ${t.terminalReason} IS NULL AND ${t.winnerAttemptId} IS NOT NULL AND ${t.result} IS NOT NULL)
       OR (${t.status} = 'failed' AND ${t.terminalReason} IS NOT NULL AND ${t.winnerAttemptId} IS NULL AND ${t.result} IS NULL)`,
    ),
    // The winner is an attempt of this very call: written in the same
    // transaction as that attempt's success, conditioned on it (a database
    // reference back to the attempts would make the two tables circular).
    openLeaseIdx: index('llm_calls_open_lease_idx').on(t.leaseUntil).where(sql`${t.status} = 'open'`),
  }),
);

/**
 * The ledger: one row per network attempt. Execution outcome and billing
 * are separate: a timed-out attempt keeps its liability while the call
 * moves on. `source` says whose configuration it used: a site provider
 * (`provider_id`) or an instance one (`instance_ref`: `llm-default`,
 * `decision`, `embedding`) — exactly one of them.
 */
export const llmAttempts = pgTable(
  'lumibase_llm_attempts',
  {
    id: text('id').$defaultFn(() => nanoid()).primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    callId: text('call_id').notNull(),
    /** 1, 2, … within the call; the attempt key is `<call_key>#<seq>`. */
    seq: integer('seq').notNull(),
    /** Index of the candidate in the call's frozen chain. */
    position: integer('position').notNull(),
    previousAttemptId: text('previous_attempt_id'),
    source: text('source').notNull(),
    providerId: text('provider_id'),
    instanceRef: text('instance_ref'),
    /** Name, model, base URL, protocol, pricing, currency, config fingerprint (no secret). */
    snapshot: jsonb('snapshot').notNull(),
    requestDigest: text('request_digest').notNull(),
    /** Budget period, fixed at reservation: `YYYY-MM` in the site's budget time zone. */
    period: text('period').notNull(),
    /** `in_flight` | `succeeded` | `failed_transferable` | `failed_final` | `lost`. */
    outcome: text('outcome').notNull(),
    /** `reserved` | `unknown` | `settled` | `cancelled`. */
    billing: text('billing').notNull(),
    version: integer('version').default(0).notNull(),
    ownerId: text('owner_id'),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    reservedMicros: bigint('reserved_micros', { mode: 'number' }).notNull(),
    actualMicros: bigint('actual_micros', { mode: 'number' }),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    /** A safe code; never the upstream's text. */
    errorCode: text('error_code'),
    /** `auto` | `manual`. */
    settledBy: text('settled_by'),
    /** Manual reconciliation: operator, time, evidence, and every revision. */
    reconciliation: jsonb('reconciliation'),
    /** An automatic result that arrived after a manual conclusion (kept, not applied). */
    lateResult: jsonb('late_result'),
    overspend: boolean('overspend').default(false).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    settledAt: timestamp('settled_at', { withTimezone: true }),
  },
  (t) => ({
    callSeqUnique: unique('llm_attempts_call_seq_unique').on(t.siteId, t.callId, t.seq),
    // Target of the same-call references (winner, previous attempt).
    callIdUnique: unique('llm_attempts_site_call_id_unique').on(t.siteId, t.callId, t.id),
    siteIdUnique: unique('llm_attempts_site_id_unique').on(t.siteId, t.id),
    callFk: foreignKey({
      columns: [t.siteId, t.callId],
      foreignColumns: [llmCalls.siteId, llmCalls.id],
      name: 'llm_attempts_call_fk',
    }),
    // RESTRICT-like (NO ACTION): a provider with ledger entries is soft-deleted, never removed.
    providerFk: foreignKey({
      columns: [t.siteId, t.providerId],
      foreignColumns: [llmProviders.siteId, llmProviders.id],
      name: 'llm_attempts_provider_fk',
    }),
    // The previous attempt belongs to the same call.
    previousFk: foreignKey({
      columns: [t.siteId, t.callId, t.previousAttemptId],
      foreignColumns: [t.siteId, t.callId, t.id],
      name: 'llm_attempts_previous_fk',
    }),
    sourceCheck: check(
      'llm_attempts_source_check',
      sql`(${t.source} = 'site' AND ${t.providerId} IS NOT NULL AND ${t.instanceRef} IS NULL)
       OR (${t.source} = 'instance' AND ${t.providerId} IS NULL AND ${t.instanceRef} IS NOT NULL)`,
    ),
    outcomeCheck: check(
      'llm_attempts_outcome_check',
      sql`${t.outcome} IN ('in_flight', 'succeeded', 'failed_transferable', 'failed_final', 'lost')`,
    ),
    billingCheck: check('llm_attempts_billing_check', sql`${t.billing} IN ('reserved', 'unknown', 'settled', 'cancelled')`),
    // A reservation exists only while the attempt is in flight.
    reservedOnlyInFlight: check('llm_attempts_reserved_in_flight_check', sql`${t.billing} <> 'reserved' OR ${t.outcome} = 'in_flight'`),
    settledHasAmount: check('llm_attempts_settled_amount_check', sql`${t.billing} <> 'settled' OR ${t.actualMicros} IS NOT NULL`),
    amountsCheck: check('llm_attempts_amounts_check', sql`${t.reservedMicros} >= 0 AND (${t.actualMicros} IS NULL OR ${t.actualMicros} >= 0)`),
    budgetIdx: index('llm_attempts_budget_idx').on(t.siteId, t.period, t.billing),
    // The daily budget sums a site's attempts of one local day (HeoPress P09 task 4.5).
    siteCreatedIdx: index('llm_attempts_site_created_idx').on(t.siteId, t.createdAt),
    inFlightLeaseIdx: index('llm_attempts_in_flight_lease_idx').on(t.leaseUntil).where(sql`${t.outcome} = 'in_flight'`),
    unknownIdx: index('llm_attempts_unknown_idx').on(t.siteId, t.createdAt).where(sql`${t.billing} = 'unknown'`),
  }),
);

/**
 * Why a site's AI content pipeline is paused (HeoPress P09 tasks 4.2, 4.4; spec ai/cost-control). A site is paused
 * while it has an active row (`lifted_at IS NULL`) — or while the kill switch freezes it. Reasons are kept apart:
 * `budget` (the month's model budget was used up; `period` is that month) is lifted automatically once the budget
 * month changes; `manual` and `incident` stay until a person lifts them. Rows are never deleted (the history).
 */
export const aiPipelinePauses = pgTable(
  'lumibase_ai_pipeline_pauses',
  {
    id: text('id').$defaultFn(() => nanoid()).primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    /** `budget` | `manual` | `incident`. */
    reason: text('reason').notNull(),
    /** The budget month (`YYYY-MM`, budget time zone) of a `budget` pause; null otherwise. */
    period: text('period'),
    note: text('note'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    liftedAt: timestamp('lifted_at', { withTimezone: true }),
    liftedBy: text('lifted_by'),
  },
  (t) => ({
    reasonCheck: check('ai_pipeline_pauses_reason_check', sql`${t.reason} IN ('budget', 'manual', 'incident')`),
    periodCheck: check('ai_pipeline_pauses_period_check', sql`(${t.reason} = 'budget') = (${t.period} IS NOT NULL)`),
    // One active pause per reason: a second "pause" is a no-op, a budget pause notifies once.
    activeUnique: uniqueIndex('ai_pipeline_pauses_active_unique').on(t.siteId, t.reason).where(sql`${t.liftedAt} IS NULL`),
  }),
);

/**
 * Source documents admitted into processing per local day (HeoPress P09 task 4.6): the counter behind the daily
 * processing quota, independent from the publishing cadence. `day` is `YYYY-MM-DD` in the site's time zone.
 */
export const aiProcessingDays = pgTable(
  'lumibase_ai_processing_days',
  {
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    day: text('day').notNull(),
    admitted: integer('admitted').default(0).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.siteId, t.day] }),
    admittedCheck: check('ai_processing_days_admitted_check', sql`${t.admitted} >= 0`),
  }),
);
