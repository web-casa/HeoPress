// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
/**
 * Change Feed dispatcher — the outbox relay (Req 4.1, 4.4, 4.5, 4.7).
 *
 * One subscription is one strictly-sequential lane: batches of up to
 * `batchSize` events are read after the checkpoint (with the same 2s safety
 * lag as the pull API), delivered through the kind's sender, and the cursor
 * advances ONLY on success — a failed batch never skips events (P6). A batch
 * retries with exponential backoff (30s·2^n, `MAX_DELIVERY_ATTEMPTS` total);
 * exhausting retries bumps `consecutive_failures`, and at
 * `DEAD_FAILURE_THRESHOLD` the subscription flips to `dead` with exactly one
 * notification (P7 / design §3.2).
 *
 * Correctness never depends on the queue: the queue trigger is a latency
 * optimization, the 30s sweep is the backstop, and `POST .../dispatch` is
 * the no-queue fallback (Req 4.7). Everything DB-shaped sits behind small
 * ports so P6/P7 run in-memory.
 */

import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import {
  cdcDeliveries,
  cdcSubscriptions,
  webhooks,
  type Database,
} from '@heopress/database';
import {
  CDC_FEED_SCHEMA_VERSION,
  cdcEventType,
  encodeCdcCursor,
  type CdcActorType,
  type CdcCursor,
  type CdcEventEnvelope,
  type CdcOperation,
  type CdcResource,
  type CdcSource,
} from '@heopress/contracts/schemas';
import type { CacheProvider, QueueProvider } from '@heopress/runtime';
import {
  eventKeyset,
  SAFETY_LAG_MS,
  type CdcEventStore,
  type StoredChangeEvent,
} from './feed-reader';
import { WebhookSender, type WebhookSendOutcome } from './webhook-sender';

export const CDC_DISPATCH_QUEUE = 'cdc-dispatch';
export const DISPATCH_BATCH_SIZE = 100;
export const MAX_DELIVERY_ATTEMPTS = 5;
export const RETRY_BASE_DELAY_MS = 30_000;
export const DEAD_FAILURE_THRESHOLD = 10;
export const SWEEP_INTERVAL_MS = 30_000;

/** Delay before retry attempt `attempt` (attempt 2 → 30s, 3 → 60s, …). Pure — P7. */
export function retryDelayMs(attempt: number, baseMs = RETRY_BASE_DELAY_MS): number {
  return baseMs * 2 ** (attempt - 2);
}

export interface DispatchableSubscription {
  id: string;
  siteId: string;
  name: string;
  kind: 'webhook' | 'extension';
  collections: string[];
  operations: CdcOperation[];
  payloadMode: 'reference' | 'snapshot';
  cursor: CdcCursor | null;
  consecutiveFailures: number;
  webhookId: string | null;
  extensionName: string | null;
}

/** Mutation port over the subscription rows the dispatcher touches. */
export interface SubscriptionDispatchStore {
  listDispatchable(siteId: string): Promise<DispatchableSubscription[]>;
  getDispatchable(siteId: string, id: string): Promise<DispatchableSubscription | null>;
  /**
   * Checkpoint forward (Req 4.4). After a delivered batch failures reset;
   * after a dead-lettered one (`resetFailures: false`) they keep counting.
   */
  advanceCursor(siteId: string, id: string, keyset: CdcCursor, opts?: { resetFailures?: boolean }): Promise<void>;
  /**
   * The subscription's dead letter (HeoPress P04, spec platform/event-consumption
   * "重试与死信"): a batch that failed every attempt is recorded here and the
   * lane moves past it (`moveTo`) in the same transaction, instead of
   * blocking every later event.
   */
  deadLetter(siteId: string, id: string, eventIds: string[], error: string, moveTo: CdcCursor): Promise<void>;
  /** Failure path: returns the NEW consecutive-failure count. */
  recordFailure(siteId: string, id: string): Promise<number>;
  markDead(siteId: string, id: string): Promise<void>;
  /** Sites with at least one active webhook/extension subscription (sweep). */
  listActiveSiteIds(): Promise<string[]>;
}

export interface DeliveryLogEntry {
  siteId: string;
  subscriptionId: string;
  eventIdFrom: string;
  eventIdTo: string;
  eventCount: number;
  attempt: number;
  /** `unknown`: the consumer may have processed the batch (timeout, 5xx); see WebhookSendOutcome. */
  status: 'success' | 'failed' | 'unknown';
  httpStatus: number | null;
  errorMessage: string | null;
  durationMs: number;
}

