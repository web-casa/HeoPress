import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const createHashHex = (text: string) => createHash('sha256').update(text).digest('hex');
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  cdcChangeEvents,
  ensureRenderRole,
  notifications,
  publicItems,
  roles,
  renderCache,
  schema,
  siteContentSettings,
  siteDomains,
  siteRenderVersions,
  sites,
  siteThemes,
  themeAssets,
  themeVersions,
  users,
  userSites,
  type Database,
} from '@heopress/database';
import { BUILTIN_THEME } from '@heopress/public-site';
import { createSiteClassic, type SiteClassic } from '@heopress/site-classic';
import { cachedPage, cacheKey } from '@heopress/site-classic/cache';
import { ItemService } from '../services/item-service';
import { ContentSettingsError, ContentSettingsService } from '../services/site-network/content-settings-service';
import { upgradeSitePreset } from '../services/site-network/preset-installer';
import { rebuildSiteProjection } from '../services/site-network/public-projection';
import { recheckActiveTheme, recheckActiveThemes, ThemeService, ThemeServiceError } from '../services/themes/theme-service';
import { connectDbIntegration, dbIntegrationUrl, hasDbIntegrationUrl } from './helpers/db-harness';

/**
 * Site themes end to end (HeoPress P06 tasks 2.3, 2.4, 2.7; spec rendering/theme-contract): versions
 * uploaded through the theme service, checked before publication, activated (published, switched, rolled
 * back) and served by `site-classic` as the rendering role — with the sponsor disclosure rules between
 * the site's policy and its theme, and immutable versions in the database.
 *
 * Needs DATABASE_OWNER_URL (to provision the rendering role).
 */

const A = 'site_p06_theme_a';
const B = 'site_p06_theme_b';
const HOST_A = 'th-a.example.com';
const HOST_B = 'th-b.example.com';
const RENDER_ROLE = 'heopress_render_it';
const OWNER_URL = process.env.DATABASE_OWNER_URL?.trim() || undefined;

const top = BUILTIN_THEME['partials/top']!;
const bottom = BUILTIN_THEME['partials/bottom']!;
/** The built-in theme with a visible version marker on every page. */
const themeWith = (marker: string, over: Record<string, string> = {}) => ({
  ...BUILTIN_THEME,
  'partials/top': top.replace('<main>', `<main><p class="marker">${marker}</p>`),
  ...over,
});
/** A theme without the disclosure slots (fine while explicit disclosure is off). */
const slotless = (marker: string) =>
  themeWith(marker, {
    item: `{% include 'partials/top' %}<article><h1>{{ item.title }}</h1>{% item_body %}</article>{% include 'partials/bottom' %}`,
    'partials/list': `{% for c in list %}<li>{% card c %}<a href="{{ c.url | url }}">{{ c.title }}</a>{% endcard %}</li>{% endfor %}`,
  });

