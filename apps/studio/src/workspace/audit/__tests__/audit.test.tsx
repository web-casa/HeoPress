// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import i18n from 'i18next';
import type { ReactNode } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initStudioI18n, setStudioLanguage } from '@/i18n';

const api = vi.hoisted(() => ({
  ignoreIssue: vi.fn(async () => ({ fingerprint: 'f', until: '2027-01-01T00:00:00Z' })),
  restoreIssue: vi.fn(async () => ({ fingerprint: 'f' })),
}));
const raw = vi.hoisted(() => vi.fn());
const route = vi.hoisted(() => ({ search: {} as Record<string, unknown> }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
  useRouterState: () => ({ location: { pathname: '/audit', search: route.search } }),
  useNavigate: () => vi.fn(),
}));
vi.mock('../../api', async (orig) => ({ ...(await orig<typeof import('../../api')>()), studioApi: api, siteKey: (...p: unknown[]) => ['s', ...p] }));
vi.mock('@/lib/api', () => ({ getApiClient: () => ({ rawRequest: raw }), getActiveToken: () => '' }));
vi.mock('@/lib/use-permissions', () => ({ usePermissions: () => ({ isAdmin: true, canAdminister: true, isLoading: false, can: () => true }) }));

const { AuditPage, AuditRunPanel, IssueDetail, issuesOf } = await import('../audit-page');
const { ToastRegion } = await import('../../ui/undo-toast');

beforeAll(async () => {
  await initStudioI18n(i18n);
  await setStudioLanguage('en', i18n);
});

const issue = (id: string, rule: string, severity: 'error' | 'warning' | 'notice', state: Record<string, unknown> = { status: 'open' }) => ({
  id,
  rule,
  severity,
  title: `Issue ${id}`,
  evidence: { target: 'https://a.example.com/impact-gone/', href: '/impact-gone/' },
  pages: [{ itemId: 'p1', collection: 'articles', title: 'Source', url: null }],
  firstSeenAt: '2026-10-20T00:00:00Z',
  lastSeenAt: '2026-10-24T00:00:00Z',
  state,
}) as unknown as Parameters<typeof issuesOf>[1][number];

const wrap = (node: ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      {node}
      <ToastRegion />
    </QueryClientProvider>,
  );

describe('views (p07a task 10.4)', () => {
  const all = [issue('w', 'meta/duplicate-title', 'warning'), issue('e', 'links/broken', 'error'), issue('i', 'links/broken', 'error', { status: 'ignored', reason: null, until: 'x', by: 'a', at: 'x' })];
  it('open lists not ignored issues, most severe first; ignored and categories split them', () => {
    expect(issuesOf('open', all).map((x) => x.id)).toEqual(['e', 'w']);
    expect(issuesOf('ignored', all).map((x) => x.id)).toEqual(['i']);
    expect(issuesOf('category:links', all).map((x) => x.id)).toEqual(['e']);
    expect(issuesOf('category:meta', all).map((x) => x.id)).toEqual(['w']);
  });
});

