/**
 * The event consumption framework (HeoPress P04, spec platform/event-consumption,
 * ADR-0011).
 *
 * Every downstream reaction to content changes — webhook delivery, search
 * sync, and later cache invalidation, translation freshness, IndexNow — is a
 * consumer: a name, an optional site scope and a handler. The runner gives
 * each consumer:
 *
 *   - its own position in the change events, read in commit order and never
 *     past a transaction that may still commit (`txid < xmin`, see
 *     `cdcChangeEvents.txid`), so late commits are read late, not skipped;
 *   - at-least-once delivery with an idempotency record: an event is marked
 *     handled in the same statement that moves the position past it, a
 *     re-delivered handled event is skipped, and handlers get a stable
 *     idempotency key (`<consumer>:<event id>`) for their own side effects;
 *   - order: a failing event (or batch) is retried in place with
 *     exponential backoff, so later events wait behind it; after the attempt
 *     limit it goes to the consumer's dead letter and the consumer moves on —
 *     a dead event never blocks the events after it;
 *   - a third outcome for side effects that cannot be confirmed
 *     (`UnknownOutcomeError`): the consumer stops at that event and waits
 *     for a person (`resolveUnknown`: it happened → move on; it did not →
 *     retry);
 *   - a lease, so one runner at a time handles a consumer, without holding a
 *     transaction open while handlers run.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Database } from '@heopress/database';

export interface ChangeEvent {
  id: string;
  siteId: string;
  resource: string;
  collection: string;
  itemId: string;
  operation: 'create' | 'update' | 'delete';
  payload: Record<string, unknown> | null;
  changedFields: string[] | null;
  itemVersion: number | null;
  actorType: string;
  actorId: string | null;
  source: string;
  occurredAt: Date;
  /** Position: transaction id (as text) and sequence number. */
  txid: string;
  seq: number;
}

interface HandleContext {
  /** Stable per consumer and event: use it to deduplicate external side effects. */
  idempotencyKey: string;
  /** 1 on first delivery, then counts retries. */
  attempt: number;
  /** Aborted when this run lost the consumer's lease (another runner took over). */
  signal?: AbortSignal;
}

/**
 * Thrown by a handler when a side effect may or may not have happened (a
 * request was sent but no answer came back). The event is parked as
 * `unknown`: never retried automatically, resolved by a person.
 */
export class UnknownOutcomeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnknownOutcomeError';
  }
}

export interface EventConsumerDefinition {
  /** Unique, stable: the position and the records hang off it. */
  name: string;
  /** Only this site's events; omitted/null reads every site. */
  siteId?: string | null;
  /** Where a consumer seen for the first time starts: only events from now on (default), or all retained events. */
  startFrom?: 'head' | 'start';
  /** Events the consumer does not care about are passed over without a record. */
  accepts?: (event: ChangeEvent) => boolean;
  batchSize?: number;
  /** Attempts before an event is dead-lettered (default 5). */
  maxAttempts?: number;
  /** First retry delay; doubles per attempt (default 30 s). */
  retryBaseMs?: number;
  /** Pause the consumer after this many failures in a row (default: never). */
  pauseAfterConsecutiveFailures?: number;
  /** Handle one event. Either this or `handleBatch`. */
  handle?(event: ChangeEvent, ctx: HandleContext): Promise<void>;
  /**
   * Handle a batch at once (webhook delivery). All or nothing: a failure
   * retries the whole batch; past the limit all of it is dead-lettered.
   */
  handleBatch?(events: ChangeEvent[], ctx: { attempt: number; idempotencyKeys: string[]; signal?: AbortSignal }): Promise<void>;
  /** Told when the consumer pauses itself (after repeated failures). */
  onPaused?(reason: string): Promise<void> | void;
}

export interface RunResult {
  /** Lease held by another runner: nothing done. */
  skipped: boolean;
  handled: number;
  failed: number;
  retried: number;
  dead: number;
  unknown: number;
  paused: boolean;
}

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_RETRY_BASE_MS = 30_000;
const LEASE_SECONDS = 120;

function retryDelayMs(attempt: number, baseMs = DEFAULT_RETRY_BASE_MS): number {
  return baseMs * 2 ** Math.max(0, attempt - 1);
}

type Row = Record<string, unknown>;

