import { and, eq, inArray, sql } from 'drizzle-orm';
import { collections, contentReviews, crawlDaily, items, siteDomains, type Database } from '@heopress/database';
import { listMySites, type AccessRequestContext, type MySite } from '../auth/site-switch';
import { PermissionService } from '../permission-service';
import { runSiteTransaction } from '../rls-transaction';
import { readableScope } from '../site-network/readable-items';
import { reachabilityViewOf } from '../site-network/reachability';
import { auditIssueCounts } from '../site-network/site-audit';
import { aiTrafficReport, type AiTrafficReport } from '../site-network/ai-traffic';
import { isArticleCollection } from './article-collections';
import { computeHealth, type Health } from './health';

/**
 * The cross-site read-only summary (HeoPress P07a tasks 3.1, 3.2; spec studio/network-summary, the one exception of
 * sites/site-switching "跨站只读概要是唯一的跨站读取"). For each site the caller may enter Studio on — judged per request
 * as the "my sites" list does — every figure is computed in that site's row-level-security scope, with permissions
 * compiled afresh for this request (no bundle cache, no summary cache). Only identity fields and aggregates leave:
 * no item, title, path, member or setting of any site.
 *
 * A site that requires two-step verification the login has not done, and a site not finished within the deadline,
 * carry only `{id, name, primaryDomain, primaryDomainState, role, availability}`.
 */

type Availability = 'available' | 'mfa_required' | 'unavailable';
type PrimaryDomainState = 'set' | 'unset' | 'none';
type NoPermission = 'no_permission';

interface SiteIdentity {
  id: string;
  name: string;
  primaryDomain: string | null;
  primaryDomainState: PrimaryDomainState;
  role: string | null;
  availability: Availability;
}

interface SiteFigures {
  /** When these figures were computed. */
  computedAt: string;
  /** Pending reviews in collections the caller may both review and read; the oldest one's wait, never its title. */
  pendingReviews: { count: number; oldestWaitSeconds: number | null } | NoPermission;
  /** Open audit issues the caller may see, by severity. */
  auditIssues: { error: number; warning: number; notice: number };
  /** Published items of article collections; `partial` when some article collection is not readable. */
  publishedArticles: { count: number; partial: boolean } | NoPermission;
  /** AI crawler reads in the last 7 days, AI-referred visits in the last 30, and those visits by platform operator. */
  aiCrawler7d: number;
  aiReferral30d: number;
  referralsByPlatform: Array<{ operator: string; hits: number }>;
  health: Health;
  lastAuditAt: string | null;
}

export type SiteSummary = SiteIdentity | (SiteIdentity & { availability: 'available' } & SiteFigures);

export interface NetworkSummary {
  sites: SiteSummary[];
  /** Server time spent, for the measurement report (task 3.4). */
  elapsedMs: number;
}

export interface SummaryPrincipal {
  user: { id: string; email: string; isBootstrap: boolean };
  /** Whether this login did two-step verification (as a site switch checks it). */
  mfaVerified: boolean;
  currentSiteId: string;
  req: AccessRequestContext;
}

export interface SummaryOptions {
  /** Total server-side budget (spec: 2 s). */
  deadlineMs?: number;
  /** Sites worked on at once. */
  concurrency?: number;
  now?: Date;
  /** Test hook: runs before a site's figures (to simulate a slow site). */
  beforeSite?: (siteId: string) => Promise<void>;
}

const DEFAULT_DEADLINE_MS = 2000;
const DEFAULT_CONCURRENCY = 8;

/** What a summary needs of a permission bundle; the bootstrap administrator gets the administrator's. */
type SitePermissions = Pick<PermissionService, 'bundle' | 'canAccess' | 'whereFor'>;

function permissionsFor(db: Database, principal: SummaryPrincipal, siteId: string): SitePermissions {
  const service = new PermissionService({
    db,
    // No cache: compiled for this request, so a revoked grant, a policy window or an IP rule applies at once.
    ctx: {
      userId: principal.user.id,
      siteId,
      roleId: null,
      user: { id: principal.user.id, email: principal.user.email, roles: [] },
      ip: principal.req.ip,
      headers: principal.req.headers,
      apiKey: null,
    },
  });
  if (!principal.user.isBootstrap) return service;
  // The instance's bootstrap administrator administers every site (as a site switch grants it).
  return {
    bundle: async () => ({ ...(await service.bundle()), admin: true }),
    canAccess: async (collection, action) => ({ collection, action, rule: null, fields: ['*'], presets: {}, validation: {}, sources: [] }),
    whereFor: () => undefined,
  } as SitePermissions;
}

