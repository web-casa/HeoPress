import { sql } from 'drizzle-orm';
import { bigint, boolean, index, integer, pgSequence, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Runtime infrastructure on PostgreSQL (HeoPress P03, ADR-0002): the cache,
 * the unique-member counters and the rate-limit windows that Redis used to
 * hold. Keys already carry their scope (`items:<siteId>:…`, `rl:<siteId>:…`),
 * so these system tables have no `site_id` column.
 *
 * `lumibase_cache_entries` and `lumibase_cache_unique_members` are switched to
 * UNLOGGED by the migrate script (`UNLOGGED_TABLES`): their content is
 * disposable and a crash may empty them. Tag generations and rate-limit
 * windows stay logged — a restart must not resurrect stale entries or reset a
 * security budget.
 */

/**
 * Version of every cache write. Global, so a key that is deleted and written
 * again never reuses a version an L1 copy might still hold.
 */
export const cacheVersionSeq = pgSequence('lumibase_cache_version_seq');

/**
 * L2 cache entries. `tag_generations[i]` is the generation of `tags[i]` when
 * written; `version` changes on every write, so a reader can check its L1 copy
 * without fetching the value again.
 */
export const cacheEntries = pgTable(
  'lumibase_cache_entries',
  {
    key: text('key').primaryKey(),
    value: text('value').notNull(),
    version: bigint('version', { mode: 'number' }).notNull().default(sql`nextval('lumibase_cache_version_seq')`),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    tagGenerations: bigint('tag_generations', { mode: 'number' }).array().notNull().default(sql`'{}'::bigint[]`),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  },
  (t) => ({
    tagsIdx: index('cache_entries_tags_idx').using('gin', t.tags),
    expiresIdx: index('cache_entries_expires_idx').on(t.expiresAt),
  }),
);

/** Current generation of each cache tag; bumped by `invalidateByTag`. */
export const cacheTags = pgTable('lumibase_cache_tags', {
  tag: text('tag').primaryKey(),
  generation: bigint('generation', { mode: 'number' }).notNull().default(0),
});

/** Members of an approximate-cardinality counter (`UniqueCounterProvider`). */
export const cacheUniqueMembers = pgTable(
  'lumibase_cache_unique_members',
  {
    key: text('key').notNull(),
    member: text('member').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.key, t.member] }),
  }),
);

/** Fixed-window rate-limit counters. Logged: a restart must not reset a security budget. */
export const rateLimitWindows = pgTable(
  'lumibase_rate_limit_windows',
  {
    key: text('key').primaryKey(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    windowSeconds: integer('window_seconds').notNull(),
    count: integer('count').notNull(),
  },
  (t) => ({
    windowIdx: index('rate_limit_windows_start_idx').on(t.windowStart),
  }),
);

/** Tables the migrate script switches to UNLOGGED after migrating. */
export const UNLOGGED_TABLES = ['lumibase_cache_entries', 'lumibase_cache_unique_members'] as const;

/**
 * One row per scheduled slot (P03 task 3.2; design "故障语义"): the first
 * worker to insert `(schedule_key, scheduled_at)` runs the slot, everyone else
 * skips it. A crash leaves the row `running`; the slot is not retried, so its
 * side effects cannot run twice. `status`: running | succeeded | failed |
 * skipped_overlap (an earlier slot of the job was still running).
 * `lease_until` is renewed while the slot runs; a `running` row with a live
 * lease blocks the next slot even if the runner lost its advisory lock.
 */
export const scheduleRuns = pgTable(
  'lumibase_schedule_runs',
  {
    scheduleKey: text('schedule_key').notNull(),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
    owner: text('owner').notNull(),
    status: text('status').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    error: text('error'),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.scheduleKey, t.scheduledAt] }),
    startedIdx: index('schedule_runs_started_idx').on(t.startedAt),
  }),
);

/**
 * Ledger of actions sent to external systems — webhooks, notifications,
 * deployments, callbacks (P03 tasks 3.4–3.5; spec "外部动作结果状态").
 * One row per idempotency key. `state` is one of the four outcomes:
 *   not_sent  — never sent, or a manual check confirmed it did not happen;
 *   failed    — the other side confirmed it did not execute (safe to retry);
 *   succeeded — done; never sent again;
 *   unknown   — sent (or being sent) without a reliable answer: a timeout, a
 *               lost receipt, a crash mid-send.
 * `paused` marks an unknown action that cannot be resolved automatically and
 * waits for manual reconciliation. A local unique key is NOT an exactly-once
 * guarantee across systems: only an idempotency key the target honours
 * (`key_expires_at`) or the target's own status query can settle `unknown`.
 */
export const externalActions = pgTable(
  'lumibase_external_actions',
  {
    idempotencyKey: text('idempotency_key').primaryKey(),
    siteId: text('site_id'),
    kind: text('kind').notNull(),
    /** What was addressed, without secrets (e.g. `webhook:<id>`, a host name). */
    target: text('target').notNull(),
    state: text('state').notNull().default('not_sent'),
    paused: boolean('paused').notNull().default(false),
    attempts: integer('attempts').notNull().default(0),
    /** While set and in the future, an attempt is in flight on some worker. */
    inFlightUntil: timestamp('in_flight_until', { withTimezone: true }),
    /** End of the window in which the target dedupes repeats of this key. */
    keyExpiresAt: timestamp('key_expires_at', { withTimezone: true }),
    lastError: text('last_error'),
    resolvedBy: text('resolved_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pausedIdx: index('external_actions_paused_idx').on(t.siteId, t.paused),
  }),
);