function toEvent(r: Row): ChangeEvent {
  return {
    id: String(r.id),
    siteId: String(r.site_id),
    resource: String(r.resource),
    collection: String(r.collection),
    itemId: String(r.item_id),
    operation: r.operation as ChangeEvent['operation'],
    payload: (r.payload as Record<string, unknown> | null) ?? null,
    changedFields: (r.changed_fields as string[] | null) ?? null,
    itemVersion: r.item_version == null ? null : Number(r.item_version),
    actorType: String(r.actor_type),
    actorId: (r.actor_id as string | null) ?? null,
    source: String(r.source),
    occurredAt: r.occurred_at instanceof Date ? r.occurred_at : new Date(String(r.occurred_at)),
    txid: String(r.txid),
    seq: Number(r.seq),
  };
}

const COLUMN_LIST = `id, site_id, resource, collection, item_id, operation, payload, changed_fields, item_version,
   actor_type, actor_id, source, occurred_at, txid::text AS txid, seq`;
const EVENT_COLUMNS = sql.raw(COLUMN_LIST);
/** The same columns qualified with the events alias `e`. */
const E_COLUMNS = sql.raw(
  COLUMN_LIST.split(',')
    .map((c) => `e.${c.trim()}`)
    .join(', '),
);

export class EventConsumerRunner {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Create the consumer's row on first sight. */
  async register(def: EventConsumerDefinition): Promise<void> {
    if ((def.startFrom ?? 'head') === 'start') {
      await this.db.execute(sql`
        INSERT INTO lumibase_event_consumers (name, site_id) VALUES (${def.name}, ${def.siteId ?? null})
        ON CONFLICT (name) DO NOTHING`);
      return;
    }
    // From the head: the last event every reader may already see.
    await this.db.execute(sql`
      INSERT INTO lumibase_event_consumers (name, site_id, cursor_txid, cursor_seq)
      SELECT ${def.name}, ${def.siteId ?? null}, h.txid, h.seq
        FROM (SELECT NULL) AS one
        LEFT JOIN LATERAL (
          SELECT txid, seq FROM lumibase_cdc_change_events
           WHERE txid < pg_snapshot_xmin(pg_current_snapshot())
             AND (${def.siteId ?? null}::text IS NULL OR site_id = ${def.siteId ?? null})
           ORDER BY txid DESC, seq DESC LIMIT 1
        ) h ON true
      ON CONFLICT (name) DO NOTHING`);
  }

