import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { UsageOperation } from '@heopress/contracts/schemas';
import {
  agentAutonomyGrants,
  agentFreezes,
  aiProductions,
  autoPublishCandidates,
  autoPublishDays,
  autoPublishSettings,
  contentProvenance,
  ingestSourceDocuments,
  ingestSources,
  items,
  qualityGateResults,
  type Database,
} from '@heopress/database';
import { AuditLogger } from '../../modules/audit/logger';
import { AutonomyService, resolveAutonomy, type AutonomyLevel } from '../autonomy-service';
import { hashData } from '../content-version-service';
import { assertUsageAllowed } from '../ingest/usage';
import { ItemServiceError } from '../item-service-error';
import { itemServiceForSystem } from '../item-service-factory';
import { dayOf, nextDayStart } from '../llm/daily';
import { siteTimezone } from '../llm/pipeline-control';
import type { PublishProposal, PublishProposer } from '../pipeline/extension-points';
import { QualityGate, type GateState } from '../quality-gate/quality-gate';
import { runSiteTransaction, type SiteTransaction } from '../rls-transaction';
import { lockContentSettingsShared } from '../site-network/content-routes';
import { localeSetOf } from './locale-set';

/**
 * Auto-publish (HeoPress P09 tasks 3.1–3.7; spec ai/auto-publish; design decision 5).
 *
 * A drafted production is **proposed**: it publishes on its own only when all of these hold —
 *   - every source it derives from is trusted (`trust_level = high`) with a cleared licence (`licensed`, `own`,
 *     `open-license`) whose current terms still allow the operation (`assertUsageAllowed`); `unknown` never passes;
 *   - the quality gate's current result for this very version is publishable (`QualityGate.currentIn`);
 *   - every source is fresh: published within the site's `source_max_age_days` (default 60) unless the collection is
 *     exempt — a source of unknown age is not fresh;
 *   - the trust tier of the site's pipeline role on the `publish` capability (LumiBase L0–L4 grants) is L3 or L4;
 *   - neither the kill switch (site freeze, or a freeze of the role) nor a Hold stands in the way.
 * Anything else lands in the **review queue** with the reason. L3 opens a **veto window** (default 30 minutes, one-click
 * veto); L4 is queued for now. Queued candidates publish under the site's **cadence** (daily limit, minimum interval,
 * the site's local day); the excess waits.
 *
 * A candidate pins what it was decided on (item version and content hash, gate result, licence revisions, tier,
 * settings version). The **final publish transaction** checks everything again under locks — the candidate rows, the
 * day's counter row — and reserves the cadence slot in the same transaction, so a person's edit, a revoked licence, a
 * lower tier, a changed policy or a concurrent publish never lets a stale approval through: the candidate goes back to
 * review instead. Members of the site's required language set publish together in that transaction, or not at all.
 */

type Tx = SiteTransaction;
type CandidateRow = typeof autoPublishCandidates.$inferSelect;

const PUBLISH_CAPABILITY = 'publish';
const CLEARED_LICENCES = new Set(['licensed', 'own', 'open-license']);
const TRUSTED_LEVEL = 'high';
const DAY_MS = 86_400_000;

export class AutoPublishError extends Error {
  constructor(public code: string, message: string, public status: 400 | 403 | 404 | 409 | 422 = 400) {
    super(message);
    this.name = 'AutoPublishError';
  }
}

export interface AutoPublishSettingsView {
  agentRole: string;
  vetoWindowMinutes: number;
  dailyLimit: number | null;
  minIntervalMinutes: number;
  sourceMaxAgeDays: number;
  freshnessExemptCollections: string[];
  requiredLocales: string[];
  /** 0 until first saved. */
  version: number;
}

const DEFAULT_SETTINGS: AutoPublishSettingsView = {
  agentRole: 'content-pipeline',
  vetoWindowMinutes: 30,
  dailyLimit: null,
  minIntervalMinutes: 0,
  sourceMaxAgeDays: 60,
  freshnessExemptCollections: [],
  requiredLocales: [],
  version: 0,
};

