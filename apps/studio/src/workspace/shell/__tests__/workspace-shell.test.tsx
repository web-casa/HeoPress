// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import i18n from 'i18next';
import type { ReactNode } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initStudioI18n, setStudioLanguage } from '@/i18n';

const state = vi.hoisted(() => ({ isAdmin: false, pathname: '/e2e-admin/audit/links' }));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
  useNavigate: () => vi.fn(),
  useRouterState: () => ({ location: { pathname: state.pathname } }),
}));
vi.mock('@/lib/use-permissions', () => ({ usePermissions: () => ({ isAdmin: state.isAdmin, can: () => false }) }));
vi.mock('@/lib/api', () => ({ getApiClient: () => ({ me: { getPreferences: vi.fn() } }), hasActiveToken: () => false, logout: vi.fn() }));
vi.mock('@/components/notifications-panel', () => ({ NotificationsPanel: () => null }));
vi.mock('@/components/site-switcher', () => ({ SiteSwitcher: () => null }));
vi.mock('@/components/search-palette', () => ({ SearchPalette: () => null }));
vi.mock('@/lib/admin-base', () => ({ getAdminBase: (p: string) => (p.startsWith('/e2e-admin') ? '/e2e-admin' : '') }));

const { WorkspaceShell } = await import('../workspace-shell');
const { ModuleLayout } = await import('../module-layout');

beforeAll(async () => {
  await initStudioI18n(i18n);
  await setStudioLanguage('en', i18n);
});

function renderShell() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <WorkspaceShell>
        <ModuleLayout groups={[{ items: [{ to: '/audit', label: 'audit.issues', exact: true }, { to: '/audit/links', label: 'audit.links' }] }]}>
          <p>page</p>
        </ModuleLayout>
      </WorkspaceShell>
    </QueryClientProvider>,
  );
}

describe('WorkspaceShell (p07a task 2.1)', () => {
  it('a member sees seven modules — no Logs & monitoring', () => {
    state.isAdmin = false;
    renderShell();
    const nav = screen.getByRole('navigation', { name: 'Modules' });
    expect(within(nav).getAllByRole('listitem')).toHaveLength(7);
    expect(within(nav).queryByRole('link', { name: 'Logs & monitoring' })).toBeNull();
  });

  it('a site administrator sees all eight', () => {
    state.isAdmin = true;
    renderShell();
    const nav = screen.getByRole('navigation', { name: 'Modules' });
    expect(within(nav).getByRole('link', { name: 'Logs & monitoring' })).toHaveAttribute('href', '/e2e-admin/monitoring');
  });

  it('the current module and view carry aria-current, and only they do', async () => {
    state.isAdmin = false;
    renderShell();
    const nav = screen.getByRole('navigation', { name: 'Modules' });
    expect(within(nav).getByRole('link', { name: 'Audit' })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('link', { name: 'Overview' })).not.toHaveAttribute('aria-current');
    const view = await screen.findByRole('link', { name: 'Internal links' });
    expect(view).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Issues' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('link', { name: 'Skip to main content' })).toHaveAttribute('href', '#main-content');
  });
});