/** Primary domain and its state from `site_domains` (design §7): `set`, `unset` (active domains, none primary), `none`. */
async function domainsOf(db: Database, siteId: string) {
  const rows = await runSiteTransaction(db, siteId, (tx) =>
    tx
      .select({ hostname: siteDomains.hostname, isPrimary: siteDomains.isPrimary, status: siteDomains.status, statusReason: siteDomains.statusReason, createdAt: siteDomains.createdAt })
      .from(siteDomains)
      .where(eq(siteDomains.siteId, siteId)),
  );
  const primary = rows.find((r) => r.isPrimary);
  const state: PrimaryDomainState = primary ? 'set' : rows.some((r) => r.status === 'active') ? 'unset' : 'none';
  return { rows, primaryDomain: primary?.hostname ?? null, state };
}

async function figuresOf(db: Database, siteId: string, perms: SitePermissions, domains: Awaited<ReturnType<typeof domainsOf>>, now: Date): Promise<SiteFigures> {
  const bundle = await perms.bundle();
  const readable = await readableScope(db, siteId, perms);
  const colls = await runSiteTransaction(db, siteId, (tx) =>
    tx.select({ id: collections.id, name: collections.name, meta: collections.meta }).from(collections).where(eq(collections.siteId, siteId)),
  );

  // Pending reviews: collections with both `review` and `read` (design §7).
  const reviewable: string[] = [];
  for (const c of colls) {
    if ((await perms.canAccess(c.name, 'review')) && (await perms.canAccess(c.name, 'read'))) reviewable.push(c.name);
  }
  let pendingReviews: SiteFigures['pendingReviews'] = 'no_permission';
  if (reviewable.length) {
    const [row] = await runSiteTransaction(db, siteId, (tx) =>
      tx
        .select({ n: sql<number>`count(*)`.mapWith(Number), oldest: sql<string | null>`min(${contentReviews.createdAt})::text` })
        .from(contentReviews)
        .innerJoin(items, and(eq(items.id, contentReviews.itemId), eq(items.siteId, siteId)))
        .innerJoin(collections, eq(collections.id, items.collectionId))
        .where(and(eq(contentReviews.siteId, siteId), eq(contentReviews.status, 'pending'), inArray(collections.name, reviewable))),
    );
    const oldest = row?.oldest ? new Date(row.oldest) : null;
    pendingReviews = { count: row?.n ?? 0, oldestWaitSeconds: oldest ? Math.max(0, Math.round((now.getTime() - oldest.getTime()) / 1000)) : null };
  }

  // Published articles: readable article collections only, each read with its row rule.
  const articles = colls.filter((c) => isArticleCollection(c.name, c.meta));
  let readableArticles = 0;
  let count = 0;
  for (const c of articles) {
    const perm = await perms.canAccess(c.name, 'read');
    if (!perm) continue;
    readableArticles += 1;
    const where = perms.whereFor(perm);
    const [row] = await runSiteTransaction(db, siteId, (tx) =>
      tx
        .select({ n: sql<number>`count(*)`.mapWith(Number) })
        .from(items)
        .where(and(eq(items.siteId, siteId), eq(items.collectionId, c.id), eq(items.status, 'published'), where)),
    );
    count += row?.n ?? 0;
  }
  const publishedArticles: SiteFigures['publishedArticles'] =
    articles.length > 0 && readableArticles === 0 ? 'no_permission' : { count, partial: readableArticles < articles.length };

  const audit = await auditIssueCounts(db, siteId, { readable, admin: bundle.admin });
  const ai = await aiFigures(db, siteId, now);
  const reach = await reachabilityViewOf(db, siteId);
  const health = computeHealth({
    reachability: reach.report ? { errors: reach.report.summary.errors, warnings: reach.report.summary.warnings } : null,
    audit: audit.lastRunAt ? { lastRunStatus: audit.lastRunStatus, errorIssues: audit.bySeverity.error ?? 0 } : null,
    domains: domains.rows,
    primaryDomainState: domains.state,
    now,
  });
  return {
    computedAt: now.toISOString(),
    pendingReviews,
    auditIssues: { error: audit.bySeverity.error ?? 0, warning: audit.bySeverity.warning ?? 0, notice: audit.bySeverity.notice ?? 0 },
    publishedArticles,
    ...ai,
    health,
    lastAuditAt: audit.lastRunAt,
  };
}

