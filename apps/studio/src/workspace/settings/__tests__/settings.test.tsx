// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import i18n from 'i18next';
import type { ReactNode } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initStudioI18n, setStudioLanguage } from '@/i18n';

/** Settings (HeoPress P07a tasks 12.1, 12.2, 12.5, 12.6). */

const perms = vi.hoisted(() => ({ isAdmin: false }));
const raw = vi.hoisted(() =>
  vi.fn(async (path: string, init?: { method?: string; body?: string }) => {
    if (path === '/api/v1/site') return { data: { name: 'Links', defaultLanguage: 'en' } };
    if (path === '/api/v1/site/content-settings') return { data: { availableLocales: ['en', 'zh-CN'], timezone: 'UTC', version: 2 } };
    if (path === '/api/v1/roles') return { data: [{ id: 'r_admin', name: 'Administrator' }, { id: 'r_member', name: 'Member' }] };
    if (path === '/api/v1/users' && !init?.method)
      return {
        data: [
          { id: 'u1', email: 'active@example.com', firstName: 'Ada', lastName: null, status: 'active', lastSeenAt: null, roleId: 'r_admin' },
          { id: 'u2', email: 'waiting@example.com', firstName: null, lastName: null, status: 'invited', lastSeenAt: null, roleId: 'r_member' },
          { id: 'u3', email: 'gone@example.com', firstName: null, lastName: null, status: 'suspended', lastSeenAt: null, roleId: 'r_member' },
        ],
      };
    if (path === '/api/v1/users/invite') {
      const email = (JSON.parse(init!.body!) as { email: string }).email;
      return { data: { id: 'x', email, status: 'invited' }, meta: { alreadyMember: email === 'active@example.com' } };
    }
    return { data: null };
  }),
);
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
  useNavigate: () => vi.fn(),
  useBlocker: () => undefined,
  useRouterState: () => ({ location: { pathname: '/e2e-admin/settings', search: {} } }),
}));
vi.mock('@/lib/api', () => ({ getApiClient: () => ({ rawRequest: raw }) }));
vi.mock('@/lib/use-permissions', () => ({ usePermissions: () => ({ isAdmin: perms.isAdmin, canAdminister: perms.isAdmin, isLoading: false }) }));
vi.mock('../../api', async (orig) => ({ ...(await orig<typeof import('../../api')>()), siteKey: (...p: unknown[]) => ['s', ...p] }));

const { settingsGroups, adminOnly } = await import('../settings-nav');
const { GeneralPage, validateGeneral } = await import('../general-page');
const { MembersPage, accountState, parseEmails } = await import('../members-page');
const { staleKey } = await import('../api-keys-page');

beforeAll(async () => {
  await initStudioI18n(i18n);
  await setStudioLanguage('en', i18n);
});

const wrap = (node: ReactNode) => render(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>);
const visible = (isAdmin: boolean) => settingsGroups(isAdmin, ['access', 'webhooks']).flatMap((g) => g.items.filter((i) => i.visible !== false).map((i) => i.to));

describe('settings sections (task 12.1)', () => {
  it('a member sees only its own sections; an administrator all', () => {
    // Agent access (HeoPress P10) is the person's own: every member sees it.
    expect(visible(false)).toEqual(['/settings/appearance', '/settings/agent-access', '/settings/agent-plans']);
    expect(visible(true)).toEqual(['/settings/general', '/settings/appearance', '/settings/agent-access', '/settings/agent-plans', '/settings/members', '/settings/api-keys', '/settings/notifications', '/settings/license', '/settings/advanced/access', '/settings/advanced/webhooks']);
  });

  it('a member opening an administrator section by address is told why', () => {
    perms.isAdmin = false;
    const Closed = adminOnly(() => <p>secret form</p>);
    wrap(<Closed />);
    expect(screen.getByText('Site administrators only')).toBeTruthy();
    expect(screen.queryByText('secret form')).toBeNull();
  });
});

