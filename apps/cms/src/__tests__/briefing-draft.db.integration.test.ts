/**
 * `POST /api/v1/studio/overview/briefing/draft` (HeoPress v1.1 backlog P12; spec studio/briefing-draft): one call turns
 * the current site's briefing into an editable draft item — through the normal item write path, with its audit — and a
 * second call the same day returns that item instead of making a duplicate.
 *
 * Test data goes through the owner's fixture connection; the route runs as the application role (ADR-0023), so the
 * suite also proves the site scope and the permission context of the real request.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditLog, cdcChangeEvents, collections, items, type Database } from '@heopress/database';
import { createRuntime } from '@heopress/runtime/node';
import app from '../index';
import { setRuntimeFactory } from '../middleware/runtime';
import { __resetPermissionProcessCacheForTests } from '../services/permission-service';
import { connectDbFixtures, connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { createCrossSiteFixture, type CrossSiteFixture } from './helpers/cross-site-fixture';

const JWT_SECRET = 'briefing-draft-secret';
const DRAFT_EVENT = 'studio_briefing_draft_created';

describe.skipIf(!hasDbIntegrationUrl)('briefing draft', () => {
  let fixtures: Database;
  let fx: CrossSiteFixture;
  let env: Record<string, unknown> = {};

  beforeAll(async () => {
    await connectDbIntegration('briefing-draft');
    fixtures = await connectDbFixtures('briefing-draft');
    env = { ...process.env, JWT_SECRET, HEOPRESS_ENV: 'development' };
    const runtime = createRuntime(env);
    setRuntimeFactory(() => runtime);
  });
  beforeEach(async () => {
    fx = await createCrossSiteFixture(fixtures, { prefix: 'briefdraft', jwtSecret: JWT_SECRET });
    // Bundles compiled by an earlier test stay in the process cache under the same key.
    __resetPermissionProcessCacheForTests();
  });
  afterAll(async () => {
    setRuntimeFactory(null);
    if (fx) await fx.teardown();
  });

  const site = () => fx.sites.a;
  const today = () => new Date().toISOString().slice(0, 10);

  async function collection(name: string, siteId = site()) {
    const [row] = await fixtures.insert(collections).values({ siteId, name, label: name }).returning({ id: collections.id });
    return row!.id;
  }
  async function articles(siteId = site()) {
    const [row] = await fixtures
      .select({ id: collections.id })
      .from(collections)
      .where(and(eq(collections.siteId, siteId), eq(collections.name, 'articles')));
    return row!.id;
  }
  async function item(collectionId: string, title: string, extra: Partial<typeof items.$inferInsert> = {}) {
    return (
      await fixtures
        .insert(items)
        .values({ siteId: site(), collectionId, status: 'draft', data: { title }, ...extra })
        .returning({ id: items.id })
    )[0]!.id;
  }
  const draft = async (who: 'onlyA' | 'both', targetSite: 'a' | 'b', body: Record<string, unknown>) =>
    app.request(
      '/api/v1/studio/overview/briefing/draft',
      {
        method: 'POST',
        headers: { ...fx.headers(targetSite, await fx.session(who, targetSite)), 'x-heopress-client': 'studio' },
        body: JSON.stringify(body),
      },
      env,
    );

  const creationAudits = async (siteId = site()) =>
    fixtures
      .select({ id: auditLog.id, metadata: auditLog.metadata })
      .from(auditLog)
      .where(and(eq(auditLog.siteId, siteId), eq(auditLog.event, DRAFT_EVENT)));

  it('creates one draft whose body summarises the briefing of the day', async () => {
    const articlesId = await articles();
    const now = Date.now();
    await item(articlesId, 'Published today A', { status: 'published', publishedAt: new Date(now - 3_600_000), updatedAt: new Date(now - 3_600_000) });
    await item(articlesId, 'Published today B', { status: 'published', publishedAt: new Date(now - 7_200_000), updatedAt: new Date(now - 7_200_000) });
    await item(articlesId, 'Hostile <script>alert(1)</script>', { status: 'published', publishedAt: new Date(now - 5_400_000), updatedAt: new Date(now - 5_400_000) });
    await item(articlesId, 'Published yesterday', { status: 'published', publishedAt: new Date(now - 2 * 86_400_000), updatedAt: new Date(now - 2 * 86_400_000) });
    await item(articlesId, 'An untouched draft', { updatedAt: new Date(now - 5 * 86_400_000) });
    // A collection the editor cannot read: neither its title nor its number may reach the summary.
    const secret = await collection('secret');
    await item(secret, 'Secret published today', { status: 'published', publishedAt: new Date(now - 1_800_000), updatedAt: new Date(now - 1_800_000) });

    const res = await draft('onlyA', 'a', {});
    expect(res.status, await res.clone().text()).toBe(201);
    const body = (await res.json()) as { data: { id: string; data: Record<string, unknown> }; created: boolean };
    expect(body.created).toBe(true);
    expect(body.data.data.title).toBe(`${today()} 站点简报`);
    expect(body.data.data.briefingDraftKey).toBe(`${today()}:day`);
    expect(body.data.data.briefingDraftPeriod).toBe('day');
    const html = String(body.data.data.body);
    expect(html).toContain(`<h2>${today()} 站点简报</h2>`);
    expect(html).toContain('今日发布');
    expect(html).toContain('共 3 篇');
    expect(html).toContain('Published today A');
    expect(html).toContain('Published today B');
    // A title is data, not markup: every value from an item is escaped.
    expect(html).toContain('Hostile &lt;script&gt;alert(1)&lt;/script&gt;');
    // Yesterday's publish belongs to the recent-changes section, not to today's.
    const todaySection = html.slice(html.indexOf('<h3>今日发布</h3>'), html.indexOf('<h3>需要处理</h3>'));
    expect(todaySection).not.toContain('Published yesterday');
    expect(html).toContain('放置超过 3 天的草稿');
    expect(html).toContain('An untouched draft');
    expect(html).toContain('最近 7 天变化');
    expect(html).not.toContain('Secret published today');
    // Plain HTML, site-relative links only: no script, no off-site URL.
    expect(html).not.toContain('<script');
    expect(html).not.toContain('http://');
    expect(html).not.toContain('https://');

    // The write went through the item service: a Change Feed event and one audit row for the creation.
    const events = await fixtures.select().from(cdcChangeEvents).where(and(eq(cdcChangeEvents.siteId, site()), eq(cdcChangeEvents.itemId, body.data.id)));
    expect(events.filter((e) => e.operation === 'create')).toHaveLength(1);
    expect(await creationAudits()).toHaveLength(1);

    // A second call the same day returns the same item and writes neither another item nor another audit row.
    const again = await draft('onlyA', 'a', {});
    expect(again.status).toBe(200);
    const reused = (await again.json()) as { data: { id: string }; created: boolean };
    expect(reused.created).toBe(false);
    expect(reused.data.id).toBe(body.data.id);
    const drafts = (await fixtures.select({ id: items.id, data: items.data }).from(items).where(eq(items.siteId, site()))).filter(
      (row) => (row.data as Record<string, unknown>).briefingDraftKey === `${today()}:day`,
    );
    expect(drafts).toHaveLength(1);
    expect(await creationAudits()).toHaveLength(1);
  });

  it('another period is another draft: the day and the week do not overwrite each other', async () => {
    const first = await draft('onlyA', 'a', {});
    expect(first.status).toBe(201);
    const day = (await first.json()) as { data: { id: string; data: Record<string, unknown> } };
    const week = await draft('onlyA', 'a', { period: 'week' });
    expect(week.status).toBe(201);
    const weekly = (await week.json()) as { data: { id: string; data: Record<string, unknown> }; created: boolean };
    expect(weekly.created).toBe(true);
    expect(weekly.data.id).not.toBe(day.data.id);
    expect(weekly.data.data.title).toBe(`${today()} 站点周报`);
    expect(weekly.data.data.briefingDraftKey).toBe(`${today()}:week`);
    // A week call again is idempotent on its own key.
    const again = await draft('onlyA', 'a', { period: 'week' });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { data: { id: string } }).data.id).toBe(weekly.data.id);
  });

  it('a caller without create on the collection gets 403 and writes nothing', async () => {
    // On site B the fixture's `both` is a reader: read, but no create.
    const res = await draft('both', 'b', {});
    expect(res.status, await res.clone().text()).toBe(403);
    const body = (await res.json()) as { errors: Array<{ code: string }> };
    expect(body.errors[0]!.code).toBe('FORBIDDEN');
    expect(await creationAudits(fx.sites.b)).toHaveLength(0);
  });

  it('an unknown collection is 404, before any permission decision', async () => {
    const res = await draft('onlyA', 'a', { collection: 'no-such-collection' });
    expect(res.status, await res.clone().text()).toBe(404);
    const body = (await res.json()) as { errors: Array<{ code: string }> };
    expect(body.errors[0]!.code).toBe('NOT_FOUND');
    expect(await creationAudits()).toHaveLength(0);
  });

  it('a malformed body is 400', async () => {
    const res = await draft('onlyA', 'a', { period: 'year' });
    expect(res.status).toBe(400);
    expect(await creationAudits()).toHaveLength(0);
  });
});
