import { and, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { collections, contentReviews, items, users, type Database } from '@heopress/database';
import type { PermissionService } from '../permission-service';
import { runSiteTransaction } from '../rls-transaction';

/**
 * The review workspace's lists (HeoPress P07a task 5.3; spec studio/review-workspace "稿件视图与筛选"): items of the
 * collections the caller may read — each read with its row rule — by view, filtered by collection, author, language and
 * title, newest change first, keyset-paged. The inbox holds what waits for the caller: reviews it may decide, and its own
 * items sent back.
 */

export const CONTENT_VIEWS = ['inbox', 'mine', 'pending', 'scheduled', 'published', 'drafts'] as const;
export type ContentView = (typeof CONTENT_VIEWS)[number];

export interface ContentFilter {
  view: ContentView;
  collection?: string;
  author?: string;
  locale?: string;
  q?: string;
}

export interface ContentRow {
  id: string;
  collection: string;
  title: string;
  status: string;
  editorialState: string | null;
  author: { id: string; email: string } | null;
  locale: string | null;
  publishAt: string | null;
  updatedAt: string;
  version: number;
}

export interface ContentPage {
  rows: ContentRow[];
  counts: Record<ContentView, number>;
  nextCursor: string | null;
  /** Collections the caller may read, and which it may review. */
  collections: Array<{ name: string; review: boolean }>;
}

type Perms = Pick<PermissionService, 'canAccess' | 'whereFor'>;

const titleOf = sql<string>`coalesce(nullif(${items.data}->>'title', ''), nullif(${items.data}->>'name', ''), ${items.id})`;
const localeOf = sql<string | null>`nullif(${items.data}->>'locale', '')`;
const PAGE = 50;

export async function contentList(db: Database, siteId: string, userId: string | null, perms: Perms, filter: ContentFilter, cursor?: string): Promise<ContentPage> {
  const colls = await runSiteTransaction(db, siteId, (tx) =>
    tx.select({ id: collections.id, name: collections.name, meta: collections.meta }).from(collections).where(eq(collections.siteId, siteId)),
  );
  const readable: Array<{ id: string; name: string; where: SQL | undefined; review: boolean }> = [];
  for (const c of colls) {
    if ((c.meta as { hidden?: boolean } | null)?.hidden) continue;
    const perm = await perms.canAccess(c.name, 'read');
    if (!perm) continue;
    readable.push({ id: c.id, name: c.name, where: perms.whereFor(perm), review: !!(await perms.canAccess(c.name, 'review')) });
  }
  const scoped = filter.collection ? readable.filter((c) => c.name === filter.collection) : readable;
  const empty = Object.fromEntries(CONTENT_VIEWS.map((v) => [v, 0])) as Record<ContentView, number>;
  if (!scoped.length) return { rows: [], counts: empty, nextCursor: null, collections: readable.map((c) => ({ name: c.name, review: c.review })) };

  const readableItems = sql.join(
    scoped.map((c) => (c.where ? sql`(${items.collectionId} = ${c.id} AND ${c.where})` : sql`${items.collectionId} = ${c.id}`)),
    sql` OR `,
  );
  const reviewableIds = scoped.filter((c) => c.review).map((c) => c.id);
  const pendingReview = sql`EXISTS (SELECT 1 FROM ${contentReviews} r WHERE r.item_id = ${items.id} AND r.site_id = ${siteId} AND r.status = 'pending')`;
  const views: Record<ContentView, SQL> = {
    inbox: sql`(
      (${pendingReview} AND ${reviewableIds.length ? inArray(items.collectionId, reviewableIds) : sql`false`})
      OR (${items.editorialState} = 'rejected' AND ${items.userCreated} = ${userId ?? ''}))`,
    mine: sql`${items.userCreated} = ${userId ?? ''}`,
    pending: pendingReview,
    scheduled: sql`(${items.status} <> 'published' AND ${items.publishAt} > now())`,
    published: sql`${items.status} = 'published'`,
    drafts: sql`(${items.status} = 'draft' AND NOT ${pendingReview} AND (${items.publishAt} IS NULL OR ${items.publishAt} <= now()))`,
  };
  const common = and(
    eq(items.siteId, siteId),
    isNull(items.deletedAt),
    sql`(${readableItems})`,
    filter.author ? eq(items.userCreated, filter.author) : undefined,
    filter.locale ? sql`${localeOf} = ${filter.locale}` : undefined,
    filter.q ? sql`${titleOf} ILIKE ${`%${filter.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`}` : undefined,
  );
  const after = decode(cursor);
  return runSiteTransaction(db, siteId, async (tx) => {
    const rows = await tx
      .select({
        id: items.id,
        collection: collections.name,
        title: titleOf,
        status: items.status,
        editorialState: items.editorialState,
        authorId: items.userCreated,
        authorEmail: users.email,
        locale: localeOf,
        publishAt: items.publishAt,
        updatedAt: items.updatedAt,
        version: items.version,
      })
      .from(items)
      .innerJoin(collections, eq(collections.id, items.collectionId))
      .leftJoin(users, eq(users.id, items.userCreated))
      .where(and(common, views[filter.view], after ? sql`(${items.updatedAt}, ${items.id}) < (${after.at}::timestamp, ${after.id})` : undefined))
      .orderBy(desc(items.updatedAt), desc(items.id))
      .limit(PAGE + 1);
    const counts = { ...empty };
    for (const v of CONTENT_VIEWS) {
      const [row] = await tx.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(items).where(and(common, views[v]));
      counts[v] = row?.n ?? 0;
    }
    const page = rows.slice(0, PAGE);
    const last = page.at(-1);
    return {
      rows: page.map((r) => ({
        id: r.id,
        collection: r.collection,
        title: r.title,
        status: r.status,
        editorialState: r.editorialState,
        author: r.authorId ? { id: r.authorId, email: r.authorEmail ?? r.authorId } : null,
        locale: r.locale,
        publishAt: r.publishAt ? new Date(r.publishAt).toISOString() : null,
        updatedAt: new Date(r.updatedAt).toISOString(),
        version: r.version,
      })),
      counts,
      nextCursor: rows.length > PAGE && last ? encode({ at: new Date(last.updatedAt).toISOString(), id: last.id }) : null,
      collections: readable.map((c) => ({ name: c.name, review: c.review })),
    };
  });
}

function encode(c: { at: string; id: string }): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}

function decode(raw: string | undefined): { at: string; id: string } | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { at: string; id: string };
    return typeof c.at === 'string' && typeof c.id === 'string' && !Number.isNaN(Date.parse(c.at)) ? c : null;
  } catch {
    return null;
  }
}

