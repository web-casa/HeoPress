// @vitest-environment jsdom
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

/** The structured data panel (HeoPress P07 tasks 2.9, 2.10): extensions' site nodes and what was left out, and why. */
const site = { preset: vi.fn(), structuredData: vi.fn() };
vi.mock('@/lib/api', () => ({ getApiClient: () => ({ site }) }));

import { StructuredDataReport } from '../content-settings-page';
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
      <StructuredDataReport />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('StructuredDataReport', () => {
  it("lists the extensions' site nodes, their diagnostics and each page's", async () => {
    site.structuredData.mockResolvedValue({
      data: {
        site: {
          nodes: [{ source: 'extension:seo-partner', fragment: 'ext-seo-partner_org', type: 'Organization' }],
          diagnostics: [{ code: 'site-node-item-field', source: 'extension:seo-partner', message: "org: a site node cannot take an item's field (body); removed" }],
        },
        items: [{ itemId: 'i1', collection: 'articles', locale: 'en', path: '/ev', url: 'https://example.com/ev/', diagnostics: [{ code: 'foreign-id', source: 'item', message: 'node 2: @id is not a part of this page' }] }],
        itemsWithDiagnostics: 1,
      },
    });
    renderPanel();
    expect(await screen.findByText(/Organization \(seo-partner\)/)).toBeTruthy();
    expect(screen.getByText(/Extension seo-partner: org: a site node cannot take/)).toBeTruthy();
    expect(screen.getByText(/Left out of 1 page:/)).toBeTruthy();
    expect(screen.getByText(/Its structured data: node 2/)).toBeTruthy();
  });

  it('says when there is nothing to report; a failed request can be retried', async () => {
    const empty = { data: { site: { nodes: [], diagnostics: [] }, items: [], itemsWithDiagnostics: 0 } };
    site.structuredData.mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce(empty);
    renderPanel();
    expect(await screen.findByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByText('Try again'));
    expect(await screen.findByText(/No extension contributes structured data/)).toBeTruthy();
  });
});
