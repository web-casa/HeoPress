import { sql } from 'drizzle-orm';
import { itemNumbers } from '@heopress/database';
import type { SiteTransaction } from '../rls-transaction';

/**
 * First publish time and item numbers (HeoPress P05 tasks 1.3, 1.6; design
 * R10, R19, R25, R28).
 *
 * `published_at` is written once, when an item first becomes published, by
 * every path that publishes (create, bulk create, edit — Releases and agents
 * included — and scheduled publishing): it is the date of date permalinks.
 * Re-publishing never changes it. An item that existed before P05 and was
 * not published then (`unknown`: it may have been published earlier) takes
 * its creation time as an estimate instead, so it shows up for a person to
 * confirm. An administrator may set it explicitly (`set`).
 */

export interface PublishState {
  status: string;
  publishedAt: Date | null;
  publishedAtSource: string | null;
  createdAt: Date;
}

/** The `published_at` columns a write to `nextStatus` sets (empty when nothing changes). */
export function firstPublishColumns(
  before: PublishState | null,
  nextStatus: string,
  now: Date,
): { publishedAt?: Date; publishedAtSource?: string } {
  if (nextStatus !== 'published') return {};
  if (before?.publishedAt) return {};
  if (before?.publishedAtSource === 'unknown') return { publishedAt: before.createdAt, publishedAtSource: 'estimated' };
  return { publishedAt: now, publishedAtSource: 'recorded' };
}

/** The same rule in SQL, for the scheduler's conditional update. */
export const firstPublishSql = {
  publishedAt: sql`COALESCE(published_at, CASE WHEN published_at_source = 'unknown' THEN created_at ELSE now() END)`,
  publishedAtSource: sql`CASE WHEN published_at IS NOT NULL THEN published_at_source WHEN published_at_source = 'unknown' THEN 'estimated' ELSE 'recorded' END`,
};

/** The next item number of a collection (positive, never reused), in the create transaction. */
export async function allocateItemNumber(tx: SiteTransaction, siteId: string, collectionId: string): Promise<number> {
  const [row] = await tx
    .insert(itemNumbers)
    .values({ siteId, collectionId, last: 1 })
    .onConflictDoUpdate({ target: [itemNumbers.siteId, itemNumbers.collectionId], set: { last: sql`${itemNumbers.last} + 1` } })
    .returning({ last: itemNumbers.last });
  return row!.last;
}
