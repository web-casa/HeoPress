// @vitest-environment jsdom
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { HeoPressError } from '@heopress/sdk';

/**
 * The reachability check page (HeoPress P07 task 3.9): the problems with their platform advice, the simulated crawlers
 * marked as simulated, a check of the chosen verified domains and platform, and the server's refusal shown.
 */
const site = { reachability: vi.fn(), runReachability: vi.fn() };
vi.mock('@/lib/api', () => ({ getApiClient: () => ({ site }) }));

import { ReachabilityPage } from '../reachability-page';
import i18n from 'i18next';
import { initStudioI18n, setStudioLanguage } from '@/i18n';

beforeAll(async () => {
  await initStudioI18n(i18n);
  await setStudioLanguage('en', i18n);
});

const platforms = [
  { id: 'vps', label: 'Own server (Caddy / Nginx)' },
  { id: 'netlify', label: 'Netlify' },
];
const hosts = [
  { hostname: 'www.example.com', primary: true, locale: null },
  { hostname: 'fr.example.com', primary: false, locale: 'fr' },
];
const run = { requested: false, lastRunAt: '2026-10-22T00:00:00Z', status: 'done', error: null, platform: 'netlify', hosts: null };
const report = {
  version: 1,
  platform: 'netlify',
  startedAt: '',
  finishedAt: '',
  hosts: [{ hostname: 'www.example.com', primary: true, locale: null, reachable: true, skipped: null }],
  checks: [
    {
      host: 'www.example.com',
      kind: 'markdown-copy',
      url: 'https://www.example.com/hello.md',
      expected: 'public',
      because: 'Markdown copies are on and the page is listable',
      status: 200,
      contentType: 'application/octet-stream',
      location: null,
      error: null,
      ok: false,
      skipped: false,
      code: 'wrong-type',
      severity: 'error',
      detail: 'Served as application/octet-stream; expected text/markdown',
      advice: 'Add to the _headers file (or a [[headers]] block in netlify.toml):\n/*.md\n  Content-Type: text/markdown; charset=utf-8',
    },
    {
      host: 'www.example.com',
      kind: 'llms',
      url: 'https://www.example.com/llms.txt',
      expected: 'absent',
      because: 'llms.txt is off',
      status: 404,
      contentType: 'text/html',
      location: null,
      error: null,
      ok: true,
      skipped: false,
      code: null,
      severity: null,
      detail: 'Answered 404: not public, as expected',
      advice: null,
    },
  ],
  crawlers: [
    {
      host: 'www.example.com',
      crawler: 'gptbot',
      userAgent: 'GPTBot',
      operator: 'OpenAI',
      purpose: 'training',
      simulated: true,
      allowedByRobots: true,
      status: 403,
      outcome: 'blocked',
      ok: false,
      code: 'crawler-blocked',
      severity: 'error',
      detail: 'robots.txt allows GPTBot, but the request was blocked: 403 (a browser gets 200)',
      advice: 'In Netlify, check the firewall traffic rules.',
    },
  ],
  traffic: [],
  simulationNote: 'Simulated request',
  summary: { errors: 2, warnings: 0, passed: 1, skipped: 0 },
  truncated: false,
};

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ReachabilityPage />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ReachabilityPage', () => {
  it('shows the problems with their advice, and the crawler requests marked simulated', async () => {
    site.reachability.mockResolvedValue({ data: { run, report, hosts, platforms } });
    renderPage();
    expect(await screen.findByText('Served as application/octet-stream; expected text/markdown')).toBeTruthy();
    // The advice as written (its lines kept: a header rule to copy).
    expect(screen.getByText((_, el) => el?.tagName === 'PRE' && !!el.textContent?.includes('/*.md\n  Content-Type: text/markdown'))).toBeTruthy();
    expect(screen.getByText('robots.txt allows GPTBot, but the request was blocked: 403 (a browser gets 200)')).toBeTruthy();
    expect(screen.getByText('Simulated')).toBeTruthy();
    expect(screen.getByText(/Simulated results: these requests carry the crawlers/)).toBeTruthy();
    // What is off and not served is not a problem: only in the full list.
    expect(screen.queryByText('llms.txt is off')).toBeNull();
    expect(screen.getByText(/2 error\(s\), 0 warning\(s\), 1 passed/)).toBeTruthy();
  });

  it('a check of the chosen domains and platform; the server\'s refusal is shown', async () => {
    site.reachability.mockResolvedValue({ data: { run, report: null, hosts, platforms } });
    site.runReachability.mockResolvedValue({ data: { requested: true } });
    renderPage();
    fireEvent.click(await screen.findByLabelText(/fr\.example\.com/));
    fireEvent.change(screen.getByLabelText('Deployed on'), { target: { value: 'vps' } });
    fireEvent.click(screen.getByText('Run check'));
    await vi.waitFor(() => expect(site.runReachability).toHaveBeenCalledWith({ platform: 'vps', hosts: ['www.example.com'] }));
    expect(await screen.findByText('Queued. The check runs within a minute.')).toBeTruthy();

    site.runReachability.mockRejectedValue(new HeoPressError(422, { errors: [{ code: 'DOMAIN_NOT_VERIFIED', message: 'x.example.com is not a verified domain serving this site; only those can be checked.' }] }));
    fireEvent.click(screen.getByText('Run check'));
    expect(await screen.findByText(/is not a verified domain serving this site/)).toBeTruthy();
  });

  it('a site without a verified domain is told to verify one', async () => {
    site.reachability.mockResolvedValue({ data: { run: { ...run, lastRunAt: null }, report: null, hosts: [], platforms } });
    renderPage();
    expect(await screen.findByText(/no verified domain to check/)).toBeTruthy();
    expect((screen.getByText('Run check').closest('button') as HTMLButtonElement).disabled).toBe(true);
  });
});
