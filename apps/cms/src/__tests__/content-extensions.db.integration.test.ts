import { randomBytes } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { collections, ensureRenderRole, extensions, items as itemsTable, schema, siteContentSettings, siteDomains, sites, type Database } from '@heopress/database';
import { BUILTIN_THEME } from '@heopress/public-site';
import { createSiteClassic, type SiteClassic } from '@heopress/site-classic';
import { exportPageData, servePageData } from '@heopress/site-classic/page-data';
import { buildSiteGeneration, pageFile, templateDir } from '@heopress/site-astro';
import type { PageDataSnapshot } from '@heopress/contracts/page-data';
import { CapabilityError, ExtensionSandbox, type ExtensionActorDataAccess } from '../extensions/sandbox';
import { ExtensionMutationError, ExtensionsService } from '../services/extensions-service';
import { ExtensionVerifierService } from '../services/extension-verifier';
import { ItemService } from '../services/item-service';
import { PermissionService } from '../services/permission-service';
import { SchemaService } from '../services/schema-service';
import { ContentSettingsService } from '../services/site-network/content-settings-service';
import { upgradeSitePreset } from '../services/site-network/preset-installer';
import { rebuildSiteProjection } from '../services/site-network/public-projection';
import { ThemeService } from '../services/themes/theme-service';
import { connectDbIntegration, dbIntegrationUrl, hasDbIntegrationUrl } from './helpers/db-harness';
import { GLOSSARY, GLOSSARY_NS, TERMS, glossaryInstall, glossaryManifest } from './helpers/glossary-plugin';

/**
 * Plugin content extensions against the real data path (HeoPress P12 tasks 2.1–2.5; spec extensions/content-extensions;
 * ADR-0015). A glossary plugin (`acme/glossary`) installs a `terms` collection under its namespace, an item route
 * `/glossary/:slug` and a list route `/glossary` with default templates for both engines, a `badge` component and a
 * structured-data node.
 *
 *   2.1  its collection is per site and namespaced; disabling keeps the data, re-enabling finds it intact; a second
 *        plugin's same-named collection is its own; its items go through the mainline write path (Hold, publish
 *        capability); hard delete needs the plugin disabled, the namespace typed and a fresh export.
 *   2.2  enabling is refused, with the conflicting paths listed, when a route collides with a system path, a language
 *        prefix, existing content or another plugin's route.
 *   2.3  Classic serves the item and list pages; Astro builds them from the page data; both say the same (status,
 *        canonical, robots, JSON-LD) and the sitemap lists them; a theme's own template overrides the default in both.
 *   2.4  a theme places the plugin's component; both engines render it; without the plugin it renders nothing.
 *   2.5  the plugin's structured data is merged by the core; disabling withdraws pages, sitemap entries, components and
 *        its node in both engines.
 *
 * Needs DATABASE_OWNER_URL (to provision this suite's rendering role, as a deployment does).
 */

const RENDER_ROLE = 'heopress_render_content_ext';
const OWNER_URL = process.env.DATABASE_OWNER_URL?.trim() || undefined;
const NOW = Date.parse('2026-10-01T12:00:00Z');
const A = 'site_p12_content_a';
const B = 'site_p12_content_b';
const HOST = 'glossary.example.com';
const HOST_B = 'other.example.com';
const ORIGIN = `https://${HOST}`;
const PERMALINKS = { articles: '/:slug', pages: '/:slug', categories: '/category/:slug', tags: '/tag/:slug', authors: '/author/:slug' };

function actorFor(db: Database, siteId: string): ExtensionActorDataAccess {
  const svc = () => new ItemService({ db, siteId });
  return {
    list: (c, p) => svc().list(c, p as never),
    detail: (c, id, f) => svc().detail(c, id, f),
    create: (c, payload) => svc().create(c, payload),
    patch: (c, id, patch) => svc().patch(c, id, patch as never),
    delete: (c, id) => svc().softDelete(c, id),
  };
}

interface SandboxItems {
  items: { patch(collection: string, id: string, patch: { data?: Record<string, unknown>; status?: string; expectedVersion?: number }): Promise<unknown> };
}
declare global {
  // eslint-disable-next-line no-var
  var __p12ContentCtx: SandboxItems | undefined;
}

