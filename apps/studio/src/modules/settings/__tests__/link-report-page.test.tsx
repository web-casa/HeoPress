// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { HeoPressError } from '@heopress/sdk';

/** The links page (HeoPress P07 tasks 5.3, 5.4): broken links to the editor, orphans with their other ways in, navigation links. */
const site = { linkReport: vi.fn(), manualLinks: vi.fn(), scanLinks: vi.fn(), addManualLink: vi.fn(), deleteManualLink: vi.fn() };
vi.mock('@/lib/api', () => ({ getApiClient: () => ({ site }) }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, params }: { children: ReactNode; params: { collection: string; id: string } }) => <a href={`/content/${params.collection}/${params.id}`}>{children}</a>,
}));

import { LinkReportPage } from '../link-report-page';

const report = {
  scan: { status: 'done', startedAt: '2026-10-22T00:00:00Z', finishedAt: '2026-10-22T00:01:00Z', processed: 3, lastError: null },
  broken: [
    { source: { kind: 'item', itemId: 'a1', collection: 'articles', title: 'First post', url: null }, field: 'body', position: 0, href: '/gone/', anchorText: 'old', targetUrl: 'https://example.com/gone/', reason: 'unpublished' },
    { source: { kind: 'navigation', linkId: 'n1', label: 'Footer' }, field: null, position: 0, href: 'https://example.com/x/', anchorText: '', targetUrl: 'https://example.com/x/', reason: 'missing' },
  ],
  brokenTotal: 2,
  orphans: [{ itemId: 'p1', collection: 'pages', title: 'About', url: null, locale: 'en', listing: false, navigation: 1 }],
  orphansTotal: 1,
  unchecked: 0,
  truncated: false,
};

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <LinkReportPage />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('LinkReportPage', () => {
  it('broken links with their source (to the editor) and why; orphans; an administrator registers a navigation link', async () => {
    site.linkReport.mockResolvedValue({ data: report });
    site.manualLinks.mockResolvedValue({ data: [] });
    site.addManualLink.mockResolvedValue({ data: { id: 'n2' } });
    renderPage();
    expect((await screen.findByText('First post')).getAttribute('href')).toBe('/content/articles/a1');
    expect(screen.getByText('unpublished')).toBeTruthy();
    expect(screen.getByText('Navigation: Footer')).toBeTruthy();
    expect(screen.getByText('About').getAttribute('href')).toBe('/content/pages/p1');
    fireEvent.change(await screen.findByLabelText('Where'), { target: { value: 'Header menu' } });
    fireEvent.change(screen.getByLabelText('Address'), { target: { value: 'https://example.com/about/' } });
    fireEvent.click(screen.getByText('Add'));
    await vi.waitFor(() => expect(site.addManualLink).toHaveBeenCalledWith({ label: 'Header menu', url: 'https://example.com/about/' }));
    fireEvent.click(screen.getByText('Scan now'));
    await vi.waitFor(() => expect(site.scanLinks).toHaveBeenCalled());
  });

  it('not an administrator: no scan, no navigation links section', async () => {
    site.linkReport.mockResolvedValue({ data: { ...report, broken: report.broken.slice(0, 1) } });
    site.manualLinks.mockRejectedValue(new HeoPressError(403, { errors: [{ code: 'FORBIDDEN', message: 'x' }] }));
    renderPage();
    expect(await screen.findByText('First post')).toBeTruthy();
    await vi.waitFor(() => expect(site.manualLinks).toHaveBeenCalled());
    expect(screen.queryByText('Scan now')).toBeNull();
    expect(screen.queryByText('Registered navigation links')).toBeNull();
  });
});
