// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import i18n from 'i18next';
import type { ReactNode } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IngestSourceResource, LicenceReviewResource } from '@heopress/contracts/schemas';
import { initStudioI18n, setStudioLanguage } from '@/i18n';

/** Content › Sources: fallback order, ingestion settings, licence reviews (HeoPress P08 tasks 1.6, 1.7, 3.3). */

const review = (over: Partial<LicenceReviewResource>): LicenceReviewResource => ({
  id: 'r1',
  itemId: 'i1',
  collection: 'articles',
  title: 'Harbour season',
  sourceId: 'src1',
  sourceName: 'Harbour news',
  reason: 'review_overdue',
  action: 'hidden',
  state: 'open',
  licenceEffective: true,
  detectedAt: '2026-10-20T00:00:00.000Z',
  resolvedAt: null,
  resolvedBy: null,
  ...over,
});
const raw = vi.hoisted(() =>
  vi.fn(async (path: string, init?: { method?: string; body?: string }): Promise<{ data: unknown }> => {
    if (path.startsWith('/api/v1/ingest/providers/chains/') && !init?.method) return { data: { chain: ['native', 'firecrawl'], custom: false } };
    if (path === '/api/v1/ingest/settings' && !init?.method) return { data: { licenceLapsePolicy: 'hide', primarySourcePatterns: ['example.org/releases/'] } };
    if (path === '/api/v1/ingest/licence-reviews' && !init?.method) return { data: [] };
    if (path.endsWith('/resolve')) return { data: { resolved: ['r1'], refused: [] } };
    return { data: null };
  }),
);
vi.mock('@/lib/api', () => ({ getApiClient: () => ({ rawRequest: raw }) }));
vi.mock('../../api', async (orig) => ({ ...(await orig<typeof import('../../api')>()), siteKey: (...p: unknown[]) => ['s', ...p] }));

const { FallbackChainEditor, IngestSettingsPanel, LicenceReviewPanel } = await import('../ingest-lifecycle-panels');

beforeAll(async () => {
  await initStudioI18n(i18n);
  await setStudioLanguage('en', i18n);
});
beforeEach(() => {
  raw.mockClear();
});
const wrap = (node: ReactNode) => render(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>);
const source = { id: 'src1', name: 'Harbour news' } as IngestSourceResource;
const puts = () => raw.mock.calls.filter(([, init]) => init?.method === 'PUT' || init?.method === 'POST');

describe('fallback order editor', () => {
  it('reorders, adds and saves a per-source order; resets to the site default', async () => {
    wrap(<FallbackChainEditor source={source} canEdit onClose={() => undefined} />);
    expect(await screen.findByText('Using the site default order.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Move Firecrawl up' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Crawl4AI' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save order' }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    const [path, init] = puts()[0]!;
    expect(path).toBe('/api/v1/ingest/providers/chains/src1');
    expect(JSON.parse(init!.body!)).toEqual({ chain: ['firecrawl', 'native', 'crawl4ai'] });
  });
  it('is read-only for non-administrators', async () => {
    wrap(<FallbackChainEditor source={source} canEdit={false} onClose={() => undefined} />);
    await screen.findByText('Using the site default order.');
    expect(screen.queryByRole('button', { name: 'Save order' })).toBeNull();
  });
});

describe('ingestion settings', () => {
  it('saves the lapse policy and allow-list', async () => {
    wrap(<IngestSettingsPanel canEdit onClose={() => undefined} />);
    const policy = await screen.findByLabelText('When a source licence lapses');
    fireEvent.change(policy, { target: { value: 'flag' } });
    fireEvent.change(screen.getByLabelText('Primary-source allow-list'), { target: { value: 'example.org/releases/\n docs.example.com \n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(JSON.parse(puts()[0]![1]!.body!)).toEqual({ licenceLapsePolicy: 'flag', primarySourcePatterns: ['example.org/releases/', 'docs.example.com'] });
  });
});

describe('licence reviews', () => {
  it('restores one or many; restore is unavailable while the licence is not effective', async () => {
    raw.mockImplementationOnce(async () => ({ data: [review({}), review({ id: 'r2', itemId: 'i2', title: 'Ferry fares', licenceEffective: false })] }));
    wrap(<LicenceReviewPanel canEdit onClose={() => undefined} />);
    await screen.findByText('Ferry fares');
    const restores = screen.getAllByRole('button', { name: 'Restore' });
    expect((restores[1] as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('Select Harbour season'));
    fireEvent.click(screen.getByLabelText('Select Ferry fares'));
    fireEvent.click(screen.getByRole('button', { name: 'Restore 2 selected' }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(JSON.parse(puts()[0]![1]!.body!)).toEqual({ ids: ['r1', 'r2'], decision: 'restore' });
  });
  it('shows an empty queue', async () => {
    wrap(<LicenceReviewPanel canEdit onClose={() => undefined} />);
    expect(await screen.findByText('Nothing to review.')).toBeTruthy();
  });
});
