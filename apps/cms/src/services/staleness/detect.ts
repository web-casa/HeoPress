/**
 * Automatic staleness detection (HeoPress v1.1; spec content/stale-content-queue).
 *
 * The manual mark (`PUT /items/:collection/:id/timeliness`) says "a person decided this needs an update". This sweep is
 * the other half of backlog 1.12: an item nobody touched for a long time is probably out of date even though no person
 * said so, and the review queue should show it. It is a derived state, so it is deliberately weaker than a manual mark
 * in three ways:
 *
 * - **Never over a person.** An item that already carries a mark (manual or automatic) is left alone, so a manual mark
 *   is never replaced or re-dated by the sweep.
 * - **Only its own marks come off.** A mark with `needs_update_source = 'auto'` is cleared as soon as the item has been
 *   updated after it — the edit is the resolution, and an automatic mark must not outlive it.
 * - **No audit, no version, no `updated_at`.** These rows are derived, not human actions: writing one audit event per
 *   stale row would drown the audit log in a daily wave nobody performed, and bumping the item's `version` or
 *   `updated_at` would make the mark look like an edit (it would invalidate an editor's open version, and it is the
 *   field the clear rule reads). The Change Feed still learns about the change, because derived caches and consumers
 *   have to see the mark (spec content/change-events).
 *
 * The pass is per site, in that site's row-level-security scope, with guarded conditional updates: a row that a person
 * marked or edited between the read and the write simply does not match, and the sweep moves on.
 */

import { and, eq, gt, inArray, isNull, lt, lte, or, type SQL } from 'drizzle-orm';
import { collections, items, type Database } from '@heopress/database';
import { appendItemEvent } from '../../modules/cdc/change-feed/outbox-writer';
import { runItemWriteTransaction } from '../rls-transaction';
import { allSiteIds } from '../site-scope';
import { AUTO_STALE_REASON, staleAfterDays, staleCutoff } from './marks';

/** How many rows one site may change per pass; a large backfill spreads over several hourly runs. */
const STALENESS_SWEEP_BATCH = 500;

export interface StalenessSweepDeps {
  /** The root application-role handle: each site's work runs in that site's own scope. */
  db: Database;
  /** The instant the pass runs; injectable so the age arithmetic is testable. */
  now?: Date;
  /** Threshold in days; defaults to `HEOPRESS_STALE_AFTER_DAYS` or {@link DEFAULT_STALE_AFTER_DAYS}. */
  staleAfterDays?: number;
  /** Per-site batch cap; defaults to {@link STALENESS_SWEEP_BATCH}. */
  limitPerSite?: number;
}

export interface StalenessSweepSiteResult {
  siteId: string;
  /** Items the pass marked `auto` (empty when there was nothing to do). */
  marked: string[];
  /** Automatic marks the pass removed because the item was edited after the mark. */
  cleared: string[];
}

/**
 * One staleness pass over every site.
 *
 * Returns what it changed, per site, so the caller can log a summary; a second run with nothing changed returns empty
 * arrays and writes nothing at all (no event, no `updated_at`).
 */
export async function sweepStaleContent(deps: StalenessSweepDeps): Promise<StalenessSweepSiteResult[]> {
  const now = deps.now ?? new Date();
  const cutoff = staleCutoff(now, deps.staleAfterDays ?? staleAfterDays());
  const batch = Math.max(1, Math.trunc(deps.limitPerSite ?? STALENESS_SWEEP_BATCH));
  const results: StalenessSweepSiteResult[] = [];
  for (const siteId of await allSiteIds(deps.db)) {
    results.push(
      await runItemWriteTransaction(deps.db, siteId, (tx) => sweepSite({ tx, siteId, now, cutoff, batch })),
    );
  }
  return results;
}

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/** The rows the sweep may mark: published, not deleted, not scheduled for a later publish, unmarked and old enough. */
function markable(siteId: string, cutoff: Date, now: Date): SQL | undefined {
  return and(
    eq(items.siteId, siteId),
    eq(items.status, 'published'),
    isNull(items.deletedAt),
    // A mark of either source exists: a person's decision wins, and an existing automatic mark is already the answer.
    isNull(items.needsUpdateSince),
    lt(items.updatedAt, cutoff),
    // A future publish window is scheduled work, not a stale page: the scheduler still has to publish it.
    or(isNull(items.publishAt), lte(items.publishAt, now)),
  );
}

