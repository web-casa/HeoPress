import { and, asc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import {
  autoPublishCandidates,
  collections,
  contentProvenance,
  ingestSnapshots,
  ingestSourceDocuments,
  items,
  retentionHolds,
  sites,
  type Database,
} from '@heopress/database';
import type { StorageProvider } from '@heopress/runtime';
import { appendItemEvent } from '../../modules/cdc/change-feed/outbox-writer';
import { notifySiteAdmins } from '../ingest/source-service';
import { runItemWriteTransaction, runSiteTransaction } from '../rls-transaction';
import { DAY_MS } from './policy';

/**
 * Raw fetch snapshots past their retention period (HeoPress P13 task 5.1; spec ops/data-retention "默认保留期限",
 * ingest/crawling "快照按数据保留规则合法清理后…墓碑").
 *
 * A snapshot older than the period (by its last write: a refetch of the same content keeps it) is examined against the
 * references that **block** clean-up:
 *
 * - `pending_review` — content derived from one of its documents (`lumibase_content_provenance`) not yet published, or
 *   with an auto-publish candidate still in `review` / `veto_window` / `queued`;
 * - `open_dispute` — an open retention hold on the snapshot, or an open licence review of derived content;
 * - `in_progress` — a processing job of one of its documents not yet handed over, or an AI production using one of its
 *   documents still `running` / `retry_scheduled`.
 *
 * Without a blocking reference its content is deleted and the row stays as a **tombstone** (hash, deletion time,
 * reason; the documents keep their extraction rule version): references for audit — the provenance of published
 * content — keep pointing at it. A blocked snapshot is taken up again on a later run, once the blockers are gone.
 *
 * A personal-data deletion request (`eraseSnapshots`) wins over all of them: the content goes regardless, the
 * documents' extracted bodies are emptied, and content still waiting for review is marked "source missing", put on
 * hold and sent (back) to review.
 */

type SnapshotBlocker = 'pending_review' | 'open_dispute' | 'in_progress';
export type SnapshotDeletionReason = 'retention_expired' | 'personal_data_erasure';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

const docsOf = (siteId: string, snapshotId: string) =>
  sql`(SELECT d.id FROM ${ingestSourceDocuments} d WHERE d.site_id = ${siteId} AND d.snapshot_id = ${snapshotId})`;

/** Items derived from the snapshot's documents (not deleted). */
const derivedItems = (siteId: string, snapshotId: string) =>
  sql`(SELECT cp.item_id FROM ${contentProvenance} cp WHERE cp.site_id = ${siteId} AND cp.source_document_id IN ${docsOf(siteId, snapshotId)})`;

/** Which references keep a snapshot past its retention period (empty: none). */
async function snapshotBlockers(tx: Tx, siteId: string, snapshotId: string): Promise<SnapshotBlocker[]> {
  const rows = (await tx.execute(sql`
    SELECT
      EXISTS (
        SELECT 1 FROM lumibase_items i
        WHERE i.site_id = ${siteId} AND i.id IN ${derivedItems(siteId, snapshotId)} AND i.deleted_at IS NULL
          AND (i.status NOT IN ('published', 'archived')
               OR EXISTS (SELECT 1 FROM lumibase_auto_publish_candidates c
                          WHERE c.site_id = ${siteId} AND c.item_id = i.id AND c.status IN ('review', 'veto_window', 'queued')))
      ) AS pending_review,
      (EXISTS (SELECT 1 FROM lumibase_retention_holds h
               WHERE h.site_id = ${siteId} AND h.target_kind = 'ingest_snapshot' AND h.target_id = ${snapshotId} AND h.released_at IS NULL)
       OR EXISTS (SELECT 1 FROM lumibase_licence_lapse_reviews r
                  WHERE r.site_id = ${siteId} AND r.state = 'open' AND r.item_id IN ${derivedItems(siteId, snapshotId)})
      ) AS open_dispute,
      (EXISTS (SELECT 1 FROM lumibase_ingest_processing_jobs j
               WHERE j.site_id = ${siteId} AND j.status = 'pending' AND j.source_document_id IN ${docsOf(siteId, snapshotId)})
       OR EXISTS (SELECT 1 FROM lumibase_ai_productions p
                  WHERE p.site_id = ${siteId} AND p.status IN ('running', 'retry_scheduled')
                    AND EXISTS (SELECT 1 FROM ${ingestSourceDocuments} d
                                WHERE d.site_id = ${siteId} AND d.snapshot_id = ${snapshotId}
                                  AND p.sources @> jsonb_build_array(jsonb_build_object('kind', 'source_document', 'id', d.id))))
      ) AS in_progress
  `)) as unknown as Array<{ pending_review: boolean; open_dispute: boolean; in_progress: boolean }>;
  const r = rows[0];
  const out: SnapshotBlocker[] = [];
  if (r?.pending_review) out.push('pending_review');
  if (r?.open_dispute) out.push('open_dispute');
  if (r?.in_progress) out.push('in_progress');
  return out;
}

/**
 * Delete a snapshot's content and keep its row as a tombstone. The object is deleted inside the row's transaction: if
 * the store refuses, the tombstone is not written and a later run tries again. An erasure overrides an earlier
 * retention tombstone's reason. Returns false when the snapshot does not exist in the site.
 */
export async function tombstoneSnapshot(
  deps: { db: Database; storage: StorageProvider },
  siteId: string,
  snapshotId: string,
  reason: SnapshotDeletionReason,
  now: Date,
): Promise<boolean> {
  return runSiteTransaction(
    deps.db,
    siteId,
    async (tx) => {
      const [row] = await tx
        .select({ storageKey: ingestSnapshots.storageKey, deletedAt: ingestSnapshots.contentDeletedAt, reason: ingestSnapshots.deletionReason })
        .from(ingestSnapshots)
        .where(and(eq(ingestSnapshots.siteId, siteId), eq(ingestSnapshots.id, snapshotId)))
        .for('update');
      if (!row) return false;
      const keepReason = row.reason === 'personal_data_erasure' ? row.reason : reason;
      await tx
        .update(ingestSnapshots)
        .set({ contentDeletedAt: row.deletedAt ?? now, deletionReason: keepReason })
        .where(and(eq(ingestSnapshots.siteId, siteId), eq(ingestSnapshots.id, snapshotId)));
      await deps.storage.delete(row.storageKey);
      return true;
    },
    { retry: false },
  );
}

export interface SnapshotRetentionResult {
  tombstoned: string[];
  blocked: Array<{ siteId: string; snapshotId: string; blockers: SnapshotBlocker[] }>;
  failedSites: number;
}

/** Tombstone the snapshots past the retention period that nothing blocks, site by site. */
export async function purgeExpiredSnapshots(deps: {
  db: Database;
  storage: StorageProvider;
  snapshotDays: number;
  now?: () => Date;
  limitPerSite?: number;
}): Promise<SnapshotRetentionResult> {
  const now = deps.now?.() ?? new Date();
  const cutoff = new Date(now.getTime() - deps.snapshotDays * DAY_MS);
  const out: SnapshotRetentionResult = { tombstoned: [], blocked: [], failedSites: 0 };
  const siteRows = await deps.db.select({ id: sites.id }).from(sites).orderBy(asc(sites.id));
  for (const { id: siteId } of siteRows) {
    try {
      const candidates = await runSiteTransaction(deps.db, siteId, (tx) =>
        tx
          .select({ id: ingestSnapshots.id })
          .from(ingestSnapshots)
          .where(and(eq(ingestSnapshots.siteId, siteId), isNull(ingestSnapshots.contentDeletedAt), lt(ingestSnapshots.lastWrittenAt, cutoff)))
          .orderBy(asc(ingestSnapshots.lastWrittenAt))
          .limit(deps.limitPerSite ?? 500),
      );
      for (const c of candidates) {
        const blockers = await runSiteTransaction(deps.db, siteId, (tx) => snapshotBlockers(tx, siteId, c.id));
        if (blockers.length > 0) {
          out.blocked.push({ siteId, snapshotId: c.id, blockers });
          continue;
        }
        if (await tombstoneSnapshot(deps, siteId, c.id, 'retention_expired', now)) out.tombstoned.push(c.id);
      }
    } catch (err) {
      out.failedSites += 1;
      console.error('[data-retention] snapshots of a site failed', { siteId, error: err instanceof Error ? err.name : 'error' });
    }
  }
  return out;
}

export interface SnapshotErasureResult {
  erased: string[];
  /** Content still waiting for review whose source went missing: marked, on hold, back in review. */
  sentToReview: string[];
}

/**
 * Erase snapshots under a personal-data deletion request: no reference keeps them. Their content is deleted (tombstone
 * `personal_data_erasure`), the extracted bodies of their documents are emptied, and derived content still waiting for
 * review is marked "source missing", put on hold (no publishing path takes it) and its auto-publish candidate goes back
 * to review; the site's administrators are told.
 */
export async function eraseSnapshots(
  deps: { db: Database; storage: StorageProvider },
  siteId: string,
  snapshotIds: readonly string[],
  now: Date,
): Promise<SnapshotErasureResult> {
  const out: SnapshotErasureResult = { erased: [], sentToReview: [] };
  for (const snapshotId of [...new Set(snapshotIds)]) {
    if (!(await tombstoneSnapshot(deps, siteId, snapshotId, 'personal_data_erasure', now))) continue;
    out.erased.push(snapshotId);
    const pending = await runSiteTransaction(deps.db, siteId, async (tx) => {
      const docs = await tx
        .update(ingestSourceDocuments)
        .set({ bodyHtml: '', bodyText: '' })
        .where(and(eq(ingestSourceDocuments.siteId, siteId), eq(ingestSourceDocuments.snapshotId, snapshotId)))
        .returning({ id: ingestSourceDocuments.id });
      if (docs.length === 0) return [];
      const derived = await tx
        .select({ itemId: items.id, status: items.status })
        .from(contentProvenance)
        .innerJoin(items, and(eq(items.siteId, contentProvenance.siteId), eq(items.id, contentProvenance.itemId)))
        .where(and(eq(contentProvenance.siteId, siteId), inArray(contentProvenance.sourceDocumentId, docs.map((d) => d.id)), isNull(items.deletedAt)));
      if (derived.length === 0) return [];
      const reviewing = new Set(
        (
          await tx
            .select({ itemId: autoPublishCandidates.itemId })
            .from(autoPublishCandidates)
            .where(
              and(
                eq(autoPublishCandidates.siteId, siteId),
                inArray(autoPublishCandidates.itemId, derived.map((d) => d.itemId)),
                inArray(autoPublishCandidates.status, ['review', 'veto_window', 'queued']),
              ),
            )
        ).map((r) => r.itemId),
      );
      const pendingItems = [...new Set(derived.filter((d) => !['published', 'archived'].includes(d.status) || reviewing.has(d.itemId)).map((d) => d.itemId))];
      if (pendingItems.length === 0) return [];
      await tx
        .update(contentProvenance)
        .set({ sourceMissingAt: now, sourceMissingReason: 'personal_data_erasure' })
        .where(
          and(
            eq(contentProvenance.siteId, siteId),
            inArray(contentProvenance.itemId, pendingItems),
            inArray(contentProvenance.sourceDocumentId, docs.map((d) => d.id)),
          ),
        );
      await tx
        .update(autoPublishCandidates)
        .set({ status: 'review', reason: 'source_missing', updatedAt: now })
        .where(
          and(
            eq(autoPublishCandidates.siteId, siteId),
            inArray(autoPublishCandidates.itemId, pendingItems),
            inArray(autoPublishCandidates.status, ['veto_window', 'queued']),
          ),
        );
      return pendingItems;
    });
    for (const itemId of pending) {
      await holdForMissingSource(deps.db, siteId, itemId, now);
      out.sentToReview.push(itemId);
    }
  }
  return out;
}

/** Put unpublished content on hold (with its change event) and tell the site's administrators. */
async function holdForMissingSource(db: Database, siteId: string, itemId: string, now: Date): Promise<void> {
  await runItemWriteTransaction(db, siteId, async (tx) => {
    const [item] = await tx
      .select({ status: items.status, hold: items.hold, data: items.data, collection: collections.name })
      .from(items)
      .innerJoin(collections, eq(collections.id, items.collectionId))
      .where(and(eq(items.siteId, siteId), eq(items.id, itemId)))
      .for('update', { of: items });
    if (!item) return;
    if (item.status !== 'published' && !item.hold) {
      const [changed] = await tx
        .update(items)
        .set({ hold: true, version: sql`${items.version} + 1`, updatedAt: now })
        .where(and(eq(items.siteId, siteId), eq(items.id, itemId)))
        .returning({ version: items.version });
      await appendItemEvent(tx, {
        siteId,
        collection: item.collection,
        itemId,
        itemVersion: changed!.version,
        changedFields: ['hold'],
        source: 'system',
        payload: { reason: 'source_missing' },
      });
    }
    const data = item.data as Record<string, unknown> | null;
    const title = typeof data?.title === 'string' ? data.title : itemId;
    await notifySiteAdmins(tx, siteId, {
      subject: `Source missing: ${title}`,
      message: `A source snapshot behind "${title}" was erased under a personal-data deletion request. The content is waiting for review and is on hold until a person checks it without that source.`,
      item: itemId,
      collection: item.collection,
    });
  });
}

// ── retention holds (open disputes) ─────────────────────────────────────────

export class RetentionHoldError extends Error {
  constructor(
    public readonly code: 'NOT_FOUND' | 'ALREADY_RELEASED' | 'VALIDATION',
    message: string,
    public readonly status: 400 | 404 | 409,
  ) {
    super(message);
    this.name = 'RetentionHoldError';
  }
}

export interface RetentionHoldResource {
  id: string;
  targetKind: 'ingest_snapshot';
  targetId: string;
  reason: string;
  openedBy: string | null;
  openedAt: string;
  releasedAt: string | null;
  releasedBy: string | null;
}

type HoldRow = typeof retentionHolds.$inferSelect;

const toHold = (r: HoldRow): RetentionHoldResource => ({
  id: r.id,
  targetKind: 'ingest_snapshot',
  targetId: r.targetId,
  reason: r.reason,
  openedBy: r.openedBy,
  openedAt: r.openedAt.toISOString(),
  releasedAt: r.releasedAt?.toISOString() ?? null,
  releasedBy: r.releasedBy,
});

export class RetentionHoldService {
  constructor(private readonly deps: { db: Database; siteId: string; userId: string | null; now?: () => Date }) {}

  async list(state: 'open' | 'all' = 'open'): Promise<RetentionHoldResource[]> {
    const { siteId } = this.deps;
    const rows = await runSiteTransaction(this.deps.db, siteId, (tx) =>
      tx
        .select()
        .from(retentionHolds)
        .where(and(eq(retentionHolds.siteId, siteId), ...(state === 'open' ? [isNull(retentionHolds.releasedAt)] : [])))
        .orderBy(asc(retentionHolds.openedAt))
        .limit(500),
    );
    return rows.map(toHold);
  }

  /** Keep a snapshot past its retention period while a dispute about it is open. */
  async open(input: { snapshotId: string; reason: string }): Promise<RetentionHoldResource> {
    const { siteId } = this.deps;
    const reason = input.reason.trim();
    if (!reason) throw new RetentionHoldError('VALIDATION', 'A hold needs a reason.', 400);
    return runSiteTransaction(this.deps.db, siteId, async (tx) => {
      const [snap] = await tx
        .select({ id: ingestSnapshots.id })
        .from(ingestSnapshots)
        .where(and(eq(ingestSnapshots.siteId, siteId), eq(ingestSnapshots.id, input.snapshotId)))
        .limit(1);
      if (!snap) throw new RetentionHoldError('NOT_FOUND', 'No such snapshot in this site.', 404);
      const [row] = await tx
        .insert(retentionHolds)
        .values({ siteId, targetKind: 'ingest_snapshot', targetId: snap.id, reason, openedBy: this.deps.userId, openedAt: this.deps.now?.() ?? new Date() })
        .returning();
      return toHold(row!);
    });
  }

  /** The dispute ended: the snapshot goes through retention again on the next run. */
  async release(id: string): Promise<RetentionHoldResource> {
    const { siteId } = this.deps;
    return runSiteTransaction(this.deps.db, siteId, async (tx) => {
      const [row] = await tx
        .select()
        .from(retentionHolds)
        .where(and(eq(retentionHolds.siteId, siteId), eq(retentionHolds.id, id)))
        .for('update');
      if (!row) throw new RetentionHoldError('NOT_FOUND', 'No such hold.', 404);
      if (row.releasedAt) throw new RetentionHoldError('ALREADY_RELEASED', 'This hold is already released.', 409);
      const [updated] = await tx
        .update(retentionHolds)
        .set({ releasedAt: this.deps.now?.() ?? new Date(), releasedBy: this.deps.userId })
        .where(and(eq(retentionHolds.siteId, siteId), eq(retentionHolds.id, id)))
        .returning();
      return toHold(updated!);
    });
  }
}