export interface DeliveryLogStore {
  record(entry: DeliveryLogEntry): Promise<void>;
}

/** A kind-specific transport (webhook now; extension lands in Phase E). */
export interface EnvelopeSender {
  deliver(
    subscription: DispatchableSubscription,
    envelopes: CdcEventEnvelope[],
  ): Promise<WebhookSendOutcome>;
}

export interface DeadSubscriptionNotice {
  siteId: string;
  subscriptionId: string;
  name: string;
  consecutiveFailures: number;
}

export interface DispatcherDeps {
  eventStore: CdcEventStore;
  subscriptions: SubscriptionDispatchStore;
  deliveryLog: DeliveryLogStore;
  senders: Partial<Record<'webhook' | 'extension', EnvelopeSender>>;
  /** Exactly-once-per-transition dead alert (Req 8.2). Default: stderr JSON. */
  notifyDead?: (notice: DeadSubscriptionNotice) => Promise<void> | void;
  /** Best-effort per-subscription lock (overlap is harmless, just wasteful). */
  cache?: CacheProvider;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  batchSize?: number;
  maxAttempts?: number;
  retryBaseMs?: number;
  safetyLagMs?: number;
}

export function buildEnvelope(
  event: StoredChangeEvent,
  payloadMode: 'reference' | 'snapshot',
): CdcEventEnvelope {
  return {
    id: event.id,
    type: cdcEventType((event.resource as CdcResource | undefined) ?? 'item', event.operation),
    schemaVersion: event.schemaVersion ?? CDC_FEED_SCHEMA_VERSION,
    siteId: event.siteId,
    collection: event.collection,
    itemId: event.itemId,
    operation: event.operation,
    occurredAt: event.occurredAt.toISOString(),
    actor: {
      type: event.actorType as CdcActorType,
      ...(event.actorId ? { id: event.actorId } : {}),
    },
    source: event.source as CdcSource,
    ...(event.changedFields?.length ? { changedFields: event.changedFields } : {}),
    ...(payloadMode === 'snapshot' && event.payload ? { data: event.payload } : {}),
    cursor: encodeCdcCursor(eventKeyset(event)),
  };
}

export class CdcDispatcher {
  constructor(private readonly deps: DispatcherDeps) {}

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  private async sleep(ms: number): Promise<void> {
    await (this.deps.sleep ?? ((m: number) => new Promise((r) => setTimeout(r, m))))(ms);
  }

  async dispatchSite(siteId: string): Promise<void> {
    const subs = await this.deps.subscriptions.listDispatchable(siteId);
    // One lane per subscription (Codex review P04-2 #6): a receiver that is
    // down — its batch sleeping through retry backoff — does not hold up
    // the other subscriptions.
    await Promise.allSettled(subs.map((sub) => this.dispatchSubscription(sub)));
  }

  async dispatchSubscriptionById(siteId: string, id: string): Promise<boolean> {
    const sub = await this.deps.subscriptions.getDispatchable(siteId, id);
    if (!sub) return false;
    await this.dispatchSubscription(sub);
    return true;
  }

