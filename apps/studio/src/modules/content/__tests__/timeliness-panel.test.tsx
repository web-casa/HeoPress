// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initStudioI18n, setStudioLanguage } from '@/i18n';

/**
 * Timeliness panel (HeoPress v1.1; spec content/timeliness-marks): a marked item shows its badge — reason and
 * deadline — and can be cleared; an unmarked one is marked with a reason (and an optional deadline); a refusal is
 * shown; a reader gets no action. Every change hands the new item version back, so the editor's next save is based
 * on it.
 */

const markTimeliness = vi.fn();
const clearTimeliness = vi.fn();

vi.mock('@/lib/api', () => ({
  getApiClient: () => ({ items: () => ({ markTimeliness, clearTimeliness }) }),
}));

import { TimelinessPanel } from '../timeliness-panel';

const UNMARKED = { needsUpdateSince: null, reason: null, dueAt: null };
const MARKED = {
  needsUpdateSince: '2026-11-01T10:00:00.000Z',
  reason: 'Prices changed',
  dueAt: '2026-12-01T00:00:00.000Z',
};

function renderPanel(over: Partial<React.ComponentProps<typeof TimelinessPanel>> = {}) {
  const onChanged = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={client}>
      <TimelinessPanel
        collection="articles"
        itemId="item-1"
        mark={UNMARKED}
        version={4}
        canUpdate
        onChanged={onChanged}
        {...over}
      />
    </QueryClientProvider>,
  );
  return { ...utils, onChanged };
}

beforeAll(async () => {
  await initStudioI18n();
  await setStudioLanguage('en');
});

beforeEach(() => {
  markTimeliness.mockResolvedValue({
    data: { itemId: 'item-1', needsUpdateSince: '2026-11-10T00:00:00.000Z', reason: 'Prices changed', dueAt: null, version: 5 },
  });
  clearTimeliness.mockResolvedValue({
    data: { itemId: 'item-1', needsUpdateSince: null, reason: null, dueAt: null, version: 6 },
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('TimelinessPanel', () => {
  it('shows the badge with the reason and the deadline of a marked item', () => {
    renderPanel({ mark: MARKED });
    const badge = screen.getByTestId('timeliness-badge');
    expect(badge.textContent).toContain('Needs update');
    expect(badge.textContent).toContain('Prices changed');
    expect(badge.textContent).toMatch(/due .*2026/);
    expect(screen.getByRole('button', { name: 'Clear mark' })).toBeTruthy();
    // A marked item offers no second mark.
    expect(screen.queryByRole('button', { name: 'Mark as needs update' })).toBeNull();
  });

  it('marks an unmarked item with a reason and the optional deadline, then reports the new version', async () => {
    const { onChanged } = renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Mark as needs update' }));
    fireEvent.change(screen.getByLabelText('Why does it need an update?'), { target: { value: 'Prices changed' } });
    fireEvent.change(screen.getByLabelText('Update by (optional)'), { target: { value: '2026-12-01T09:30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save mark' }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(5));
    expect(markTimeliness).toHaveBeenCalledTimes(1);
    const [id, input] = markTimeliness.mock.calls[0]!;
    expect(id).toBe('item-1');
    expect(input).toMatchObject({ reason: 'Prices changed', expectedVersion: 4 });
    // The datetime-local value is sent as an ISO instant, in the browser's zone.
    expect(input.dueAt).toMatch(/^2026-12-01T/);
  });

  it('clears a mark with the version it is based on', async () => {
    const { onChanged } = renderPanel({ mark: MARKED, version: 7 });
    fireEvent.click(screen.getByRole('button', { name: 'Clear mark' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(6));
    expect(clearTimeliness).toHaveBeenCalledWith('item-1', { expectedVersion: 7 });
  });

  it('shows why a mark was refused', async () => {
    markTimeliness.mockRejectedValueOnce(new Error('Not saved: someone changed this item'));
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Mark as needs update' }));
    fireEvent.change(screen.getByLabelText('Why does it need an update?'), { target: { value: 'Stale data' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save mark' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('someone changed this item'));
  });

  it('gives a reader the badge but no action', () => {
    renderPanel({ mark: MARKED, canUpdate: false });
    expect(screen.getByTestId('timeliness-badge')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Clear mark' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('tells a reader of an unmarked item that nothing needs an update, with no form', () => {
    renderPanel({ canUpdate: false });
    expect(screen.getByText('Not marked as needing an update.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Mark as needs update' })).toBeNull();
  });
});
