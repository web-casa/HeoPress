import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { collections, ensureRenderRole, schema, scopedDatabase, siteContentSettings, siteDomains, sites, type Database } from '@heopress/database';
import { createSiteClassic, type SiteClassic } from '@heopress/site-classic';
import { exportPageData, servePageData } from '@heopress/site-classic/page-data';
import { buildSiteGeneration, pageFile } from '@heopress/site-astro';
import type { PageDataSnapshot } from '@heopress/contracts/page-data';
import { ExtensionSandbox } from '../extensions/sandbox';
import { ExtensionsService } from '../services/extensions-service';
import { ExtensionVerifierService } from '../services/extension-verifier';
import { ItemService } from '../services/item-service';
import { PermissionService } from '../services/permission-service';
import { ContentSettingsService } from '../services/site-network/content-settings-service';
import { SeoSettingsService } from '../services/site-network/seo-settings-service';
import { upgradeSitePreset } from '../services/site-network/preset-installer';
import { rebuildSiteProjection } from '../services/site-network/public-projection';
import { dbFixturesUrl, connectDbFixtures, connectDbIntegration, dbIntegrationUrl, hasDbIntegrationUrl } from './helpers/db-harness';

/**
 * The official daily-briefing plugin's public half (HeoPress v1.1 P12; spec extensions/briefing-route,
 * rendering/public-feeds): the plugin's own `briefings` collection, the `/briefing` list and `/briefing/:slug` item
 * routes rendered by Classic and built by Astro, and the collection feed. The page-data snapshot is the projection:
 * it must contain the feed, the published briefing must be in it, and an unpublished or noindex briefing must not.
 *
 * Needs DATABASE_OWNER_URL (to provision this suite's rendering role, as a deployment does).
 */

const RENDER_ROLE = 'heopress_render_briefing';
const OWNER_URL = dbFixturesUrl();
const NOW = Date.parse('2026-11-10T12:00:00Z');
const A = 'site_p12_briefing_a';
const HOST = 'briefing.example.com';
const ORIGIN = `https://${HOST}`;
const PLUGIN = 'heopress-briefing-daily';
const BRIEFINGS = 'heopress_briefing_daily__briefings';
const PERMALINKS = { articles: '/:slug', pages: '/:slug', categories: '/category/:slug', tags: '/tag/:slug', authors: '/author/:slug' };