  /** One sequential lane; never throws — failures land in the delivery log. */
  async dispatchSubscription(sub: DispatchableSubscription): Promise<void> {
    const sender = this.deps.senders[sub.kind];
    if (!sender) return;
    if (!(await this.acquireLock(sub))) return;
    try {
      let cursor = sub.cursor;
      // Bounded loop: a lane drains at most 1000 batches per run.
      for (let round = 0; round < 1000; round++) {
        const notAfter = new Date(
          this.now().getTime() - (this.deps.safetyLagMs ?? SAFETY_LAG_MS),
        );
        const events = await this.deps.eventStore.listAfter(
          sub.siteId,
          cursor,
          { collections: sub.collections, operations: sub.operations },
          this.deps.batchSize ?? DISPATCH_BATCH_SIZE,
          notAfter,
        );
        if (events.length === 0) return;

        const envelopes = events.map((e) => buildEnvelope(e, sub.payloadMode));
        const delivered = await this.deliverWithRetry(sender, sub, events, envelopes);
        if (!delivered.ok) {
          const failures = await this.deps.subscriptions.recordFailure(sub.siteId, sub.id);
          if (failures >= DEAD_FAILURE_THRESHOLD) {
            await this.deps.subscriptions.markDead(sub.siteId, sub.id);
            const notify =
              this.deps.notifyDead ??
              ((notice: DeadSubscriptionNotice) => {
                // eslint-disable-next-line no-console
                console.error(JSON.stringify({ event: 'cdc_subscription_dead', ...notice }));
              });
            await notify({
              siteId: sub.siteId,
              subscriptionId: sub.id,
              name: sub.name,
              consecutiveFailures: failures,
            });
            return; // a dead subscription stops at the batch it could not deliver (replay resumes there)
          }
          // Every attempt failed: dead-letter the batch and move past it, so a
          // single bad batch does not block the lane (HeoPress P04; P6 as
          // revised). The next batch goes out on the next run.
          const last = events[events.length - 1]!;
          await this.deps.subscriptions.deadLetter(
            sub.siteId,
            sub.id,
            events.map((e) => e.id),
            delivered.error ?? 'delivery failed',
            eventKeyset(last),
          );
          return;
        }

        const last = events[events.length - 1]!;
        const keyset = eventKeyset(last);
        await this.deps.subscriptions.advanceCursor(sub.siteId, sub.id, keyset);
        cursor = keyset;
      }
    } finally {
      await this.releaseLock(sub);
    }
  }

  private async deliverWithRetry(
    sender: EnvelopeSender,
    sub: DispatchableSubscription,
    events: StoredChangeEvent[],
    envelopes: CdcEventEnvelope[],
  ): Promise<{ ok: boolean; error?: string }> {
    const maxAttempts = this.deps.maxAttempts ?? MAX_DELIVERY_ATTEMPTS;
    let lastError: string | undefined;
    const first = events[0]!;
    const last = events[events.length - 1]!;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) {
        await this.sleep(retryDelayMs(attempt, this.deps.retryBaseMs ?? RETRY_BASE_DELAY_MS));
      }
      const started = this.now().getTime();
      let outcome: WebhookSendOutcome;
      try {
        outcome = await sender.deliver(sub, envelopes);
      } catch (err) {
        outcome = {
          ok: false,
          httpStatus: null,
          errorMessage: err instanceof Error ? err.message : String(err),
          outcome: 'unknown',
        };
      }
      await this.deps.deliveryLog.record({
        siteId: sub.siteId,
        subscriptionId: sub.id,
        eventIdFrom: first.id,
        eventIdTo: last.id,
        eventCount: events.length,
        attempt,
        status: outcome.ok ? 'success' : outcome.outcome === 'unknown' ? 'unknown' : 'failed',
        httpStatus: outcome.httpStatus,
        errorMessage: outcome.errorMessage,
        durationMs: Math.max(0, this.now().getTime() - started),
      });
      if (outcome.ok) return { ok: true };
      lastError = outcome.errorMessage ?? (outcome.httpStatus ? `HTTP ${outcome.httpStatus}` : undefined);
    }
    return { ok: false, error: lastError };
  }

  private lockKey(sub: DispatchableSubscription): string {
    return `cdc:dispatch:${sub.siteId}:${sub.id}`; // tenant-prefixed (DoD §2b)
  }

  private async acquireLock(sub: DispatchableSubscription): Promise<boolean> {
    if (!this.deps.cache) return true;
    try {
      const key = this.lockKey(sub);
      if ((await this.deps.cache.get(key)) === 'locked') return false;
      await this.deps.cache.set(key, 'locked', { ttl: 60 });
      return true;
    } catch {
      return true; // lock is an optimization, never a correctness gate
    }
  }

  private async releaseLock(sub: DispatchableSubscription): Promise<void> {
    if (!this.deps.cache) return;
    try {
      await this.deps.cache.delete(this.lockKey(sub));
    } catch {
      /* TTL expires it */
    }
  }
}

/** The event-consumer name of a Change Feed subscription (HeoPress P04). */
export function subscriptionConsumerName(subscriptionId: string): string {
  return `cdc-subscription:${subscriptionId}`;
}

// ── In-memory ports (repo `InMemory*` convention — P6/P7 tests) ──────────

export class InMemorySubscriptionDispatchStore implements SubscriptionDispatchStore {
  dead: string[] = [];
  deadLetters: Array<{ subscriptionId: string; eventIds: string[]; error: string }> = [];
  constructor(public subs: DispatchableSubscription[]) {}

