/**
 * Event consumer operations (HeoPress P11 task 1.1, spec publishing/event-consumers): what an administrator sees of
 * each framework consumer — its backlog, its dead letters — and replaying a consumer from a chosen position.
 *
 * Webhook subscriptions (`cdc-subscription:*`) are consumers too, but they have their own delivery log, replay and
 * screen (Change Feed); they are left out here.
 *
 * Times: `occurred_at` is a timestamp without time zone holding UTC; it is read `AT TIME ZONE 'UTC'`.
 *
 * Backlog: how long the oldest event the consumer has not passed has been waiting (0 when it is caught up). Over
 * {@link BACKLOG_ALERT_SECONDS} the consumer is flagged; the scheduled reconciliation records an alert for it.
 */
import { sql } from 'drizzle-orm';
import type { Database } from '@heopress/database';

/** Spec "消费者停摆": a backlog over ten minutes alerts the administrator. */
export const BACKLOG_ALERT_SECONDS = 10 * 60;
/** Pending events are counted up to this many (the exact number past it does not matter for the view). */
const PENDING_COUNT_CAP = 10_000;
const SUBSCRIPTION_PREFIX = 'cdc-subscription:';

type Row = Record<string, unknown>;

export interface ConsumerOverview {
  name: string;
  siteId: string | null;
  status: string;
  pausedReason: string | null;
  /** The event the position is at (null: before every retained event). */
  cursor: { eventId: string | null; occurredAt: string | null } | null;
  lastRunAt: string | null;
  pending: number;
  pendingCapped: boolean;
  oldestPendingAt: string | null;
  backlogSeconds: number;
  overThreshold: boolean;
  failures: { retrying: number; dead: number; unknown: number };
}

export interface DeadLetter {
  eventId: string;
  state: string;
  attempts: number;
  lastError: string | null;
  updatedAt: string;
  /** Null when the event itself has been pruned. */
  event: { siteId: string; resource: string; collection: string; itemId: string; operation: string; occurredAt: string } | null;
}

const iso = (v: unknown): string | null => (v == null ? null : new Date(v instanceof Date ? v : String(v)).toISOString());

export async function listConsumers(db: Database, now = new Date()): Promise<ConsumerOverview[]> {
  const rows = (await db.execute(sql`
    SELECT c.name, c.site_id, c.status, c.paused_reason, c.last_run_at, c.cursor_txid IS NOT NULL AS has_cursor,
           at.id AS cursor_event_id, at.occurred_at AS cursor_occurred_at,
           p.n AS pending, p.oldest AS oldest_pending,
           (SELECT count(*) FILTER (WHERE f.state = 'retrying') FROM lumibase_event_consumer_failures f WHERE f.consumer = c.name)::int AS retrying,
           (SELECT count(*) FILTER (WHERE f.state = 'dead') FROM lumibase_event_consumer_failures f WHERE f.consumer = c.name)::int AS dead,
           (SELECT count(*) FILTER (WHERE f.state = 'unknown') FROM lumibase_event_consumer_failures f WHERE f.consumer = c.name)::int AS unknown
      FROM lumibase_event_consumers c
      LEFT JOIN LATERAL (
        SELECT e.id, (e.occurred_at AT TIME ZONE 'UTC') AS occurred_at FROM lumibase_cdc_change_events e
         WHERE c.cursor_txid IS NOT NULL AND e.txid = c.cursor_txid AND e.seq = c.cursor_seq LIMIT 1
      ) at ON true
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS n, min(x.occurred_at) AS oldest FROM (
          SELECT (e.occurred_at AT TIME ZONE 'UTC') AS occurred_at FROM lumibase_cdc_change_events e
           WHERE e.txid < pg_snapshot_xmin(pg_current_snapshot())
             AND (c.cursor_txid IS NULL OR (e.txid, e.seq) > (c.cursor_txid, c.cursor_seq))
             AND (c.site_id IS NULL OR e.site_id = c.site_id)
           LIMIT ${PENDING_COUNT_CAP}
        ) x
      ) p ON true
     WHERE c.name NOT LIKE ${`${SUBSCRIPTION_PREFIX}%`}
     ORDER BY c.name`)) as unknown as Row[];
  return rows.map((r) => {
    const oldest = iso(r.oldest_pending);
    const backlogSeconds = oldest ? Math.max(0, Math.floor((now.getTime() - new Date(oldest).getTime()) / 1000)) : 0;
    const pending = Number(r.pending ?? 0);
    return {
      name: String(r.name),
      siteId: (r.site_id as string | null) ?? null,
      status: String(r.status),
      pausedReason: (r.paused_reason as string | null) ?? null,
      cursor: r.has_cursor ? { eventId: (r.cursor_event_id as string | null) ?? null, occurredAt: iso(r.cursor_occurred_at) } : null,
      lastRunAt: iso(r.last_run_at),
      pending,
      pendingCapped: pending >= PENDING_COUNT_CAP,
      oldestPendingAt: oldest,
      backlogSeconds,
      overThreshold: backlogSeconds > BACKLOG_ALERT_SECONDS,
      failures: { retrying: Number(r.retrying ?? 0), dead: Number(r.dead ?? 0), unknown: Number(r.unknown ?? 0) },
    };
  });
}

/** Whether `name` is a consumer this screen manages. */
export async function consumerExists(db: Database, name: string): Promise<boolean> {
  if (name.startsWith(SUBSCRIPTION_PREFIX)) return false;
  const rows = (await db.execute(sql`SELECT 1 FROM lumibase_event_consumers WHERE name = ${name}`)) as unknown as Row[];
  return rows.length > 0;
}

