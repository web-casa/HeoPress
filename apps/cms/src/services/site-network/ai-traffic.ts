import { and, asc, eq, sql } from 'drizzle-orm';
import { crawlDaily, publicItems, crawlHits, sites, type Database } from '@heopress/database';
import { runSiteTransaction } from '../rls-transaction';

/**
 * AI traffic of a site (HeoPress P07 tasks 6.2, 6.4; spec analytics/ai-traffic): the day totals the rendering service
 * keeps (`lumibase_crawl_daily`, written through `lumibase_record_crawl_hit`) — by day and purpose, by crawler or
 * assistant, the pages AI crawlers read most and the pages AI assistants send visitors to — read in the site's scope only.
 * The details (`lumibase_crawl_hits`) are kept 7 days (`purgeCrawlHits`); the totals stay.
 */

/** Days a report covers at most, and the rows of each top list. */
const MAX_DAYS = 90;
const TOP = 20;
/** Days the details are kept. */
const CRAWL_HITS_DAYS = 7;

export interface AiTrafficReport {
  from: string;
  to: string;
  totals: { crawler: number; referral: number };
  /** Per day: crawler hits by purpose, AI-referred visits. */
  byDay: Array<{ day: string; training: number; search: number; userFetch: number; referral: number }>;
  /** Per crawler or assistant. */
  byAgent: Array<{ kind: 'crawler' | 'referral'; agent: string; operator: string; purpose: string | null; hits: number }>;
  /** The paths AI crawlers (training, search, user-fetch) read most, with the kind of resource. */
  topCrawled: Array<{ path: string; resource: string; hits: number; /** The public page at that path, when there is one (HeoPress P07a: a link to its editor). */ itemId?: string | null; collection?: string | null }>;
  /** The pages AI assistants sent visitors to most. */
  topLanding: Array<{ path: string; hits: number; sources: string[] }>;
  /**
   * With `previous: true` (HeoPress P07a task 7.1): the totals of the period of the same length just before, read from
   * the same day totals; `null` when that period has no recorded day — not zeros.
   */
  previousTotals?: { crawler: number; referral: number } | null;
}

const AI_PURPOSES = sql`('training', 'search', 'user-fetch')`;

