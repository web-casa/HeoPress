// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from 'i18next';
import { initStudioI18n, setStudioLanguage } from '@/i18n';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

/**
 * The storage settings page (HeoPress P04 task 6.3): profiles listed with
 * the secret only as the API's mask, which one takes new media, a
 * connection test, binding, creating an S3 profile (the secret is sent once
 * and never shown), and the API's refusal shown when a profile in use is
 * deleted.
 */

const h = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/lib/http', () => ({ siteFetch: h.fetch }));

import { StorageSettingsPage } from '../storage-page';

const MASK = '••••••••';
const profile = (over: Record<string, unknown> = {}) => ({
  id: 'sp_1',
  name: 'R2 media',
  driver: 's3',
  bucket: 'media',
  endpoint: 'https://acct.r2.example.com',
  region: 'auto',
  forcePathStyle: false,
  accessKeyId: 'AKIA-E2E',
  secretAccessKey: MASK,
  publicBaseUrl: 'https://img.example.com',
  bound: false,
  objectCount: 3,
  createdAt: '2026-10-17T00:00:00.000Z',
  updatedAt: '2026-10-17T00:00:00.000Z',
  ...over,
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function routes(handlers: Record<string, (init: RequestInit) => Response>) {
  h.fetch.mockImplementation(async (url: string, init: RequestInit = {}) => {
    const key = `${(init.method ?? 'GET').toUpperCase()} ${url}`;
    const handler = handlers[key];
    if (!handler) throw new Error(`unexpected ${key}`);
    return handler(init);
  });
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <StorageSettingsPage />
    </QueryClientProvider>,
  );
  return client;
}

/** Everything React Query holds: query data and mutation variables and results. */
const cacheText = (client: QueryClient) =>
  JSON.stringify([
    client.getQueryCache().getAll().map((q) => q.state),
    client.getMutationCache().getAll().map((m) => m.state),
  ]);


beforeAll(async () => {
  await initStudioI18n(i18n);
  await setStudioLanguage('en', i18n);
});

describe('StorageSettingsPage', () => {
  beforeEach(() => {
    h.fetch.mockReset();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('lists profiles with the secret masked and marks where new media goes', async () => {
    routes({ 'GET /api/v1/storage-profiles': () => json({ data: [profile()], meta: { boundProfileId: null } }) });
    renderPage();
    const row = await screen.findByTestId('storage-profile-sp_1');
    expect(within(row).getByText(MASK)).toBeTruthy();
    expect(within(row).getByText('3')).toBeTruthy();
    expect(within(screen.getByTestId('storage-default')).getByText('New media')).toBeTruthy();
  });

  it('tests a connection and shows the result', async () => {
    routes({
      'GET /api/v1/storage-profiles': () => json({ data: [profile()], meta: { boundProfileId: null } }),
      'POST /api/v1/storage-profiles/sp_1/test': () => json({ data: { ok: false, latencyMs: 12, error: 'Access denied' } }),
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /test connection/i }));
    expect(await screen.findByRole('status')).toHaveTextContent('Connection failed: Access denied');
  });

  it('binds a profile for new media', async () => {
    let bound: string | null = null;
    routes({
      'GET /api/v1/storage-profiles': () => json({ data: [profile({ bound: bound === 'sp_1' })], meta: { boundProfileId: bound } }),
      'PUT /api/v1/storage-profiles/binding': (init) => {
        bound = (JSON.parse(String(init.body)) as { profileId: string }).profileId;
        return json({ data: { profileId: bound } });
      },
    });
    renderPage();
    const row = await screen.findByTestId('storage-profile-sp_1');
    fireEvent.click(within(row).getByRole('button', { name: 'Use for new media' }));
    await waitFor(() => expect(within(screen.getByTestId('storage-profile-sp_1')).getByText('New media')).toBeTruthy());
    expect(bound).toBe('sp_1');
  });

  it('creates an S3 profile; the secret is sent once and kept nowhere afterwards', async () => {
    const posts: Array<Record<string, unknown>> = [];
    routes({
      'GET /api/v1/storage-profiles': () =>
        json({ data: posts.length ? [profile({ id: 'sp_2', name: 'New bucket' })] : [], meta: { boundProfileId: null } }),
      'POST /api/v1/storage-profiles': (init) => {
        posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return json({ data: profile({ id: 'sp_2', name: 'New bucket' }) }, 201);
      },
    });
    const client = renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /new storage profile/i }));
    const form = screen.getByRole('form', { name: 'New storage profile' });
    const type = (label: string, value: string) => fireEvent.change(within(form).getByLabelText(label), { target: { value } });
    type('Name', 'New bucket');
    type('Bucket', 'site-media');
    type('Access key ID', 'AKIA-NEW');
    type('Secret access key', 'super-secret');
    type('Public address', 'https://img.example.com');
    expect(within(form).getByLabelText('Secret access key')).toHaveAttribute('type', 'password');
    fireEvent.click(within(form).getByRole('button', { name: 'Create' }));
    await screen.findByTestId('storage-profile-sp_2');
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ name: 'New bucket', driver: 's3', bucket: 'site-media', accessKeyId: 'AKIA-NEW', secretAccessKey: 'super-secret' });
    // Afterwards: not on the page, not in any cache, not in a reopened form.
    expect(screen.queryByRole('form', { name: 'New storage profile' })).toBeNull();
    expect(document.body.innerHTML).not.toContain('super-secret');
    expect(cacheText(client)).not.toContain('super-secret');
    fireEvent.click(screen.getByRole('button', { name: /new storage profile/i }));
    expect(within(screen.getByRole('form', { name: 'New storage profile' })).getByLabelText('Secret access key')).toHaveValue('');
  });

  it('a refused creation shows the API’s reason, which does not echo the secret', async () => {
    routes({
      'GET /api/v1/storage-profiles': () => json({ data: [], meta: { boundProfileId: null } }),
      'POST /api/v1/storage-profiles': () => json({ errors: [{ code: 'VALIDATION', message: 'An S3 profile needs bucket.' }] }, 400),
    });
    const client = renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /new storage profile/i }));
    const form = screen.getByRole('form', { name: 'New storage profile' });
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Broken' } });
    fireEvent.change(within(form).getByLabelText('Secret access key'), { target: { value: 'typed-secret' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Create' }));
    const alert = await within(form).findByRole('alert');
    expect(alert).toHaveTextContent('An S3 profile needs bucket.');
    expect(alert.textContent).not.toContain('typed-secret');
    expect(cacheText(client)).not.toContain('typed-secret');
  });

  it('a person who is not an administrator of the site is told so and gets no form', async () => {
    routes({ 'GET /api/v1/storage-profiles': () => json({ errors: [{ code: 'FORBIDDEN', message: 'Forbidden' }] }, 403) });
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('Only administrators of this site can manage its storage.');
    expect(screen.queryByRole('button', { name: /new storage profile/i })).toBeNull();
  });

  it('shows why a profile in use cannot be deleted', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    routes({
      'GET /api/v1/storage-profiles': () => json({ data: [profile({ bound: true })], meta: { boundProfileId: 'sp_1' } }),
      'DELETE /api/v1/storage-profiles/sp_1': () =>
        json({ errors: [{ code: 'PROFILE_IN_USE', message: 'The profile is in use.' }] }, 409),
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete R2 media' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The profile is in use.');
  });
});
