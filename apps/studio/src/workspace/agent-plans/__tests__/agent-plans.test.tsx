// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import i18n from 'i18next';
import type { ReactNode } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initStudioI18n, setStudioLanguage } from '@/i18n';

/** Batch plans in Studio (HeoPress P10 tasks 3.2–3.4): the plan review per approval mode, canary and results. */

const state = vi.hoisted(() => ({ plan: null as Record<string, unknown> | null }));

const basePlan = (over: Record<string, unknown> = {}, viewer: Record<string, unknown> = {}) => ({
  id: 'pl1',
  operation: 'content_update',
  status: 'pending_approval',
  riskTier: 'canary',
  highRisk: false,
  siteCount: 2,
  approvalMode: 'solo',
  createdAt: '2026-10-26T00:00:00Z',
  expiresAt: '2026-10-29T00:00:00Z',
  arguments: { collection: 'articles' },
  scopeSummary: 'Exactly these 2 site(s): site_a, site_b.',
  requiresPreview: true,
  requiresCanary: true,
  requiredApprovals: 1,
  planHash: 'a'.repeat(64),
  revision: 1,
  draftedBy: 'u1',
  drafterEmail: 'drafter@example.com',
  coolingOffUntil: null,
  canaryConfirmedAt: null,
  decisionReason: null,
  items: [
    { siteId: 'site_a', position: 0, canary: true, arguments: {}, status: 'pending', result: null, attempts: 0 },
    { siteId: 'site_b', position: 1, canary: false, arguments: {}, status: 'pending', result: null, attempts: 0 },
  ],
  approvals: [],
  approvalsCurrent: 0,
  viewer: { isDrafter: true, eligible: true, canApprove: true, needsSecondFactor: true, canReject: true, canCancel: true, canExecute: false, canConfirmCanary: false, canRetry: false, ...viewer },
  ...over,
});

const raw = vi.hoisted(() =>
  vi.fn(async (path: string, init?: { method?: string; body?: string }) => {
    if (typeof path !== 'string') return { data: null };
    if (path === '/api/v1/agent-plans') return { data: [{ id: 'pl1', operation: 'content_delete', status: 'cooling_off', riskTier: 'highest', highRisk: true, siteCount: 1, approvalMode: 'solo', createdAt: '2026-10-26T00:00:00Z', expiresAt: '2026-10-29T00:00:00Z' }] };
    if (path.endsWith('/preview'))
      return { data: { items: [{ siteId: 'site_a', canary: true, expectedVersion: 3, currentVersion: 4, stale: true, changes: [{ field: 'title', current: 'Old', proposed: 'New' }] }], truncated: false } };
    if (init?.method === 'POST') {
      if (path.endsWith('/approve')) {
        state.plan = { ...state.plan!, status: 'approved', viewer: { ...(state.plan!.viewer as object), canApprove: false, canExecute: true } };
      }
      return { data: state.plan };
    }
    return { data: state.plan };
  }),
);
vi.mock('@/lib/api', () => ({ getApiClient: () => ({ rawRequest: raw }) }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  useParams: () => ({ planId: 'pl1' }),
  useRouterState: () => ({ location: { pathname: '/admin/settings/agent-plans/pl1' } }),
}));

const { AgentPlanDetailPage, AgentPlansPage } = await import('../agent-plans-page');
const { countByStatus, showValue, statusTone } = await import('../agent-plans-api');

beforeAll(async () => {
  await initStudioI18n(i18n);
  await setStudioLanguage('en', i18n);
});
beforeEach(() => raw.mockClear());

function wrap(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

describe('batch plans', () => {
  it('lists plans with tier and status', async () => {
    wrap(<AgentPlansPage />);
    expect(await screen.findByText('Delete content')).toBeTruthy();
    expect(screen.getByText('Highest')).toBeTruthy();
    expect(screen.getByText('Cooling off')).toBeTruthy();
  });

  it('solo drafter: approval needs the authenticator code and is bound to the plan hash', async () => {
    state.plan = basePlan();
    wrap(<AgentPlanDetailPage />);
    const approve = await screen.findByRole('button', { name: 'Approve' });
    expect((approve as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Authenticator code'), { target: { value: '123456' } });
    fireEvent.click(approve);
    await waitFor(() => expect(raw).toHaveBeenCalledWith('/api/v1/agent-plans/pl1/approve', expect.objectContaining({ method: 'POST' })));
    const call = raw.mock.calls.find((c) => c[0] === '/api/v1/agent-plans/pl1/approve')!;
    expect(JSON.parse(call[1]!.body!)).toEqual({ planHash: 'a'.repeat(64), secondFactor: '123456' });
    expect(await screen.findByRole('button', { name: 'Run canary' })).toBeTruthy();
    // The diff shows the current and proposed value, and a stale version.
    expect(screen.getByText('Old')).toBeTruthy();
    expect(screen.getByText('New')).toBeTruthy();
    expect(screen.getByText(/Changed since: expected 3, now 4/)).toBeTruthy();
  });

  it('team mode: the drafter cannot approve and is told why', async () => {
    state.plan = basePlan({ approvalMode: 'team' }, { canApprove: false, needsSecondFactor: false });
    wrap(<AgentPlanDetailPage />);
    expect(await screen.findByText(/someone other than the drafter must approve/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('canary review: confirm and per-site results', async () => {
    state.plan = basePlan(
      {
        status: 'canary_review',
        items: [
          { siteId: 'site_a', position: 0, canary: true, arguments: {}, status: 'succeeded', result: { code: 'X' }, attempts: 1 },
          { siteId: 'site_b', position: 1, canary: false, arguments: {}, status: 'pending', result: null, attempts: 0 },
        ],
      },
      { canApprove: false, canConfirmCanary: true },
    );
    wrap(<AgentPlanDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm canary results' }));
    await waitFor(() => expect(raw).toHaveBeenCalledWith('/api/v1/agent-plans/pl1/canary/confirm', expect.objectContaining({ method: 'POST' })));
    expect(screen.getByText(/Succeeded 1 · Pending 1/)).toBeTruthy();
  });

  it('helpers', () => {
    expect(statusTone('conflict')).toBe('bad');
    expect(statusTone('cooling_off')).toBe('warn');
    expect(statusTone('succeeded')).toBe('ok');
    expect(showValue(null)).toBe('—');
    expect(showValue('x'.repeat(200))).toHaveLength(118);
    expect(countByStatus([{ status: 'failed' }, { status: 'failed' }] as never)).toEqual({ failed: 2 });
  });
});
