import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  LicenceReviewResolveSchema,
  type LicenceLapsePolicy,
  type LicenceReviewResource,
  type UsageOperation,
} from '@heopress/contracts/schemas';
import { collections, contentProvenance, ingestSourceDocuments, ingestSources, items, licenceLapseReviews, sites, type Database } from '@heopress/database';
import { appendItemEvent } from '../../modules/cdc/change-feed/outbox-writer';
import { runItemWriteTransaction, runSiteTransaction, type SiteTransaction } from '../rls-transaction';
import { syncContentRoute } from '../site-network/content-routes';
import { assertMayPublishInGroup, assertMembershipUnchanged, itemLocale, lockMembership } from '../site-network/translation-groups';
import { siteSettingsOf } from './site-settings';
import { IngestSourceError, notifySiteAdmins } from './source-service';
import { assertUsageAllowed } from './usage';

/**
 * Published derivative content when its source's licence lapses (HeoPress P08 task 1.6; spec ingest/sources
 * "授权失效后的已发布内容"; design "信源使用方式与授权失效").
 *
 * The link: `lumibase_content_provenance` says an item was derived from a source document by an operation
 * (`recordDerivation`, called by the processing pipeline, P09). An item's derivation **lapses** when the usage
 * contract (`usage.ts`) no longer allows that operation with the source's current terms — the licence expired, its
 * review is overdue, it has not started, or the terms were revoked (a revision that no longer grants the use).
 *
 * `sweepLicenceLapses` (scheduled) finds published items with a lapsed derivation and applies the site's policy, once
 * per item, source and licence revision:
 *
 *   - `hide` (default): in one item-write transaction the item goes to `draft` and on hold (no publishing path can put
 *     it back: publish-guard, scheduler), its route is synced, its change event is appended (ADR-0011) and the public
 *     projection is flushed before the commit — the page, the sitemap, feeds and llms files lose it, the render version
 *     moves (page cache), IndexNow is told and the Astro build consumer sees the event. A review row is opened and the
 *     site's administrators get the withdrawal notice.
 *   - `flag`: the item stays public; a review row is opened and the administrators are told.
 *
 * Restoring (`resolveReviews`) is a person's decision, item by item or in bulk, and only once every source the item
 * derives from allows its operation again: the status, editorial state and hold from before are put back in one
 * transaction with the change event. A renewed licence alone never republishes anything.
 */

type Tx = SiteTransaction;

type LapseReason = 'licence_expired' | 'review_overdue' | 'licence_not_started' | 'licence_unknown' | 'revoked';

/** Record that `itemId` was derived from `sourceDocumentId` by `operation` (the processing pipeline, P09). */
export async function recordDerivation(
  db: Database,
  input: { siteId: string; itemId: string; sourceDocumentId: string; operation: UsageOperation },
): Promise<void> {
  await runSiteTransaction(db, input.siteId, async (tx) => {
    const [doc] = await tx
      .select({ sourceId: ingestSourceDocuments.sourceId })
      .from(ingestSourceDocuments)
      .where(and(eq(ingestSourceDocuments.siteId, input.siteId), eq(ingestSourceDocuments.id, input.sourceDocumentId)));
    if (!doc) throw new IngestSourceError('NOT_FOUND', 'No such source document.', 404);
    await tx
      .insert(contentProvenance)
      .values({ siteId: input.siteId, itemId: input.itemId, sourceDocumentId: input.sourceDocumentId, sourceId: doc.sourceId, operation: input.operation })
      .onConflictDoNothing();
  });
}

type SourceRow = typeof ingestSources.$inferSelect;

/** Why the source's current terms no longer allow `operation`, or null when they do. */
function lapseReason(source: SourceRow, operation: string, now: Date): LapseReason | null {
  const decision = assertUsageAllowed(source, operation as UsageOperation, now);
  if (decision.allowed) return null;
  switch (decision.reason) {
    case 'licence_expired':
    case 'review_overdue':
    case 'licence_not_started':
    case 'licence_unknown':
      return decision.reason;
    default:
      // The terms no longer grant the use at all: an administrator revoked it.
      return 'revoked';
  }
}

interface Derivation {
  itemId: string;
  source: SourceRow;
  operation: string;
}

