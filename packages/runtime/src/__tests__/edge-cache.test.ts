// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { describe, expect, it, vi } from 'vitest';
import { NoOpEdgeCacheProvider } from '../adapters/docker/edge-cache';

describe('NoOpEdgeCacheProvider', () => {
  const provider = new NoOpEdgeCacheProvider();
  const request = new Request('https://example.com/api/v1/deliver/page/site-a/home');

  it('always misses', async () => {
    expect(await provider.match(request)).toBeNull();
  });

  it('put is a no-op', async () => {
    await expect(
      provider.put(request, new Response(JSON.stringify({ ok: true }), { status: 200 })),
    ).resolves.toBeUndefined();
    expect(await provider.match(request)).toBeNull();
  });

  it('purges nothing — there is no edge in front of Docker by default', async () => {
    expect(
      await provider.purge({ urls: ['https://example.com/a'], tags: ['deliver:site-a'] }),
    ).toBe(0);
  });
});

/**
 * #392 — the zone purge API is what reaches PoPs other than the one running
 * this code (`caches.default.delete` is colo-local). The provider is given
 * both a tag and the indexed URLs, tries the tag first because it is one call
 * and covers more, and falls back to URLs when the account refuses it.
 */