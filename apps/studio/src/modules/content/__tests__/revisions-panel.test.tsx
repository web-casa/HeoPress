// @vitest-environment jsdom
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import i18n from 'i18next';
import { initStudioI18n, setStudioLanguage } from '@/i18n';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * Revert re-hydrates the editor with the reverted content (P02 task 8.5).
 *
 * The item editor re-seeds its draft from the cached item as soon as the draft
 * is cleared. `onRevert` therefore must run only after the item query has
 * refetched; before the fix it ran right after starting the invalidation, the
 * editor re-seeded from the pre-revert cache, and a later save overwrote the
 * revert.
 */

const revertRevision = vi.fn();
const listRevisions = vi.fn();
vi.mock('@/lib/api', () => ({
  getApiClient: () => ({ items: () => ({ listRevisions, revertRevision }) }),
}));

import { RevisionsPanel } from '../revisions-panel';

beforeAll(async () => {
  await initStudioI18n(i18n);
  await setStudioLanguage('en', i18n);
});

const revision = {
  id: 'rev_00000001',
  createdAt: '2026-01-01T00:00:00Z',
  userId: null,
  authorType: 'system',
  data: { title: 'Before' },
  delta: { title: 'Before' },
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('RevisionsPanel revert', () => {
  it('calls onRevert only after the item query holds the reverted content', async () => {
    let serverTitle = 'Current';
    const fetchItem = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { title: serverTitle };
    });
    listRevisions.mockResolvedValue({ data: [revision] });
    revertRevision.mockImplementation(async () => {
      serverTitle = 'Before';
      return { data: { id: 'item_1' } };
    });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const seenOnRevert: unknown[] = [];
    function ItemProbe() {
      useQuery({ queryKey: ['item', 'posts', 'item_1'], queryFn: fetchItem });
      return null;
    }
    render(
      <QueryClientProvider client={queryClient}>
        <ItemProbe />
        <RevisionsPanel
          itemVersion={7}
          collection="posts"
          itemId="item_1"
          onRevert={() => seenOnRevert.push(queryClient.getQueryData(['item', 'posts', 'item_1']))}
        />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(queryClient.getQueryData(['item', 'posts', 'item_1'])).toEqual({ title: 'Current' }));
    fireEvent.click(await screen.findByText(/rev_0000/));
    fireEvent.click(screen.getByRole('button', { name: /revert/i }));

    await waitFor(() => expect(seenOnRevert).toHaveLength(1));
    expect(seenOnRevert[0]).toEqual({ title: 'Before' });
  });

  it('asks for a reason when the CMS requires one (a published item\'s sponsor marking), then reverts with it', async () => {
    const { HeoPressError } = await import('@heopress/sdk');
    listRevisions.mockResolvedValue({ data: [revision] });
    revertRevision
      .mockRejectedValueOnce(new HeoPressError(422, { errors: [{ code: 'REASON_REQUIRED', message: 'needs a reason' }] }))
      .mockResolvedValueOnce({ data: { id: 'item_1' } });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const onRevert = vi.fn();
    render(
      <QueryClientProvider client={queryClient}>
        <RevisionsPanel itemVersion={3} collection="articles" itemId="item_1" onRevert={onRevert} />
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByText(/rev_0000/));
    fireEvent.click(screen.getByRole('button', { name: 'Revert to this' }));
    const input = await screen.findByLabelText('Reason for the revert');
    fireEvent.change(input, { target: { value: 'Campaign restored' } });
    fireEvent.click(screen.getByRole('button', { name: 'Revert with this reason' }));
    await waitFor(() => expect(onRevert).toHaveBeenCalled());
    expect(revertRevision).toHaveBeenLastCalledWith('item_1', 'rev_00000001', 3, 'Campaign restored');
  });
});
