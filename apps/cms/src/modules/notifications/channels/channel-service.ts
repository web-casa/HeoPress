/**
 * Per-site outbound notification channels and their delivery queue (HeoPress P10 tasks 5.2, 5.5; spec
 * agents/notifications "通知通道", "通知失败不影响业务").
 *
 * - Channels: site administrators create, change and remove them; the target (URL, signing secret, bot token) is
 *   sealed under the runtime KEK with the channel id as AAD and never returned — only the host (`targetHint`).
 * - Enqueue: `enqueueChannelNotifications(tx, …)` writes one delivery row per subscribed, enabled channel inside the
 *   caller's transaction (outbox): it commits with the event or not at all, and never calls the network.
 * - Delivery: `deliverDue(…)` claims due rows (`FOR UPDATE SKIP LOCKED`, the claim pushes `next_attempt_at` out as a
 *   lease), sends each outside the transaction, then records the outcome: `sent`, or a retry at
 *   `30 s · 2^(attempt-1)` (capped at one hour), or `failed` once `max_attempts` is reached or the failure is permanent
 *   (refused by the outbound boundary, a 4xx). The notification sweep runs this for every site.
 *
 * Nothing here throws into the business operation that produced the event: callers enqueue inside their own
 * transaction (a few inserts), and sending happens after commit or in the sweep.
 */
import { and, asc, count, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import { notificationChannels, notificationDeliveries, sites, type Database } from '@heopress/database';
import type { KeyProvider } from '@heopress/runtime';
import {
  NotificationTelegramTargetSchema,
  NotificationWebhookTargetSchema,
  type NotificationChannelCreateInput,
  type NotificationChannelKind,
  type NotificationChannelResource,
  type NotificationChannelTarget,
  type NotificationChannelUpdateInput,
  type NotificationDeliveryResource,
  type NotificationEventKind,
} from '@heopress/contracts/schemas';
import { formatSafeError } from '@heopress/contracts/utils';
import { AuditLogger } from '../../audit/logger';
import { openSecret, sealSecret } from '../../../services/crypto/secret-vault';
import { runSiteTransaction, type SiteTransaction } from '../../../services/rls-transaction';
import { sendToChannel, type ChannelMessage, type SenderOptions, type SendOutcome } from './senders';

type ChannelRow = typeof notificationChannels.$inferSelect;
type DeliveryRow = typeof notificationDeliveries.$inferSelect;

export const DEFAULT_MAX_ATTEMPTS = 6;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 60 * 60_000;
/** How long a claimed delivery is held before another sweep may take it again. */
const CLAIM_LEASE_MS = 2 * 60_000;

export class NotificationChannelError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 404 | 409 | 503,
  ) {
    super(message);
    this.name = 'NotificationChannelError';
  }
}

/** Backoff before attempt `attempt + 1`, after `attempt` failed attempts. */
export function backoffMs(attempt: number): number {
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, attempt - 1));
}

const aad = (channelId: string) => `notification-channel|${channelId}`;

/** Host of a target for display; never the path or query (WeCom / DingTalk keep their key there). */
function hintOf(kind: NotificationChannelKind, target: NotificationChannelTarget): string {
  if (kind === 'telegram') return 'api.telegram.org';
  try {
    return new URL((target as { url: string }).url).host;
  } catch {
    return '';
  }
}

function parseTarget(kind: NotificationChannelKind, raw: unknown): NotificationChannelTarget {
  const schema = kind === 'telegram' ? NotificationTelegramTargetSchema : NotificationWebhookTargetSchema;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new NotificationChannelError('VALIDATION', parsed.error.issues.map((i) => i.message).join('; '), 400);
  }
  return parsed.data;
}

async function withKey<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (err) {
    if (err instanceof Error && /no encryption key configured/i.test(err.message)) {
      throw new NotificationChannelError(
        'ENCRYPTION_NOT_CONFIGURED',
        'Notification channel secrets need the instance encryption key (ENCRYPTION_KEY): configure it and restart.',
        503,
      );
    }
    throw err;
  }
}

export interface ChannelServiceDeps {
  db: Database;
  siteId: string;
  keys: KeyProvider;
  userId?: string | null;
  /** Fallback base of Studio links (HEOPRESS_PUBLIC_URL). */
  publicUrl?: string | null;
  sender?: SenderOptions;
  now?: () => Date;
}

export class NotificationChannelService {
  constructor(private readonly deps: ChannelServiceDeps) {}

  private tx<T>(fn: (tx: SiteTransaction) => Promise<T>): Promise<T> {
    return runSiteTransaction(this.deps.db, this.deps.siteId, fn);
  }

