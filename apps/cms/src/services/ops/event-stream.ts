import { and, desc, eq, lt, sql, type SQL } from 'drizzle-orm';
import { auditLog, cdcChangeEvents, contentReviews, systemEvents, type Database } from '@heopress/database';
import { runSiteTransaction } from '../rls-transaction';

/**
 * The event stream of Logs & monitoring (HeoPress P07a tasks 11.3, 11.4, 11.6; spec ops/event-log). One shape over
 * several sources, each read through an adapter that also redacts (no IP, no user agent, no token; a key only by its last
 * four characters):
 *   - content: change events (`occurred_at`) and editorial reviews — a submission at its `created_at`, a decision at its
 *     `decided_at`, two events with their own ids (`review:<id>:submitted`, `review:<id>:approved|rejected`);
 *   - run, security, access, api_key: the site's audit log (`timestamp`);
 *   - system: instance events (`occurred_at`), for the bootstrap administrator only, read under `app.platform_reader`.
 * Newest first, keyset-paged by (time, source, id); `since` reads what came after a time, looking back 60 seconds so a
 * transaction committed late is not missed (the caller deduplicates by id).
 */

export type EventSource = 'content' | 'run' | 'security' | 'access' | 'api_key' | 'system';
export type EventLevel = 'info' | 'warn' | 'error';
export const EVENT_SOURCES: readonly EventSource[] = ['content', 'run', 'security', 'access', 'api_key', 'system'];

export interface StreamEvent {
  id: string;
  at: string;
  source: EventSource;
  level: EventLevel;
  event: string;
  message: string;
  /** Related object, when there is one (an item, a member, a job). */
  subject?: { type: string; id: string; collection?: string };
  actor?: string | null;
  data: Record<string, unknown>;
}

export interface EventFilter {
  levels?: EventLevel[];
  sources?: EventSource[];
  from?: Date;
  to?: Date;
  q?: string;
}

export interface EventPage {
  events: StreamEvent[];
  nextCursor: string | null;
  /** The oldest time any source still holds — earlier ones were removed by retention. */
  earliest: string | null;
  /**
   * Each source's oldest kept event (spec ops/event-log "超出保留期"): the sources keep events for different times, so
   * a window reaching past one source's retention says where that source's record begins. Absent: nothing kept.
   */
  earliestBySource: Partial<Record<EventSource, string>>;
}

export const SINCE_LOOKBACK_MS = 60_000;
const MAX_LIMIT = 200;

const REDACTED_KEYS = /^(ip|ipaddress|user_?agent|token|access_?token|refresh_?token|password|secret|authorization|cookie)$/i;

/** Remove addresses, agents and secrets from event data; a key is kept by its last four characters. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 5) return null;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (REDACTED_KEYS.test(k)) continue;
    if (/^(api_?key|key|plaintext)$/i.test(k) && typeof v === 'string') {
      out[k] = v.length > 4 ? `…${v.slice(-4)}` : '…';
      continue;
    }
    out[k] = redact(v, depth + 1);
  }
  return out;
}

/** Which source an audit-log event belongs to. */
export function sourceOfAuditEvent(event: string): EventSource {
  if (event === 'site_job_run' || event.startsWith('site_audit') || event.startsWith('reachability')) return 'run';
  if (event.startsWith('access_') || event.startsWith('public_access') || event.startsWith('member')) return 'access';
  if (event.startsWith('api_key') || event.startsWith('apikey')) return 'api_key';
  return 'security';
}

function levelOfAuditEvent(event: string, metadata: Record<string, unknown>): EventLevel {
  if (event === 'site_job_run') return metadata.status === 'succeeded' ? 'info' : 'error';
  if (/fail|denied|locked|blocked|refused|revoked/.test(event)) return 'warn';
  return 'info';
}

interface Cursor {
  at: string;
  source: string;
  id: string;
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify([c.at, c.source, c.id])).toString('base64url');
}

export function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const [at, source, id] = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as [string, string, string];
    if (typeof at !== 'string' || typeof source !== 'string' || typeof id !== 'string' || Number.isNaN(Date.parse(at))) return null;
    return { at, source, id };
  } catch {
    return null;
  }
}

