// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
// @vitest-environment jsdom
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import i18n from 'i18next';
import { initStudioI18n, setStudioLanguage } from '@/i18n';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * Content version panel tests (content-versioning task 6.5).
 * **Validates: Requirements 4.1, 4.3, 4.5**
 */

vi.mock('@/lib/api', () => ({ getActiveToken: () => 'tok', getActiveSite: () => 'site_1' }));
vi.mock('@/lib/api-base', () => ({ getApiBaseUrl: () => '' }));

import { VersionPanel } from '../version-panel';

beforeAll(async () => {
  await initStudioI18n(i18n);
  await setStudioLanguage('en', i18n);
});

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);
vi.stubGlobal('confirm', () => true);

function ok(data: unknown) {
  return { ok: true, json: () => Promise.resolve({ data }) } as Response;
}

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <VersionPanel collection="posts" itemId="item_1" />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
});

const version = { id: 'v1', key: 'draft', name: 'Draft', createdAt: '2026-01-01T00:00:00Z', mainChanged: true };

describe('VersionPanel', () => {
  it('lists versions with a "main changed" badge', async () => {
    fetchMock.mockResolvedValueOnce(ok([version]));
    renderPanel();
    await waitFor(() => expect(screen.getByText('Draft')).toBeTruthy());
    expect(screen.getByText('draft')).toBeTruthy();
    expect(screen.getByText('main changed')).toBeTruthy();
  });

  /** Answers by URL (the panel fetches the comparison and the merge diff together). */
  function route(table: Record<string, unknown>, fail: Record<string, { status: number; code: string; meta?: unknown }> = {}) {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const path = String(url).split('/versions')[1] ?? '';
      const key = `${init?.method ?? 'GET'} ${path}`;
      if (fail[key]) {
        const f = fail[key]!;
        return Promise.resolve({ ok: false, status: f.status, json: () => Promise.resolve({ errors: [{ code: f.code, message: f.code, meta: f.meta }] }) } as Response);
      }
      return Promise.resolve(ok(key in table ? table[key] : null));
    });
  }

  const cleanDiff = { state: 'open', revision: 2, baseVersion: 3, mainVersion: 4, branch: [{ field: 'title' }], main: [], merge: { clean: true, conflicts: [], fromBranch: ['title'], fromMain: [] } };
  const conflictDiff = {
    ...cleanDiff,
    merge: {
      clean: false,
      fromBranch: [],
      fromMain: [],
      conflicts: [{ id: 'body#p2', field: 'body', kind: 'block', blockId: 'p2', base: '<p>Two</p>', main: '<p>Two (main)</p>', branch: '<p>Two (branch)</p>' }],
    },
  };
  const compare = { main: { title: 'Live' }, version: { title: 'Drafted' }, changes: [{ key: 'title', state: 'changed', before: 'Live', after: 'Drafted' }] };

  it('compares a version with main and renders the field diff', async () => {
    route({ 'GET ': [version], 'GET /draft/compare': compare, 'GET /draft/diff': cleanDiff });
    renderPanel();
    await waitFor(() => expect(screen.getByText('Draft')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
    await waitFor(() => expect(screen.getByText('Drafted')).toBeTruthy());
    // The compare endpoint was hit.
    expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/versions/draft/compare'))).toBe(true);
  });

  it('P10: a clean merge names the versions it compared', async () => {
    route({ 'GET ': [version], 'GET /draft/compare': compare, 'GET /draft/diff': cleanDiff, 'POST /draft/merge': { branch: {} } });
    renderPanel();
    await waitFor(() => expect(screen.getByText('Draft')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
    await waitFor(() => expect(screen.getByTestId('merge-clean')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Merge' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Merged'));
    const call = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/versions/draft/merge'))!;
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({ expectedMainVersion: 4, expectedRevision: 2 });
  });

  it('P10: conflicts show base, main and branch; merging waits for a choice per conflict and sends it', async () => {
    route({ 'GET ': [version], 'GET /draft/compare': compare, 'GET /draft/diff': conflictDiff, 'POST /draft/merge': { branch: {} } });
    renderPanel();
    await waitFor(() => expect(screen.getByText('Draft')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
    await waitFor(() => expect(screen.getByTestId('merge-conflicts')).toBeTruthy());
    expect(screen.getByText('Block p2 of “body”')).toBeTruthy();
    expect(screen.getByText('<p>Two (main)</p>')).toBeTruthy();
    expect(screen.getByText('<p>Two (branch)</p>')).toBeTruthy();
    const merge = screen.getByRole('button', { name: 'Merge' }) as HTMLButtonElement;
    expect(merge.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('Keep branch'));
    expect(merge.disabled).toBe(false);
    fireEvent.click(merge);
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/versions/draft/merge'))).toBe(true));
    const call = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/versions/draft/merge'))!;
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({ expectedMainVersion: 4, expectedRevision: 2, resolutions: { 'body#p2': 'branch' } });
  });

  it('P10: a merge refused because main changed meanwhile asks to compare again', async () => {
    route({ 'GET ': [version], 'GET /draft/compare': compare, 'GET /draft/diff': cleanDiff }, { 'POST /draft/merge': { status: 409, code: 'MERGE_STALE' } });
    renderPanel();
    await waitFor(() => expect(screen.getByText('Draft')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
    await waitFor(() => expect(screen.getByTestId('merge-clean')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Merge' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('changed since this comparison'));
  });

  it('promotes a version onto the main version it compared, and a merged one onto the version it was merged against', async () => {
    route({ 'GET ': [version, { ...version, id: 'v2', key: 'merged', name: 'Merged one', state: 'merged', baseVersion: 7 }], 'GET /draft/diff': cleanDiff, 'POST /draft/promote': { id: 'item_1' }, 'POST /merged/promote': { id: 'item_1' } });
    renderPanel();
    await waitFor(() => expect(screen.getByText('Draft')).toBeTruthy());
    expect(screen.getByText('merged — pending')).toBeTruthy();
    const [first, second] = screen.getAllByRole('button', { name: 'Promote' });
    fireEvent.click(first!);
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/versions/draft/promote') && c[1]?.method === 'POST')).toBe(true));
    fireEvent.click(second!);
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/versions/merged/promote'))).toBe(true));
    const body = (key: string) => JSON.parse(String((fetchMock.mock.calls.find((c) => String(c[0]).endsWith(`/versions/${key}/promote`))![1] as RequestInit).body));
    expect(body('draft')).toEqual({ expectedVersion: 4 });
    expect(body('merged')).toEqual({ expectedVersion: 7 });
  });
});
