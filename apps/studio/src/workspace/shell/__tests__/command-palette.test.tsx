// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import i18n from 'i18next';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initStudioI18n, setStudioLanguage } from '@/i18n';
import { availableCommands } from '../commands';

const perms = vi.hoisted(() => ({ isAdmin: false, allowed: new Set<string>() }));

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@/lib/use-permissions', () => ({
  usePermissions: () => ({ isAdmin: perms.isAdmin, can: (c: string, a: string) => perms.allowed.has(`${c}::${a}`) }),
}));
vi.mock('@/lib/api', () => ({ getApiClient: () => ({ request: vi.fn() }) }));

const { CommandPalette } = await import('../command-palette');

beforeAll(async () => {
  await initStudioI18n(i18n);
  await setStudioLanguage('en', i18n);
  // cmdk measures its list.
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
  Element.prototype.scrollIntoView ??= () => undefined;
});

function open() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <CommandPalette open onClose={() => undefined} adminBase="" onAction={() => undefined} />
    </QueryClientProvider>,
  );
}

describe('command palette permissions (p07a task 2.5)', () => {
  it('pure filter: admin-only jumps and collection actions need the permission', () => {
    const none = availableCommands(false, () => false).map((c) => c.id);
    expect(none).not.toContain('go.events');
    expect(none).not.toContain('action.newArticle');
    expect(none).toContain('go.overview');
    const writer = availableCommands(false, (c, a) => c === 'articles' && a === 'create').map((c) => c.id);
    expect(writer).toContain('action.newArticle');
    expect(availableCommands(true, () => false).map((c) => c.id)).toContain('go.events');
  });

  it('a member without create rights sees no monitoring jump and no "New article"', () => {
    perms.isAdmin = false;
    perms.allowed = new Set();
    open();
    expect(screen.getByText('Issues')).toBeTruthy();
    expect(screen.queryByText('Event stream')).toBeNull();
    expect(screen.queryByText('New article')).toBeNull();
  });

  it('a site administrator sees them', () => {
    perms.isAdmin = true;
    open();
    expect(screen.getByText('Event stream')).toBeTruthy();
    expect(screen.getByText('New article')).toBeTruthy();
  });
});
