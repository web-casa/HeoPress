// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import i18n from 'i18next';
import type { ReactNode } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initStudioI18n, setStudioLanguage } from '@/i18n';

/** Agent access (HeoPress P10 tasks 1.2, 1.3): the consent page and the personal tokens page. */

const raw = vi.hoisted(() =>
  vi.fn(async (path: string, init?: { method?: string; body?: string }) => {
    if (path.startsWith('/api/v1/agent-access/consent?')) {
      return {
        data: {
          client: { id: 'hpc_1', name: 'Test agent', redirectHost: '127.0.0.1:33418' },
          requestedGroups: ['read', 'content'],
          groups: ['read', 'content', 'publish', 'settings', 'theme'],
          sites: [
            { id: 'site_a', name: 'Site A' },
            { id: 'site_b', name: 'Site B' },
          ],
          resource: 'https://cms.example.com/api/v1/agents/mcp',
        },
      };
    }
    if (path === '/api/v1/agent-access/consent' && init?.method === 'POST') return { data: { redirectTo: 'http://127.0.0.1:33418/callback?code=x' } };
    if (path === '/api/v1/agent-access/grants')
      return {
        data: {
          grants: [{ id: 'g1', kind: 'pat', name: 'CLI', clientId: null, siteIds: ['site_a'], toolGroups: ['read'], tokenPrefix: 'hpo_pat_abc', createdAt: '2026-10-01T00:00:00Z', expiresAt: null, lastUsedAt: null }],
          sites: [{ id: 'site_a', name: 'Site A' }],
          groups: ['read', 'content', 'publish', 'settings', 'theme'],
          mcpEndpoint: 'https://cms.example.com/api/v1/agents/mcp',
        },
      };
    return { data: null };
  }),
);
vi.mock('@/lib/api', () => ({ getApiClient: () => ({ rawRequest: raw }) }));

const { AgentConsentPage } = await import('../consent-page');
const { AgentAccessPage } = await import('../agent-access-page');
const { grantableGroups, toggle } = await import('../agent-access-api');

beforeAll(async () => {
  await initStudioI18n(i18n);
  await setStudioLanguage('en', i18n);
});

const wrap = (node: ReactNode) => render(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>);

describe('agent access helpers', () => {
  it('limits the groups to those the agent asked for and keeps the order', () => {
    expect(grantableGroups({ requestedGroups: ['content', 'read'], groups: ['read', 'content', 'publish'] })).toEqual(['read', 'content']);
    expect(grantableGroups({ requestedGroups: null, groups: ['read', 'publish'] })).toEqual(['read', 'publish']);
    expect(toggle(['b'], 'a', ['a', 'b', 'c'])).toEqual(['a', 'b']);
    expect(toggle(['a', 'b'], 'a', ['a', 'b'])).toEqual(['b']);
  });
});

describe('consent page', () => {
  it('needs a site, disables groups the agent did not ask for, and sends the choice', async () => {
    window.history.replaceState(null, '', '/e2e-admin/agent-access/consent?request=req1');
    const assign = vi.fn();
    Object.defineProperty(window, 'location', { value: { ...window.location, search: '?request=req1', assign }, writable: true });
    wrap(<AgentConsentPage />);
    expect(await screen.findByText(/Test agent asks to act for you/)).toBeTruthy();
    expect((screen.getByRole('checkbox', { name: /Publishing/ }) as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Authorize' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Choose at least one site.');
    fireEvent.click(screen.getByRole('checkbox', { name: /Site A/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Authorize' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('http://127.0.0.1:33418/callback?code=x'));
    const post = raw.mock.calls.find(([p, init]) => p === '/api/v1/agent-access/consent' && init?.method === 'POST');
    expect(JSON.parse(post![1]!.body!)).toEqual({ request: 'req1', approve: true, siteIds: ['site_a'], toolGroups: ['read'] });
  });
});

describe('agent access page', () => {
  it('lists tokens with their sites and groups and shows the endpoint', async () => {
    wrap(<AgentAccessPage />);
    expect(await screen.findByText('https://cms.example.com/api/v1/agents/mcp')).toBeTruthy();
    const row = document.querySelector('[data-grant="CLI"]')!;
    expect(row.textContent).toContain('Site A');
    expect(row.textContent).toContain('Read only');
    expect(row.textContent).toContain('Personal token');
  });
});
