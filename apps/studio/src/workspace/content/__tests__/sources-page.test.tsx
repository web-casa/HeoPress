// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import i18n from 'i18next';
import type { ReactNode } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IngestSourceResource } from '@heopress/contracts/schemas';
import { initStudioI18n, setStudioLanguage } from '@/i18n';

/** Content › Sources (HeoPress P08 tasks 1.1, 1.2, 1.4, 1.5). */

const perms = vi.hoisted(() => ({ isAdmin: false }));
const source = (over: Partial<IngestSourceResource>): IngestSourceResource => ({
  id: 's1',
  name: 'Example feed',
  type: 'rss',
  url: 'https://news.example.com/feed.xml',
  listSelectors: null,
  scheduleTimes: ['08:00'],
  timezone: 'Asia/Shanghai',
  maxItemsPerRun: 20,
  licenceStatus: 'unknown',
  usageMode: 'discovery_only',
  commercialUse: false,
  reviewDueAt: null,
  trustLevel: 'low',
  attribution: null,
  licenceValidUntil: null,
  licenceEffective: true,
  effectiveUsageMode: 'discovery_only',
  status: 'active',
  pausedReason: null,
  consecutiveFailures: 0,
  lastFailureCategory: null,
  lastFailureMessage: null,
  lastRunAt: null,
  nextRunAt: '2026-10-27T00:00:00.000Z',
  createdAt: '2026-10-26T00:00:00.000Z',
  updatedAt: '2026-10-26T00:00:00.000Z',
  ...over,
});
const state = vi.hoisted(() => ({ sources: [] as unknown[] }));
const raw = vi.hoisted(() =>
  vi.fn(async (path: string, init?: { method?: string; body?: string }) => {
    if (path === '/api/v1/ingest/sources' && !init?.method) return { data: state.sources };
    if (path === '/api/v1/ingest/sources' && init?.method === 'POST') return { data: { id: 'new' } };
    if (String(path).endsWith('/licences') && !init?.method)
      return {
        data: [
          { id: 'r2', sourceId: 's2', licenceStatus: 'licensed', usageMode: 'licensed_derivative', commercialUse: true, trustLevel: 'high', evidence: 'Contract EX-1', scope: null, validFrom: null, validUntil: '2026-01-01T00:00:00.000Z', reviewDueAt: null, attribution: null, setBy: 'u_admin', createdAt: '2025-06-01T00:00:00.000Z' },
          { id: 'r1', sourceId: 's2', licenceStatus: 'unknown', usageMode: 'discovery_only', commercialUse: false, trustLevel: 'low', evidence: null, scope: null, validFrom: null, validUntil: null, reviewDueAt: null, attribution: null, setBy: 'u_editor', createdAt: '2025-05-01T00:00:00.000Z' },
        ],
      };
    return { data: null };
  }),
);
vi.mock('@/lib/api', () => ({ getApiClient: () => ({ rawRequest: raw }) }));
vi.mock('@/lib/use-permissions', () => ({ usePermissions: () => ({ isAdmin: perms.isAdmin, canAdminister: perms.isAdmin, isLoading: false }) }));
vi.mock('../../api', async (orig) => ({ ...(await orig<typeof import('../../api')>()), siteKey: (...p: unknown[]) => ['s', ...p] }));

const { SourcesPage, parseTimes } = await import('../sources-page');

beforeAll(async () => {
  await initStudioI18n(i18n);
  await setStudioLanguage('en', i18n);
});
beforeEach(() => raw.mockClear());

const wrap = (node: ReactNode) => render(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>);

describe('parseTimes', () => {
  it('reads comma-separated local times, sorted and once each; anything else is refused', () => {
    expect(parseTimes('20:00, 8:00 08:00')).toEqual(['08:00', '20:00']);
    expect(parseTimes('')).toBeNull();
    expect(parseTimes('24:00')).toBeNull();
    expect(parseTimes('8am')).toBeNull();
  });
});

