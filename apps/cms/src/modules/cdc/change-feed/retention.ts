// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
/**
 * Change Feed retention (Req 6.1, 6.3, 6.4).
 *
 * Prunes outbox events and delivery logs older than the site's retention
 * window (`cdc_feed.retentionDays`, default 30, clamp [1, 90]) — idempotent,
 * safe to run on every sweep tick. An event goes only once every registered
 * consumer has confirmed it (HeoPress P04): a stopped consumer keeps its
 * backlog however old. A subscription flips to `stale` only when events
 * after its checkpoint were in fact deleted — one that was not registered —
 * never because its checkpoint is old (Codex review P04-3 #8); with a
 * notification exactly once per transition. Storage sits behind a port so
 * P10 runs in-memory (the dispatcher convention).
 */

import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { compareKeyset } from './subscription-state';
import { lockSiteFeed } from './feed-lock';
import {
  cdcChangeEvents,
  cdcDeliveries,
  cdcSubscriptions,
  settings,
  type Database,
} from '@heopress/database';
import { CdcFeedSettingsSchema, type CdcCursor } from '@heopress/contracts/schemas';

/** Spec content/change-events "事件保留" (HeoPress P04): 30 days by default. */
export const DEFAULT_RETENTION_DAYS = 30;

export interface StaleSubscriptionNotice {
  siteId: string;
  subscriptionId: string;
  name: string;
}

export interface RetentionResult {
  prunedEvents: number;
  prunedDeliveries: number;
  staleSubscriptions: string[];
}

export interface RetentionStore {
  /** active/paused subscriptions that lost events: something after their checkpoint was deleted. */
  listLagging(siteId: string): Promise<Array<{ id: string; name: string }>>;
  markStale(siteId: string, ids: string[], now: Date): Promise<void>;
  pruneEvents(siteId: string, cutoff: Date): Promise<number>;
  pruneDeliveries(siteId: string, cutoff: Date): Promise<number>;
}

export interface RetentionDeps {
  store: RetentionStore;
  retentionDays: number;
  now?: () => Date;
  notifyStale?: (notice: StaleSubscriptionNotice) => Promise<void> | void;
}

export async function readRetentionDays(db: Database, siteId: string): Promise<number> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(and(eq(settings.siteId, siteId), eq(settings.key, 'cdc_feed')))
    .limit(1);
  const parsed = CdcFeedSettingsSchema.safeParse(row?.value ?? {});
  return parsed.success ? parsed.data.retentionDays : DEFAULT_RETENTION_DAYS;
}

/** Prune one site. Idempotent — a second run at the same instant is a no-op. */
export async function pruneChangeFeed(
  deps: RetentionDeps,
  siteId: string,
): Promise<RetentionResult> {
  const now = (deps.now ?? (() => new Date()))();
  const cutoff = new Date(now.getTime() - deps.retentionDays * 86_400_000);

  // 1) Prune what every registered consumer has confirmed.
  const prunedEvents = await deps.store.pruneEvents(siteId, cutoff);

  // 2) A subscription that lost events after its checkpoint (one that was
  //    not registered) flips to stale — never silently skipped (Req 6.3).
  const lagging = await deps.store.listLagging(siteId);
  const staleIds = lagging.map((s) => s.id);
  if (staleIds.length > 0) {
    await deps.store.markStale(siteId, staleIds, now);
    for (const sub of lagging) {
      const notify =
        deps.notifyStale ??
        ((notice: StaleSubscriptionNotice) => {
          // eslint-disable-next-line no-console
          console.error(JSON.stringify({ event: 'cdc_subscription_stale', ...notice }));
        });
      await notify({ siteId, subscriptionId: sub.id, name: sub.name });
    }
  }

  // 3) The delivery log past the cutoff.
  const prunedDeliveries = await deps.store.pruneDeliveries(siteId, cutoff);

  return { prunedEvents, prunedDeliveries, staleSubscriptions: staleIds };
}

// ── In-memory store (P10) ────────────────────────────────────────────────

export interface InMemoryRetentionSubscription {
  id: string;
  siteId: string;
  name: string;
  status: 'active' | 'paused' | 'dead' | 'stale';
  cursor: CdcCursor | null;
  /** In the consumer registry (default true): its unconfirmed events are kept. */
  registered?: boolean;
}

