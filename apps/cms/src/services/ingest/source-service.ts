import { and, desc, eq, sql } from 'drizzle-orm';
import {
  IngestLicenceRevisionSchema,
  IngestSourceCreateSchema,
  IngestSourceUpdateSchema,
  type FailureCategory,
  type IngestLicenceResource,
  type IngestSourceResource,
  type IngestSourceRunResource,
} from '@heopress/contracts/schemas';
import { ingestSchedule, ingestSourceLicences, ingestSourceRuns, ingestSources, notifications, roles, userSites, type Database } from '@heopress/database';
import { runSiteTransaction, type SiteTransaction } from '../rls-transaction';
import { nextRunAfter } from './schedule';
import { effectiveUsage, isLicenceEffective } from './usage';

/**
 * A site's content sources (HeoPress P08 tasks 1.1, 1.2, 1.4, 1.5; spec
 * ingest/sources).
 *
 * - Editors add, change and pause sources. A new source's terms are the
 *   defaults: licence `unknown`, `discovery_only`, not commercial, `low` trust.
 * - The terms change only through `reviseLicence`, which needs a site
 *   administrator and appends a revision with its evidence. This service is
 *   the only writer of the terms: nothing fetched or generated reaches them.
 * - Resuming a paused source is an administrator's decision (a source paused
 *   by the health check stays paused until then).
 * - The scheduler's row (`ingest_schedule`) follows the source: present with
 *   the next run while active, absent while paused.
 */

export class IngestSourceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 403 | 404 | 409,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export interface IngestActor {
  userId: string | null;
  apiKeyId?: string | null;
  /** Administrator of the site (decided by the caller from the permission bundle). */
  isAdmin: boolean;
}

type SourceRow = typeof ingestSources.$inferSelect;
type Tx = SiteTransaction;

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

