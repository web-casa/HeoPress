import { and, eq } from 'drizzle-orm';
import { collections, type Database } from '@heopress/database';
import { AuditLogger } from '../../modules/audit/logger';
import { ItemServiceError } from '../item-service-error';
import type { ItemService } from '../item-service';
import type { PermissionService } from '../permission-service';
import { runSiteTransaction } from '../rls-transaction';
import { overviewFeed, type OverviewFeed } from './overview-feed';

/**
 * The briefing's draft (`POST /api/v1/studio/overview/briefing/draft`, HeoPress v1.1 backlog P12): one call turns the
 * current site's briefing — the data `GET /api/v1/studio/overview/feed` already computes — into an editable draft item.
 *
 * The write goes through the normal item path (`ItemService.create`), so revisions, activity, the Change Feed/outbox and
 * cache invalidation happen exactly as for any other create. The summary is plain HTML built from the feed, with the
 * caller's own read scope: what the operator may not read never appears in the draft.
 *
 * Idempotency is per site, collection, UTC day and period: the draft carries `data.briefingDraftKey`
 * (`<date>:<period>`), and a second call finds it through the normal read path and returns it with `created: false`.
 */

const DEFAULT_BRIEFING_DRAFT_COLLECTION = 'articles';
const BRIEFING_PERIODS = ['day', 'week'] as const;
type BriefingPeriod = (typeof BRIEFING_PERIODS)[number];

const DAY_MS = 86_400_000;
/** Examples listed per section of the summary; the counts carry the whole number. */
const SUMMARY_EXAMPLES = 3;

/** The audit context of the request that asked for the draft. */
interface BriefingDraftAudit {
  actorEmail: string | null;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
  userId: string | null;
}

interface CreateBriefingDraftInput {
  db: Database;
  siteId: string;
  permissions: Pick<PermissionService, 'bundle' | 'canAccess' | 'whereFor'>;
  /** The request-scoped item service (`itemServiceForRequest`): permissions, Change Feed and hooks included. */
  items: Pick<ItemService, 'list' | 'create'>;
  collection?: string;
  period?: BriefingPeriod;
  now?: Date;
  audit: BriefingDraftAudit;
}

interface BriefingDraftResult {
  item: Record<string, unknown>;
  created: boolean;
}

/** The window the summary covers: the UTC day, or the UTC week starting Monday (the same rule as `/overview/feed`). */
function briefingWindow(period: BriefingPeriod, now: Date): { from: Date; to: Date } {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (period === 'week') from.setUTCDate(from.getUTCDate() - ((from.getUTCDay() + 6) % 7));
  return { from, to: new Date(from.getTime() + (period === 'week' ? 7 : 1) * DAY_MS) };
}

