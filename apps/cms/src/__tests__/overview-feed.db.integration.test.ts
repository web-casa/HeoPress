import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { collections, contentReviews, items, permissions, policies, rolePolicies, roles, siteDomains, type Database } from '@heopress/database';
import { createRuntime } from '@heopress/runtime/node';
import app from '../index';
import { setRuntimeFactory } from '../middleware/runtime';
import { __resetPermissionProcessCacheForTests } from '../services/permission-service';
import type { OverviewFeed } from '../services/studio/overview-feed';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { createCrossSiteFixture, SHARED, type CrossSiteFixture } from './helpers/cross-site-fixture';

/** `GET /api/v1/studio/overview/feed` (HeoPress P07a task 4.3; spec studio/overview). */

const JWT_SECRET = 'overview-feed-secret';

describe.skipIf(!hasDbIntegrationUrl)('overview feed', () => {
  let db: Database;
  let fx: CrossSiteFixture;
  let env: Record<string, unknown> = {};

  beforeAll(async () => {
    db = await connectDbIntegration('overview-feed');
    env = { ...process.env, JWT_SECRET, HEOPRESS_ENV: 'development' };
    const runtime = createRuntime(env);
    setRuntimeFactory(() => runtime);
  });
  beforeEach(async () => {
    fx = await createCrossSiteFixture(db, { prefix: 'ovfeed', jwtSecret: JWT_SECRET });
    // Bundles compiled by an earlier test stay in the process cache under the same key.
    __resetPermissionProcessCacheForTests();
  });
  afterAll(async () => {
    setRuntimeFactory(null);
    if (fx) await fx.teardown();
  });

  const site = () => fx.sites.a;
  const feed = async (who: 'onlyA' | 'adminA', query = '') => {
    const res = await app.request(`/api/v1/studio/overview/feed${query}`, { headers: { ...fx.headers('a', await fx.session(who, 'a')), 'x-heopress-client': 'studio' } }, env);
    expect(res.status, await res.clone().text()).toBe(200);
    return ((await res.json()) as { data: OverviewFeed }).data;
  };
  async function collection(name: string) {
    const [row] = await db.insert(collections).values({ siteId: site(), name, label: name }).returning({ id: collections.id });
    return row!.id;
  }
  async function idOf(name: string) {
    return (await db.select({ id: collections.id }).from(collections).where(and(eq(collections.siteId, site()), eq(collections.name, name))))[0]!.id;
  }
  async function item(collectionId: string, title: string, extra: Partial<typeof items.$inferInsert> = {}) {
    return (await db.insert(items).values({ siteId: site(), collectionId, status: 'draft', data: { title }, ...extra }).returning({ id: items.id }))[0]!.id;
  }
  async function pending(itemId: string, createdAt: Date) {
    await db.insert(contentReviews).values({ siteId: site(), itemId, status: 'pending', createdAt });
  }
  async function grantEditor(collectionName: string, action: string) {
    const [policy] = await db.insert(policies).values({ siteId: site(), name: `ov ${collectionName} ${action}`, key: `ov-${collectionName}-${action}`, appAccess: true }).returning({ id: policies.id });
    await db.insert(permissions).values({ siteId: site(), policyId: policy!.id, collection: collectionName, action, fields: ['*'] });
    const [role] = await db.select({ id: roles.id }).from(roles).where(and(eq(roles.siteId, site()), eq(roles.name, 'Editor')));
    await db.insert(rolePolicies).values({ roleId: role!.id, policyId: policy!.id });
  }

  it('reviews count and the oldest only from collections with review: posts yes, news no', async () => {
    await grantEditor(SHARED.collection, 'review');
    const news = await collection('news');
    await grantEditor('news', 'read');
    await pending(await item(await idOf(SHARED.collection), 'Posts newer'), new Date(Date.now() - 60_000));
    await pending(await item(await idOf(SHARED.collection), 'Posts oldest'), new Date(Date.now() - 7_200_000));
    await pending(await item(news, 'News oldest of all'), new Date(Date.now() - 9_000_000));
    const f = await feed('onlyA');
    expect(f.reviews?.count).toBe(2);
    expect(f.reviews?.oldest).toMatchObject({ title: 'Posts oldest', collection: SHARED.collection });
    expect(f.reviews!.oldest!.waitSeconds).toBeGreaterThanOrEqual(7190);
  });

  it('no reviewable collection: no reviews card', async () => {
    expect((await feed('onlyA')).reviews).toBeUndefined();
  });

  it('items of a collection the caller cannot read never appear nor count', async () => {
    const secret = await collection('secret');
    const now = Date.now();
    await item(secret, 'Secret published', { status: 'published', publishedAt: new Date(now - 1000) });
    const hidden = await item(secret, 'Secret pending');
    await pending(hidden, new Date(now - 5000));
    await item(await idOf(SHARED.collection), 'Visible published', { status: 'published', publishedAt: new Date(now - 2000) });
    const f = await feed('onlyA');
    const json = JSON.stringify(f);
    expect(json).not.toContain('Secret');
    expect(f.activity.map((a) => a.title)).toContain('Visible published');
    // The administrator sees everything.
    expect(JSON.stringify(await feed('adminA'))).toContain('Secret pending');
  });

  it('a scheduled item appears on its day in the week asked for', async () => {
    const saturday = new Date('2026-10-31T18:00:00Z');
    await item(await idOf(SHARED.collection), 'Saturday story', { publishAt: saturday });
    const f = await feed('onlyA', '?from=2026-10-26T00:00:00Z&to=2026-11-02T00:00:00Z');
    expect(f.week).toContainEqual(expect.objectContaining({ title: 'Saturday story', kind: 'scheduled', at: saturday.toISOString() }));
    const other = await feed('onlyA', '?from=2026-11-02T00:00:00Z&to=2026-11-09T00:00:00Z');
    expect(other.week.map((w) => w.title)).not.toContain('Saturday story');
  });

  it('a window over 14 days is refused', async () => {
    const res = await app.request('/api/v1/studio/overview/feed?from=2026-10-01T00:00:00Z&to=2026-10-30T00:00:00Z', { headers: { ...fx.headers('a', await fx.session('onlyA', 'a')), 'x-heopress-client': 'studio' } }, env);
    expect(res.status).toBe(400);
  });

  it('task 4.5: the setup checklist follows the site: no domain, no article, no policy, one member', async () => {
    const setup = (await feed('adminA')).setup;
    expect(setup).toEqual({ domainVerified: false, firstArticlePublished: false, crawlerPolicySet: false, membersInvited: true });
    // Spec "已绑定域名": a pending domain is not enough; an active one completes the step by itself.
    await db.insert(siteDomains).values({ siteId: fx.sites.a, hostname: 'feed-setup.example.com', kind: 'custom', status: 'pending' });
    expect((await feed('adminA')).setup.domainVerified).toBe(false);
    await db.update(siteDomains).set({ status: 'active', verifiedAt: new Date() }).where(eq(siteDomains.hostname, 'feed-setup.example.com'));
    expect((await feed('adminA')).setup.domainVerified).toBe(true);
  });
});