const day = (d: Date, back: number) => new Date(d.getTime() - back * 86_400_000).toISOString().slice(0, 10);
const AI_CRAWLER = sql`(${crawlDaily.kind} = 'crawler' AND ${crawlDaily.purpose} IN ('training', 'search', 'user-fetch'))`;
const AI_REFERRAL = sql`(${crawlDaily.kind} = 'referral' AND ${crawlDaily.purpose} = '')`;

/** The site's AI traffic as `analytics/ai-traffic` counts it (open to the site's members). */
async function aiFigures(db: Database, siteId: string, now: Date) {
  return runSiteTransaction(db, siteId, async (tx) => {
    const [totals] = await tx
      .select({
        crawler: sql<number>`coalesce(sum(${crawlDaily.hits}) FILTER (WHERE ${AI_CRAWLER} AND ${crawlDaily.day} >= ${day(now, 6)}::date), 0)`.mapWith(Number),
        referral: sql<number>`coalesce(sum(${crawlDaily.hits}) FILTER (WHERE ${AI_REFERRAL}), 0)`.mapWith(Number),
      })
      .from(crawlDaily)
      .where(and(eq(crawlDaily.siteId, siteId), sql`${crawlDaily.day} BETWEEN ${day(now, 29)}::date AND ${day(now, 0)}::date`));
    const platforms = await tx
      .select({ operator: crawlDaily.operator, hits: sql<number>`sum(${crawlDaily.hits})`.mapWith(Number) })
      .from(crawlDaily)
      .where(and(eq(crawlDaily.siteId, siteId), AI_REFERRAL, sql`${crawlDaily.day} BETWEEN ${day(now, 29)}::date AND ${day(now, 0)}::date`))
      .groupBy(crawlDaily.operator)
      .orderBy(sql`sum(${crawlDaily.hits}) DESC`);
    return { aiCrawler7d: totals?.crawler ?? 0, aiReferral30d: totals?.referral ?? 0, referralsByPlatform: platforms };
  });
}

/** Run `tasks` at most `limit` at a time. */
async function pool<T>(inputs: readonly T[], limit: number, task: (input: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, inputs.length) }, async () => {
    while (next < inputs.length) {
      const input = inputs[next++]!;
      await task(input);
    }
  });
  await Promise.all(workers);
}

function timeout(ms: number): Promise<'timeout'> {
  return new Promise((resolve) => setTimeout(() => resolve('timeout'), Math.max(0, ms)));
}

/**
 * For each site the principal may enter: its identity, and `figures` computed within the deadline — or the site marked
 * `mfa_required` (two-step verification required, not done by this login) or `unavailable` (not finished in time).
 */
async function perSite<F>(
  db: Database,
  principal: SummaryPrincipal,
  opts: SummaryOptions,
  figures: (siteId: string, perms: SitePermissions, domains: Awaited<ReturnType<typeof domainsOf>>, now: Date) => Promise<F>,
): Promise<{ sites: Array<SiteIdentity | (SiteIdentity & F)>; elapsedMs: number }> {
  const started = Date.now();
  const deadline = started + (opts.deadlineMs ?? DEFAULT_DEADLINE_MS);
  const now = opts.now ?? new Date();
  const sites: MySite[] = await listMySites(db, principal.user as never, principal.currentSiteId, principal.req);
  const out = new Map<string, SiteIdentity | (SiteIdentity & F)>();

  await pool(sites, opts.concurrency ?? DEFAULT_CONCURRENCY, async (site) => {
    const domains = await domainsOf(db, site.id);
    const identity: SiteIdentity = {
      id: site.id,
      name: site.displayTitle ?? site.name,
      primaryDomain: domains.primaryDomain,
      primaryDomainState: domains.state,
      role: principal.user.isBootstrap && !site.roleName ? 'Administrator' : site.roleName,
      availability: 'available',
    };
    if (site.mfaRequired && !principal.mfaVerified) {
      out.set(site.id, { ...identity, availability: 'mfa_required' });
      return;
    }
    const work = (async () => {
      await opts.beforeSite?.(site.id);
      return figures(site.id, permissionsFor(db, principal, site.id), domains, now);
    })();
    const result = await Promise.race([work, timeout(deadline - Date.now())]).catch(() => 'timeout' as const);
    if (result === 'timeout') {
      work.catch(() => undefined);
      out.set(site.id, { ...identity, availability: 'unavailable' });
    } else {
      out.set(site.id, { ...identity, ...(result as F) });
    }
  });

  return { sites: sites.map((s) => out.get(s.id)!).filter(Boolean), elapsedMs: Date.now() - started };
}

