// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The overview's read of the plugins' briefing sections (v1.1; spec studio/briefing "插件分节"): it is the existing
 * extension-point endpoint of the active site, read under the site's query key, and not read at all when the page is
 * not on the current site's scope.
 */

const rawRequest = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({ getApiClient: () => ({ rawRequest }), getActiveToken: () => '' }));

const { useBriefingSections } = await import('../api');

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  rawRequest.mockReset();
  rawRequest.mockResolvedValue({
    data: [{ plugin: 'stale-drafts', pluginName: 'Stale drafts helper', id: 'stale-drafts', title: 'Stale drafts', description: null, count: 2, items: [] }],
  });
});

describe('useBriefingSections', () => {
  it('reads the active site’s sections from the briefing-sections endpoint', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useBriefingSections(), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.data?.[0]?.title).toBe('Stale drafts'));
    expect(rawRequest).toHaveBeenCalledWith('/api/v1/extensions/briefing-sections');
    expect(result.current.data?.[0]?.count).toBe(2);
  });

  it('does not read at all when the scope is not the current site', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useBriefingSections(false), { wrapper: wrapper(client) });
    expect(result.current.fetchStatus).toBe('idle');
    expect(rawRequest).not.toHaveBeenCalled();
  });
});
