import { sql } from 'drizzle-orm';
import { bigint, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
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