/** Every derivation of the given items (or of all items of the site), with the source's current terms. */
async function derivationsOf(tx: Tx, siteId: string, itemIds?: string[]): Promise<Derivation[]> {
  const rows = await tx
    .select({ itemId: contentProvenance.itemId, operation: contentProvenance.operation, source: ingestSources })
    .from(contentProvenance)
    .innerJoin(ingestSources, and(eq(ingestSources.siteId, contentProvenance.siteId), eq(ingestSources.id, contentProvenance.sourceId)))
    .where(and(eq(contentProvenance.siteId, siteId), ...(itemIds ? [inArray(contentProvenance.itemId, itemIds)] : [])));
  return rows;
}

export interface LapseSweepResult {
  hidden: string[];
  flagged: string[];
}

/** One site: find published items with a lapsed derivation and apply the site's policy. */
async function sweepSiteLicenceLapses(deps: { db: Database; now?: () => Date }, siteId: string): Promise<LapseSweepResult> {
  const now = deps.now?.() ?? new Date();
  const out: LapseSweepResult = { hidden: [], flagged: [] };
  const candidates = await runSiteTransaction(deps.db, siteId, async (tx) => {
    const lapsed = new Map<string, { source: SourceRow; reason: LapseReason }>();
    for (const d of await derivationsOf(tx, siteId)) {
      if (lapsed.has(d.itemId)) continue;
      const reason = lapseReason(d.source, d.operation, now);
      if (reason) lapsed.set(d.itemId, { source: d.source, reason });
    }
    if (!lapsed.size) return [];
    const published = await tx
      .select({ id: items.id })
      .from(items)
      .where(and(eq(items.siteId, siteId), inArray(items.id, [...lapsed.keys()]), eq(items.status, 'published'), sql`${items.deletedAt} IS NULL`));
    return published.map((p) => ({ itemId: p.id, ...lapsed.get(p.id)! }));
  });
  if (!candidates.length) return out;
  const { licenceLapsePolicy: policy } = await runSiteTransaction(deps.db, siteId, (tx) => siteSettingsOf(tx, siteId));
  for (const c of candidates) {
    const done = await applyLapse(deps.db, siteId, c, policy, now);
    if (done === 'hidden') out.hidden.push(c.itemId);
    if (done === 'flagged') out.flagged.push(c.itemId);
  }
  return out;
}

/** Every site in turn. */
export async function sweepLicenceLapses(deps: { db: Database; now?: () => Date }): Promise<LapseSweepResult> {
  const out: LapseSweepResult = { hidden: [], flagged: [] };
  for (const { id } of await deps.db.select({ id: sites.id }).from(sites)) {
    const r = await sweepSiteLicenceLapses(deps, id);
    out.hidden.push(...r.hidden);
    out.flagged.push(...r.flagged);
  }
  return out;
}

async function applyLapse(
  db: Database,
  siteId: string,
  c: { itemId: string; source: SourceRow; reason: LapseReason },
  policy: LicenceLapsePolicy,
  now: Date,
): Promise<'hidden' | 'flagged' | null> {
  return runItemWriteTransaction(db, siteId, async (tx) => {
    const [item] = await tx
      .select({ id: items.id, status: items.status, editorialState: items.editorialState, hold: items.hold, data: items.data, collection: collections.name })
      .from(items)
      .innerJoin(collections, eq(collections.id, items.collectionId))
      .where(and(eq(items.siteId, siteId), eq(items.id, c.itemId)))
      .for('update', { of: items });
    if (!item || item.status !== 'published') return null;
    // Once per item, source and licence revision: a person's decision on this lapse stands until the terms change.
    const [seen] = await tx
      .select({ id: licenceLapseReviews.id })
      .from(licenceLapseReviews)
      .where(
        and(
          eq(licenceLapseReviews.siteId, siteId),
          eq(licenceLapseReviews.itemId, c.itemId),
          sql`(${licenceLapseReviews.state} = 'open' OR (${licenceLapseReviews.sourceId} = ${c.source.id} AND ${licenceLapseReviews.licenceRevisionId} IS NOT DISTINCT FROM ${c.source.licenceRevisionId}))`,
        ),
      )
      .limit(1);
    if (seen) return null;
    const title = typeof (item.data as Record<string, unknown>)?.title === 'string' ? String((item.data as Record<string, unknown>).title) : c.itemId;
    const action = policy === 'flag' ? 'flagged' : 'hidden';
    const [review] = await tx
      .insert(licenceLapseReviews)
      .values({
        siteId,
        itemId: c.itemId,
        sourceId: c.source.id,
        licenceRevisionId: c.source.licenceRevisionId,
        reason: c.reason,
        action,
        previousStatus: item.status,
        previousEditorialState: item.editorialState,
        previousHold: item.hold,
        detectedAt: now,
      })
      .returning({ id: licenceLapseReviews.id });
    if (action === 'hidden') {
      const [changed] = await tx
        .update(items)
        .set({ status: 'draft', editorialState: item.editorialState === null ? null : 'draft', hold: true, version: sql`${items.version} + 1`, updatedAt: now })
        .where(and(eq(items.siteId, siteId), eq(items.id, c.itemId)))
        .returning({ version: items.version });
      await syncContentRoute(tx, siteId, c.itemId, { wasPublished: true });
      await appendItemEvent(tx, {
        siteId,
        collection: item.collection,
        itemId: c.itemId,
        itemVersion: changed!.version,
        changedFields: ['status', 'hold'],
        source: 'system',
        payload: { reason: 'licence_lapse', lapse: c.reason, sourceId: c.source.id, reviewId: review!.id },
      });
      await notifySiteAdmins(tx, siteId, {
        subject: `Withdrawn: ${title}`,
        message: `"${title}" was taken off the public site because the licence of its source "${c.source.name}" lapsed (${c.reason}). It stays hidden until a person with rights confirms it again under Content › Sources › Licence review, once the licence is effective.`,
        item: c.itemId,
        collection: item.collection,
      });
    } else {
      await notifySiteAdmins(tx, siteId, {
        subject: `Licence review needed: ${title}`,
        message: `The licence of the source "${c.source.name}" behind "${title}" lapsed (${c.reason}). The site keeps it public (policy: flag); review it under Content › Sources › Licence review.`,
        item: c.itemId,
        collection: item.collection,
      });
    }
    return action;
  });
}

