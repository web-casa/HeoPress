// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import i18n from 'i18next';
import type { ReactNode } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IngestProviderResource } from '@heopress/contracts/schemas';
import { initStudioI18n, setStudioLanguage } from '@/i18n';

/** Content › Sources › Crawl services (HeoPress P08 tasks 3.3, 3.4, 3.6). */

const perms = vi.hoisted(() => ({ isAdmin: true }));
const provider = (over: Partial<IngestProviderResource>): IngestProviderResource => ({
  provider: 'firecrawl',
  enabled: false,
  position: 0,
  consentAt: null,
  credentialSet: false,
  credentialHint: null,
  credentialKind: 'api_key',
  hosts: ['api.firecrawl.dev'],
  endpoint: null,
  accountId: null,
  monthlyBudgetUsd: null,
  pausedUntil: null,
  usage: { month: '2026-10', requests: 0, failures: 0, costUsd: 0, exhausted: false },
  unavailableReason: 'disabled',
  ...over,
});
const raw = vi.hoisted(() =>
  vi.fn(async (path: string, init?: { method?: string }) => {
    if (path === '/api/v1/ingest/providers' && !init?.method)
      return {
        data: [
          provider({ enabled: true, consentAt: '2026-10-01T00:00:00.000Z', credentialSet: true, credentialHint: 'abcd', monthlyBudgetUsd: 5, unavailableReason: 'budget_exhausted', usage: { month: '2026-10', requests: 12, failures: 1, costUsd: 5, exhausted: true } }),
          provider({ provider: 'crawl4ai', hosts: [], credentialKind: 'optional_token' }),
          provider({ provider: 'cloudflare', hosts: ['api.cloudflare.com'], credentialKind: 'api_token' }),
          provider({ provider: 'tinyfish', hosts: ['agent.tinyfish.ai'] }),
        ],
      };
    return { data: null };
  }),
);
vi.mock('@/lib/api', () => ({ getApiClient: () => ({ rawRequest: raw }) }));
vi.mock('@/lib/use-permissions', () => ({ usePermissions: () => ({ isAdmin: perms.isAdmin, canAdminister: perms.isAdmin, isLoading: false }) }));
vi.mock('../../api', async (orig) => ({ ...(await orig<typeof import('../../api')>()), siteKey: (...p: unknown[]) => ['s', ...p] }));

const { CrawlServicesPanel } = await import('../crawl-services-panel');

beforeAll(async () => {
  await initStudioI18n(i18n);
  await setStudioLanguage('en', i18n);
});
beforeEach(() => raw.mockClear());
const wrap = (node: ReactNode) => render(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>);

describe('crawl services panel', () => {
  it('shows each service with usage, budget state and a write-only credential', async () => {
    perms.isAdmin = true;
    wrap(<CrawlServicesPanel onClose={() => undefined} />);
    const fc = await screen.findByRole('form', { name: 'Firecrawl' });
    expect(within(fc).getByText('Budget used up')).toBeTruthy();
    expect(within(fc).getByText('12 requests')).toBeTruthy();
    const key = within(fc).getByLabelText('API key') as HTMLInputElement;
    expect(key.value).toBe('');
    expect(key.placeholder).toContain('abcd');
    expect(screen.getByRole('form', { name: 'Cloudflare Browser Run' })).toBeTruthy();
    expect(within(screen.getByRole('form', { name: 'Cloudflare Browser Run' })).getByLabelText('Account ID')).toBeTruthy();
  });

  it('saves consent, budget and a new credential', async () => {
    perms.isAdmin = true;
    wrap(<CrawlServicesPanel onClose={() => undefined} />);
    const tf = await screen.findByRole('form', { name: 'TinyFish' });
    fireEvent.click(within(tf).getByLabelText('Use this service'));
    fireEvent.click(within(tf).getByLabelText(/may be sent to TinyFish/));
    fireEvent.change(within(tf).getByLabelText('API key'), { target: { value: 'tf-secret' } });
    fireEvent.change(within(tf).getByLabelText(/Monthly budget/), { target: { value: '10' } });
    fireEvent.click(within(tf).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(raw).toHaveBeenCalledWith('/api/v1/ingest/providers/tinyfish', expect.objectContaining({ method: 'PATCH' })));
    const body = JSON.parse((raw.mock.calls.find((c) => c[1]?.method === 'PATCH')![1] as { body: string }).body) as Record<string, unknown>;
    expect(body).toMatchObject({ enabled: true, consent: true, credential: 'tf-secret', monthlyBudgetUsd: 10 });
  });

  it('non-administrators see the settings read-only', async () => {
    perms.isAdmin = false;
    wrap(<CrawlServicesPanel onClose={() => undefined} />);
    const fc = await screen.findByRole('form', { name: 'Firecrawl' });
    expect(within(fc).queryByRole('button', { name: 'Save' })).toBeNull();
    expect(within(fc).getByLabelText('Use this service').closest('fieldset')?.disabled).toBe(true);
  });
});
