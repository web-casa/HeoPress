// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import i18n from 'i18next';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initStudioI18n, setStudioLanguage } from '@/i18n';
import type { SiteSummary } from '../../api';

/**
 * The overview's briefing (v1.1; spec studio/briefing): three sections from the page's reads — needs attention (failed
 * jobs, stale drafts, the review backlog), the last seven days' changes, and site health — plus the empty state and the
 * "current site only" scope note.
 */

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
  useRouterState: () => ({ location: { pathname: '/overview' } }),
}));
vi.mock('@/lib/api', () => ({ getApiClient: () => ({ rawRequest: vi.fn() }), getActiveToken: () => '' }));

const { Briefing } = await import('../briefing');
type BriefingModel = import('../model').Briefing;

const site = {
  id: 'site-a',
  name: 'Site A',
  primaryDomain: 'a.example.com',
  primaryDomainState: 'set',
  role: 'Administrator',
  availability: 'available',
  computedAt: '2026-10-24T10:00:00Z',
  pendingReviews: { count: 6, oldestWaitSeconds: 7200 },
  auditIssues: { error: 2, warning: 5, notice: 0 },
  publishedArticles: { count: 10, partial: false },
  aiCrawler7d: 5,
  aiReferral30d: 2,
  referralsByPlatform: [],
  health: { status: 'bad', reasons: [] },
  lastAuditAt: null,
} as SiteSummary;

function model(over: Partial<BriefingModel> = {}): BriefingModel {
  return {
    attention: [
      { kind: 'reviews', count: 6, oldest: { itemId: 'i1', collection: 'articles', title: 'First story', waitSeconds: 7200 } },
      { kind: 'staleDrafts', count: 2, oldest: { itemId: 'd1', collection: 'articles', title: 'Old idea', waitSeconds: 432_000 } },
      { kind: 'failedJobs', count: 2 },
    ],
    recent: {
      days: 7,
      published: { count: 3, examples: [{ itemId: 'p1', collection: 'articles', title: 'Fresh publish', at: '2026-10-24T09:00:00Z' }] },
      updated: { count: 2, examples: [{ itemId: 'u1', collection: 'articles', title: 'Edited piece', at: '2026-10-23T09:00:00Z' }] },
    },
    health: {
      status: 'bad',
      sites: 1,
      failing: 1,
      attention: 1,
      unreadable: 0,
      signals: [
        { key: 'domain', tone: 'bad', host: 'x.example.com', detail: 'DNS lookup failed' },
        { key: 'audit', tone: 'bad', errors: 2, warnings: 5 },
        { key: 'reviewBacklog', tone: 'warn', count: 4 },
        { key: 'failedJobs', tone: 'bad', count: 2 },
        { key: 'services', tone: 'bad', names: ['queue'] },
      ],
    },
    reviewsUnreadable: 0,
    currentSiteOnly: false,
    ...over,
  };
}

function renderBriefing(over: Partial<BriefingModel> = {}, onGo = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Briefing model={model(over)} scope={{ kind: 'current' }} sites={[site]} loading={false} nextAudit={null} onGo={onGo} />
    </QueryClientProvider>,
  );
  return onGo;
}

beforeAll(async () => {
  await initStudioI18n(i18n);
  await setStudioLanguage('en', i18n);
});

afterEach(() => cleanup());

describe('briefing', () => {
  it('renders the three sections and the rows of each', () => {
    renderBriefing();
    expect(screen.getByRole('heading', { name: 'Needs attention' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Recent changes' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Site health' })).toBeTruthy();

    // Needs attention: the review backlog with its oldest item, the stale drafts, and the failed jobs.
    expect(screen.getByText('Review 6 items')).toBeTruthy();
    expect(screen.getByText(/Oldest: “First story”, waiting 2 hours/)).toBeTruthy();
    expect(screen.getByText('2 drafts untouched for days')).toBeTruthy();
    expect(screen.getByText(/Oldest: “Old idea”, untouched 5 days/)).toBeTruthy();
    expect(screen.getByText('2 failed jobs in the last 24 hours')).toBeTruthy();

    // Recent changes: both counts and one example of each.
    expect(screen.getByText('3 publishes in the last 7 days')).toBeTruthy();
    expect(screen.getByText('2 changes in the last 7 days')).toBeTruthy();
    expect(screen.getByText('Fresh publish')).toBeTruthy();
    expect(screen.getByText('Edited piece')).toBeTruthy();

    // Site health: the status, the domain failure, the audit levels, the backlog, the failed jobs and the service.
    expect(screen.getByText('1 site has a failure')).toBeTruthy();
    expect(screen.getByText('x.example.com')).toBeTruthy();
    expect(screen.getByText('2 error-level and 5 warning-level audit issues')).toBeTruthy();
    expect(screen.getByText('4 items waiting for review')).toBeTruthy();
    expect(screen.getByText('Failed jobs · 24h: 2')).toBeTruthy();
    expect(screen.getByText('Unhealthy services: queue')).toBeTruthy();
  });

  it('a stale draft row opens the drafts view', () => {
    const onGo = renderBriefing();
    fireEvent.click(screen.getByText('2 drafts untouched for days'));
    expect(onGo).toHaveBeenCalledWith('/content?view=drafts', undefined);
  });

  it('says nothing needs attention instead of showing zero rows', () => {
    renderBriefing({ attention: [], recent: { days: 7, published: { count: 0, examples: [] }, updated: { count: 0, examples: [] } } });
    expect(screen.getByText('Nothing needs attention right now.')).toBeTruthy();
    expect(screen.getByText('Nothing changed in the last 7 days.')).toBeTruthy();
    expect(screen.queryByText(/Review 0/)).toBeNull();
  });

  it('in another scope, says drafts and changes are shown for the current site only', () => {
    renderBriefing({ currentSiteOnly: true, attention: [], recent: null });
    expect(screen.getAllByText(/shown for the current site only/)).toHaveLength(1);
  });

  it('counts reviews the user may not read apart', () => {
    renderBriefing({ reviewsUnreadable: 2 });
    expect(screen.getByText('2 sites not visible to you')).toBeTruthy();
  });
});