describe.skipIf(!hasDbIntegrationUrl)('The official briefing plugin — public pages and feed (P12)', () => {
  let db: Database;
  let fixtures: Database;
  let owner: postgres.Sql;
  let renderClient: postgres.Sql;
  let renderDb: Database;
  let classic: SiteClassic;
  let root: string;
  let generation = 0;
  let manifest: Record<string, unknown>;

  const ctx = (siteId: string) => ({ siteId, userId: null, roleId: null, user: null, ip: null, headers: {}, apiKey: null }) as never;
  const siteDb = (siteId: string) => scopedDatabase(db, { site: siteId });
  const service = () => new ExtensionsService({ db: siteDb(A), siteId: A, permissionCtx: ctx(A) });
  const items = () => new ItemService({ db: siteDb(A), siteId: A });
  const seo = () => new SeoSettingsService({ db: siteDb(A), siteId: A, actor: { userId: null } });
  const get = async (path: string) => {
    const res = await classic.app.request(path, { headers: { host: HOST } });
    return { status: res.status, body: await res.text(), contentType: res.headers.get('content-type') };
  };
  const headOf = (html: string) => /<head>([\s\S]*?)<\/head>/.exec(html)?.[1] ?? '';

  async function build(): Promise<{ live: string; snapshot: PageDataSnapshot }> {
    const snapshot = await exportPageData({ db: renderDb, siteId: A, now: () => NOW });
    const out = await buildSiteGeneration({ root, generation: ++generation, theme: 'official:starter', snapshot, serve: servePageData });
    expect(out.ok, out.ok ? '' : out.error).toBe(true);
    return { live: out.ok ? out.outDir : '', snapshot };
  }

  beforeAll(async () => {
    expect(OWNER_URL, 'DATABASE_OWNER_URL is required to provision the rendering role').toBeDefined();
    db = await connectDbIntegration('briefing-route-feed');
    fixtures = await connectDbFixtures('briefing-route-feed');
    owner = postgres(OWNER_URL!, { max: 1, onnotice: () => {} });
    const password = randomBytes(18).toString('hex');
    await owner.begin((tx) => ensureRenderRole(tx, { role: RENDER_ROLE, password }));
    const url = new URL(dbIntegrationUrl!);
    url.username = RENDER_ROLE;
    url.password = password;
    renderClient = postgres(url.toString(), { max: 2, onnotice: () => {} });
    renderDb = drizzle(renderClient, { schema }) as unknown as Database;
    classic = createSiteClassic({ db: renderDb, now: () => NOW, traffic: false, sweepIntervalMs: 0 });
    root = await mkdtemp(join(tmpdir(), 'heopress-p12-briefing-'));

    await fixtures.delete(sites).where(eq(sites.id, A));
    await fixtures.insert(sites).values({ id: A, name: 'Briefing Site', defaultLanguage: 'en' });
    await upgradeSitePreset(db, A);
    await fixtures.insert(siteDomains).values({ siteId: A, hostname: HOST, kind: 'custom', status: 'active', isPrimary: true, verifiedAt: new Date('2026-09-01T00:00:00Z') });
    const [r] = await fixtures.select().from(siteContentSettings).where(eq(siteContentSettings.siteId, A));
    await new ContentSettingsService({ db: siteDb(A), siteId: A, actor: { userId: null } }).update({
      availableLocales: ['en'], timezone: 'UTC', siteType: 'blog', trailingSlash: 'always', localeStrategy: 'subdirectory',
      localePrefixMode: 'default_at_root', localePrefixes: {}, permalinks: PERMALINKS, allowCrossSiteTranslations: false,
      sponsorDisclosure: true, sponsorRel: true, version: r!.version,
    } as never);
    await rebuildSiteProjection(db, A);

    // Admin, official signature verified: this suite checks the plugin's declarations and public output, not the gates.
    vi.spyOn(PermissionService.prototype, 'canAccess').mockImplementation(async (collection, action) => ({ collection, action, rule: null, fields: ['*'], presets: {}, validation: {}, sources: [] }) as never);
    vi.spyOn(ExtensionVerifierService.prototype, 'verifyByMetadata').mockResolvedValue({ ok: true, isOfficial: true, reason: 'ok' } as never);
    vi.spyOn(ExtensionSandbox.prototype as unknown as { isTrustedBundleUrl(u: string): boolean }, 'isTrustedBundleUrl').mockReturnValue(true);

    manifest = JSON.parse(await readFile(new URL('../../../../examples/plugin-briefing-daily/heopress-extension.json', import.meta.url), 'utf8')) as Record<string, unknown>;
  }, 180_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await db?.delete(sites).where(eq(sites.id, A));
    await classic?.close();
    await renderClient?.end({ timeout: 2 });
    await owner?.end({ timeout: 2 });
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('installs its own briefings collection and the two public routes', async () => {
    const { name, version, type, entry: _entry, capabilities, ...declarations } = manifest as { name: string; version: string; type: string; entry: string; capabilities: string[] } & Record<string, unknown>;
    const installed = await service().installExtension({
      name,
      version,
      type,
      enabled: true,
      bundleUrl: 'https://example.com/briefing.js',
      capabilities,
      approvedCapabilities: capabilities,
      manifest: declarations,
    } as never);
    expect(installed).toMatchObject({ enabled: true, isOfficial: true, permissionsStatus: 'approved' });
    const [coll] = await fixtures.select().from(collections).where(and(eq(collections.siteId, A), eq(collections.name, BRIEFINGS)));
    expect(coll?.meta).toMatchObject({ extension: { name: PLUGIN, namespace: 'heopress_briefing_daily', collection: 'briefings' } });
    // A page at the list route exists before any item does.
    expect((await get('/briefing/')).status).toBe(200);
  });

  it('publishes a briefing page: the list and the item render with the plugin templates', async () => {
    const published = (await items().create(BRIEFINGS, {
      data: { title: 'Daily briefing 2026-11-10', slug: '2026-11-10', locale: 'en', excerpt: 'What happened today.', body: '<p>PUBLISHED-BRIEFING-BODY</p>', briefing_date: '2026-11-10', period: 'daily' },
      status: 'published',
      publishedAt: new Date('2026-11-10T09:00:00.000Z'),
    })) as { id: string };
    // A draft and a noindex briefing: neither may reach the feed.
    await items().create(BRIEFINGS, {
      data: { title: 'DRAFT-BRIEFING', slug: '2026-11-11', locale: 'en', body: '<p>Draft body.</p>' },
      status: 'draft',
    });
    await items().create(BRIEFINGS, {
      data: { title: 'NOINDEX-BRIEFING', slug: '2026-11-09', locale: 'en', body: '<p>Hidden body.</p>', seo_robots: 'noindex,follow' },
      status: 'published',
      publishedAt: new Date('2026-11-09T09:00:00.000Z'),
    });
    // An article, so the default site feed has something that is not a briefing.
    await items().create('articles', { data: { title: 'An article', slug: 'an-article', locale: 'en', body: '<p>Article body.</p>' }, status: 'published', publishedAt: new Date('2026-11-10T08:00:00.000Z') });

    const item = await get('/briefing/2026-11-10/');
    expect(item.status).toBe(200);
    expect(item.body).toContain('class="heopress-briefing heopress-briefing-item"');
    expect(item.body).toContain('PUBLISHED-BRIEFING-BODY');
    expect(item.body).toContain('2026-11-10');
    expect(headOf(item.body)).toContain(`<link rel="canonical" href="${ORIGIN}/briefing/2026-11-10/">`);
    expect(headOf(item.body)).toContain('Daily briefing 2026-11-10');

    const list = await get('/briefing/');
    expect(list.status).toBe(200);
    expect(list.body).toContain('class="heopress-briefing heopress-briefing-index"');
    expect(list.body).toContain('Daily briefing 2026-11-10');
    expect(list.body).not.toContain('DRAFT-BRIEFING');
    expect((await get('/briefing/2026-11-11/')).status).toBe(404);
    expect((await get('/feed/briefings.xml')).status).toBe(200);
  });

  it('the projection contains the feed: published in, draft and noindex out; Astro writes the same bytes', async () => {
    const { live, snapshot } = await build();
    const paths = snapshot.files.map((f) => f.path);
    expect(paths).toEqual(expect.arrayContaining(['/feed.xml', '/feed/briefings.xml', '/atom/briefings.xml', '/feed/pages.xml']));
    expect(snapshot.pages.map((p) => p.path)).toEqual(expect.arrayContaining(['/briefing/', '/briefing/2026-11-10/']));
    const feed = snapshot.files.find((f) => f.path === '/feed/briefings.xml')!;
    expect(feed.contentType).toBe('application/rss+xml; charset=utf-8');
    expect(feed.body).toContain(`${ORIGIN}/briefing/2026-11-10/`);
    expect(feed.body).toContain('Daily briefing 2026-11-10');
    expect(feed.body).not.toContain('DRAFT-BRIEFING');
    expect(feed.body).not.toContain('NOINDEX-BRIEFING');
    // The item page is in the sitemap, the noindex one is not.
    const sitemap = (await get('/sitemap-1.xml')).body;
    expect(sitemap).toContain(`${ORIGIN}/briefing/2026-11-10/`);
    expect(sitemap).not.toContain(`${ORIGIN}/briefing/2026-11-09/`);
    // The static build writes the Classic engine's bytes.
    expect(await readFile(join(live, '/feed/briefings.xml'), 'utf8')).toBe((await get('/feed/briefings.xml')).body);
    expect(await readFile(pageFile(live, '/briefing/2026-11-10/'), 'utf8')).toContain('PUBLISHED-BRIEFING-BODY');
  }, 240_000);

  it('the site feed follows discovery.feedCollection, and feeds off removes both from the projection', async () => {
    const before = await seo().get();
    await seo().update({ version: before.version, discovery: { ...before.settings.discovery, feedCollection: BRIEFINGS } });
    const siteFeed = await get('/feed.xml');
    expect(siteFeed.body).toContain(`${ORIGIN}/briefing/2026-11-10/`);
    expect(siteFeed.body).not.toContain(`${ORIGIN}/an-article/`);
    // The site feed's collection has one address: the collection feed is not repeated.
    expect((await get('/feed/briefings.xml')).status).toBe(404);

    const current = await seo().get();
    await seo().update({ version: current.version, discovery: { ...current.settings.discovery, feeds: false } });
    expect((await get('/feed.xml')).status).toBe(404);
    expect((await get('/atom.xml')).status).toBe(404);
    const { snapshot } = await build();
    expect(snapshot.files.map((f) => f.path)).not.toEqual(expect.arrayContaining(['/feed.xml']));
    expect(snapshot.files.map((f) => f.path)).not.toEqual(expect.arrayContaining(['/feed/briefings.xml']));
  }, 240_000);
});