/** The sites the principal may enter, each with what it may see (spec studio/network-summary). */
export async function networkSummary(db: Database, principal: SummaryPrincipal, opts: SummaryOptions = {}): Promise<NetworkSummary> {
  const result = await perSite(db, principal, opts, (siteId, perms, domains, now) => figuresOf(db, siteId, perms, domains, now));
  return { sites: result.sites as SiteSummary[], elapsedMs: result.elapsedMs };
}

export interface NetworkAiTraffic {
  days: number;
  from: string;
  to: string;
  /** Day totals over the available sites. */
  byDay: AiTrafficReport['byDay'];
  totals: { crawler: number; referral: number };
  /** The same over the period of the same length before; `null` when no available site has a day recorded there. */
  previousTotals: { crawler: number; referral: number } | null;
  /** Each site: available ones with their totals, the others with their availability only. */
  sites: Array<SiteIdentity | (SiteIdentity & { totals: { crawler: number; referral: number }; previousTotals: { crawler: number; referral: number } | null })>;
  /** Sites left out of the totals, by reason. */
  excluded: { mfaRequired: number; unavailable: number };
  elapsedMs: number;
}

const AI_DAYS = new Set([7, 30, 90]);

/**
 * AI crawler reads by purpose and AI-referred visits per day across the sites the principal may enter (HeoPress P07a
 * task 3.3; spec studio/network-summary "跨站 AI 流量序列"): only `available` sites count; the others are named with their
 * availability and counted by reason. AI traffic is open to a site's members (analytics/ai-traffic).
 */
export async function networkAiTraffic(db: Database, principal: SummaryPrincipal, days: number, opts: SummaryOptions = {}): Promise<NetworkAiTraffic> {
  const span = AI_DAYS.has(days) ? days : 30;
  let window: { from: string; to: string } | null = null;
  const reports = new Map<string, AiTrafficReport>();
  const result = await perSite(db, principal, opts, async (siteId, _perms, _domains, now) => {
    const report = await aiTrafficReport(db, siteId, { days: span, now, previous: true });
    window = { from: report.from, to: report.to };
    reports.set(siteId, report);
    return { availability: 'available' as const, totals: report.totals, previousTotals: report.previousTotals ?? null };
  });
  const byDay = new Map<string, AiTrafficReport['byDay'][number]>();
  const totals = { crawler: 0, referral: 0 };
  let previous = null as { crawler: number; referral: number } | null;
  const excluded = { mfaRequired: 0, unavailable: 0 };
  for (const site of result.sites) {
    if (site.availability === 'mfa_required') excluded.mfaRequired += 1;
    if (site.availability === 'unavailable') excluded.unavailable += 1;
    const report = site.availability === 'available' ? reports.get(site.id) : undefined;
    if (!report) continue;
    totals.crawler += report.totals.crawler;
    totals.referral += report.totals.referral;
    if (report.previousTotals) {
      const before: { crawler: number; referral: number } = previous ?? { crawler: 0, referral: 0 };
      previous = { crawler: before.crawler + report.previousTotals.crawler, referral: before.referral + report.previousTotals.referral };
    }
    for (const d of report.byDay) {
      const acc = byDay.get(d.day) ?? { day: d.day, training: 0, search: 0, userFetch: 0, referral: 0 };
      acc.training += d.training;
      acc.search += d.search;
      acc.userFetch += d.userFetch;
      acc.referral += d.referral;
      byDay.set(d.day, acc);
    }
  }
  const now = opts.now ?? new Date();
  const fallback = { to: now.toISOString().slice(0, 10), from: new Date(now.getTime() - (span - 1) * 86_400_000).toISOString().slice(0, 10) };
  const w = (window as { from: string; to: string } | null) ?? fallback;
  return {
    days: span,
    from: w.from,
    to: w.to,
    byDay: [...byDay.values()].sort((x, y) => x.day.localeCompare(y.day)),
    totals,
    previousTotals: previous,
    sites: result.sites,
    excluded,
    elapsedMs: result.elapsedMs,
  };
}
