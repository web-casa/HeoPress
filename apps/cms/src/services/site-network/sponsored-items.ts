import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
import { collections, items, type Database } from '@heopress/database';
import { runSiteTransaction } from '../rls-transaction';

/** An item's sponsor marking (P05 preset fields): changing it on a published item needs a reason. */
export const SPONSOR_FIELDS = ['sponsored', 'sponsor_name'] as const;

/** Whether two versions of an item's data differ in its sponsor marking. */
export function sponsorMarkingDiffers(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return SPONSOR_FIELDS.some((f) => JSON.stringify(a[f] ?? null) !== JSON.stringify(b[f] ?? null));
}

/**
 * The site's published sponsored items, page by page (HeoPress P05 task 1.9,
 * design F): what a renderer re-renders after a `site_content_settings`
 * change event that moved the sponsor policy (P06). Keyset by item id, so a
 * long walk is stable while items change.
 */
export async function listPublishedSponsored(
  db: Database,
  siteId: string,
  page: { after?: string; limit: number },
): Promise<{ items: Array<{ id: string; collection: string; version: number; sponsorName: string | null }>; next: string | null }> {
  const rows = await runSiteTransaction(db, siteId, (tx) =>
    tx
      .select({ id: items.id, collection: collections.name, version: items.version, data: items.data })
      .from(items)
      .innerJoin(collections, eq(collections.id, items.collectionId))
      .where(
        and(
          eq(items.siteId, siteId),
          eq(items.status, 'published'),
          isNull(items.deletedAt),
          sql`(${items.data}->'sponsored') = 'true'::jsonb`,
          page.after ? gt(items.id, page.after) : undefined,
        ),
      )
      .orderBy(asc(items.id))
      .limit(page.limit + 1),
  );
  const more = rows.length > page.limit;
  const list = rows.slice(0, page.limit).map((r) => {
    const name = (r.data as Record<string, unknown> | null)?.sponsor_name;
    return { id: r.id, collection: r.collection, version: r.version, sponsorName: typeof name === 'string' ? name : null };
  });
  return { items: list, next: more ? list[list.length - 1]!.id : null };
}
