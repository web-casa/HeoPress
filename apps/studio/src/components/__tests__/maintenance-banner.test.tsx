// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import i18n from 'i18next';
import type { ReactElement } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initStudioI18n, setStudioLanguage } from '@/i18n';
import { MaintenanceBanner, readMaintenance } from '../maintenance-banner';

const rawRequest = vi.fn();
vi.mock('@/lib/api', () => ({
  getApiClient: () => ({ rawRequest }),
}));

function renderWithClient(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeAll(async () => {
  await initStudioI18n(i18n);
});

afterEach(() => {
  cleanup();
  rawRequest.mockReset();
});

describe('MaintenanceBanner (P13 upgrade write freeze)', () => {
  it('reads the maintenance endpoint, wrapped or bare', () => {
    expect(readMaintenance({ data: { active: true, since: '2026-10-29T01:00:00.000Z', reason: 'upgrade' } })).toEqual({ active: true, since: '2026-10-29T01:00:00.000Z' });
    expect(readMaintenance({ active: false })).toEqual({ active: false, since: null });
    expect(readMaintenance(null)).toEqual({ active: false, since: null });
  });

  it('says that changes cannot be saved while an upgrade runs (en and zh-CN)', async () => {
    await setStudioLanguage('en', i18n);
    rawRequest.mockResolvedValue({ data: { active: true, since: null, reason: 'upgrade' } });
    renderWithClient(<MaintenanceBanner />);
    expect(await screen.findByRole('status')).toHaveTextContent('Maintenance in progress');
    expect(screen.getByRole('status')).toHaveTextContent('changes cannot be saved right now');
    expect(rawRequest).toHaveBeenCalledWith('/api/v1/system/maintenance');
    cleanup();

    await setStudioLanguage('zh-CN', i18n);
    renderWithClient(<MaintenanceBanner initial={{ active: true, since: null }} />);
    expect(screen.getByRole('status')).toHaveTextContent('系统维护中');
  });

  it('renders nothing when maintenance is off or the endpoint fails', async () => {
    await setStudioLanguage('en', i18n);
    rawRequest.mockResolvedValue({ data: { active: false, since: null, reason: null } });
    const { container } = renderWithClient(<MaintenanceBanner />);
    await vi.waitFor(() => expect(rawRequest).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    cleanup();
    rawRequest.mockRejectedValue(new Error('offline'));
    const failed = renderWithClient(<MaintenanceBanner />);
    await vi.waitFor(() => expect(rawRequest).toHaveBeenCalledTimes(2));
    expect(failed.container).toBeEmptyDOMElement();
  });
});