function toSourceResource(r: SourceRow, now: Date = new Date()): IngestSourceResource {
  return {
    id: r.id,
    name: r.name,
    type: r.type as IngestSourceResource['type'],
    url: r.url,
    listSelectors: r.listSelectors ?? null,
    scheduleTimes: r.scheduleTimes,
    timezone: r.timezone,
    maxItemsPerRun: r.maxItemsPerRun,
    licenceStatus: r.licenceStatus as IngestSourceResource['licenceStatus'],
    usageMode: r.usageMode as IngestSourceResource['usageMode'],
    commercialUse: r.commercialUse,
    reviewDueAt: iso(r.reviewDueAt),
    trustLevel: r.trustLevel as IngestSourceResource['trustLevel'],
    attribution: r.attribution,
    licenceValidUntil: iso(r.licenceValidUntil),
    licenceEffective: isLicenceEffective(r, now),
    effectiveUsageMode: effectiveUsage(r, now),
    status: r.status as IngestSourceResource['status'],
    pausedReason: (r.pausedReason as IngestSourceResource['pausedReason']) ?? null,
    consecutiveFailures: r.consecutiveFailures,
    lastFailureCategory: (r.lastFailureCategory as FailureCategory | null) ?? null,
    lastFailureMessage: r.lastFailureMessage,
    lastRunAt: iso(r.lastRunAt),
    nextRunAt: iso(r.nextRunAt),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

const toLicence = (r: typeof ingestSourceLicences.$inferSelect): IngestLicenceResource => ({
  id: r.id,
  sourceId: r.sourceId,
  licenceStatus: r.licenceStatus as IngestLicenceResource['licenceStatus'],
  usageMode: r.usageMode as IngestLicenceResource['usageMode'],
  commercialUse: r.commercialUse,
  trustLevel: r.trustLevel as IngestLicenceResource['trustLevel'],
  evidence: r.evidence,
  scope: r.scope,
  validFrom: iso(r.validFrom),
  validUntil: iso(r.validUntil),
  reviewDueAt: iso(r.reviewDueAt),
  attribution: r.attribution,
  setBy: r.setBy,
  createdAt: r.createdAt.toISOString(),
});

const toRun = (r: typeof ingestSourceRuns.$inferSelect): IngestSourceRunResource => ({
  id: r.id,
  sourceId: r.sourceId,
  scheduledFor: r.scheduledFor.toISOString(),
  trigger: r.trigger as IngestSourceRunResource['trigger'],
  startedAt: r.startedAt.toISOString(),
  finishedAt: iso(r.finishedAt),
  outcome: r.outcome as IngestSourceRunResource['outcome'],
  failureCategory: (r.failureCategory as FailureCategory | null) ?? null,
  message: r.message,
  itemsFound: r.itemsFound,
});

function invalid(issues: Array<{ path: PropertyKey[]; message: string }>): IngestSourceError {
  return new IngestSourceError('VALIDATION', 'The source is not valid.', 400, issues.map((i) => ({ path: i.path.map(String), message: i.message })));
}

/** Keys of a source that only a licence revision may set. */
export const TERMS_KEYS = ['licenceStatus', 'usageMode', 'commercialUse', 'reviewDueAt', 'trustLevel', 'attribution', 'licenceValidFrom', 'licenceValidUntil'] as const;

export class IngestSourceService {
  constructor(private readonly deps: { db: Database; siteId: string; actor: IngestActor; now?: () => Date }) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return runSiteTransaction(this.deps.db, this.deps.siteId, fn);
  }

  private get actorId(): string | null {
    const a = this.deps.actor;
    return a.userId ?? (a.apiKeyId ? `api_key:${a.apiKeyId}` : null);
  }

  private requireAdmin(what: string): void {
    if (!this.deps.actor.isAdmin) throw new IngestSourceError('FORBIDDEN', `Only site administrators may ${what}.`, 403);
  }

  private async row(tx: Tx, id: string, lock = false): Promise<SourceRow> {
    const q = tx.select().from(ingestSources).where(and(eq(ingestSources.siteId, this.deps.siteId), eq(ingestSources.id, id)));
    const [row] = lock ? await q.for('update') : await q;
    if (!row) throw new IngestSourceError('NOT_FOUND', 'No such source.', 404);
    return row;
  }

  /** Bring the scheduler's row in line with the source: due at the next run while active, absent while paused. */
  private async syncSchedule(tx: Tx, row: SourceRow): Promise<Date | null> {
    if (row.status !== 'active') {
      await tx.delete(ingestSchedule).where(and(eq(ingestSchedule.siteId, row.siteId), eq(ingestSchedule.sourceId, row.id)));
      await tx.update(ingestSources).set({ nextRunAt: null }).where(and(eq(ingestSources.siteId, row.siteId), eq(ingestSources.id, row.id)));
      return null;
    }
    const next = nextRunAfter(row.scheduleTimes, row.timezone, this.now());
    await tx
      .insert(ingestSchedule)
      .values({ sourceId: row.id, siteId: row.siteId, nextRunAt: next })
      .onConflictDoUpdate({ target: ingestSchedule.sourceId, set: { nextRunAt: next } });
    await tx.update(ingestSources).set({ nextRunAt: next }).where(and(eq(ingestSources.siteId, row.siteId), eq(ingestSources.id, row.id)));
    return next;
  }

  async list(): Promise<IngestSourceResource[]> {
    const now = this.now();
    return this.tx(async (tx) =>
      (await tx.select().from(ingestSources).where(eq(ingestSources.siteId, this.deps.siteId)).orderBy(ingestSources.name)).map((r) => toSourceResource(r, now)),
    );
  }

  async get(id: string): Promise<IngestSourceResource> {
    return this.tx(async (tx) => toSourceResource(await this.row(tx, id), this.now()));
  }

  async create(input: unknown): Promise<IngestSourceResource> {
    const parsed = IngestSourceCreateSchema.safeParse(input);
    if (!parsed.success) throw invalid(parsed.error.issues);
    const v = parsed.data;
    const { siteId } = this.deps;
    return this.tx(async (tx) => {
      const [dup] = await tx.select({ id: ingestSources.id }).from(ingestSources).where(and(eq(ingestSources.siteId, siteId), eq(ingestSources.name, v.name)));
      if (dup) throw new IngestSourceError('CONFLICT', 'A source with this name exists.', 409);
      const [row] = await tx
        .insert(ingestSources)
        .values({
          siteId,
          name: v.name,
          type: v.type,
          url: v.url,
          listSelectors: v.type === 'list_page' ? (v.listSelectors ?? null) : null,
          scheduleTimes: v.scheduleTimes,
          timezone: v.timezone,
          ...(v.maxItemsPerRun ? { maxItemsPerRun: v.maxItemsPerRun } : {}),
          createdBy: this.actorId,
        })
        .returning();
      // The first revision: the defaults, set by whoever added the source.
      const [rev] = await tx
        .insert(ingestSourceLicences)
        .values({ siteId, sourceId: row!.id, licenceStatus: row!.licenceStatus, usageMode: row!.usageMode, commercialUse: row!.commercialUse, trustLevel: row!.trustLevel, setBy: this.actorId })
        .returning({ id: ingestSourceLicences.id });
      await tx.update(ingestSources).set({ licenceRevisionId: rev!.id }).where(and(eq(ingestSources.siteId, siteId), eq(ingestSources.id, row!.id)));
      await this.syncSchedule(tx, row!);
      return toSourceResource(await this.row(tx, row!.id), this.now());
    });
  }

  async update(id: string, input: unknown): Promise<IngestSourceResource> {
    const parsed = IngestSourceUpdateSchema.safeParse(input);
    if (!parsed.success) throw invalid(parsed.error.issues);
    const v = parsed.data;
    const { siteId } = this.deps;
    return this.tx(async (tx) => {
      const current = await this.row(tx, id, true);
      const type = v.type ?? current.type;
      const selectors = v.listSelectors !== undefined ? v.listSelectors : current.listSelectors;
      if (type === 'list_page' && !selectors) throw invalid([{ path: ['listSelectors'], message: 'A list page needs CSS selectors for its items and links.' }]);
      if (v.name && v.name !== current.name) {
        const [dup] = await tx.select({ id: ingestSources.id }).from(ingestSources).where(and(eq(ingestSources.siteId, siteId), eq(ingestSources.name, v.name)));
        if (dup) throw new IngestSourceError('CONFLICT', 'A source with this name exists.', 409);
      }
      const [row] = await tx
        .update(ingestSources)
        .set({
          ...(v.name !== undefined ? { name: v.name } : {}),
          ...(v.type !== undefined ? { type: v.type } : {}),
          ...(v.url !== undefined ? { url: v.url } : {}),
          listSelectors: type === 'list_page' ? (selectors ?? null) : null,
          ...(v.scheduleTimes !== undefined ? { scheduleTimes: v.scheduleTimes } : {}),
          ...(v.timezone !== undefined ? { timezone: v.timezone } : {}),
          ...(v.maxItemsPerRun !== undefined ? { maxItemsPerRun: v.maxItemsPerRun } : {}),
          updatedAt: this.now(),
        })
        .where(and(eq(ingestSources.siteId, siteId), eq(ingestSources.id, id)))
        .returning();
      if (v.scheduleTimes !== undefined || v.timezone !== undefined) await this.syncSchedule(tx, row!);
      return toSourceResource(await this.row(tx, id), this.now());
    });
  }

  /** Delete a source with its revisions and runs. Administrators only. */
  async remove(id: string): Promise<void> {
    this.requireAdmin('delete a source');
    await this.tx(async (tx) => {
      await this.row(tx, id, true);
      await tx.delete(ingestSources).where(and(eq(ingestSources.siteId, this.deps.siteId), eq(ingestSources.id, id)));
    });
  }

  /** Record new terms with their evidence (a new revision). Administrators only. */
  async reviseLicence(id: string, input: unknown): Promise<{ source: IngestSourceResource; licence: IngestLicenceResource }> {
    this.requireAdmin('change a source\'s licence, usage or trust');
    const parsed = IngestLicenceRevisionSchema.safeParse(input);
    if (!parsed.success) throw invalid(parsed.error.issues);
    const v = parsed.data;
    const date = (s: string | null | undefined) => (s ? new Date(s) : null);
    const { siteId } = this.deps;
    return this.tx(async (tx) => {
      await this.row(tx, id, true);
      const [rev] = await tx
        .insert(ingestSourceLicences)
        .values({
          siteId,
          sourceId: id,
          licenceStatus: v.licenceStatus,
          usageMode: v.usageMode,
          commercialUse: v.commercialUse,
          trustLevel: v.trustLevel,
          evidence: v.evidence ?? null,
          scope: v.scope ?? null,
          validFrom: date(v.validFrom),
          validUntil: date(v.validUntil),
          reviewDueAt: date(v.reviewDueAt),
          attribution: v.attribution ?? null,
          setBy: this.actorId,
          createdAt: this.now(),
        })
        .returning();
      await tx
        .update(ingestSources)
        .set({
          licenceStatus: v.licenceStatus,
          usageMode: v.usageMode,
          commercialUse: v.commercialUse,
          trustLevel: v.trustLevel,
          reviewDueAt: date(v.reviewDueAt),
          licenceValidFrom: date(v.validFrom),
          licenceValidUntil: date(v.validUntil),
          attribution: v.attribution ?? null,
          licenceRevisionId: rev!.id,
          updatedAt: this.now(),
        })
        .where(and(eq(ingestSources.siteId, siteId), eq(ingestSources.id, id)));
      return { source: toSourceResource(await this.row(tx, id), this.now()), licence: toLicence(rev!) };
    });
  }

  /** The licence revisions, newest first. */
  async licences(id: string): Promise<IngestLicenceResource[]> {
    return this.tx(async (tx) => {
      await this.row(tx, id);
      return (
        await tx
          .select()
          .from(ingestSourceLicences)
          .where(and(eq(ingestSourceLicences.siteId, this.deps.siteId), eq(ingestSourceLicences.sourceId, id)))
          .orderBy(desc(ingestSourceLicences.createdAt), desc(ingestSourceLicences.id))
      ).map(toLicence);
    });
  }

  /** The latest runs, newest first. */
  async runs(id: string, limit = 50): Promise<IngestSourceRunResource[]> {
    return this.tx(async (tx) => {
      await this.row(tx, id);
      return (
        await tx
          .select()
          .from(ingestSourceRuns)
          .where(and(eq(ingestSourceRuns.siteId, this.deps.siteId), eq(ingestSourceRuns.sourceId, id)))
          .orderBy(desc(ingestSourceRuns.startedAt))
          .limit(Math.min(Math.max(limit, 1), 200))
      ).map(toRun);
    });
  }

  async pause(id: string): Promise<IngestSourceResource> {
    return this.tx(async (tx) => {
      const current = await this.row(tx, id, true);
      if (current.status === 'paused') return toSourceResource(current, this.now());
      const [row] = await tx
        .update(ingestSources)
        .set({ status: 'paused', pausedReason: 'manual', updatedAt: this.now() })
        .where(and(eq(ingestSources.siteId, this.deps.siteId), eq(ingestSources.id, id)))
        .returning();
      await this.syncSchedule(tx, row!);
      return toSourceResource(await this.row(tx, id), this.now());
    });
  }

  /** Resume a paused source; its failure count starts again from zero. Administrators only. */
  async resume(id: string): Promise<IngestSourceResource> {
    this.requireAdmin('resume a source');
    return this.tx(async (tx) => {
      await this.row(tx, id, true);
      const [row] = await tx
        .update(ingestSources)
        .set({ status: 'active', pausedReason: null, consecutiveFailures: 0, updatedAt: this.now() })
        .where(and(eq(ingestSources.siteId, this.deps.siteId), eq(ingestSources.id, id)))
        .returning();
      await this.syncSchedule(tx, row!);
      return toSourceResource(await this.row(tx, id), this.now());
    });
  }
}

// ── Health (task 1.2) ────────────────────────────────────────────────────────

/** Consecutive failed runs after which a source is paused (HEOPRESS_INGEST_FAILURE_THRESHOLD). */
const DEFAULT_FAILURE_THRESHOLD = 5;

export function failureThreshold(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.HEOPRESS_INGEST_FAILURE_THRESHOLD);
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_FAILURE_THRESHOLD;
}