/** The UTC date the draft is for (`2026-11-10`). */
function briefingDraftDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** The idempotency key of the draft: one per UTC day, period and collection (the collection is the item's own). */
function briefingDraftKey(now: Date, period: BriefingPeriod): string {
  return `${briefingDraftDate(now)}:${period}`;
}

/** The title the operator sees, and the convention that makes the draft recognisable in a list. */
function briefingDraftTitle(now: Date, period: BriefingPeriod): string {
  return `${briefingDraftDate(now)} ${period === 'day' ? '站点简报' : '站点周报'}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

/** A site-relative editor link; the id is encoded, never interpolated raw. */
function itemLink(collection: string, itemId: string, title: string): string {
  return `<a href="/content/${encodeURIComponent(collection)}/${encodeURIComponent(itemId)}">${escapeHtml(title)}</a>`;
}

/** The fields the summary needs from a named item, whether it came from the week window or the recent examples. */
interface NamedItem {
  itemId: string;
  collection: string;
  title: string;
}

function examples(list: readonly NamedItem[]): string {
  if (list.length === 0) return '<p>没有例子。</p>';
  return `<ul>${list
    .slice(0, SUMMARY_EXAMPLES)
    .map((item) => `<li>${itemLink(item.collection, item.itemId, item.title)}</li>`)
    .join('')}</ul>`;
}

function waitLabel(seconds: number): string {
  if (seconds >= 86_400) return `${Math.floor(seconds / 86_400)} 天`;
  if (seconds >= 3_600) return `${Math.floor(seconds / 3_600)} 小时`;
  return `${Math.max(1, Math.round(seconds / 60))} 分钟`;
}

/**
 * The plain-HTML summary: the period's publishes, what needs attention, and the last 7 days' changes. Every value that
 * came from an item is escaped; the only links are site-relative editor links.
 */
function briefingDraftHtml(feed: OverviewFeed, options: { now: Date; period: BriefingPeriod; collection: string }): string {
  const { now, period, collection } = options;
  const periodLabel = period === 'day' ? '今日发布' : '本周发布';
  const published = feed.week
    .filter((item) => item.kind === 'published')
    .sort((a, b) => b.at.localeCompare(a.at));
  const parts: string[] = [];
  parts.push(`<h2>${escapeHtml(briefingDraftTitle(now, period))}</h2>`);
  parts.push(`<p>由当前站点的概览简报生成于 ${escapeHtml(now.toISOString())}；集合：${escapeHtml(collection)}。</p>`);

  parts.push(`<h3>${periodLabel}</h3>`);
  parts.push(`<p>共 ${published.length} 篇。</p>`);
  parts.push(examples(published));

  parts.push('<h3>需要处理</h3>');
  const attention: string[] = [];
  if (feed.briefing.staleDrafts.count > 0) {
    const oldest = feed.briefing.staleDrafts.oldest;
    attention.push(
      `<li>放置超过 ${feed.briefing.staleDrafts.days} 天的草稿：${feed.briefing.staleDrafts.count} 篇` +
        (oldest
          ? `，最久一条是 ${itemLink(oldest.collection, oldest.itemId, oldest.title)}（已等待 ${waitLabel(oldest.waitSeconds)}）`
          : '') +
        '。</li>',
    );
  }
  if (feed.reviews && feed.reviews.count > 0) {
    const oldest = feed.reviews.oldest;
    attention.push(
      `<li>待审核稿件：${feed.reviews.count} 篇` +
        (oldest
          ? `，最久一条是 ${itemLink(oldest.collection, oldest.itemId, oldest.title)}（已等待 ${waitLabel(oldest.waitSeconds)}）`
          : '') +
        '。</li>',
    );
  }
  parts.push(attention.length > 0 ? `<ul>${attention.join('')}</ul>` : '<p>没有需要处理的事项。</p>');

  parts.push('<h3>最近 7 天变化</h3>');
  parts.push(
    `<p>发布 ${feed.briefing.recent.published.count} 篇，修改 ${feed.briefing.recent.updated.count} 篇。</p>`,
  );
  parts.push('<h4>发布</h4>');
  parts.push(examples(feed.briefing.recent.published.examples));
  parts.push('<h4>修改</h4>');
  parts.push(examples(feed.briefing.recent.updated.examples));

  return parts.join('\n');
}

/** The existing draft for this key, through the caller's read path; `null` when there is none (or no read grant). */
async function findExistingDraft(
  items: Pick<ItemService, 'list'>,
  collection: string,
  key: string,
): Promise<Record<string, unknown> | null> {
  try {
    const page = (await items.list(collection, {
      filter: { briefingDraftKey: { _eq: key } },
      limit: 1,
      withTotal: false,
    })) as { data?: Array<Record<string, unknown>> } | null;
    return page?.data?.[0] ?? null;
  } catch (err) {
    // A create-only caller cannot see the draft it made: it may still create one, but never read another's.
    if (err instanceof ItemServiceError && err.code === 'FORBIDDEN') return null;
    throw err;
  }
}

/**
 * Create (or return) the briefing draft. Unknown collection 404, missing `create` 403; the write is an ordinary item
 * create and the first one is audited.
 */
export async function createBriefingDraft(input: CreateBriefingDraftInput): Promise<BriefingDraftResult> {
  const collection = input.collection ?? DEFAULT_BRIEFING_DRAFT_COLLECTION;
  const period = input.period ?? 'day';
  const now = input.now ?? new Date();
  const { db, siteId, permissions, items } = input;

  // The collection first: an unknown one is 404 even for a caller without `create`.
  const [coll] = await runSiteTransaction(db, siteId, (tx) =>
    tx
      .select({ id: collections.id })
      .from(collections)
      .where(and(eq(collections.siteId, siteId), eq(collections.name, collection)))
      .limit(1),
  );
  if (!coll) throw new ItemServiceError('NOT_FOUND', `Collection "${collection}" not found.`, 404);
  if (!(await permissions.canAccess(collection, 'create'))) {
    throw new ItemServiceError('FORBIDDEN', `Action "create" on "${collection}" is not allowed.`, 403);
  }

  const key = briefingDraftKey(now, period);
  const existing = await findExistingDraft(items, collection, key);
  if (existing) return { item: existing, created: false };

  const window = briefingWindow(period, now);
  const feed = await overviewFeed(db, siteId, permissions, window, now);
  const item = (await items.create(
    collection,
    {
      data: {
        title: briefingDraftTitle(now, period),
        body: briefingDraftHtml(feed, { now, period, collection }),
        briefingDraftKey: key,
        briefingDraftPeriod: period,
      },
      status: 'draft',
    },
    { actorEmail: input.audit.actorEmail },
  )) as Record<string, unknown>;

  await new AuditLogger({ db, siteId }).write({
    event: 'studio_briefing_draft_created',
    actorEmail: input.audit.actorEmail,
    ip: input.audit.ip,
    userAgent: input.audit.userAgent,
    requestId: input.audit.requestId,
    metadata: {
      userId: input.audit.userId,
      collection,
      itemId: item.id,
      period,
      key,
      published: feed.week.filter((entry) => entry.kind === 'published').length,
      staleDrafts: feed.briefing.staleDrafts.count,
      reviews: feed.reviews?.count ?? null,
    },
  });

  return { item, created: true };
}
