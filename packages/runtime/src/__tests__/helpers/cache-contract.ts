// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CacheProvider } from '../../interfaces/cache';

/**
 * The upstream CacheProvider contract, shared by every adapter's suite
 * (memory in cache-provider-contract.test.ts, PostgreSQL in
 * postgres-cache.db.test.ts). `skipTtl` skips the fake-timer TTL case for
 * backends whose clock is the database's.
 */
export function runContractSuite(name: string, factory: () => CacheProvider | Promise<CacheProvider>, opts?: { skipTtl?: boolean }) {
  describe(`CacheProvider contract — ${name}`, () => {
    let cache: CacheProvider;

    beforeEach(async () => {
      cache = await factory();
    });

    it('set + get round-trips a value', async () => {
      await cache.set('k1', JSON.stringify({ ok: true }));
      expect(await cache.get<{ ok: boolean }>('k1')).toEqual({ ok: true });
    });

    if (!opts?.skipTtl) {
      it('honours TTL expiry', async () => {
        vi.useFakeTimers();
        try {
          await cache.set('ttl-key', JSON.stringify('v'), { ttl: 1 });
          expect(await cache.get('ttl-key')).toBe('v');
          vi.advanceTimersByTime(1_100);
          expect(await cache.get('ttl-key')).toBeNull();
        } finally {
          vi.useRealTimers();
        }
      });
    }

    it('tags → invalidateByTag → miss', async () => {
      await cache.set('a', JSON.stringify(1), { tags: ['items:site-a:posts'] });
      await cache.set('b', JSON.stringify(2), { tags: ['items:site-a:posts'] });
      await cache.set('c', JSON.stringify(3), { tags: ['items:site-b:posts'] });
      await cache.invalidateByTag('items:site-a:posts');
      expect(await cache.get('a')).toBeNull();
      expect(await cache.get('b')).toBeNull();
      expect(await cache.get('c')).toEqual(3);
    });

    it('negative cache still works after tag purge', async () => {
      await cache.setNegative('neg:site-a:page:home', { ttl: 60 });
      const entry = await cache.getEntry('neg:site-a:page:home');
      expect(entry.state).toBe('negative');
      expect(await cache.get('neg:site-a:page:home')).toBeNull();
    });
  });
}
