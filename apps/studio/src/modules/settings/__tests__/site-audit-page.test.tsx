// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { HeoPressError } from '@heopress/sdk';

/** The site audit page (HeoPress P07 tasks 5.1, 5.2): issues with their pages (to the editor), a run, the rule filter. */
const site = { audit: vi.fn(), runAudit: vi.fn(), auditExport: vi.fn() };
vi.mock('@/lib/api', () => ({ getApiClient: () => ({ site }) }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, params }: { children: ReactNode; params: { collection: string; id: string } }) => <a href={`/content/${params.collection}/${params.id}`}>{children}</a>,
}));

import { SiteAuditPage } from '../site-audit-page';

const rules = [
  { id: 'links/broken', severity: 'error', title: 'Broken internal link', description: '' },
  { id: 'meta/duplicate-title', severity: 'warning', title: 'Duplicate title', description: '' },
];
const view = (issues: unknown[]) => ({ data: { run: { lastRunAt: '2026-10-22T00:00:00Z', status: 'done', requested: false, truncated: false, error: null }, rules, issues, total: issues.length } });

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SiteAuditPage />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('SiteAuditPage', () => {
  it('lists the issues with what was found and their pages, each to the editor; filters by rule', async () => {
    site.audit.mockResolvedValue(
      view([
        {
          id: 'i1',
          rule: 'links/broken',
          severity: 'error',
          title: 'Broken internal link',
          evidence: { href: '/gone/', reason: 'deleted' },
          pages: [{ itemId: 'a1', collection: 'articles', title: 'First post', url: 'https://example.com/first/' }],
          firstSeenAt: '',
          lastSeenAt: '',
        },
      ]),
    );
    renderPage();
    expect(await screen.findByText('Broken internal link', { selector: 'span' })).toBeTruthy();
    expect(screen.getByText('Link /gone/ (deleted)')).toBeTruthy();
    expect(screen.getByText('First post').getAttribute('href')).toBe('/content/articles/a1');
    site.audit.mockResolvedValue(view([]));
    fireEvent.change(screen.getByLabelText('Rule'), { target: { value: 'meta/duplicate-title' } });
    await vi.waitFor(() => expect(site.audit).toHaveBeenLastCalledWith('meta/duplicate-title'));
    expect(await screen.findByText('No issues for this rule.')).toBeTruthy();
  });

  it('the export is the server\'s (every issue, whatever the filter shows)', async () => {
    site.audit.mockResolvedValue(view([]));
    site.auditExport.mockResolvedValue({ version: 1, siteId: 's', generatedAt: '', issues: [] });
    const create = vi.fn(() => 'blob:x');
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    renderPage();
    fireEvent.change(await screen.findByLabelText('Rule'), { target: { value: 'links/broken' } });
    fireEvent.click(screen.getByText('Export JSON'));
    await vi.waitFor(() => expect(site.auditExport).toHaveBeenCalledWith());
    await vi.waitFor(() => expect(create).toHaveBeenCalled());
  });

  it('a run: queued for administrators, refused with its reason otherwise', async () => {
    site.audit.mockResolvedValue(view([]));
    site.runAudit.mockResolvedValue({ data: { requested: true } });
    renderPage();
    fireEvent.click(await screen.findByText('Run audit'));
    expect(await screen.findByText('Queued. The audit runs within a minute.')).toBeTruthy();
    cleanup();
    site.runAudit.mockRejectedValue(new HeoPressError(403, { errors: [{ code: 'FORBIDDEN', message: 'x' }] }));
    renderPage();
    fireEvent.click(await screen.findByText('Run audit'));
    expect(await screen.findByText('Only administrators can run the audit.')).toBeTruthy();
  });
});