describe('sources page', () => {
  it('lists sources with their status, terms and health badges; an expired licence is called out', async () => {
    perms.isAdmin = false;
    state.sources = [
      source({}),
      source({ id: 's2', name: 'Licensed wire', licenceStatus: 'licensed', usageMode: 'licensed_derivative', licenceEffective: false, effectiveUsageMode: 'discovery_only', trustLevel: 'high', commercialUse: true }),
      source({ id: 's3', name: 'Broken feed', status: 'paused', pausedReason: 'failures', consecutiveFailures: 5, lastFailureCategory: 'network', nextRunAt: null }),
    ];
    wrap(<SourcesPage />);
    const first = await screen.findByText('Example feed');
    const row1 = first.closest('tr')!;
    for (const text of ['Active', 'Licence unknown', 'Discovery only', 'Low trust', 'Healthy']) expect(within(row1).getByText(text)).toBeTruthy();
    const row2 = screen.getByText('Licensed wire').closest('tr')!;
    expect(within(row2).getByText('Licensed derivative')).toBeTruthy();
    expect(within(row2).getByText('Licence not in effect: discovery only until reviewed')).toBeTruthy();
    const row3 = screen.getByText('Broken feed').closest('tr')!;
    expect(within(row3).getByText('Paused after failures')).toBeTruthy();
    expect(within(row3).getByText('5 failures in a row (Network)')).toBeTruthy();
    // An editor: no licence controls, no resume.
    expect(screen.queryByRole('button', { name: 'Licence & terms' })).toBeNull();
    expect(within(row3).queryByRole('button', { name: 'Resume' })).toBeNull();
    expect(within(row1).getByRole('button', { name: 'Pause' })).toBeTruthy();
  });

  it('an administrator sees licence controls and resume, and the licence history', async () => {
    perms.isAdmin = true;
    state.sources = [source({ id: 's2', name: 'Licensed wire', status: 'paused', pausedReason: 'manual' })];
    wrap(<SourcesPage />);
    const row = (await screen.findByText('Licensed wire')).closest('tr')!;
    expect(within(row).getByRole('button', { name: 'Resume' })).toBeTruthy();
    fireEvent.click(within(row).getByRole('button', { name: 'Licence & terms' }));
    expect(screen.getByRole('form', { name: 'Licence & terms' })).toBeTruthy();
    fireEvent.click(within(row).getByRole('button', { name: 'History' }));
    const history = await screen.findByRole('region', { name: 'Licence history' });
    expect(await within(history).findByText('Contract EX-1')).toBeTruthy();
    expect(within(history).getAllByText(/Set by/)).toHaveLength(2);
  });

  it('a new source: the form explains the default terms, checks times and time zone, and sends no terms', async () => {
    perms.isAdmin = false;
    state.sources = [];
    wrap(<SourcesPage />);
    expect(await screen.findByText('No sources yet')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'New source' }));
    const form = screen.getByRole('form', { name: 'New source' });
    expect(within(form).getByText(/licence unknown, discovery only/)).toBeTruthy();
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Wire' } });
    fireEvent.change(within(form).getByLabelText('URL'), { target: { value: 'https://wire.example.com/rss' } });
    fireEvent.change(within(form).getByLabelText(/^Times of day/), { target: { value: '8am' } });
    expect(within(form).getByText('Use HH:MM times, e.g. 08:00.')).toBeTruthy();
    expect((within(form).getByRole('button', { name: 'Create' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(form).getByLabelText(/^Times of day/), { target: { value: '08:00, 20:00' } });
    fireEvent.change(within(form).getByLabelText(/^Time zone/), { target: { value: 'Mars/Olympus' } });
    expect(within(form).getByText('Not a known time zone.')).toBeTruthy();
    fireEvent.change(within(form).getByLabelText(/^Time zone/), { target: { value: 'America/New_York' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(raw).toHaveBeenCalledWith('/api/v1/ingest/sources', expect.objectContaining({ method: 'POST' })));
    const sent = JSON.parse((raw.mock.calls.find((c) => c[1]?.method === 'POST')![1] as { body: string }).body) as Record<string, unknown>;
    expect(sent).toMatchObject({ name: 'Wire', type: 'rss', scheduleTimes: ['08:00', '20:00'], timezone: 'America/New_York' });
    expect(Object.keys(sent).some((k) => ['licenceStatus', 'usageMode', 'trustLevel', 'commercialUse'].includes(k))).toBe(false);
  });

  it('reads in Chinese', async () => {
    await setStudioLanguage('zh-CN', i18n);
    try {
      perms.isAdmin = false;
      state.sources = [source({})];
      wrap(<SourcesPage />);
      expect(await screen.findByText('授权未知')).toBeTruthy();
      expect(screen.getByText('仅发现')).toBeTruthy();
    } finally {
      await setStudioLanguage('en', i18n);
    }
  });
});