describe.skipIf(!hasDbIntegrationUrl)('site themes — DB integration', () => {
  let db: Database;
  let owner: postgres.Sql;
  let renderClient: postgres.Sql;
  let service: SiteClassic;
  let renderDb: Database;

  beforeAll(async () => {
    expect(OWNER_URL, 'DATABASE_OWNER_URL is required to provision the rendering role').toBeDefined();
    db = await connectDbIntegration('themes');
    owner = postgres(OWNER_URL!, { max: 1, onnotice: () => {} });
    const password = randomBytes(18).toString('hex');
    await owner.begin((tx) => ensureRenderRole(tx, { role: RENDER_ROLE, password }));
    const url = new URL(dbIntegrationUrl!);
    url.username = RENDER_ROLE;
    url.password = password;
    renderClient = postgres(url.toString(), { max: 2, onnotice: () => {} });
    renderDb = drizzle(renderClient, { schema }) as unknown as Database;
    service = createSiteClassic({ db: renderDb });
  });
  afterAll(async () => {
    await db?.delete(sites).where(inArray(sites.id, [A, B]));
    await service?.close();
    await renderClient?.end({ timeout: 2 });
    await owner?.end({ timeout: 2 });
  });

  beforeEach(async () => {
    await db.delete(sites).where(inArray(sites.id, [A, B]));
    await db.insert(sites).values([
      { id: A, name: 'Theme Alpha', defaultLanguage: 'en' },
      { id: B, name: 'Theme Beta', defaultLanguage: 'en' },
    ]);
    for (const id of [A, B]) await upgradeSitePreset(db, id);
    await db.insert(siteDomains).values([
      { siteId: A, hostname: HOST_A, kind: 'custom', status: 'active', isPrimary: true, verifiedAt: new Date() },
      { siteId: B, hostname: HOST_B, kind: 'custom', status: 'active', isPrimary: true, verifiedAt: new Date() },
    ]);
    for (const id of [A, B]) await settings(id, { permalinks: { articles: '/:slug', pages: '/:slug', categories: '/category/:slug' } });
    for (const id of [A, B]) await rebuildSiteProjection(db, id);
  });

  async function settings(siteId: string, over: Record<string, unknown>) {
    const [r] = await db.select().from(siteContentSettings).where(eq(siteContentSettings.siteId, siteId));
    return new ContentSettingsService({ db, siteId, actor: { userId: null } }).update({
      availableLocales: r!.availableLocales,
      timezone: r!.timezone,
      siteType: 'blog',
      trailingSlash: r!.trailingSlash as 'always',
      localeStrategy: r!.localeStrategy as 'subdirectory',
      localePrefixMode: r!.localePrefixMode as 'default_at_root',
      localePrefixes: r!.localePrefixes,
      permalinks: r!.permalinks,
      allowCrossSiteTranslations: false,
      sponsorDisclosure: r!.sponsorDisclosure,
      sponsorRel: r!.sponsorRel,
      reason: 'test',
      riskAcknowledged: ['disclosure', 'rel'],
      version: r!.version,
      ...over,
    } as never);
  }
  const themesOf = (siteId: string) => new ThemeService({ db, siteId, actor: { userId: null } });
  const items = (siteId: string) => new ItemService({ db, siteId });
  const article = (siteId: string, slug: string, data: Record<string, unknown> = {}) =>
    items(siteId).create('articles', { data: { title: `Title ${slug}`, slug, locale: 'en', ...data }, status: 'published' }) as Promise<{ id: string }>;
  const page = async (host: string, path: string) => {
    const res = await service.app.request(path, { headers: { host } });
    return { status: res.status, html: await res.text(), headers: res.headers };
  };
  const renderVersion = async (siteId: string) => (await db.select({ v: siteRenderVersions.version }).from(siteRenderVersions).where(eq(siteRenderVersions.siteId, siteId)))[0]?.v ?? 0;

  it('spec "回滚" / "不影响其他站点": publish, switch and roll back take effect at once; the other site is untouched', async () => {
    await article(A, 'hello');
    await article(B, 'hello');
    expect((await page(HOST_A, '/hello/')).html).not.toContain('class="marker"');
    // The real content time (P07 task 2.5; spec "只更换主题"): a theme published, switched or rolled back never moves it.
    // Its head, its JSON-LD article node and its sitemap entry say the same time, and keep it.
    const modifiedOf = async () => {
      const html = (await page(HOST_A, '/hello/')).html;
      const meta = /<meta property="article:modified_time" content="([^"]+)">/.exec(html)?.[1];
      const graph = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '{}') as { '@graph'?: Array<Record<string, unknown>> };
      const ld = graph['@graph']?.find((n) => typeof n['@id'] === 'string' && (n['@id'] as string).endsWith('/hello/#article'))?.dateModified;
      const lastmod = new RegExp(`<loc>https://${HOST_A.replace(/\./g, '\\.')}/hello/</loc><lastmod>([^<]+)</lastmod>`).exec((await page(HOST_A, '/sitemap-1.xml')).html)?.[1];
      return meta && ld === meta && lastmod === meta ? meta : `mismatch ${meta} ${String(ld)} ${lastmod}`;
    };
    const modified = await modifiedOf();
    expect(modified).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const v1 = await themesOf(A).createVersion({ name: 'main', templates: themeWith('V1') });
    expect(v1.checks).toMatchObject({ ok: true, disclosureOk: true });
    expect(v1.publishedAt).toBeNull();
    // Uploaded is not active.
    expect((await page(HOST_A, '/hello/')).html).not.toContain('V1');
    const bBefore = await renderVersion(B);
    const aBefore = await renderVersion(A);
    await themesOf(A).activate(v1.id);
    // The pointer moved in the same transaction as the render version (cache keys, task 3.x).
    expect(await renderVersion(A)).toBeGreaterThan(aBefore);
    expect((await page(HOST_A, '/hello/')).html).toContain('<p class="marker">V1</p>');
    const v2 = await themesOf(A).createVersion({ name: 'main', templates: themeWith('V2') });
    expect(v2.number).toBe(2);
    await themesOf(A).activate(v2.id);
    expect((await page(HOST_A, '/hello/')).html).toContain('<p class="marker">V2</p>');
    expect(await modifiedOf()).toBe(modified);
    // Rollback: the earlier version, immediately, no rebuild.
    await themesOf(A).activate(v1.id);
    expect((await page(HOST_A, '/hello/')).html).toContain('<p class="marker">V1</p>');
    expect(await modifiedOf()).toBe(modified);
    // B: built-in theme, render version unchanged by A's theme changes.
    const b = await page(HOST_B, '/hello/');
    expect(b.html).not.toContain('class="marker"');
    expect(await renderVersion(B)).toBe(bBefore);
    const listed = await themesOf(A).list();
    expect(listed.filter((v) => v.active).map((v) => v.id)).toEqual([v1.id]);
  });

  it('task 7.2: two sites on two theme versions, the same path, concurrent requests and a switch mid-way never cross', async () => {
    await article(A, 'same', { title: 'Alpha same' });
    await article(B, 'same', { title: 'Beta same' });
    const a1 = await themesOf(A).createVersion({ name: 'main', templates: themeWith('ALPHA-1') });
    const b1 = await themesOf(B).createVersion({ name: 'main', templates: themeWith('BETA-1') });
    await themesOf(A).activate(a1.id);
    await themesOf(B).activate(b1.id);
    const burst = (n: number, svc = service) =>
      Promise.all(
        Array.from({ length: n }, async (_, i) => {
          const res = await svc.app.request('/same/', { headers: { host: i % 2 ? HOST_A : HOST_B } });
          return { status: res.status, html: await res.text(), cache: res.headers.get('x-cache') };
        }),
      );
    const expectOwn = (results: Array<{ status: number; html: string; cache: string | null }>, alpha: string, beta: string, cache?: string) =>
      results.forEach((r, i) => {
        expect(r.status).toBe(200);
        // Its own content and its own theme, nothing of the other site's.
        expect(r.html).toContain(i % 2 ? 'Alpha same' : 'Beta same');
        expect(r.html).not.toContain(i % 2 ? 'Beta same' : 'Alpha same');
        expect(r.html).toContain(`<p class="marker">${i % 2 ? alpha : beta}</p>`);
        expect(r.html).not.toContain(i % 2 ? 'BETA-' : 'ALPHA-');
        if (cache) expect(r.cache, `request ${i}`).toBe(cache);
      });
    // Concurrent misses; then hits from this process; then from the shared level, in a second process.
    expectOwn(await burst(24), 'ALPHA-1', 'BETA-1');
    expectOwn(await burst(24), 'ALPHA-1', 'BETA-1', 'hit');
    // Level-2 writes happen after the answer: wait until both sites' entries are there.
    for (let i = 0; i < 50 && (await db.select().from(renderCache).where(inArray(renderCache.siteId, [A, B]))).length < 2; i++) await new Promise((r) => setTimeout(r, 20));
    const second = createSiteClassic({ db: renderDb, sweepIntervalMs: 0 });
    try {
      // Sequential: the first of each site is from the shared level, then from the second process's own.
      for (const host of [HOST_B, HOST_A]) {
        const res = await second.app.request('/same/', { headers: { host } });
        expect(res.headers.get('x-cache'), host).toBe('hit-shared');
        expect(await res.text()).toContain(host === HOST_A ? 'Alpha same' : 'Beta same');
      }
      expectOwn(await burst(24, second), 'ALPHA-1', 'BETA-1', 'hit');
    } finally {
      await second.close();
    }
    // A switches while requests are in flight: each answer is one of A's versions, never B's; after the
    // switch has committed every answer is the new one.
    const a2 = await themesOf(A).createVersion({ name: 'main', templates: themeWith('ALPHA-2') });
    const during = burst(24);
    await themesOf(A).activate(a2.id);
    (await during).forEach((r, i) => {
      expect(r.status).toBe(200);
      expect(r.html).toMatch(i % 2 ? /<p class="marker">ALPHA-[12]<\/p>/ : /<p class="marker">BETA-1<\/p>/);
      expect(r.html).toContain(i % 2 ? 'Alpha same' : 'Beta same');
      expect(r.html).not.toContain(i % 2 ? 'Beta same' : 'Alpha same');
    });
    expectOwn(await burst(24), 'ALPHA-2', 'BETA-1');
  });

  it('task 5.1: each starter theme installs as a checked version, activates, and is served with its stylesheet', async () => {
    await article(A, 'starter-post');
    for (const name of ['news', 'tech', 'minimal']) {
      const v = await themesOf(A).installStarter(name);
      expect(v.checks).toMatchObject({ ok: true, disclosureOk: true });
      await themesOf(A).activate(v.id);
      const res = await service.app.request('/starter-post/', { headers: { host: HOST_A } });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain(`<body class="theme-${name}">`);
      const css = /href="(\/_theme\/[^"]+\.css)"/.exec(html)?.[1];
      expect(css, name).toBeDefined();
      const sheet = await service.app.request(css!, { headers: { host: HOST_A } });
      expect(sheet.status).toBe(200);
      expect(sheet.headers.get('content-type')).toContain('text/css');
    }
    await expect(themesOf(A).installStarter('nope')).rejects.toThrow(/No starter theme/);
    await expect(themesOf(A).installStarter('__proto__')).rejects.toThrow(/No starter theme/);
  });

  it('task 2.4: a version that fails the checks is stored with its issues and cannot be published', async () => {
    const broken = await themesOf(A).createVersion({ name: 'broken', templates: themeWith('X', { item: "{% include 'partials/top' %}{% if %}{% item_body %}" }) });
    expect(broken.checks?.ok).toBe(false);
    await expect(themesOf(A).activate(broken.id)).rejects.toMatchObject({ code: 'THEME_CHECKS_FAILED', status: 422 });
    const noSeo = await themesOf(A).createVersion({ name: 'noseo', templates: themeWith('X', { 'partials/top': top.replace('{% seo_head %}', '') }) });
    expect(noSeo.checks?.issues.some((i) => /seo_head/.test(i.message))).toBe(true);
    await expect(themesOf(A).activate(noSeo.id)).rejects.toBeInstanceOf(ThemeServiceError);
    const outside = await themesOf(A).createVersion({ name: 'outside', templates: themeWith('X', { item: "{% include '../b/item' %}" }) });
    expect(outside.checks?.ok).toBe(false);
    expect(await db.select().from(siteThemes).where(eq(siteThemes.siteId, A))).toEqual([]);
  });

  it('task 2.7: disclosure on refuses a slotless version; off allows it; switching disclosure back on is refused until a slotted version is active', async () => {
    const plain = await themesOf(A).createVersion({ name: 'plain', templates: slotless('PLAIN') });
    expect(plain.checks).toMatchObject({ ok: true, disclosureOk: false });
    // Disclosure is on by default: refused, nothing changes (spec "主题缺少披露插槽").
    await expect(themesOf(A).activate(plain.id)).rejects.toMatchObject({ code: 'THEME_LACKS_DISCLOSURE_SLOT', status: 409 });
    expect(await db.select().from(siteThemes).where(eq(siteThemes.siteId, A))).toEqual([]);
    // Disclosure off: allowed (spec "披露关闭时切换主题").
    await settings(A, { sponsorDisclosure: false });
    await themesOf(A).activate(plain.id);
    // Switching disclosure on with it active: refused, settings unchanged (spec "重新开启披露时主题缺插槽").
    await expect(settings(A, { sponsorDisclosure: true })).rejects.toMatchObject({ code: 'THEME_LACKS_DISCLOSURE_SLOT' });
    expect((await db.select().from(siteContentSettings).where(eq(siteContentSettings.siteId, A)))[0]!.sponsorDisclosure).toBe(false);
    // A slotted version first, then disclosure on.
    const slotted = await themesOf(A).createVersion({ name: 'slotted', templates: themeWith('SLOTTED') });
    await themesOf(A).activate(slotted.id);
    await settings(A, { sponsorDisclosure: true });
    // Rolling back to the slotless version while disclosure is on: refused, the current one stays (spec "披露开启时回滚到无插槽版本").
    await expect(themesOf(A).activate(plain.id)).rejects.toMatchObject({ code: 'THEME_LACKS_DISCLOSURE_SLOT' });
    expect((await db.select().from(siteThemes).where(eq(siteThemes.siteId, A)))[0]!.themeVersionId).toBe(slotted.id);
    expect(ContentSettingsError).toBeDefined();
  });

  it('task 2.7: the two sponsor switches, four combinations — disclosure block and rel="sponsored"; the mark stays in the data', async () => {
    const sponsored = await article(A, 'paid', { sponsored: true, sponsor_name: 'Acme', body: '<p>Buy <a href="https://shop.example.org/x">here</a> or <a href="https://th-a.example.com/in">there</a>.</p>' });
    for (const [disclosure, rel] of [[true, true], [false, true], [true, false], [false, false]] as const) {
      await settings(A, { sponsorDisclosure: disclosure, sponsorRel: rel });
      const item = (await page(HOST_A, '/paid/')).html;
      const home = (await page(HOST_A, '/')).html;
      const label = `disclosure=${disclosure} rel=${rel}`;
      expect(item.includes('heopress-disclosure'), label).toBe(disclosure);
      if (disclosure) expect(item.indexOf('heopress-disclosure'), label).toBeLessThan(item.indexOf('heopress-body'));
      expect(item.includes('Sponsored by Acme'), label).toBe(disclosure);
      expect(/<a href="https:\/\/shop.example.org\/x" rel="sponsored">/.test(item), label).toBe(rel);
      expect(item, label).toContain('<a href="https://th-a.example.com/in">there</a>');
      // The list card: disclosed inside the card when on.
      expect(/<article data-heopress-card="[^"]+">[^]*?heopress-disclosure/.test(home), label).toBe(disclosure);
    }
    const [row] = await db.select({ sponsored: publicItems.sponsored }).from(publicItems).where(eq(publicItems.itemId, sponsored.id));
    expect(row!.sponsored).toBe(true);
  });

  it('assets: content-addressed URLs from asset_url, served immutable for published versions of the site only', async () => {
    const css = 'body { color: #123; }';
    const templates = themeWith('ASSETS', { 'partials/top': top.replace('{% seo_head %}', "{% seo_head %}<link rel=\"stylesheet\" href=\"{{ 'css/site.css' | asset_url }}\">") });
    const v = await themesOf(A).createVersion({ name: 'assets', templates, assets: [{ path: 'css/site.css', contentType: 'text/css', base64: Buffer.from(css).toString('base64') }] });
    expect(v.checks?.ok).toBe(true);
    const sha = v.assets[0]!.sha256;
    const assetPath = `/_theme/${v.id}/${sha}.css`;
    // Not published yet: not served.
    expect((await page(HOST_A, assetPath)).status).toBe(404);
    await themesOf(A).activate(v.id);
    expect((await page(HOST_A, '/')).html).toContain(`<link rel="stylesheet" href="${assetPath}">`);
    const res = await page(HOST_A, assetPath);
    expect(res.status).toBe(200);
    expect(res.html).toBe(css);
    expect(res.headers.get('content-type')).toBe('text/css');
    expect(res.headers.get('cache-control')).toContain('immutable');
    // Another site's host: not served.
    expect((await page(HOST_B, assetPath)).status).toBe(404);
    // A missing asset is caught before publication.
    const missing = await themesOf(A).createVersion({ name: 'missing', templates: themeWith('M', { home: "{% include 'partials/top' %}<img src=\"{{ 'img/none.png' | asset_url }}\" alt=\"\">{% include 'partials/bottom' %}" }) });
    expect(missing.checks?.ok).toBe(false);
    // Uploads are validated.
    await expect(themesOf(A).createVersion({ name: 'bad', templates: themeWith('B'), assets: [{ path: 'x.html', contentType: 'text/html', base64: '' }] })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('against the application role itself: no foreign or unpublished pointer, no moved asset, no forged seal, no incomplete manifest (Codex review)', async () => {
    const attempt = (q: PromiseLike<unknown>) => Promise.resolve(q).then(() => 'accepted', (e: { cause?: { message?: string }; message?: string }) => e.cause?.message ?? e.message ?? 'refused');
    const a = await themesOf(A).createVersion({ name: 'a', templates: themeWith('A') });
    const draft = await themesOf(A).createVersion({ name: 'a', templates: themeWith('A2') });
    const b = await themesOf(B).createVersion({ name: 'b', templates: themeWith('B') });
    await themesOf(B).activate(b.id);
    // A's pointer cannot name B's version, nor an unpublished one of its own.
    expect(await attempt(db.insert(siteThemes).values({ siteId: A, themeVersionId: b.id }))).toMatch(/foreign key|own published/);
    expect(await attempt(db.insert(siteThemes).values({ siteId: A, themeVersionId: draft.id }))).toMatch(/own published/);
    await themesOf(A).activate(a.id);
    expect(await attempt(db.update(siteThemes).set({ themeVersionId: draft.id }).where(eq(siteThemes.siteId, A)))).toMatch(/own published/);
    // The draft is never visible to the renderer through the pointer or the asset view.
    expect((await page(HOST_A, '/')).html).toContain('<p class="marker">A</p>');
    // A forged seal: the session setting is no credential.
    const [theme] = await db.select({ t: themeVersions.themeId }).from(themeVersions).where(eq(themeVersions.id, a.id));
    const raw = 'th_raw_' + randomBytes(4).toString('hex');
    await db.insert(themeVersions).values({ id: raw, siteId: A, themeId: theme!.t, number: 50, templates: { home: 'x' }, assets: [] });
    expect(
      await attempt(
        db.transaction(async (tx) => {
          await tx.execute(sql`SELECT set_config('heopress.sealing', ${raw}, true)`);
          await tx.update(themeVersions).set({ sealedAt: new Date(), contentHash: 'x' }).where(eq(themeVersions.id, raw));
        }),
      ),
    ).toMatch(/sealed by heopress_seal_theme_version/);
    // An asset row cannot move into a sealed version (or another site).
    await db.insert(themeAssets).values({ versionId: raw, siteId: A, path: 'x.css', sha256: createHashHex('x'), contentType: 'text/css', bytes: Buffer.from('x') });
    expect(await attempt(db.update(themeAssets).set({ versionId: a.id }).where(eq(themeAssets.versionId, raw)))).toMatch(/identity is immutable/);
    expect(await attempt(db.update(themeAssets).set({ siteId: B }).where(eq(themeAssets.versionId, raw)))).toMatch(/identity is immutable|foreign key/);
    // A manifest entry missing fields does not seal.
    await db.update(themeVersions).set({ assets: [{ path: 'x.css' } as never] }).where(eq(themeVersions.id, raw));
    expect(await attempt(db.execute(sql`SELECT heopress_seal_theme_version(${raw}, ${A})`))).toMatch(/malformed asset manifest/);
    // Another site's version cannot be sealed from here (whatever the owner's privileges).
    expect(await attempt(db.execute(sql`SELECT heopress_seal_theme_version(${raw}, ${B})`))).toMatch(/no theme version/);
    expect(
      await attempt(
        db.transaction(async (tx) => {
          await tx.execute(sql`SELECT set_config('app.site_id', ${B}, true)`);
          await tx.execute(sql`SELECT heopress_seal_theme_version(${raw}, ${A})`);
        }),
      ),
    ).toMatch(/no theme version/);
  });

  it('assets with the same bytes under two names are served with their own types; stale checks are redone; uploads are bounded before decoding', async () => {
    const same = Buffer.from('/* same */').toString('base64');
    const v = await themesOf(A).createVersion({
      name: 'same',
      templates: themeWith('S'),
      assets: [
        { path: 'a.css', contentType: 'text/css', base64: same },
        { path: 'b.js', contentType: 'text/javascript', base64: same },
      ],
    });
    // Stale checks (an older checker): redone at activation.
    await db.update(themeVersions).set({ checks: { ...(v.checks as object), validator: 0 } as never }).where(eq(themeVersions.id, v.id));
    await themesOf(A).activate(v.id);
    const [row] = await db.select({ checks: themeVersions.checks }).from(themeVersions).where(eq(themeVersions.id, v.id));
    expect(row!.checks!.validator).toBeGreaterThan(0);
    const sha = v.assets[0]!.sha256;
    expect((await page(HOST_A, `/_theme/${v.id}/${sha}.js`)).headers.get('content-type')).toBe('text/javascript');
    expect((await page(HOST_A, `/_theme/${v.id}/${sha}.css`)).headers.get('content-type')).toBe('text/css');
    expect((await page(HOST_A, `/_theme/${v.id}/${sha}.png`)).status).toBe(404);
    const many = Array.from({ length: 201 }, (_, i) => ({ path: `f${i}.css`, contentType: 'text/css', base64: '' }));
    await expect(themesOf(A).createVersion({ name: 'many', templates: themeWith('M'), assets: many })).rejects.toMatchObject({ code: 'VALIDATION' });
    const huge = 'A'.repeat(3 * 1024 * 1024);
    await expect(themesOf(A).createVersion({ name: 'huge', templates: themeWith('H'), assets: [{ path: 'h.css', contentType: 'text/css', base64: huge }] })).rejects.toMatchObject({ code: 'TOO_LARGE' });
  });

  it('versions are immutable in the database: sealed content, published versions kept, assets fixed and checked', async () => {
    const v = await themesOf(A).createVersion({ name: 'imm', templates: themeWith('I'), assets: [{ path: 'a.css', contentType: 'text/css', base64: Buffer.from('a{}').toString('base64') }] });
    await themesOf(A).activate(v.id);
    const attempt = (q: Promise<unknown>) => q.then(() => 'accepted', (e: { cause?: { message?: string }; message?: string }) => e.cause?.message ?? e.message ?? 'refused');
    expect(await attempt(db.update(themeVersions).set({ templates: { home: 'x' } }).where(eq(themeVersions.id, v.id)))).toMatch(/sealed/);
    expect(await attempt(db.update(themeVersions).set({ publishedAt: null }).where(eq(themeVersions.id, v.id)))).toMatch(/set once/);
    expect(await attempt(db.delete(themeVersions).where(eq(themeVersions.id, v.id)))).toMatch(/published/);
    expect(await attempt(db.update(themeAssets).set({ contentType: 'text/plain' }).where(eq(themeAssets.versionId, v.id)))).toMatch(/sealed/);
    expect(await attempt(db.delete(themeAssets).where(and(eq(themeAssets.versionId, v.id))))).toMatch(/sealed/);
    expect(await attempt(db.execute(sql`SELECT heopress_seal_theme_version(${v.id}, ${A})`))).toMatch(/already sealed/);
    // A new version cannot start sealed or published, nor carry an asset whose digest is wrong.
    expect(await attempt(db.insert(themeVersions).values({ siteId: A, themeId: (await db.select({ t: themeVersions.themeId }).from(themeVersions).where(eq(themeVersions.id, v.id)))[0]!.t, number: 99, templates: {}, assets: [], sealedAt: new Date() }))).toMatch(/unsealed/);
    expect(await attempt(db.insert(themeAssets).values({ versionId: v.id, siteId: A, path: 'b.css', sha256: '0'.repeat(64), contentType: 'text/css', bytes: Buffer.from('b') }))).toMatch(/sha256|sealed/);
    // Deleting the site takes everything with it.
    await db.delete(sites).where(eq(sites.id, A));
    expect(await db.select().from(themeVersions).where(eq(themeVersions.siteId, A))).toEqual([]);
  });

  describe('HeoPress P07 task 2.4: themes write no JSON-LD', () => {
    const jsonLdItem = (marker: string) => themeWith(marker, { item: `{% include 'partials/top' %}<article>{% json_ld item %}<h1>{{ item.title }}</h1>{% sponsor_disclosure item %}{% item_body %}</article>{% include 'partials/bottom' %}` });
    const scriptItem = (marker: string) => themeWith(marker, { item: `{% include 'partials/top' %}<article><script type="application/ld+json">{"@type":"Thing"}</script><h1>{{ item.title }}</h1>{% sponsor_disclosure item %}{% item_body %}</article>{% include 'partials/bottom' %}` });

    it('a version with the json_ld tag or an ld+json script of its own fails the checks and cannot go live', async () => {
      for (const templates of [jsonLdItem('TAG'), scriptItem('SCRIPT')]) {
        const v = await themesOf(A).createVersion({ name: 'main', templates });
        expect(v.checks).toMatchObject({ ok: false });
        expect(v.checks!.issues.some((i) => /json_ld|JSON-LD/.test(i.message))).toBe(true);
        // Pointed to what replaces it (spec seo/page-metadata "主题直接输出 JSON-LD").
        expect(v.checks!.issues.some((i) => /JSON-LD|json_ld %\}/.test(i.message) && /use a structured-data contribution instead/.test(i.message))).toBe(true);
        await expect(themesOf(A).activate(v.id)).rejects.toMatchObject({ code: 'THEME_CHECKS_FAILED' });
      }
    });

    /** A version an older checker passed, active before this change (written as the former code left it). */
    async function legacyActive(siteId: string, templates: Record<string, string>, validator = 1) {
      const v = await themesOf(siteId).createVersion({ name: 'legacy', templates });
      await owner.begin(async (tx) => {
        await tx`SELECT set_config('app.site_id', ${siteId}, true)`;
        await tx`UPDATE lumibase_theme_versions SET checks = jsonb_set(jsonb_set(jsonb_set(checks, '{validator}', to_jsonb(${validator}::int)), '{ok}', 'true'), '{disclosureOk}', 'true'), published_at = now() WHERE id = ${v.id}`;
        await tx`INSERT INTO lumibase_site_themes (site_id, theme_version_id) VALUES (${siteId}, ${v.id})`;
      });
      await rebuildSiteProjection(db, siteId);
      return v;
    }

    it('an active version checked by an older checker: the rendering view returns no row (any renderer falls back), migration 0068 raises the render version of a site it stops serving, a warm cache is not served', async () => {
      await article(A, 'hello');
      // Passed by checker 3, which lost an include's whitespace control: `application/  {%- include -%}  ld+json` in an untaken branch.
      const legacy = await legacyActive(A, themeWith('LEGACY', {
        'partials/noop': '',
        item: `{% include 'partials/top' %}<article>{% if item.title == 'publish-me' %}<script type="application/  {%- include 'partials/noop' -%}  ld+json">{}</script>{% endif %}<h1>{{ item.title }}</h1>{% sponsor_disclosure item %}{% item_body %}</article>{% include 'partials/bottom' %}`,
      }), 3);
      // A page cached under the former theme, as an older renderer would have stored it.
      const before = await renderVersion(A);
      const key = cacheKey({ mode: 'public', siteId: A, host: HOST_A, path: '/hello/', query: new URLSearchParams(), themeVersion: legacy.id, siteVersion: before });
      const stale = cachedPage(200, '<p class="marker">LEGACY</p><script type="application/ld+json">{}</script>', null);
      await db.insert(renderCache).values({ key, siteId: A, siteVersion: before, status: 200, body: stale.body, etag: stale.etag, location: null, contentType: stale.contentType, headers: {}, expiresAt: new Date(Date.now() + 3_600_000) });
      // The view the rendering role reads: no active version for A (an older renderer reads it too).
      const rows = await renderClient.begin(async (tx) => {
        await tx`SELECT set_config('app.site_id', ${A}, true)`;
        return tx`SELECT version_id FROM lumibase_render_themes`;
      });
      expect(rows).toHaveLength(0);
      // Migration 0068 raises A's render version (checker 3 had passed its active version, served until then), not B's (no theme).
      const bBefore = await renderVersion(B);
      const migration = readFileSync(path.resolve(__dirname, '../../../../packages/database/drizzle/0068_render_themes_checker_4.sql'), 'utf8').replace(/--> statement-breakpoint/g, '');
      await owner.unsafe(migration);
      expect(await renderVersion(A)).toBeGreaterThan(before);
      expect(await renderVersion(B)).toBe(bBefore);
      // The page: the built-in theme, the system's one graph, not the cached former page.
      const html = (await page(HOST_A, '/hello/')).html;
      expect(html).not.toContain('LEGACY');
      expect(html.match(/<script type="application\/ld\+json">/g)).toHaveLength(1);
      // The worker's check with checker 4 finds what checker 3 missed: switched off.
      expect(await recheckActiveTheme(db, A)).toBe('reverted');
      expect((await db.select({ checks: themeVersions.checks }).from(themeVersions).where(eq(themeVersions.id, legacy.id)))[0]!.checks).toMatchObject({ validator: 4, ok: false });
    });

    it('the worker checks active versions again: a failing one goes (built-in theme, event, audit, administrators told), a passing one stays', async () => {
      // An administrator of A to be told.
      const adminId = 'usr_p07_theme_admin';
      await db.delete(users).where(eq(users.id, adminId));
      await db.insert(users).values({ id: adminId, email: 'p07-theme-admin@example.com' });
      const [adminRole] = await db.insert(roles).values({ siteId: A, name: 'Theme admin', adminAccess: true, appAccess: true }).returning({ id: roles.id });
      await db.insert(userSites).values({ userId: adminId, siteId: A, roleId: adminRole!.id });
      try {
        const legacy = await legacyActive(A, jsonLdItem('LEGACY'));
        const clean = await legacyActive(B, themeWith('CLEAN'));
        // Checked by an older checker: not served until checked again, whatever its content (the view reads the stored checks).
        expect((await page(HOST_B, '/')).html).not.toContain('CLEAN');
        const bBefore = await renderVersion(B);
        const before = await renderVersion(A);
        expect(await recheckActiveTheme(db, A)).toBe('reverted');
        expect(await recheckActiveTheme(db, B)).toBe('passed');
        // A: no active version, its checks recorded, the render version raised, the event and the notice.
        expect(await db.select().from(siteThemes).where(eq(siteThemes.siteId, A))).toEqual([]);
        const [checked] = await db.select({ checks: themeVersions.checks }).from(themeVersions).where(eq(themeVersions.id, legacy.id));
        expect(checked!.checks).toMatchObject({ validator: 4, ok: false });
        expect(await renderVersion(A)).toBeGreaterThan(before);
        const events = await db.select().from(cdcChangeEvents).where(and(eq(cdcChangeEvents.siteId, A), eq(cdcChangeEvents.resource, 'theme')));
        expect(events.at(-1)!.payload).toMatchObject({ theme: { versionId: null, previousVersionId: legacy.id } });
        const notices = await db.select().from(notifications).where(and(eq(notifications.siteId, A), eq(notifications.recipient, adminId)));
        expect(notices).toHaveLength(1);
        expect(notices[0]!.subject).toContain('legacy');
        // B: still active, checked by the current checker, served again under a raised render version (no built-in page cached meanwhile is served).
        expect((await db.select().from(siteThemes).where(eq(siteThemes.siteId, B)))[0]!.themeVersionId).toBe(clean.id);
        expect(await renderVersion(B)).toBeGreaterThan(bBefore);
        expect((await db.select({ checks: themeVersions.checks }).from(themeVersions).where(eq(themeVersions.id, clean.id)))[0]!.checks).toMatchObject({ validator: 4, ok: true });
        expect((await page(HOST_B, '/')).html).toContain('<p class="marker">CLEAN</p>');
        // Again: nothing left to do, nobody told twice.
        const again = await recheckActiveThemes(db);
        expect(again.reverted).not.toContain(A);
        expect(again.current).toContain(B);
        expect(await db.select().from(notifications).where(eq(notifications.recipient, adminId))).toHaveLength(1);
      } finally {
        await db.delete(users).where(eq(users.id, adminId));
      }
    });

    it('a version whose current checks failed is switched off too; with explicit disclosure on, one lacking its slots is (Codex review of batch 5b-1)', async () => {
      // Current checks that failed (a restore, a repair by hand): switched off, not left active.
      const failing = await themesOf(A).createVersion({ name: 'failing', templates: themeWith('FAILING') });
      await owner.begin(async (tx) => {
        await tx`SELECT set_config('app.site_id', ${A}, true)`;
        await tx`UPDATE lumibase_theme_versions SET checks = jsonb_set(checks, '{ok}', 'false'), published_at = now() WHERE id = ${failing.id}`;
        await tx`INSERT INTO lumibase_site_themes (site_id, theme_version_id) VALUES (${A}, ${failing.id})`;
      });
      expect(await recheckActiveTheme(db, A)).toBe('reverted');
      expect(await db.select().from(siteThemes).where(eq(siteThemes.siteId, A))).toEqual([]);
      // Disclosure on (B's default) and a version without the disclosure slots, passed by an older checker: switched off.
      const noSlots = await legacyActive(B, slotless('NOSLOTS'));
      expect(await recheckActiveTheme(db, B)).toBe('reverted');
      expect((await db.select({ checks: themeVersions.checks }).from(themeVersions).where(eq(themeVersions.id, noSlots.id)))[0]!.checks).toMatchObject({ validator: 4, ok: true, disclosureOk: false });
    });
  });
});