/** The consumer's failed events — dead letters first, newest first — with what the event was. */
export async function listDeadLetters(db: Database, consumer: string, limit = 100): Promise<DeadLetter[]> {
  const rows = (await db.execute(sql`
    SELECT f.event_id, f.state, f.attempts, f.last_error, (f.updated_at AT TIME ZONE 'UTC') AS updated_at,
           e.site_id, e.resource, e.collection, e.item_id, e.operation, (e.occurred_at AT TIME ZONE 'UTC') AS occurred_at
      FROM lumibase_event_consumer_failures f
      LEFT JOIN lumibase_cdc_change_events e ON e.id = f.event_id
     WHERE f.consumer = ${consumer}
     ORDER BY (f.state = 'dead') DESC, f.updated_at DESC
     LIMIT ${Math.min(Math.max(limit, 1), 500)}`)) as unknown as Row[];
  return rows.map((r) => ({
    eventId: String(r.event_id),
    state: String(r.state),
    attempts: Number(r.attempts),
    lastError: (r.last_error as string | null) ?? null,
    updatedAt: iso(r.updated_at)!,
    event: r.resource
      ? {
          siteId: String(r.site_id),
          resource: String(r.resource),
          collection: String(r.collection),
          itemId: String(r.item_id),
          operation: String(r.operation),
          occurredAt: iso(r.occurred_at)!,
        }
      : null,
  }));
}

export type ReplayFrom = { at: Date } | { eventId: string };

export type ReplayResult =
  | { ok: true; replayFrom: { eventId: string | null; occurredAt: string | null }; events: number }
  | { ok: false; reason: 'not_found' | 'busy' | 'event_not_found' | 'dead' };

/**
 * Move the consumer's position back so it handles again every event from `from` on (spec "重放"): the first retained
 * event (in position order) that occurred at or after `at`, or the given event. The events from there are forgotten as
 * handled, and their `retrying`/`dead` records are cleared, so the runner handles them again — idempotently, by each
 * handler's own rules. Events waiting for a person's decision (`unknown`) keep it: replay never repeats a side effect
 * nobody confirmed.
 *
 * Only while no runner holds the consumer's lease (`busy` otherwise — try again): the position, the handled records and
 * the failures change in one transaction, and the consumer row stays locked until it commits, so a runner that starts
 * meanwhile reads the new position.
 */
export async function replayConsumer(db: Database, consumer: string, from: ReplayFrom): Promise<ReplayResult> {
  if (consumer.startsWith(SUBSCRIPTION_PREFIX)) return { ok: false, reason: 'not_found' };
  return db.transaction(async (tx) => {
    const [row] = (await tx.execute(sql`
      SELECT name, site_id, status, (lease_until IS NOT NULL AND lease_until >= now()) AS leased
        FROM lumibase_event_consumers WHERE name = ${consumer} FOR UPDATE`)) as unknown as Row[];
    if (!row) return { ok: false, reason: 'not_found' } as const;
    if (row.status === 'dead') return { ok: false, reason: 'dead' } as const;
    if (row.leased) return { ok: false, reason: 'busy' } as const;
    const siteId = (row.site_id as string | null) ?? null;
    const [first] = (
      'eventId' in from
        ? await tx.execute(sql`
            SELECT id, txid::text AS txid, seq, (occurred_at AT TIME ZONE 'UTC') AS occurred_at FROM lumibase_cdc_change_events
             WHERE id = ${from.eventId} AND (${siteId}::text IS NULL OR site_id = ${siteId})`)
        : await tx.execute(sql`
            SELECT id, txid::text AS txid, seq, (occurred_at AT TIME ZONE 'UTC') AS occurred_at FROM lumibase_cdc_change_events
             WHERE (occurred_at AT TIME ZONE 'UTC') >= ${from.at.toISOString()}::timestamptz
               AND txid < pg_snapshot_xmin(pg_current_snapshot())
               AND (${siteId}::text IS NULL OR site_id = ${siteId})
             ORDER BY txid, seq LIMIT 1`)
    ) as unknown as Row[];
    if (!first) {
      if ('eventId' in from) return { ok: false, reason: 'event_not_found' } as const;
      // Nothing that recent: there is nothing to replay; the position stays.
      return { ok: true, replayFrom: { eventId: null, occurredAt: null }, events: 0 } as const;
    }
    // Just before the chosen event: seq is one global sequence, so (txid, seq - 1) sorts right before it.
    const txid = String(first.txid);
    const seq = Number(first.seq) - 1;
    const after = sql`SELECT e.id FROM lumibase_cdc_change_events e
       WHERE (e.txid, e.seq) > (${txid}::xid8, ${seq}::bigint)
         AND (${siteId}::text IS NULL OR e.site_id = ${siteId})`;
    const [counted] = (await tx.execute(sql`SELECT count(*)::int AS n FROM (${after}) a`)) as unknown as Row[];
    await tx.execute(sql`
      UPDATE lumibase_event_consumers
         SET cursor_txid = ${txid}::xid8, cursor_seq = ${seq}::bigint, consecutive_failures = 0, updated_at = now()
       WHERE name = ${consumer}`);
    await tx.execute(sql`DELETE FROM lumibase_event_consumer_processed WHERE consumer = ${consumer} AND event_id IN (${after})`);
    await tx.execute(sql`
      DELETE FROM lumibase_event_consumer_failures
       WHERE consumer = ${consumer} AND state IN ('retrying', 'dead') AND event_id IN (${after})`);
    return { ok: true, replayFrom: { eventId: String(first.id), occurredAt: iso(first.occurred_at) }, events: Number(counted?.n ?? 0) } as const;
  });
}