async function autoPublishSettingsIn(tx: Tx, siteId: string): Promise<AutoPublishSettingsView> {
  const [row] = await tx.select().from(autoPublishSettings).where(eq(autoPublishSettings.siteId, siteId));
  if (!row) return { ...DEFAULT_SETTINGS };
  return {
    agentRole: row.agentRole,
    vetoWindowMinutes: row.vetoWindowMinutes,
    dailyLimit: row.dailyLimit,
    minIntervalMinutes: row.minIntervalMinutes,
    sourceMaxAgeDays: row.sourceMaxAgeDays,
    freshnessExemptCollections: row.freshnessExemptCollections,
    requiredLocales: row.requiredLocales,
    version: row.version,
  };
}

/** One condition that does not hold. The first one found is the candidate's reason. */
export interface ConditionFailure {
  reason: string;
  detail?: Record<string, unknown>;
}

/** What a decision is based on (pinned by a candidate). */
interface Snapshot {
  itemVersion: number;
  contentHash: string;
  gateResultId: string | null;
  licenceRevisions: Record<string, string | null>;
  autonomyLevel: AutonomyLevel;
}

/** The gate's view of an item; replaceable in tests. */
export type GateCheck = (tx: Tx, siteId: string, itemId: string) => Promise<Pick<GateState, 'state' | 'publishable' | 'staleReasons'> & { result: { id: string } | null }>;

const builtInGate: GateCheck = (tx, siteId, itemId) => new QualityGate({ db: tx as unknown as Database, siteId }).currentIn(tx, itemId);

// ── pure helpers ──────────────────────────────────────────────────────

/** The cadence decision for `n` publishes at `now`: go, or the earliest time to try again. */
export function cadenceSlot(input: {
  now: Date;
  timeZone: string;
  dailyLimit: number | null;
  minIntervalMinutes: number;
  publishedToday: number;
  lastPublishedAt: Date | null;
  n: number;
}): { ok: true } | { ok: false; reason: 'cadence_daily_limit' | 'cadence_min_interval'; notBefore: Date } {
  if (input.dailyLimit !== null && input.publishedToday + input.n > input.dailyLimit) {
    return { ok: false, reason: 'cadence_daily_limit', notBefore: nextDayStart(input.now, input.timeZone) };
  }
  if (input.lastPublishedAt && input.minIntervalMinutes > 0) {
    const next = input.lastPublishedAt.getTime() + input.minIntervalMinutes * 60_000;
    if (next > input.now.getTime()) return { ok: false, reason: 'cadence_min_interval', notBefore: new Date(next) };
  }
  return { ok: true };
}

/** Whether a source published at `publishedAt` is fresh at `now` (null: unknown age, not fresh). */
export function isSourceFresh(publishedAt: Date | null, now: Date, maxAgeDays: number): boolean {
  return publishedAt !== null && now.getTime() - publishedAt.getTime() <= maxAgeDays * DAY_MS;
}

/** The decision a tier makes on a proposal that meets every other condition. */
export function tierDecision(level: AutonomyLevel): 'review_queue' | 'veto_window' | 'immediate' {
  return level >= 4 ? 'immediate' : level === 3 ? 'veto_window' : 'review_queue';
}

// ── the service ───────────────────────────────────────────────────────

export interface AutoPublisherDeps {
  db: Database;
  siteId: string;
  now?: () => Date;
  /** Default: the quality gate's current state. */
  gate?: GateCheck;
}

export type PublishOutcome = 'published' | 'deferred' | 'waiting' | 'review' | 'skipped';

export class AutoPublisher {
  constructor(private readonly deps: AutoPublisherDeps) {}