  async listDispatchable(siteId: string): Promise<DispatchableSubscription[]> {
    return this.subs.filter((s) => s.siteId === siteId);
  }
  async getDispatchable(siteId: string, id: string) {
    return this.subs.find((s) => s.siteId === siteId && s.id === id) ?? null;
  }
  async advanceCursor(siteId: string, id: string, keyset: CdcCursor, opts?: { resetFailures?: boolean }): Promise<void> {
    const sub = this.subs.find((s) => s.siteId === siteId && s.id === id);
    if (sub) {
      sub.cursor = keyset;
      if (opts?.resetFailures !== false) sub.consecutiveFailures = 0;
    }
  }
  async deadLetter(siteId: string, id: string, eventIds: string[], error: string, moveTo: CdcCursor): Promise<void> {
    this.deadLetters.push({ subscriptionId: id, eventIds, error });
    await this.advanceCursor(siteId, id, moveTo, { resetFailures: false });
  }
  async recordFailure(siteId: string, id: string): Promise<number> {
    const sub = this.subs.find((s) => s.siteId === siteId && s.id === id);
    if (!sub) return 0;
    sub.consecutiveFailures += 1;
    return sub.consecutiveFailures;
  }
  async markDead(siteId: string, id: string): Promise<void> {
    this.dead.push(id);
    this.subs = this.subs.filter((s) => !(s.siteId === siteId && s.id === id));
  }
  async listActiveSiteIds(): Promise<string[]> {
    return [...new Set(this.subs.map((s) => s.siteId))];
  }
}

export class InMemoryDeliveryLog implements DeliveryLogStore {
  entries: DeliveryLogEntry[] = [];
  async record(entry: DeliveryLogEntry): Promise<void> {
    this.entries.push(entry);
  }
}

// ── Drizzle ports (production) ────────────────────────────────────────────

export class DrizzleSubscriptionDispatchStore implements SubscriptionDispatchStore {
  constructor(private readonly db: Database) {}

  private async positions(ids: string[]): Promise<Map<string, { txid: string; seq: number }>> {
    if (ids.length === 0) return new Map();
    const names = ids.map(subscriptionConsumerName);
    const rows = (await this.db.execute(sql`
      SELECT name, cursor_txid::text AS txid, cursor_seq AS seq FROM lumibase_event_consumers
       WHERE name IN (${sql.join(names.map((n) => sql`${n}`), sql`, `)}) AND cursor_txid IS NOT NULL`)) as unknown as Array<{
      name: string;
      txid: string;
      seq: number;
    }>;
    return new Map(rows.map((r) => [r.name.slice('cdc-subscription:'.length), { txid: r.txid, seq: Number(r.seq) }]));
  }

  private toDispatchable(
    row: typeof cdcSubscriptions.$inferSelect,
    position?: { txid: string; seq: number },
  ): DispatchableSubscription {
    return {
      id: row.id,
      siteId: row.siteId,
      name: row.name,
      kind: row.kind as 'webhook' | 'extension',
      collections: (row.collections as string[]) ?? [],
      operations: (row.operations as CdcOperation[]) ?? [],
      payloadMode: row.payloadMode as 'reference' | 'snapshot',
      // The checkpoint with its exact registered position: a replay "from a
      // time" stores the time with an empty id, and its position only in the
      // registry (Codex review P04-3 #4, #5).
      cursor: row.cursorOccurredAt
        ? {
            occurredAtMs: row.cursorOccurredAt.getTime(),
            eventId: row.cursorId ?? '',
            ...(position ? { position } : {}),
          }
        : null,
      consecutiveFailures: row.consecutiveFailures,
      webhookId: row.webhookId,
      extensionName: row.extensionName,
    };
  }

  async listDispatchable(siteId: string): Promise<DispatchableSubscription[]> {
    const rows = await this.db
      .select()
      .from(cdcSubscriptions)
      .where(
        and(
          eq(cdcSubscriptions.siteId, siteId),
          eq(cdcSubscriptions.status, 'active'),
          inArray(cdcSubscriptions.kind, ['webhook', 'extension']),
        ),
      );
    const positions = await this.positions(rows.map((r) => r.id));
    return rows.map((r) => this.toDispatchable(r, positions.get(r.id)));
  }