export interface HistoryEntry {
  kind: 'submitted' | 'approved' | 'rejected';
  at: string;
  by: string | null;
  reason: string | null;
}

/** An item's review history (submissions and decisions, with reasons), newest first. Call after a read check. */
export async function reviewHistory(db: Database, siteId: string, itemId: string): Promise<HistoryEntry[]> {
  const rows = await runSiteTransaction(db, siteId, (tx) =>
    tx
      .select({
        status: contentReviews.status,
        createdAt: contentReviews.createdAt,
        decidedAt: contentReviews.decidedAt,
        reason: contentReviews.reason,
        requestedBy: sql<string | null>`(SELECT email FROM ${users} WHERE id = ${contentReviews.requestedBy})`,
        decidedBy: sql<string | null>`(SELECT email FROM ${users} WHERE id = ${contentReviews.decidedBy})`,
      })
      .from(contentReviews)
      .where(and(eq(contentReviews.siteId, siteId), eq(contentReviews.itemId, itemId))),
  );
  const out: HistoryEntry[] = [];
  for (const r of rows) {
    out.push({ kind: 'submitted', at: r.createdAt.toISOString(), by: r.requestedBy, reason: null });
    if (r.decidedAt && (r.status === 'approved' || r.status === 'rejected')) out.push({ kind: r.status, at: r.decidedAt.toISOString(), by: r.decidedBy, reason: r.reason });
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}