  /** Run one pass for a consumer. Never throws for a handler's failure. */
  async runOnce(def: EventConsumerDefinition): Promise<RunResult> {
    await this.register(def);
    const result: RunResult = { skipped: false, handled: 0, failed: 0, retried: 0, dead: 0, unknown: 0, paused: false };
    const lease = await this.acquire(def.name);
    if (!lease) return { ...result, skipped: true };
    try {
      for (let round = 0; round < 1000; round++) {
        if (lease.lost) return result;
        const [state] = (await this.db.execute(sql`
          SELECT status, cursor_txid::text AS cursor_txid, cursor_seq, consecutive_failures
            FROM lumibase_event_consumers WHERE name = ${def.name} AND lease_token = ${lease.token}`)) as unknown as Row[];
        if (!state) return result; // lease lost
        if (state.status !== 'active') return { ...result, paused: true };

        const all = await this.readAfter(def, state.cursor_txid as string | null, state.cursor_seq as number | null);
        if (all.length === 0) return result;

        // Pass over what the consumer does not want or has already handled.
        const batch: ChangeEvent[] = [];
        for (const event of all) {
          if ((def.accepts && !def.accepts(event)) || (await this.alreadyHandled(def.name, event.id))) {
            if (batch.length === 0) {
              await this.advance(def.name, lease.token, event, null);
              continue;
            }
            break;
          }
          batch.push(event);
          if (!def.handleBatch) break; // one at a time
        }
        if (batch.length === 0) continue;

        // A failure recorded for the head event decides whether it is due.
        const head = batch[0]!;
        const [failure] = (await this.db.execute(sql`
          SELECT state, attempts, next_attempt_at FROM lumibase_event_consumer_failures
           WHERE consumer = ${def.name} AND event_id = ${head.id}`)) as unknown as Row[];
        if (failure?.state === 'unknown') return { ...result, paused: true };
        if (failure?.state === 'dead') {
          // Already dead-lettered (an older runner stopped after recording it).
          await this.advance(def.name, lease.token, head, null);
          continue;
        }
        if (failure && new Date(String(failure.next_attempt_at)) > this.now()) return result;
        const attempt = failure ? Number(failure.attempts) + 1 : 1;

        try {
          if (def.handleBatch) {
            await def.handleBatch(batch, { attempt, idempotencyKeys: batch.map((e) => `${def.name}:${e.id}`), signal: lease.signal });
          } else {
            await def.handle!(head, { idempotencyKey: `${def.name}:${head.id}`, attempt, signal: lease.signal });
          }
          // Another runner took over meanwhile: it owns the outcome now.
          for (const event of batch) await this.advance(def.name, lease.token, event, 'handled');
          result.handled += batch.length;
          if (failure) result.retried += batch.length;
          await this.setConsecutive(def.name, lease.token, 0);
        } catch (err) {
          if (err instanceof LeaseLost) return result;
          const unknown = err instanceof UnknownOutcomeError;
          const maxAttempts = def.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
          const dead = !unknown && attempt >= maxAttempts;
          const stateName = unknown ? 'unknown' : dead ? 'dead' : 'retrying';
          const next = new Date(this.now().getTime() + retryDelayMs(attempt, def.retryBaseMs));
          for (const event of batch) {
            // A dead letter and the move past it are one statement.
            await this.recordFailure(def.name, lease.token, event, stateName, attempt, next, errorText(err), dead);
          }
          if (dead) result.dead += batch.length;
          else if (unknown) result.unknown += batch.length;
          else result.failed += batch.length;
          const consecutive = Number(state.consecutive_failures ?? 0) + 1;
          await this.setConsecutive(def.name, lease.token, consecutive);
          if (def.pauseAfterConsecutiveFailures && consecutive >= def.pauseAfterConsecutiveFailures) {
            const reason = `paused after ${consecutive} failures in a row: ${errorText(err)}`;
            await this.pause(def.name, reason, lease.token);
            await def.onPaused?.(reason);
            return { ...result, paused: true };
          }
          if (!dead) return { ...result, paused: unknown };
        }
      }
      return result;
    } catch (err) {
      if (err instanceof LeaseLost) return result;
      throw err;
    } finally {
      await this.release(def.name, lease);
    }
  }

  /** Events after the position that every reader may see, in position order. */
  private async readAfter(def: EventConsumerDefinition, txid: string | null, seq: number | null): Promise<ChangeEvent[]> {
    const rows = (await this.db.execute(sql`
      SELECT ${EVENT_COLUMNS}
        FROM lumibase_cdc_change_events
       WHERE txid < pg_snapshot_xmin(pg_current_snapshot())
         AND (${txid}::text IS NULL OR (txid, seq) > (${txid}::xid8, ${seq}::bigint))
         AND (${def.siteId ?? null}::text IS NULL OR site_id = ${def.siteId ?? null})
       -- The column, not the text alias of the select list: '10' < '9' as text (Codex P04-3 #1).
       ORDER BY lumibase_cdc_change_events.txid, lumibase_cdc_change_events.seq
       LIMIT ${def.batchSize ?? 100}`)) as unknown as Row[];
    return rows.map(toEvent);
  }

  private async alreadyHandled(consumer: string, eventId: string): Promise<boolean> {
    const rows = (await this.db.execute(sql`
      SELECT 1 FROM lumibase_event_consumer_processed WHERE consumer = ${consumer} AND event_id = ${eventId}`)) as unknown as Row[];
    return rows.length > 0;
  }

