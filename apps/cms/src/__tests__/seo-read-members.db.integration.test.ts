import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { siteDomains, type Database } from '@heopress/database';
import { createRuntime } from '@heopress/runtime/node';
import app from '../index';
import { setRuntimeFactory } from '../middleware/runtime';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { createCrossSiteFixture, type CrossSiteFixture } from './helpers/cross-site-fixture';

/** HeoPress P07a task 8.1: a site's members read structured data, root files and redirects; only administrators change them. */

const JWT_SECRET = 'seo-read-secret';

describe.skipIf(!hasDbIntegrationUrl)('SEO settings — members read, administrators write', () => {
  let db: Database;
  let fx: CrossSiteFixture;
  let env: Record<string, unknown> = {};

  beforeAll(async () => {
    db = await connectDbIntegration('seo-read-members');
    env = { ...process.env, JWT_SECRET, HEOPRESS_ENV: 'development' };
    const runtime = createRuntime(env);
    setRuntimeFactory(() => runtime);
  });
  beforeEach(async () => {
    fx = await createCrossSiteFixture(db, { prefix: 'seoread', jwtSecret: JWT_SECRET });
  });
  afterAll(async () => {
    setRuntimeFactory(null);
    if (fx) await fx.teardown();
  });

  const call = async (who: 'onlyA' | 'adminA' | 'onlyB', method: string, path: string, body?: unknown) =>
    app.request(`/api/v1${path}`, { method, headers: fx.headers('a', await fx.session(who, 'a')), body: body === undefined ? undefined : JSON.stringify(body) }, env);

  it('a member reads all three', async () => {
    for (const path of ['/site/structured-data', '/site/root-files', '/redirects', '/site/canonical', '/site/seo-settings', '/site/identity']) {
      const res = await call('onlyA', 'GET', path);
      expect(res.status, `${path}: ${await res.clone().text()}`).toBe(200);
    }
    expect([200, 404]).toContain((await call('onlyA', 'GET', '/site/root-files/ads.txt')).status);
  });

  it('task 8.2: the canonical domain lists the active hostnames, the primary marked', async () => {
    await db.insert(siteDomains).values([
      { siteId: fx.sites.a, hostname: 'seoread-main.example.com', kind: 'custom', status: 'active', isPrimary: true },
      { siteId: fx.sites.a, hostname: 'seoread-alt.example.com', kind: 'custom', status: 'active', isPrimary: false },
      { siteId: fx.sites.a, hostname: 'seoread-wait.example.com', kind: 'custom', status: 'pending', isPrimary: false },
    ]);
    const res = await call('onlyA', 'GET', '/site/canonical');
    const view = ((await res.json()) as { data: { primary: string; domains: Array<{ hostname: string; primary: boolean }> } }).data;
    expect(view.primary).toBe('seoread-main.example.com');
    expect(view.domains.map((d) => d.hostname)).toEqual(['seoread-alt.example.com', 'seoread-main.example.com']);
    // Switching stays an administrator's (the domains control plane).
    expect((await call('onlyA', 'POST', `/domains/x/primary`)).status).toBe(403);
  });

  it('a member cannot write; an administrator can', async () => {
    expect((await call('onlyA', 'PUT', '/site/root-files/ads.txt', { content: 'example.com, 1, DIRECT' })).status).toBe(403);
    expect((await call('onlyA', 'DELETE', '/site/root-files/ads.txt')).status).toBe(403);
    expect((await call('onlyA', 'POST', '/redirects/delete', { ids: ['x'] })).status).toBe(403);
    // Settings › General (task 12.2): the site's name and default language are the administrators'.
    expect((await call('onlyA', 'PATCH', '/site', { name: 'Renamed by a member' })).status).toBe(403);
    expect((await call('adminA', 'PUT', '/site/root-files/ads.txt', { content: 'example.com, 1, DIRECT' })).status).toBe(200);
  });

  it('someone of another site reads nothing', async () => {
    for (const path of ['/site/structured-data', '/site/root-files', '/redirects', '/site/canonical', '/site/seo-settings', '/site/identity']) {
      expect([401, 403, 404]).toContain((await call('onlyB', 'GET', path)).status);
    }
  });
});
