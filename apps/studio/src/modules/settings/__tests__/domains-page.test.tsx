// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { DomainResource } from '@heopress/sdk';

/**
 * Domains page (HeoPress P04 task 5.6): add a domain with its verification
 * method and language entry, show the records to publish and the status,
 * report why verification failed, issue a new token, make a domain primary,
 * switch it off, and register a language entry.
 */

const domains = {
  list: vi.fn(),
  create: vi.fn(),
  verify: vi.fn(),
  setPrimary: vi.fn(),
  update: vi.fn(),
  newToken: vi.fn(),
  delete: vi.fn(),
};

vi.mock('@/lib/api', () => ({
  getApiClient: () => ({ domains }),
}));

import { DomainsSettingsPage } from '../domains-page';

const base: DomainResource = {
  id: 'dom_1',
  hostname: 'example.com',
  kind: 'custom',
  isPrimary: false,
  status: 'pending',
  statusReason: null,
  sslStatus: null,
  verificationMethod: 'dns_txt',
  verificationExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  entryLocale: null,
  verification: {
    records: [{ type: 'TXT', name: '_heopress-challenge.example.com', value: 'heopress-verify-abc', purpose: 'Add this TXT record, then verify.' }],
  },
  verifiedAt: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <DomainsSettingsPage />
    </QueryClientProvider>,
  );
}

const row = async (hostname: string) => within(await screen.findByRole('listitem', { name: hostname }));

beforeEach(() => {
  for (const fn of Object.values(domains)) fn.mockReset();
});
afterEach(() => cleanup());

