import { sql } from 'drizzle-orm';
import { bigint, check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { nanoid } from 'nanoid';
import { sites } from './core';

/**
 * The AI content pipeline (HeoPress P09 tasks 1.1–1.10; spec ai/content-pipeline).
 *
 * A **production** is one request to turn source documents (or a translation group's source item) into a draft of the
 * site: translate, rewrite, write, or retranslate the stale blocks of a translation. Its idempotency key —
 * `(sorted source ids and versions, site, target language, mode, prompt version, editorial policy version)` — is
 * unique per site, so triggering the same request twice never makes a second draft; a newer source version, another
 * target language or another policy version is another request.
 *
 * The production keeps the full source record (URL, final URL, snapshot, licence revision and terms at the time) as
 * read from the database — never as a model said it — the value assessment, the draft it made, its gate and
 * publish-proposal results (filled by later slices) and its retry state.
 */
export const aiProductions = pgTable(
  'lumibase_ai_productions',
  {
    id: text('id').$defaultFn(() => nanoid()).primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    /** SHA-256 of the canonical idempotency tuple. */
    idempotencyKey: text('idempotency_key').notNull(),
    /** `translate` | `rewrite` | `write` | `retranslate`. */
    mode: text('mode').notNull(),
    targetLocale: text('target_locale'),
    /** The collection the draft is (to be) written to. */
    collection: text('collection').notNull(),
    /**
     * Every source: `{ kind: 'source_document' | 'item', id, version, sourceId?, url?, finalUrl?, snapshotId?,
     * licenceRevisionId?, licenceStatus?, usageMode?, title? }`, sorted by id.
     */
    sources: jsonb('sources').$type<Array<Record<string, unknown>>>().notNull(),
    promptVersion: text('prompt_version').notNull(),
    /** The editorial profile version in effect (null: the site has none). */
    editorialProfileVersion: integer('editorial_profile_version'),
    /**
     * `running` | `drafted` | `low_value` | `refused_usage` | `terminated` (an agent cap) | `retry_scheduled` |
     * `failed` | `nothing_to_do` (a retranslation without candidates).
     */
    status: text('status').default('running').notNull(),
    /** Why it stopped (refusal reason, cap, error code). */
    statusReason: text('status_reason'),
    valueScore: integer('value_score'),
    valueReasons: jsonb('value_reasons').$type<string[]>(),
    valueThreshold: integer('value_threshold'),
    /** The draft: an item, or for a retranslation the content version (`draft revision`) on the target item. */
    itemId: text('item_id'),
    contentVersionKey: text('content_version_key'),
    /** Block correspondence: `[{ sourceKey, targetKey, sourceHash, origin: 'memory' | 'model' }]`; retranslation review items. */
    blockMap: jsonb('block_map').$type<Array<Record<string, unknown>>>().default([]).notNull(),
    review: jsonb('review').$type<Array<Record<string, unknown>>>().default([]).notNull(),
    /** The quality gate's result, bound to the item version it checked (filled by the gate, slice 3). */
    gate: jsonb('gate').$type<Record<string, unknown> | null>(),
    /** What happened to the publish proposal (slice 4 decides; until then always the review queue). */
    publishProposal: jsonb('publish_proposal').$type<Record<string, unknown> | null>(),
    /** Retry state (`afterTaskFailure`): business retries spent, the limit, and when it may run again. */
    attempts: integer('attempts').default(0).notNull(),
    maxAttempts: integer('max_attempts').default(3).notNull(),
    notBefore: timestamp('not_before', { withTimezone: true }),
    flowRunId: text('flow_run_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    keyUnique: uniqueIndex('ai_productions_site_key_unique').on(t.siteId, t.idempotencyKey),
    itemIdx: index('ai_productions_item_idx').on(t.siteId, t.itemId),
    modeCheck: check('ai_productions_mode_check', sql`${t.mode} IN ('translate', 'rewrite', 'write', 'retranslate')`),
    statusCheck: check(
      'ai_productions_status_check',
      sql`${t.status} IN ('running', 'drafted', 'low_value', 'refused_usage', 'terminated', 'retry_scheduled', 'failed', 'nothing_to_do')`,
    ),
  }),
);

/**
 * The run record of a production, one row per step (HeoPress P09 task 1.7): which step, the AI capability, the model
 * call (ledger call id, provider, model), the prompt and editorial policy versions, tokens and cost. Steps without a
 * model call (fetch, usage check, translation-memory hits, gate) are recorded too, with what they decided.
 */
export const aiProductionSteps = pgTable(
  'lumibase_ai_production_steps',
  {
    id: text('id').$defaultFn(() => nanoid()).primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    productionId: text('production_id')
      .notNull()
      .references(() => aiProductions.id, { onDelete: 'cascade' }),
    /** `fetch_source` | `usage_check` | `value_assessment` | `translate` | `rewrite` | `write` | `research` | `seo_copy` | `gate` | `propose_publish`. */
    step: text('step').notNull(),
    capability: text('capability'),
    callId: text('call_id'),
    provider: text('provider'),
    model: text('model'),
    promptVersion: text('prompt_version'),
    editorialProfileVersion: integer('editorial_profile_version'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    costMicros: bigint('cost_micros', { mode: 'number' }),
    /** `ok` | `refused` | `failed` | `terminated` | `skipped`. */
    outcome: text('outcome').default('ok').notNull(),
    detail: jsonb('detail').$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    productionIdx: index('ai_production_steps_production_idx').on(t.productionId, t.createdAt),
  }),
);

/**
 * Quality gate results (HeoPress P09 tasks 2.1, 2.2, 2.4–2.7; spec ai/quality-gate).
 *
 * One row per gate run on a draft. A result is **bound** to what it checked: the item version and content hash, the
 * gate policy hash (check levels, thresholds, editorial profile version, constitution hash) and every source's
 * licence revision. When any of these changes the result no longer applies (`QualityGate.current`): publishing needs
 * a new run. `checks` keeps each rule's raw verdict next to the status its site level made of it, so a level change
 * re-judges stored results without running the rules again.
 */
export const qualityGateResults = pgTable(
  'lumibase_quality_gate_results',
  {
    id: text('id').$defaultFn(() => nanoid()).primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    productionId: text('production_id').references(() => aiProductions.id, { onDelete: 'cascade' }),
    collection: text('collection').notNull(),
    itemId: text('item_id').notNull(),
    itemVersion: integer('item_version').notNull(),
    contentHash: text('content_hash').notNull(),
    /** SHA-256 of the gate policy in effect: levels, thresholds, editorial profile version, constitution hash. */
    policyHash: text('policy_hash').notNull(),
    editorialProfileVersion: integer('editorial_profile_version'),
    constitutionHash: text('constitution_hash'),
    /** `{ <source document id>: <licence revision id | null> }` at the time of the run. */
    licenceRevisions: jsonb('licence_revisions').$type<Record<string, string | null>>().default({}).notNull(),
    /** `passed` | `blocked` | `needs_review`. */
    status: text('status').notNull(),
    /** 0–100: the mean of the checks' scores. */
    score: integer('score').notNull(),
    /** `[{ rule, verdict, level, mandatory, status, score, evidence, suggestions }]`. */
    checks: jsonb('checks').$type<Array<Record<string, unknown>>>().default([]).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    itemIdx: index('quality_gate_results_item_idx').on(t.siteId, t.itemId, t.createdAt),
    productionIdx: index('quality_gate_results_production_idx').on(t.siteId, t.productionId, t.createdAt),
    statusCheck: check('quality_gate_results_status_check', sql`${t.status} IN ('passed', 'blocked', 'needs_review')`),
  }),
);