// ── the review queue ─────────────────────────────────────────────────────────

export class LicenceReviewService {
  constructor(private readonly deps: { db: Database; siteId: string; actor: { userId: string | null; person: boolean }; now?: () => Date }) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  async list(state: 'open' | 'all' = 'open'): Promise<LicenceReviewResource[]> {
    const { siteId } = this.deps;
    const now = this.now();
    return runSiteTransaction(this.deps.db, siteId, async (tx) => {
      const rows = await tx
        .select({ review: licenceLapseReviews, collection: collections.name, data: items.data, sourceName: ingestSources.name })
        .from(licenceLapseReviews)
        .innerJoin(items, eq(items.id, licenceLapseReviews.itemId))
        .innerJoin(collections, eq(collections.id, items.collectionId))
        .leftJoin(ingestSources, and(eq(ingestSources.siteId, licenceLapseReviews.siteId), eq(ingestSources.id, licenceLapseReviews.sourceId)))
        .where(and(eq(licenceLapseReviews.siteId, siteId), ...(state === 'open' ? [eq(licenceLapseReviews.state, 'open')] : [])))
        .orderBy(desc(licenceLapseReviews.detectedAt))
        .limit(500);
      const derivations = await derivationsOf(tx, siteId, [...new Set(rows.map((r) => r.review.itemId))]);
      return rows.map(({ review: r, collection, data, sourceName }) => ({
        id: r.id,
        itemId: r.itemId,
        collection,
        title: typeof (data as Record<string, unknown>)?.title === 'string' ? String((data as Record<string, unknown>).title) : null,
        sourceId: r.sourceId,
        sourceName: sourceName ?? null,
        reason: r.reason as LicenceReviewResource['reason'],
        action: r.action as LicenceReviewResource['action'],
        state: r.state as LicenceReviewResource['state'],
        licenceEffective: derivations.filter((d) => d.itemId === r.itemId).every((d) => lapseReason(d.source, d.operation, now) === null),
        detectedAt: r.detectedAt.toISOString(),
        resolvedAt: r.resolvedAt?.toISOString() ?? null,
        resolvedBy: r.resolvedBy,
      }));
    });
  }

