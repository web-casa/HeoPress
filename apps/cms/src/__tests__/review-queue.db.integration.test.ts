import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { collections, items, type Database } from '@heopress/database';
import { createRuntime } from '@heopress/runtime/node';
import app from '../index';
import { setRuntimeFactory } from '../middleware/runtime';
import { __resetPermissionProcessCacheForTests } from '../services/permission-service';
import { AUTO_STALE_REASON } from '../services/staleness/marks';
import { connectDbFixtures, connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { createCrossSiteFixture, SHARED, type CrossSiteFixture } from './helpers/cross-site-fixture';

/**
 * The review queue (HeoPress v1.1; spec content/stale-content-queue): the site's manual marks, automatic marks and
 * items awaiting review, with per-group counts, a page cap and `truncated`, scoped to the site and to the collections
 * the caller may read.
 */

const JWT_SECRET = 'review-queue-secret';

interface QueueRow {
  itemId: string;
  collection: string;
  title: string;
  reason: string | null;
  dueAt: string | null;
  updatedAt: string;
  group: 'manual' | 'auto' | 'awaiting_review';
}
interface Queue {
  counts: Record<'manual' | 'auto' | 'awaiting_review', number>;
  items: QueueRow[];
  truncated: boolean;
  limit: number;
}

describe.skipIf(!hasDbIntegrationUrl)('review queue — DB integration', () => {
  let fixtures: Database;
  let fx: CrossSiteFixture;
  let env: Record<string, unknown> = {};
  let articles = '';
  let locked = '';

  beforeAll(async () => {
    // The database must answer for both roles the suite relies on: the requests below run as the application role
    // (the runtime builds that handle per request), and the fixtures prepare rows as the owner.
    await connectDbIntegration('review-queue');
    fixtures = await connectDbFixtures('review-queue');
    env = { ...process.env, JWT_SECRET, HEOPRESS_ENV: 'development' };
    setRuntimeFactory(() => createRuntime(env));
  });
  beforeEach(async () => {
    fx = await createCrossSiteFixture(fixtures, { prefix: 'rq', jwtSecret: JWT_SECRET });
    __resetPermissionProcessCacheForTests();
    articles = await collectionId(fx.sites.a, SHARED.collection);
    const [row] = await fixtures
      .insert(collections)
      .values({ siteId: fx.sites.a, name: 'locked', label: 'Locked' })
      .returning({ id: collections.id });
    locked = row!.id;

    const dueAt = new Date('2026-12-01T00:00:00.000Z');
    // One row per group, plus rows the queue must not return.
    await make('Manual piece', {
      needsUpdateSince: new Date('2026-11-01T00:00:00.000Z'),
      needsUpdateReason: 'Prices changed',
      needsUpdateDueAt: dueAt,
      needsUpdateSource: 'manual',
    });
    await make('Auto piece', {
      needsUpdateSince: new Date('2026-11-02T00:00:00.000Z'),
      needsUpdateReason: AUTO_STALE_REASON,
      needsUpdateSource: 'auto',
    });
    await make('Review piece', { status: 'draft', editorialState: 'in_review' });
    await make('Unmarked piece');
    await make('Deleted marked piece', {
      deletedAt: new Date('2026-11-03T00:00:00.000Z'),
      needsUpdateSince: new Date('2026-11-01T00:00:00.000Z'),
      needsUpdateReason: 'Deleted',
      needsUpdateSource: 'manual',
    });
    await fixtures.insert(items).values({
      siteId: fx.sites.a,
      collectionId: locked,
      status: 'published',
      data: { title: 'Locked piece' },
      needsUpdateSince: new Date('2026-11-01T00:00:00.000Z'),
      needsUpdateReason: 'No permission to read',
      needsUpdateSource: 'manual',
    });
    // A hidden collection is never offered in a queue, even when its rows carry a mark.
    const [hidden] = await fixtures
      .insert(collections)
      .values({ siteId: fx.sites.a, name: 'hidden', label: 'Hidden', meta: { hidden: true } })
      .returning({ id: collections.id });
    await fixtures.insert(items).values({
      siteId: fx.sites.a,
      collectionId: hidden!.id,
      status: 'published',
      data: { title: 'Hidden piece' },
      needsUpdateSince: new Date('2026-11-01T00:00:00.000Z'),
      needsUpdateReason: 'Hidden from the queue',
      needsUpdateSource: 'manual',
    });
    await fixtures.insert(items).values({
      siteId: fx.sites.b,
      collectionId: await collectionId(fx.sites.b, SHARED.collection),
      status: 'published',
      data: { title: 'Site B piece' },
      needsUpdateSince: new Date('2026-11-01T00:00:00.000Z'),
      needsUpdateReason: 'Another site',
      needsUpdateSource: 'manual',
    });
  });
  afterAll(async () => {
    setRuntimeFactory(null);
    if (fx) await fx.teardown();
  });

  async function collectionId(siteId: string, name: string) {
    const [row] = await fixtures
      .select({ id: collections.id })
      .from(collections)
      .where(and(eq(collections.siteId, siteId), eq(collections.name, name)));
    return row!.id;
  }
  async function make(title: string, extra: Partial<typeof items.$inferInsert> = {}) {
    const [row] = await fixtures
      .insert(items)
      .values({ siteId: fx.sites.a, collectionId: articles, status: 'published', data: { title }, ...extra })
      .returning({ id: items.id });
    return row!.id;
  }
  const call = async (query: string, headers: Record<string, string>) => app.request(`/api/v1/review-queue${query}`, { headers }, env);
  const editor = async (site: 'a' | 'b' = 'a') => fx.headers(site, await fx.session(site === 'a' ? 'onlyA' : 'onlyB', site));
  const queue = async (query = '') => {
    const res = await call(query, await editor());
    expect(res.status, await res.clone().text()).toBe(200);
    return ((await res.json()) as { data: Queue }).data;
  };

  it('groups the site’s manual marks, automatic marks and items awaiting review, with counts', async () => {
    const data = await queue();
    expect(data.counts).toEqual({ manual: 1, auto: 1, awaiting_review: 1 });
    expect(data.items.map((i) => i.group).sort()).toEqual(['auto', 'awaiting_review', 'manual']);
    expect(data.truncated).toBe(false);
    expect(data.limit).toBe(50);

    const manual = data.items.find((i) => i.group === 'manual')!;
    expect(manual).toMatchObject({
      collection: SHARED.collection,
      title: 'Manual piece',
      reason: 'Prices changed',
      group: 'manual',
    });
    expect(manual.dueAt).toBe('2026-12-01T00:00:00.000Z');
    expect(Number.isNaN(Date.parse(manual.updatedAt))).toBe(false);

    const auto = data.items.find((i) => i.group === 'auto')!;
    expect(auto.reason).toBe(AUTO_STALE_REASON);
    expect(auto.dueAt).toBeNull();

    const review = data.items.find((i) => i.group === 'awaiting_review')!;
    expect(review.reason).toBeNull();
    expect(review.title).toBe('Review piece');

    // Deleted rows, unmarked rows, unreadable collections and other sites are not in the queue.
    const titles = data.items.map((i) => i.title);
    expect(titles).not.toContain('Deleted marked piece');
    expect(titles).not.toContain('Unmarked piece');
    expect(titles).not.toContain('Locked piece');
    expect(titles).not.toContain('Hidden piece');
    expect(titles).not.toContain('Site B piece');
  });

  it('filters by collection and refuses an unknown one', async () => {
    expect((await queue(`?collection=${SHARED.collection}`)).counts).toEqual({ manual: 1, auto: 1, awaiting_review: 1 });
    const missing = await call('?collection=nope', await editor());
    expect(missing.status).toBe(404);
  });

  it('caps the page and says when it truncated; counts cover the page', async () => {
    const data = await queue('?limit=1');
    expect(data.items).toHaveLength(1);
    expect(data.truncated).toBe(true);
    expect(data.limit).toBe(1);
    expect(Object.values(data.counts).reduce((a, b) => a + b, 0)).toBe(1);

    // Over the maximum is clamped rather than refused.
    expect((await queue('?limit=500')).limit).toBe(200);
    for (const bad of ['0', '-1', 'abc']) {
      expect((await call(`?limit=${bad}`, await editor())).status).toBe(400);
    }
  });

  it('is site-scoped and readable by a read-only principal, and needs a session', async () => {
    const b = await call('', await editor('b'));
    expect(b.status).toBe(200);
    const otherSite = ((await b.json()) as { data: Queue }).data;
    expect(otherSite.counts).toEqual({ manual: 1, auto: 0, awaiting_review: 0 });
    expect(otherSite.items.map((i) => i.title)).toEqual(['Site B piece']);

    const reader = await call('', fx.headers('a', fx.apiKeys.aReader.token));
    expect(reader.status).toBe(200);
    expect(((await reader.json()) as { data: Queue }).data.counts.manual).toBe(1);

    expect((await call('', { 'x-heopress-site': fx.sites.a })).status).toBe(401);
  });
});