  private audit(tx: SiteTransaction, event: string, metadata: Record<string, unknown>): Promise<void> {
    return new AuditLogger({ db: tx as unknown as Database, siteId: this.deps.siteId }).writeInTransaction(tx, {
      siteId: this.deps.siteId,
      event,
      metadata: { ...metadata, by: this.deps.userId ?? null },
    });
  }

  async list(): Promise<NotificationChannelResource[]> {
    return this.tx(async (tx) => {
      const rows = await tx
        .select()
        .from(notificationChannels)
        .where(eq(notificationChannels.siteId, this.deps.siteId))
        .orderBy(asc(notificationChannels.createdAt));
      const counts = await tx
        .select({ channelId: notificationDeliveries.channelId, status: notificationDeliveries.status, n: count() })
        .from(notificationDeliveries)
        .where(eq(notificationDeliveries.siteId, this.deps.siteId))
        .groupBy(notificationDeliveries.channelId, notificationDeliveries.status);
      return rows.map((r) => {
        const d = { pending: 0, sent: 0, failed: 0 };
        for (const c of counts) if (c.channelId === r.id && c.status in d) d[c.status as keyof typeof d] = Number(c.n);
        return { ...toResource(r), deliveries: d };
      });
    });
  }

  async get(id: string): Promise<NotificationChannelResource> {
    return this.tx(async (tx) => toResource(await this.row(tx, id)));
  }

  private async row(tx: SiteTransaction, id: string): Promise<ChannelRow> {
    const [row] = await tx
      .select()
      .from(notificationChannels)
      .where(and(eq(notificationChannels.siteId, this.deps.siteId), eq(notificationChannels.id, id)));
    if (!row) throw new NotificationChannelError('NOT_FOUND', 'Notification channel not found.', 404);
    return row;
  }

  async create(input: NotificationChannelCreateInput): Promise<NotificationChannelResource> {
    const id = crypto.randomUUID();
    const target = parseTarget(input.kind, input.target);
    const sealed = await withKey(() => sealSecret(this.deps.keys, JSON.stringify(target), aad(id)));
    try {
      return await this.tx(async (tx) => {
        const [row] = await tx
          .insert(notificationChannels)
          .values({
            id,
            siteId: this.deps.siteId,
            name: input.name,
            kind: input.kind,
            targetCiphertext: sealed.ciphertext,
            targetHint: hintOf(input.kind, target),
            events: [...new Set(input.events)],
            linkBaseUrl: input.linkBaseUrl ?? null,
            enabled: input.enabled ?? true,
            createdBy: this.deps.userId ?? null,
          })
          .returning();
        await this.audit(tx, 'notification_channel_created', { channelId: id, kind: input.kind });
        return toResource(row!);
      });
    } catch (err) {
      throw uniqueName(err) ?? err;
    }
  }

  async update(id: string, input: NotificationChannelUpdateInput): Promise<NotificationChannelResource> {
    let sealed: string | undefined;
    let hint: string | undefined;
    if (input.target !== undefined) {
      const current = await this.get(id);
      const target = parseTarget(current.kind, input.target);
      sealed = (await withKey(() => sealSecret(this.deps.keys, JSON.stringify(target), aad(id)))).ciphertext;
      hint = hintOf(current.kind, target);
    }
    try {
      return await this.tx(async (tx) => {
        await this.row(tx, id);
        const next: Partial<ChannelRow> = { updatedAt: new Date() };
        if (input.name !== undefined) next.name = input.name;
        if (input.events !== undefined) next.events = [...new Set(input.events)];
        if (input.linkBaseUrl !== undefined) next.linkBaseUrl = input.linkBaseUrl;
        if (input.enabled !== undefined) next.enabled = input.enabled;
        if (sealed) {
          next.targetCiphertext = sealed;
          next.targetHint = hint!;
        }
        const [row] = await tx
          .update(notificationChannels)
          .set(next)
          .where(and(eq(notificationChannels.siteId, this.deps.siteId), eq(notificationChannels.id, id)))
          .returning();
        await this.audit(tx, 'notification_channel_updated', {
          channelId: id,
          fields: Object.keys(input).filter((k) => (input as Record<string, unknown>)[k] !== undefined),
        });
        return toResource(row!);
      });
    } catch (err) {
      throw uniqueName(err) ?? err;
    }
  }

  async remove(id: string): Promise<void> {
    await this.tx(async (tx) => {
      await this.row(tx, id);
      await tx.delete(notificationChannels).where(and(eq(notificationChannels.siteId, this.deps.siteId), eq(notificationChannels.id, id)));
      await this.audit(tx, 'notification_channel_deleted', { channelId: id });
    });
  }

