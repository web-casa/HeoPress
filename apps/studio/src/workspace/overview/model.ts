import { isAvailable, type OverviewBriefing, type OverviewFeed, type SiteFigures, type SiteSummary } from '../api';

/**
 * The overview's figures (HeoPress P07a tasks 4.1, 4.2, 4.4; spec studio/overview) and the three-section briefing
 * (v1.1; spec studio/briefing): what needs doing in the chosen scope, what changed recently, the site's health, and
 * the key figures with what they leave out. Pure, so the rules are tested apart from the page.
 */

export type Scope = { kind: 'current' } | { kind: 'all' } | { kind: 'site'; siteId: string };

export interface Exclusions {
  mfa: number;
  unavailable: number;
  noPermission: number;
  partial: number;
}

type TodoKind = 'alerts' | 'failedJobs' | 'domains' | 'auditErrors' | 'reviews' | 'staleDrafts' | 'auditWarnings';

export interface Todo {
  kind: TodoKind;
  count: number;
  /** The current site only: the oldest item waiting for review, or the least recently changed stale draft. */
  oldest?: { itemId: string; collection: string; title: string; waitSeconds: number };
  /** Other scopes: the longest wait and how many sites (never a title). */
  longestWaitSeconds?: number | null;
  sites?: number;
  /** For a single site that is not available: its state instead of a number. */
  unavailable?: 'mfa_required' | 'unavailable';
  detail?: { host?: string; detail?: string | null; code: string };
}

/** Order of urgency: service alerts, failed jobs, failing domains, error issues, reviews, stale drafts, warnings. */
const URGENCY: TodoKind[] = ['alerts', 'failedJobs', 'domains', 'auditErrors', 'reviews', 'staleDrafts', 'auditWarnings'];

export interface TodoInput {
  scope: Scope;
  /** Service alerts (site administrators only; else 0). */
  alerts: number;
  /** Scheduled jobs that failed in the last 24 hours (instance administrators only; `null` when unreadable). */
  failedJobs?: number | null;
  /** The scope's sites from the summary (current site: just it). */
  sites: SiteSummary[];
  /** The current site's feed (titles), when the scope is the current site. */
  feed?: OverviewFeed;
}

export function todoItems(input: TodoInput): Todo[] {
  const out: Todo[] = [];
  if (input.alerts > 0) out.push({ kind: 'alerts', count: input.alerts });
  if (input.failedJobs && input.failedJobs > 0) out.push({ kind: 'failedJobs', count: input.failedJobs });

  // A single other site that is not available: its state, no numbers.
  if (input.scope.kind === 'site') {
    const s = input.sites[0];
    if (s && !isAvailable(s)) return [{ kind: 'reviews', count: 0, unavailable: s.availability as 'mfa_required' | 'unavailable' }];
  }

  const available = input.sites.filter(isAvailable);
  const domainReasons = available.flatMap((s) => s.health.reasons.filter((r) => r.code === 'domain_failed' || r.code === 'domain_pending'));
  if (domainReasons.length) {
    const first = domainReasons[0]!;
    out.push({ kind: 'domains', count: domainReasons.length, detail: { code: first.code, host: first.host, detail: first.detail } });
  }
  const errors = available.reduce((n, s) => n + s.auditIssues.error, 0);
  if (errors > 0) out.push({ kind: 'auditErrors', count: errors });

  if (input.scope.kind === 'current') {
    const reviews = input.feed?.reviews;
    if (reviews && reviews.count > 0) out.push({ kind: 'reviews', count: reviews.count, ...(reviews.oldest ? { oldest: reviews.oldest } : {}) });
    const stale = input.feed?.briefing?.staleDrafts;
    if (stale && stale.count > 0) out.push({ kind: 'staleDrafts', count: stale.count, ...(stale.oldest ? { oldest: stale.oldest } : {}) });
  } else {
    const reviewable = available.filter((s): s is SiteSummary & SiteFigures & { pendingReviews: { count: number; oldestWaitSeconds: number | null } } => typeof s.pendingReviews === 'object');
    const count = reviewable.reduce((n, s) => n + s.pendingReviews.count, 0);
    if (count > 0) {
      const waits = reviewable.map((s) => s.pendingReviews.oldestWaitSeconds).filter((w): w is number => w !== null);
      out.push({
        kind: 'reviews',
        count,
        longestWaitSeconds: waits.length ? Math.max(...waits) : null,
        sites: reviewable.filter((s) => s.pendingReviews.count > 0).length,
      });
    }
  }
  const warnings = available.reduce((n, s) => n + s.auditIssues.warning, 0);
  if (warnings > 0) out.push({ kind: 'auditWarnings', count: warnings });
  return out.sort((a, b) => URGENCY.indexOf(a.kind) - URGENCY.indexOf(b.kind));
}

