// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * The header site switcher (HeoPress P04 task 9.10): the current site's name
 * always shows; with more than one site a selector lists them, marking the
 * ones that require 2FA; it is disabled while switching; a failed switch
 * shows its reason (MFA_REQUIRED offers signing in on that site) and leaves
 * the selector on the current site.
 */

const h = vi.hoisted(() => ({
  sites: vi.fn(),
  canCreate: vi.fn(() => false),
  create: vi.fn(),
  switchSite: vi.fn(),
  setActiveSite: vi.fn(),
}));

vi.mock('@/lib/http', () => ({
  siteFetch: (url: string, init?: RequestInit) =>
    Promise.resolve(
      url === '/api/v1/instance/sites' && init?.method === 'POST'
        ? (h.create(JSON.parse(String(init.body))) as Response)
        : new Response(JSON.stringify({ data: h.sites(), meta: { canCreateSites: h.canCreate() } })),
    ),
}));
vi.mock('@/lib/session/switch', () => ({ switchSite: h.switchSite }));
vi.mock('@/lib/api', () => ({ getActiveSite: () => 'site_a', setActiveSite: h.setActiveSite }));

import { SiteSwitcher } from '../site-switcher';

const site = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  displayTitle: `Site ${id.slice(-1).toUpperCase()}`,
  roleName: 'Editor',
  current: false,
  mfaRequired: false,
  ...extra,
});

function renderSwitcher() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SiteSwitcher />
    </QueryClientProvider>,
  );
}

describe('SiteSwitcher', () => {
  beforeEach(() => {
    h.sites.mockReset();
    h.switchSite.mockReset();
    h.setActiveSite.mockReset();
    h.canCreate.mockReset();
    h.canCreate.mockReturnValue(false);
    h.create.mockReset();
  });
  afterEach(() => cleanup());

  it('shows only the name with a single site', async () => {
    h.sites.mockReturnValue([site('site_a', { current: true })]);
    renderSwitcher();
    expect(await screen.findByLabelText('Current site')).toHaveTextContent('Site A');
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('lists the sites, marks 2FA ones, and switches', async () => {
    h.sites.mockReturnValue([site('site_a', { current: true }), site('site_b', { mfaRequired: true })]);
    h.switchSite.mockReturnValue(new Promise(() => undefined)); // the page would navigate away
    renderSwitcher();
    const select = (await screen.findByLabelText('Switch site')) as HTMLSelectElement;
    expect(select.value).toBe('site_a');
    expect([...select.options].map((o) => o.textContent)).toEqual(['Site A — Editor', 'Site B — Editor (2FA)']);
    fireEvent.change(select, { target: { value: 'site_b' } });
    expect(h.switchSite).toHaveBeenCalledWith('site_b', expect.objectContaining({ confirmUnknownWrites: expect.any(Function) }));
    await waitFor(() => expect(select).toBeDisabled());
    expect(screen.getByText('Switching…')).toBeTruthy();
  });

  it('a failed switch shows the reason, stays on the current site, and is usable again', async () => {
    h.sites.mockReturnValue([site('site_a', { current: true }), site('site_b')]);
    h.switchSite.mockResolvedValue({ ok: false, code: 'SITE_NOT_ALLOWED', message: 'You cannot use Studio on that site.' });
    renderSwitcher();
    const select = (await screen.findByLabelText('Switch site')) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'site_b' } });
    expect(await screen.findByRole('alert')).toHaveTextContent('You cannot use Studio on that site.');
    expect(select.value).toBe('site_a');
    expect(select).not.toBeDisabled();
    expect(screen.queryByText('Sign in there')).toBeNull();
  });

  it('MFA_REQUIRED offers signing in on that site', async () => {
    h.sites.mockReturnValue([site('site_a', { current: true }), site('site_b', { mfaRequired: true })]);
    h.switchSite.mockResolvedValue({ ok: false, code: 'MFA_REQUIRED', message: 'That site requires two-factor authentication: sign in there.' });
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, pathname: '/admin-x/content', assign });
    renderSwitcher();
    fireEvent.change(await screen.findByLabelText('Switch site'), { target: { value: 'site_b' } });
    fireEvent.click(await screen.findByText('Sign in there'));
    expect(h.setActiveSite).toHaveBeenCalledWith('site_b');
    expect(assign).toHaveBeenCalledWith('/admin-x/login');
    vi.unstubAllGlobals();
  });

  it('HeoPress P07 task 0.1: no "New site" without the capability', async () => {
    h.sites.mockReturnValue([site('site_a', { current: true })]);
    renderSwitcher();
    await screen.findByLabelText('Current site');
    expect(screen.queryByText('New site')).toBeNull();
  });

  it('the instance administrator creates a site and is taken there', async () => {
    h.sites.mockReturnValue([site('site_a', { current: true })]);
    h.canCreate.mockReturnValue(true);
    h.create.mockReturnValue(new Response(JSON.stringify({ data: { id: 'site_new' } }), { status: 201 }));
    h.switchSite.mockReturnValue(new Promise(() => undefined));
    renderSwitcher();
    fireEvent.click(await screen.findByText('New site'));
    fireEvent.change(screen.getByLabelText('Site id'), { target: { value: 'site_new' } });
    fireEvent.change(screen.getByLabelText('Site name'), { target: { value: 'New one' } });
    fireEvent.change(screen.getByLabelText('Default language'), { target: { value: 'zh-CN' } });
    fireEvent.submit(screen.getByRole('form', { name: 'New site' }));
    await waitFor(() => expect(h.create).toHaveBeenCalledWith({ id: 'site_new', name: 'New one', defaultLanguage: 'zh-CN' }));
    await waitFor(() => expect(h.switchSite).toHaveBeenCalledWith('site_new', expect.anything()));
    // It lands on the new site's identity first (P07 task 2.12), under the admin base.
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    const { navigate } = h.switchSite.mock.calls[0]![1] as { navigate: (base: string) => void };
    navigate('/admin-x/');
    expect(assign).toHaveBeenLastCalledWith('/admin-x/settings/identity?new=1');
    navigate('/');
    expect(assign).toHaveBeenLastCalledWith('/settings/identity?new=1');
    vi.unstubAllGlobals();
  });

  it('a refused creation shows the reason and stays', async () => {
    h.sites.mockReturnValue([site('site_a', { current: true }), site('site_b')]);
    h.canCreate.mockReturnValue(true);
    h.create.mockReturnValue(new Response(JSON.stringify({ errors: [{ code: 'CONFLICT', message: 'A site "site_b" already exists.' }] }), { status: 409 }));
    renderSwitcher();
    fireEvent.click(await screen.findByText('New site'));
    fireEvent.change(screen.getByLabelText('Site id'), { target: { value: 'site_b' } });
    fireEvent.change(screen.getByLabelText('Site name'), { target: { value: 'B again' } });
    fireEvent.submit(screen.getByRole('form', { name: 'New site' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('A site "site_b" already exists.');
    expect(h.switchSite).not.toHaveBeenCalled();
  });
});
