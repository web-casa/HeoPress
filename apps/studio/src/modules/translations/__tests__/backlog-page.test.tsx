// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { initStudioI18n, setStudioLanguage } from '@/i18n';

/**
 * Translation backlog page (v1.1; spec i18n/translation-backlog Req 1–3): three columns from one API answer, the
 * per-state counts, and "create translation" calling the group's drafts endpoint — disabled when a row has no group.
 */

const request = vi.fn();
const collectionsList = vi.fn();
const settingsGet = vi.fn();

vi.mock('@/lib/api', () => ({
  getApiClient: () => ({
    request,
    schema: { collections: { list: collectionsList } },
    settings: { get: settingsGet },
  }),
}));

import { TranslationBacklogPage } from '../backlog-page';

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TranslationBacklogPage />
    </QueryClientProvider>,
  );
}

beforeAll(async () => {
  await initStudioI18n();
  await setStudioLanguage('en');
});

beforeEach(() => {
  collectionsList.mockResolvedValue({ data: [{ name: 'articles' }] });
  settingsGet.mockResolvedValue({ data: { value: { supported: ['en', 'zh-CN'] } } });
  request.mockImplementation(async (path: string) => {
    if (path.startsWith('/api/v1/translation-groups/backlog')) {
      return {
        data: {
          locale: 'zh-CN',
          counts: { missing: 1, stale: 1, in_review: 1 },
          items: [
            { itemId: 'i1', groupId: 'g1', title: 'Missing one', slug: 'm', state: 'missing', updatedAt: null },
            { itemId: 'i2', groupId: null, title: 'Stale one', slug: 's', state: 'stale', updatedAt: null },
            { itemId: 'i3', groupId: 'g1', title: 'Review one', slug: 'r', state: 'in_review', updatedAt: null },
          ],
          truncated: false,
        },
      };
    }
    return { data: {} };
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('TranslationBacklogPage', () => {
  it('renders the three columns with their counts and the items in each', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Missing one')).toBeTruthy());
    expect(screen.getByText('Stale one')).toBeTruthy();
    expect(screen.getByText('Review one')).toBeTruthy();
    expect(screen.getByTestId('backlog-count-missing').textContent).toBe('1');
    expect(screen.getByTestId('backlog-count-stale').textContent).toBe('1');
    expect(screen.getByTestId('backlog-count-in_review').textContent).toBe('1');
  });

  it('creates a translation through the group’s drafts endpoint, and only when there is a group', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Missing one')).toBeTruthy());
    // The language defaults to the first supported one (the site's settings decide the order).
    expect(request).toHaveBeenCalledWith('/api/v1/translation-groups/backlog?collection=articles&locale=en');
    const buttons = screen.getAllByRole('button', { name: 'Create translation' });
    // The stale row has no group: its button is disabled with the reason.
    const disabled = buttons.filter((b) => (b as HTMLButtonElement).disabled);
    expect(disabled).toHaveLength(1);
    expect(disabled[0]!.getAttribute('title')).toMatch(/no translation group/i);
    fireEvent.click(buttons[0]!);
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('/api/v1/translation-groups/g1/drafts', {
        method: 'POST',
        body: JSON.stringify({ locale: 'en' }),
      }),
    );
  });
});
