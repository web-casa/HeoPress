import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createDb, sites, systemState, users, type Database } from '@heopress/database';

import app from '../index';
import { STANDARD_LOCKOUT_POLICY } from '../modules/setup/policy-codec';

/**
 * Login and recovery budgets through the real app on PostgreSQL (P03 task
 * 2.3): both run on the generic rate limiter (the logged PostgreSQL table),
 * answer 429 with Retry-After once spent, and do not share a budget.
 * Fail-closed behaviour is covered without a database in
 * security-rate-limits-fail-closed.test.ts. Needs DATABASE_URL (disposable).
 */

const TEST_DATABASE_URL = process.env.DATABASE_URL?.trim() || undefined;
const SITE = '__default__';
const ENV = { ...process.env, HEOPRESS_LOGIN_RATE_LIMIT: '3' } as unknown as Record<string, unknown>;
const request = (path: string, init?: RequestInit) => app.request(path, init, ENV);
const json = (ip: string) => ({ 'content-type': 'application/json', 'x-heopress-site': SITE, 'cf-connecting-ip': ip });

const login = (ip: string) =>
  request('/api/v1/auth/login', {
    method: 'POST',
    headers: json(ip),
    body: JSON.stringify({ email: `nobody-${Math.random()}@example.test`, password: 'Wrong-Password-1!' }),
  });
const recover = (ip: string) =>
  request('/api/v1/admin/security/recover', {
    method: 'POST',
    headers: json(ip),
    body: JSON.stringify({ email: 'nobody@example.test', code: 'AAAA-BBBB' }),
  });

describe.skipIf(!TEST_DATABASE_URL)('login and recovery rate limits (PostgreSQL)', () => {
  let db: Database;

  async function resetFixture(): Promise<void> {
    await db.execute(sql`TRUNCATE lumibase_rate_limit_windows`).catch(() => undefined);
    await db.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
    await db.delete(users).where(eq(users.isBootstrap, true)).catch(() => undefined);
    await db.delete(systemState).catch(() => undefined);
  }

  beforeAll(async () => {
    db = createDb(TEST_DATABASE_URL!);
    await db.execute(sql`SELECT 1`);
    await resetFixture();
    const setup = await request('/api/v1/setup/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        account: { email: 'limits-admin@example.test', password: 'Rate-Limits-E2E-1!', firstName: 'Rate', lastName: 'Limits' },
        adminPath: '/rate-limits-admin',
        policy: STANDARD_LOCKOUT_POLICY,
        project: { defaultLanguage: 'en', siteUrl: 'https://limits.example.test', displayTitle: 'Limits' },
      }),
    });
    expect(setup.status, await setup.clone().text()).toBe(201);
  });

  afterAll(async () => {
    if (db) await resetFixture();
  });

  it('login: the attempt after the per-IP budget answers 429 with Retry-After', async () => {
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await login('203.0.113.10')).status);
    expect(statuses.every((s) => s !== 429)).toBe(true);
    const blocked = await login('203.0.113.10');
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    // Another IP has its own budget.
    expect((await login('203.0.113.11')).status).not.toBe(429);
  });

  it('recovery: three requests per IP per hour, then 429', async () => {
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await recover('198.51.100.20')).status);
    expect(statuses.every((s) => s !== 429)).toBe(true);
    expect((await recover('198.51.100.20')).status).toBe(429);
  });

  it('login and recovery do not share a budget', async () => {
    for (let i = 0; i < 4; i++) await login('192.0.2.30');
    expect((await login('192.0.2.30')).status).toBe(429);
    expect((await recover('192.0.2.30')).status).not.toBe(429);
  });

  it('a real Node server counts the socket address, not a client-supplied header', async () => {
    const server = serve({
      fetch: (req, nodeEnv) => app.fetch(req, { ...ENV, ...(nodeEnv as object) }),
      port: 0,
      hostname: '127.0.0.1',
    });
    try {
      await new Promise<void>((resolve) => server.once('listening', () => resolve()));
      const { port } = server.address() as AddressInfo;
      const attempt = (spoofed: string) =>
        fetch(`http://127.0.0.1:${port}/api/v1/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-heopress-site': SITE, 'cf-connecting-ip': spoofed },
          body: JSON.stringify({ email: `nobody-${Math.random()}@example.test`, password: 'Wrong-Password-1!' }),
        });
      // A different spoofed header on every attempt must not buy a fresh budget.
      const statuses = [];
      for (let i = 0; i < 4; i++) statuses.push((await attempt(`203.0.113.${100 + i}`)).status);
      expect(statuses.slice(0, 3).every((s) => s !== 429)).toBe(true);
      expect(statuses[3]).toBe(429);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('budgets are stored in the logged table', async () => {
    const rows = await db.execute(sql`SELECT key FROM lumibase_rate_limit_windows WHERE key LIKE 'rl:%' ORDER BY key`);
    const keys = (rows as unknown as Array<{ key: string }>).map((r) => r.key);
    expect(keys).toEqual(expect.arrayContaining([`rl:login:${SITE}:203.0.113.10`, 'rl:recovery:198.51.100.20']));
  });
});
