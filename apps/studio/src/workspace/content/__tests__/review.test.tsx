// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import i18n from 'i18next';
import type { ReactNode } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initStudioI18n, setStudioLanguage } from '@/i18n';

const api = vi.hoisted(() => ({ approve: vi.fn(async () => ({})), reject: vi.fn(async () => ({})) }));
const perms = vi.hoisted(() => ({ review: true }));
const raw = vi.hoisted(() =>
  vi.fn(async (path: string) => {
    if (path.endsWith('/checks')) return { data: { itemId: 'i1', checks: [{ id: 'title', status: 'warn', reason: 'too_short', value: 5 }, { id: 'links', status: 'pass' }] } };
    if (path.endsWith('/history')) return { data: [] };
    return { data: { id: 'i1', status: 'draft', version: 3, editorialState: 'in_review', publishAt: null, data: { title: 'Short', body: '<p>Hello there world</p>' } } };
  }),
);
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
  useRouterState: () => ({ location: { pathname: '/content', search: {} } }),
  useNavigate: () => vi.fn(),
}));
vi.mock('@/lib/api', () => ({ getApiClient: () => ({ rawRequest: raw }) }));
vi.mock('@/lib/use-permissions', () => ({ usePermissions: () => ({ isAdmin: false, can: (_c: string, a: string) => (a === 'review' ? perms.review : true) }) }));
vi.mock('../../api', async (orig) => ({ ...(await orig<typeof import('../../api')>()), studioApi: api, siteKey: (...p: unknown[]) => ['s', ...p] }));

const { ReviewDetail, stateOf } = await import('../review-page');

beforeAll(async () => {
  await initStudioI18n(i18n);
  await setStudioLanguage('en', i18n);
});

const row = { id: 'i1', collection: 'articles', title: 'Short', status: 'draft', editorialState: 'in_review', author: { id: 'u', email: 'author@example.com' }, locale: 'en', publishAt: null, updatedAt: '2026-10-24T10:00:00Z', version: 3 };
const wrap = (node: ReactNode) => render(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>);

describe('review detail (p07a tasks 5.5, 5.6)', () => {
  it('sending back needs a reason', async () => {
    perms.review = true;
    wrap(<ReviewDetail row={row} onDone={() => undefined} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Send back' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Send back' }).at(-1)!);
    expect(screen.getByRole('alert').textContent).toContain('Write a reason');
    expect(api.reject).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Why is it sent back?'), { target: { value: 'Add the source' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Send back' }).at(-1)!);
    await waitFor(() => expect(api.reject).toHaveBeenCalledWith('articles', 'i1', { reason: 'Add the source', expectedVersion: 3 }));
  });

  it('⌘↵ with a failing check shows it first and approves only after the second confirmation', async () => {
    api.approve.mockClear();
    const onDone = vi.fn();
    wrap(<ReviewDetail row={row} onDone={onDone} />);
    await screen.findByText('Too short (5)');
    fireEvent.keyDown(window, { key: 'Enter', metaKey: true });
    const confirm = await screen.findByRole('alertdialog', { name: 'Approve anyway' });
    expect(confirm.textContent).toContain('Title length');
    expect(api.approve).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(api.approve).toHaveBeenCalledOnce());
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it('without the review permission the decisions are not offered, with the reason', async () => {
    perms.review = false;
    wrap(<ReviewDetail row={row} onDone={() => undefined} />);
    expect(await screen.findByText('Needs an administrator or a role with the review permission.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull();
  });

  it('a future publish time on an approved item is scheduled', () => {
    expect(stateOf({ status: 'draft', editorialState: 'approved', publishAt: new Date(Date.now() + 60_000).toISOString() })).toBe('scheduled');
    expect(stateOf({ status: 'published', editorialState: 'approved', publishAt: null })).toBe('published');
    expect(stateOf({ status: 'draft', editorialState: null, publishAt: null })).toBe('draft');
  });
});

describe('approve and publish (p07a task 5.5, spec "批准并发布时发布失败")', () => {
  it('approved but the publish refused: the reason and a retry are shown, the approval stands', async () => {
    perms.review = true;
    api.approve.mockClear();
    raw.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (init?.method === 'PATCH') throw new Error('Another page already answers at this address.');
      if (path.endsWith('/checks')) return { data: { itemId: 'i1', checks: [] } };
      if (path.endsWith('/history')) return { data: [] };
      // Once approved, the item reads back approved (and still a draft).
      const state = api.approve.mock.calls.length ? 'approved' : 'in_review';
      return { data: { id: 'i1', status: 'draft', version: 3, editorialState: state, publishAt: null, data: { title: 'Short', body: '<p>x</p>' } } };
    });
    const onDone = vi.fn();
    const client = new QueryClient();
    const { rerender } = render(<QueryClientProvider client={client}><ReviewDetail row={row} onDone={onDone} /></QueryClientProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve and publish' }));
    expect(await screen.findByText('Approved, but publishing failed: Another page already answers at this address.')).toBeTruthy();
    // The list refreshes: the item is approved, still a draft.
    rerender(<QueryClientProvider client={client}><ReviewDetail row={{ ...row, editorialState: 'approved' }} onDone={onDone} /></QueryClientProvider>);
    expect(await screen.findByRole('button', { name: 'Retry publishing' })).toBeTruthy();
    expect(api.approve).toHaveBeenCalledOnce();
    expect(onDone).not.toHaveBeenCalled();
  });
});