  async getDispatchable(siteId: string, id: string) {
    const [row] = await this.db
      .select()
      .from(cdcSubscriptions)
      .where(
        and(
          eq(cdcSubscriptions.siteId, siteId),
          eq(cdcSubscriptions.id, id),
          eq(cdcSubscriptions.status, 'active'),
          inArray(cdcSubscriptions.kind, ['webhook', 'extension']),
        ),
      )
      .limit(1);
    return row ? this.toDispatchable(row, (await this.positions([row.id])).get(row.id)) : null;
  }

  async advanceCursor(siteId: string, id: string, keyset: CdcCursor, opts?: { resetFailures?: boolean }): Promise<void> {
    await this.db.transaction((tx) => this.advanceIn(tx as unknown as Database, siteId, id, keyset, opts));
  }

  private async advanceIn(
    db: Database,
    siteId: string,
    id: string,
    keyset: CdcCursor,
    opts?: { resetFailures?: boolean },
  ): Promise<void> {
    const reset = opts?.resetFailures !== false;
    const tx = db;
    {
      await tx
        .update(cdcSubscriptions)
        .set({
          cursorOccurredAt: new Date(keyset.occurredAtMs),
          cursorId: keyset.eventId,
          ...(reset ? { consecutiveFailures: 0, lastDeliveredAt: new Date() } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(cdcSubscriptions.siteId, siteId), eq(cdcSubscriptions.id, id)));
      // The registered consumer's position (HeoPress P04): what retention and
      // monitoring read for every consumer, subscriptions included.
      if (keyset.position) {
        await tx.execute(sql`
          INSERT INTO lumibase_event_consumers (name, site_id, cursor_txid, cursor_seq)
          VALUES (${subscriptionConsumerName(id)}, ${siteId}, ${keyset.position.txid}::xid8, ${keyset.position.seq}::bigint)
          ON CONFLICT (name) DO UPDATE
             SET cursor_txid = EXCLUDED.cursor_txid, cursor_seq = EXCLUDED.cursor_seq, updated_at = now()`);
      } else {
        await tx.execute(sql`
          INSERT INTO lumibase_event_consumers (name, site_id, cursor_txid, cursor_seq)
          SELECT ${subscriptionConsumerName(id)}, ${siteId}, e.txid, e.seq
            FROM lumibase_cdc_change_events e WHERE e.site_id = ${siteId} AND e.id = ${keyset.eventId}
          ON CONFLICT (name) DO UPDATE
             SET cursor_txid = EXCLUDED.cursor_txid, cursor_seq = EXCLUDED.cursor_seq, updated_at = now()`);
      }
    }
  }

  /** Record the dead batch and move past it in one transaction (Codex review P04-2 #8). */
  async deadLetter(siteId: string, id: string, eventIds: string[], error: string, moveTo: CdcCursor): Promise<void> {
    const name = subscriptionConsumerName(id);
    await this.db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Database;
      await tx.execute(sql`
        INSERT INTO lumibase_event_consumers (name, site_id) VALUES (${name}, ${siteId}) ON CONFLICT (name) DO NOTHING`);
      for (const eventId of eventIds) {
        await tx.execute(sql`
          INSERT INTO lumibase_event_consumer_failures (consumer, event_id, state, attempts, last_error)
          VALUES (${name}, ${eventId}, 'dead', ${MAX_DELIVERY_ATTEMPTS}, ${error.slice(0, 1000)})
          ON CONFLICT (consumer, event_id) DO UPDATE
             SET state = 'dead', last_error = EXCLUDED.last_error, updated_at = now()`);
      }
      await this.advanceIn(tx, siteId, id, moveTo, { resetFailures: false });
    });
  }

  async recordFailure(siteId: string, id: string): Promise<number> {
    const [row] = await this.db
      .update(cdcSubscriptions)
      .set({
        consecutiveFailures: sql`${cdcSubscriptions.consecutiveFailures} + 1`,
        updatedAt: new Date(),
      })
      .where(and(eq(cdcSubscriptions.siteId, siteId), eq(cdcSubscriptions.id, id)))
      .returning({ n: cdcSubscriptions.consecutiveFailures });
    return row?.n ?? 0;
  }

  async markDead(siteId: string, id: string): Promise<void> {
    await this.db
      .update(cdcSubscriptions)
      .set({ status: 'dead', updatedAt: new Date() })
      .where(and(eq(cdcSubscriptions.siteId, siteId), eq(cdcSubscriptions.id, id)));
  }

  async listActiveSiteIds(): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ siteId: cdcSubscriptions.siteId })
      .from(cdcSubscriptions)
      .where(
        and(
          eq(cdcSubscriptions.status, 'active'),
          ne(cdcSubscriptions.kind, 'pull'),
        ),
      );
    return rows.map((r) => r.siteId);
  }
}