describe('DomainsSettingsPage', () => {
  it('a domain recorded as failed is marked so, with the reason (HeoPress P07a spec studio/site-topology "已记录为失败的域名")', async () => {
    domains.list.mockResolvedValue({ data: [{ ...base, status: 'failed', statusReason: 'Certificate could not be issued: CAA record forbids it.' }] });
    renderPage();
    expect(await screen.findByText('Failed')).toBeTruthy();
    expect(screen.getByText('Certificate could not be issued: CAA record forbids it.')).toBeTruthy();
  });

  it('shows a pending domain with the record to publish and when its token expires', async () => {
    domains.list.mockResolvedValue({ data: [base] });
    renderPage();
    const r = await row('example.com');
    expect(r.getByText('Pending verification')).toBeTruthy();
    expect(r.getByText('_heopress-challenge.example.com')).toBeTruthy();
    expect(r.getByText('heopress-verify-abc')).toBeTruthy();
    expect(r.getByText(/Token valid until/)).toBeTruthy();
    expect(r.queryByLabelText('Set primary')).toBeNull(); // only active domains can be primary
  });

  it('says why verification failed and offers a new token', async () => {
    domains.list.mockResolvedValue({ data: [base] });
    domains.verify.mockRejectedValue(new Error('The verification record was not found yet. DNS changes can take a while to appear.'));
    domains.newToken.mockResolvedValue({ data: base });
    renderPage();
    const r = await row('example.com');
    fireEvent.click(r.getByLabelText('Verify'));
    expect((await r.findByRole('alert')).textContent).toMatch(/not found yet/);
    fireEvent.click(r.getByLabelText('New token'));
    await waitFor(() => expect(domains.newToken).toHaveBeenCalledWith('dom_1'));
  });

  it('tells the user to serve the HTTP file from the domain\'s current host, not from HeoPress', async () => {
    domains.list.mockResolvedValue({
      data: [{ ...base, verificationMethod: 'http_file', verification: { records: [{ type: 'HTTP', name: 'http://example.com/.well-known/heopress-verification.txt', value: 'heopress-verify-abc', purpose: '' }] } }],
    });
    renderPage();
    const r = await row('example.com');
    expect(r.getByText(/from the server that hosts the domain now — before pointing it at HeoPress/)).toBeTruthy();
    expect(r.queryByText(/point the domain here/)).toBeNull();
  });

  it('marks an expired token', async () => {
    domains.list.mockResolvedValue({ data: [{ ...base, verificationExpiresAt: new Date(Date.now() - 1000).toISOString() }] });
    renderPage();
    expect((await row('example.com')).getByText(/token has expired/)).toBeTruthy();
  });

  it('makes an active domain primary, switches one off, and registers a language entry', async () => {
    const active = { ...base, status: 'active' as const, verifiedAt: base.createdAt, verification: { records: [] } };
    domains.list.mockResolvedValue({
      data: [
        { ...active, id: 'dom_1', hostname: 'example.com' },
        { ...active, id: 'dom_2', hostname: 'en.example.com' },
      ],
    });
    domains.setPrimary.mockResolvedValue({ data: active });
    domains.update.mockResolvedValue({ data: active });
    renderPage();
    const first = await row('example.com');
    fireEvent.click(first.getByLabelText('Set primary'));
    await waitFor(() => expect(domains.setPrimary).toHaveBeenCalledWith('dom_1'));
    fireEvent.click(first.getByLabelText('Disable'));
    await waitFor(() => expect(domains.update).toHaveBeenCalledWith('dom_1', { status: 'disabled' }));

    const second = await row('en.example.com');
    fireEvent.click(second.getByLabelText('Language entry'));
    fireEvent.change(second.getByLabelText(/Language served on this domain/), { target: { value: 'en' } });
    fireEvent.click(second.getByText('Save language'));
    await waitFor(() => expect(domains.update).toHaveBeenCalledWith('dom_2', { entryLocale: 'en' }));
  });

  it('shows a language entry and the primary domain', async () => {
    domains.list.mockResolvedValue({
      data: [{ ...base, status: 'active', isPrimary: true, entryLocale: 'zh-CN', verifiedAt: base.createdAt, verification: { records: [] } }],
    });
    renderPage();
    const r = await row('example.com');
    expect(r.getByText('Primary')).toBeTruthy();
    expect(r.getByText(/Language entry: zh-CN/)).toBeTruthy();
    expect(r.queryByLabelText('Disable')).toBeNull(); // the primary domain cannot be switched off
  });

  it('adds a domain with its verification method and language entry', async () => {
    domains.list.mockResolvedValue({ data: [] });
    domains.create.mockResolvedValue({
      data: { ...base, hostname: 'shop.example.org', verificationMethod: 'http_file', entryLocale: 'en' },
    });
    renderPage();
    fireEvent.click(await screen.findByText('Setup domain'));
    fireEvent.change(screen.getByLabelText('Domain'), { target: { value: 'Shop.Example.org' } });
    fireEvent.change(screen.getByLabelText('Prove it is yours with'), { target: { value: 'http_file' } });
    fireEvent.change(screen.getByLabelText('Language entry (optional)'), { target: { value: 'en' } });
    fireEvent.click(screen.getByText('Create'));
    await waitFor(() =>
      expect(domains.create).toHaveBeenCalledWith({
        kind: 'custom',
        hostname: 'shop.example.org',
        verificationMethod: 'http_file',
        entryLocale: 'en',
      }),
    );
    // HTTP verification happens on the domain's current host (Codex P04-3 #11).
    expect(await screen.findByText(/Serve this from the server that hosts/)).toBeTruthy();
  });

  it('asks before removing a domain', async () => {
    domains.list.mockResolvedValue({ data: [base] });
    domains.delete.mockResolvedValue({ data: undefined });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    renderPage();
    const r = await row('example.com');
    fireEvent.click(r.getByLabelText('Remove'));
    expect(domains.delete).not.toHaveBeenCalled();
    fireEvent.click(r.getByLabelText('Remove'));
    await waitFor(() => expect(domains.delete).toHaveBeenCalledWith('dom_1'));
    confirm.mockRestore();
  });
});
