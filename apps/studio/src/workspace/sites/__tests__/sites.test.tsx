// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import i18n from 'i18next';
import type { ReactNode } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initStudioI18n, setStudioLanguage } from '@/i18n';
import type { SiteSummary } from '../../api';
import { GROUP_THRESHOLD, layoutTopology } from '../layout';

const raw = vi.hoisted(() => vi.fn(async () => ({ data: { topCrawled: [] } })));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
  useRouterState: () => ({ location: { pathname: '/sites' } }),
}));
vi.mock('@/lib/api', () => ({ getApiClient: () => ({ rawRequest: raw }) }));
vi.mock('@/lib/session/current', () => ({ activeSiteId: () => 'a', activeSession: () => ({ userId: 'u', sid: 's' }) }));
vi.mock('../../site-switch', () => ({ openOnSite: vi.fn() }));

const { DomainLabel, SiteDetail, Topology } = await import('../topology-page');

beforeAll(async () => {
  await initStudioI18n(i18n);
  await setStudioLanguage('en', i18n);
});

const site = (id: string, over: Record<string, unknown> = {}): SiteSummary =>
  ({
    id,
    name: `Site ${id}`,
    primaryDomain: null,
    primaryDomainState: 'none',
    role: 'Administrator',
    availability: 'available',
    computedAt: 'x',
    pendingReviews: 'no_permission',
    auditIssues: { error: 0, warning: 0, notice: 0 },
    publishedArticles: { count: 3, partial: false },
    aiCrawler7d: 1,
    aiReferral30d: 1,
    referralsByPlatform: [{ operator: 'OpenAI', hits: 4 }],
    health: { status: 'ok', reasons: [] },
    lastAuditAt: null,
    ...over,
  }) as SiteSummary;
const off = (id: string, availability: 'mfa_required' | 'unavailable'): SiteSummary => ({ id, name: `Site ${id}`, primaryDomain: 'b.example.com', primaryDomainState: 'set', role: 'Reader', availability }) as SiteSummary;
const wrap = (node: ReactNode) => render(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>);

describe('topology layout (p07a task 9.1)', () => {
  it('is deterministic: the same sites in any order give the same places', () => {
    const sites = [site('c'), site('a'), site('b')];
    const one = layoutTopology(sites, { width: 640, height: 520 }).nodes.map((n) => [n.site.id, n.x.toFixed(2), n.y.toFixed(2)]);
    const two = layoutTopology([...sites].reverse(), { width: 640, height: 520 }).nodes.map((n) => [n.site.id, n.x.toFixed(2), n.y.toFixed(2)]);
    expect(two).toEqual(one);
  });

  it('30 sites with 2 needing verification and 1 unavailable: six groups, those 3 in their own', () => {
    const sites = [...Array.from({ length: 27 }, (_, i) => site(`s${String(i).padStart(2, '0')}`, { health: { status: i % 2 ? 'ok' : 'warn', reasons: [] } })), off('m1', 'mfa_required'), off('m2', 'mfa_required'), off('u1', 'unavailable')];
    expect(sites.length).toBeGreaterThan(GROUP_THRESHOLD);
    const layout = layoutTopology(sites, { width: 640, height: 520 });
    expect(layout.grouped).toBe(true);
    expect(layout.sectors.find((s) => s.group === 'mfa_required')!.count).toBe(2);
    expect(layout.sectors.find((s) => s.group === 'unavailable')!.count).toBe(1);
    expect(layout.nodes.filter((n) => n.group === 'mfa_required').map((n) => n.site.id).sort()).toEqual(['m1', 'm2']);
  });
});

describe('topology view', () => {
  it('names each node with its state; selecting by keyboard; no line between sites', () => {
    const onSelect = vi.fn();
    const { container } = wrap(<Topology sites={[site('a'), off('b', 'mfa_required')]} selected={null} onSelect={onSelect} layer />);
    expect(screen.getByRole('button', { name: 'Site a, Healthy' })).toBeTruthy();
    const b = screen.getByRole('button', { name: 'Site b, Needs two-step verification' });
    fireEvent.keyDown(b, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('b');
    // Lines: one spoke per site from the deployment, nothing else without a selection.
    expect(container.querySelectorAll('line')).toHaveLength(2);
  });

  it('a selected site that needs verification gets no AI platform line; an available one does', () => {
    const sites = [site('a'), off('b', 'mfa_required')];
    const { container, rerender } = wrap(<Topology sites={sites} selected="b" onSelect={() => undefined} layer />);
    expect(container.querySelectorAll('[data-platform-edge]')).toHaveLength(0);
    expect(screen.getByText('Switch and verify to see its AI platforms.')).toBeTruthy();
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <Topology sites={sites} selected="a" onSelect={() => undefined} layer />
      </QueryClientProvider>,
    );
    expect(container.querySelectorAll('[data-platform-edge]')).toHaveLength(1);
  });
});

describe('primary domain label', () => {
  it('none: no domain bound; unset: no primary domain; set: the hostname', () => {
    wrap(
      <>
        <DomainLabel site={site('a', { primaryDomainState: 'none' })} />
        <DomainLabel site={site('b', { primaryDomainState: 'unset' })} />
        <DomainLabel site={site('c', { primaryDomainState: 'set', primaryDomain: 'c.example.com' })} />
      </>,
    );
    expect(screen.getByText('No domain bound')).toBeTruthy();
    expect(screen.getByText('No primary domain set')).toBeTruthy();
    expect(screen.getByText('c.example.com')).toBeTruthy();
  });
});

describe('site detail (p07a task 9.2)', () => {
  it('a site needing verification: name, domain, role and its state — no figure, no health', () => {
    wrap(<SiteDetail site={off('b', 'mfa_required')} />);
    const panel = screen.getByRole('complementary', { name: 'Site b' });
    expect(panel.textContent).toContain('b.example.com');
    expect(panel.textContent).toContain('Reader');
    expect(panel.textContent).toContain('Needs two-step verification');
    expect(panel.textContent).not.toMatch(/Published|Healthy|AI crawler/);
    expect(screen.getByRole('button', { name: 'Switch and verify' })).toBeTruthy();
  });

  it('readable collections only is marked; another site requests no page-level data', () => {
    raw.mockClear();
    wrap(<SiteDetail site={site('z', { publishedArticles: { count: 4, partial: true } })} />);
    expect(screen.getByText('readable collections only')).toBeTruthy();
    expect(screen.getByText('Page details are shown after switching to this site.')).toBeTruthy();
    expect(raw).not.toHaveBeenCalled();
  });

  it('the current site lists its most read pages', () => {
    raw.mockClear();
    wrap(<SiteDetail site={site('a')} />);
    expect(raw).toHaveBeenCalledWith('/api/v1/site/ai-traffic?days=30&previous=1');
  });
});

describe('reachability (spec studio/site-topology "可达性异常")', () => {
  it('a crawler blocked at the CDN is an attention item linking to the reachability record in Logs & monitoring', () => {
    wrap(<SiteDetail site={site('a', { health: { status: 'bad', reasons: [{ code: 'reachability_errors', count: 1 }] } })} />);
    const link = screen.getByRole('link', { name: /1 reachability error/ });
    expect(link.getAttribute('href')).toBe('/monitoring/reachability');
  });
});
