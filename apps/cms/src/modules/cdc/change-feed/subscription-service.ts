// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
/**
 * Change Feed subscription service (Req 3.1–3.5, 6.2, 6.3).
 *
 * CRUD + checkpoint lifecycle for feed consumers. Ordering/transition rules
 * are delegated to the pure helpers in `subscription-state.ts`; storage goes
 * through Drizzle; lag reads go through the `CdcEventStore` port so tests
 * stay DB-free. Route handlers translate the typed errors below into the
 * platform's `{ errors: [...] }` responses (409/403/404/400).
 */

import { and, count, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  cdcDeliveries,
  cdcSubscriptions,
  webhooks,
  type Database,
} from '@heopress/database';
import {
  decodeCdcCursor,
  encodeCdcCursor,
  type CdcCursor,
  type CdcSubscriptionCreateInput,
  type CdcSubscriptionPatchInput,
  type CdcSubscriptionStatus,
} from '@heopress/contracts/schemas';
import type { CdcEventStore } from './feed-reader';
import { eventKeyset, eventPosition } from './feed-reader';
import { subscriptionConsumerName } from './dispatcher';
import { lockSiteFeed } from './feed-lock';
import {
  canTransitionSubscription,
  compareKeyset,
  isAckAllowed,
} from './subscription-state';
import { invalidateFeedFlagCache } from './outbox-writer';
import type { CacheProvider } from '@heopress/runtime';

export const MAX_SUBSCRIPTIONS_PER_SITE = 50;

export class SubscriptionNotFoundError extends Error {
  constructor(id: string) {
    super(`Subscription "${id}" not found`);
    this.name = 'SubscriptionNotFoundError';
  }
}
export class SubscriptionNameConflictError extends Error {
  constructor(name: string) {
    super(`A subscription named "${name}" already exists for this site`);
    this.name = 'SubscriptionNameConflictError';
  }
}
export class SubscriptionLimitExceededError extends Error {
  constructor() {
    super(`Site reached the maximum of ${MAX_SUBSCRIPTIONS_PER_SITE} subscriptions`);
    this.name = 'SubscriptionLimitExceededError';
  }
}
export class WebhookSecretRequiredError extends Error {
  constructor() {
    super('kind=webhook requires a webhook with a signing secret (Req 4.2)');
    this.name = 'WebhookSecretRequiredError';
  }
}
export class AckRegressionError extends Error {
  constructor() {
    super('Ack cursor may not move backwards — use replay to rewind (Req 3.3)');
    this.name = 'AckRegressionError';
  }
}
export class InvalidTransitionError extends Error {
  constructor(from: CdcSubscriptionStatus, to: CdcSubscriptionStatus) {
    super(`Invalid status transition ${from} → ${to} — dead/stale resume only via replay`);
    this.name = 'InvalidTransitionError';
  }
}
export class ReplayOutOfRetentionError extends Error {
  constructor() {
    super('Replay target predates the retention window (Req 6.2)');
    this.name = 'ReplayOutOfRetentionError';
  }
}

export interface SubscriptionRecord {
  id: string;
  siteId: string;
  name: string;
  kind: string;
  collections: string[];
  operations: string[];
  payloadMode: string;
  cursor: string | null;
  status: CdcSubscriptionStatus;
  webhookId: string | null;
  extensionName: string | null;
  consecutiveFailures: number;
  lastDeliveredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  /** Req 3.5 — events (and ms) between the checkpoint and the feed head. */
  lag: { events: number; behindMs: number | null };
}

export interface SubscriptionServiceDeps {
  db: Database;
  siteId: string;
  eventStore: CdcEventStore;
  cache?: CacheProvider;
  retentionDays: number;
  now?: () => Date;
  /** Audit sink for replay (Req 6.2); wired to AuditLogger by the routes. */
  audit?: (event: string, metadata: Record<string, unknown>) => Promise<void> | void;
}

type SubscriptionRow = typeof cdcSubscriptions.$inferSelect;

/**
 * The checkpoint stored on the row. A replay "from a time" stores the time
 * with an empty event id — still a checkpoint (Codex review P04-3 #4); its
 * exact position is the registry's.
 */
function rowCursor(row: SubscriptionRow): CdcCursor | null {
  if (!row.cursorOccurredAt) return null;
  return { occurredAtMs: row.cursorOccurredAt.getTime(), eventId: row.cursorId ?? '' };
}

