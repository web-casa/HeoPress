import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { collections, type Database } from '@heopress/database';
import { createRuntime } from '@heopress/runtime/node';
import app from '../index';
import { setRuntimeFactory } from '../middleware/runtime';
import { isArticleCollection } from '../services/studio/article-collections';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { createCrossSiteFixture, SHARED, type CrossSiteFixture } from './helpers/cross-site-fixture';

/** `PUT /collections/:name/studio-kind` (HeoPress P07a task 6.1): only `meta.studio.kind` changes; administrators only. */

const JWT_SECRET = 'studio-kind-secret';
const META = {
  preset: { name: 'site-network', version: 2, key: 'articles' },
  sharedFields: ['author'],
  systemFields: { status: { hidden: true } },
  systemFieldOverrides: { slug: { required: true } },
  studio: { other: 1 },
};

describe.skipIf(!hasDbIntegrationUrl)('studio kind — HTTP', () => {
  let db: Database;
  let fx: CrossSiteFixture;
  let env: Record<string, unknown> = {};

  beforeAll(async () => {
    db = await connectDbIntegration('studio-kind');
    env = { ...process.env, JWT_SECRET, HEOPRESS_ENV: 'development' };
    const runtime = createRuntime(env);
    setRuntimeFactory(() => runtime);
  });
  beforeEach(async () => {
    fx = await createCrossSiteFixture(db, { prefix: 'stkind', jwtSecret: JWT_SECRET });
    await db.update(collections).set({ meta: META }).where(and(eq(collections.siteId, fx.sites.a), eq(collections.name, SHARED.collection)));
  });
  afterAll(async () => {
    setRuntimeFactory(null);
    if (fx) await fx.teardown();
  });

  const put = async (who: 'adminA' | 'onlyA', kind: string | null) =>
    app.request(`/api/v1/collections/${SHARED.collection}/studio-kind`, { method: 'PUT', headers: fx.headers('a', await fx.session(who, 'a')), body: JSON.stringify({ kind }) }, env);
  const meta = async () => (await db.select({ m: collections.meta }).from(collections).where(and(eq(collections.siteId, fx.sites.a), eq(collections.name, SHARED.collection))))[0]!.m as Record<string, unknown>;

  it('marks and unmarks, keeping every other meta key', async () => {
    expect((await put('adminA', 'article')).status).toBe(200);
    expect(await meta()).toEqual({ ...META, studio: { other: 1, kind: 'article' } });
    expect((await put('adminA', null)).status).toBe(200);
    expect(await meta()).toEqual(META);
  });

  it('a non-administrator is refused and nothing changes; a bad value is a 400', async () => {
    expect((await put('onlyA', 'article')).status).toBe(403);
    expect((await put('adminA', 'page')).status).toBe(400);
    expect(await meta()).toEqual(META);
  });

  it('the article rule: the preset articles collection or the mark; not pages', () => {
    expect(isArticleCollection('articles', { preset: { key: 'articles' } })).toBe(true);
    expect(isArticleCollection('news', { studio: { kind: 'article' } })).toBe(true);
    expect(isArticleCollection('pages', { preset: { key: 'pages' } })).toBe(false);
    expect(isArticleCollection('articles', {})).toBe(false);
  });
});