  /**
   * Move the position past `event` — only while `token` holds the lease —
   * and for `handled` record it (and clear a failure it had) in the same
   * statement. Throws LeaseLost when the lease is gone: an older runner can
   * never move the position of the one that took over.
   */
  private async advance(consumer: string, token: string, event: ChangeEvent, outcome: 'handled' | null): Promise<void> {
    const moveCursor = sql`
      UPDATE lumibase_event_consumers
         SET cursor_txid = ${event.txid}::xid8, cursor_seq = ${event.seq}::bigint, updated_at = now(),
             lease_until = now() + make_interval(secs => ${LEASE_SECONDS})
       WHERE name = ${consumer} AND lease_token = ${token}`;
    const rows = (outcome === null
      ? await this.db.execute(sql`${moveCursor} RETURNING name`)
      : await this.db.execute(sql`
          WITH moved AS (${moveCursor} RETURNING name),
               cleared AS (DELETE FROM lumibase_event_consumer_failures
                            WHERE consumer = ${consumer} AND event_id = ${event.id} AND EXISTS (SELECT 1 FROM moved)),
               recorded AS (INSERT INTO lumibase_event_consumer_processed (consumer, event_id)
                            SELECT name, ${event.id} FROM moved ON CONFLICT DO NOTHING)
          SELECT name FROM moved`)) as unknown as Row[];
    if (rows.length === 0) throw new LeaseLost();
  }

  /** Record a failure (and, for a dead letter, move past it) while holding the lease. */
  private async recordFailure(
    consumer: string,
    token: string,
    event: ChangeEvent,
    state: 'retrying' | 'dead' | 'unknown',
    attempts: number,
    next: Date,
    error: string,
    moveOn: boolean,
  ): Promise<void> {
    const rows = (await this.db.execute(sql`
      WITH owner AS (
        UPDATE lumibase_event_consumers
           SET updated_at = now(),
               cursor_txid = CASE WHEN ${moveOn} THEN ${event.txid}::xid8 ELSE cursor_txid END,
               cursor_seq = CASE WHEN ${moveOn} THEN ${event.seq}::bigint ELSE cursor_seq END
         WHERE name = ${consumer} AND lease_token = ${token}
        RETURNING name
      ),
      upsert AS (
        INSERT INTO lumibase_event_consumer_failures (consumer, event_id, state, attempts, next_attempt_at, last_error)
        SELECT name, ${event.id}, ${state}, ${attempts}, ${state === 'retrying' ? next.toISOString() : null}::timestamptz, ${error}
          FROM owner
        ON CONFLICT (consumer, event_id) DO UPDATE
           SET state = EXCLUDED.state, attempts = EXCLUDED.attempts, next_attempt_at = EXCLUDED.next_attempt_at,
               last_error = EXCLUDED.last_error, updated_at = now()
      )
      SELECT name FROM owner`)) as unknown as Row[];
    if (rows.length === 0) throw new LeaseLost();
  }

  private async setConsecutive(consumer: string, token: string, n: number): Promise<void> {
    await this.db.execute(sql`
      UPDATE lumibase_event_consumers SET consecutive_failures = ${n}, updated_at = now()
       WHERE name = ${consumer} AND lease_token = ${token}`);
  }

  /**
   * A person's decision on `unknown` events, where the consumer stopped:
   * `done` (the side effects happened — record them as handled) or `retry`
   * (they did not — try again on the next run). `eventId` null decides every
   * unknown event of the consumer (a batch). The position only moves over
   * the unbroken run of decided events right after it: an earlier event
   * still waiting for a decision is never skipped.
   */
  async resolveUnknown(consumer: string, eventId: string | null, decision: 'done' | 'retry'): Promise<boolean> {
    const lease = await this.acquire(consumer);
    if (!lease) return false; // a runner is working on it; decide again shortly
    try {
      // A `done` event is recorded as processed in the same statement: it is
      // never handled again, even while an undecided event before it keeps
      // the position where it is (Codex review P04-3 #3).
      const marked = (await this.db.execute(sql`
        WITH decided AS (
          UPDATE lumibase_event_consumer_failures
             SET state = ${decision === 'done' ? 'done' : 'retrying'},
                 next_attempt_at = ${decision === 'done' ? null : this.now().toISOString()}::timestamptz, updated_at = now()
           WHERE consumer = ${consumer} AND state = 'unknown' AND (${eventId}::text IS NULL OR event_id = ${eventId})
          RETURNING event_id
        ), processed AS (
          INSERT INTO lumibase_event_consumer_processed (consumer, event_id)
          SELECT ${consumer}, event_id FROM decided WHERE ${decision === 'done'}
          ON CONFLICT DO NOTHING
        )
        SELECT event_id FROM decided`)) as unknown as Row[];
      if (marked.length === 0) return false;
      if (decision === 'done') await this.advanceOverDecided(consumer, lease.token);
      return true;
    } finally {
      await this.release(consumer, lease);
    }
  }