  private get siteId() {
    return this.deps.siteId;
  }
  private now() {
    return this.deps.now?.() ?? new Date();
  }
  private tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return runSiteTransaction(this.deps.db, this.siteId, fn);
  }
  private audit(tx: Tx, event: string, metadata: Record<string, unknown>) {
    return new AuditLogger({ db: tx as unknown as Database, siteId: this.siteId }).writeInTransaction(tx, { siteId: this.siteId, event, metadata });
  }

  /** The pipeline's `propose publish` extension point. */
  asProposer(): PublishProposer {
    return { propose: async (req) => this.propose({ productionId: req.productionId, collection: req.collection, itemId: req.itemId }) };
  }

  // ── conditions ──────────────────────────────────────────────────────

  private async tierIn(tx: Tx, role: string): Promise<AutonomyLevel> {
    const [grant] = await tx
      .select({ level: agentAutonomyGrants.level, expiresAt: agentAutonomyGrants.expiresAt })
      .from(agentAutonomyGrants)
      .where(and(eq(agentAutonomyGrants.siteId, this.siteId), eq(agentAutonomyGrants.agentRole, role), eq(agentAutonomyGrants.capability, PUBLISH_CAPABILITY)));
    const level = grant && (!grant.expiresAt || grant.expiresAt > this.now()) ? grant.level : null;
    // Publishing makes content public: dangerous (no grant → L1).
    return resolveAutonomy({ grantLevel: level, dangerous: true });
  }

  private async frozenIn(tx: Tx, role: string): Promise<boolean> {
    const rows = await tx
      .select({ scope: agentFreezes.scope, targetRole: agentFreezes.targetRole })
      .from(agentFreezes)
      .where(and(eq(agentFreezes.siteId, this.siteId), isNull(agentFreezes.liftedAt)));
    return rows.some((r) => r.scope === 'site' || (r.scope === 'role' && r.targetRole === role));
  }

  /**
   * Every condition for publishing `itemId` now, read inside `tx`; with `pinned`, also that nothing changed since the
   * candidate was decided. Returns the failures (empty: may publish) and what the decision is based on.
   */
  async evaluateIn(tx: Tx, input: { itemId: string; collection: string; settings: AutoPublishSettingsView; pinned?: CandidateRow }): Promise<{ failures: ConditionFailure[]; snapshot: Snapshot | null }> {
    const { settings, pinned } = input;
    const now = this.now();
    const failures: ConditionFailure[] = [];
    if (await this.frozenIn(tx, settings.agentRole)) failures.push({ reason: 'kill_switch' });
    const [item] = await tx
      .select({ data: items.data, version: items.version, status: items.status, hold: items.hold, deletedAt: items.deletedAt })
      .from(items)
      .where(and(eq(items.siteId, this.siteId), eq(items.id, input.itemId)));
    if (!item || item.deletedAt) return { failures: [...failures, { reason: 'item_gone' }], snapshot: null };
    if (item.status === 'published') failures.push({ reason: 'already_published' });
    if (item.hold) failures.push({ reason: 'hold' });
    const contentHash = hashData(item.data as Record<string, unknown>);
    if (pinned && (pinned.itemVersion !== item.version || pinned.contentHash !== contentHash)) failures.push({ reason: 'content_changed', detail: { pinned: pinned.itemVersion, now: item.version } });

    const gate = await (this.deps.gate ?? builtInGate)(tx, this.siteId, input.itemId);
    if (!gate.publishable) failures.push({ reason: 'gate_not_passed', detail: { state: gate.state, staleReasons: gate.staleReasons } });
    else if (pinned && pinned.gateResultId !== (gate.result?.id ?? null)) failures.push({ reason: 'gate_changed' });

    const sources = await tx
      .select({
        documentId: contentProvenance.sourceDocumentId,
        operation: contentProvenance.operation,
        source: ingestSources,
        publishedAt: ingestSourceDocuments.publishedAt,
      })
      .from(contentProvenance)
      .innerJoin(ingestSources, and(eq(ingestSources.siteId, contentProvenance.siteId), eq(ingestSources.id, contentProvenance.sourceId)))
      .leftJoin(ingestSourceDocuments, and(eq(ingestSourceDocuments.siteId, contentProvenance.siteId), eq(ingestSourceDocuments.id, contentProvenance.sourceDocumentId)))
      .where(and(eq(contentProvenance.siteId, this.siteId), eq(contentProvenance.itemId, input.itemId)));
    const licenceRevisions: Record<string, string | null> = {};
    if (!sources.length) failures.push({ reason: 'no_sources' });
    const exempt = settings.freshnessExemptCollections.includes(input.collection);
    for (const s of sources) {
      licenceRevisions[s.documentId] = s.source.licenceRevisionId ?? null;
      const detail = { sourceId: s.source.id, sourceDocumentId: s.documentId };
      if (s.source.licenceStatus === 'unknown') failures.push({ reason: 'licence_unknown', detail });
      else if (!CLEARED_LICENCES.has(s.source.licenceStatus)) failures.push({ reason: 'licence_not_cleared', detail: { ...detail, licenceStatus: s.source.licenceStatus } });
      if (s.source.trustLevel !== TRUSTED_LEVEL) failures.push({ reason: 'source_not_trusted', detail: { ...detail, trustLevel: s.source.trustLevel } });
      const usage = assertUsageAllowed(s.source, s.operation as UsageOperation, now);
      if (!usage.allowed) failures.push({ reason: 'usage_refused', detail: { ...detail, refusal: usage.reason } });
      if (!exempt && !isSourceFresh(s.publishedAt ?? null, now, settings.sourceMaxAgeDays)) {
        failures.push({ reason: 'source_stale', detail: { ...detail, publishedAt: s.publishedAt?.toISOString() ?? null, maxAgeDays: settings.sourceMaxAgeDays } });
      }
    }
    if (pinned) {
      const before = pinned.licenceRevisions;
      const keys = new Set([...Object.keys(before), ...Object.keys(licenceRevisions)]);
      if ([...keys].some((k) => before[k] !== licenceRevisions[k])) failures.push({ reason: 'licence_changed' });
    }

    const level = await this.tierIn(tx, settings.agentRole);
    if (level < 3) failures.push({ reason: `tier_l${level}` });
    if (pinned && level < pinned.autonomyLevel) failures.push({ reason: 'tier_downgraded', detail: { pinned: pinned.autonomyLevel, now: level } });
    if (pinned && pinned.settingsVersion !== settings.version) failures.push({ reason: 'policy_changed' });

    return { failures, snapshot: { itemVersion: item.version, contentHash, gateResultId: gate.result?.id ?? null, licenceRevisions, autonomyLevel: level } };
  }

  // ── proposing ───────────────────────────────────────────────────────

  /** Decide on a drafted item: review queue, veto window, or queued for now (and published when the cadence allows). */
  async propose(input: { productionId?: string | null; collection: string; itemId: string }): Promise<PublishProposal> {
    const decided = await this.tx(async (tx) => {
      const settings = await autoPublishSettingsIn(tx, this.siteId);
      const { failures, snapshot } = await this.evaluateIn(tx, { itemId: input.itemId, collection: input.collection, settings });
      if (input.productionId) {
        const [prod] = await tx.select({ mode: aiProductions.mode }).from(aiProductions).where(and(eq(aiProductions.siteId, this.siteId), eq(aiProductions.id, input.productionId)));
        // A retranslation is a draft revision of a live translation: a person promotes it.
        if (prod?.mode === 'retranslate') failures.unshift({ reason: 'retranslation_needs_review' });
      }
      // A newer proposal replaces an open one of the item.
      await tx
        .update(autoPublishCandidates)
        .set({ status: 'superseded', updatedAt: this.now() })
        .where(and(eq(autoPublishCandidates.siteId, this.siteId), eq(autoPublishCandidates.itemId, input.itemId), inArray(autoPublishCandidates.status, ['review', 'veto_window', 'queued'])));
      const tier = snapshot ? tierDecision(snapshot.autonomyLevel) : 'review_queue';
      const status = failures.length ? 'review' : tier === 'veto_window' ? 'veto_window' : 'queued';
      const reason = failures[0]?.reason ?? (status === 'veto_window' ? 'veto_window' : 'tier_l4');
      const notBefore = status === 'veto_window' ? new Date(this.now().getTime() + settings.vetoWindowMinutes * 60_000) : status === 'queued' ? this.now() : null;
      const [row] = await tx
        .insert(autoPublishCandidates)
        .values({
          siteId: this.siteId,
          productionId: input.productionId ?? null,
          collection: input.collection,
          itemId: input.itemId,
          itemVersion: snapshot?.itemVersion ?? 0,
          contentHash: snapshot?.contentHash ?? '',
          gateResultId: snapshot?.gateResultId ?? null,
          licenceRevisions: snapshot?.licenceRevisions ?? {},
          autonomyLevel: snapshot?.autonomyLevel ?? 0,
          settingsVersion: settings.version,
          status,
          reason,
          detail: { failures },
          notBefore,
        })
        .returning();
      await this.audit(tx, 'auto_publish_proposed', { candidateId: row!.id, itemId: input.itemId, status, reason, autonomyLevel: snapshot?.autonomyLevel ?? null });
      return row!;
    });
    const itemVersion = decided.itemVersion;
    if (decided.status === 'review') return { decision: 'review_queue', reason: decided.reason, itemVersion };
    if (decided.status === 'veto_window') return { decision: 'veto_window', reason: decided.reason, itemVersion };
    const outcome = await this.tryPublish(decided.id);
    if (outcome === 'published') return { decision: 'published', reason: 'tier_l4', itemVersion };
    if (outcome === 'review') {
      const [now] = await this.tx((tx) => tx.select({ reason: autoPublishCandidates.reason }).from(autoPublishCandidates).where(eq(autoPublishCandidates.id, decided.id)));
      return { decision: 'review_queue', reason: now?.reason ?? 'review', itemVersion };
    }
    return { decision: 'scheduled', reason: 'queued', itemVersion };
  }

  // ── the final publish ───────────────────────────────────────────────

  private async toReview(tx: Tx, c: CandidateRow, failure: ConditionFailure, failures: ConditionFailure[] = [failure]): Promise<void> {
    await tx
      .update(autoPublishCandidates)
      .set({ status: 'review', reason: failure.reason, detail: { ...c.detail, failures, returnedAt: this.now().toISOString() }, notBefore: null, updatedAt: this.now() })
      .where(eq(autoPublishCandidates.id, c.id));
    await this.audit(tx, 'auto_publish_to_review', { candidateId: c.id, itemId: c.itemId, reason: failure.reason });
  }

  private isDue(c: CandidateRow, now: Date): boolean {
    if (c.status !== 'queued' && c.status !== 'veto_window') return false;
    return !c.notBefore || c.notBefore.getTime() <= now.getTime();
  }

  /**
   * Publish one due candidate (with its required language set) if everything still holds, in one transaction: the
   * candidates and the day's counter are locked, every condition is checked again, the cadence slot is reserved and
   * the items are published together. Otherwise the candidate waits (cadence, other languages) or goes to review.
   */
  async tryPublish(candidateId: string): Promise<PublishOutcome> {
    let failed: { code: string; ids: string[] } | null = null;
    const outcome = await this.tx(async (tx): Promise<PublishOutcome> => {
      const now = this.now();
      await lockContentSettingsShared(tx, this.siteId);
      const [seen] = await tx.select().from(autoPublishCandidates).where(and(eq(autoPublishCandidates.siteId, this.siteId), eq(autoPublishCandidates.id, candidateId)));
      if (!seen) return 'skipped';
      const settings = await autoPublishSettingsIn(tx, this.siteId);
      const set = await localeSetOf(tx, this.siteId, seen.itemId);
      // Every candidate of the set, locked in id order.
      const memberIds = set ? set.members.map((m) => m.itemId) : [seen.itemId];
      const open = await tx
        .select()
        .from(autoPublishCandidates)
        .where(and(eq(autoPublishCandidates.siteId, this.siteId), inArray(autoPublishCandidates.itemId, memberIds), inArray(autoPublishCandidates.status, ['veto_window', 'queued'])))
        .orderBy(asc(autoPublishCandidates.id))
        .for('update');
      const self = open.find((c) => c.id === candidateId);
      if (!self) return 'skipped';
      if (!this.isDue(self, now)) return 'waiting';

      const group: CandidateRow[] = [self];
      if (set) {
        const waitingFor = [...set.missing];
        for (const m of set.members) {
          if (m.itemId === self.itemId) continue;
          const c = open.find((o) => o.itemId === m.itemId);
          if (m.status === 'published') continue;
          if (!c || !this.isDue(c, now)) waitingFor.push(m.locale);
          else group.push(c);
        }
        if (waitingFor.length) {
          await tx.update(autoPublishCandidates).set({ reason: 'waiting_for_locales', detail: { ...self.detail, waitingFor }, updatedAt: now }).where(eq(autoPublishCandidates.id, self.id));
          return 'waiting';
        }
      }

      // Every condition, again, for every member.
      let anyFailed = false;
      for (const c of group) {
        const { failures } = await this.evaluateIn(tx, { itemId: c.itemId, collection: c.collection, settings, pinned: c });
        if (failures.length) {
          anyFailed = true;
          await this.toReview(tx, c, failures[0]!, failures);
        }
      }
      if (anyFailed) {
        if (group.length > 1) {
          // The others wait: the set publishes together or not at all.
          for (const c of group) await tx.update(autoPublishCandidates).set({ reason: 'waiting_for_locales', updatedAt: now }).where(and(eq(autoPublishCandidates.id, c.id), inArray(autoPublishCandidates.status, ['veto_window', 'queued'])));
        }
        return group.some((c) => c.id === self.id) && (await this.statusOf(tx, self.id)) === 'review' ? 'review' : 'waiting';
      }

      // The cadence slot, reserved under the day's row lock.
      const timeZone = await siteTimezone(tx, this.siteId);
      const day = dayOf(now, timeZone);
      await tx.insert(autoPublishDays).values({ siteId: this.siteId, day }).onConflictDoNothing();
      const dayKey = and(eq(autoPublishDays.siteId, this.siteId), eq(autoPublishDays.day, day));
      const [today] = await tx.select().from(autoPublishDays).where(dayKey).for('update');
      const [last] = await tx
        .select({ at: autoPublishDays.lastPublishedAt })
        .from(autoPublishDays)
        .where(and(eq(autoPublishDays.siteId, this.siteId), sql`${autoPublishDays.lastPublishedAt} IS NOT NULL`))
        .orderBy(desc(autoPublishDays.lastPublishedAt))
        .limit(1);
      if (settings.dailyLimit !== null && group.length > settings.dailyLimit) {
        for (const c of group) await this.toReview(tx, c, { reason: 'set_exceeds_daily_limit' });
        return 'review';
      }
      const slot = cadenceSlot({ now, timeZone, dailyLimit: settings.dailyLimit, minIntervalMinutes: settings.minIntervalMinutes, publishedToday: today?.published ?? 0, lastPublishedAt: last?.at ?? null, n: group.length });
      if (!slot.ok) {
        for (const c of group) {
          await tx.update(autoPublishCandidates).set({ status: 'queued', reason: slot.reason, notBefore: slot.notBefore, updatedAt: now }).where(eq(autoPublishCandidates.id, c.id));
        }
        return 'deferred';
      }

      // Publish, together.
      const writer = itemServiceForSystem({ db: tx as unknown as Database, siteId: this.siteId, provenance: { authorType: 'agent', runId: null }, localeSetWrite: true }, 'background-worker');
      try {
        for (const c of group) await writer.patch(c.collection, c.itemId, { status: 'published', expectedVersion: c.itemVersion });
      } catch (err) {
        failed = { code: err instanceof ItemServiceError ? err.code : err instanceof Error ? err.name : 'PUBLISH_FAILED', ids: group.map((c) => c.id) };
        throw err;
      }
      await tx
        .update(autoPublishDays)
        .set({ published: sql`${autoPublishDays.published} + ${group.length}`, lastPublishedAt: now, updatedAt: now })
        .where(dayKey);
      for (const c of group) {
        await tx.update(autoPublishCandidates).set({ status: 'published', reason: 'published', publishedAt: now, updatedAt: now }).where(eq(autoPublishCandidates.id, c.id));
        await this.audit(tx, 'auto_publish_published', { candidateId: c.id, itemId: c.itemId, itemVersion: c.itemVersion, autonomyLevel: c.autonomyLevel, set: group.length > 1 ? group.map((g) => g.itemId) : undefined });
      }
      return 'published';
    }).catch(async (err: unknown) => {
      if (!failed) throw err;
      // The publish itself was refused (a hold set meanwhile, the language taken in the group, …): back to review.
      const f = failed as { code: string; ids: string[] };
      await this.tx(async (tx) => {
        const rows = await tx.select().from(autoPublishCandidates).where(and(eq(autoPublishCandidates.siteId, this.siteId), inArray(autoPublishCandidates.id, f.ids))).for('update');
        for (const c of rows) if (c.status === 'queued' || c.status === 'veto_window') await this.toReview(tx, c, { reason: 'publish_refused', detail: { code: f.code } });
      });
      return 'review' as const;
    });
    return outcome;
  }

  private async statusOf(tx: Tx, id: string): Promise<string | null> {
    const [row] = await tx.select({ status: autoPublishCandidates.status }).from(autoPublishCandidates).where(eq(autoPublishCandidates.id, id));
    return row?.status ?? null;
  }

  /** Every due candidate of the site (window over, or queued and its time come), oldest first. */
  async processDue(limit = 200): Promise<Record<PublishOutcome, number>> {
    const now = this.now();
    const due = await this.tx((tx) =>
      tx
        .select({ id: autoPublishCandidates.id })
        .from(autoPublishCandidates)
        .where(
          and(
            eq(autoPublishCandidates.siteId, this.siteId),
            inArray(autoPublishCandidates.status, ['veto_window', 'queued']),
            or(isNull(autoPublishCandidates.notBefore), lte(autoPublishCandidates.notBefore, now)),
          ),
        )
        .orderBy(asc(autoPublishCandidates.createdAt), asc(autoPublishCandidates.id))
        .limit(limit),
    );
    const counts: Record<PublishOutcome, number> = { published: 0, deferred: 0, waiting: 0, review: 0, skipped: 0 };
    for (const { id } of due) counts[await this.tryPublish(id)]++;
    return counts;
  }

  // ── people ──────────────────────────────────────────────────────────

  /**
   * One-click veto inside the window (or while still queued): nothing is published, the candidate returns to the
   * review queue with the vetoer recorded, and — as every LumiBase veto — an incident feeds the tier's demotion.
   */
  async veto(candidateId: string, userId: string, reason?: string): Promise<CandidateRow> {
    return this.tx(async (tx) => {
      const [c] = await tx.select().from(autoPublishCandidates).where(and(eq(autoPublishCandidates.siteId, this.siteId), eq(autoPublishCandidates.id, candidateId))).for('update');
      if (!c) throw new AutoPublishError('NOT_FOUND', 'No such candidate.', 404);
      if (c.status !== 'veto_window' && c.status !== 'queued') throw new AutoPublishError('NOT_VETOABLE', `The candidate is ${c.status}: only a pending publish can be vetoed.`, 409);
      const now = this.now();
      const [row] = await tx
        .update(autoPublishCandidates)
        .set({ status: 'review', reason: 'vetoed', decidedBy: userId, decidedAt: now, notBefore: null, detail: { ...c.detail, vetoReason: reason ?? null }, updatedAt: now })
        .where(eq(autoPublishCandidates.id, c.id))
        .returning();
      await this.audit(tx, 'auto_publish_vetoed', { candidateId: c.id, itemId: c.itemId, by: userId, reason: reason ?? null });
      const settings = await autoPublishSettingsIn(tx, this.siteId);
      await new AutonomyService({ db: tx as unknown as Database, siteId: this.siteId }).recordIncident({
        agentRole: settings.agentRole,
        capability: PUBLISH_CAPABILITY,
        source: 'veto',
        severity: 'low',
        detail: { candidateId: c.id, itemId: c.itemId, reason: reason ?? null },
      });
      return row!;
    });
  }

  /** A person closes a review entry (handled by hand, or not to be published). */
  async dismiss(candidateId: string, userId: string, reason: string): Promise<CandidateRow> {
    return this.tx(async (tx) => {
      const [c] = await tx.select().from(autoPublishCandidates).where(and(eq(autoPublishCandidates.siteId, this.siteId), eq(autoPublishCandidates.id, candidateId))).for('update');
      if (!c) throw new AutoPublishError('NOT_FOUND', 'No such candidate.', 404);
      if (c.status !== 'review') throw new AutoPublishError('NOT_IN_REVIEW', 'Only review entries are dismissed; veto a pending publish.', 409);
      const now = this.now();
      const [row] = await tx
        .update(autoPublishCandidates)
        .set({ status: 'dismissed', decidedBy: userId, decidedAt: now, detail: { ...c.detail, dismissReason: reason }, updatedAt: now })
        .where(eq(autoPublishCandidates.id, c.id))
        .returning();
      await this.audit(tx, 'auto_publish_dismissed', { candidateId: c.id, itemId: c.itemId, by: userId, reason });
      return row!;
    });
  }

  async list(filter: { status?: string; limit?: number } = {}): Promise<CandidateRow[]> {
    return this.tx((tx) =>
      tx
        .select()
        .from(autoPublishCandidates)
        .where(and(eq(autoPublishCandidates.siteId, this.siteId), filter.status ? eq(autoPublishCandidates.status, filter.status) : undefined))
        .orderBy(desc(autoPublishCandidates.createdAt))
        .limit(Math.min(500, filter.limit ?? 100)),
    );
  }

  async get(id: string): Promise<CandidateRow> {
    const [row] = await this.tx((tx) => tx.select().from(autoPublishCandidates).where(and(eq(autoPublishCandidates.siteId, this.siteId), eq(autoPublishCandidates.id, id))));
    if (!row) throw new AutoPublishError('NOT_FOUND', 'No such candidate.', 404);
    return row;
  }

  settings(): Promise<AutoPublishSettingsView> {
    return this.tx((tx) => autoPublishSettingsIn(tx, this.siteId));
  }

  /** Change the settings (site administrators; audited). Every open candidate decided under the old version goes back to review at its final check. */
  async updateSettings(patch: Partial<Omit<AutoPublishSettingsView, 'version'>>, userId: string | null): Promise<AutoPublishSettingsView> {
    const check = (ok: boolean, msg: string) => {
      if (!ok) throw new AutoPublishError('VALIDATION', msg, 422);
    };
    if (patch.vetoWindowMinutes !== undefined) check(Number.isInteger(patch.vetoWindowMinutes) && patch.vetoWindowMinutes >= 1 && patch.vetoWindowMinutes <= 7 * 24 * 60, 'The veto window is 1 minute to 7 days.');
    if (patch.dailyLimit !== undefined && patch.dailyLimit !== null) check(Number.isInteger(patch.dailyLimit) && patch.dailyLimit >= 0, 'The daily limit is a whole number ≥ 0, or null.');
    if (patch.minIntervalMinutes !== undefined) check(Number.isInteger(patch.minIntervalMinutes) && patch.minIntervalMinutes >= 0, 'The minimum interval is a whole number of minutes ≥ 0.');
    if (patch.sourceMaxAgeDays !== undefined) check(Number.isInteger(patch.sourceMaxAgeDays) && patch.sourceMaxAgeDays >= 1, 'The source age limit is at least 1 day.');
    return this.tx(async (tx) => {
      const before = await autoPublishSettingsIn(tx, this.siteId);
      const next = { ...before, ...patch, version: before.version + 1 };
      const values = {
        agentRole: next.agentRole,
        vetoWindowMinutes: next.vetoWindowMinutes,
        dailyLimit: next.dailyLimit,
        minIntervalMinutes: next.minIntervalMinutes,
        sourceMaxAgeDays: next.sourceMaxAgeDays,
        freshnessExemptCollections: [...new Set(next.freshnessExemptCollections)],
        requiredLocales: [...new Set(next.requiredLocales.map((l) => l.trim()).filter(Boolean))],
        version: next.version,
        updatedBy: userId,
        updatedAt: this.now(),
      };
      await tx.insert(autoPublishSettings).values({ siteId: this.siteId, ...values }).onConflictDoUpdate({ target: autoPublishSettings.siteId, set: values });
      await this.audit(tx, 'auto_publish_settings_changed', { before, after: values, by: userId });
      return autoPublishSettingsIn(tx, this.siteId);
    });
  }
}