export class SubscriptionService {
  constructor(private readonly deps: SubscriptionServiceDeps) {}

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  /** The checkpoint with its exact registered position (Codex review P04-3 #5). */
  private async cursorOf(row: SubscriptionRow, db: Pick<Database, 'execute'> = this.deps.db): Promise<CdcCursor | null> {
    const cursor = rowCursor(row);
    if (!cursor) return null;
    const position = await this.registeredPosition(row.id, db);
    return position ? { ...cursor, position } : cursor;
  }

  private async toRecord(row: SubscriptionRow): Promise<SubscriptionRecord> {
    const cursor = await this.cursorOf(row);
    const [events, head] = await Promise.all([
      this.deps.eventStore.countAfter(this.deps.siteId, cursor),
      this.deps.eventStore.latest(this.deps.siteId),
    ]);
    // behindMs is only meaningful once a checkpoint exists; before the first
    // ack/delivery the backlog is conveyed by `events` alone (Req 3.5).
    const behindMs =
      head && cursor ? Math.max(0, head.occurredAt.getTime() - cursor.occurredAtMs) : null;
    return {
      id: row.id,
      siteId: row.siteId,
      name: row.name,
      kind: row.kind,
      collections: (row.collections as string[]) ?? [],
      operations: (row.operations as string[]) ?? [],
      payloadMode: row.payloadMode,
      cursor: cursor ? encodeCdcCursor(cursor) : null,
      status: row.status as CdcSubscriptionStatus,
      webhookId: row.webhookId,
      extensionName: row.extensionName,
      consecutiveFailures: row.consecutiveFailures,
      lastDeliveredAt: row.lastDeliveredAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      lag: { events, behindMs },
    };
  }

  private async getRow(id: string): Promise<SubscriptionRow> {
    const [row] = await this.deps.db
      .select()
      .from(cdcSubscriptions)
      .where(and(eq(cdcSubscriptions.siteId, this.deps.siteId), eq(cdcSubscriptions.id, id)))
      .limit(1);
    if (!row) throw new SubscriptionNotFoundError(id);
    return row;
  }

