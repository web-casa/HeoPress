// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { sql } from 'drizzle-orm';
import {
  bigint,
  customType,
  index,
  integer,
  jsonb,
  pgSequence,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { nanoid } from 'nanoid';
import { sites } from './core';
import { webhooks } from './platform';

const id = () => text('id').$defaultFn(() => nanoid()).primaryKey();
const createdAt = () => timestamp('created_at').defaultNow().notNull();
const updatedAt = () => timestamp('updated_at').defaultNow().notNull();

/*
 * ── Change Feed (spec: docs/legacy/kiro-specs/cdc-extension-integration) ───────────────
 *
 * First-party transactional outbox + relay over content mutations. (The
 * ClickHouse CDC control-plane tables were removed in HeoPress P02; the new
 * migration baseline drops them.)
 *
 * ID/cursor convention: PKs are nanoid text (matching `audit_log` and every
 * regulated/audit-grade table — see the note in `regulated.ts`; the codebase
 * deliberately carries no uuidv7 dependency). Feed ordering therefore comes
 * from the composite keyset `(occurred_at, id)` — `occurred_at` is stamped by
 * Postgres `now()` (one clock), with `id` as a deterministic tie-breaker —
 * not from the id itself. Cursors are opaque tokens encoding that pair
 * (`encodeCdcCursor` in `@heopress/contracts/schemas`).
 */

/**
 * `lumibase_cdc_change_events` — append-only outbox. One row per committed
 * item mutation when the feed is enabled for the site. Never UPDATEd; only
 * retention pruning deletes. `payload` is the post-mutation snapshot with
 * pii/phi fields masked BEFORE insert (Req 1.4); NULL for deletes and for
 * reference-mode-only sites.
 */
/**
 * PostgreSQL 64-bit transaction id. Read as text: it does not fit a JS number
 * safely, and only the database compares it.
 */
export const xid8 = customType<{ data: string; driverData: string }>({
  dataType: () => 'xid8',
});

/** Order of events within the commit order of their transactions (HeoPress P04). */
export const cdcEventSeq = pgSequence('lumibase_cdc_change_events_seq');

export const cdcChangeEvents = pgTable(
  'lumibase_cdc_change_events',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    /**
     * Resource kind the event describes: 'item' (default — content rows),
     * 'collection'/'field' (schema changes), or 'setting'. Drives the envelope
     * `type` prefix (`items.*`, `collections.*`, `fields.*`, `settings.*`).
     * Defaults to 'item' so rows written before this column read correctly.
     */
    resource: text('resource').default('item').notNull(),
    collection: text('collection').notNull(),
    itemId: text('item_id').notNull(),
    /** 'create' | 'update' | 'delete' */
    operation: text('operation').notNull(),
    /** Masked post-mutation snapshot; NULL on delete. */
    payload: jsonb('payload'),
    /** string[] of changed field names (update only). */
    changedFields: jsonb('changed_fields'),
    schemaVersion: integer('schema_version').default(1).notNull(),
    /** 'user' | 'api_key' | 'agent' | 'system' */
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    /** 'api' | 'agent' | 'flow' | 'system' */
    source: text('source').notNull(),
    /**
     * Keyset major key — DB clock, not app clock. Millisecond precision to match
     * the cursor (`occurredAtMs`); see migration 0020.
     */
    occurredAt: timestamp('occurred_at', { precision: 3 }).defaultNow().notNull(),
    /**
     * Position (HeoPress P04, spec content/change-events "晚提交事件不被跳过"):
     * the writing transaction's id and a sequence number. Readers order by
     * (txid, seq) and only read transactions older than every one still in
     * progress (`txid < pg_snapshot_xmin(pg_current_snapshot())`), so a long
     * transaction that commits late is read late, never skipped.
     */
    txid: xid8('txid').default(sql`pg_current_xact_id()`).notNull(),
    seq: bigint('seq', { mode: 'number' }).default(sql`nextval('lumibase_cdc_change_events_seq')`).notNull(),
    /** The item version this event produced (item events; P04). Lets consumers ignore stale events. */
    itemVersion: integer('item_version'),
  },
  (t) => ({
    positionIdx: index('cdc_change_events_position_idx').on(t.txid, t.seq),
    sitePositionIdx: index('cdc_change_events_site_position_idx').on(t.siteId, t.txid, t.seq),
    siteCursorIdx: index('cdc_change_events_site_cursor_idx').on(
      t.siteId,
      t.occurredAt,
      t.id,
    ),
    siteCollectionCursorIdx: index('cdc_change_events_site_collection_cursor_idx').on(
      t.siteId,
      t.collection,
      t.occurredAt,
      t.id,
    ),
  }),
);

/**
 * `lumibase_cdc_subscriptions` — consumer registry + checkpoint. The cursor
 * pair points at the LAST successfully delivered/acked event; NULL means
 * "start from the head at creation time". State machine per design §3.2:
 * active ⇄ paused; active → dead (10 consecutive failures);
 * active/paused → stale (cursor pruned past); dead/stale → active only via
 * explicit replay/resume.
 */
