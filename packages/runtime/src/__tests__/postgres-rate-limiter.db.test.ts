import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PostgresRateLimiter } from '../adapters/postgres/rate-limiter';
import { PG_URL, connectRuntimeDb, resetRuntimeTables, likeDrizzle } from './helpers/pg';

/**
 * PostgreSQL rate limiter (P03 tasks 2.3–2.4): fixed windows counted
 * atomically in a logged table, so concurrent requests cannot overspend and a
 * new connection (as after a restart) sees the same budget; a database error
 * is thrown, never turned into "allowed".
 */
describe.skipIf(!PG_URL)('PostgresRateLimiter (PostgreSQL)', () => {
  let sql: postgres.Sql;

  beforeAll(async () => {
    sql = await connectRuntimeDb(10);
  });

  beforeEach(async () => {
    await resetRuntimeTables(sql);
  });

  afterAll(async () => {
    await sql?.end({ timeout: 1 });
  });

  it('allows up to the limit, then denies, and reports remaining and reset', async () => {
    const limiter = new PostgresRateLimiter(sql);
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await limiter.consume('rl:recovery:203.0.113.7', 3, 3600));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
    expect(results.map((r) => r.remaining)).toEqual([2, 1, 0, 0]);
    const now = Math.floor(Date.now() / 1000);
    expect(results[3]!.resetAt).toBeGreaterThan(now + 3500);
  });

  it('counts concurrent consumes exactly once each', async () => {
    const limiter = new PostgresRateLimiter(sql);
    const results = await Promise.all(Array.from({ length: 25 }, () => limiter.consume('rl:login:198.51.100.1', 10, 60)));
    expect(results.filter((r) => r.allowed)).toHaveLength(10);
  });

  it('starts a new window once the old one has ended', async () => {
    const limiter = new PostgresRateLimiter(sql);
    expect((await limiter.consume('rl:short', 1, 1)).allowed).toBe(true);
    expect((await limiter.consume('rl:short', 1, 1)).allowed).toBe(false);
    await new Promise((r) => setTimeout(r, 1200));
    expect((await limiter.consume('rl:short', 1, 1)).allowed).toBe(true);
  });

  it('keeps the budget across connections (as after a restart)', async () => {
    const before = new PostgresRateLimiter(sql);
    for (let i = 0; i < 3; i++) await before.consume('rl:recovery:192.0.2.9', 3, 3600);
    const fresh = likeDrizzle(postgres(PG_URL!, { max: 1, onnotice: () => {}, prepare: false }));
    try {
      expect((await new PostgresRateLimiter(fresh).consume('rl:recovery:192.0.2.9', 3, 3600)).allowed).toBe(false);
    } finally {
      await fresh.end({ timeout: 1 });
    }
    const [row] = await sql<{ relpersistence: string }[]>`
      SELECT relpersistence FROM pg_class WHERE oid = 'lumibase_rate_limit_windows'::regclass`;
    expect(row!.relpersistence).toBe('p'); // logged: survives a crash restart
  });

  it('throws when the database is unavailable', async () => {
    const dead = postgres('postgresql://nobody@127.0.0.1:1/none', { connect_timeout: 1, max: 1 });
    await expect(new PostgresRateLimiter(dead).consume('rl:x', 1, 60)).rejects.toThrow();
    await dead.end({ timeout: 1 });
  });
});