  async create(input: CdcSubscriptionCreateInput): Promise<SubscriptionRecord> {
    const [countRow] = await this.deps.db
      .select({ n: count() })
      .from(cdcSubscriptions)
      .where(eq(cdcSubscriptions.siteId, this.deps.siteId));
    if (Number(countRow?.n ?? 0) >= MAX_SUBSCRIPTIONS_PER_SITE) {
      throw new SubscriptionLimitExceededError();
    }

    const [existing] = await this.deps.db
      .select({ id: cdcSubscriptions.id })
      .from(cdcSubscriptions)
      .where(
        and(eq(cdcSubscriptions.siteId, this.deps.siteId), eq(cdcSubscriptions.name, input.name)),
      )
      .limit(1);
    if (existing) throw new SubscriptionNameConflictError(input.name);

    if (input.kind === 'webhook') {
      const [hook] = await this.deps.db
        .select({ secret: webhooks.secret })
        .from(webhooks)
        .where(and(eq(webhooks.siteId, this.deps.siteId), eq(webhooks.id, input.webhook_id!)))
        .limit(1);
      if (!hook?.secret) throw new WebhookSecretRequiredError();
    }

    // The subscription and its entry in the consumer registry commit together
    // (HeoPress P04, Codex review P04-2 #9): retention never sees one without
    // the other. A new subscription starts from the first retained event.
    const row = await this.deps.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(cdcSubscriptions)
        .values({
          siteId: this.deps.siteId,
          name: input.name,
          kind: input.kind,
          collections: input.collections,
          operations: input.operations,
          payloadMode: input.payload_mode,
          webhookId: input.webhook_id ?? null,
          extensionName: input.extension_name ?? null,
        })
        .returning();
      await tx.execute(sql`
        INSERT INTO lumibase_event_consumers (name, site_id) VALUES (${subscriptionConsumerName(created!.id)}, ${this.deps.siteId})
        ON CONFLICT (name) DO UPDATE SET cursor_txid = NULL, cursor_seq = NULL, status = 'active', updated_at = now()`);
      return created;
    });
    await invalidateFeedFlagCache(this.deps.cache, this.deps.siteId);
    await this.deps.audit?.('cdc_subscription_created', {
      subscriptionId: row!.id,
      name: input.name,
      kind: input.kind,
    });
    return this.toRecord(row!);
  }

  async list(): Promise<SubscriptionRecord[]> {
    const rows = await this.deps.db
      .select()
      .from(cdcSubscriptions)
      .where(eq(cdcSubscriptions.siteId, this.deps.siteId))
      .orderBy(desc(cdcSubscriptions.createdAt));
    return Promise.all(rows.map((r) => this.toRecord(r)));
  }

  async get(id: string): Promise<SubscriptionRecord> {
    return this.toRecord(await this.getRow(id));
  }

  async patch(id: string, input: CdcSubscriptionPatchInput): Promise<SubscriptionRecord> {
    const row = await this.getRow(id);
    if (input.status && input.status !== row.status) {
      if (
        !canTransitionSubscription(row.status as CdcSubscriptionStatus, input.status, 'admin')
      ) {
        throw new InvalidTransitionError(row.status as CdcSubscriptionStatus, input.status);
      }
    }
    if (input.name && input.name !== row.name) {
      const [existing] = await this.deps.db
        .select({ id: cdcSubscriptions.id })
        .from(cdcSubscriptions)
        .where(
          and(eq(cdcSubscriptions.siteId, this.deps.siteId), eq(cdcSubscriptions.name, input.name)),
        )
        .limit(1);
      if (existing && existing.id !== id) throw new SubscriptionNameConflictError(input.name);
    }
    const [updated] = await this.deps.db
      .update(cdcSubscriptions)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.collections !== undefined ? { collections: input.collections } : {}),
        ...(input.operations !== undefined ? { operations: input.operations } : {}),
        ...(input.payload_mode !== undefined ? { payloadMode: input.payload_mode } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        updatedAt: this.now(),
      })
      .where(and(eq(cdcSubscriptions.siteId, this.deps.siteId), eq(cdcSubscriptions.id, id)))
      .returning();
    await invalidateFeedFlagCache(this.deps.cache, this.deps.siteId);
    if (input.status && input.status !== row.status) {
      await this.deps.audit?.('cdc_subscription_status_changed', {
        subscriptionId: id,
        name: row.name,
        from: row.status,
        to: input.status,
      });
    }
    return this.toRecord(updated!);
  }

  async remove(id: string): Promise<void> {
    const row = await this.getRow(id);
    await this.deps.db
      .delete(cdcSubscriptions)
      .where(and(eq(cdcSubscriptions.siteId, this.deps.siteId), eq(cdcSubscriptions.id, id)));
    await invalidateFeedFlagCache(this.deps.cache, this.deps.siteId);
    await this.deps.audit?.('cdc_subscription_deleted', {
      subscriptionId: id,
      name: row.name,
      kind: row.kind,
    });
  }

  /** Pull-consumer checkpoint commit — forward-only (Req 3.3, property P11). */
  async ack(id: string, cursorToken: string): Promise<SubscriptionRecord> {
    const next = decodeCdcCursor(cursorToken);
    if (!next) throw new AckRegressionError(); // routes map decode failure to 400 earlier
    const nextAt = await this.withPosition(next);
    // One transaction with the row locked (Codex review P04-3 #2): concurrent
    // acks are compared one after the other, and the checkpoint and the
    // registry position change together.
    const updated = await this.deps.db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Database;
      const [row] = await tx
        .select()
        .from(cdcSubscriptions)
        .where(and(eq(cdcSubscriptions.siteId, this.deps.siteId), eq(cdcSubscriptions.id, id)))
        .for('update');
      if (!row) throw new SubscriptionNotFoundError(id);
      // Compare in the feed's order — positions (Codex review P04-2 #3).
      const current = await this.cursorOf(row, tx);
      // On this transaction's connection: holding the row lock while waiting
      // for another pooled connection can starve the pool under load.
      const currentAt = current ? await this.withPosition(current, tx) : null;
      if (!isAckAllowed(currentAt, nextAt)) throw new AckRegressionError();
      const [saved] = await tx
        .update(cdcSubscriptions)
        .set({
          cursorOccurredAt: new Date(next.occurredAtMs),
          cursorId: next.eventId,
          lastDeliveredAt: this.now(),
          updatedAt: this.now(),
        })
        .where(and(eq(cdcSubscriptions.siteId, this.deps.siteId), eq(cdcSubscriptions.id, id)))
        .returning();
      await this.setRegisteredPosition(tx, id, nextAt.position ?? null);
      return saved!;
    });
    return this.toRecord(updated);
  }

  /** `cursor` with its position filled in (production store). */
  private async withPosition(cursor: CdcCursor, db: Database = this.deps.db): Promise<CdcCursor> {
    if (cursor.position) return cursor;
    const position = await eventPosition(db, this.deps.siteId, cursor).catch(() => null);
    return position ? { ...cursor, position } : cursor;
  }

  /** The subscription's exact position in the consumer registry, if recorded. */
  private async registeredPosition(id: string, db: Pick<Database, 'execute'> = this.deps.db): Promise<{ txid: string; seq: number } | null> {
    const [row] = (await db.execute(sql`
      SELECT cursor_txid::text AS txid, cursor_seq AS seq FROM lumibase_event_consumers
       WHERE name = ${subscriptionConsumerName(id)} AND cursor_txid IS NOT NULL`)) as unknown as Array<{ txid: string; seq: number }>;
    return row ? { txid: row.txid, seq: Number(row.seq) } : null;
  }

  /** Set the subscription's registry position (null: from the start). */
  private async setRegisteredPosition(
    db: Pick<Database, 'execute'>,
    id: string,
    position: { txid: string; seq: number } | null,
  ): Promise<void> {
    await db.execute(sql`
      INSERT INTO lumibase_event_consumers (name, site_id, cursor_txid, cursor_seq, status)
      VALUES (${subscriptionConsumerName(id)}, ${this.deps.siteId}, ${position?.txid ?? null}::xid8, ${position?.seq ?? null}::bigint, 'active')
      ON CONFLICT (name) DO UPDATE
         SET cursor_txid = EXCLUDED.cursor_txid, cursor_seq = EXCLUDED.cursor_seq, status = 'active', updated_at = now()`);
  }

  /**
   * Rewind the checkpoint inside the retention window and reset the
   * subscription to `active` (the only path out of dead/stale — Req 6.2).
   */
  async replay(
    id: string,
    target: { cursor?: string; occurredAfter?: string },
    actor: { type: string; id?: string | null },
  ): Promise<SubscriptionRecord> {
    const row = await this.getRow(id);
    let next: CdcCursor;
    if (target.cursor) {
      const decoded = decodeCdcCursor(target.cursor);
      if (!decoded) throw new ReplayOutOfRetentionError();
      next = decoded;
    } else {
      // occurred_after: empty eventId sorts before every real id at that ms.
      next = { occurredAtMs: new Date(target.occurredAfter!).getTime(), eventId: '' };
    }
    // Out of retention only when events after the replay point were deleted
    // (Codex review P04-2 #10). Checked, and the position rewound, under the
    // site's feed lock: no prune runs in between (Codex review P04-3 #2).
    const floorMs = this.now().getTime() - this.deps.retentionDays * 86_400_000;
    const current = rowCursor(row);
    const updated = await this.deps.db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Database;
      await lockSiteFeed(tx, this.deps.siteId);
      if (await this.deps.eventStore.isExpired(this.deps.siteId, next, floorMs)) throw new ReplayOutOfRetentionError();
      // The replay point as a position, fixed now (a time: just before the
      // first event at or after it).
      const position = next.position ?? (await eventPosition(tx, this.deps.siteId, next));
      const [saved] = await tx
        .update(cdcSubscriptions)
        .set({
          cursorOccurredAt: new Date(next.occurredAtMs),
          cursorId: next.eventId,
          status: 'active',
          consecutiveFailures: 0,
          updatedAt: this.now(),
        })
        .where(and(eq(cdcSubscriptions.siteId, this.deps.siteId), eq(cdcSubscriptions.id, id)))
        .returning();
      await this.setRegisteredPosition(tx, id, position);
      return saved!;
    });
    await this.deps.audit?.('cdc_subscription_replayed', {
      subscriptionId: id,
      name: row.name,
      from: current ? encodeCdcCursor(current) : null,
      to: encodeCdcCursor(next),
      previousStatus: row.status,
      actorType: actor.type,
      actorId: actor.id ?? null,
    });
    await invalidateFeedFlagCache(this.deps.cache, this.deps.siteId);
    return this.toRecord(updated);
  }

  /** Delivery-attempt history, newest first (Req 8.1). */
  async listDeliveries(
    id: string,
    opts: { limit?: number; page?: number } = {},
  ): Promise<{ data: (typeof cdcDeliveries.$inferSelect)[]; total: number }> {
    await this.getRow(id);
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const page = Math.max(opts.page ?? 1, 1);
    const where = and(
      eq(cdcDeliveries.siteId, this.deps.siteId),
      eq(cdcDeliveries.subscriptionId, id),
    );
    const [rows, countRows] = await Promise.all([
      this.deps.db
        .select()
        .from(cdcDeliveries)
        .where(where)
        .orderBy(desc(cdcDeliveries.createdAt))
        .limit(limit)
        .offset((page - 1) * limit),
      this.deps.db.select({ n: count() }).from(cdcDeliveries).where(where),
    ]);
    return { data: rows, total: Number(countRows[0]?.n ?? 0) };
  }
}

/** Re-exported for route/service tests. */
export { compareKeyset };
