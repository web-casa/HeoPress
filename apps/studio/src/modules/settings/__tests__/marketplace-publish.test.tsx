// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from 'i18next';
import { initStudioI18n, setStudioLanguage } from '@/i18n';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * Marketplace publish dialog tests (studio-ops-ui task 3.2).
 *
 * **Validates: Requirements 3.1, 3.2**
 */

const rawRequest = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api', () => ({
  getApiClient: () => ({
    extensions: {
      list: vi.fn().mockResolvedValue({ data: [{ id: 'ext_1', name: 'My Hook' }] }),
    },
    rawRequest,
  }),
}));


import { MarketplacePage } from '../marketplace-page';

const SHA = 'a'.repeat(64);

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MarketplacePage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  rawRequest.mockResolvedValue({ data: [] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});


beforeAll(async () => {
  await initStudioI18n(i18n);
  await setStudioLanguage('en', i18n);
});

describe('Marketplace publish', () => {
  it('submits the publish payload (Req 3.1)', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /publish extension/i }));

    await screen.findByRole('option', { name: 'My Hook' });
    fireEvent.change(screen.getByLabelText('Extension to publish'), {
      target: { value: 'ext_1' },
    });
    fireEvent.change(screen.getByPlaceholderText('my-extension'), {
      target: { value: 'my-hook' },
    });
    fireEvent.change(screen.getByLabelText(/^Publisher \*/), { target: { value: 'acme' } });
    fireEvent.change(screen.getByLabelText(/Publisher key id/), { target: { value: 'key_1' } });
    fireEvent.change(screen.getByLabelText(/Bundle signature/), { target: { value: 'sig==' } });
    fireEvent.change(screen.getByLabelText(/Bundle SHA-256/), { target: { value: SHA } });
    fireEvent.click(screen.getByRole('button', { name: 'Publish to catalog' }));

    await waitFor(() => {
      const call = rawRequest.mock.calls.find(([path]) => path === '/api/v1/marketplace/publish');
      expect(call).toBeDefined();
      expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({
        extensionId: 'ext_1',
        marketplaceSlug: 'my-hook',
        publisher: 'acme',
        signature: 'sig==',
        signatureAlg: 'ed25519',
        publisherKeyId: 'key_1',
        bundleSha256: SHA,
      });
    });
  });

  it('shows the backend error inline (Req 3.2)', async () => {
    rawRequest.mockImplementation((path: string) =>
      path === '/api/v1/marketplace/publish'
        ? Promise.reject(new Error('Extension not found'))
        : Promise.resolve({ data: [] }),
    );
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /publish extension/i }));

    await screen.findByRole('option', { name: 'My Hook' });
    fireEvent.change(screen.getByLabelText('Extension to publish'), {
      target: { value: 'ext_1' },
    });
    fireEvent.change(screen.getByPlaceholderText('my-extension'), {
      target: { value: 'my-hook' },
    });
    fireEvent.change(screen.getByLabelText(/^Publisher \*/), { target: { value: 'acme' } });
    fireEvent.change(screen.getByLabelText(/Publisher key id/), { target: { value: 'key_1' } });
    fireEvent.change(screen.getByLabelText(/Bundle signature/), { target: { value: 'sig==' } });
    fireEvent.change(screen.getByLabelText(/Bundle SHA-256/), { target: { value: SHA } });
    fireEvent.click(screen.getByRole('button', { name: 'Publish to catalog' }));

    expect(await screen.findByText('Extension not found')).toBeInTheDocument();
  });
});
