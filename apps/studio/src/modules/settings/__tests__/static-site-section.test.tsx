// @vitest-environment jsdom
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import i18n from 'i18next';
import { initStudioI18n, setStudioLanguage } from '@/i18n';

/** The static site section (HeoPress P11 task 4.3): target choice, Vercel Hobby notice, support matrix, records, rollback. */

const yes = { support: 'yes' };
const no = { support: 'no', note: 'runtime' };
const row = { noindex: yes, 'markdown-canonical': yes, 'redirect-301': yes, 'gone-410': yes, feeds: yes, search: no, preview: no, analytics: no };
const VIEW = {
  enabled: true,
  theme: 'official:starter',
  deployTargetId: null,
  platform: 'vps',
  publishedRevision: 12,
  activeGeneration: 3,
  activeRevision: 11,
  deployedGeneration: 3,
  deployedRevision: 11,
  rollbackCandidate: { id: 'sd_1', generation: 2, revision: 9 },
  support: { vps: row, 'cloudflare-pages': { ...row, 'gone-410': { support: 'degraded', note: '404' } }, vercel: row, netlify: row },
  deploys: [
    {
      id: 'sd_2',
      targetId: null,
      provider: 'netlify',
      kind: 'deploy',
      generation: 3,
      revision: 11,
      status: 'succeeded',
      providerDeploymentId: 'd2',
      url: 'https://site.example.net',
      error: null,
      log: null,
      warnings: null,
      reachability: { status: 'issues', issues: [{ url: 'https://www.example.com/a.md', code: 'wrong-type', severity: 'error', detail: 'Served as text/plain', advice: 'Add to the _headers file' }] },
      rollbackOf: null,
      createdAt: '2026-10-01T00:00:00Z',
      finishedAt: '2026-10-01T00:01:00Z',
    },
  ],
};
const configure = vi.fn().mockResolvedValue({ data: VIEW });
const rollback = vi.fn().mockResolvedValue({ data: { id: 'sd_3' } });

vi.mock('@/lib/api', () => ({
  getApiClient: () => ({ deployments: { static: { get: vi.fn().mockResolvedValue({ data: VIEW }), configure, rollback, redeploy: vi.fn() } } }),
}));

import { StaticSiteSection } from '../static-site-section';

beforeAll(async () => {
  await initStudioI18n(i18n);
  await setStudioLanguage('en', i18n);
});
afterEach(cleanup);

const TARGETS = [
  { id: 't_vc', provider: 'vercel', name: 'Shop', projectId: 'prj', defaultBranch: null, productionUrl: null, status: 'active', createdAt: '', updatedAt: '' },
  { id: 't_cf', provider: 'cloudflare-pages', name: 'Docs', projectId: 'a/b', defaultBranch: null, productionUrl: null, status: 'active', createdAt: '', updatedAt: '' },
] as const;

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <StaticSiteSection targets={[...TARGETS]} />
    </QueryClientProvider>,
  );
}

describe('StaticSiteSection', () => {
  it('choosing Vercel shows that the Hobby plan forbids commercial use', async () => {
    renderSection();
    await screen.findByText(/Published revision 12/);
    const select = screen.getByRole('combobox', { name: 'Deploy to' });
    expect(screen.queryByRole('note')).toBeNull();
    fireEvent.change(select, { target: { value: 't_vc' } });
    expect(screen.getByRole('note')).toHaveTextContent('Hobby plan does not allow commercial use');
    fireEvent.change(select, { target: { value: 't_cf' } });
    expect(screen.queryByRole('note')).toBeNull();
    const matrix = screen.getByRole('region', { name: 'What this target can serve' });
    expect(within(matrix).getByText('410 for withdrawn pages').parentElement).toHaveTextContent('Limited');
    expect(within(matrix).getByText('Site search').parentElement).toHaveTextContent('Unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(configure).toHaveBeenCalledWith({ enabled: true, theme: 'official:starter', deployTargetId: 't_cf' }));
  });

  it('records show the reachability issues with the platform advice; rollback asks first', async () => {
    renderSection();
    const records = await screen.findByRole('region', { name: 'Static deploys' });
    await waitFor(() => expect(within(records).getByText('1 issue(s)')).toBeInTheDocument());
    expect(records).toHaveTextContent('wrong-type');
    expect(records).toHaveTextContent('Add to the _headers file');
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Roll back to previous deploy' }));
    await waitFor(() => expect(rollback).toHaveBeenCalled());
    expect(await screen.findByRole('status')).toHaveTextContent('Requested');
  });
});
