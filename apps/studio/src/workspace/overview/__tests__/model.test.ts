import { describe, expect, it } from 'vitest';
import type { SiteSummary } from '../../api';
import { keyFigures, nextAuditAt, reviewsUnreadable, todoItems, weekOf } from '../model';

const site = (id: string, over: Partial<Record<string, unknown>> = {}): SiteSummary =>
  ({
    id,
    name: id.toUpperCase(),
    primaryDomain: null,
    primaryDomainState: 'none',
    role: 'Administrator',
    availability: 'available',
    computedAt: '2026-10-24T10:00:00Z',
    pendingReviews: { count: 0, oldestWaitSeconds: null },
    auditIssues: { error: 0, warning: 0, notice: 0 },
    publishedArticles: { count: 10, partial: false },
    aiCrawler7d: 5,
    aiReferral30d: 2,
    referralsByPlatform: [],
    health: { status: 'ok', reasons: [] },
    lastAuditAt: null,
    ...over,
  }) as SiteSummary;
const off = (id: string, availability: 'mfa_required' | 'unavailable'): SiteSummary =>
  ({ id, name: id, primaryDomain: null, primaryDomainState: 'none', role: 'Reader', availability }) as SiteSummary;

describe('to-do list (p07a task 4.1)', () => {
  it('current site: count and the oldest title with its wait', () => {
    const todos = todoItems({
      scope: { kind: 'current' },
      alerts: 0,
      sites: [site('a')],
      feed: { reviews: { count: 6, oldest: { itemId: 'i', collection: 'articles', title: 'First', waitSeconds: 7200 } }, activity: [], week: [], setup: { domainVerified: true, firstArticlePublished: true, crawlerPolicySet: true, membersInvited: true } },
    });
    expect(todos).toEqual([{ kind: 'reviews', count: 6, oldest: { itemId: 'i', collection: 'articles', title: 'First', waitSeconds: 7200 } }]);
  });

  it('all sites: total, sites concerned and the longest wait — no title', () => {
    const todos = todoItems({
      scope: { kind: 'all' },
      alerts: 0,
      sites: [site('a', { pendingReviews: { count: 4, oldestWaitSeconds: 3600 } }), site('b', { pendingReviews: { count: 5, oldestWaitSeconds: 18_000 } }), site('c')],
    });
    expect(todos).toEqual([{ kind: 'reviews', count: 9, longestWaitSeconds: 18_000, sites: 2 }]);
    expect(JSON.stringify(todos)).not.toContain('title');
  });

  it('a chosen other site: count and longest wait; when it needs verification or is unavailable, its state', () => {
    expect(todoItems({ scope: { kind: 'site', siteId: 'b' }, alerts: 0, sites: [site('b', { pendingReviews: { count: 3, oldestWaitSeconds: 60 } })] })).toEqual([
      { kind: 'reviews', count: 3, longestWaitSeconds: 60, sites: 1 },
    ]);
    expect(todoItems({ scope: { kind: 'site', siteId: 'b' }, alerts: 0, sites: [off('b', 'mfa_required')] })[0]).toMatchObject({ unavailable: 'mfa_required' });
  });

  it('ordered by urgency: alerts, domains, errors, reviews, warnings; nothing at zero', () => {
    const todos = todoItems({
      scope: { kind: 'all' },
      alerts: 2,
      sites: [
        site('a', { auditIssues: { error: 1, warning: 3, notice: 0 }, pendingReviews: { count: 1, oldestWaitSeconds: 5 }, health: { status: 'bad', reasons: [{ code: 'domain_failed', host: 'x.example.com', detail: 'DNS' }] } }),
        site('b'),
      ],
    });
    expect(todos.map((t) => t.kind)).toEqual(['alerts', 'domains', 'auditErrors', 'reviews', 'auditWarnings']);
    expect(todoItems({ scope: { kind: 'all' }, alerts: 0, sites: [site('a')] })).toEqual([]);
  });

  it('a site without review permission counts nothing', () => {
    expect(todoItems({ scope: { kind: 'all' }, alerts: 0, sites: [site('a', { pendingReviews: 'no_permission' })] })).toEqual([]);
  });
});

describe('key figures (p07a tasks 4.2, 4.4)', () => {
  it('only available sites count; the others are named by reason, never as zero', () => {
    const f = keyFigures([site('a', { health: { status: 'warn', reasons: [] } }), off('b', 'mfa_required'), off('c', 'unavailable')]);
    expect(f).toMatchObject({ published: 10, crawler7d: 5, referral30d: 2, attention: 1 });
    expect(f.exclusions).toEqual({ mfa: 1, unavailable: 1, noPermission: 0, partial: 0 });
  });

  it('published: readable collections only and no permission are marked incomplete', () => {
    const f = keyFigures([site('a', { publishedArticles: { count: 4, partial: true } }), site('b', { publishedArticles: 'no_permission' })]);
    expect(f.published).toBe(4);
    expect(f.publishedExclusions).toEqual({ mfa: 0, unavailable: 0, noPermission: 1, partial: 1 });
  });
});

describe('the week', () => {
  it('starts on Monday and has seven days', () => {
    const w = weekOf(new Date(2026, 9, 31, 12));
    expect(w.days).toHaveLength(7);
    expect(w.days[0]!.getDay()).toBe(1);
    expect(w.days[5]!.getDate()).toBe(31);
  });
});

describe('nothing to do, and what is left out (spec "全部处理完", "部分无权限")', () => {
  const now = Date.parse('2026-10-24T12:00:00Z');

  it('the next audit: the earliest last audit plus a day, never in the past; none ever audited, none', () => {
    expect(nextAuditAt([site('a', { lastAuditAt: '2026-10-24T03:00:00Z' }), site('b', { lastAuditAt: '2026-10-24T06:00:00Z' })], now)?.toISOString()).toBe('2026-10-25T03:00:00.000Z');
    expect(nextAuditAt([site('a', { lastAuditAt: '2026-10-22T03:00:00Z' })], now)?.getTime()).toBe(now);
    expect(nextAuditAt([site('a'), off('m', 'mfa_required')], now)).toBeNull();
  });

  it('sites whose reviews cannot be read are counted apart', () => {
    expect(reviewsUnreadable([site('a'), site('b', { pendingReviews: 'no_permission' }), off('m', 'mfa_required')])).toBe(1);
  });
});
