import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  collections,
  ensureRenderRole,
  extensions,
  publicStaticMounts,
  schema,
  scopedDatabase,
  siteContentSettings,
  siteDomains,
  siteRenderVersions,
  siteStaticMounts,
  sites,
  type Database,
} from '@heopress/database';
import { createSiteClassic, type SiteClassic } from '@heopress/site-classic';
import { renderPort } from '@heopress/site-classic/read-port';
import { ItemService } from '../services/item-service';
import { ContentSettingsService } from '../services/site-network/content-settings-service';
import { rebuildSiteProjection } from '../services/site-network/public-projection';
import { upgradeSitePreset } from '../services/site-network/preset-installer';
import { StaticMountService } from '../services/site-network/static-mount-service';
import { connectDbFixtures, connectDbIntegration, dbIntegrationUrl, hasDbIntegrationUrl } from './helpers/db-harness';

/**
 * The static directory mount (v1.5, spec rendering/static-directory-mount): the site setting and its validation, tenant
 * isolation, the Classic fallback (precedence, headers, conditional requests, 404), the content pass-through and the
 * sitemap merge. The Classic engine runs as the rendering role, the setting is written through the CMS service as the
 * application role, and the mount lives under a temporary `HEOPRESS_STATIC_ROOT`.
 */

const A = 'site_mount_a';
const B = 'site_mount_b';
const HOST_A = 'mount-a.example.com';
const HOST_B = 'mount-b.example.com';
const RENDER_ROLE = 'heopress_render_mount_it';