export class InMemoryRetentionStore implements RetentionStore {
  constructor(
    public subs: InMemoryRetentionSubscription[],
    public events: Array<{ id: string; siteId: string; occurredAt: Date }>,
    public deliveries: Array<{ id: string; siteId: string; createdAt: Date }> = [],
  ) {}

  /** Every event pruned so far, as cursors. */
  public pruned: CdcCursor[] = [];

  async listLagging(siteId: string) {
    return this.subs
      .filter(
        (s) =>
          s.siteId === siteId &&
          (s.status === 'active' || s.status === 'paused') &&
          this.pruned.some((p) => s.cursor === null || compareKeyset(p, s.cursor) > 0),
      )
      .map((s) => ({ id: s.id, name: s.name }));
  }
  async markStale(siteId: string, ids: string[]): Promise<void> {
    for (const s of this.subs) {
      if (s.siteId === siteId && ids.includes(s.id)) s.status = 'stale';
    }
  }
  async pruneEvents(siteId: string, cutoff: Date): Promise<number> {
    const before = this.events.length;
    // Registered = every subscription that is not dead (stale ones too).
    const registered = this.subs.filter((s) => s.siteId === siteId && s.status !== 'dead' && s.registered !== false);
    const confirmedByAll = (e: { id: string; occurredAt: Date }) =>
      registered.every((s) => s.cursor !== null && compareKeyset({ occurredAtMs: e.occurredAt.getTime(), eventId: e.id }, s.cursor) <= 0);
    const prunable = (e: { id: string; siteId: string; occurredAt: Date }) =>
      e.siteId === siteId && e.occurredAt.getTime() < cutoff.getTime() && confirmedByAll(e);
    for (const e of this.events) if (prunable(e)) this.pruned.push({ occurredAtMs: e.occurredAt.getTime(), eventId: e.id });
    this.events = this.events.filter((e) => !prunable(e));
    return before - this.events.length;
  }
  async pruneDeliveries(siteId: string, cutoff: Date): Promise<number> {
    const before = this.deliveries.length;
    this.deliveries = this.deliveries.filter(
      (d) => !(d.siteId === siteId && d.createdAt.getTime() < cutoff.getTime()),
    );
    return before - this.deliveries.length;
  }
}

// ── Drizzle store (production) ───────────────────────────────────────────

export class DrizzleRetentionStore implements RetentionStore {
  constructor(private readonly db: Database) {}

  async listLagging(siteId: string) {
    // Lost events: the site's prune mark lies after the subscription's
    // registered position (a null position — from the start — keeps everything).
    return (await this.db.execute(sql`
      SELECT s.id, s.name
        FROM lumibase_cdc_subscriptions s
        JOIN lumibase_cdc_prune_marks m ON m.site_id = s.site_id
        LEFT JOIN lumibase_event_consumers c ON c.name = 'cdc-subscription:' || s.id
       WHERE s.site_id = ${siteId} AND s.status IN ('active', 'paused')
         AND (c.name IS NULL OR (c.cursor_txid IS NOT NULL AND (m.txid, m.seq) > (c.cursor_txid, c.cursor_seq)))`)) as unknown as Array<{
      id: string;
      name: string;
    }>;
  }
  async markStale(siteId: string, ids: string[], now: Date): Promise<void> {
    await this.db
      .update(cdcSubscriptions)
      .set({ status: 'stale', updatedAt: now })
      .where(and(eq(cdcSubscriptions.siteId, siteId), inArray(cdcSubscriptions.id, ids)));
  }
  /**
   * Delete events older than the cutoff **that every registered consumer has
   * confirmed** (HeoPress P04, spec content/change-events "事件保留"): a
   * consumer that has stopped — even for longer than the retention period —
   * keeps the events it has not reached. Registered consumers are the rows of
   * `lumibase_event_consumers` (search sync and later consumers) and every
   * subscription that is not dead; events a consumer is still retrying or
   * waiting on a person for are kept too.
   */
  async pruneEvents(siteId: string, cutoff: Date): Promise<number> {
    // One transaction: the registry the DELETE checks is the one just made whole.
    return this.db.transaction(async (tx) => this.pruneEventsIn(tx as unknown as Database, siteId, cutoff));
  }

