// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HeoPressError } from '@heopress/sdk';

/**
 * Site identity page (HeoPress P07 task 2.12): a new site lands here with a prompt; the operator picks the kind and
 * fills in what applies; empty fields are sent empty (never made up); the version read is sent; a stale save says so.
 */

const site = { identity: vi.fn(), updateIdentity: vi.fn() };

vi.mock('@/lib/api', () => ({
  getApiClient: () => ({ site }),
}));

import { SiteIdentityPage } from '../site-identity-page';

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SiteIdentityPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  site.identity.mockResolvedValue({ data: { identity: null, version: 0 } });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.history.replaceState(null, '', '/');
});

describe('SiteIdentityPage', () => {
  it('a new site is prompted; a person with a name and two profiles is saved as such, empty fields empty', async () => {
    window.history.replaceState(null, '', '/settings/identity?new=1');
    site.updateIdentity.mockImplementation(async (input: Record<string, unknown>) => ({ data: { identity: input, version: 1 } }));
    renderPage();
    expect(await screen.findByRole('status')).toHaveTextContent('Your site is ready');
    fireEvent.click(screen.getByLabelText(/^Person/));
    // A person has no address block.
    expect(screen.queryByText('Address')).toBeNull();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Sam Example' } });
    fireEvent.change(screen.getByLabelText('Official profiles'), { target: { value: 'https://social.example.com/sam\n\n  https://code.example.com/sam  ' } });
    fireEvent.submit(screen.getByRole('form', { name: 'Site identity' }));
    await waitFor(() =>
      expect(site.updateIdentity).toHaveBeenCalledWith({
        version: 0,
        kind: 'person',
        name: 'Sam Example',
        logo: '',
        email: '',
        telephone: '',
        address: { streetAddress: '', addressLocality: '', addressRegion: '', postalCode: '', addressCountry: '' },
        sameAs: ['https://social.example.com/sam', 'https://code.example.com/sam'],
      }),
    );
    expect(await screen.findByText('Saved')).toBeTruthy();
  });

  it('an existing identity fills the form and is saved against its version; a stale save says to reload', async () => {
    site.identity.mockResolvedValue({
      data: {
        identity: { kind: 'local_business', name: 'Corner Café', logo: '', email: '', telephone: '+1 555 0100', address: { streetAddress: '1 Main St', addressLocality: 'Springfield', addressRegion: '', postalCode: '', addressCountry: 'US' }, sameAs: [] },
        version: 3,
      },
    });
    site.updateIdentity.mockRejectedValue(new HeoPressError(409, { errors: [{ code: 'VERSION_CONFLICT', message: 'stale' }] }));
    renderPage();
    expect(await screen.findByDisplayValue('Corner Café')).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
    expect((screen.getByLabelText('City') as HTMLInputElement).value).toBe('Springfield');
    fireEvent.submit(screen.getByRole('form', { name: 'Site identity' }));
    await waitFor(() => expect(site.updateIdentity).toHaveBeenCalledWith(expect.objectContaining({ version: 3, kind: 'local_business', telephone: '+1 555 0100' })));
    expect(await screen.findByRole('alert')).toHaveTextContent('Reload the page');
  });

  it('switching a business to a person sends no address: none is left hidden in the form (Codex review of batch 5a)', async () => {
    site.identity.mockResolvedValue({
      data: {
        identity: { kind: 'local_business', name: 'Corner Café', logo: '', email: '', telephone: '', address: { streetAddress: '1 Main St', addressLocality: 'Springfield', addressRegion: 'IL', postalCode: '62701', addressCountry: 'US' }, sameAs: [] },
        version: 2,
      },
    });
    site.updateIdentity.mockImplementation(async (input: Record<string, unknown>) => ({ data: { identity: input, version: 3 } }));
    renderPage();
    expect(await screen.findByDisplayValue('Corner Café')).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/^Person/));
    fireEvent.submit(screen.getByRole('form', { name: 'Site identity' }));
    await waitFor(() =>
      expect(site.updateIdentity).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'person', address: { streetAddress: '', addressLocality: '', addressRegion: '', postalCode: '', addressCountry: '' } }),
      ),
    );
  });

  it('a new person can be given an email and a telephone (Codex review of batch 5a)', async () => {
    site.updateIdentity.mockImplementation(async (input: Record<string, unknown>) => ({ data: { identity: input, version: 1 } }));
    renderPage();
    fireEvent.click(await screen.findByLabelText(/^Person/));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Sam' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'sam@example.com' } });
    fireEvent.change(screen.getByLabelText('Telephone'), { target: { value: '+1 555 0100' } });
    fireEvent.submit(screen.getByRole('form', { name: 'Site identity' }));
    await waitFor(() => expect(site.updateIdentity).toHaveBeenCalledWith(expect.objectContaining({ kind: 'person', email: 'sam@example.com', telephone: '+1 555 0100' })));
  });
});