/** Order: newest first; equal times by source, then id (descending). */
export function compareEvents(a: Pick<StreamEvent, 'at' | 'source' | 'id'>, b: Pick<StreamEvent, 'at' | 'source' | 'id'>): number {
  if (a.at !== b.at) return a.at < b.at ? 1 : -1;
  if (a.source !== b.source) return a.source < b.source ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

function afterCursor(e: StreamEvent, c: Cursor | null): boolean {
  return !c || compareEvents(e, { at: c.at, source: c.source as EventSource, id: c.id }) > 0;
}

/** Keyword match over message, event and subject; `a|b` matches either. */
function matchesText(e: StreamEvent, q: string | undefined): boolean {
  if (!q) return true;
  const hay = `${e.message}\n${e.event}\n${e.subject?.id ?? ''}`.toLowerCase();
  return q
    .toLowerCase()
    .split('|')
    .map((n) => n.trim())
    .filter(Boolean)
    .some((n) => hay.includes(n));
}

interface ReadWindow {
  from?: Date;
  to?: Date;
  /** Upper bound from the cursor (inclusive). */
  before?: Date;
  limit: number;
}

const iso = (d: Date) => d.toISOString();
function windowOf(col: SQL, w: ReadWindow): SQL | undefined {
  return and(
    w.from ? sql`${col} >= ${iso(w.from)}::timestamptz` : undefined,
    w.to ? sql`${col} < ${iso(w.to)}::timestamptz` : undefined,
    // The cursor's time has milliseconds, the rows microseconds: read to the end of its millisecond, so rows in the same
    // millisecond but older than the cursor are not lost; the cursor comparison then orders the ties (CI found the gap).
    w.before ? sql`${col} < ${iso(new Date(w.before.getTime() + 1))}::timestamptz` : undefined,
  );
}

async function contentEvents(db: Database, siteId: string, w: ReadWindow): Promise<StreamEvent[]> {
  return runSiteTransaction(db, siteId, async (tx) => {
    const changes = await tx
      .select({ id: cdcChangeEvents.id, at: cdcChangeEvents.occurredAt, collection: cdcChangeEvents.collection, itemId: cdcChangeEvents.itemId, operation: cdcChangeEvents.operation, actorType: cdcChangeEvents.actorType, actorId: cdcChangeEvents.actorId, changedFields: cdcChangeEvents.changedFields, resource: cdcChangeEvents.resource })
      .from(cdcChangeEvents)
      .where(and(eq(cdcChangeEvents.siteId, siteId), windowOf(sql`${cdcChangeEvents.occurredAt}`, w)))
      .orderBy(desc(cdcChangeEvents.occurredAt))
      .limit(w.limit);
    const submitted = await tx
      .select({ id: contentReviews.id, at: contentReviews.createdAt, itemId: contentReviews.itemId, by: contentReviews.requestedBy })
      .from(contentReviews)
      .where(and(eq(contentReviews.siteId, siteId), windowOf(sql`${contentReviews.createdAt}`, w)))
      .orderBy(desc(contentReviews.createdAt))
      .limit(w.limit);
    const decided = await tx
      .select({ id: contentReviews.id, at: contentReviews.decidedAt, itemId: contentReviews.itemId, status: contentReviews.status, by: contentReviews.decidedBy, reason: contentReviews.reason })
      .from(contentReviews)
      .where(and(eq(contentReviews.siteId, siteId), sql`${contentReviews.decidedAt} IS NOT NULL`, windowOf(sql`${contentReviews.decidedAt}`, w)))
      .orderBy(desc(contentReviews.decidedAt))
      .limit(w.limit);
    return [
      ...changes.map((c): StreamEvent => ({
        id: `change:${c.id}`,
        at: c.at.toISOString(),
        source: 'content',
        level: 'info',
        event: `item_${c.operation}`,
        message: `${c.collection}/${c.itemId}: ${c.operation}`,
        subject: { type: c.resource, id: c.itemId, collection: c.collection },
        actor: c.actorId,
        data: redact({ actorType: c.actorType, changedFields: c.changedFields }) as Record<string, unknown>,
      })),
      ...submitted.map((r): StreamEvent => ({
        id: `review:${r.id}:submitted`,
        at: r.at.toISOString(),
        source: 'content',
        level: 'info',
        event: 'review_submitted',
        message: `Submitted for review: ${r.itemId ?? 'deleted item'}`,
        subject: r.itemId ? { type: 'item', id: r.itemId } : undefined,
        actor: r.by,
        data: {},
      })),
      ...decided.map((r): StreamEvent => ({
        id: `review:${r.id}:${r.status}`,
        at: r.at!.toISOString(),
        source: 'content',
        level: r.status === 'rejected' ? 'warn' : 'info',
        event: `review_${r.status}`,
        message: `Review ${r.status}: ${r.itemId ?? 'deleted item'}`,
        subject: r.itemId ? { type: 'item', id: r.itemId } : undefined,
        actor: r.by,
        data: r.reason ? { reason: r.reason } : {},
      })),
    ];
  });
}

async function auditEvents(db: Database, siteId: string, w: ReadWindow): Promise<StreamEvent[]> {
  const rows = await runSiteTransaction(db, siteId, (tx) =>
    tx
      .select({ id: auditLog.id, at: auditLog.timestamp, event: auditLog.event, actor: auditLog.actorEmail, target: auditLog.targetEmail, metadata: auditLog.metadata })
      .from(auditLog)
      .where(and(eq(auditLog.siteId, siteId), windowOf(sql`${auditLog.timestamp}`, w)))
      .orderBy(desc(auditLog.timestamp))
      .limit(w.limit),
  );
  return rows.map((r) => {
    const metadata = (r.metadata ?? {}) as Record<string, unknown>;
    return {
      id: `audit:${r.id}`,
      at: r.at.toISOString(),
      source: sourceOfAuditEvent(r.event),
      level: levelOfAuditEvent(r.event, metadata),
      event: r.event,
      message:
        r.event === 'site_job_run' && typeof metadata.job === 'string'
          ? `${metadata.job}: ${String(metadata.status ?? '')}`
          : r.target
            ? `${r.event}: ${r.target}`
            : r.event,
      actor: r.actor,
      data: redact(metadata) as Record<string, unknown>,
    };
  });
}

async function systemEventsOf(db: Database, w: ReadWindow): Promise<StreamEvent[]> {
  return db.transaction(async (tx) => {
    // Set only after the server confirmed the caller is the bootstrap administrator (task 11.4).
    await tx.execute(sql`SELECT set_config('app.platform_reader', 'on', true)`);
    const rows = await tx
      .select()
      .from(systemEvents)
      .where(windowOf(sql`${systemEvents.occurredAt}`, w))
      .orderBy(desc(systemEvents.occurredAt))
      .limit(w.limit);
    return rows.map((r) => ({
      id: `system:${r.id}`,
      at: r.occurredAt.toISOString(),
      source: 'system' as const,
      level: r.level as EventLevel,
      event: r.event,
      message: r.message,
      actor: r.actor,
      data: redact(r.data) as Record<string, unknown>,
    }));
  });
}

export interface StreamScope {
  siteId: string;
  /** Instance events too (the bootstrap administrator). */
  platform: boolean;
}

/** Every event of the scope matching `filter` except its levels, newest first, at most `limit` per source. */
async function gather(db: Database, scope: StreamScope, filter: EventFilter, w: ReadWindow): Promise<StreamEvent[]> {
  const wanted = (s: EventSource) => !filter.sources?.length || filter.sources.includes(s);
  const reads: Array<Promise<StreamEvent[]>> = [];
  if (wanted('content')) reads.push(contentEvents(db, scope.siteId, w));
  if (wanted('run') || wanted('security') || wanted('access') || wanted('api_key')) reads.push(auditEvents(db, scope.siteId, w));
  if (scope.platform && wanted('system')) reads.push(systemEventsOf(db, w));
  const all = (await Promise.all(reads)).flat();
  return all.filter((e) => wanted(e.source) && matchesText(e, filter.q)).sort(compareEvents);
}

export async function readEvents(
  db: Database,
  scope: StreamScope,
  filter: EventFilter,
  page: { cursor?: string; since?: Date; limit?: number } = {},
): Promise<EventPage> {
  const limit = Math.min(Math.max(page.limit ?? 50, 1), MAX_LIMIT);
  const cursor = decodeCursor(page.cursor);
  const from = page.since ? new Date(Math.max(page.since.getTime() - SINCE_LOOKBACK_MS, filter.from?.getTime() ?? 0)) : filter.from;
  // Read enough of each source that the merge can fill a page past rows filtered out by level or text.
  const w: ReadWindow = { from, to: filter.to, before: cursor ? new Date(cursor.at) : undefined, limit: (limit + 1) * 4 };
  const merged = (await gather(db, scope, filter, w)).filter((e) => (!filter.levels?.length || filter.levels.includes(e.level)) && afterCursor(e, cursor));
  const events = merged.slice(0, limit);
  const last = events.at(-1);
  return {
    events,
    nextCursor: merged.length > limit && last ? encodeCursor({ at: last.at, source: last.source, id: last.id }) : null,
    ...(await earliestOf(db, scope).then((e) => ({ earliest: e.earliest, earliestBySource: e.bySource }))),
  };
}

async function earliestOf(db: Database, scope: StreamScope): Promise<{ earliest: string | null; bySource: Partial<Record<EventSource, string>> }> {
  const iso = (t: string | null | undefined) => (t ? new Date(t).toISOString() : null);
  const [a] = await runSiteTransaction(db, scope.siteId, (tx) =>
    tx.select({ t: sql<string | null>`min(${auditLog.timestamp})::text` }).from(auditLog).where(eq(auditLog.siteId, scope.siteId)),
  );
  const [c] = await runSiteTransaction(db, scope.siteId, (tx) =>
    tx.select({ t: sql<string | null>`min(${cdcChangeEvents.occurredAt})::text` }).from(cdcChangeEvents).where(eq(cdcChangeEvents.siteId, scope.siteId)),
  );
  const bySource: Partial<Record<EventSource, string>> = {};
  const audit = iso(a?.t);
  // Runs, security, member and key events are all read from the site's audit records.
  if (audit) for (const source of ['run', 'security', 'access', 'api_key'] as const) bySource[source] = audit;
  const content = iso(c?.t);
  if (content) bySource.content = content;
  if (scope.platform) {
    const [s] = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.platform_reader', 'on', true)`);
      return tx.select({ t: sql<string | null>`min(${systemEvents.occurredAt})::text` }).from(systemEvents);
    });
    const system = iso(s?.t);
    if (system) bySource.system = system;
  }
  const times = Object.values(bySource).sort();
  return { earliest: times[0] ?? null, bySource };
}