describe('general (task 12.2)', () => {
  it('an unknown time zone is explained in place and blocks saving', async () => {
    perms.isAdmin = true;
    wrap(<GeneralPage />);
    const tz = await screen.findByLabelText('Time zone');
    fireEvent.change(tz, { target: { value: 'Mars/Olympus' } });
    expect(screen.getByRole('alert').textContent).toContain('Not a known time zone');
    // It offers valid values: examples in the message, and the full list on the field.
    expect(screen.getByRole('alert').textContent).toContain('Asia/Shanghai');
    const list = document.getElementById(tz.getAttribute('list')!)!;
    expect(list.querySelectorAll('option').length).toBeGreaterThan(5);
    const bar = screen.getByRole('region', { name: 'Unsaved changes' });
    expect((within(bar).getByRole('button', { name: 'Fix 1 error first' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(tz, { target: { value: 'Asia/Shanghai' } });
    expect((within(bar).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('validates the name and language too', () => {
    expect(validateGeneral({ name: ' ', defaultLanguage: 'fr', timezone: 'UTC' }, ['en'], ['UTC'])).toEqual({ name: 'general.errors.nameRequired', defaultLanguage: 'general.errors.language' });
  });
});

describe('members (task 12.5)', () => {
  it('shows each account state, a disabled account included', async () => {
    perms.isAdmin = true;
    wrap(<MembersPage />);
    const table = await screen.findByRole('table');
    expect(within(table).getByText('Active')).toBeTruthy();
    expect(within(table).getByText('Invitation not accepted')).toBeTruthy();
    expect(within(table).getByText('Disabled')).toBeTruthy();
    expect(accountState('suspended')).toBe('disabled');
  });

  it('invites several addresses, each answered; a member keeps its role', async () => {
    wrap(<MembersPage />);
    fireEvent.change(await screen.findByLabelText('Email addresses'), { target: { value: 'new@example.com, active@example.com' } });
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'r_member' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send 2 invitations' }));
    const results = await screen.findByRole('list', { name: 'Invitation results' });
    await waitFor(() => expect(within(results).getAllByRole('listitem')).toHaveLength(2));
    expect(within(results).getByText('Invited')).toBeTruthy();
    expect(within(results).getByText('Already a member: role unchanged')).toBeTruthy();
    expect(raw).not.toHaveBeenCalledWith(expect.stringMatching(/^\/api\/v1\/users\/u1$/), expect.anything());
  });

  it('removing asks first and says what follows', async () => {
    wrap(<MembersPage />);
    const row = (await screen.findByText('waiting@example.com')).closest('tr')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Remove' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('The invitation is withdrawn');
    expect(raw).not.toHaveBeenCalledWith('/api/v1/users/u2', expect.objectContaining({ method: 'DELETE' }));
  });

  it('reads addresses from any separator, once each', () => {
    expect(parseEmails('A@example.com; b@example.com\na@example.com ')).toEqual(['a@example.com', 'b@example.com']);
  });
});

describe('api keys (task 12.6)', () => {
  it('suggests revoking a key unused for 90 days', () => {
    const now = Date.parse('2026-10-24T00:00:00Z');
    expect(staleKey({ createdAt: '2026-01-01T00:00:00Z', lastUsedAt: '2026-10-01T00:00:00Z', revokedAt: null }, now)).toBe(false);
    expect(staleKey({ createdAt: '2026-01-01T00:00:00Z', lastUsedAt: '2026-07-01T00:00:00Z', revokedAt: null }, now)).toBe(true);
    expect(staleKey({ createdAt: '2026-01-01T00:00:00Z', lastUsedAt: null, revokedAt: null }, now)).toBe(true);
    expect(staleKey({ createdAt: '2026-01-01T00:00:00Z', lastUsedAt: null, revokedAt: '2026-02-01T00:00:00Z' }, now)).toBe(false);
  });
});

describe('license (task 12.6, spec "查看第三方声明")', () => {
  it('opening the third-party notices shows the components shipped and their licenses', async () => {
    const { LicensePage } = await import('../license-page');
    wrap(<LicensePage />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Third-party notices' }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(dialog.textContent).toContain('Third-Party Notices'));
    expect(dialog.textContent).toContain('LGPL-3.0-or-later');
  });
});
