// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import i18n from 'i18next';
import { initStudioI18n, setStudioLanguage } from '@/i18n';
import type { ExtensionResource } from '@heopress/sdk';

const list = vi.fn();
const collections = vi.fn(async () => ({ data: [] }));

vi.mock('@/lib/api', () => ({
  getApiClient: () => ({
    extensions: {
      list,
      collections,
      update: vi.fn(),
      delete: vi.fn(),
      create: vi.fn(),
      approveUpgrade: vi.fn(),
      confirmPermissions: vi.fn(),
      rejectUpgrade: vi.fn(),
      exportCollections: vi.fn(),
      purgeCollections: vi.fn(),
    },
    rawRequest: vi.fn(),
  }),
}));

import { ExtensionsPage } from '../extensions-page';

function renderWithClient(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function extension(overrides: Partial<ExtensionResource> = {}): ExtensionResource {
  return {
    id: 'ext_1',
    siteId: 'site_1',
    key: 'acme_glossary',
    name: 'acme-glossary',
    version: '1.0.0',
    type: 'hook',
    enabled: true,
    bundleUrl: 'https://example.com/glossary.js',
    manifest: {},
    capabilities: ['ext:jobs', 'ext:events'],
    permissionsStatus: 'approved',
    installedBy: null,
    installedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  } as ExtensionResource;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeAll(async () => {
  await initStudioI18n(i18n);
  await setStudioLanguage('en', i18n);
});

describe('plugin list — contract versions (P14 task 7.3)', () => {
  it('marks a plugin whose extension points this instance no longer provides, naming them', async () => {
    list.mockResolvedValue({
      data: [
        extension({
          needsUpgrade: {
            points: ['jobs', 'events'],
            required: { jobs: '^2.0.0', events: '^2.0.0' },
            current: { jobs: '1.0.0', events: '1.0.0' },
          },
        }),
      ],
    });
    renderWithClient(<ExtensionsPage />);
    const notice = await screen.findByTestId('needs-upgrade');
    expect(notice).toHaveTextContent('Needs upgrade: jobs, events');
    // The rest of the plugin still shows.
    expect(screen.getByText('acme-glossary')).toBeInTheDocument();
  });

  it('shows no upgrade notice for a compatible plugin', async () => {
    list.mockResolvedValue({ data: [extension({ needsUpgrade: null })] });
    renderWithClient(<ExtensionsPage />);
    expect(await screen.findByText('acme-glossary')).toBeInTheDocument();
    expect(screen.queryByTestId('needs-upgrade')).not.toBeInTheDocument();
  });
});