/** Every site's due candidates (the scheduler tick). One site's failure does not stop the others. */
export async function runDueAutoPublish(db: Database, now = new Date()): Promise<number> {
  const rows = await db
    .selectDistinct({ siteId: autoPublishCandidates.siteId })
    .from(autoPublishCandidates)
    .where(and(inArray(autoPublishCandidates.status, ['veto_window', 'queued']), or(isNull(autoPublishCandidates.notBefore), lte(autoPublishCandidates.notBefore, now))));
  let published = 0;
  for (const { siteId } of rows) {
    try {
      published += (await new AutoPublisher({ db, siteId, now: () => now }).processDue()).published;
    } catch (err) {
      console.warn('[auto-publish] due run failed', { siteId, err: String(err) });
    }
  }
  return published;
}

/** Whether an item has AI provenance or gate results (then a person's exception still needs the gate). */
export async function isAiDerived(tx: Tx, siteId: string, itemId: string): Promise<boolean> {
  const [p] = await tx.select({ id: contentProvenance.id }).from(contentProvenance).where(and(eq(contentProvenance.siteId, siteId), eq(contentProvenance.itemId, itemId))).limit(1);
  if (p) return true;
  const [g] = await tx.select({ id: qualityGateResults.id }).from(qualityGateResults).where(and(eq(qualityGateResults.siteId, siteId), eq(qualityGateResults.itemId, itemId))).limit(1);
  return !!g;
}