export type RunResult =
  | { outcome: 'succeeded'; itemsFound: number }
  | { outcome: 'failed'; category: FailureCategory; message?: string | null };

/**
 * Finish a run and update the source's health, inside the site's transaction:
 * a success resets the failure count; a failure adds one with its category,
 * and the failure that reaches `threshold` pauses the source and tells the
 * site's administrators why. Returns whether this call paused the source.
 */
export async function recordRunResult(
  tx: Tx,
  input: { siteId: string; sourceId: string; runId: string; result: RunResult; now: Date; threshold: number; generation?: number },
): Promise<{ paused: boolean; stale?: boolean }> {
  const { siteId, sourceId, runId, result, now } = input;
  const where = and(eq(ingestSources.siteId, siteId), eq(ingestSources.id, sourceId));
  // HeoPress P08 task 2.7: only the run's current owner (its generation, still running) records the result.
  const finished = await tx
    .update(ingestSourceRuns)
    .set(
      result.outcome === 'succeeded'
        ? { outcome: 'succeeded', finishedAt: now, itemsFound: result.itemsFound, leaseUntil: null }
        : { outcome: 'failed', finishedAt: now, failureCategory: result.category, message: result.message ?? null, leaseUntil: null },
    )
    .where(
      and(
        eq(ingestSourceRuns.siteId, siteId),
        eq(ingestSourceRuns.id, runId),
        ...(input.generation === undefined ? [] : [eq(ingestSourceRuns.generation, input.generation), eq(ingestSourceRuns.outcome, 'running')]),
      ),
    )
    .returning({ id: ingestSourceRuns.id });
  if (!finished.length) return { paused: false, stale: true };
  if (result.outcome === 'succeeded') {
    await tx.update(ingestSources).set({ consecutiveFailures: 0, lastFailureCategory: null, lastFailureMessage: null, lastRunAt: now }).where(where);
    return { paused: false };
  }
  const [row] = await tx
    .update(ingestSources)
    .set({
      consecutiveFailures: sql`${ingestSources.consecutiveFailures} + 1`,
      lastFailureCategory: result.category,
      lastFailureMessage: result.message ?? null,
      lastRunAt: now,
    })
    .where(where)
    .returning();
  if (!row || row.status !== 'active' || row.consecutiveFailures < input.threshold) return { paused: false };
  await tx.update(ingestSources).set({ status: 'paused', pausedReason: 'failures', nextRunAt: null, updatedAt: now }).where(where);
  await tx.delete(ingestSchedule).where(and(eq(ingestSchedule.siteId, siteId), eq(ingestSchedule.sourceId, sourceId)));
  await notifySiteAdmins(tx, siteId, {
    subject: `Source paused: ${row.name}`,
    message: `"${row.name}" failed ${row.consecutiveFailures} times in a row (last: ${result.category}${result.message ? ` — ${result.message}` : ''}) and was paused. Resume it from Content › Sources once the cause is fixed.`,
    item: sourceId,
  });
  return { paused: true };
}

/** One notification to each administrator of the site. */
async function notifySiteAdmins(tx: Tx, siteId: string, note: { subject: string; message: string; item: string }): Promise<void> {
  const admins = await tx
    .selectDistinct({ userId: userSites.userId })
    .from(userSites)
    .innerJoin(roles, eq(roles.id, userSites.roleId))
    .where(and(eq(userSites.siteId, siteId), eq(roles.adminAccess, true)));
  if (!admins.length) return;
  await tx.insert(notifications).values(admins.map((a) => ({ siteId, recipient: a.userId, subject: note.subject, message: note.message, collection: 'ingest_sources', item: note.item })));
}