export const cdcSubscriptions = pgTable(
  'lumibase_cdc_subscriptions',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** 'pull' | 'webhook' | 'extension' */
    kind: text('kind').notNull(),
    /** string[] collection filter; [] = all. */
    collections: jsonb('collections').default([]).notNull(),
    /** string[] operation filter; [] = all. */
    operations: jsonb('operations').default([]).notNull(),
    /** 'reference' | 'snapshot' */
    payloadMode: text('payload_mode').default('reference').notNull(),
    cursorOccurredAt: timestamp('cursor_occurred_at', { precision: 3 }),
    cursorId: text('cursor_id'),
    /** 'active' | 'paused' | 'dead' | 'stale' */
    status: text('status').default('active').notNull(),
    webhookId: text('webhook_id').references(() => webhooks.id, {
      onDelete: 'set null',
    }),
    extensionName: text('extension_name'),
    consecutiveFailures: integer('consecutive_failures').default(0).notNull(),
    lastDeliveredAt: timestamp('last_delivered_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    siteNameUnique: uniqueIndex('cdc_subscriptions_site_name_unique').on(
      t.siteId,
      t.name,
    ),
    siteStatusIdx: index('cdc_subscriptions_site_status_idx').on(
      t.siteId,
      t.status,
    ),
  }),
);

/**
 * `lumibase_cdc_deliveries` — append-only delivery-attempt log (one row per
 * batch attempt). `errorMessage` is masked before insert. Pruned on the same
 * retention policy as the outbox.
 */
export const cdcDeliveries = pgTable(
  'lumibase_cdc_deliveries',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    subscriptionId: text('subscription_id')
      .notNull()
      .references(() => cdcSubscriptions.id, { onDelete: 'cascade' }),
    eventIdFrom: text('event_id_from'),
    eventIdTo: text('event_id_to'),
    eventCount: integer('event_count').default(0).notNull(),
    attempt: integer('attempt').default(1).notNull(),
    /** 'success' | 'failed' | 'unknown' (may have been processed: timeout, 5xx) */
    status: text('status').notNull(),
    httpStatus: integer('http_status'),
    /** Masked — never raw provider/consumer output. */
    errorMessage: text('error_message'),
    durationMs: integer('duration_ms').default(0).notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    siteSubTimeIdx: index('cdc_deliveries_site_sub_time_idx').on(
      t.siteId,
      t.subscriptionId,
      t.createdAt,
    ),
  }),
);

/**
 * Event consumers (HeoPress P04, spec platform/event-consumption): each has
 * its own position in the change events, reads in order and records what it
 * has handled. `site_id` scopes a consumer to one site (webhook
 * subscriptions); null reads every site (search sync). A paused consumer
 * reads nothing until resumed, but still holds back retention.
 */
export const eventConsumers = pgTable('lumibase_event_consumers', {
  name: text('name').primaryKey(),
  siteId: text('site_id').references(() => sites.id, { onDelete: 'cascade' }),
  cursorTxid: xid8('cursor_txid'),
  cursorSeq: bigint('cursor_seq', { mode: 'number' }),
  /** 'active' | 'paused' */
  status: text('status').default('active').notNull(),
  pausedReason: text('paused_reason'),
  consecutiveFailures: integer('consecutive_failures').default(0).notNull(),
  /**
   * Lease: one runner at a time per consumer, without holding a transaction
   * open while handlers run (an open transaction with an id would hold back
   * every reader's position).
   */
  leaseToken: text('lease_token'),
  leaseUntil: timestamp('lease_until', { withTimezone: true }),
  lastRunAt: timestamp('last_run_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * Events a consumer could not handle. `retrying` ones come back after a
 * backoff; after the attempt limit they are `dead` (dead letter). `unknown`
 * means a side effect may or may not have happened: no retry until a person
 * confirms. None of them blocks the consumer's later events.
 */
export const eventConsumerFailures = pgTable(
  'lumibase_event_consumer_failures',
  {
    consumer: text('consumer')
      .notNull()
      .references(() => eventConsumers.name, { onDelete: 'cascade' }),
    eventId: text('event_id').notNull(),
    /** 'retrying' | 'dead' | 'unknown' */
    state: text('state').notNull(),
    attempts: integer('attempts').default(1).notNull(),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.consumer, t.eventId] }),
    dueIdx: index('event_consumer_failures_due_idx').on(t.state, t.nextAttemptAt),
  }),
);

/** Events a consumer has handled — the idempotency record (re-delivery is skipped). */
export const eventConsumerProcessed = pgTable(
  'lumibase_event_consumer_processed',
  {
    consumer: text('consumer')
      .notNull()
      .references(() => eventConsumers.name, { onDelete: 'cascade' }),
    eventId: text('event_id').notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.consumer, t.eventId] }),
  }),
);

/**
 * How far retention has deleted a site's events (HeoPress P04): the highest
 * position removed. A cursor before it may have missed events and is
 * expired; a cursor at or after it can always continue — retention keeps
 * every event a registered consumer has not confirmed, however old.
 */
export const cdcPruneMarks = pgTable('lumibase_cdc_prune_marks', {
  siteId: text('site_id')
    .primaryKey()
    .references(() => sites.id, { onDelete: 'cascade' }),
  txid: xid8('txid').notNull(),
  seq: bigint('seq', { mode: 'number' }).notNull(),
  /**
   * The latest `occurred_at` among deleted events: a replay "from time T"
   * with T at or before it may miss deleted events, so it is expired
   * (Codex review P04-3 #6).
   */
  deletedUntil: timestamp('deleted_until', { withTimezone: true }),
  updatedAt: updatedAt(),
});