export interface KeyFigures {
  published: number;
  crawler7d: number;
  referral30d: number;
  attention: number;
  /** Published articles left partly out: unavailable sites, no permission, readable collections only. */
  publishedExclusions: Exclusions;
  /** The other three figures: unavailable sites only. */
  exclusions: Exclusions;
}

/** Key figures over the available sites only; the others are counted by reason, never as zero. */
export function keyFigures(sites: SiteSummary[]): KeyFigures {
  const exclusions: Exclusions = { mfa: 0, unavailable: 0, noPermission: 0, partial: 0 };
  let published = 0;
  let crawler7d = 0;
  let referral30d = 0;
  let attention = 0;
  const publishedExclusions: Exclusions = { mfa: 0, unavailable: 0, noPermission: 0, partial: 0 };
  for (const s of sites) {
    if (!isAvailable(s)) {
      const key = s.availability === 'mfa_required' ? 'mfa' : 'unavailable';
      exclusions[key] += 1;
      publishedExclusions[key] += 1;
      continue;
    }
    crawler7d += s.aiCrawler7d;
    referral30d += s.aiReferral30d;
    if (s.health.status === 'warn' || s.health.status === 'bad') attention += 1;
    if (s.publishedArticles === 'no_permission') publishedExclusions.noPermission += 1;
    else {
      published += s.publishedArticles.count;
      if (s.publishedArticles.partial) publishedExclusions.partial += 1;
    }
  }
  return { published, crawler7d, referral30d, attention, publishedExclusions, exclusions };
}

export const incomplete = (e: Exclusions) => e.mfa + e.unavailable + e.noPermission + e.partial > 0;