  /** Move over the events right after the position that a person marked `done`. */
  private async advanceOverDecided(consumer: string, token: string): Promise<void> {
    const [state] = (await this.db.execute(sql`
      SELECT site_id, cursor_txid::text AS cursor_txid, cursor_seq FROM lumibase_event_consumers WHERE name = ${consumer}`)) as unknown as Row[];
    if (!state) return;
    for (;;) {
      const [next] = (await this.db.execute(sql`
        SELECT ${E_COLUMNS}, f.state AS failure_state
          FROM lumibase_cdc_change_events e
          LEFT JOIN lumibase_event_consumer_failures f ON f.consumer = ${consumer} AND f.event_id = e.id
         WHERE e.txid < pg_snapshot_xmin(pg_current_snapshot())
           AND (${(state.cursor_txid as string | null) ?? null}::text IS NULL OR (e.txid, e.seq) > (${(state.cursor_txid as string | null) ?? null}::xid8, ${(state.cursor_seq as number | null) ?? null}::bigint))
           AND (${(state.site_id as string | null) ?? null}::text IS NULL OR e.site_id = ${(state.site_id as string | null) ?? null})
         ORDER BY e.txid, e.seq
         LIMIT 1`)) as unknown as Row[];
      if (!next || next.failure_state !== 'done') return;
      const event = toEvent(next);
      await this.advance(consumer, token, event, 'handled');
      state.cursor_txid = event.txid;
      state.cursor_seq = event.seq;
    }
  }

  async pause(consumer: string, reason: string, token?: string): Promise<void> {
    await this.db.execute(sql`
      UPDATE lumibase_event_consumers SET status = 'paused', paused_reason = ${reason}, updated_at = now()
       WHERE name = ${consumer} AND (${token ?? null}::text IS NULL OR lease_token = ${token ?? null})`);
  }

  async resume(consumer: string): Promise<void> {
    await this.db.execute(sql`
      UPDATE lumibase_event_consumers
         SET status = 'active', paused_reason = NULL, consecutive_failures = 0, updated_at = now()
       WHERE name = ${consumer}`);
  }

  /**
   * Take the consumer's lease, and keep renewing it while the run lasts
   * (a slow handler does not lose it). When a renewal finds the lease gone
   * the run is told through `lost` and the handlers' `signal`.
   */
  private async acquire(consumer: string): Promise<Lease | null> {
    const token = randomUUID();
    const rows = (await this.db.execute(sql`
      UPDATE lumibase_event_consumers
         SET lease_token = ${token}, lease_until = now() + make_interval(secs => ${LEASE_SECONDS})
       WHERE name = ${consumer} AND (lease_until IS NULL OR lease_until < now())
      RETURNING name`)) as unknown as Row[];
    if (rows.length === 0) return null;
    const controller = new AbortController();
    const lease: Lease = { token, lost: false, signal: controller.signal, heartbeat: undefined };
    lease.heartbeat = setInterval(() => {
      void this.db
        .execute(sql`
          UPDATE lumibase_event_consumers SET lease_until = now() + make_interval(secs => ${LEASE_SECONDS})
           WHERE name = ${consumer} AND lease_token = ${token}
          RETURNING name`)
        .then((renewed) => {
          if ((renewed as unknown as Row[]).length === 0 && !lease.lost) {
            lease.lost = true;
            controller.abort(new LeaseLost());
          }
        })
        .catch(() => {});
    }, (LEASE_SECONDS * 1000) / 4);
    (lease.heartbeat as unknown as { unref?: () => void }).unref?.();
    return lease;
  }

  private async release(consumer: string, lease: Lease): Promise<void> {
    clearInterval(lease.heartbeat);
    await this.db.execute(sql`
      UPDATE lumibase_event_consumers SET lease_token = NULL, lease_until = NULL, last_run_at = now()
       WHERE name = ${consumer} AND lease_token = ${lease.token}`);
  }
}

interface Lease {
  token: string;
  lost: boolean;
  signal: AbortSignal;
  heartbeat: ReturnType<typeof setInterval> | undefined;
}

/** The run no longer holds the consumer's lease: stop without writing anything. */
class LeaseLost extends Error {
  constructor() {
    super('consumer lease lost');
    this.name = 'LeaseLost';
  }
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 1000);
}