/** An automatic mark the item has since outgrown: it was edited after the sweep wrote the mark. */
function clearable(siteId: string): SQL | undefined {
  return and(
    eq(items.siteId, siteId),
    eq(items.needsUpdateSource, 'auto'),
    isNull(items.deletedAt),
    gt(items.updatedAt, items.needsUpdateSince),
  );
}

async function sweepSite(input: {
  tx: Tx;
  siteId: string;
  now: Date;
  cutoff: Date;
  batch: number;
}): Promise<StalenessSweepSiteResult> {
  const { tx, siteId, now, cutoff, batch } = input;
  const names = new Map(
    (await tx.select({ id: collections.id, name: collections.name }).from(collections).where(eq(collections.siteId, siteId))).map(
      (c) => [c.id, c.name] as const,
    ),
  );

  // ── mark ────────────────────────────────────────────────────────────────────────────────────────────────────────
  const candidates = await tx
    .select({ id: items.id })
    .from(items)
    .where(markable(siteId, cutoff, now))
    .limit(batch);
  const marked: string[] = [];
  if (candidates.length > 0) {
    // The same predicate guards the write: a row marked or edited since the read no longer matches and is left alone.
    const updated = await tx
      .update(items)
      .set({
        needsUpdateSince: now,
        needsUpdateReason: AUTO_STALE_REASON,
        needsUpdateDueAt: null,
        // An automatic mark has no deadline, so it never reminds; clear stale watermark anyway (spec
        // content/review-reminders) — a leftover from a previous manual mark must not survive a new writer.
        needsUpdateRemindedAt: null,
        needsUpdateSource: 'auto',
        // Deliberately untouched: `updated_at` (the clear rule reads it, and the mark is not an edit) and `version`
        // (an open editor must not be refused because a background pass touched its row).
      })
      .where(and(markable(siteId, cutoff, now), inArray(items.id, candidates.map((c) => c.id))))
      .returning({ id: items.id, collectionId: items.collectionId, version: items.version });
    for (const row of updated) {
      marked.push(row.id);
      await appendItemEvent(tx, {
        siteId,
        collection: names.get(row.collectionId) ?? row.collectionId,
        itemId: row.id,
        itemVersion: row.version,
        changedFields: ['needs_update'],
        actor: { type: 'system' },
        source: 'system',
      });
    }
  }

  // ── clear ───────────────────────────────────────────────────────────────────────────────────────────────────────
  const stale = await tx
    .select({ id: items.id })
    .from(items)
    .where(clearable(siteId))
    .limit(batch);
  const cleared: string[] = [];
  if (stale.length > 0) {
    const updated = await tx
      .update(items)
      .set({
        needsUpdateSince: null,
        needsUpdateReason: null,
        needsUpdateDueAt: null,
        needsUpdateRemindedAt: null,
        needsUpdateSource: null,
      })
      .where(and(clearable(siteId), inArray(items.id, stale.map((c) => c.id))))
      .returning({ id: items.id, collectionId: items.collectionId, version: items.version });
    for (const row of updated) {
      cleared.push(row.id);
      await appendItemEvent(tx, {
        siteId,
        collection: names.get(row.collectionId) ?? row.collectionId,
        itemId: row.id,
        itemVersion: row.version,
        changedFields: ['needs_update'],
        actor: { type: 'system' },
        source: 'system',
      });
    }
  }

  return { siteId, marked, cleared };
}