/**
 * A person's decision on a gate result that needs review (spec "人工审核结论与发布守卫"): bound to the result, and so to
 * its item version and content hash. It applies to that version only; a blocked result cannot be approved (a
 * deterministic block, safety above all, is fixed and re-run).
 */
export const qualityGateReviews = pgTable(
  'lumibase_quality_gate_reviews',
  {
    id: text('id').$defaultFn(() => nanoid()).primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    resultId: text('result_id')
      .notNull()
      .references(() => qualityGateResults.id, { onDelete: 'cascade' }),
    itemId: text('item_id').notNull(),
    itemVersion: integer('item_version').notNull(),
    contentHash: text('content_hash').notNull(),
    /** `approve` | `reject`. */
    decision: text('decision').notNull(),
    reason: text('reason').notNull(),
    reviewerId: text('reviewer_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    resultIdx: index('quality_gate_reviews_result_idx').on(t.siteId, t.resultId),
    decisionCheck: check('quality_gate_reviews_decision_check', sql`${t.decision} IN ('approve', 'reject')`),
  }),
);

/**
 * A site's gate settings: the level of each check (`block` | `warn` | `off`; mandatory checks are always `block`),
 * thresholds, and `version`, which grows on every change (changes are audited).
 */
export const qualityGateSettings = pgTable('lumibase_quality_gate_settings', {
  siteId: text('site_id')
    .primaryKey()
    .references(() => sites.id, { onDelete: 'cascade' }),
  levels: jsonb('levels').$type<Record<string, string>>().default({}).notNull(),
  thresholds: jsonb('thresholds').$type<Record<string, number>>().default({}).notNull(),
  version: integer('version').default(1).notNull(),
  updatedBy: text('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * A site's auto-publish settings (HeoPress P09 tasks 3.1–3.7; spec ai/auto-publish).
 *
 * - `agentRole`: the role whose `publish` capability grant (trust tier, `lumibase_agent_autonomy_grants`) decides:
 *   L1/L2 → review queue, L3 → veto window, L4 → immediate.
 * - Cadence: `dailyLimit` auto-publishes per local day of the site (`lumibase_site_content_settings.timezone`; null:
 *   no limit) and `minIntervalMinutes` between two; the excess waits in the queue.
 * - `sourceMaxAgeDays`: a source published earlier than that goes to review (`freshnessExemptCollections` exempt).
 * - `requiredLocales`: the languages a translation group's members **on this site** publish and unpublish together.
 * - `version` grows on every change: a candidate decided under another version goes back to review.
 */
export const autoPublishSettings = pgTable('lumibase_auto_publish_settings', {
  siteId: text('site_id')
    .primaryKey()
    .references(() => sites.id, { onDelete: 'cascade' }),
  agentRole: text('agent_role').default('content-pipeline').notNull(),
  vetoWindowMinutes: integer('veto_window_minutes').default(30).notNull(),
  dailyLimit: integer('daily_limit'),
  minIntervalMinutes: integer('min_interval_minutes').default(0).notNull(),
  sourceMaxAgeDays: integer('source_max_age_days').default(60).notNull(),
  freshnessExemptCollections: jsonb('freshness_exempt_collections').$type<string[]>().default([]).notNull(),
  requiredLocales: jsonb('required_locales').$type<string[]>().default([]).notNull(),
  version: integer('version').default(1).notNull(),
  updatedBy: text('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * An auto-publish candidate: one item version proposed for publishing, and what became of it.
 *
 * It **pins** what it was decided on — the item version and content hash, the gate result, the sources' licence
 * revisions, the trust tier and the settings version — and the final publish transaction checks all of them again.
 * `status`: `review` (a person decides; `reason` says why), `veto_window` (L3: publishes after `not_before` unless
 * vetoed), `queued` (waits for the cadence, or for the other required languages), `published`, `superseded` (a newer
 * proposal of the item), `dismissed` (a person closed it). At most one open candidate per item.
 */
export const autoPublishCandidates = pgTable(
  'lumibase_auto_publish_candidates',
  {
    id: text('id').$defaultFn(() => nanoid()).primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    productionId: text('production_id').references(() => aiProductions.id, { onDelete: 'set null' }),
    collection: text('collection').notNull(),
    itemId: text('item_id').notNull(),
    itemVersion: integer('item_version').notNull(),
    contentHash: text('content_hash').notNull(),
    gateResultId: text('gate_result_id'),
    /** `{ <source document id>: <licence revision id | null> }` when decided. */
    licenceRevisions: jsonb('licence_revisions').$type<Record<string, string | null>>().default({}).notNull(),
    /** The trust tier of the `publish` capability when decided (0–4). */
    autonomyLevel: integer('autonomy_level').notNull(),
    settingsVersion: integer('settings_version').notNull(),
    status: text('status').notNull(),
    /** Why it is where it is (`gate_not_passed`, `licence_unknown`, `tier_l2`, `vetoed`, `waiting_for_locales`, …). */
    reason: text('reason').notNull(),
    detail: jsonb('detail').$type<Record<string, unknown>>().default({}).notNull(),
    /** Veto window end (L3), or the earliest time the cadence allows (queued). */
    notBefore: timestamp('not_before', { withTimezone: true }),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    decidedBy: text('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    openUnique: uniqueIndex('auto_publish_candidates_open_unique')
      .on(t.siteId, t.itemId)
      .where(sql`${t.status} IN ('review', 'veto_window', 'queued')`),
    dueIdx: index('auto_publish_candidates_due_idx').on(t.status, t.notBefore),
    siteIdx: index('auto_publish_candidates_site_idx').on(t.siteId, t.status, t.createdAt),
    statusCheck: check(
      'auto_publish_candidates_status_check',
      sql`${t.status} IN ('review', 'veto_window', 'queued', 'published', 'superseded', 'dismissed')`,
    ),
  }),
);

/** Auto-publishes per local day of a site (the cadence counter; its row is locked while a publish reserves a slot). */
export const autoPublishDays = pgTable(
  'lumibase_auto_publish_days',
  {
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    /** `YYYY-MM-DD` in the site's time zone. */
    day: text('day').notNull(),
    published: integer('published').default(0).notNull(),
    lastPublishedAt: timestamp('last_published_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.siteId, t.day] }),
  }),
);

/**
 * Flow definitions drafted by an agent (HeoPress P09 task 5.1; spec ai/flow-authoring; ADR-0012). A draft only names
 * registered operation types (checked when submitted); it becomes a flow only when a person approves it in Studio —
 * never through an agent channel. `pending` → `approved` (the flow is created, `flowId`) or `rejected`.
 */
export const flowDrafts = pgTable(
  'lumibase_flow_drafts',
  {
    id: text('id').$defaultFn(() => nanoid()).primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    triggerType: text('trigger_type').notNull(),
    triggerOptions: jsonb('trigger_options').$type<Record<string, unknown>>().default({}).notNull(),
    graph: jsonb('graph').$type<Record<string, unknown>>().notNull(),
    /** The person the draft is for: the signed-in user, or the creator of the agent's API key. */
    draftedBy: text('drafted_by'),
    /** `agent` (an API key / MCP / Agent API tool call) or `studio`. */
    draftedVia: text('drafted_via').notNull(),
    apiKeyId: text('api_key_id'),
    status: text('status').default('pending').notNull(),
    /** The approval mode when submitted (a mode change applies to later drafts only). */
    approvalMode: text('approval_mode').notNull(),
    decidedBy: text('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decisionReason: text('decision_reason'),
    /** How the approver verified (`totp`, `none`). */
    verification: text('verification'),
    flowId: text('flow_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    siteIdx: index('flow_drafts_site_idx').on(t.siteId, t.status, t.createdAt),
    statusCheck: check('flow_drafts_status_check', sql`${t.status} IN ('pending', 'approved', 'rejected')`),
    viaCheck: check('flow_drafts_via_check', sql`${t.draftedVia} IN ('agent', 'studio')`),
  }),
);