export async function aiTrafficReport(db: Database, siteId: string, opts: { days?: number; now?: Date; previous?: boolean } = {}): Promise<AiTrafficReport> {
  const days = Math.min(Math.max(1, Math.trunc(opts.days ?? 30)), MAX_DAYS);
  const end = opts.now ?? new Date();
  const to = end.toISOString().slice(0, 10);
  const from = new Date(end.getTime() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  return runSiteTransaction(db, siteId, async (tx) => {
    // AI crawlers and AI referrals only, whatever an older version wrote (Codex review of batch 11, round 2).
    const within = and(
      eq(crawlDaily.siteId, siteId),
      sql`${crawlDaily.day} BETWEEN ${from}::date AND ${to}::date`,
      sql`((${crawlDaily.kind} = 'crawler' AND ${crawlDaily.purpose} IN ${AI_PURPOSES}) OR (${crawlDaily.kind} = 'referral' AND ${crawlDaily.purpose} = ''))`,
    );
    const byDayRows = (await tx.execute(sql`
      SELECT day::text AS day,
             sum(hits) FILTER (WHERE kind = 'crawler' AND purpose = 'training')::int AS training,
             sum(hits) FILTER (WHERE kind = 'crawler' AND purpose = 'search')::int AS search,
             sum(hits) FILTER (WHERE kind = 'crawler' AND purpose = 'user-fetch')::int AS "userFetch",
             sum(hits) FILTER (WHERE kind = 'referral')::int AS referral
      FROM ${crawlDaily} WHERE ${within}
      GROUP BY day ORDER BY day`)) as unknown as Array<Record<string, number | string | null>>;
    const byAgent = (await tx.execute(sql`
      SELECT kind, agent, operator, nullif(purpose, '') AS purpose, sum(hits)::int AS hits
      FROM ${crawlDaily} WHERE ${within}
      GROUP BY kind, agent, operator, purpose ORDER BY hits DESC, agent`)) as unknown as AiTrafficReport['byAgent'];
    const topCrawled = (await tx.execute(sql`
      SELECT t.path, t.resource, t.hits, p.item_id AS "itemId", p.collection
      FROM (
        SELECT path, min(resource) AS resource, sum(hits)::int AS hits
        FROM ${crawlDaily} WHERE ${within} AND kind = 'crawler' AND purpose IN ${AI_PURPOSES}
        GROUP BY path ORDER BY hits DESC, path LIMIT ${TOP}
      ) t
      LEFT JOIN LATERAL (
        SELECT pi.item_id, pi.collection FROM ${publicItems} pi
        WHERE pi.site_id = ${siteId} AND t.resource = 'page' AND rtrim(pi.path, '/') = rtrim(t.path, '/')
        LIMIT 1
      ) p ON true
      ORDER BY t.hits DESC, t.path`)) as unknown as AiTrafficReport['topCrawled'];
    const topLanding = (await tx.execute(sql`
      SELECT path, sum(hits)::int AS hits, array_agg(DISTINCT agent ORDER BY agent) AS sources
      FROM ${crawlDaily} WHERE ${within} AND kind = 'referral' AND resource = 'page'
      GROUP BY path ORDER BY hits DESC, path LIMIT ${TOP}`)) as unknown as AiTrafficReport['topLanding'];
    const n = (v: unknown) => Number(v ?? 0);
    let previousTotals: AiTrafficReport['previousTotals'];
    if (opts.previous) {
      const prevTo = new Date(end.getTime() - days * 86_400_000).toISOString().slice(0, 10);
      const prevFrom = new Date(end.getTime() - (2 * days - 1) * 86_400_000).toISOString().slice(0, 10);
      const [prev] = (await tx.execute(sql`
        SELECT count(*)::int AS rows,
               coalesce(sum(hits) FILTER (WHERE kind = 'crawler'), 0)::int AS crawler,
               coalesce(sum(hits) FILTER (WHERE kind = 'referral'), 0)::int AS referral
        FROM ${crawlDaily}
        WHERE site_id = ${siteId} AND day BETWEEN ${prevFrom}::date AND ${prevTo}::date
          AND ((kind = 'crawler' AND purpose IN ${AI_PURPOSES}) OR (kind = 'referral' AND purpose = ''))`)) as unknown as Array<{ rows: number; crawler: number; referral: number }>;
      previousTotals = prev && n(prev.rows) > 0 ? { crawler: n(prev.crawler), referral: n(prev.referral) } : null;
    }
    const byDay = byDayRows.map((r) => ({
      day: String(r.day),
      training: n(r.training),
      search: n(r.search),
      userFetch: n(r.userFetch),
      referral: n(r.referral),
    }));
    return {
      from,
      to,
      totals: {
        crawler: byAgent.filter((a) => a.kind === 'crawler').reduce((s, a) => s + n(a.hits), 0),
        referral: byAgent.filter((a) => a.kind === 'referral').reduce((s, a) => s + n(a.hits), 0),
      },
      byDay,
      byAgent: byAgent.map((a) => ({ ...a, hits: n(a.hits) })),
      topCrawled: topCrawled.map(({ itemId, collection, ...t }) => ({ ...t, hits: n(t.hits), ...(itemId ? { itemId, collection } : {}) })),
      topLanding: topLanding.map((t) => ({ ...t, hits: n(t.hits) })),
      ...(opts.previous ? { previousTotals } : {}),
    };
  });
}

/** Details removed per statement (Codex review of batch 11: a backlog never becomes one long transaction). */
const PURGE_BATCH = 5000;

/**
 * The details older than `CRAWL_HITS_DAYS` removed, every site in its own scope (the tables force row-level security),
 * `PURGE_BATCH` rows per transaction until none is left; the day totals stay. Then the site's rows from yesterday on are
 * reconciled (`lumibase_crawl_traffic_reconcile`, migration 0089: what a writer of an earlier definition still made after
 * an upgrade brought within the rules) and its day path lists older than yesterday removed. A failure of one site does
 * not stop the others, but fails the run once all were tried (Codex review of batch 11, round 4: the scheduled slot is
 * recorded failed, not done). Returns how many details were removed.
 */
export async function purgeCrawlHits(db: Database, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - CRAWL_HITS_DAYS * 86_400_000).toISOString();
  let removed = 0;
  let failed = 0;
  const all = await db.select({ id: sites.id }).from(sites).orderBy(asc(sites.id));
  for (const { id } of all) {
    try {
      for (;;) {
        const gone = await runSiteTransaction(db, id, async (tx) => {
          const rows = (await tx.execute(sql`
            WITH old AS (SELECT h.id FROM ${crawlHits} h WHERE h.site_id = ${id} AND h.at < ${cutoff}::timestamptz LIMIT ${PURGE_BATCH})
            DELETE FROM ${crawlHits} h USING old WHERE h.id = old.id
            RETURNING 1`)) as unknown as unknown[];
          return rows.length;
        });
        removed += gone;
        if (gone < PURGE_BATCH) break;
      }
      const since = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
      await runSiteTransaction(db, id, (tx) => tx.execute(sql`SELECT public.lumibase_crawl_traffic_reconcile(${since}::date, ${id})`));
    } catch (err) {
      failed += 1;
      console.error('[crawl-hits-purge] a site failed', { siteId: id, error: err instanceof Error ? err.name : 'error' });
    }
  }
  if (failed > 0) throw new Error(`AI traffic maintenance failed for ${failed} of ${all.length} sites`);
  return removed;
}
