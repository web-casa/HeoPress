/**
 * The review queue (HeoPress v1.1; spec content/stale-content-queue): the items that need a human, in three groups —
 * manual marks, automatic marks, and items awaiting editorial review — newest change first, one page at a time.
 *
 * It reuses the time­liness mark columns rather than introducing a second shape: a mark is the same three columns the
 * item API and the timeliness panel already read (`needs_update_since` / `needs_update_reason` / `needs_update_due_at`)
 * plus the writer (`needs_update_source`); `editorial_state = 'in_review'` is the third group. It also reuses the
 * review workspace's permission shape (`services/studio/content-list.ts`): only the collections the caller may read,
 * each read with its row rule, so the queue can never show an item the caller could not open.
 *
 * Counts cover the page, not the whole site: the page cap bounds the work, so a site with more than `limit` waiting
 * items sees `truncated: true` and counts of the rows returned. A real total would need a separate aggregate over every
 * mark, which is what the cap exists to avoid.
 */

import { and, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { collections, items, type Database } from '@heopress/database';
import type { PermissionService } from '../permission-service';
import { ItemServiceError } from '../item-service-error';
import { runSiteTransaction } from '../rls-transaction';

type ReviewQueueGroup = 'manual' | 'auto' | 'awaiting_review';

/** One page by default; the maximum keeps a single request bounded. */
const REVIEW_QUEUE_DEFAULT_LIMIT = 50;
export const REVIEW_QUEUE_MAX_LIMIT = 200;

interface ReviewQueueRow {
  itemId: string;
  /** The collection's name, the same identifier the item API uses. */
  collection: string;
  /** The item's title (or its name, or its id when it has neither). */
  title: string;
  /** The mark's short reason; null in the awaiting-review group, which has no mark. */
  reason: string | null;
  dueAt: string | null;
  updatedAt: string;
  /** Which of the three groups this row is counted in; a row appears once. */
  group: ReviewQueueGroup;
}

export interface ReviewQueuePage {
  counts: Record<ReviewQueueGroup, number>;
  items: ReviewQueueRow[];
  /** True when more rows matched than the page could hold. */
  truncated: boolean;
  limit: number;
}

type Perms = Pick<PermissionService, 'canAccess' | 'whereFor'>;

const titleOf = sql<string>`coalesce(nullif(${items.data}->>'title', ''), nullif(${items.data}->>'name', ''), ${items.id})`;

/** The page size in force: the caller's (clamped to the maximum) or the default. */
export function reviewQueueLimit(requested?: number): number {
  if (requested === undefined) return REVIEW_QUEUE_DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(requested), 1), REVIEW_QUEUE_MAX_LIMIT);
}

/**
 * A row is counted in exactly one group, in this order: a manual mark (a person's decision), then an automatic mark
 * (the sweep's), then awaiting review. A marked item that is also in review belongs to its mark's group.
 */
export function reviewQueueGroup(row: {
  needsUpdateSince: Date | null;
  needsUpdateSource: string | null;
  editorialState: string | null;
}): ReviewQueueGroup | null {
  if (row.needsUpdateSince) return row.needsUpdateSource === 'auto' ? 'auto' : 'manual';
  if (row.editorialState === 'in_review') return 'awaiting_review';
  return null;
}

export interface ReviewQueueFilter {
  /** Only this collection; its absence means every collection the caller may read. */
  collection?: string;
  limit?: number;
}

/**
 * One page of the queue, site-scoped. Throws `NOT_FOUND` for a collection the site does not have (the caller named a
 * collection, so silence would look like an empty queue); a collection the caller may not read simply contributes
 * nothing.
 */
export async function reviewQueue(
  db: Database,
  siteId: string,
  perms: Perms,
  filter: ReviewQueueFilter = {},
): Promise<ReviewQueuePage> {
  const limit = reviewQueueLimit(filter.limit);
  const known = await runSiteTransaction(db, siteId, (tx) =>
    tx.select({ id: collections.id, name: collections.name, meta: collections.meta }).from(collections).where(eq(collections.siteId, siteId)),
  );
  if (filter.collection && !known.some((c) => c.name === filter.collection)) {
    throw new ItemServiceError('NOT_FOUND', `Collection "${filter.collection}" not found.`, 404);
  }
  const readable: Array<{ id: string; name: string; where: SQL | undefined }> = [];
  for (const c of known) {
    if ((c.meta as { hidden?: boolean } | null)?.hidden) continue;
    if (filter.collection && c.name !== filter.collection) continue;
    const perm = await perms.canAccess(c.name, 'read');
    if (perm) readable.push({ id: c.id, name: c.name, where: perms.whereFor(perm) });
  }
  const empty: ReviewQueuePage = {
    counts: { manual: 0, auto: 0, awaiting_review: 0 },
    items: [],
    truncated: false,
    limit,
  };
  if (readable.length === 0) return empty;

  const readableItems = sql.join(
    readable.map((c) => (c.where ? sql`(${items.collectionId} = ${c.id} AND ${c.where})` : sql`${items.collectionId} = ${c.id}`)),
    sql` OR `,
  );
  const names = new Map(readable.map((c) => [c.id, c.name] as const));

  return runSiteTransaction(db, siteId, async (tx) => {
    const rows = await tx
      .select({
        id: items.id,
        collectionId: items.collectionId,
        title: titleOf,
        needsUpdateSince: items.needsUpdateSince,
        needsUpdateReason: items.needsUpdateReason,
        needsUpdateDueAt: items.needsUpdateDueAt,
        needsUpdateSource: items.needsUpdateSource,
        editorialState: items.editorialState,
        updatedAt: items.updatedAt,
      })
      .from(items)
      .where(
        and(
          eq(items.siteId, siteId),
          isNull(items.deletedAt),
          sql`(${readableItems})`,
          sql`(${items.needsUpdateSince} IS NOT NULL OR ${items.editorialState} = 'in_review')`,
        ),
      )
      .orderBy(desc(items.updatedAt), desc(items.id))
      .limit(limit + 1);

    const page = rows.slice(0, limit);
    const counts: Record<ReviewQueueGroup, number> = { manual: 0, auto: 0, awaiting_review: 0 };
    const queue: ReviewQueueRow[] = [];
    for (const row of page) {
      const group = reviewQueueGroup(row);
      if (!group) continue;
      counts[group] += 1;
      queue.push({
        itemId: row.id,
        collection: names.get(row.collectionId) ?? row.collectionId,
        title: row.title,
        reason: group === 'awaiting_review' ? null : row.needsUpdateReason,
        dueAt: group === 'awaiting_review' ? null : (row.needsUpdateDueAt?.toISOString() ?? null),
        updatedAt: row.updatedAt.toISOString(),
        group,
      });
    }
    return { counts, items: queue, truncated: rows.length > limit, limit };
  });
}