  /** Recent deliveries of the site (or of one channel), newest first. */
  async deliveries(channelId?: string, limit = 50): Promise<NotificationDeliveryResource[]> {
    return this.tx(async (tx) => {
      const rows = await tx
        .select()
        .from(notificationDeliveries)
        .where(
          channelId
            ? and(eq(notificationDeliveries.siteId, this.deps.siteId), eq(notificationDeliveries.channelId, channelId))
            : eq(notificationDeliveries.siteId, this.deps.siteId),
        )
        .orderBy(desc(notificationDeliveries.createdAt))
        .limit(Math.min(Math.max(limit, 1), 200));
      return rows.map(toDeliveryResource);
    });
  }

  /** Queue a test message to one channel and try it at once. */
  async test(id: string): Promise<NotificationDeliveryResource> {
    const deliveryId = await this.tx(async (tx) => {
      const ch = await this.row(tx, id);
      const [site] = await tx.select({ name: sites.name, title: sites.displayTitle }).from(sites).where(eq(sites.id, this.deps.siteId));
      const [row] = await tx
        .insert(notificationDeliveries)
        .values({
          siteId: this.deps.siteId,
          channelId: ch.id,
          event: 'test',
          message: { title: 'HeoPress test notification', severity: 'info', siteName: site?.title || site?.name || this.deps.siteId, path: '/settings/notifications' },
          maxAttempts: 1,
        })
        .returning({ id: notificationDeliveries.id });
      return row!.id;
    });
    await this.deliverDue({ ids: [deliveryId] });
    return this.tx(async (tx) => {
      const [row] = await tx.select().from(notificationDeliveries).where(and(eq(notificationDeliveries.siteId, this.deps.siteId), eq(notificationDeliveries.id, deliveryId)));
      return toDeliveryResource(row!);
    });
  }

  /**
   * Send the site's due deliveries (or only `ids`, when due). Never throws for a delivery failure: each outcome is
   * recorded on its row. Returns how many were sent, retried and failed.
   */
  async deliverDue(opts: { ids?: string[]; limit?: number } = {}): Promise<{ sent: number; retried: number; failed: number }> {
    const now = this.deps.now?.() ?? new Date();
    const out = { sent: 0, retried: 0, failed: 0 };
    if (opts.ids && opts.ids.length === 0) return out;
    const claimed = await this.tx(async (tx) => {
      const due = await tx
        .select({ d: notificationDeliveries, c: notificationChannels })
        .from(notificationDeliveries)
        .innerJoin(
          notificationChannels,
          and(eq(notificationChannels.siteId, notificationDeliveries.siteId), eq(notificationChannels.id, notificationDeliveries.channelId)),
        )
        .where(
          and(
            eq(notificationDeliveries.siteId, this.deps.siteId),
            eq(notificationDeliveries.status, 'pending'),
            lte(notificationDeliveries.nextAttemptAt, now),
            opts.ids ? inArray(notificationDeliveries.id, opts.ids) : undefined,
          ),
        )
        .orderBy(asc(notificationDeliveries.nextAttemptAt))
        .limit(opts.limit ?? 50)
        .for('update', { of: notificationDeliveries, skipLocked: true });
      if (due.length) {
        await tx
          .update(notificationDeliveries)
          .set({ attempts: sql`${notificationDeliveries.attempts} + 1`, nextAttemptAt: new Date(now.getTime() + CLAIM_LEASE_MS) })
          .where(and(eq(notificationDeliveries.siteId, this.deps.siteId), inArray(notificationDeliveries.id, due.map((r) => r.d.id))));
      }
      return due.map((r) => ({ d: { ...r.d, attempts: r.d.attempts + 1 }, c: r.c }));
    });

    for (const { d, c } of claimed) {
      const outcome = await this.sendOne(d, c);
      const done = outcome.ok;
      const final = !outcome.ok && (!outcome.retryable || d.attempts >= d.maxAttempts);
      await this.tx(async (tx) => {
        await tx
          .update(notificationDeliveries)
          .set(
            done
              ? { status: 'sent', sentAt: new Date(), lastError: null }
              : final
                ? { status: 'failed', lastError: outcome.error }
                : { lastError: outcome.error, nextAttemptAt: new Date(now.getTime() + backoffMs(d.attempts)) },
          )
          .where(and(eq(notificationDeliveries.siteId, this.deps.siteId), eq(notificationDeliveries.id, d.id)));
        if (final) {
          await this.audit(tx, 'notification_delivery_failed', { deliveryId: d.id, channelId: c.id, kind: c.kind, attempts: d.attempts, error: outcome.error });
        }
      });
      if (done) out.sent++;
      else if (final) out.failed++;
      else out.retried++;
    }
    return out;
  }