describe('issue detail (p07a tasks 10.4, 10.5)', () => {
  it('ignoring offers an undo that restores the issue', async () => {
    wrap(<IssueDetail issue={issue('e', 'links/broken', 'error')} rules={[]} canTriage sameTarget={() => 3} />);
    fireEvent.change(screen.getByLabelText('Reason (optional)'), { target: { value: 'known' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ignore issue' }));
    await waitFor(() => expect(api.ignoreIssue).toHaveBeenCalledWith('e', { reason: 'known', days: 90 }));
    const undo = await screen.findByRole('button', { name: 'Undo' });
    await act(async () => {
      fireEvent.click(undo);
    });
    expect(api.restoreIssue).toHaveBeenCalledWith('e');
  });

  it('an ignored issue shows who, until when and why, and can be restored', () => {
    wrap(<IssueDetail issue={issue('i', 'meta/duplicate-title', 'warning', { status: 'ignored', reason: 'expected', until: '2027-01-21T00:00:00Z', by: 'admin@example.com', at: '2026-10-24T00:00:00Z' })} rules={[]} canTriage sameTarget={() => 0} />);
    expect(screen.getByText(/Ignored by admin@example.com, until/)).toBeTruthy();
    expect(screen.getByText('Reason: expected')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Restore' })).toBeTruthy();
  });

  it('a member cannot triage', () => {
    wrap(<IssueDetail issue={issue('e', 'links/broken', 'error')} rules={[]} canTriage={false} sameTarget={() => 0} />);
    expect(screen.queryByRole('button', { name: 'Ignore issue' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Add a redirect for the old address' })).toBeNull();
  });

  it('broken link fix: checks first, shows before and after and the pages affected, then applies with the report', async () => {
    raw.mockReset();
    raw.mockResolvedValueOnce({ data: { summary: {}, import: [{ from: '/impact-gone/', to: '/impact-dest/' }], conflicts: [], loops: [], reportHash: 'a'.repeat(64) } });
    raw.mockResolvedValueOnce({ data: {} });
    wrap(<IssueDetail issue={issue('e', 'links/broken', 'error')} rules={[]} canTriage sameTarget={() => 3} />);
    fireEvent.change(screen.getByLabelText('New address'), { target: { value: '/impact-dest/' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    expect(await screen.findByText('/impact-gone/ → 301 /impact-dest/')).toBeTruthy();
    expect(screen.getByText('3 pages link to this address')).toBeTruthy();
    expect(raw).toHaveBeenCalledWith('/api/v1/redirects/import?dryRun=1', { method: 'POST', body: JSON.stringify({ content: '/impact-gone/,/impact-dest/', format: 'csv' }) });
    fireEvent.click(screen.getByRole('button', { name: 'Add redirect' }));
    expect(await screen.findByText('Redirect added — it takes effect now.')).toBeTruthy();
    expect(raw).toHaveBeenLastCalledWith('/api/v1/redirects/import', { method: 'POST', body: JSON.stringify({ content: '/impact-gone/,/impact-dest/', format: 'csv', reportHash: 'a'.repeat(64) }) });
  });
});

describe('the last audit in the panel (spec studio/audit-workspace "重新审计", "结果被截断")', () => {
  const run = (patch: Record<string, unknown> = {}) => ({ lastRunAt: '2026-10-24T08:00:00Z', status: 'done', requested: false, truncated: false, error: null, ...patch });

  it('a run cut short says the list is incomplete', () => {
    render(<AuditRunPanel run={run({ truncated: true })} canRun={false} pending={false} onRun={() => undefined} />);
    expect(screen.getByText('Cut short — the list is incomplete')).toBeTruthy();
  });

  it('running again: queued or going is shown and the button waits; done, the new time shows', () => {
    const onRun = vi.fn();
    const { rerender } = render(<AuditRunPanel run={run()} canRun pending={false} onRun={onRun} />);
    fireEvent.click(screen.getByRole('button', { name: 'Audit again' }));
    expect(onRun).toHaveBeenCalledOnce();
    rerender(<AuditRunPanel run={run({ requested: true })} canRun pending={false} onRun={onRun} />);
    expect(screen.getByRole('status').textContent).toBe('Queued or running');
    expect((screen.getByRole('button', { name: 'Audit again' }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<AuditRunPanel run={run({ lastRunAt: '2026-10-24T09:30:00Z' })} canRun pending={false} onRun={onRun} />);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByText('Completed')).toBeTruthy();
    expect(document.querySelector('time')?.getAttribute('datetime')).toBe('2026-10-24T09:30:00.000Z');
  });

  it('members see the state but no button', () => {
    render(<AuditRunPanel run={run()} canRun={false} pending={false} onRun={() => undefined} />);
    expect(screen.queryByRole('button', { name: 'Audit again' })).toBeNull();
  });
});

describe('the ignored view (spec studio/audit-workspace "已忽略为空")', () => {
  it('with nothing ignored: says so, and that ignored issues come back by themselves', async () => {
    route.search = { view: 'ignored' };
    raw.mockImplementation(async (path: string) =>
      path.endsWith('/resolved') ? { data: { issues: [], total: 0 } } : { data: { issues: [issue('i1', 'broken_internal_link', 'error')], rules: {}, run: { lastRunAt: null, status: null, requested: false, truncated: false, error: null } } },
    );
    wrap(<AuditPage />);
    expect(await screen.findByText('No ignored issues. An ignored issue comes back by itself when its time is up.')).toBeTruthy();
    route.search = {};
  });
});
