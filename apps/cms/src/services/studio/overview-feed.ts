import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { collections, contentReviews, items, siteDomains, siteSeoSettings, userSites, type Database } from '@heopress/database';
import type { PermissionService } from '../permission-service';
import { runSiteTransaction } from '../rls-transaction';
import { readableScope } from '../site-network/readable-items';
import { isArticleCollection } from './article-collections';

/**
 * The current site's overview feed (HeoPress P07a task 4.3; spec studio/overview). Every item it names or counts is
 * one the caller may read (its `read` grant, row rule included); the reviews card counts collections the caller may
 * both review and read, and is absent when there is none.
 */

interface FeedItem {
  itemId: string;
  collection: string;
  title: string;
}

export interface OverviewFeed {
  /** Absent when the caller may review no collection. */
  reviews?: { count: number; oldest: (FeedItem & { waitSeconds: number }) | null };
  /** Newest first: publishes, submissions for review, rejections. */
  activity: Array<FeedItem & { kind: 'published' | 'submitted' | 'rejected'; at: string }>;
  /** The week asked for: published, scheduled and pending-review items by their time. */
  week: Array<FeedItem & { kind: 'published' | 'scheduled' | 'pending'; at: string }>;
  /** The setup checklist (task 4.5), from the site's actual state. */
  setup: { domainVerified: boolean; firstArticlePublished: boolean; crawlerPolicySet: boolean; membersInvited: boolean };
}

const ACTIVITY_LIMIT = 20;
const WEEK_LIMIT = 200;
const titleOf = sql<string>`coalesce(nullif(${items.data}->>'title', ''), nullif(${items.data}->>'name', ''), ${items.id})`;