export class DrizzleDeliveryLog implements DeliveryLogStore {
  constructor(private readonly db: Database) {}
  async record(entry: DeliveryLogEntry): Promise<void> {
    await this.db.insert(cdcDeliveries).values({
      ...entry,
      // Sender outcomes never include response bodies or headers, so there is
      // no secret to mask — just bound the size (Req 7.5).
      errorMessage: entry.errorMessage ? entry.errorMessage.slice(0, 500) : null,
    });
  }
}

/** Resolve a webhook subscription's target (url/secret/headers) per site. */
export async function loadWebhookTarget(
  db: Database,
  siteId: string,
  webhookId: string,
): Promise<{ url: string; secret: string; headers: Record<string, string> } | null> {
  const [row] = await db
    .select({ url: webhooks.url, secret: webhooks.secret, headers: webhooks.headers })
    .from(webhooks)
    .where(and(eq(webhooks.siteId, siteId), eq(webhooks.id, webhookId)))
    .limit(1);
  if (!row?.secret) return null; // unsigned delivery is never allowed (Req 4.2)
  return {
    url: row.url,
    secret: row.secret,
    headers: (row.headers as Record<string, string>) ?? {},
  };
}

/**
 * Production webhook transport: resolves the subscription's webhook target
 * (url/secret/headers) per delivery, refusing unsigned targets (Req 4.2).
 */
export function createWebhookEnvelopeSender(db: Database): EnvelopeSender {
  const sender = new WebhookSender();
  return {
    async deliver(sub, envelopes) {
      if (!sub.webhookId) {
        return { ok: false, httpStatus: null, errorMessage: 'Subscription has no webhook' };
      }
      const target = await loadWebhookTarget(db, sub.siteId, sub.webhookId);
      if (!target) {
        return { ok: false, httpStatus: null, errorMessage: 'Webhook missing or has no secret' };
      }
      return sender.deliver(target, envelopes, { id: sub.id, name: sub.name });
    },
  };
}

// ── Worker pass (Docker/Node long-lived runtime — Req 4.7) ────────────────

export interface CdcDispatchPassDeps {
  buildDispatcher: () => CdcDispatcher;
  subscriptions: SubscriptionDispatchStore;
  /** Retention prune, run per site at most every `pruneIntervalMs` (Req 6.1). */
  prune?: (siteId: string) => Promise<void>;
  pruneIntervalMs?: number;
  /** Every site, for retention. */
  listAllSiteIds?: () => Promise<string[]>;
}

/**
 * One pass over every site with an active push subscription. Driven by the
 * event consumer loop (`registerEventConsumers`, HeoPress P04), which wakes
 * on writes and ticks as the backstop; pruning keeps its slower cadence.
 */
export function createCdcDispatchPass(deps: CdcDispatchPassDeps): () => Promise<void> {
  let lastPrune = 0;
  /** Subscriptions with a lane running: started, not awaited (Codex review P04-2 #6). */
  const inFlight = new Set<string>();
  return async () => {
    const sites = await deps.subscriptions.listActiveSiteIds();
    const dispatcher = deps.buildDispatcher();
    for (const siteId of sites) {
      for (const sub of await deps.subscriptions.listDispatchable(siteId)) {
        if (inFlight.has(sub.id)) continue;
        inFlight.add(sub.id);
        // Detached: a failure (the database, say) is logged here, never left
        // as an unhandled rejection that could stop the worker (Codex review P04-3 #9).
        void dispatcher
          .dispatchSubscription(sub)
          .catch((err: unknown) => {
            // eslint-disable-next-line no-console
            console.error(JSON.stringify({ event: 'cdc_dispatch_failed', siteId, subscriptionId: sub.id, error: err instanceof Error ? err.message : String(err) }));
          })
          .finally(() => inFlight.delete(sub.id));
      }
    }
    // Retention covers every site — not only those with push subscriptions:
    // events are written for all of them (Codex review P04-2 #11).
    if (deps.prune && Date.now() - lastPrune >= (deps.pruneIntervalMs ?? SWEEP_INTERVAL_MS)) {
      lastPrune = Date.now();
      for (const siteId of await (deps.listAllSiteIds ?? (() => Promise.resolve(sites)))()) await deps.prune(siteId);
    }
  };
}