describe.skipIf(!hasDbIntegrationUrl)('static directory mount — DB integration', () => {
  let db: Database;
  let fixtures: Database;
  let owner: postgres.Sql;
  let renderClient: postgres.Sql;
  let renderDb: Database;
  let service: SiteClassic;
  let app: SiteClassic['app'];
  let root: string;
  let mount: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'heopress-static-root-'));
    db = await connectDbIntegration('static-mount');
    fixtures = await connectDbFixtures('static-mount');
    owner = (fixtures as unknown as { $client: postgres.Sql }).$client;
    const password = randomBytes(18).toString('hex');
    await owner.begin((tx) => ensureRenderRole(tx, { role: RENDER_ROLE, password }));
    const url = new URL(dbIntegrationUrl!);
    url.username = RENDER_ROLE;
    url.password = password;
    renderClient = postgres(url.toString(), { max: 2, onnotice: () => {} });
    renderDb = drizzle(renderClient, { schema }) as unknown as Database;
    service = createSiteClassic({ db: renderDb, staticRoot: root });
    app = service.app;
  });

  afterAll(async () => {
    await fixtures?.delete(sites).where(inArray(sites.id, [A, B]));
    await service?.close();
    await renderClient?.end({ timeout: 2 });
    await owner?.end({ timeout: 2 });
    await rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await fixtures.delete(sites).where(inArray(sites.id, [A, B]));
    await fixtures.insert(sites).values([
      { id: A, name: 'Mount Site', defaultLanguage: 'en' },
      { id: B, name: 'Other Site', defaultLanguage: 'en' },
    ]);
    for (const id of [A, B]) await upgradeSitePreset(db, id);
    await fixtures.insert(siteDomains).values([
      { siteId: A, hostname: HOST_A, kind: 'custom', status: 'active', isPrimary: true, verifiedAt: new Date() },
      { siteId: B, hostname: HOST_B, kind: 'custom', status: 'active', isPrimary: true, verifiedAt: new Date() },
    ]);
    const permalinks = { articles: '/:slug', pages: '/:slug', categories: '/category/:slug', tags: '/tag/:slug', authors: '/author/:slug' };
    for (const id of [A, B]) await contentSettings(id, { availableLocales: ['en'], permalinks });
    // The domains and settings above were written past the services: rebuild, as a deployment does first.
    for (const id of [A, B]) await rebuildSiteProjection(db, id);
    // A fresh render version per test: this service process keeps a page cache, and a recreated site must not read the
    // answers of the previous test's version.
    await fixtures
      .update(siteRenderVersions)
      .set({ version: sql`${siteRenderVersions.version} + 1000`, structureVersion: sql`${siteRenderVersions.structureVersion} + 1000` })
      .where(inArray(siteRenderVersions.siteId, [A, B]));
    mount = join(root, `mount-${randomBytes(4).toString('hex')}`);
    await mkdir(mount, { recursive: true });
  });

  const siteDb = (siteId: string) => scopedDatabase(db, { site: siteId });

  async function contentSettings(siteId: string, over: Record<string, unknown>) {
    const [r] = await fixtures.select().from(siteContentSettings).where(eq(siteContentSettings.siteId, siteId));
    return new ContentSettingsService({ db: siteDb(siteId), siteId, actor: { userId: null } }).update({
      availableLocales: r!.availableLocales,
      timezone: r!.timezone,
      siteType: 'blog',
      trailingSlash: r!.trailingSlash,
      localeStrategy: r!.localeStrategy,
      localePrefixMode: r!.localePrefixMode,
      localePrefixes: r!.localePrefixes,
      permalinks: r!.permalinks,
      allowCrossSiteTranslations: false,
      sponsorDisclosure: true,
      sponsorRel: true,
      version: r!.version,
      ...over,
    } as never);
  }

  const article = (siteId: string, slug: string, data: Record<string, unknown> = {}) =>
    new ItemService({ db: siteDb(siteId), siteId }).create('articles', { data: { title: `Title ${slug}`, slug, locale: 'en', ...data }, status: 'published' }) as Promise<{ id: string; version: number }>;

  const mountService = (siteId: string, configuredRoot: string | null | undefined = root) =>
    new StaticMountService({ db: siteDb(siteId), siteId, root: configuredRoot, actor: { userId: null } });

  async function mountSite(siteId: string, files: Record<string, string>) {
    for (const [rel, body] of Object.entries(files)) {
      const file = join(mount, ...rel.split('/'));
      await mkdir(join(file, '..'), { recursive: true });
      await writeFile(file, body);
    }
    return mountService(siteId).update({ directory: mount, version: 0 });
  }

  const get = (host: string, path: string, headers: Record<string, string> = {}) => app.request(path, { headers: { host, ...headers } });

  it('saves a directory under the operator root, resolves it, and projects it for the rendering role', async () => {
    await mountSite(A, { 'legacy/about.html': '<p>archive</p>' });
    const view = await mountService(A).get();
    expect(view).toEqual({ directory: mount, version: 1 });
    const [projected] = await fixtures.select().from(publicStaticMounts).where(eq(publicStaticMounts.siteId, A));
    expect(projected?.directory).toBe(mount);
    // The rendering role reads it from the projection (and not from the settings table).
    await expect(renderPort(renderDb).request(A, (_port, reads) => reads.site())).resolves.toMatchObject({ staticDirectory: mount });
    expect(await renderPort(renderDb).request(B, (_port, reads) => reads.site())).toMatchObject({ staticDirectory: null });
    // The render role reads the projection only, never the settings table.
    const [privilege] = await fixtures.execute(sql`SELECT has_table_privilege(${RENDER_ROLE}, 'public.lumibase_site_static_mounts', 'SELECT') AS ok`);
    expect((privilege as { ok: boolean }).ok).toBe(false);
  });

  it('refuses a directory outside the root, an unconfigured root, a missing path, a file and an invalid path', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'heopress-outside-'));
    const cases: Array<[() => Promise<unknown>, string]> = [
      [() => mountService(A, null).update({ directory: mount, version: 0 }), 'ROOT_NOT_CONFIGURED'],
      [() => mountService(A, '').update({ directory: mount, version: 0 }), 'ROOT_NOT_CONFIGURED'],
      [() => mountService(A).update({ directory: outside, version: 0 }), 'OUTSIDE_ROOT'],
      [() => mountService(A).update({ directory: join(root, 'missing'), version: 0 }), 'NOT_FOUND'],
      [() => mountService(A).update({ directory: join(mount, 'static-urls.txt'), version: 0 }), 'NOT_FOUND'],
      [() => mountService(A).update({ directory: 'relative/path', version: 0 }), 'INVALID_PATH'],
      [() => mountService(A).update({ directory: '/tmp/a\u0000b', version: 0 }), 'INVALID_PATH'],
    ];
    for (const [run, code] of cases) {
      await expect(run(), code).rejects.toMatchObject({ code, status: 400 });
    }
    // A file (not a directory) that exists: refused as not a directory.
    const file = join(mount, 'a-file.txt');
    await writeFile(file, 'x');
    await expect(mountService(A).update({ directory: file, version: 0 })).rejects.toMatchObject({ code: 'NOT_DIRECTORY', status: 400 });
    // Nothing was saved.
    expect(await mountService(A).get()).toEqual({ directory: '', version: 0 });
    await rm(outside, { recursive: true, force: true });
  });

  it('keeps the setting per site and refuses a stale write', async () => {
    await mountSite(A, {});
    expect((await mountService(A).get()).version).toBe(1);
    expect(await mountService(B).get()).toEqual({ directory: '', version: 0 });
    // A stale form is a 409, never an overwrite.
    await expect(mountService(A).update({ directory: mount, version: 0 })).rejects.toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
    // Another site's mount cannot be read or changed through this site's scope.
    const rows = await siteDb(B).select().from(siteStaticMounts).where(eq(siteStaticMounts.siteId, A));
    expect(rows).toEqual([]);
    await mountService(B).update({ directory: '', version: 0 });
    expect((await mountService(A).get()).directory).toBe(mount);
    // Clearing the mount removes the projection row too.
    await mountService(A).update({ directory: '', version: 1 });
    expect(await mountService(A).get()).toEqual({ directory: '', version: 0 });
    expect(await fixtures.select().from(publicStaticMounts).where(eq(publicStaticMounts.siteId, A))).toEqual([]);
  });

  it('serves a matched HeoPress path before the mount, for every class: entry, plugin route, robots.txt, sitemap, .well-known and health', async () => {
    await article(A, 'taken');
    // A plugin list route at `/notes`.
    // The plugin namespace is the name with its separators normalised (`demo/notes` → `demo_notes`).
    const ns = 'demo_notes';
    await fixtures.insert(collections).values({
      siteId: A,
      name: `${ns}__docs`,
      meta: { extension: { name: 'demo/notes', namespace: ns, collection: 'docs' } },
    });
    await fixtures.insert(extensions).values({
      siteId: A,
      key: 'notes',
      name: 'demo/notes',
      version: '1.0.0',
      type: 'hook',
      enabled: true,
      bundleUrl: 'https://example.com/notes.js',
      capabilities: ['ext:routes', 'ext:collections'],
      manifest: {
        collections: [{ name: 'docs', fields: [{ name: 'title', type: 'string', interface: 'input' }] }],
        routes: [{ id: 'index', kind: 'list', path: '/notes', collection: 'docs', template: 'index' }],
        templates: {
          classic: {
            index:
              '<!doctype html><html lang="{{ page.locale }}"><head><meta charset="utf-8">{% seo_head %}</head><body><main><div class="plugin-index">plugin-index</div></main></body></html>',
          },
        },
      },
    });
    await rebuildSiteProjection(db, A);
    await mountSite(A, {
      'taken/index.html': '<p>mount took the entry</p>',
      'notes/index.html': '<p>mount took the plugin route</p>',
      'robots.txt': 'User-agent: *\nDisallow: /\n',
      'sitemap.xml': '<urlset><url><loc>https://example.invalid/mount</loc></url></urlset>',
      '.well-known/security.txt': 'Contact: mailto:mount@example.com\n',
      'health/index.html': '<p>mount health</p>',
      'search/index.html': '<p>mount search</p>',
    });

    const entry = await get(HOST_A, '/taken/');
    expect(entry.status).toBe(200);
    expect(await entry.text()).toContain('Title taken');
    expect(await (await get(HOST_A, '/taken/')).text()).not.toContain('mount took the entry');

    const plugin = await get(HOST_A, '/notes/');
    const pluginBody = await plugin.text();
    expect(plugin.status).toBe(200);
    expect(pluginBody).not.toContain('mount took the plugin route');
    expect(pluginBody).toContain('plugin-index');

    const robots = await get(HOST_A, '/robots.txt');
    expect(robots.status).toBe(200);
    expect(await robots.text()).not.toContain('Disallow: /');

    const sitemap = await get(HOST_A, '/sitemap.xml');
    expect(sitemap.status).toBe(200);
    expect(await sitemap.text()).not.toContain('example.invalid');

    const wellKnown = await get(HOST_A, '/.well-known/security.txt');
    expect(await wellKnown.text()).not.toContain('mount@example.com');

    const health = await get(HOST_A, '/health/');
    expect(await health.text()).not.toContain('mount health');

    // The search page is a HeoPress route too.
    const search = await get(HOST_A, '/search');
    expect(await search.text()).not.toContain('mount search');
  });

  it('serves a mount file with its type, cache policy and validators, and answers conditional requests', async () => {
    await mountSite(A, { 'legacy/about.html': '<link rel="canonical" href="/old/about"><meta name="robots" content="noindex">\n<p>archive</p>', 'app.css': 'body{}' });
    const html = await get(HOST_A, '/legacy/about.html');
    expect(html.status).toBe(200);
    expect(html.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(html.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
    expect(html.headers.get('x-content-type-options')).toBe('nosniff');
    expect(html.headers.get('etag')).toMatch(/^W\//);
    expect(html.headers.get('last-modified')).toBeTruthy();
    expect(html.headers.get('vary')).toBeNull();
    // Pass-through: the operator's canonical and noindex are untouched, byte for byte.
    expect(await html.text()).toBe(await readFile(join(mount, 'legacy/about.html'), 'utf8'));

    const css = await get(HOST_A, '/app.css');
    expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8');
    expect(css.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');

    const notModified = await get(HOST_A, '/legacy/about.html', { 'if-none-match': html.headers.get('etag')! });
    expect(notModified.status).toBe(304);
    expect(notModified.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(notModified.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
    expect(notModified.headers.get('etag')).toBe(html.headers.get('etag'));

    const byDate = await get(HOST_A, '/legacy/about.html', { 'if-modified-since': html.headers.get('last-modified')! });
    expect(byDate.status).toBe(304);

    // HEAD: the headers, no body.
    const head = await app.request('/legacy/about.html', { method: 'HEAD', headers: { host: HOST_A } });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe(String((await readFile(join(mount, 'legacy/about.html'))).byteLength));
  });

  it('answers a mount directory through its index (301 to the trailing slash) and a miss with the site’s 404', async () => {
    await mountSite(A, { 'docs/index.html': '<p>docs</p>' });
    const redirect = await get(HOST_A, '/docs');
    expect(redirect.status).toBe(301);
    expect(redirect.headers.get('location')).toBe('/docs/');
    const index = await get(HOST_A, '/docs/');
    expect(index.status).toBe(200);
    expect(await index.text()).toBe('<p>docs</p>');

    const missing = await get(HOST_A, '/legacy/none.html');
    expect(missing.status).toBe(404);
    expect(missing.headers.get('cache-control')).toBe('no-store');
    expect(missing.headers.get('content-type')).toContain('text/html');
  });

  it('never serves a file added after a 404 was cached, and never lets a mount file escape the directory', async () => {
    await mountSite(A, {});
    expect((await get(HOST_A, '/late.html')).status).toBe(404);
    await writeFile(join(mount, 'late.html'), '<p>late</p>');
    const late = await get(HOST_A, '/late.html');
    expect(late.status).toBe(200);
    expect(await late.text()).toBe('<p>late</p>');

    // A symbolic link out of the mount is not a file of the mount.
    const outside = join(root, 'outside-secret.txt');
    await writeFile(outside, 'do not serve');
    await (await import('node:fs/promises')).symlink(outside, join(mount, 'escape.txt'));
    expect((await get(HOST_A, '/escape.txt')).status).toBe(404);
    for (const path of ['/%2e%2e/outside-secret.txt', '/%252e%252e/outside-secret.txt', '/../outside-secret.txt']) {
      expect((await get(HOST_A, path)).status, path).toBe(404);
    }
  });

  it('merges static-urls.txt into the sitemap, de-duplicated and without failing on invalid lines', async () => {
    await article(A, 'taken');
    await mountSite(A, {
      'static-urls.txt': ['/legacy/a.html', '/legacy/b.html', '/taken/', '/legacy/a.html', 'not-a-path', '/has?query=1', '/../escape', ''].join('\n'),
    });
    // The index names its shard; the shard carries the URLs.
    const index = await (await get(HOST_A, '/sitemap.xml')).text();
    expect(index).toContain(`https://${HOST_A}/sitemap-1.xml`);
    const sitemap = await (await get(HOST_A, '/sitemap-1.xml')).text();
    expect(sitemap).toContain(`https://${HOST_A}/legacy/a.html`);
    expect(sitemap).toContain(`https://${HOST_A}/legacy/b.html`);
    // The declared `/taken/` duplicates the entry's own address: once.
    expect(sitemap.split(`https://${HOST_A}/taken/`).length - 1).toBe(1);
    expect(sitemap).not.toContain('not-a-path');
    expect(sitemap).not.toContain('escape');
    const txt = await (await get(HOST_A, '/sitemap.txt')).text();
    expect(txt).toContain(`https://${HOST_A}/legacy/a.html`);
    expect(txt).toContain(`https://${HOST_A}/legacy/b.html`);

    // An edit of the declared list is seen without a publication.
    await writeFile(join(mount, 'static-urls.txt'), '/legacy/c.html\n');
    const again = await (await get(HOST_A, '/sitemap-1.xml')).text();
    expect(again).toContain(`https://${HOST_A}/legacy/c.html`);
    expect(again).not.toContain(`https://${HOST_A}/legacy/a.html`);
  });

  it('does not serve a mount for another site, and a site without one is unchanged', async () => {
    await mountSite(A, { 'only-a.html': '<p>a</p>' });
    expect((await get(HOST_A, '/only-a.html')).status).toBe(200);
    expect((await get(HOST_B, '/only-a.html')).status).toBe(404);
    // A site with no mount: the same 404s as before, with the normal cacheable answer.
    await mountService(A).update({ directory: '', version: 1 });
    expect((await get(HOST_B, '/only-a.html')).status).toBe(404);
  });
});