describe.skipIf(!hasDbIntegrationUrl)('Plugin content extensions — DB integration (P12 tasks 2.1–2.5)', () => {
  let db: Database;
  let owner: postgres.Sql;
  let renderClient: postgres.Sql;
  let renderDb: Database;
  let classic: SiteClassic;
  let root: string;
  let themes: string;
  let glossaryId = '';
  let generation = 0;
  const terms: Record<string, string> = {};

  const ctx = (siteId: string) => ({ siteId, userId: null, roleId: null, user: null, ip: null, headers: {}, apiKey: null }) as never;
  const service = (siteId = A) => new ExtensionsService({ db, siteId, permissionCtx: ctx(siteId) });
  const items = (siteId = A) => new ItemService({ db, siteId });
  const get = async (path: string, host = HOST) => {
    const res = await classic.app.request(path, { headers: { host } });
    return { status: res.status, html: await res.text(), headers: res.headers };
  };
  const setEnabled = (enabled: boolean) => service().updateExtension(glossaryId, { enabled } as never);
  const term = async (slug: string, title: string, extra: Record<string, unknown> = {}) =>
    ((await items().create(TERMS, { data: { title, slug, body: `<p>${title} explained.</p>`, ...extra }, status: 'published', publishedAt: new Date('2026-09-01T00:00:00Z') })) as { id: string }).id;
  const refusal = async (p: Promise<unknown>) => {
    const err = await p.then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ExtensionMutationError);
    return err as ExtensionMutationError;
  };

  /** What a crawler reads in a head. */
  function seoOf(html: string) {
    const head = /<head>([\s\S]*?)<\/head>/.exec(html)?.[1] ?? '';
    const all = (re: RegExp) => [...head.matchAll(re)].map((m) => m.slice(1).join(' '));
    return {
      title: all(/<title>([^<]*)<\/title>/g),
      description: all(/<meta name="description" content="([^"]*)">/g),
      canonical: all(/<link rel="canonical" href="([^"]*)">/g),
      robots: all(/<meta name="robots" content="([^"]*)">/g),
      hreflang: all(/<link rel="alternate" hreflang="([^"]*)" href="([^"]*)">/g).sort(),
      jsonLd: [...head.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]!) as unknown),
    };
  }
  const graphOf = (html: string) => ((seoOf(html).jsonLd[0] as { '@graph'?: Array<Record<string, unknown>> } | undefined)?.['@graph'] ?? []);
  const sitemapUrls = async () => {
    const index = (await get('/sitemap.xml')).html;
    const urls: string[] = [];
    for (const m of index.matchAll(/<loc>([^<]+)<\/loc>/g)) {
      const shard = new URL(m[1]!).pathname;
      for (const u of (await get(shard)).html.matchAll(/<loc>([^<]+)<\/loc>/g)) urls.push(u[1]!);
    }
    return urls;
  };

  async function build(theme = 'official:starter'): Promise<{ live: string; snapshot: PageDataSnapshot }> {
    const snapshot = await exportPageData({ db: renderDb, siteId: A, now: () => NOW });
    const out = await buildSiteGeneration({ root, generation: ++generation, theme, snapshot, serve: servePageData, operatorThemesDir: themes });
    expect(out.ok, out.ok ? '' : out.error).toBe(true);
    return { live: out.ok ? out.outDir : '', snapshot };
  }

  beforeAll(async () => {
    expect(OWNER_URL, 'DATABASE_OWNER_URL is required to provision the rendering role').toBeDefined();
    db = await connectDbIntegration('content-extensions');
    owner = postgres(OWNER_URL!, { max: 1, onnotice: () => {} });
    const password = randomBytes(18).toString('hex');
    await owner.begin((tx) => ensureRenderRole(tx, { role: RENDER_ROLE, password }));
    const url = new URL(dbIntegrationUrl!);
    url.username = RENDER_ROLE;
    url.password = password;
    renderClient = postgres(url.toString(), { max: 2, onnotice: () => {} });
    renderDb = drizzle(renderClient, { schema }) as unknown as Database;
    classic = createSiteClassic({ db: renderDb, now: () => NOW, traffic: false, sweepIntervalMs: 0 });
    root = await mkdtemp(join(tmpdir(), 'heopress-p12-content-'));
    themes = await mkdtemp(join(tmpdir(), 'heopress-p12-themes-'));

    await db.delete(sites).where(inArray(sites.id, [A, B]));
    await db.insert(sites).values([
      { id: A, name: 'Glossary Site', defaultLanguage: 'en' },
      { id: B, name: 'Other Site', defaultLanguage: 'en' },
    ]);
    for (const id of [A, B]) await upgradeSitePreset(db, id);
    await db.insert(siteDomains).values([
      { siteId: A, hostname: HOST, kind: 'custom', status: 'active', isPrimary: true, verifiedAt: new Date('2026-09-01T00:00:00Z') },
      { siteId: B, hostname: HOST_B, kind: 'custom', status: 'active', isPrimary: true, verifiedAt: new Date('2026-09-01T00:00:00Z') },
    ]);
    for (const id of [A, B]) {
      const [r] = await db.select().from(siteContentSettings).where(eq(siteContentSettings.siteId, id));
      await new ContentSettingsService({ db, siteId: id, actor: { userId: null } }).update({
        availableLocales: ['en', 'fr'], timezone: 'UTC', siteType: 'blog', trailingSlash: 'always', localeStrategy: 'subdirectory',
        localePrefixMode: 'default_at_root', localePrefixes: {}, permalinks: PERMALINKS, allowCrossSiteTranslations: false,
        sponsorDisclosure: true, sponsorRel: true, version: r!.version,
      } as never);
      await rebuildSiteProjection(db, id);
    }
    await items().create('articles', { data: { title: 'Reading notes', slug: 'reading-notes', locale: 'en', body: '<p>Notes.</p>' }, status: 'published', publishedAt: new Date('2026-09-02T00:00:00Z') });
    await items().create('pages', { data: { title: 'Lexicon', slug: 'lexicon', locale: 'en', body: '<p>An existing page.</p>' }, status: 'published', publishedAt: new Date('2026-09-02T00:00:00Z') });

    // Admin, signature verified: these suites check content extensions, not the permission or signature gates.
    vi.spyOn(PermissionService.prototype, 'canAccess').mockImplementation(async (collection, action) => ({ collection, action, rule: null, fields: ['*'], presets: {}, validation: {}, sources: [] }) as never);
    vi.spyOn(ExtensionVerifierService.prototype, 'verifyByMetadata').mockResolvedValue({ ok: true, isOfficial: false, reason: 'ok' } as never);
  }, 180_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await db?.delete(sites).where(inArray(sites.id, [A, B]));
    await classic?.close();
    await renderClient?.end({ timeout: 2 });
    await owner?.end({ timeout: 2 });
    for (const dir of [root, themes]) if (dir) await rm(dir, { recursive: true, force: true });
    await rm(join(templateDir(), 'themes', '.operator'), { recursive: true, force: true });
    await rm(join(templateDir(), 'themes', '.ext'), { recursive: true, force: true });
  });

  // ---------- 2.1 collections ----------

  it('2.1: enabling installs the namespaced collection on this site only; items go through the mainline write path', async () => {
    const row = await service().installExtension(glossaryInstall({ enabled: true }));
    glossaryId = row!.id;
    const [coll] = await db.select().from(collections).where(and(eq(collections.siteId, A), eq(collections.name, TERMS)));
    expect(coll?.meta).toMatchObject({ extension: { name: GLOSSARY, namespace: GLOSSARY_NS, collection: 'terms' } });
    expect(await db.select().from(collections).where(and(eq(collections.siteId, B), eq(collections.name, TERMS)))).toEqual([]);
    terms.alpha = await term('alpha', 'Alpha');
    terms.beta = await term('beta', 'Beta');
    terms.gamma = await term('gamma', 'Gamma');
    // A revision: the history has to survive a disable too.
    await items().patch(TERMS, terms.alpha, { data: { body: '<p>Alpha, revised.</p>' }, expectedVersion: 1 } as never);
    expect((await get('/glossary/alpha/')).status).toBe(200);
  });

  it('2.1: the schema API neither creates a plugin-form collection nor renames or deletes a plugin\'s', async () => {
    const schemaSvc = new SchemaService({ db, siteId: A } as never);
    await expect(schemaSvc.createCollection({ name: 'acme_glossary__fake' } as never)).rejects.toMatchObject({ code: 'INVALID_NAME' });
    await expect(schemaSvc.deleteCollection(TERMS)).rejects.toMatchObject({ code: 'PLUGIN_COLLECTION' });
    await expect(schemaSvc.updateCollection(TERMS, { name: 'terms_renamed' })).rejects.toMatchObject({ code: 'PLUGIN_COLLECTION' });
  });

  it('2.1: plugin items are subject to the publish capability and Hold', async () => {
    const draft = ((await items().create(TERMS, { data: { title: 'Delta', slug: 'delta', body: '<p>Delta.</p>' } })) as { id: string }).id;
    const load = async (capabilities: string[]) => {
      globalThis.__p12ContentCtx = undefined;
      const sandbox = new ExtensionSandbox({}, { actorDataAccess: actorFor(db, A) });
      vi.spyOn(sandbox as unknown as { isTrustedBundleUrl(url: string): boolean }, 'isTrustedBundleUrl').mockReturnValue(true);
      const src = 'export default (ctx) => { globalThis.__p12ContentCtx = ctx; return {}; }';
      await sandbox.load({ name: GLOSSARY, bundleUrl: `data:text/javascript,${encodeURIComponent(src)}`, capabilities, verify: async () => true });
      return globalThis.__p12ContentCtx!;
    };
    const write = await load([`items:write:${TERMS}`]);
    await expect(write.items.patch(TERMS, draft, { status: 'published', expectedVersion: 1 })).rejects.toBeInstanceOf(CapabilityError);
    await items().setHold(TERMS, draft, true, 1);
    const publish = await load([`items:write:${TERMS}`, `items:publish:${TERMS}`]);
    const v = (await db.select({ v: itemsTable.version }).from(itemsTable).where(eq(itemsTable.id, draft)))[0]!.v;
    await expect(publish.items.patch(TERMS, draft, { status: 'published', expectedVersion: v })).rejects.toMatchObject({ code: 'ITEM_HELD' });
    expect((await db.select({ s: itemsTable.status }).from(itemsTable).where(eq(itemsTable.id, draft)))[0]!.s).toBe('draft');
    await items().softDelete(TERMS, draft);
  });

  it('2.1: a second plugin declaring the same collection gets its own; neither overwrites the other', async () => {
    const m = glossaryManifest();
    const beta = await service().installExtension(glossaryInstall({ name: 'beta/glossary', enabled: true, capabilities: ['ext:collections'], manifest: { collections: m.collections } }));
    const other = ((await items().create('beta_glossary__terms', { data: { title: 'Alpha (beta)', slug: 'alpha', body: '<p>Beta.</p>' } })) as { id: string }).id;
    const own = await db.select({ id: itemsTable.id, data: itemsTable.data }).from(itemsTable).innerJoin(collections, eq(collections.id, itemsTable.collectionId)).where(and(eq(itemsTable.siteId, A), eq(collections.name, TERMS)));
    expect(own.map((r) => r.id)).not.toContain(other);
    expect(own.find((r) => r.id === terms.alpha)?.data).toMatchObject({ title: 'Alpha' });
    await service().uninstallExtension(beta!.id);
    // Uninstalling keeps the data, too.
    expect(await db.select().from(itemsTable).where(eq(itemsTable.id, other))).toHaveLength(1);
  });

  // ---------- 2.3 / 2.4 / 2.5 rendering, enabled ----------

  it('2.3: Classic serves the item and list routes with the plugin\'s templates; both are indexable sitemap entries', async () => {
    const item = await get('/glossary/alpha/');
    expect(item.status).toBe(200);
    expect(item.html).toContain('class="glossary-term"');
    expect(item.html).toContain('Alpha, revised.');
    expect(seoOf(item.html).canonical).toEqual([`${ORIGIN}/glossary/alpha/`]);
    expect(seoOf(item.html).robots.join(' ')).not.toContain('noindex');
    const list = await get('/glossary/');
    expect(list.status).toBe(200);
    expect(list.html).toContain('class="glossary-index"');
    expect(seoOf(list.html).title[0]).toContain('Glossary');
    expect(seoOf(list.html).canonical).toEqual([`${ORIGIN}/glossary/`]);
    // Two a page: the third is on page 2.
    expect([...list.html.matchAll(/<li><a href/g)]).toHaveLength(2);
    const second = await get('/glossary/?page=2');
    expect(second.status).toBe(200);
    expect(second.html).toContain('Gamma');
    expect((await get('/fr/glossary/')).status).toBe(200);
    const urls = await sitemapUrls();
    expect(urls).toEqual(expect.arrayContaining([`${ORIGIN}/glossary/alpha/`, `${ORIGIN}/glossary/`]));
    // No French terms: the French list page answers, empty, and is not a sitemap entry.
    expect(urls).not.toContain(`${ORIGIN}/fr/glossary/`);
  });

  it('2.5: the plugin\'s structured data is merged into the page\'s one graph; the plugin wrote none itself', async () => {
    const { html } = await get('/glossary/alpha/');
    expect(seoOf(html).jsonLd).toHaveLength(1);
    expect(graphOf(html).some((n) => n['@type'] === 'Organization' && n.name === 'Acme Glossary')).toBe(true);
  });

  let enabledBuild: { live: string; snapshot: PageDataSnapshot };

  it('2.3: Astro builds the plugin pages from the page data; Classic and Astro say the same', async () => {
    enabledBuild = await build();
    const { live, snapshot } = enabledBuild;
    expect(snapshot.extensions?.hash).toBeTruthy();
    const paths = snapshot.pages.map((p) => p.path);
    expect(paths).toEqual(expect.arrayContaining(['/glossary/alpha/', '/glossary/beta/', '/glossary/gamma/', '/glossary/', '/fr/glossary/']));
    for (const path of ['/glossary/alpha/', '/glossary/', '/reading-notes/', '/']) {
      const fromClassic = await get(path);
      const fromAstro = await readFile(pageFile(live, path), 'utf8');
      expect(seoOf(fromAstro), path).toEqual(seoOf(fromClassic.html));
    }
    expect(await readFile(pageFile(live, '/glossary/alpha/'), 'utf8')).toContain('class="glossary-term"');
    expect(await readFile(pageFile(live, '/glossary/'), 'utf8')).toContain('class="glossary-index"');
    // The sitemap is the Classic engine's, byte for byte.
    for (const file of snapshot.files.filter((f) => f.path.startsWith('/sitemap'))) {
      expect(await readFile(join(live, file.path), 'utf8')).toBe((await get(file.path)).html);
    }
  }, 240_000);

  it('2.4: a plugin component renders nowhere a theme does not place it', async () => {
    // Only the plugin's own template places the badge; the starter themes do not.
    expect((await get('/glossary/alpha/')).html).toContain('glossary-badge');
    expect((await get('/reading-notes/')).html).not.toContain('glossary-badge');
    expect(await readFile(pageFile(enabledBuild.live, '/glossary/alpha/'), 'utf8')).toContain('glossary-badge');
    expect(await readFile(pageFile(enabledBuild.live, '/reading-notes/'), 'utf8')).not.toContain('glossary-badge');
  });

  it('2.3 / 2.4: a theme overrides the default template and places the component — Classic', async () => {
    const themeSvc = new ThemeService({ db, siteId: A, actor: { userId: null } });
    const top = BUILTIN_THEME['partials/top']!;
    const bottom = BUILTIN_THEME['partials/bottom']!;
    const v = await themeSvc.createVersion({
      name: 'glossary-aware',
      templates: {
        ...BUILTIN_THEME,
        item: `${top}<article><h1>{{ item.title }}</h1>{% if item.sponsor.sponsored %}{% sponsor_disclosure item %}{% endif %}{% item_body %}{% include 'ext/acme_glossary/components/badge' %}</article>${bottom}`,
        'ext/acme_glossary/term': `${top}<article class="theme-term"><h1>{{ item.title }}</h1>{% item_body %}</article>${bottom}`,
      },
    });
    expect(v.checks?.ok, JSON.stringify(v.checks)).toBe(true);
    await themeSvc.activate(v.id);
    const item = await get('/glossary/alpha/');
    expect(item.html).toContain('class="theme-term"');
    expect(item.html).not.toContain('class="glossary-term"');
    expect(seoOf(item.html).canonical).toEqual([`${ORIGIN}/glossary/alpha/`]);
    // The list route keeps the plugin's default.
    expect((await get('/glossary/')).html).toContain('class="glossary-index"');
    expect((await get('/reading-notes/')).html).toContain('glossary-badge');
  });

  it('2.3 / 2.4: a theme overrides the default template and places the component — Astro', async () => {
    const dir = join(themes, 'glossary-aware');
    await cp(join(templateDir(), 'themes', 'starter'), dir, { recursive: true });
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as { heopress: { astroTheme: Record<string, unknown> } };
    pkg.heopress.astroTheme.extensionTemplates = { 'acme_glossary/term': 'src/Term.astro' };
    await writeFile(join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
    const entry = join(dir, 'src', 'Page.astro');
    let page = await readFile(entry, 'utf8');
    page = page.replace("import './style.css';", "import './style.css';\nimport GlossaryBadge from 'heopress:ext/acme_glossary/badge';");
    page = page.replace('<ItemBody page={page} />', '<ItemBody page={page} /><GlossaryBadge page={page} />');
    await writeFile(entry, page);
    await writeFile(join(dir, 'src', 'Term.astro'), `---
import type { PageDataPage } from '@heopress/astro-kit';
import SeoHead from '@heopress/astro-kit/SeoHead.astro';
import ItemBody from '@heopress/astro-kit/ItemBody.astro';
interface Props { page: PageDataPage }
const { page } = Astro.props;
---
<html lang={page.vm.page.locale}><head><meta charset="utf-8"><SeoHead page={page} /></head>
<body><article class="theme-term"><h1>{page.vm.item?.title}</h1><ItemBody page={page} /></article></body></html>
`);
    const { live } = await build('operator:glossary-aware');
    const item = await readFile(pageFile(live, '/glossary/alpha/'), 'utf8');
    expect(item).toContain('class="theme-term"');
    expect(item).not.toContain('class="glossary-term"');
    expect(seoOf(item)).toEqual(seoOf((await get('/glossary/alpha/')).html));
    expect(await readFile(pageFile(live, '/glossary/'), 'utf8')).toContain('class="glossary-index"');
    expect(await readFile(pageFile(live, '/reading-notes/'), 'utf8')).toContain('glossary-badge');
  }, 240_000);

  // ---------- 2.2 route conflicts ----------

  it('2.2: enabling is refused, with the conflicting paths listed: another plugin, existing content, a system path, a language prefix', async () => {
    const m = glossaryManifest() as { routes: Array<Record<string, unknown>> };
    const withRoutes = (name: string, paths: Record<string, string>) =>
      glossaryManifest({ routes: m.routes.map((r) => ({ ...r, path: paths[r.id as string] })) }, name.replace('/', '_'));
    const cases: Array<[string, Record<string, string>, string, string]> = [
      ['other/glossary', { term: '/glossary/:slug', index: '/glossary' }, '/glossary', 'plugin'],
      ['lex/glossary', { term: '/terms/:slug', index: '/lexicon' }, '/lexicon/', 'content'],
      // The spec's case: the item route's section is a page already.
      ['sec/glossary', { term: '/lexicon/:slug', index: '/terms' }, '/lexicon/', 'content'],
      ['sys/glossary', { term: '/api/:slug', index: '/terms' }, '/api', 'system-path'],
      ['loc/glossary', { term: '/fr/:slug', index: '/terms' }, '/fr', 'locale-prefix'],
    ];
    for (const [name, paths, path, reason] of cases) {
      const row = await service().installExtension(glossaryInstall({ name, manifest: withRoutes(name, paths) }));
      const err = await refusal(service().updateExtension(row!.id, { enabled: true } as never));
      expect(err.code, name).toBe('ROUTE_CONFLICT');
      expect(err.message, name).toContain(path);
      expect((err.details?.conflicts as Array<{ path: string; reason: string }>), name).toContainEqual(expect.objectContaining({ path, reason }));
      const [after] = await db.select({ enabled: extensions.enabled }).from(extensions).where(eq(extensions.id, row!.id));
      expect(after!.enabled, name).toBe(false);
      await service().uninstallExtension(row!.id);
    }
    // The page that was there still answers.
    expect((await get('/lexicon/')).html).toContain('An existing page.');
    // And the other way round: while the plugin is enabled, no other item takes its paths.
    await expect(items().create('pages', { data: { title: 'Glossary page', slug: 'glossary', locale: 'en', body: '<p>x</p>' }, status: 'published' })).rejects.toMatchObject({ code: 'PATH_RESERVED' });
  });

  // ---------- disable: 2.1 data kept, 2.3–2.5 withdrawn ----------

  it('2.1 / 2.3–2.5: disabling withdraws pages, sitemap entries, components and the structured data in both engines; the data stays', async () => {
    const before = await db.select().from(itemsTable).where(inArray(itemsTable.id, Object.values(terms))).orderBy(itemsTable.id);
    await setEnabled(false);
    expect((await get('/glossary/alpha/')).status).toBe(404);
    expect((await get('/glossary/')).status).toBe(404);
    expect((await sitemapUrls()).filter((u) => u.includes('/glossary/'))).toEqual([]);
    const article = await get('/reading-notes/');
    expect(article.status).toBe(200);
    expect(article.html).not.toContain('glossary-badge');
    expect(graphOf(article.html).some((n) => n.name === 'Acme Glossary')).toBe(false);

    const { live, snapshot } = await build('operator:glossary-aware');
    expect(snapshot.extensions).toBeUndefined();
    expect(snapshot.pages.map((p) => p.path).filter((p) => p.startsWith('/glossary'))).toEqual([]);
    const astroArticle = await readFile(pageFile(live, '/reading-notes/'), 'utf8');
    expect(astroArticle).not.toContain('glossary-badge');
    expect(seoOf(astroArticle)).toEqual(seoOf(article.html));
    await expect(readFile(pageFile(live, '/glossary/alpha/'), 'utf8')).rejects.toThrow();

    // The data is intact, history included.
    const after = await db.select().from(itemsTable).where(inArray(itemsTable.id, Object.values(terms))).orderBy(itemsTable.id);
    expect(after).toEqual(before);

    // Re-enabled: the same items, the same pages.
    await setEnabled(true);
    expect(await db.select().from(itemsTable).where(inArray(itemsTable.id, Object.values(terms))).orderBy(itemsTable.id)).toEqual(before);
    const back = await get('/glossary/alpha/');
    expect(back.status).toBe(200);
    expect(back.html).toContain('Alpha, revised.');
  }, 240_000);

  // ---------- 2.1 hard delete ----------

  it('2.1: hard delete needs the plugin disabled, the namespace typed and an export newer than the last change', async () => {
    const svc = service();
    const listed = await svc.listPluginCollections();
    expect(listed.find((c) => c.name === TERMS)).toMatchObject({ namespace: GLOSSARY_NS, plugin: GLOSSARY, items: expect.any(Number) });
    expect((await refusal(svc.purgePluginCollections(GLOSSARY_NS, { confirm: 'yes' }))).code).toBe('CONFIRMATION_REQUIRED');
    expect((await refusal(svc.purgePluginCollections(GLOSSARY_NS, { confirm: GLOSSARY_NS }))).code).toBe('PLUGIN_ENABLED');
    await setEnabled(false);
    expect((await refusal(svc.purgePluginCollections(GLOSSARY_NS, { confirm: GLOSSARY_NS }))).code).toBe('EXPORT_REQUIRED');
    const first = await svc.exportPluginCollections(GLOSSARY_NS);
    expect(first.format).toBe('heopress-plugin-collections@1');
    expect(first.collections.find((c) => c.name === TERMS)?.items.map((i) => i.id)).toEqual(expect.arrayContaining(Object.values(terms)));
    // A change after the export: that export no longer covers the data.
    const v = (await db.select({ v: itemsTable.version }).from(itemsTable).where(eq(itemsTable.id, terms.beta!)))[0]!.v;
    await new Promise((r) => setTimeout(r, 5));
    await items().patch(TERMS, terms.beta!, { data: { title: 'Beta, edited' }, expectedVersion: v } as never);
    expect((await refusal(svc.purgePluginCollections(GLOSSARY_NS, { confirm: GLOSSARY_NS, exportDigest: first.digest }))).code).toBe('EXPORT_STALE');
    const fresh = await svc.exportPluginCollections(GLOSSARY_NS);
    expect(await svc.purgePluginCollections(GLOSSARY_NS, { confirm: GLOSSARY_NS, exportDigest: fresh.digest })).toEqual({ deleted: [TERMS] });
    expect(await db.select().from(collections).where(and(eq(collections.siteId, A), eq(collections.name, TERMS)))).toEqual([]);
    expect(await db.select().from(itemsTable).where(inArray(itemsTable.id, Object.values(terms)))).toEqual([]);
  });
});
