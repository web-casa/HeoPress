import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { reachabilitySites, siteDomains, type Database } from '@heopress/database';
import { createRuntime } from '@heopress/runtime/node';
import app from '../index';
import { setRuntimeFactory } from '../middleware/runtime';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { createCrossSiteFixture, type CrossSiteFixture } from './helpers/cross-site-fixture';
import type { ReachabilityView } from '../services/site-network/reachability';

/**
 * The reachability check over HTTP (HeoPress P07 task 3.9; spec seo/crawl-discovery "线上可达性体检", scenario 未绑定域名):
 * a check is asked for by an administrator, of the site's verified domains only — an unbound domain, another site's
 * domain or a pending one is refused (422 `DOMAIN_NOT_VERIFIED`); members read the report; another site sees its own.
 */

const JWT_SECRET = 'reachability-secret';

describe.skipIf(!hasDbIntegrationUrl)('reachability check — HTTP', () => {
  let db: Database;
  let fx: CrossSiteFixture;
  let env: Record<string, unknown> = {};

  beforeAll(async () => {
    db = await connectDbIntegration('reachability-http');
    env = { ...process.env, JWT_SECRET, HEOPRESS_ENV: 'development' };
    const runtime = createRuntime(env);
    setRuntimeFactory(() => runtime);
  });
  beforeEach(async () => {
    fx = await createCrossSiteFixture(db, { prefix: 'reachh', jwtSecret: JWT_SECRET });
    await db.insert(siteDomains).values([
      { siteId: fx.sites.a, hostname: 'reachh-a.example.com', kind: 'custom', status: 'active', isPrimary: true, verifiedAt: new Date() },
      { siteId: fx.sites.a, hostname: 'reachh-a-pending.example.com', kind: 'custom', status: 'pending' },
      { siteId: fx.sites.b, hostname: 'reachh-b.example.com', kind: 'custom', status: 'active', isPrimary: true, verifiedAt: new Date() },
    ]);
  });
  afterAll(async () => {
    setRuntimeFactory(null);
    if (fx) await fx.teardown();
  });

  const call = (path: string, method: string, headers: Record<string, string>, body?: unknown) =>
    app.request(path, { method, headers: { ...headers, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }, env);

  it('scenario 未绑定域名: an unbound, pending or other site\'s domain is refused; the site\'s own verified domain is accepted', async () => {
    const admin = fx.headers('a', await fx.session('adminA', 'a'));
    for (const host of ['unbound.example.com', 'reachh-a-pending.example.com', 'reachh-b.example.com']) {
      const res = await call('/api/v1/site/reachability/run', 'POST', admin, { hosts: [host] });
      expect(res.status, host).toBe(422);
      expect(((await res.json()) as { errors: Array<{ code: string }> }).errors[0]!.code).toBe('DOMAIN_NOT_VERIFIED');
    }
    expect(await db.select().from(reachabilitySites).where(eq(reachabilitySites.siteId, fx.sites.a))).toEqual([]);
    expect((await call('/api/v1/site/reachability/run', 'POST', admin, { platform: 'nowhere' })).status).toBe(400);
    // A body that is not a JSON object is refused, never read as "no body" (which would check every domain).
    for (const raw of ['{"hosts":[', '[]', 'null', '"x"']) {
      const res = await app.request('/api/v1/site/reachability/run', { method: 'POST', headers: { ...admin, 'content-type': 'application/json' }, body: raw }, env);
      expect(res.status, raw).toBe(400);
      expect(((await res.json()) as { errors: Array<{ code: string }> }).errors[0]!.code).toBe('VALIDATION');
    }
    expect(await db.select().from(reachabilitySites).where(eq(reachabilitySites.siteId, fx.sites.a))).toEqual([]);
    const ok = await call('/api/v1/site/reachability/run', 'POST', admin, { hosts: ['reachh-a.example.com'], platform: 'netlify' });
    expect(ok.status).toBe(202);
    expect((await db.select().from(reachabilitySites).where(eq(reachabilitySites.siteId, fx.sites.a)))[0]).toMatchObject({ hosts: ['reachh-a.example.com'], platform: 'netlify' });
  });

  it('a check is for administrators; members read the report and the domains a check may name; another site sees its own', async () => {
    const editor = fx.headers('a', await fx.session('onlyA', 'a'));
    expect((await call('/api/v1/site/reachability/run', 'POST', editor, {})).status).toBe(403);
    const res = await call('/api/v1/site/reachability', 'GET', editor);
    expect(res.status).toBe(200);
    const view = ((await res.json()) as { data: ReachabilityView }).data;
    expect(view.hosts.map((h) => h.hostname)).toEqual(['reachh-a.example.com']);
    expect(view.report).toBeNull();
    expect(view.platforms.map((p) => p.id)).toContain('cloudflare-pages');
    const b = ((await (await call('/api/v1/site/reachability', 'GET', fx.headers('b', await fx.session('adminB', 'b')))).json()) as { data: ReachabilityView }).data;
    expect(b.hosts.map((h) => h.hostname)).toEqual(['reachh-b.example.com']);
    // Site A's header with site B's session: refused.
    expect((await call('/api/v1/site/reachability', 'GET', fx.headers('a', await fx.session('adminB', 'b')))).status).toBeGreaterThanOrEqual(401);
  });
});
