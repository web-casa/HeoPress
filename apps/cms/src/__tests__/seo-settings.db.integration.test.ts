import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { ensureRenderRole, publicSites, siteRenderVersions, type Database } from '@heopress/database';
import { defaultSeoSettings } from '@heopress/contracts/schemas';
import { createRuntime } from '@heopress/runtime/node';
import { renderPort } from '@heopress/site-classic/read-port';
import app from '../index';
import { setRuntimeFactory } from '../middleware/runtime';
import { rebuildSiteProjection } from '../services/site-network/public-projection';
import { SeoSettingsService } from '../services/site-network/seo-settings-service';
import { ContentSettingsService } from '../services/site-network/content-settings-service';
import { RetryExhaustedError } from '../services/rls-transaction';
import { upgradeSitePreset } from '../services/site-network/preset-installer';
import { connectDbIntegration, dbIntegrationUrl, hasDbIntegrationUrl } from './helpers/db-harness';
import { createCrossSiteFixture, type CrossSiteFixture } from './helpers/cross-site-fixture';

/**
 * A site's SEO / GEO settings and their public snapshot (HeoPress P07 task 1.4): read with defaults and a
 * version, changed against that version by the site's administrators; each change passes the projection gate
 * — the snapshot the rendering service reads and the site's render version change in the same transaction,
 * the other site's do not — and the rendering role can read the snapshot but never the settings table.
 */

const JWT_SECRET = 'seo-settings-secret';
const OWNER_URL = process.env.DATABASE_OWNER_URL?.trim() || undefined;
const RENDER_ROLE = 'heopress_render_seo_it';

