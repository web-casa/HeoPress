import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '@heopress/database';
import { createRuntime } from '@heopress/runtime/node';
import app from '../index';
import { setRuntimeFactory } from '../middleware/runtime';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { createCrossSiteFixture, type CrossSiteFixture } from './helpers/cross-site-fixture';

/** Settings › API & keys (HeoPress P07a task 12.6; spec studio/settings "新建密钥"): the full key is returned once. */

const JWT_SECRET = 'api-key-once-secret';

describe.skipIf(!hasDbIntegrationUrl)('API keys — the full key once, then its last 4 characters', () => {
  let db: Database;
  let fx: CrossSiteFixture;
  let env: Record<string, unknown> = {};

  beforeAll(async () => {
    db = await connectDbIntegration('api-key-once');
    env = { ...process.env, JWT_SECRET, HEOPRESS_ENV: 'development' };
    const runtime = createRuntime(env);
    setRuntimeFactory(() => runtime);
  });
  beforeEach(async () => {
    fx = await createCrossSiteFixture(db, { prefix: 'keyonce', jwtSecret: JWT_SECRET });
  });
  afterAll(async () => {
    setRuntimeFactory(null);
    if (fx) await fx.teardown();
  });

  const call = async (method: string, path: string, body?: unknown) =>
    app.request(`/api/v1${path}`, { method, headers: fx.headers('a', await fx.session('adminA', 'a')), body: body === undefined ? undefined : JSON.stringify(body) }, env);

  it('create shows the token; list, read and rotate-free reads never do', async () => {
    const created = await call('POST', '/api-keys', { name: 'Deploy hook' });
    expect(created.status, await created.clone().text()).toBe(201);
    const key = ((await created.json()) as { data: { id: string; token: string; last4: string } }).data;
    expect(key.token.length).toBeGreaterThan(20);
    expect(key.last4).toBe(key.token.slice(-4));

    for (const path of ['/api-keys', `/api-keys/${key.id}`]) {
      const text = await (await call('GET', path)).text();
      expect(text).not.toContain(key.token);
      expect(text).toContain(`"last4":"${key.last4}"`);
    }
    // Rotating shows the new token once and its new last 4.
    const rotated = ((await (await call('POST', `/api-keys/${key.id}/rotate`, {})).json()) as { data: { token: string; last4: string } }).data;
    expect(rotated.last4).toBe(rotated.token.slice(-4));
    expect(await (await call('GET', '/api-keys')).text()).not.toContain(rotated.token);
  });

  it('spec ops/event-log "不泄露密钥": the event of a new key has its name, scope and last 4 — never the key or its prefix', async () => {
    const created = await call('POST', '/api-keys', { name: 'Events key' });
    const key = ((await created.json()) as { data: { id: string; token: string; last4: string; prefix: string } }).data;
    await new Promise((r) => setTimeout(r, 300));
    const res = await app.request('/api/v1/studio/events?source=api_key', { headers: { ...fx.headers('a', await fx.session('adminA', 'a')), 'x-heopress-client': 'studio' } }, env);
    expect(res.status, await res.clone().text()).toBe(200);
    const text = await res.text();
    const event = ((JSON.parse(text) as { data: Array<{ event: string; data: Record<string, unknown> }> }).data).find((e) => e.event === 'api_key_created' && e.data.apiKeyName === 'Events key');
    expect(event?.data).toMatchObject({ apiKeyName: 'Events key', last4: key.last4, scope: { roles: [], policies: [] } });
    expect(text).not.toContain(key.token);
    expect(text).not.toContain(key.prefix);
  });
});
