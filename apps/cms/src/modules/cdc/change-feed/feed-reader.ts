// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
/**
 * Change Feed reader — keyset pagination over the outbox (Req 2.1–2.5).
 *
 * Paging semantics live HERE, against a small `CdcEventStore` port, so the
 * gap-free/filter properties (P2, P8) are testable on the in-memory store
 * (repo `InMemory*` convention) while production reads go through Drizzle
 * with an equivalent SQL keyset predicate.
 *
 * Two ordering rules from the design apply to every read path:
 * - order/compare by the composite keyset `(occurred_at, id)` (§3.1);
 * - a **safety lag** (default 2s, §6): never read past `now - lag`, so a
 *   long transaction holding an earlier `now()` cannot be overtaken and
 *   then skipped.
 */

import { and, asc, count, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { cdcChangeEvents, type Database } from '@heopress/database';
import {
  encodeCdcCursor,
  type CdcCursor,
  type CdcOperation,
} from '@heopress/contracts/schemas';
import { compareKeyset } from './subscription-state';

export const SAFETY_LAG_MS = 2_000;

export interface StoredChangeEvent {
  id: string;
  siteId: string;
  /** Resource kind — defaults to 'item' for rows written before this column. */
  resource?: string;
  collection: string;
  itemId: string;
  operation: CdcOperation;
  payload: Record<string, unknown> | null;
  changedFields: string[] | null;
  schemaVersion: number;
  actorType: string;
  actorId: string | null;
  source: string;
  occurredAt: Date;
  /** Position (production store): writing transaction id and sequence number. */
  txid?: string;
  seq?: number;
}

export interface FeedFilters {
  collections?: string[];
  operations?: CdcOperation[];
}

/** Read port over the outbox — Drizzle in production, in-memory in tests. */
export interface CdcEventStore {
  /**
   * Events strictly after `after` (exclusive keyset), matching the filters,
   * with `occurredAt < notAfter`, ordered by `(occurredAt, id)` asc, at most
   * `limit` rows.
   */
  listAfter(
    siteId: string,
    after: CdcCursor | null,
    filters: FeedFilters,
    limit: number,
    notAfter: Date,
  ): Promise<StoredChangeEvent[]>;
  /** Earliest event still retained for the site (any filter), or null. */
  earliest(siteId: string): Promise<StoredChangeEvent | null>;
  /** Latest event for the site, or null — the feed head (lag denominator). */
  latest(siteId: string): Promise<StoredChangeEvent | null>;
  /** Number of events strictly after `after` (null = everything). Drives Req 3.5 lag. */
  countAfter(siteId: string, after: CdcCursor | null): Promise<number>;
  /**
   * Whether events after `cursor` may already have been deleted (410). The
   * in-memory store uses the time floor; the production store the prune mark
   * (HeoPress P04): a consumer whose events were kept can always continue.
   */
  isExpired(siteId: string, cursor: CdcCursor, floorMs: number): Promise<boolean>;
}

export function eventKeyset(event: Pick<StoredChangeEvent, 'id' | 'occurredAt' | 'txid' | 'seq'>): CdcCursor {
  const cursor: CdcCursor = { occurredAtMs: event.occurredAt.getTime(), eventId: event.id };
  if (event.txid !== undefined && event.seq !== undefined) cursor.position = { txid: String(event.txid), seq: Number(event.seq) };
  return cursor;
}

export class InMemoryCdcEventStore implements CdcEventStore {
  constructor(private readonly events: StoredChangeEvent[] = []) {}

  async isExpired(_siteId: string, cursor: CdcCursor, floorMs: number): Promise<boolean> {
    return cursor.occurredAtMs < floorMs;
  }

  add(event: StoredChangeEvent): void {
    this.events.push(event);
  }

  async listAfter(
    siteId: string,
    after: CdcCursor | null,
    filters: FeedFilters,
    limit: number,
    notAfter: Date,
  ): Promise<StoredChangeEvent[]> {
    return this.events
      .filter((e) => e.siteId === siteId)
      .filter((e) => e.occurredAt.getTime() < notAfter.getTime())
      .filter((e) => (after ? compareKeyset(eventKeyset(e), after) > 0 : true))
      .filter((e) =>
        filters.collections?.length ? filters.collections.includes(e.collection) : true,
      )
      .filter((e) =>
        filters.operations?.length ? filters.operations.includes(e.operation) : true,
      )
      .sort((a, b) => compareKeyset(eventKeyset(a), eventKeyset(b)))
      .slice(0, limit);
  }

  async earliest(siteId: string): Promise<StoredChangeEvent | null> {
    const site = this.events
      .filter((e) => e.siteId === siteId)
      .sort((a, b) => compareKeyset(eventKeyset(a), eventKeyset(b)));
    return site[0] ?? null;
  }

  async latest(siteId: string): Promise<StoredChangeEvent | null> {
    const site = this.events
      .filter((e) => e.siteId === siteId)
      .sort((a, b) => compareKeyset(eventKeyset(a), eventKeyset(b)));
    return site[site.length - 1] ?? null;
  }

  async countAfter(siteId: string, after: CdcCursor | null): Promise<number> {
    return this.events
      .filter((e) => e.siteId === siteId)
      .filter((e) => (after ? compareKeyset(eventKeyset(e), after) > 0 : true)).length;
  }
}

/**
 * Production store (HeoPress P04, spec content/change-events "晚提交事件不被跳过").
 *
 * Events are ordered by their position — the writing transaction's id and a
 * sequence number (`txid`, `seq`) — and only events of transactions older
 * than every one still running are read (`txid < xmin`). A transaction that
 * commits late therefore appears late, behind the cursor's position, instead
 * of behind a fixed time window it may already have fallen out of. The
 * `notAfter` safety lag of the in-memory store is not needed here.
 *
 * Cursors keep their token format: the event id in a cursor is resolved to
 * that event's position. A cursor whose event is gone (or a replay point with
 * no event id) resolves to the last event at or before its time.
 */
export class DrizzleCdcEventStore implements CdcEventStore {
  constructor(private readonly db: Database) {}

  private positionOf(siteId: string, after: CdcCursor | null): Promise<{ txid: string; seq: number } | null> {
    return eventPosition(this.db, siteId, after);
  }

  async isExpired(siteId: string, cursor: CdcCursor, _floorMs: number): Promise<boolean> {
    if (!cursor.position && !cursor.eventId) {
      // A point in time (replay "from T"): complete only if nothing that
      // happened at or after T was deleted (Codex review P04-3 #6).
      const rows = (await this.db.execute(sql`
        SELECT 1 FROM lumibase_cdc_prune_marks
         WHERE site_id = ${siteId} AND deleted_until >= ${new Date(cursor.occurredAtMs).toISOString()}::timestamptz`)) as unknown as unknown[];
      return rows.length > 0;
    }
    if (!cursor.position && cursor.eventId) {
      // A cursor without a position whose event was pruned: what followed it
      // may be gone too, and its time cannot say which — treat it as expired.
      const [kept] = (await this.db.execute(sql`
        SELECT 1 FROM lumibase_cdc_change_events WHERE site_id = ${siteId} AND id = ${cursor.eventId}`)) as unknown as unknown[];
      if (!kept && (await this.hasPruneMark(siteId))) return true;
    }
    const pos = await this.positionOf(siteId, cursor);
    if (!pos) return false;
    const rows = (await this.db.execute(sql`
      SELECT 1 FROM lumibase_cdc_prune_marks
       WHERE site_id = ${siteId} AND (txid, seq) > (${pos.txid}::xid8, ${pos.seq}::bigint)`)) as unknown as unknown[];
    return rows.length > 0;
  }

  private async hasPruneMark(siteId: string): Promise<boolean> {
    const rows = (await this.db.execute(sql`
      SELECT 1 FROM lumibase_cdc_prune_marks WHERE site_id = ${siteId}`)) as unknown as unknown[];
    return rows.length > 0;
  }

  async listAfter(
    siteId: string,
    after: CdcCursor | null,
    filters: FeedFilters,
    limit: number,
    _notAfter: Date,
  ): Promise<StoredChangeEvent[]> {
    const pos = await this.positionOf(siteId, after);
    const conditions: (SQL | undefined)[] = [
      eq(cdcChangeEvents.siteId, siteId),
      // Never past a transaction that may still commit.
      sql`${cdcChangeEvents.txid} < pg_snapshot_xmin(pg_current_snapshot())`,
      pos ? sql`(${cdcChangeEvents.txid}, ${cdcChangeEvents.seq}) > (${pos.txid}::xid8, ${pos.seq}::bigint)` : undefined,
    ];
    if (filters.collections?.length) {
      conditions.push(inArray(cdcChangeEvents.collection, filters.collections));
    }
    if (filters.operations?.length) {
      conditions.push(inArray(cdcChangeEvents.operation, filters.operations));
    }
    const rows = await this.db
      .select()
      .from(cdcChangeEvents)
      .where(and(...conditions))
      .orderBy(asc(cdcChangeEvents.txid), asc(cdcChangeEvents.seq))
      .limit(limit);
    return rows as unknown as StoredChangeEvent[];
  }

  async earliest(siteId: string): Promise<StoredChangeEvent | null> {
    const [row] = await this.db
      .select()
      .from(cdcChangeEvents)
      .where(eq(cdcChangeEvents.siteId, siteId))
      .orderBy(asc(cdcChangeEvents.txid), asc(cdcChangeEvents.seq))
      .limit(1);
    return (row as unknown as StoredChangeEvent) ?? null;
  }

  async latest(siteId: string): Promise<StoredChangeEvent | null> {
    const [row] = await this.db
      .select()
      .from(cdcChangeEvents)
      .where(and(eq(cdcChangeEvents.siteId, siteId), sql`${cdcChangeEvents.txid} < pg_snapshot_xmin(pg_current_snapshot())`))
      .orderBy(desc(cdcChangeEvents.txid), desc(cdcChangeEvents.seq))
      .limit(1);
    return (row as unknown as StoredChangeEvent) ?? null;
  }

  async countAfter(siteId: string, after: CdcCursor | null): Promise<number> {
    const pos = await this.positionOf(siteId, after);
    const [row] = await this.db
      .select({ n: count() })
      .from(cdcChangeEvents)
      .where(
        and(
          eq(cdcChangeEvents.siteId, siteId),
          pos ? sql`(${cdcChangeEvents.txid}, ${cdcChangeEvents.seq}) > (${pos.txid}::xid8, ${pos.seq}::bigint)` : undefined,
        ),
      );
    return Number(row?.n ?? 0);
  }
}

/**
 * The position a cursor stands at (HeoPress P04): the position of the event it
 * names, or of the last event at or before its time when that event is gone
 * (or the cursor is a replay point without an event); `{0, 0}` before every
 * event; null for no cursor ("from the start").
 */
export async function eventPosition(
  db: Database,
  siteId: string,
  after: CdcCursor | null,
): Promise<{ txid: string; seq: number } | null> {
  if (!after) return null;
  if (after.position) return after.position;
  // A cursor from before positions existed: its event, when still there.
  const byId = after.eventId
    ? ((await db.execute(sql`
        SELECT txid::text AS txid, seq FROM lumibase_cdc_change_events
         WHERE site_id = ${siteId} AND id = ${after.eventId}`)) as unknown as Array<{ txid: string; seq: number }>)
    : [];
  if (byId[0]) return { txid: byId[0].txid, seq: Number(byId[0].seq) };
  return positionBefore(db, siteId, after.occurredAtMs);
}

/**
 * A point in time as a position (replay "from time T", or a legacy cursor
 * whose event is gone): just before the **earliest position** of any event
 * at or after T. Times and positions need not agree — a transaction can
 * start before another and write after it — so taking "the last event before
 * T" could skip an event of T or later (Codex review P04-2 #5). This way
 * nothing at or after T is skipped; a few events before T may be read again.
 */
async function positionBefore(db: Database, siteId: string, occurredAtMs: number): Promise<{ txid: string; seq: number }> {
  const [first] = (await db.execute(sql`
    SELECT txid::text AS txid, seq FROM lumibase_cdc_change_events
     WHERE site_id = ${siteId} AND occurred_at >= ${new Date(occurredAtMs).toISOString()}::timestamptz
     -- The xid8 column, not the text alias (Codex P04-3 #1).
     ORDER BY lumibase_cdc_change_events.txid, lumibase_cdc_change_events.seq
     LIMIT 1`)) as unknown as Array<{ txid: string; seq: number }>;
  if (first) return { txid: first.txid, seq: Number(first.seq) - 1 };
  // Nothing that late: the current end of the site's events.
  const [last] = (await db.execute(sql`
    SELECT txid::text AS txid, seq FROM lumibase_cdc_change_events
     WHERE site_id = ${siteId}
     ORDER BY lumibase_cdc_change_events.txid DESC, lumibase_cdc_change_events.seq DESC LIMIT 1`)) as unknown as Array<{ txid: string; seq: number }>;
  return last ? { txid: last.txid, seq: Number(last.seq) } : { txid: '0', seq: 0 };
}

/** Thrown when the caller's cursor predates the retention floor (Req 2.5 → 410). */
export class CursorExpiredError extends Error {
  constructor(public readonly earliestCursor: string | null) {
    super('Cursor predates the retention floor');
    this.name = 'CursorExpiredError';
  }
}

export interface FeedPage {
  events: StoredChangeEvent[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface FeedReaderDeps {
  store: CdcEventStore;
  siteId: string;
  /** Retention window used for the 410 floor check (Req 2.5). */
  retentionDays: number;
  now?: () => Date;
  safetyLagMs?: number;
}

export class FeedReader {
  constructor(private readonly deps: FeedReaderDeps) {}

  async read(
    cursor: CdcCursor | null,
    filters: FeedFilters,
    limit: number,
  ): Promise<FeedPage> {
    const now = (this.deps.now ?? (() => new Date()))();
    const floorMs = now.getTime() - this.deps.retentionDays * 86_400_000;
    const expired = async () => {
      const earliest = await this.deps.store.earliest(this.deps.siteId);
      return new CursorExpiredError(earliest ? encodeCdcCursor(eventKeyset(earliest)) : null);
    };
    if (cursor && (await this.deps.store.isExpired(this.deps.siteId, cursor, floorMs))) throw await expired();

    const notAfter = new Date(now.getTime() - (this.deps.safetyLagMs ?? SAFETY_LAG_MS));
    // Over-fetch by one to compute hasMore without a second query.
    const rows = await this.deps.store.listAfter(
      this.deps.siteId,
      cursor,
      filters,
      limit + 1,
      notAfter,
    );
    // A prune between the check above and the read could have deleted the
    // next events, and the page would skip them unnoticed: check again
    // (Codex review P04-3 #7). Events read before a prune are a complete page.
    if (cursor && (await this.deps.store.isExpired(this.deps.siteId, cursor, floorMs))) throw await expired();
    const events = rows.slice(0, limit);
    const last = events[events.length - 1];
    return {
      events,
      nextCursor: last ? encodeCdcCursor(eventKeyset(last)) : null,
      hasMore: rows.length > limit,
    };
  }
}
