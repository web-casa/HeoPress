import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import type postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PostgresCacheProvider } from '../adapters/postgres/cache';
import { runContractSuite } from './helpers/cache-contract';
import { PG_URL, connectRuntimeDb, resetRuntimeTables } from './helpers/pg';

/**
 * PostgreSQL cache adapter (P03 tasks 2.1, 2.2, 2.4; spec
 * platform/infrastructure-adapters "跨进程缓存失效"):
 *   - the upstream CacheProvider contract;
 *   - TTL, counters, unique counters and failure semantics;
 *   - a tagged entry written before an invalidation is never served, even if
 *     its row survived (generation check);
 *   - across two real processes: invalidation in one is seen by the other,
 *     including when the other process lost its notifications because its
 *     connections were killed (as in a database restart).
 */

const CHILD = path.resolve(__dirname, 'fixtures/cache-child.ts');
const CHILD_APP_NAME = 'heopress-cache-child';

describe.skipIf(!PG_URL)('PostgresCacheProvider (PostgreSQL)', () => {
  let sql: postgres.Sql;
  const providers: PostgresCacheProvider[] = [];
  const make = (opts?: ConstructorParameters<typeof PostgresCacheProvider>[1]) => {
    const p = new PostgresCacheProvider(sql, { purgeIntervalMs: 0, ...opts });
    providers.push(p);
    return p;
  };

  beforeAll(async () => {
    sql = await connectRuntimeDb(8);
  });

  beforeEach(async () => {
    await resetRuntimeTables(sql);
  });

  afterAll(async () => {
    await Promise.all(providers.map((p) => p.close()));
    await sql?.end({ timeout: 1 });
  });

  runContractSuite('PostgresCacheProvider', () => make(), { skipTtl: true });

  it('expires an entry after its TTL (database clock)', async () => {
    const cache = make();
    await cache.set('ttl:site-a:k', JSON.stringify('v'), { ttl: 1 });
    expect(await cache.get('ttl:site-a:k')).toBe('v');
    await new Promise((r) => setTimeout(r, 1200));
    expect(await cache.get('ttl:site-a:k')).toBeNull();
  });

  it('never serves a tagged entry written before its tag was invalidated', async () => {
    const cache = make({ l1TtlMs: 0 });
    await cache.set('page:site-a:home', JSON.stringify('old'), { tags: ['pages:site-a'] });
    // Bump the generation without deleting the row, as if the delete were lost.
    await sql`UPDATE lumibase_cache_tags SET generation = generation + 1 WHERE tag = 'pages:site-a'`;
    await sql`INSERT INTO lumibase_cache_tags (tag, generation) VALUES ('pages:site-a', 1) ON CONFLICT DO NOTHING`;
    expect(await cache.get('page:site-a:home')).toBeNull();
    await cache.set('page:site-a:home', JSON.stringify('new'), { tags: ['pages:site-a'] });
    expect(await cache.get('page:site-a:home')).toBe('new');
  });

  it('increments atomically and restarts an expired counter', async () => {
    const cache = make();
    const results = await Promise.all(Array.from({ length: 20 }, () => cache.increment('ctr:site-a:views')));
    expect(results.sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(await cache.get('ctr:site-a:views')).toBe(20);
    expect(await cache.increment('ctr:site-a:short', 5, { ttl: 1 })).toBe(5);
    expect(await cache.increment('ctr:site-a:short', 5, { ttl: 1 })).toBe(10);
    await new Promise((r) => setTimeout(r, 1200));
    expect(await cache.increment('ctr:site-a:short', 5, { ttl: 1 })).toBe(5);
  });

  it('counts unique members, fixed TTL from the first member', async () => {
    const cache = make();
    for (const m of ['a', 'b', 'a', 'c']) await cache.addUnique('uv:site-a:2026-10-16', m, { ttl: 60 });
    expect(await cache.countUnique('uv:site-a:2026-10-16')).toBe(3);
    expect(await cache.countUnique('uv:site-b:2026-10-16')).toBe(0);
  });

  it('lets a member rejoin once its window has ended, before any purge', async () => {
    const cache = make();
    await cache.addUnique('uv:site-a:short', 'a', { ttl: 1 });
    expect(await cache.countUnique('uv:site-a:short')).toBe(1);
    await new Promise((r) => setTimeout(r, 1200));
    expect(await cache.countUnique('uv:site-a:short')).toBe(0);
    await cache.addUnique('uv:site-a:short', 'a', { ttl: 1 });
    expect(await cache.countUnique('uv:site-a:short')).toBe(1);
  });

  it('reports unavailable on read and rejects counters when the database is gone', async () => {
    const dead = (await import('postgres')).default('postgresql://nobody@127.0.0.1:1/none', { connect_timeout: 1, max: 1 });
    const cache = new PostgresCacheProvider(dead, { purgeIntervalMs: 0 });
    expect((await cache.getEntry('k')).state).toBe('unavailable');
    await expect(cache.increment('k')).rejects.toThrow();
    await cache.close();
    await dead.end({ timeout: 1 });
  });

  describe('across processes', () => {
    // Strict: every read in the other process must already see the change —
    // no polling, no waiting for notifications.
    let child: ChildProcessWithoutNullStreams;
    let lines: AsyncIterator<string>;

    const childSays = async (): Promise<Record<string, unknown>> => {
      const { value, done } = await lines.next();
      if (done) throw new Error('child exited');
      return JSON.parse(value) as Record<string, unknown>;
    };
    const childGet = async (key: string): Promise<unknown> => {
      child.stdin.write(`get ${key}\n`);
      return (await childSays()).value;
    };

    beforeAll(async () => {
      const url = new URL(PG_URL!);
      url.searchParams.set('application_name', CHILD_APP_NAME);
      child = spawn(process.execPath, ['--import', 'tsx', CHILD], {
        env: { ...process.env, DATABASE_URL: url.toString() },
        cwd: path.resolve(__dirname, '../..'),
      });
      child.stderr.on('data', (d: Buffer) => process.stderr.write(`[cache-child] ${d.toString()}`));
      lines = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]();
      expect(await childSays()).toEqual({ ready: true });
    }, 30_000);

    afterAll(() => {
      child?.stdin.write('exit\n');
      child?.kill();
    });

    it('control: the other process serves an unchanged value from its L1 copy', async () => {
      const api = make();
      await api.set('item:site-a:0', JSON.stringify('cached'), { tags: ['items:site-a:x0'] });
      expect(await childGet('item:site-a:0')).toBe('cached');
      // Change the value behind the cache's back, keeping its version: only an
      // L1 copy can still answer 'cached'.
      await sql`UPDATE lumibase_cache_entries SET value = ${JSON.stringify('changed')} WHERE key = 'item:site-a:0'`;
      expect(await childGet('item:site-a:0')).toBe('cached');
    });

    it('an overwrite or delete in one process is seen by the other on its very next read', async () => {
      const api = make();
      await api.set('setting:site-a:theme', JSON.stringify('light'));
      expect(await childGet('setting:site-a:theme')).toBe('light');
      await api.set('setting:site-a:theme', JSON.stringify('dark'));
      expect(await childGet('setting:site-a:theme')).toBe('dark');
      await api.delete('setting:site-a:theme');
      expect(await childGet('setting:site-a:theme')).toBeNull();
    });

    it('a tag invalidated in one process is seen by the other on its very next read', async () => {
      const api = make();
      await api.set('item:site-a:1', JSON.stringify('v1'), { tags: ['items:site-a:x1'] });
      expect(await childGet('item:site-a:1')).toBe('v1');
      await api.invalidateByTag('items:site-a:x1');
      expect(await childGet('item:site-a:1')).toBeNull();
      await api.set('item:site-a:1', JSON.stringify('v2'), { tags: ['items:site-a:x1'] });
      expect(await childGet('item:site-a:1')).toBe('v2');
    });

    it('with every notification lost, the other process still never reads a stale value', async () => {
      const api = make();
      await api.set('item:site-a:2', JSON.stringify('old'), { tags: ['items:site-a:x2'] });
      expect(await childGet('item:site-a:2')).toBe('old'); // L1 copy in the child
      child.stdin.write('mute\n');
      expect(await childSays()).toEqual({ ok: true });
      await api.set('item:site-a:2', JSON.stringify('overwritten'), { tags: ['items:site-a:x2'] });
      expect(await childGet('item:site-a:2')).toBe('overwritten');
      await api.invalidateByTag('items:site-a:x2');
      expect(await childGet('item:site-a:2')).toBeNull();
      child.stdin.write('relisten\n');
      expect(await childSays()).toEqual({ ok: true });
    });

    it('after its connections are killed (as in a database restart) the other process reads the new value', async () => {
      const api = make();
      await api.set('item:site-a:3', JSON.stringify('old'), { tags: ['items:site-a:x3'] });
      expect(await childGet('item:site-a:3')).toBe('old');
      await sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = ${CHILD_APP_NAME}`;
      await api.set('item:site-a:3', JSON.stringify('new'), { tags: ['items:site-a:x3'] });
      // A query that lands on a killed pooled connection fails once and reads
      // as a miss (fail soft); a stale value is never returned.
      const reads = [];
      for (let i = 0; i < 3; i++) reads.push(await childGet('item:site-a:3'));
      expect(reads).not.toContain('old');
      expect(reads.at(-1)).toBe('new');
    });
  });
});