export async function overviewFeed(
  db: Database,
  siteId: string,
  perms: Pick<PermissionService, 'bundle' | 'canAccess' | 'whereFor'>,
  window: { from: Date; to: Date },
  now = new Date(),
): Promise<OverviewFeed> {
  const readable = await readableScope(db, siteId, perms);
  const canRead: SQL = readable(sql`${items.id}`, sql`${collections.name}`);
  const colls = await runSiteTransaction(db, siteId, (tx) =>
    tx.select({ name: collections.name, meta: collections.meta }).from(collections).where(eq(collections.siteId, siteId)),
  );
  const reviewable: string[] = [];
  for (const c of colls) {
    if ((await perms.canAccess(c.name, 'review')) && (await perms.canAccess(c.name, 'read'))) reviewable.push(c.name);
  }

  return runSiteTransaction(db, siteId, async (tx) => {
    const feed: OverviewFeed = { activity: [], week: [], setup: { domainVerified: false, firstArticlePublished: false, crawlerPolicySet: false, membersInvited: false } };

    if (reviewable.length) {
      const pending = and(eq(contentReviews.siteId, siteId), eq(contentReviews.status, 'pending'), inArray(collections.name, reviewable), canRead);
      const [count] = await tx
        .select({ n: sql<number>`count(*)`.mapWith(Number) })
        .from(contentReviews)
        .innerJoin(items, and(eq(items.id, contentReviews.itemId), eq(items.siteId, siteId)))
        .innerJoin(collections, eq(collections.id, items.collectionId))
        .where(pending);
      const [oldest] = await tx
        .select({ itemId: items.id, collection: collections.name, title: titleOf, createdAt: contentReviews.createdAt })
        .from(contentReviews)
        .innerJoin(items, and(eq(items.id, contentReviews.itemId), eq(items.siteId, siteId)))
        .innerJoin(collections, eq(collections.id, items.collectionId))
        .where(pending)
        .orderBy(contentReviews.createdAt)
        .limit(1);
      feed.reviews = {
        count: count?.n ?? 0,
        oldest: oldest
          ? { itemId: oldest.itemId, collection: oldest.collection, title: oldest.title, waitSeconds: Math.max(0, Math.round((now.getTime() - oldest.createdAt.getTime()) / 1000)) }
          : null,
      };
    }

    // Activity: publishes (the item's publish time), submissions (review created) and rejections (review decided).
    const published = await tx
      .select({ itemId: items.id, collection: collections.name, title: titleOf, at: items.publishedAt })
      .from(items)
      .innerJoin(collections, eq(collections.id, items.collectionId))
      .where(and(eq(items.siteId, siteId), eq(items.status, 'published'), sql`${items.publishedAt} IS NOT NULL`, canRead))
      .orderBy(sql`${items.publishedAt} DESC`)
      .limit(ACTIVITY_LIMIT);
    const reviewRows = await tx
      .select({ itemId: items.id, collection: collections.name, title: titleOf, status: contentReviews.status, createdAt: contentReviews.createdAt, decidedAt: contentReviews.decidedAt })
      .from(contentReviews)
      .innerJoin(items, and(eq(items.id, contentReviews.itemId), eq(items.siteId, siteId)))
      .innerJoin(collections, eq(collections.id, items.collectionId))
      .where(and(eq(contentReviews.siteId, siteId), canRead))
      .orderBy(sql`greatest(${contentReviews.createdAt}, coalesce(${contentReviews.decidedAt}, ${contentReviews.createdAt})) DESC`)
      .limit(ACTIVITY_LIMIT);
    const activity: OverviewFeed['activity'] = [
      ...published.map((p) => ({ itemId: p.itemId, collection: p.collection, title: p.title, kind: 'published' as const, at: p.at!.toISOString() })),
      ...reviewRows.map((r) => ({ itemId: r.itemId, collection: r.collection, title: r.title, kind: 'submitted' as const, at: r.createdAt.toISOString() })),
      ...reviewRows
        .filter((r) => r.status === 'rejected' && r.decidedAt)
        .map((r) => ({ itemId: r.itemId, collection: r.collection, title: r.title, kind: 'rejected' as const, at: r.decidedAt!.toISOString() })),
    ];
    feed.activity = activity.sort((a, b) => b.at.localeCompare(a.at)).slice(0, ACTIVITY_LIMIT);

    // The week: published in it, scheduled in it, and items waiting for review (by submission time).
    const inWindow = (col: SQL) => sql`${col} >= ${window.from.toISOString()}::timestamptz AND ${col} < ${window.to.toISOString()}::timestamptz`;
    const weekPublished = await tx
      .select({ itemId: items.id, collection: collections.name, title: titleOf, at: items.publishedAt })
      .from(items)
      .innerJoin(collections, eq(collections.id, items.collectionId))
      .where(and(eq(items.siteId, siteId), eq(items.status, 'published'), inWindow(sql`${items.publishedAt}`), canRead))
      .limit(WEEK_LIMIT);
    const weekScheduled = await tx
      .select({ itemId: items.id, collection: collections.name, title: titleOf, at: items.publishAt })
      .from(items)
      .innerJoin(collections, eq(collections.id, items.collectionId))
      .where(and(eq(items.siteId, siteId), sql`${items.status} <> 'published'`, inWindow(sql`${items.publishAt}`), canRead))
      .limit(WEEK_LIMIT);
    const weekPending = await tx
      .select({ itemId: items.id, collection: collections.name, title: titleOf, at: contentReviews.createdAt })
      .from(contentReviews)
      .innerJoin(items, and(eq(items.id, contentReviews.itemId), eq(items.siteId, siteId)))
      .innerJoin(collections, eq(collections.id, items.collectionId))
      .where(and(eq(contentReviews.siteId, siteId), eq(contentReviews.status, 'pending'), canRead))
      .limit(WEEK_LIMIT);
    feed.week = [
      ...weekPublished.map((r) => ({ itemId: r.itemId, collection: r.collection, title: r.title, kind: 'published' as const, at: r.at!.toISOString() })),
      ...weekScheduled.map((r) => ({ itemId: r.itemId, collection: r.collection, title: r.title, kind: 'scheduled' as const, at: new Date(r.at!).toISOString() })),
      ...weekPending
        .filter((r) => r.at >= window.from && r.at < window.to)
        .map((r) => ({ itemId: r.itemId, collection: r.collection, title: r.title, kind: 'pending' as const, at: r.at.toISOString() })),
    ].sort((a, b) => a.at.localeCompare(b.at));

    // Setup checklist: what the site has, regardless of the caller's reading rights (no item is named).
    const [domain] = await tx.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(siteDomains).where(and(eq(siteDomains.siteId, siteId), eq(siteDomains.status, 'active')));
    const articleNames = colls.filter((c) => isArticleCollection(c.name, c.meta)).map((c) => c.name);
    const [article] = articleNames.length
      ? await tx
          .select({ n: sql<number>`count(*)`.mapWith(Number) })
          .from(items)
          .innerJoin(collections, eq(collections.id, items.collectionId))
          .where(and(eq(items.siteId, siteId), eq(items.status, 'published'), inArray(collections.name, articleNames)))
      : [{ n: 0 }];
    const [seo] = await tx.select({ version: siteSeoSettings.version }).from(siteSeoSettings).where(eq(siteSeoSettings.siteId, siteId));
    const [members] = await tx.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(userSites).where(eq(userSites.siteId, siteId));
    feed.setup = {
      domainVerified: (domain?.n ?? 0) > 0,
      firstArticlePublished: (article?.n ?? 0) > 0,
      crawlerPolicySet: (seo?.version ?? 0) > 0,
      membersInvited: (members?.n ?? 0) > 1,
    };
    return feed;
  });
}