  private async pruneEventsIn(db: Database, siteId: string, cutoff: Date): Promise<number> {
    // No replay of this site may rewind while its floor moves (Codex review P04-3 #2).
    await lockSiteFeed(db, siteId);
    // Subscriptions are consumers: make sure each has its registry row.
    await db.execute(sql`
      INSERT INTO lumibase_event_consumers (name, site_id, cursor_txid, cursor_seq)
      SELECT 'cdc-subscription:' || s.id, s.site_id, e.txid, e.seq
        FROM lumibase_cdc_subscriptions s
        LEFT JOIN lumibase_cdc_change_events e ON e.site_id = s.site_id AND e.id = s.cursor_id
       WHERE s.site_id = ${siteId} AND s.status <> 'dead'
      ON CONFLICT (name) DO NOTHING`);
    // A dead or deleted subscription no longer holds events back.
    await db.execute(sql`
      UPDATE lumibase_event_consumers c SET status = 'dead', updated_at = now()
       WHERE c.site_id = ${siteId} AND c.name LIKE 'cdc-subscription:%' AND c.status <> 'dead'
         AND NOT EXISTS (SELECT 1 FROM lumibase_cdc_subscriptions s
                          WHERE 'cdc-subscription:' || s.id = c.name AND s.status <> 'dead')`);
    const rows = (await db.execute(sql`
      DELETE FROM lumibase_cdc_change_events e
       WHERE e.site_id = ${siteId}
         AND e.occurred_at < ${cutoff.toISOString()}::timestamptz
         AND NOT EXISTS (
           SELECT 1 FROM lumibase_event_consumers c
            WHERE c.status <> 'dead'
              AND (c.site_id IS NULL OR c.site_id = e.site_id)
              AND (c.cursor_txid IS NULL OR (e.txid, e.seq) > (c.cursor_txid, c.cursor_seq)))
         AND NOT EXISTS (
           SELECT 1 FROM lumibase_event_consumer_failures f
            WHERE f.event_id = e.id AND f.state IN ('retrying', 'unknown'))
      RETURNING e.id, e.txid::text AS txid, e.seq, e.occurred_at`)) as unknown as Array<{
      id: string;
      txid: string;
      seq: number;
      occurred_at: string | Date;
    }>;
    // The prune mark: cursors before the highest deleted position are expired,
    // and so is a replay from a time at or before the latest deleted event.
    let mark: { txid: string; seq: number } | null = null;
    let deletedUntil: Date | null = null;
    for (const r of rows) {
      if (!mark || BigInt(r.txid) > BigInt(mark.txid) || (BigInt(r.txid) === BigInt(mark.txid) && Number(r.seq) > mark.seq)) {
        mark = { txid: r.txid, seq: Number(r.seq) };
      }
      const at = new Date(r.occurred_at);
      if (!deletedUntil || at > deletedUntil) deletedUntil = at;
    }
    if (mark) {
      await db.execute(sql`
        INSERT INTO lumibase_cdc_prune_marks (site_id, txid, seq, deleted_until)
        VALUES (${siteId}, ${mark.txid}::xid8, ${mark.seq}::bigint, ${deletedUntil!.toISOString()}::timestamptz)
        ON CONFLICT (site_id) DO UPDATE
           SET txid = GREATEST(lumibase_cdc_prune_marks.txid, EXCLUDED.txid),
               seq = CASE WHEN (EXCLUDED.txid, EXCLUDED.seq) > (lumibase_cdc_prune_marks.txid, lumibase_cdc_prune_marks.seq)
                          THEN EXCLUDED.seq ELSE lumibase_cdc_prune_marks.seq END,
               deleted_until = GREATEST(lumibase_cdc_prune_marks.deleted_until, EXCLUDED.deleted_until),
               updated_at = now()`);
    }
    // Idempotency keys stand for their write for a day (P04, task 9.2).
    await db.execute(sql`
      DELETE FROM lumibase_item_idempotency_keys
       WHERE site_id = ${siteId} AND created_at < now() - interval '1 day'`);
    // Records of handled events (and dead letters) that old are no longer needed.
    await db.execute(sql`
      DELETE FROM lumibase_event_consumer_processed p
       WHERE p.processed_at < ${cutoff.toISOString()}::timestamptz
         AND NOT EXISTS (SELECT 1 FROM lumibase_cdc_change_events e WHERE e.id = p.event_id)`);
    return rows.length;
  }
  async pruneDeliveries(siteId: string, cutoff: Date): Promise<number> {
    const rows = await this.db
      .delete(cdcDeliveries)
      .where(and(eq(cdcDeliveries.siteId, siteId), lt(cdcDeliveries.createdAt, cutoff)))
      .returning({ id: cdcDeliveries.id });
    return rows.length;
  }
}