  private async sendOne(d: DeliveryRow, c: ChannelRow): Promise<SendOutcome> {
    if (!c.enabled) return { ok: false, retryable: false, error: 'channel_disabled' };
    let target: NotificationChannelTarget;
    try {
      // Validated when it was written; the outbound boundary checks the address again on every send.
      target = JSON.parse(await openSecret(this.deps.keys, c.targetCiphertext, aad(c.id))) as NotificationChannelTarget;
    } catch {
      return { ok: false, retryable: false, error: 'target_unreadable' };
    }
    const base = (c.linkBaseUrl ?? this.deps.publicUrl ?? '').replace(/\/+$/, '');
    const message: ChannelMessage = {
      id: d.id,
      event: d.event,
      title: d.message.title,
      severity: d.message.severity,
      siteName: d.message.siteName,
      link: base && d.message.path ? `${base}${d.message.path}` : null,
      ts: d.createdAt.toISOString(),
    };
    try {
      return await sendToChannel(c.kind as NotificationChannelKind, target, message, { ...this.deps.sender, now: this.deps.now });
    } catch (err) {
      // A sender bug — logged without the target (formatSafeError keeps only the error class and message).
      console.error('[notify] channel send failed', formatSafeError(err));
      return { ok: false, retryable: true, error: 'internal' };
    }
  }
}

/** What an event becomes in a channel: a summary and a Studio path. Never body text. */
export interface ChannelEvent {
  event: NotificationEventKind;
  title: string;
  severity: 'info' | 'warning' | 'critical';
  /** Studio-relative path, e.g. `/mission-control/inbox?entry=approval:<id>`. */
  path?: string | null;
}

/**
 * Write a delivery row for each enabled channel of the site subscribed to `e.event`, inside the caller's transaction.
 * Returns the new delivery ids (to try at once after commit).
 */
export async function enqueueChannelNotifications(tx: SiteTransaction, siteId: string, e: ChannelEvent): Promise<string[]> {
  const channels = await tx
    .select({ id: notificationChannels.id, events: notificationChannels.events })
    .from(notificationChannels)
    .where(and(eq(notificationChannels.siteId, siteId), eq(notificationChannels.enabled, true)));
  const targets = channels.filter((c) => Array.isArray(c.events) && c.events.includes(e.event));
  if (!targets.length) return [];
  const [site] = await tx.select({ name: sites.name, title: sites.displayTitle }).from(sites).where(eq(sites.id, siteId));
  const rows = await tx
    .insert(notificationDeliveries)
    .values(
      targets.map((c) => ({
        siteId,
        channelId: c.id,
        event: e.event,
        message: { title: e.title.slice(0, 200), severity: e.severity, siteName: site?.title || site?.name || siteId, path: e.path ?? null },
        maxAttempts: DEFAULT_MAX_ATTEMPTS,
      })),
    )
    .returning({ id: notificationDeliveries.id });
  return rows.map((r) => r.id);
}

/** The notification sweep: due deliveries of every site. */
export async function sweepNotificationDeliveries(deps: Omit<ChannelServiceDeps, 'siteId'>): Promise<{ sent: number; retried: number; failed: number }> {
  const total = { sent: 0, retried: 0, failed: 0 };
  for (const { id } of await deps.db.select({ id: sites.id }).from(sites)) {
    const r = await new NotificationChannelService({ ...deps, siteId: id }).deliverDue();
    total.sent += r.sent;
    total.retried += r.retried;
    total.failed += r.failed;
  }
  return total;
}

function toResource(r: ChannelRow): NotificationChannelResource {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind as NotificationChannelKind,
    targetHint: r.targetHint,
    events: (r.events ?? []) as NotificationEventKind[],
    linkBaseUrl: r.linkBaseUrl,
    enabled: r.enabled,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

function toDeliveryResource(r: DeliveryRow): NotificationDeliveryResource {
  return {
    id: r.id,
    channelId: r.channelId,
    event: r.event,
    title: r.message.title,
    status: r.status as NotificationDeliveryResource['status'],
    attempts: r.attempts,
    maxAttempts: r.maxAttempts,
    nextAttemptAt: r.nextAttemptAt.toISOString(),
    lastError: r.lastError,
    sentAt: r.sentAt ? r.sentAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
  };
}

function uniqueName(err: unknown): NotificationChannelError | null {
  for (let e: unknown = err, depth = 0; e && depth < 3; e = (e as { cause?: unknown }).cause, depth++) {
    if ((e as { code?: unknown }).code === '23505') {
      return new NotificationChannelError('NAME_TAKEN', 'A notification channel with this name already exists on this site.', 409);
    }
  }
  return null;
}
