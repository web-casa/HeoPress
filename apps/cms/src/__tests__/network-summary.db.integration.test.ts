import { SignJWT } from 'jose';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  auditLog,
  authSessions,
  collections,
  contentReviews,
  crawlDaily,
  sites,
  items,
  permissions,
  policies,
  rolePolicies,
  roles,
  siteDomains,
  userSites,
  type Database,
} from '@heopress/database';
import { createRuntime } from '@heopress/runtime/node';
import app from '../index';
import { setRuntimeFactory } from '../middleware/runtime';
import { TOKEN_AUDIENCE } from '../services/auth/token-audience';
import { runSiteTransaction } from '../services/rls-transaction';
import { networkAiTraffic, networkSummary, type SiteSummary } from '../services/studio/network-summary';
import { aiTrafficReport } from '../services/site-network/ai-traffic';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { createCrossSiteFixture, SHARED, type CrossSiteFixture } from './helpers/cross-site-fixture';

/**
 * The cross-site read-only summary (HeoPress P07a task 3.1; spec studio/network-summary, sites/site-switching
 * "跨站只读概要是唯一的跨站读取"). Each site is judged per request in its own scope, with permissions compiled afresh.
 */

const JWT_SECRET = 'network-summary-secret';
type Full = Extract<SiteSummary, { computedAt: string }>;

