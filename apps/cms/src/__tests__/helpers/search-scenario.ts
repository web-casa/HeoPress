import { afterAll, beforeAll, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createDb, sites, systemState, users, type Database } from '@heopress/database';
import { createRuntime } from '@heopress/runtime/node';
import type { RuntimeContext } from '@heopress/runtime';

import app from '../../index';
import { setRuntimeFactory } from '../../middleware/runtime';
import { searchSyncConsumer } from '../../services/content-indexing-worker';
import { registerEventConsumers } from '../../modules/events/consumer-worker';
import { EventConsumerRunner } from '../../modules/events/consumer-runner';
import { STANDARD_LOCKOUT_POLICY } from '../../modules/setup/policy-codec';

/**
 * The search API end to end on one backend (P03 tasks 5.1–5.2): items are
 * created through the real app, indexed by the search sync event consumer, and found
 * through GET /api/v1/search — Chinese and English, and only within the
 * caller's site. Used by search-postgres.e2e.test.ts and
 * search-meilisearch.e2e.test.ts (one runtime per test file).
 */
export function searchApiScenario(env: Record<string, unknown>, backend: 'postgres' | 'meilisearch'): void {
  const SITE = '__default__';
  let db: Database;
  let runtime: RuntimeContext;
  let bearer = '';
  let stopConsumers: (() => void) | undefined;
  const request = (path: string, init?: RequestInit) => app.request(path, init, env);
  const headers = () => ({ 'content-type': 'application/json', 'x-heopress-site': SITE, authorization: bearer });

  async function reset(): Promise<void> {
    await db.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
    await db.delete(users).where(eq(users.isBootstrap, true)).catch(() => undefined);
    await db.delete(systemState).catch(() => undefined);
  }

  beforeAll(async () => {
    db = createDb(String(env.DATABASE_URL));
    await db.execute(sql`SELECT 1`);
    await reset();
    runtime = createRuntime(env);
    setRuntimeFactory(() => runtime);
    // Search sync is an event consumer (HeoPress P04): register it before the
    // first write (it starts at the head), then let the worker loop run it.
    // A name of its own, from the head: the shared test database keeps events
    // of earlier suites that this run should not replay.
    const consumer = {
      ...searchSyncConsumer({ db, search: runtime.search, keyProvider: runtime.keys }),
      name: `search-index:e2e:${backend}:${Date.now()}`,
      startFrom: 'head' as const,
    };
    await new EventConsumerRunner(db).register(consumer);
    stopConsumers = registerEventConsumers({ db, queue: runtime.queue, consumers: () => [consumer], tickMs: 200 });

    const setup = await request('/api/v1/setup/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        account: { email: 'search-admin@example.test', password: 'Search-E2E-Pass-1!', firstName: 'Search', lastName: 'Admin' },
        adminPath: '/search-e2e-admin',
        policy: STANDARD_LOCKOUT_POLICY,
        project: { defaultLanguage: 'en', siteUrl: 'https://search.example.test', displayTitle: 'Search E2E' },
      }),
    });
    expect(setup.status, await setup.clone().text()).toBe(201);
    const login = await request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-heopress-site': SITE },
      body: JSON.stringify({ email: 'search-admin@example.test', password: 'Search-E2E-Pass-1!' }),
    });
    bearer = `Bearer ${((await login.json()) as { data: { token: string } }).data.token}`;
    expect((await request('/api/v1/collections', { method: 'POST', headers: headers(), body: JSON.stringify({ name: 'notes' }) })).status).toBe(201);
    for (const data of [
      { title: '站群运营指南', body: '介绍内容管理系统的全文检索。' },
      { title: 'Running a site network', body: 'Editors search content across many sites.' },
    ]) {
      const res = await request('/api/v1/items/notes', { method: 'POST', headers: headers(), body: JSON.stringify({ data, status: 'published' }) });
      expect(res.status).toBe(201);
    }
    // A document of another site in the same backend, written directly.
    await runtime.search.index('other_site__notes', [{ id: 'x1', _title: 'exclusiveword 运营指南' }]);
  }, 60_000);

  afterAll(async () => {
    stopConsumers?.();
    await runtime?.queue.close?.();
    setRuntimeFactory(null);
    if (db) await reset();
  });

  const searchIds = async (q: string) => {
    const res = await request(`/api/v1/search?collection=notes&q=${encodeURIComponent(q)}`, { headers: headers() });
    expect(res.status, await res.clone().text()).toBe(200);
    return ((await res.json()) as { data: Array<{ title?: string; _title?: string }> }).data.map((h) => h._title ?? h.title);
  };

  const eventuallyFinds = async (q: string, expected: string) => {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const found = await searchIds(q);
      if (found.includes(expected)) return;
      if (Date.now() > deadline) throw new Error(`${backend}: "${q}" never found "${expected}" (got ${JSON.stringify(found)})`);
      await new Promise((r) => setTimeout(r, 300));
    }
  };

  // Only searchable attributes are matched — here the title, as no field of
  // the collection is marked searchable (same semantics on both backends).
  it(`${backend}: finds a Chinese article indexed through the queue`, async () => {
    await eventuallyFinds('运营指南', '站群运营指南');
  }, 30_000);

  it(`${backend}: finds an English article`, async () => {
    await eventuallyFinds('site network', 'Running a site network');
  }, 30_000);

  it(`${backend}: never returns another site's documents`, async () => {
    expect(await searchIds('exclusiveword')).toEqual([]);
  });
}
