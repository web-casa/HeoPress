// @vitest-environment jsdom
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

/** The site preset panel (HeoPress P07 task 2.4): the version and what the last upgrade left alone, or an error to retry. */
const site = { preset: vi.fn() };
vi.mock('@/lib/api', () => ({ getApiClient: () => ({ site }) }));

import { PresetReport } from '../content-settings-page';
import i18n from 'i18next';
import { initStudioI18n, setStudioLanguage } from '@/i18n';

beforeAll(async () => {
  await initStudioI18n(i18n);
  await setStudioLanguage('en', i18n);
});

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <PresetReport />
    </QueryClientProvider>,
  );
}
const report = (skipped: unknown[]) => ({ data: { preset: 'site-network', version: 3, installedAt: '2026-10-01T00:00:00Z', upgradedAt: null, report: { version: 3, at: '2026-10-21T00:00:00Z', added: [], skipped } } });

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PresetReport', () => {
  it('lists the fields an upgrade left alone, with why', async () => {
    site.preset.mockResolvedValue(report([{ collection: 'articles', field: 'faq', reason: 'site_field_with_same_name' }, { collection: 'pages', field: 'title', reason: 'exists' }]));
    renderPanel();
    expect(await screen.findByText(/articles · faq/)).toBeTruthy();
    expect(screen.getByText(/a field of your own has this name/)).toBeTruthy();
    expect(screen.queryByText(/pages · title/)).toBeNull();
  });

  it('says every field is in place when nothing was left alone; nothing without a preset', async () => {
    site.preset.mockResolvedValue(report([]));
    renderPanel();
    expect(await screen.findByText('Every field of the preset is in place.')).toBeTruthy();
    cleanup();
    site.preset.mockResolvedValue({ data: null });
    const { container } = renderPanel();
    await waitFor(() => expect(site.preset).toHaveBeenCalledTimes(2));
    expect(container.textContent).toBe('');
  });

  it('a failed request says so and can be retried', async () => {
    site.preset.mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce(report([]));
    renderPanel();
    expect(await screen.findByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByText('Try again'));
    expect(await screen.findByText('Every field of the preset is in place.')).toBeTruthy();
  });
});