  /**
   * Restore or dismiss open reviews. Restoring needs a person (not an API key, not an agent) and every derivation of
   * the item allowed again; each review is its own transaction, so one refusal does not undo the others.
   */
  async resolve(input: unknown): Promise<{ resolved: string[]; refused: Array<{ id: string; code: string; message: string }> }> {
    const parsed = LicenceReviewResolveSchema.safeParse(input);
    if (!parsed.success) throw new IngestSourceError('VALIDATION', 'Invalid review decision.', 400, parsed.error.issues);
    if (!this.deps.actor.person || !this.deps.actor.userId) {
      throw new IngestSourceError('PERSON_REQUIRED', 'Only a person with rights on the site can confirm licence reviews; API keys and agents cannot.', 403);
    }
    const out: { resolved: string[]; refused: Array<{ id: string; code: string; message: string }> } = { resolved: [], refused: [] };
    for (const id of [...new Set(parsed.data.ids)]) {
      try {
        await this.resolveOne(id, parsed.data.decision);
        out.resolved.push(id);
      } catch (err) {
        if (err instanceof IngestSourceError) out.refused.push({ id, code: err.code, message: err.message });
        else if (err instanceof Error && 'code' in err && typeof (err as { code: unknown }).code === 'string') {
          out.refused.push({ id, code: (err as { code: string }).code, message: err.message });
        } else throw err;
      }
    }
    return out;
  }

  private async resolveOne(id: string, decision: 'restore' | 'dismiss'): Promise<void> {
    const { siteId } = this.deps;
    const now = this.now();
    await runItemWriteTransaction(this.deps.db, siteId, async (tx) => {
      const [review] = await tx
        .select()
        .from(licenceLapseReviews)
        .where(and(eq(licenceLapseReviews.siteId, siteId), eq(licenceLapseReviews.id, id)))
        .for('update');
      if (!review) throw new IngestSourceError('NOT_FOUND', 'No such review.', 404);
      if (review.state !== 'open') throw new IngestSourceError('ALREADY_RESOLVED', 'This review is already resolved.', 409);
      const close = (state: 'restored' | 'dismissed') =>
        tx
          .update(licenceLapseReviews)
          .set({ state, resolvedAt: now, resolvedBy: this.deps.actor.userId })
          .where(and(eq(licenceLapseReviews.siteId, siteId), eq(licenceLapseReviews.id, id)));
      if (decision === 'dismiss') {
        await close('dismissed');
        return;
      }
      const blocked = (await derivationsOf(tx, siteId, [review.itemId])).map((d) => lapseReason(d.source, d.operation, now)).find((r) => r !== null);
      if (blocked) throw new IngestSourceError('LICENCE_NOT_EFFECTIVE', `The source's licence is not effective (${blocked}): renew it before restoring.`, 409);
      if (review.action === 'hidden') {
        const [item] = await tx
          .select({ status: items.status, data: items.data, collection: collections.name, deletedAt: items.deletedAt })
          .from(items)
          .innerJoin(collections, eq(collections.id, items.collectionId))
          .where(and(eq(items.siteId, siteId), eq(items.id, review.itemId)))
          .for('update', { of: items });
        if (!item || item.deletedAt) throw new IngestSourceError('NOT_FOUND', 'The item no longer exists.', 404);
        const republish = review.previousStatus === 'published';
        const group = republish ? await lockMembership(tx, siteId, review.itemId) : null;
        if (group) await assertMayPublishInGroup(tx, group, await itemLocale(tx, siteId, item.data));
        const [changed] = await tx
          .update(items)
          .set({ status: review.previousStatus, editorialState: review.previousEditorialState, hold: review.previousHold, version: sql`${items.version} + 1`, updatedAt: now })
          .where(and(eq(items.siteId, siteId), eq(items.id, review.itemId)))
          .returning({ version: items.version });
        if (group) await assertMembershipUnchanged(tx, siteId, review.itemId, group);
        await syncContentRoute(tx, siteId, review.itemId, { wasPublished: item.status === 'published' });
        await appendItemEvent(tx, {
          siteId,
          collection: item.collection,
          itemId: review.itemId,
          itemVersion: changed!.version,
          changedFields: ['status', 'hold'],
          actor: { type: 'user', id: this.deps.actor.userId },
          source: 'api',
          payload: { reason: 'licence_restored', reviewId: id },
        });
      }
      await close('restored');
    });
  }
}

/** Whether an item has an open licence review that hid it (its hold may then only be released by restoring it). */
export async function hasOpenLicenceHold(tx: Tx, siteId: string, itemId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: licenceLapseReviews.id })
    .from(licenceLapseReviews)
    .where(and(eq(licenceLapseReviews.siteId, siteId), eq(licenceLapseReviews.itemId, itemId), eq(licenceLapseReviews.state, 'open'), eq(licenceLapseReviews.action, 'hidden')))
    .limit(1);
  return Boolean(row);
}
