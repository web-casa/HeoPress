// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import i18n from 'i18next';
import { initStudioI18n, setStudioLanguage } from '@/i18n';

/**
 * The header site switcher (HeoPress P04 task 9.10): the current site's name
 * always shows; with more than one site it opens a list of them, each with its
 * id and role, marking the ones that require 2FA; it is disabled while
 * switching; a failed switch shows its reason (MFA_REQUIRED offers signing in
 * on that site) and stays on the current site. Creating a site is the list's
 * last entry and opens a dialog.
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

import { SiteSwitcher, siteIdFrom } from '../site-switcher';

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

const trigger = () => screen.findByRole('button', { name: /^Switch site/ });
async function pick(siteId: string) {
  fireEvent.click(await trigger());
  fireEvent.click(document.querySelector(`[role="option"][data-site="${siteId}"]`)!);
}
async function openNewSite() {
  fireEvent.click(await trigger());
  fireEvent.click(screen.getByRole('button', { name: 'New site' }));
}

describe('SiteSwitcher', () => {
  beforeEach(async () => {
    await initStudioI18n(i18n);
    await setStudioLanguage('en', i18n);
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
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('lists the sites with id and role, marks the current and 2FA ones, and switches', async () => {
    h.sites.mockReturnValue([site('site_a', { current: true }), site('site_b', { mfaRequired: true })]);
    h.switchSite.mockReturnValue(new Promise(() => undefined)); // the page would navigate away
    renderSwitcher();
    const button = await trigger();
    expect(button).toHaveAccessibleName('Switch site: Site A');
    expect(button).toHaveAttribute('data-site', 'site_a');
    fireEvent.click(button);
    const options = screen.getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['SSite Asite_a · Editor', 'SSite Bsite_b · Editor2FA']);
    expect(options.map((o) => o.getAttribute('aria-selected'))).toEqual(['true', 'false']);
    fireEvent.click(options[1]!);
    expect(h.switchSite).toHaveBeenCalledWith('site_b', expect.objectContaining({ confirmUnknownWrites: expect.any(Function) }));
    await waitFor(() => expect(button).toBeDisabled());
    expect(button).toHaveTextContent('Switching…');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('picking the current site changes nothing', async () => {
    h.sites.mockReturnValue([site('site_a', { current: true }), site('site_b')]);
    renderSwitcher();
    await pick('site_a');
    expect(h.switchSite).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('Escape closes the list', async () => {
    h.sites.mockReturnValue([site('site_a', { current: true }), site('site_b')]);
    renderSwitcher();
    fireEvent.click(await trigger());
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('many sites can be searched by name or id', async () => {
    h.sites.mockReturnValue([site('site_a', { current: true }), ...['b', 'c', 'd', 'e', 'f'].map((x) => site(`site_${x}`))]);
    renderSwitcher();
    fireEvent.click(await trigger());
    expect(screen.getAllByRole('option')).toHaveLength(6);
    fireEvent.change(screen.getByLabelText('Find a site'), { target: { value: 'site_d' } });
    expect(screen.getAllByRole('option').map((o) => o.getAttribute('data-site'))).toEqual(['site_d']);
    fireEvent.change(screen.getByLabelText('Find a site'), { target: { value: 'nothing' } });
    expect(screen.getByText('No site matches.')).toBeTruthy();
  });

  it('a failed switch shows the reason, stays on the current site, and is usable again', async () => {
    h.sites.mockReturnValue([site('site_a', { current: true }), site('site_b')]);
    h.switchSite.mockResolvedValue({ ok: false, code: 'SITE_NOT_ALLOWED', message: 'You cannot use Studio on that site.' });
    renderSwitcher();
    await pick('site_b');
    expect(await screen.findByRole('alert')).toHaveTextContent('You cannot use Studio on that site.');
    const button = await trigger();
    expect(button).toHaveAttribute('data-site', 'site_a');
    expect(button).not.toBeDisabled();
    expect(screen.queryByText('Sign in there')).toBeNull();
  });

  it('MFA_REQUIRED offers signing in on that site', async () => {
    h.sites.mockReturnValue([site('site_a', { current: true }), site('site_b', { mfaRequired: true })]);
    h.switchSite.mockResolvedValue({ ok: false, code: 'MFA_REQUIRED', message: 'That site requires two-factor authentication: sign in there.' });
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, pathname: '/admin-x/content', assign });
    renderSwitcher();
    await pick('site_b');
    fireEvent.click(await screen.findByText('Sign in there'));
    expect(h.setActiveSite).toHaveBeenCalledWith('site_b');
    expect(assign).toHaveBeenCalledWith('/admin-x/login');
    vi.unstubAllGlobals();
  });

  it('HeoPress P07 task 0.1: no "New site" without the capability', async () => {
    h.sites.mockReturnValue([site('site_a', { current: true }), site('site_b')]);
    renderSwitcher();
    fireEvent.click(await trigger());
    expect(screen.queryByText('New site')).toBeNull();
  });

  it('the instance administrator creates a site from a dialog and is taken there', async () => {
    h.sites.mockReturnValue([site('site_a', { current: true })]);
    h.canCreate.mockReturnValue(true);
    h.create.mockReturnValue(new Response(JSON.stringify({ data: { id: 'new-one' } }), { status: 201 }));
    h.switchSite.mockReturnValue(new Promise(() => undefined));
    renderSwitcher();
    // With one site the switcher still opens: creating is its entry.
    await openNewSite();
    const dialog = screen.getByRole('dialog', { name: 'New site' });
    expect(dialog).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Site name'), { target: { value: 'New One' } });
    // The id follows the name until it is edited.
    expect(screen.getByLabelText('Site id')).toHaveValue('new-one');
    fireEvent.change(screen.getByLabelText('Default language'), { target: { value: 'zh-CN' } });
    fireEvent.submit(dialog);
    await waitFor(() => expect(h.create).toHaveBeenCalledWith({ id: 'new-one', name: 'New One', defaultLanguage: 'zh-CN' }));
    await waitFor(() => expect(h.switchSite).toHaveBeenCalledWith('new-one', expect.anything()));
    expect(screen.getByRole('button', { name: 'Creating…' })).toBeDisabled();
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

  it('an edited id is kept when the name changes; no language is sent when left empty', async () => {
    h.sites.mockReturnValue([site('site_a', { current: true })]);
    h.canCreate.mockReturnValue(true);
    h.create.mockReturnValue(new Response(JSON.stringify({ data: { id: 'blog' } }), { status: 201 }));
    h.switchSite.mockReturnValue(new Promise(() => undefined));
    renderSwitcher();
    await openNewSite();
    fireEvent.change(screen.getByLabelText('Site id'), { target: { value: 'blog' } });
    fireEvent.change(screen.getByLabelText('Site name'), { target: { value: '我的博客' } });
    expect(screen.getByLabelText('Site id')).toHaveValue('blog');
    fireEvent.submit(screen.getByRole('dialog'));
    await waitFor(() => expect(h.create).toHaveBeenCalledWith({ id: 'blog', name: '我的博客' }));
  });

  it('a refused creation shows the reason and stays; Cancel closes the dialog', async () => {
    h.sites.mockReturnValue([site('site_a', { current: true }), site('site_b')]);
    h.canCreate.mockReturnValue(true);
    h.create.mockReturnValue(new Response(JSON.stringify({ errors: [{ code: 'CONFLICT', message: 'A site "site_b" already exists.' }] }), { status: 409 }));
    renderSwitcher();
    await openNewSite();
    fireEvent.change(screen.getByLabelText('Site name'), { target: { value: 'B again' } });
    fireEvent.change(screen.getByLabelText('Site id'), { target: { value: 'site_b' } });
    fireEvent.submit(screen.getByRole('dialog'));
    expect(await screen.findByRole('alert')).toHaveTextContent('A site "site_b" already exists.');
    expect(h.switchSite).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('siteIdFrom', () => {
  it('makes an id of a name, or nothing when it has no Latin letters or digits', () => {
    expect(siteIdFrom('My Travel Blog')).toBe('my-travel-blog');
    expect(siteIdFrom('  Café № 5!  ')).toBe('cafe-no-5');
    expect(siteIdFrom('我的博客')).toBe('');
  });
});
