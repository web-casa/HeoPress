// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import i18n from 'i18next';
import type { ReactNode } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initStudioI18n, setStudioLanguage } from '@/i18n';
import { niceScale } from '../../charts/scale';
import { StackedBars } from '../../charts/stacked-bars';
import { isBlocked } from '../blocked';

const route = vi.hoisted(() => ({ search: {} as Record<string, unknown>, navigate: vi.fn() }));
const raw = vi.hoisted(() =>
  vi.fn(async (path: string) => {
    if (path.includes('/seo-settings')) return { data: { settings: { crawlers: { purposes: {}, overrides: {}, contentSignal: false, custom: [] } } } };
    return {
      data: {
        from: '2026-10-22',
        to: '2026-10-24',
        totals: { crawler: 9, referral: 4 },
        previousTotals: null,
        byDay: [
          { day: '2026-10-23', training: 5, search: 3, userFetch: 1, referral: 4 },
        ],
        byAgent: [],
        topCrawled: [],
        topLanding: [],
      },
    };
  }),
);
vi.mock('@/lib/api', () => ({ getApiClient: () => ({ rawRequest: raw }), getActiveToken: () => '' }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
  useNavigate: () => route.navigate,
  useRouterState: () => ({ location: { pathname: '/ai-traffic', search: route.search } }),
}));

const { AiTrafficPage, Excluded, PerSite, SiteDetails, fillDays } = await import('../ai-traffic-page');

beforeAll(async () => {
  await initStudioI18n(i18n);
  await setStudioLanguage('en', i18n);
});

describe('chart (p07a task 7.2)', () => {
  it('rounds the axis to whole steps', () => {
    expect(niceScale(37)).toEqual({ top: 40, ticks: [0, 10, 20, 30, 40] });
    expect(niceScale(3)).toEqual({ top: 3, ticks: [0, 1, 2, 3] });
    expect(niceScale(0).top).toBe(4);
    for (const t of niceScale(1234).ticks) expect(Number.isInteger(t)).toBe(true);
  });

  it('fills the period with zero days', () => {
    expect(fillDays('2026-10-01', '2026-10-03', [{ day: '2026-10-02', training: 1, search: 0, userFetch: 0, referral: 0 }]).map((d) => d.training)).toEqual([0, 1, 0]);
  });

  it('reads out the previous day with the left arrow', () => {
    render(
      <StackedBars
        caption="AI crawler reads per day"
        series={[{ key: 'training', label: 'Training', color: 'red' }, { key: 'search', label: 'AI search', color: 'blue' }]}
        data={[
          { label: 'Oct 1', values: { training: 2, search: 1 } },
          { label: 'Oct 2', values: { training: 5, search: 0 } },
        ]}
      />,
    );
    const chart = screen.getByRole('group', { name: 'AI crawler reads per day' });
    fireEvent.focus(chart);
    expect(document.getElementById('stacked-bars-active')!.textContent).toBe('Oct 2: Training 5, AI search 0');
    fireEvent.keyDown(chart, { key: 'ArrowLeft' });
    expect(document.getElementById('stacked-bars-active')!.textContent).toBe('Oct 1: Training 2, AI search 1');
  });
});