describe.skipIf(!hasDbIntegrationUrl)('SEO settings — DB integration', () => {
  let db: Database;
  let fx: CrossSiteFixture;
  let env: Record<string, unknown> = {};
  let owner: postgres.Sql;
  let render: postgres.Sql;

  beforeAll(async () => {
    expect(OWNER_URL, 'DATABASE_OWNER_URL is required to provision the rendering role').toBeDefined();
    db = await connectDbIntegration('seo-settings');
    env = { ...process.env, JWT_SECRET, HEOPRESS_ENV: 'development' };
    const runtime = createRuntime(env);
    setRuntimeFactory(() => runtime);
    owner = postgres(OWNER_URL!, { max: 1, onnotice: () => {} });
    const password = randomBytes(18).toString('hex');
    await owner.begin((tx) => ensureRenderRole(tx, { role: RENDER_ROLE, password }));
    const url = new URL(dbIntegrationUrl!);
    url.username = RENDER_ROLE;
    url.password = password;
    render = postgres(url.toString(), { max: 1, onnotice: () => {} });
  });
  beforeEach(async () => {
    fx = await createCrossSiteFixture(db, { prefix: 'seos', jwtSecret: JWT_SECRET });
    for (const id of [fx.sites.a, fx.sites.b]) {
      await upgradeSitePreset(db, id);
      await rebuildSiteProjection(db, id);
    }
  });
  afterAll(async () => {
    setRuntimeFactory(null);
    if (fx) await fx.teardown();
    await render?.end({ timeout: 1 });
    await owner?.end({ timeout: 1 });
  });

  const call = (path: string, method: string, headers: Record<string, string>, body?: unknown) =>
    app.request(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env);
  const renderVersion = async (siteId: string) =>
    (await db.select({ v: siteRenderVersions.version }).from(siteRenderVersions).where(eq(siteRenderVersions.siteId, siteId)))[0]?.v ?? 0;
  const snapshot = async (siteId: string) => (await db.select({ seo: publicSites.seo }).from(publicSites).where(eq(publicSites.siteId, siteId)))[0]?.seo;
  const codeOf = async (res: Response) => ((await res.json()) as { errors: Array<{ code: string }> }).errors[0]!.code;

  it('reads with defaults and version 0; an administrator changes it against the version read; stale and invalid forms are refused', async () => {
    const admin = fx.headers('a', await fx.session('adminA', 'a'));
    const read = (await (await call('/api/v1/site/seo-settings', 'GET', admin)).json()) as { data: { settings: Record<string, unknown>; version: number } };
    expect(read.data.version).toBe(0);
    expect(read.data.settings).toMatchObject({ titleTemplate: '', snippet: { maxImagePreview: 'large' }, index: { site: true } });
    const changed = await call('/api/v1/site/seo-settings', 'PUT', admin, { version: 0, titleTemplate: '{title} | {site}', snippet: { maxImagePreview: 'standard' } });
    expect(changed.status, await changed.clone().text()).toBe(200);
    expect(((await changed.json()) as { data: { version: number } }).data.version).toBe(1);
    // Read at version 0 again: stale.
    const stale = await call('/api/v1/site/seo-settings', 'PUT', admin, { version: 0, titleTemplate: 'x' });
    expect(stale.status).toBe(409);
    expect(await codeOf(stale)).toBe('VERSION_CONFLICT');
    const unknownNested = ['index', 'snippet', 'crawlers', 'discovery'].map((section) => ({ version: 1, [section]: { unknownSetting: true } }));
    for (const bad of [
      { titleTemplate: 'x' },
      { version: -1 },
      { version: 1, snippet: { maxImagePreview: 'huge' } },
      { version: 1, unknownSetting: true },
      ...unknownNested,
      { version: 1, crawlers: { overrides: { 'Bad Name': 'allow' } } },
    ]) {
      const res = await call('/api/v1/site/seo-settings', 'PUT', admin, bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    // The search results page set to be indexed (spec seo/page-metadata "搜索结果页设为收录"): told it is the system's limit.
    const search = await call('/api/v1/site/seo-settings', 'PUT', admin, { version: 1, index: { pageTypes: { search: true } } });
    expect(search.status).toBe(400);
    const searchError = ((await search.json()) as { errors: Array<{ code: string; message: string; details?: unknown }> }).errors[0]!;
    expect(searchError).toMatchObject({ code: 'SYSTEM_LIMIT', details: { pageTypes: ['search'] } });
    expect(searchError.message).toMatch(/system limit/);
    expect(((await (await call('/api/v1/site/seo-settings', 'GET', admin)).json()) as { data: { version: number } }).data.version).toBe(1);
    // Not an administrator of the site: refused; another site's administrator: refused.
    expect((await call('/api/v1/site/seo-settings', 'PUT', fx.headers('a', await fx.session('onlyA', 'a')), { version: 1 })).status).toBe(403);
    expect((await call('/api/v1/site/seo-settings', 'PUT', fx.headers('a', await fx.session('adminB', 'b')), { version: 1 })).status).toBeGreaterThanOrEqual(401);
  });

  it('a write that kept having to start over is a 409 RETRY_EXHAUSTED to the client, never a 500 (SEO and content settings routes)', async () => {
    const admin = fx.headers('a', await fx.session('adminA', 'a'));
    const seoSpy = vi.spyOn(SeoSettingsService.prototype, 'update').mockRejectedValueOnce(new RetryExhaustedError());
    const contentSpy = vi.spyOn(ContentSettingsService.prototype, 'update').mockRejectedValueOnce(new RetryExhaustedError());
    try {
      // A valid form of each (the routes validate before the service runs).
      const current = ((await (await call('/api/v1/site/content-settings', 'GET', admin)).json()) as { data: Record<string, unknown> }).data;
      const { siteId: _s, updatedAt: _u, ...form } = current;
      for (const [path, body] of [
        ['/api/v1/site/seo-settings', { version: 0 }],
        ['/api/v1/site/content-settings', form],
      ] as const) {
        const res = await call(path, 'PUT', admin, body);
        expect(res.status, path).toBe(409);
        expect(await codeOf(res), path).toBe('RETRY_EXHAUSTED');
      }
    } finally {
      seoSpy.mockRestore();
      contentSpy.mockRestore();
    }
  });

  it('concurrent first updates: one wins, the others get the 409 (no row to lock yet)', async () => {
    const attempt = (n: number) => new SeoSettingsService({ db, siteId: fx.sites.a, actor: { userId: null } }).update({ version: 0, titleTemplate: `{title} ${n}` });
    const results = await Promise.allSettled([1, 2, 3, 4].map(attempt));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')) {
      expect((r.reason as { code?: string }).code, String(r.reason)).toBe('VERSION_CONFLICT');
    }
    expect((await new SeoSettingsService({ db, siteId: fx.sites.a, actor: { userId: null } }).get()).version).toBe(1);
  });

  it('a change passes the projection gate: the snapshot and render version of that site move with it, not the other site\'s', async () => {
    const service = new SeoSettingsService({ db, siteId: fx.sites.a, actor: { userId: null } });
    const before = { a: await renderVersion(fx.sites.a), b: await renderVersion(fx.sites.b), bSnapshot: await snapshot(fx.sites.b) };
    await service.update({ version: 0, discovery: { newsSitemap: true, newsPublicationName: 'Alpha News' }, index: { collections: { tags: false } } });
    expect(await renderVersion(fx.sites.a)).toBeGreaterThan(before.a);
    expect(await snapshot(fx.sites.a)).toMatchObject({ discovery: { newsSitemap: true, newsPublicationName: 'Alpha News' }, index: { collections: { tags: false } } });
    expect(await renderVersion(fx.sites.b)).toBe(before.b);
    expect(await snapshot(fx.sites.b)).toEqual(before.bSnapshot);
    // A rebuild produces the same snapshot (the projection is the only writer).
    await rebuildSiteProjection(db, fx.sites.a);
    expect(await snapshot(fx.sites.a)).toMatchObject({ discovery: { newsSitemap: true } });
  });

  it('a snapshot from before P07 (empty, no rebuild since) reads as the defaults; a stored change still wins', async () => {
    await owner`UPDATE lumibase_public_sites SET seo = '{}'::jsonb WHERE site_id IN (${fx.sites.a}, ${fx.sites.b})`;
    const seoOf = (siteId: string) => renderPort(db).request(siteId, async (_port, reads) => (await reads.site())?.seo);
    expect(await seoOf(fx.sites.b)).toEqual(defaultSeoSettings());
    await new SeoSettingsService({ db, siteId: fx.sites.a, actor: { userId: null } }).update({ version: 0, snippet: { maxImagePreview: 'none' } });
    expect(await seoOf(fx.sites.a)).toMatchObject({ snippet: { maxImagePreview: 'none' }, index: { site: true } });
  });

  it('the rendering role reads the snapshot of the site in scope, never the settings table', async () => {
    await new SeoSettingsService({ db, siteId: fx.sites.a, actor: { userId: null } }).update({ version: 0, titleTemplate: '{title} — A' });
    const rows = await render.begin(async (tx) => {
      await tx`SELECT set_config('app.site_id', ${fx.sites.a}, true)`;
      return tx`SELECT seo FROM lumibase_public_sites WHERE site_id = ${fx.sites.a}`;
    });
    expect(rows[0]?.seo).toMatchObject({ titleTemplate: '{title} — A' });
    const raw = await render`SELECT settings FROM lumibase_site_seo_settings`.catch((e: { code?: string }) => e.code);
    expect(raw).toBe('42501');
  });
});
