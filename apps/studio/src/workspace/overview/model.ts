import { isAvailable, type OverviewFeed, type SiteFigures, type SiteSummary } from '../api';

/**
 * The overview's figures (HeoPress P07a tasks 4.1, 4.2, 4.4; spec studio/overview): what needs doing in the chosen
 * scope, and the key figures with what they leave out. Pure, so the rules are tested apart from the page.
 */

export type Scope = { kind: 'current' } | { kind: 'all' } | { kind: 'site'; siteId: string };

export interface Exclusions {
  mfa: number;
  unavailable: number;
  noPermission: number;
  partial: number;
}

type TodoKind = 'alerts' | 'domains' | 'auditErrors' | 'reviews' | 'auditWarnings';

export interface Todo {
  kind: TodoKind;
  count: number;
  /** The current site only: the oldest item waiting for review (title, wait). */
  oldest?: { itemId: string; collection: string; title: string; waitSeconds: number };
  /** Other scopes: the longest wait and how many sites (never a title). */
  longestWaitSeconds?: number | null;
  sites?: number;
  /** For a single site that is not available: its state instead of a number. */
  unavailable?: 'mfa_required' | 'unavailable';
  detail?: { host?: string; detail?: string | null; code: string };
}

/** Order of urgency: service alerts, failing domains, error issues, reviews, warning issues. */
const URGENCY: TodoKind[] = ['alerts', 'domains', 'auditErrors', 'reviews', 'auditWarnings'];

export interface TodoInput {
  scope: Scope;
  /** Service alerts (site administrators only; else 0). */
  alerts: number;
  /** The scope's sites from the summary (current site: just it). */
  sites: SiteSummary[];
  /** The current site's feed (titles), when the scope is the current site. */
  feed?: OverviewFeed;
}

export function todoItems(input: TodoInput): Todo[] {
  const out: Todo[] = [];
  if (input.alerts > 0) out.push({ kind: 'alerts', count: input.alerts });

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
