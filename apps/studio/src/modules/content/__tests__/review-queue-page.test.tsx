// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { initStudioI18n, setStudioLanguage } from '@/i18n';

/**
 * The review queue page (v1.1; spec content/stale-content-queue): the three groups with the server's counts, each row
 * opening the item, one empty state per group, the truncation notice, and the failure notice.
 */

const request = vi.fn();

vi.mock('@/lib/api', () => ({ getApiClient: () => ({ request }) }));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, params, children }: { to: string; params?: Record<string, string>; children: ReactNode }) => (
    <a href={params ? to.replace('$collection', params.collection ?? '').replace('$id', params.id ?? '') : to}>{children}</a>
  ),
}));

import { ReviewQueuePage } from '../review-queue-page';

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ReviewQueuePage />
    </QueryClientProvider>,
  );
}

const row = (overrides: Record<string, unknown>) => ({
  itemId: 'item-1',
  collection: 'articles',
  title: 'A title',
  reason: null,
  dueAt: null,
  updatedAt: '2026-11-01T00:00:00.000Z',
  group: 'manual',
  ...overrides,
});

beforeAll(async () => {
  await initStudioI18n();
  await setStudioLanguage('en');
});

beforeEach(() => {
  request.mockResolvedValue({
    data: {
      counts: { manual: 1, auto: 1, awaiting_review: 1 },
      items: [
        row({ itemId: 'm1', title: 'Manual one', group: 'manual', reason: 'Prices changed', dueAt: '2026-12-01T00:00:00.000Z' }),
        row({ itemId: 'a1', title: 'Auto one', group: 'auto', reason: 'auto:stale' }),
        row({ itemId: 'r1', title: 'Review one', group: 'awaiting_review' }),
      ],
      truncated: false,
      limit: 50,
    },
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ReviewQueuePage', () => {
  it('renders the three groups with their counts and each row in its group', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Manual one')).toBeTruthy());
    expect(screen.getByText('Auto one')).toBeTruthy();
    expect(screen.getByText('Review one')).toBeTruthy();
    expect(screen.getByTestId('review-count-manual').textContent).toBe('1');
    expect(screen.getByTestId('review-count-auto').textContent).toBe('1');
    expect(screen.getByTestId('review-count-awaiting_review').textContent).toBe('1');
    expect(request).toHaveBeenCalledWith('/api/v1/review-queue');
    // Each mark's reason is shown, including the sweep's own reason.
    expect(screen.getByText(/Prices changed/)).toBeTruthy();
    expect(screen.getByText(/auto:stale/)).toBeTruthy();
  });

  it('links every row to the item it came from', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Manual one')).toBeTruthy());
    expect(screen.getByText('Manual one').closest('a')?.getAttribute('href')).toBe('/content/articles/m1');
    expect(screen.getByText('Auto one').closest('a')?.getAttribute('href')).toBe('/content/articles/a1');
    expect(screen.getByText('Review one').closest('a')?.getAttribute('href')).toBe('/content/articles/r1');
  });

  it('shows an empty state in each group that has no rows, and the truncation notice', async () => {
    request.mockResolvedValue({
      data: { counts: { manual: 0, auto: 1, awaiting_review: 0 }, items: [row({ itemId: 'a1', title: 'Auto one', group: 'auto' })], truncated: true, limit: 1 },
    });
    renderPage();
    await waitFor(() => expect(screen.getByText('Auto one')).toBeTruthy());
    expect(screen.getAllByText('Nothing here.')).toHaveLength(2);
    expect(screen.getByText(/counts cover the items shown/i)).toBeTruthy();
  });

  it('says so when the queue cannot be loaded', async () => {
    request.mockRejectedValue(new Error('boom'));
    renderPage();
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/could not be loaded/i));
  });
});