export interface EventStats {
  /** Per level — not narrowed by the level filter; narrowed by source, time and text. */
  levels: Record<EventLevel, number>;
  /** The last 60 minutes, per minute: all events and errors (every filter but the level). */
  minutes: Array<{ at: string; total: number; errors: number }>;
}

const STATS_CAP = 5000;

export async function eventStats(db: Database, scope: StreamScope, filter: EventFilter, now = new Date()): Promise<EventStats> {
  const levelsWindow: ReadWindow = { from: filter.from ?? new Date(now.getTime() - 24 * 3_600_000), to: filter.to, limit: STATS_CAP };
  const forLevels = await gather(db, scope, { ...filter, levels: undefined }, levelsWindow);
  const levels: Record<EventLevel, number> = { info: 0, warn: 0, error: 0 };
  for (const e of forLevels) levels[e.level] += 1;
  const start = new Date(Math.floor(now.getTime() / 60_000) * 60_000 - 59 * 60_000);
  const recent = await gather(db, scope, { ...filter, levels: undefined, from: start, to: undefined }, { from: start, limit: STATS_CAP });
  const minutes = Array.from({ length: 60 }, (_, i) => ({ at: new Date(start.getTime() + i * 60_000).toISOString(), total: 0, errors: 0 }));
  for (const e of recent) {
    const slot = Math.floor((Date.parse(e.at) - start.getTime()) / 60_000);
    if (slot < 0 || slot >= 60) continue;
    minutes[slot]!.total += 1;
    if (e.level === 'error') minutes[slot]!.errors += 1;
  }
  return { levels, minutes };
}

/** Instance events older than 90 days removed, in a transaction that set `app.retention` (task 11.4). */
const SYSTEM_EVENT_RETENTION_DAYS = 90;

export async function purgeSystemEvents(db: Database, now = new Date()): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.retention', 'on', true)`);
    const cutoff = new Date(now.getTime() - SYSTEM_EVENT_RETENTION_DAYS * 86_400_000);
    const removed = await tx.delete(systemEvents).where(lt(systemEvents.occurredAt, cutoff)).returning({ id: systemEvents.id });
    return removed.length;
  });
}