describe('details (p07a task 7.3)', () => {
  const report = {
    from: '2026-10-01',
    to: '2026-10-30',
    totals: { crawler: 4, referral: 1 },
    byDay: [],
    byAgent: [
      { kind: 'crawler' as const, agent: 'ccbot', operator: 'Common Crawl', purpose: 'training', hits: 3 },
      { kind: 'crawler' as const, agent: 'gptbot', operator: 'OpenAI', purpose: 'training', hits: 1 },
      { kind: 'referral' as const, agent: 'chatgpt', operator: 'OpenAI', purpose: null, hits: 1 },
    ],
    topCrawled: [{ path: '/a/', resource: 'page', hits: 3, itemId: 'i1', collection: 'articles' }],
    topLanding: [{ path: '/a/', hits: 1, sources: ['chatgpt'] }],
  };

  it('a crawler the policy blocks is marked and links to the crawler policy; a page links to its editor', () => {
    render(<SiteDetails report={report} policy={{ purposes: {}, overrides: { ccbot: 'disallow' } }} adminBase="" />);
    const blocked = screen.getByRole('link', { name: /Blocked/ });
    expect(blocked).toHaveAttribute('href', '/seo/crawlers');
    expect(screen.getAllByText('Blocked')).toHaveLength(1);
    expect(screen.getByRole('link', { name: '/a/' })).toHaveAttribute('href', '/content/articles/i1');
    expect(document.body.textContent).not.toMatch(/\d+\.\d+\.\d+\.\d+|utm_|https?:\/\//);
  });

  it('isBlocked: an override wins over the purpose; search engines are never blocked by purpose', () => {
    expect(isBlocked({ purposes: { training: 'disallow' }, overrides: {} }, 'gptbot', 'training')).toBe(true);
    expect(isBlocked({ purposes: { training: 'disallow' }, overrides: { gptbot: 'allow' } }, 'gptbot', 'training')).toBe(false);
    expect(isBlocked({ purposes: { 'search-engine': 'disallow' }, overrides: {} }, 'googlebot', 'search-engine')).toBe(false);
  });
});

describe('all sites (p07a task 7.4)', () => {
  const data = {
    days: 30,
    from: '2026-10-01',
    to: '2026-10-30',
    byDay: [],
    totals: { crawler: 7, referral: 3 },
    previousTotals: null,
    excluded: { mfaRequired: 1, unavailable: 1 },
    sites: [
      { id: 'a', name: 'Site A', primaryDomain: null, primaryDomainState: 'none' as const, role: 'Reader', availability: 'available' as const, totals: { crawler: 7, referral: 3 }, previousTotals: null },
      { id: 'b', name: 'Site B', primaryDomain: null, primaryDomainState: 'none' as const, role: 'Reader', availability: 'mfa_required' as const },
      { id: 'c', name: 'Site C', primaryDomain: null, primaryDomainState: 'none' as const, role: 'Reader', availability: 'unavailable' as const },
    ],
  };

  it('names both reasons for sites left out', () => {
    render(<Excluded excluded={data.excluded} />);
    expect(screen.getByRole('status').textContent).toBe('1 site needs two-step verification · 1 site temporarily unavailable');
  });

  it('lists those sites with their state, never a zero', () => {
    render(<PerSite data={data} />);
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows[1]!.textContent).toBe('Site BTwo-step verification required');
    expect(rows[2]!.textContent).toBe('Site CTemporarily unavailable');
    expect(rows[1]!.textContent).not.toContain('0');
  });
});

describe('metric (spec studio/ai-traffic-view "切换到引荐访客")', () => {
  const page = () => render(<QueryClientProvider client={new QueryClient()}><AiTrafficPage /></QueryClientProvider>);

  it('choosing referred visitors writes the metric to the address', async () => {
    route.search = {};
    page();
    fireEvent.click(await screen.findByRole('tab', { name: /AI referrals|referr/i }));
    expect(route.navigate).toHaveBeenCalledWith(expect.objectContaining({ search: expect.objectContaining({ metric: 'referral' }) }));
    // No previous period recorded (task 7.2): "no comparable data", never a 0% change.
    expect(screen.getAllByText(i18n.t('common:noPrevious')).length).toBe(2);
  });

  it('with referred visitors chosen: one series of visitors per day, the legend says so', async () => {
    route.search = { metric: 'referral' };
    page();
    const chart = await screen.findByRole('figure');
    const referral = i18n.t('aiTraffic:purpose.referral');
    expect(chart.querySelector('figcaption')?.textContent?.trim()).toBe(referral);
    // The day's bar is the referred visitors (4), not the crawler purposes.
    expect([...chart.querySelectorAll('td')].map((td) => td.textContent)).toContain(`${referral} 4`);
    route.search = { metric: 'crawler' };
  });
});