/** Monday 00:00 (local) of the week holding `now`, and the Monday after, as ISO strings. */
export function weekOf(now: Date): { from: string; to: string; days: Date[] } {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  const days = Array.from({ length: 7 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7);
  return { from: start.toISOString(), to: end.toISOString(), days };
}

/** Audits run once a day per site (the CMS's audit period). */
const AUDIT_PERIOD_MS = 24 * 60 * 60_000;

/**
 * When the next audit of the scope is due (spec studio/overview "全部处理完"): the earliest of its sites' last audit plus a
 * day, never in the past (an overdue one is due now). Null when no site of the scope was ever audited or none is readable.
 */
export function nextAuditAt(sites: readonly SiteSummary[], now = Date.now()): Date | null {
  const due = sites.filter(isAvailable).map((s) => (s.lastAuditAt ? Date.parse(s.lastAuditAt) + AUDIT_PERIOD_MS : null)).filter((t): t is number => t !== null);
  return due.length ? new Date(Math.max(now, Math.min(...due))) : null;
}

/** Sites of the scope whose items waiting for review the user may not see (spec "部分无权限": counted apart, said). */
export function reviewsUnreadable(sites: readonly SiteSummary[]): number {
  return sites.filter((s) => isAvailable(s) && s.pendingReviews === 'no_permission').length;
}

/** A line of the site-health section (v1.1; spec studio/briefing "站点健康"). */
export type HealthSignal =
  | { key: 'domain'; tone: 'bad'; host?: string; detail?: string | null }
  | { key: 'reachability'; tone: 'bad' | 'warn'; count: number }
  | { key: 'auditFailed'; tone: 'warn' }
  | { key: 'noPrimaryDomain'; tone: 'warn' }
  | { key: 'audit'; tone: 'bad' | 'warn'; errors: number; warnings: number }
  | { key: 'reviewBacklog'; tone: 'warn'; count: number }
  | { key: 'failedJobs'; tone: 'bad' | 'ok'; count: number }
  | { key: 'services'; tone: 'bad' | 'ok'; names: string[] };

export interface SiteHealth {
  status: 'ok' | 'warn' | 'bad' | 'unknown';
  /** Available sites in the scope. */
  sites: number;
  /** Available sites with health `bad`. */
  failing: number;
  /** Available sites with health `bad` or `warn`. */
  attention: number;
  /** Sites counted apart: two-step verification, temporarily unavailable, or no permission. */
  unreadable: number;
  /** At most four reasons (most serious first), then the audit, review, failed-job and service lines. */
  signals: HealthSignal[];
}

/** At most this many "why" lines from the sites' health reasons. */
const MAX_HEALTH_REASONS = 4;

/**
 * Site health from what the existing reads already compute (`studio/network-summary`'s health reasons and audit
 * counts, the overview feed's review backlog, `service-status`' failed jobs and service states). The status follows
 * `computeHealth`; the reasons keep its order. Broken links are `links/broken` error audit issues, so they are counted
 * there rather than fetched again from the (much heavier) link report.
 */
export function siteHealthOf(input: {
  sites: readonly SiteSummary[];
  /** Items waiting for review across the scope. */
  unreviewed: number;
  /** Failed scheduled jobs in the last 24 hours; `null`/absent when the caller cannot read them. */
  failedJobs?: number | null;
  /** Instance service states; `null`/absent when the caller cannot read them. */
  services?: Record<string, string> | null;
}): SiteHealth {
  const available = input.sites.filter(isAvailable);
  const byStatus = { ok: 0, warn: 0, bad: 0, unknown: 0 };
  for (const s of available) byStatus[s.health.status] += 1;
  const status: SiteHealth['status'] =
    byStatus.bad > 0 ? 'bad' : byStatus.warn > 0 ? 'warn' : available.length > 0 && byStatus.unknown === available.length ? 'unknown' : 'ok';

  const reasons: HealthSignal[] = [];
  for (const s of available) {
    for (const r of s.health.reasons) {
      if (r.code === 'domain_failed' || r.code === 'domain_pending') reasons.push({ key: 'domain', tone: 'bad', host: r.host, detail: r.detail ?? null });
      else if (r.code === 'reachability_errors') reasons.push({ key: 'reachability', tone: 'bad', count: r.count ?? 0 });
      else if (r.code === 'reachability_warnings') reasons.push({ key: 'reachability', tone: 'warn', count: r.count ?? 0 });
      else if (r.code === 'audit_failed') reasons.push({ key: 'auditFailed', tone: 'warn' });
      else if (r.code === 'no_primary_domain') reasons.push({ key: 'noPrimaryDomain', tone: 'warn' });
      // audit_errors is summed below; not_checked/not_readable are the unknown state itself.
    }
  }
  const signals: HealthSignal[] = reasons.slice(0, MAX_HEALTH_REASONS);

  const audit = available.reduce((acc, s) => ({ errors: acc.errors + s.auditIssues.error, warnings: acc.warnings + s.auditIssues.warning }), { errors: 0, warnings: 0 });
  if (audit.errors + audit.warnings > 0) signals.push({ key: 'audit', tone: audit.errors > 0 ? 'bad' : 'warn', ...audit });
  if (input.unreviewed > 0) signals.push({ key: 'reviewBacklog', tone: 'warn', count: input.unreviewed });
  if (input.failedJobs !== null && input.failedJobs !== undefined) signals.push({ key: 'failedJobs', tone: input.failedJobs > 0 ? 'bad' : 'ok', count: input.failedJobs });
  if (input.services) {
    const unhealthy = Object.entries(input.services)
      .filter(([, state]) => state === 'unhealthy')
      .map(([name]) => name);
    signals.push({ key: 'services', tone: unhealthy.length > 0 ? 'bad' : 'ok', names: unhealthy });
  }
  return { status, sites: available.length, failing: byStatus.bad, attention: byStatus.bad + byStatus.warn, unreadable: input.sites.length - available.length, signals };
}

/** The three-section briefing (v1.1; spec studio/briefing). */
export interface Briefing {
  /** What needs a human, in the order of `todoItems`. */
  attention: Todo[];
  /** The last week's publishes and changes, or `null` when the scope is not the current site. */
  recent: OverviewBriefing['recent'] | null;
  health: SiteHealth;
  /** Sites whose review backlog the user may not see (counted apart; spec studio/overview "部分无权限"). */
  reviewsUnreadable: number;
  /** True when the scope is not the current site: drafts and changes cannot be read across sites. */
  currentSiteOnly: boolean;
}

export interface BriefingInput {
  scope: Scope;
  alerts: number;
  failedJobs?: number | null;
  services?: Record<string, string> | null;
  sites: SiteSummary[];
  feed?: OverviewFeed;
  /** Items waiting for review across the scope (current site: the feed's count). */
  unreviewed: number;
}

/**
 * Compose the briefing. The current site gets all three sections; other scopes get the summary's aggregates for
 * "needs attention" and "site health", and say that drafts and recent changes are current-site only rather than
 * inventing cross-site numbers (spec studio/briefing "范围与降级").
 */
export function briefingOf(input: BriefingInput): Briefing {
  const current = input.scope.kind === 'current';
  return {
    attention: todoItems({ scope: input.scope, alerts: input.alerts, failedJobs: input.failedJobs, sites: input.sites, feed: current ? input.feed : undefined }),
    recent: current ? (input.feed?.briefing?.recent ?? null) : null,
    health: siteHealthOf({ sites: input.sites, unreviewed: input.unreviewed, failedJobs: input.failedJobs, services: input.services }),
    reviewsUnreadable: reviewsUnreadable(input.sites),
    currentSiteOnly: !current,
  };
}
