// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initStudioI18n, setStudioLanguage } from '@/i18n';

/**
 * The items list's view of timeliness marks (HeoPress v1.1; spec content/timeliness-marks): a marked row shows the
 * badge, an unmarked one does not, and "needs update only" is sent to the server as the `needsUpdate` list parameter
 * instead of being filtered in the browser (the list is paginated server-side).
 */

const list = vi.fn();
const listFields = vi.fn();
const getCollection = vi.fn();

vi.mock('@/lib/api', () => ({
  getApiClient: () => ({
    items: () => ({ list }),
    schema: { listFields, getCollection },
    settings: { get: async () => ({ data: null }) },
  }),
  getActiveSite: () => 'site-1',
}));

vi.mock('@/lib/use-permissions', () => ({
  usePermissions: () => ({
    bundle: { admin: true },
    isLoading: false,
    isAdmin: true,
    canAdminister: true,
    can: () => true,
    get: () => null,
    fieldAllowed: () => true,
    filterFields: (_c: string, _a: string, fields: string[]) => fields,
  }),
}));

vi.mock('@/hooks/use-realtime', () => ({ useRealtimeSubscription: () => {} }));
vi.mock('@/modules/presets/api', () => ({
  getEffectivePreset: async () => null,
  saveUserView: async () => ({}),
  deleteBookmark: async () => ({ ok: true }),
  viewDiffers: () => false,
}));
vi.mock('@/modules/presets/bookmark-switcher', () => ({ BookmarkSwitcher: () => null }));
vi.mock('@/modules/presets/save-bookmark-dialog', () => ({ SaveBookmarkDialog: () => null }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children?: React.ReactNode }) => <a href="#/content/articles">{children}</a>,
  useParams: () => ({ collection: 'articles' }),
}));

import { ItemsListPage } from '../items-list';

const marked = {
  id: 'item-marked',
  siteId: 'site-1',
  collectionId: 'col-1',
  status: 'draft',
  data: { title: 'Old prices' },
  sort: 0,
  version: 2,
  hold: false,
  needsUpdateSince: '2026-11-01T10:00:00.000Z',
  needsUpdateReason: 'Prices changed',
  needsUpdateDueAt: '2026-12-01T00:00:00.000Z',
  userCreated: null,
  userUpdated: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-11-01T10:00:00.000Z',
  deletedAt: null,
};
const plain = {
  ...marked,
  id: 'item-plain',
  data: { title: 'Fresh one' },
  needsUpdateSince: null,
  needsUpdateReason: null,
  needsUpdateDueAt: null,
};

function renderList() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ItemsListPage />
    </QueryClientProvider>,
  );
}

beforeAll(async () => {
  await initStudioI18n();
  await setStudioLanguage('en');
});

beforeEach(() => {
  listFields.mockResolvedValue({
    data: [{ id: 'f1', name: 'title', type: 'string', interface: 'input', sortOrder: 1 }],
  });
  getCollection.mockResolvedValue({ data: { name: 'articles', label: 'Articles' } });
  list.mockResolvedValue({ data: [marked, plain], meta: { total: 2, limit: 25, offset: 0 } });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('items list — timeliness', () => {
  it('shows the badge only on the marked row', async () => {
    renderList();
    await waitFor(() => expect(screen.getByText('Old prices')).toBeTruthy());
    const badges = screen.getAllByTestId('timeliness-badge');
    expect(badges).toHaveLength(1);
    expect(badges[0]!.textContent).toContain('Needs update');
    // Unmarked rows say nothing about timeliness.
    const rows = screen.getAllByRole('row');
    const plainRow = rows.find((r) => r.textContent?.includes('Fresh one'))!;
    expect(plainRow.querySelector('[data-testid="timeliness-badge"]')).toBeNull();
  });

  it('sends “needs update only” to the server rather than filtering the page', async () => {
    renderList();
    await waitFor(() => expect(screen.getByText('Old prices')).toBeTruthy());
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ needsUpdate: undefined }));

    list.mockResolvedValue({ data: [marked], meta: { total: 1, limit: 25, offset: 0 } });
    fireEvent.click(screen.getByLabelText(/Needs update only/i));

    await waitFor(() => expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ needsUpdate: true })));
    // The server's answer is what is shown: the unmarked row is gone.
    await waitFor(() => expect(screen.queryByText('Fresh one')).toBeNull());
  });
});