describe.skipIf(!hasDbIntegrationUrl)('network summary', () => {
  let db: Database;
  let fx: CrossSiteFixture;
  let env: Record<string, unknown> = {};

  beforeAll(async () => {
    db = await connectDbIntegration('network-summary');
    env = { ...process.env, JWT_SECRET, HEOPRESS_ENV: 'development' };
    const runtime = createRuntime(env);
    setRuntimeFactory(() => runtime);
  });
  beforeEach(async () => {
    fx = await createCrossSiteFixture(db, { prefix: 'netsum', jwtSecret: JWT_SECRET });
  });
  afterAll(async () => {
    setRuntimeFactory(null);
    if (fx) await fx.teardown();
  });

  const read = async (bearer: string, site: 'a' | 'b' = 'a') =>
    app.request('/api/v1/studio/network-summary', { headers: { ...fx.headers(site, bearer), 'x-heopress-client': 'studio' } }, env);
  const summary = async (who: Parameters<CrossSiteFixture['session']>[0], site: 'a' | 'b' = 'a') => {
    const res = await read(await fx.session(who, site), site);
    expect(res.status, await res.clone().text()).toBe(200);
    return ((await res.json()) as { data: SiteSummary[] }).data;
  };
  const siteOf = (data: SiteSummary[], key: 'a' | 'b') => data.find((s) => s.id === fx.sites[key]);

  async function grant(site: 'a' | 'b', roleName: string, collection: string, action: string, extra: Partial<typeof policies.$inferInsert> = {}) {
    const siteId = fx.sites[site];
    const [policy] = await db
      .insert(policies)
      .values({ siteId, name: `${roleName} ${action}`, key: `netsum-${site}-${roleName}-${collection}-${action}`, adminAccess: false, appAccess: true, ...extra })
      .returning({ id: policies.id });
    await db.insert(permissions).values({ siteId, policyId: policy!.id, collection, action, fields: ['*'] });
    const [role] = await db.select({ id: roles.id }).from(roles).where(and(eq(roles.siteId, siteId), eq(roles.name, roleName)));
    await db.insert(rolePolicies).values({ roleId: role!.id, policyId: policy!.id });
    return policy!.id;
  }

  async function collectionId(site: 'a' | 'b', name: string, meta: Record<string, unknown> = {}) {
    const [row] = await db.insert(collections).values({ siteId: fx.sites[site], name, label: name, meta }).returning({ id: collections.id });
    return row!.id;
  }

  async function pendingReview(site: 'a' | 'b', collection: string, createdAt = new Date()) {
    const siteId = fx.sites[site];
    const [coll] = await db.select({ id: collections.id }).from(collections).where(and(eq(collections.siteId, siteId), eq(collections.name, collection)));
    const [item] = await db.insert(items).values({ siteId, collectionId: coll!.id, status: 'draft', editorialState: 'in_review', data: { title: `Secret ${collection} title` } }).returning({ id: items.id });
    await db.insert(contentReviews).values({ siteId, itemId: item!.id, status: 'pending', createdAt });
  }

  it('each site judged with its own role: an editor of A and reader of B; titles never leave', async () => {
    await pendingReview('a', SHARED.collection);
    const data = await summary('both');
    expect(data.map((s) => s.id).sort()).toEqual([fx.sites.a, fx.sites.b].sort());
    const a = siteOf(data, 'a') as Full;
    expect(a.role).toBe('Editor');
    expect(siteOf(data, 'b')!.role).toBe('Reader');
    // Neither role has `review` (task 5.1): no number.
    expect(a.pendingReviews).toBe('no_permission');
    expect(a.availability).toBe('available');
    const json = JSON.stringify(data);
    expect(json).not.toContain('Secret');
    expect(json).not.toContain('Hello from');
    expect(json).not.toContain(SHARED.path);
  });

  it('a site the caller is not a member of is absent, not even its id', async () => {
    const json = JSON.stringify(await summary('onlyA'));
    expect(json).toContain(fx.sites.a);
    expect(json).not.toContain(fx.sites.b);
  });

  it('API keys and frontend sessions are refused', async () => {
    expect((await read(fx.apiKeys.aEditor.token)).status).toBe(403);
    const frontend = await new SignJWT({ userId: fx.users.onlyA.id, siteId: fx.sites.a, sid: await fx.loginOf('onlyA'), tokenVersion: 0 })
      .setProtectedHeader({ alg: 'HS256' })
      .setAudience(TOKEN_AUDIENCE.frontend)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(JWT_SECRET));
    expect([401, 403]).toContain((await read(frontend)).status);
  });

  it('removal from a site and a downgrade show on the very next request', async () => {
    await pendingReview('a', SHARED.collection);
    expect((siteOf(await summary('adminA'), 'a') as Full).pendingReviews).toMatchObject({ count: 1 });
    expect(siteOf(await summary('both'), 'b')).toBeDefined();
    await db.delete(userSites).where(and(eq(userSites.userId, fx.users.both.id), eq(userSites.siteId, fx.sites.b)));
    expect(siteOf(await summary('both'), 'b')).toBeUndefined();
    const [editor] = await db.select({ id: roles.id }).from(roles).where(and(eq(roles.siteId, fx.sites.a), eq(roles.name, 'Editor')));
    await db.update(userSites).set({ roleId: editor!.id }).where(and(eq(userSites.userId, fx.users.adminA.id), eq(userSites.siteId, fx.sites.a)));
    expect((siteOf(await summary('adminA'), 'a') as Full).pendingReviews).toBe('no_permission');
  });

  it('pending reviews count only collections with review and read; the oldest wait, no title', async () => {
    await collectionId('a', 'news');
    await grant('a', 'Editor', SHARED.collection, 'review');
    await pendingReview('a', SHARED.collection, new Date(Date.now() - 3_600_000));
    await pendingReview('a', 'news');
    const a = siteOf(await summary('onlyA'), 'a') as Full;
    expect(a.pendingReviews).toMatchObject({ count: 1 });
    expect((a.pendingReviews as { oldestWaitSeconds: number }).oldestWaitSeconds).toBeGreaterThanOrEqual(3590);
  });

  it('published articles: preset articles 2 + a marked custom collection 1, pages not counted; partial and unreadable', async () => {
    const siteId = fx.sites.a;
    await db.update(collections).set({ meta: { preset: { key: 'articles' } } }).where(and(eq(collections.siteId, siteId), eq(collections.name, SHARED.collection)));
    const news = await collectionId('a', 'news', { studio: { kind: 'article' } });
    const pages = await collectionId('a', 'pages', { preset: { key: 'pages' } });
    const [articles] = await db.select({ id: collections.id }).from(collections).where(and(eq(collections.siteId, siteId), eq(collections.name, SHARED.collection)));
    await db.insert(items).values([
      { siteId, collectionId: articles!.id, status: 'published', data: {} },
      { siteId, collectionId: articles!.id, status: 'published', data: {} },
      { siteId, collectionId: news, status: 'published', data: {} },
      { siteId, collectionId: pages, status: 'published', data: {} },
    ]);
    expect((siteOf(await summary('adminA'), 'a') as Full).publishedArticles).toEqual({ count: 3, partial: false });
    // The editor reads articles but not news: the readable sum, marked partial.
    expect((siteOf(await summary('onlyA'), 'a') as Full).publishedArticles).toEqual({ count: 2, partial: true });
    // B: the reader of B reads articles; mark only an unreadable collection as an article one.
    await db.update(collections).set({ meta: {} }).where(and(eq(collections.siteId, fx.sites.b), eq(collections.name, SHARED.collection)));
    await collectionId('b', 'secret_news', { studio: { kind: 'article' } });
    expect((siteOf(await summary('both'), 'b') as Full).publishedArticles).toBe('no_permission');
  });

  it('two-step verification: unverified, a site requiring it shows only identity; verified, everything', async () => {
    await db.update(policies).set({ enforceTfa: true }).where(eq(policies.key, `netsum-b-reader`));
    const b = siteOf(await summary('both'), 'b')!;
    expect(Object.keys(b).sort()).toEqual(['availability', 'id', 'name', 'primaryDomain', 'primaryDomainState', 'role'].sort());
    expect(b.availability).toBe('mfa_required');
    expect(siteOf(await summary('both'), 'a')!.availability).toBe('available');
    await db.update(authSessions).set({ mfaVerified: true }).where(eq(authSessions.id, await fx.loginOf('both')));
    const verified = siteOf(await summary('both'), 'b') as Full;
    expect(verified.availability).toBe('available');
    expect(verified.health).toBeDefined();
  });

  it('a policy not yet valid, one expired and an IP rule apply at once (no bundle cache)', async () => {
    const policyId = await grant('a', 'Editor', SHARED.collection, 'review');
    await pendingReview('a', SHARED.collection);
    const req = { ip: '203.0.113.9', headers: {} };
    const user = { id: fx.users.onlyA.id, email: fx.users.onlyA.email, isBootstrap: false };
    const run = async () => (await networkSummary(db, { user, mfaVerified: false, currentSiteId: fx.sites.a, req })).sites.find((s) => s.id === fx.sites.a) as Full;
    expect(typeof (await run()).pendingReviews).toBe('object');
    await db.update(policies).set({ validFrom: new Date(Date.now() + 86_400_000) }).where(eq(policies.id, policyId));
    expect((await run()).pendingReviews).toBe('no_permission');
    await db.update(policies).set({ validFrom: null, validUntil: new Date(Date.now() - 1000) }).where(eq(policies.id, policyId));
    expect((await run()).pendingReviews).toBe('no_permission');
    await db.update(policies).set({ validUntil: null, ipAllow: ['198.51.100.0/24'] }).where(eq(policies.id, policyId));
    expect((await run()).pendingReviews).toBe('no_permission');
    await db.update(policies).set({ ipAllow: ['203.0.113.0/24'] }).where(eq(policies.id, policyId));
    expect(typeof (await run()).pendingReviews).toBe('object');
  });

  it('a slow site is marked unavailable, identity only; the others answer in time', async () => {
    const user = { id: fx.users.both.id, email: fx.users.both.email, isBootstrap: false };
    const result = await networkSummary(
      db,
      { user, mfaVerified: false, currentSiteId: fx.sites.a, req: { ip: null, headers: {} } },
      { deadlineMs: 300, beforeSite: async (id) => (id === fx.sites.b ? new Promise((r) => setTimeout(r, 1500)) : undefined) },
    );
    const b = result.sites.find((s) => s.id === fx.sites.b)!;
    expect(b.availability).toBe('unavailable');
    expect(Object.keys(b).sort()).toEqual(['availability', 'id', 'name', 'primaryDomain', 'primaryDomainState', 'role'].sort());
    expect(result.sites.find((s) => s.id === fx.sites.a)!.availability).toBe('available');
    expect(result.elapsedMs).toBeLessThan(1200);
  });

  it('primary domain: none without domains or with only pending ones; unset with an active non-primary one; set', async () => {
    const siteId = fx.sites.a;
    expect(siteOf(await summary('adminA'), 'a')).toMatchObject({ primaryDomain: null, primaryDomainState: 'none' });
    await runSiteTransaction(db, siteId, (tx) => tx.insert(siteDomains).values({ siteId, hostname: 'pending.netsum.example.com', status: 'pending', kind: 'custom' } as never));
    expect(siteOf(await summary('adminA'), 'a')).toMatchObject({ primaryDomainState: 'none' });
    await runSiteTransaction(db, siteId, (tx) => tx.insert(siteDomains).values({ siteId, hostname: 'www.netsum.example.com', status: 'active', kind: 'custom' } as never));
    const unset = siteOf(await summary('adminA'), 'a') as Full;
    expect(unset).toMatchObject({ primaryDomain: null, primaryDomainState: 'unset' });
    expect(unset.health.reasons.map((r) => r.code)).toContain('no_primary_domain');
    await runSiteTransaction(db, siteId, (tx) => tx.update(siteDomains).set({ isPrimary: true }).where(eq(siteDomains.hostname, 'www.netsum.example.com')));
    expect(siteOf(await summary('adminA'), 'a')).toMatchObject({ primaryDomain: 'www.netsum.example.com', primaryDomainState: 'set' });
  });

  it('every read leaves one audit record with the number of sites only', async () => {
    await summary('both');
    const rows = await runSiteTransaction(db, fx.sites.a, (tx) =>
      tx.select().from(auditLog).where(and(eq(auditLog.siteId, fx.sites.a), sql`${auditLog.event} = 'studio_network_summary_read'`)),
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(rows.at(-1))).toContain('"sites":2');
  });

  describe('AI traffic series (task 3.3) and the previous period (task 7.1)', () => {
    const SITE_C = 'site_netsum_c';
    const day = (back: number) => new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10);
    async function traffic(siteId: string, back: number, crawler: number, referral: number) {
      await runSiteTransaction(db, siteId, (tx) =>
        tx.insert(crawlDaily).values([
          { siteId, day: day(back), kind: 'crawler', agent: 'gptbot', operator: 'OpenAI', purpose: 'training', resource: 'page', path: '/x/', hits: crawler },
          { siteId, day: day(back), kind: 'referral', agent: 'chatgpt', operator: 'OpenAI', purpose: '', resource: 'page', path: '/x/', hits: referral },
        ]),
      );
    }
    beforeEach(async () => {
      await db.delete(sites).where(eq(sites.id, SITE_C));
      await db.insert(sites).values({ id: SITE_C, name: 'netsum C' });
      const [role] = await db.insert(roles).values({ siteId: SITE_C, name: 'Reader', adminAccess: false, appAccess: true }).returning({ id: roles.id });
      await db.insert(userSites).values({ userId: fx.users.both.id, siteId: SITE_C, roleId: role!.id });
      await traffic(fx.sites.a, 1, 3, 1);
      await traffic(fx.sites.b, 1, 4, 2);
      await traffic(SITE_C, 1, 5, 3);
      await traffic(fx.sites.a, 40, 7, 0);
    });
    afterAll(async () => {
      await db.delete(sites).where(eq(sites.id, SITE_C));
    });
    const principal = async (mfaVerified = false) => ({
      user: { id: fx.users.both.id, email: fx.users.both.email, isBootstrap: false },
      mfaVerified,
      currentSiteId: fx.sites.a,
      req: { ip: null, headers: {} },
    });

    it('three sites: each day is the sum, with per-site totals and the previous 30 days', async () => {
      const r = await networkAiTraffic(db, await principal(), 30);
      const yesterday = r.byDay.find((d) => d.day === day(1))!;
      expect(yesterday).toMatchObject({ training: 12, referral: 6 });
      expect(r.totals).toEqual({ crawler: 12, referral: 6 });
      expect(r.previousTotals).toEqual({ crawler: 7, referral: 0 });
      expect(r.sites).toHaveLength(3);
      expect(r.excluded).toEqual({ mfaRequired: 0, unavailable: 0 });
    });

    it('B requires two-step verification: left out until this login verifies', async () => {
      await db.update(policies).set({ enforceTfa: true }).where(eq(policies.key, 'netsum-b-reader'));
      const unverified = await networkAiTraffic(db, await principal(false), 30);
      expect(unverified.totals).toEqual({ crawler: 8, referral: 4 });
      expect(unverified.excluded.mfaRequired).toBe(1);
      expect(Object.keys(unverified.sites.find((s) => s.id === fx.sites.b)!)).not.toContain('totals');
      expect((await networkAiTraffic(db, await principal(true), 30)).totals).toEqual({ crawler: 12, referral: 6 });
    });

    it('C times out: left out and named unavailable, never counted as zero', async () => {
      const r = await networkAiTraffic(db, await principal(), 30, {
        deadlineMs: 300,
        beforeSite: async (id) => (id === SITE_C ? new Promise((res) => setTimeout(res, 1500)) : undefined),
      });
      expect(r.totals).toEqual({ crawler: 7, referral: 3 });
      expect(r.excluded.unavailable).toBe(1);
      const c = r.sites.find((s) => s.id === SITE_C)!;
      expect(c.availability).toBe('unavailable');
      expect(c).not.toHaveProperty('totals');
    });

    it('task 7.1: the previous period with no recorded day is null, not zeros', async () => {
      expect((await aiTrafficReport(db, fx.sites.b, { days: 30, previous: true })).previousTotals).toBeNull();
      expect((await aiTrafficReport(db, fx.sites.a, { days: 30, previous: true })).previousTotals).toEqual({ crawler: 7, referral: 0 });
      expect(await aiTrafficReport(db, fx.sites.a, { days: 30 })).not.toHaveProperty('previousTotals');
    });
  });
});
