import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { auditLog, ensureRenderRole, extensions, items as itemsTable, publicItems as publicItemsTable, projectionRebuilds, renderCache, schema, siteContentSettings, siteDomains, siteRenderVersions, sites, type Database } from '@heopress/database';
import { createSiteClassic, type SiteClassic } from '@heopress/site-classic';
import { renderPort } from '@heopress/site-classic/read-port';
import { cachedPage, cacheKey } from '@heopress/site-classic/cache';
import { BUILTIN_THEME_ID, publicUrlOf, resolvePublicPathWith } from '@heopress/public-site';
import { ItemService } from '../services/item-service';
import { SchemaService } from '../services/schema-service';
import { runSiteTransaction } from '../services/rls-transaction';
import { ContentSettingsService } from '../services/site-network/content-settings-service';
import { SeoSettingsService } from '../services/site-network/seo-settings-service';
import { SiteIdentityService } from '../services/site-network/site-identity-service';
import { upgradeSitePreset } from '../services/site-network/preset-installer';
import { processProjectionRebuilds, rebuildSiteProjection } from '../services/site-network/public-projection';
import { structuredDataReportOf } from '../services/site-network/structured-data-report';
import { RootFilesService } from '../services/site-network/root-files';
import { ExtensionsService } from '../services/extensions-service';
import { ExtensionVerifierService } from '../services/extension-verifier';
import { PermissionService } from '../services/permission-service';
import { contributionFragment, parseItemRobots } from '@heopress/seo-geo';
import { schemaErrors } from '../../../site-classic/src/__tests__/xml-schemas';
import { connectDbIntegration, dbIntegrationUrl, hasDbIntegrationUrl } from './helpers/db-harness';

/**
 * The classic rendering service over HTTP (HeoPress P06 tasks 1.1–1.4; spec rendering/classic-engine,
 * i18n/locale-routing): content written through the CMS services, served by `site-classic` connected
 * as the rendering role — two hosts, two sites; 200 / 301 / 404 / 410 / 503; home, article, category,
 * tag and author lists with pagination, search; the three language entries; no administration surface.
 *
 * Needs DATABASE_OWNER_URL (to provision the rendering role, as a deployment does).
 */

const A = 'site_p06_classic_a';
const B = 'site_p06_classic_b';
const HOST_A = 'sc-a.example.com';
const HOST_B = 'sc-b.example.com';
const ALIAS_A = 'www.sc-a.example.com';
const JA_SUBDOMAIN = 'ja.sc-a.example.com';
const FR_DOMAIN = 'sc-a.example.fr';
const RENDER_ROLE = 'heopress_render_it';
const OWNER_URL = process.env.DATABASE_OWNER_URL?.trim() || undefined;

describe.skipIf(!hasDbIntegrationUrl)('site-classic over HTTP — DB integration', () => {
  let db: Database;
  let owner: postgres.Sql;
  let renderClient: postgres.Sql;
  let renderDb: Database;
  let service: SiteClassic;
  let app: SiteClassic['app'];

  beforeAll(async () => {
    expect(OWNER_URL, 'DATABASE_OWNER_URL is required to provision the rendering role').toBeDefined();
    db = await connectDbIntegration('site-classic');
    owner = postgres(OWNER_URL!, { max: 1, onnotice: () => {} });
    const password = randomBytes(18).toString('hex');
    await owner.begin((tx) => ensureRenderRole(tx, { role: RENDER_ROLE, password }));
    const url = new URL(dbIntegrationUrl!);
    url.username = RENDER_ROLE;
    url.password = password;
    renderClient = postgres(url.toString(), { max: 2, onnotice: () => {} });
    renderDb = drizzle(renderClient, { schema }) as unknown as Database;
    service = createSiteClassic({ db: renderDb });
    app = service.app;
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
      { id: A, name: 'Site Alpha', defaultLanguage: 'en' },
      { id: B, name: 'Site Beta', defaultLanguage: 'en' },
    ]);
    for (const id of [A, B]) await upgradeSitePreset(db, id);
    await db.insert(siteDomains).values([
      { siteId: A, hostname: HOST_A, kind: 'custom', status: 'active', isPrimary: true, verifiedAt: new Date() },
      { siteId: A, hostname: ALIAS_A, kind: 'custom', status: 'active', verifiedAt: new Date() },
      { siteId: A, hostname: JA_SUBDOMAIN, kind: 'custom', status: 'active', entryLocale: 'ja', verifiedAt: new Date() },
      { siteId: A, hostname: FR_DOMAIN, kind: 'custom', status: 'active', entryLocale: 'fr', verifiedAt: new Date() },
      { siteId: B, hostname: HOST_B, kind: 'custom', status: 'active', isPrimary: true, verifiedAt: new Date() },
    ]);
    const permalinks = { articles: '/:slug', pages: '/:slug', categories: '/category/:slug', tags: '/tag/:slug', authors: '/author/:slug' };
    await settings(A, { availableLocales: ['en', 'zh-CN', 'ja', 'fr'], localePrefixes: { 'zh-CN': 'zh' }, permalinks });
    await settings(B, { permalinks });
    // The domains above were written past the services: rebuild, as a deployment does first.
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
      sponsorDisclosure: true,
      sponsorRel: true,
      version: r!.version,
      ...over,
    } as never);
  }

  const items = (siteId: string) => new ItemService({ db, siteId });
  const article = (siteId: string, slug: string, data: Record<string, unknown> = {}, status = 'published') =>
    items(siteId).create('articles', { data: { title: `Title ${slug}`, slug, locale: 'en', ...data }, status }) as Promise<{ id: string; version: number }>;
  const term = (siteId: string, collection: 'categories' | 'tags' | 'authors', slug: string) =>
    items(siteId).create(collection, { data: { name: `Term ${slug}`, slug }, status: 'published' }) as Promise<{ id: string; version: number }>;
  const get = (host: string, path: string, headers: Record<string, string> = {}) => app.request(path, { headers: { host, ...headers } });
  /** A page without the system's JSON-LD script (exactly one, in the head; P07): what is left must hold no script. */
  const withoutJsonLd = (html: string) => {
    const scripts = html.match(/<script type="application\/ld\+json">[^<]*<\/script>/g) ?? [];
    expect(scripts.length).toBeLessThanOrEqual(1);
    return html.replace(/<script type="application\/ld\+json">[^<]*<\/script>/, '');
  };

  it('upgrade from P05: a site never built is in maintenance until migration 0040 marks it and the worker job builds it (Codex review, task 5.2)', async () => {
    await article(A, 'before-p06');
    // As before the projection existed: no built site row.
    await owner`DELETE FROM lumibase_public_sites WHERE site_id = ${A}`;
    await owner`DELETE FROM lumibase_projection_rebuilds WHERE site_id IN (${A}, ${B})`;
    expect((await get(HOST_A, '/before-p06/')).status).toBe(503);
    const migration = readFileSync(path.resolve(__dirname, '../../../../packages/database/drizzle/0040_initial_projection_build.sql'), 'utf8');
    await owner.unsafe(migration);
    const marked = await owner`SELECT site_id FROM lumibase_projection_rebuilds WHERE site_id IN (${A}, ${B})`;
    expect(marked.map((r) => r.site_id)).toContain(A);
    // Run twice: no second mark for a site already marked.
    await owner.unsafe(migration);
    expect((await owner`SELECT count(*)::int AS n FROM lumibase_projection_rebuilds WHERE site_id = ${A}`)[0]!.n).toBe(1);
    // The worker's job, until the queue is empty (other suites' sites share this database).
    while ((await processProjectionRebuilds(db, { limit: 500 })).rebuilt.length > 0);
    expect((await get(HOST_A, '/before-p06/')).status).toBe(200);
    expect((await get(HOST_B, '/')).status).toBe(200);
  });

  it('task 1.1: each host answers with its own site; an unknown host is 404, never a default site', async () => {
    const a = await get(HOST_A, '/');
    expect(a.status).toBe(200);
    expect(await a.text()).toContain('Site Alpha');
    const b = await get(HOST_B, '/');
    expect(b.status).toBe(200);
    const body = await b.text();
    expect(body).toContain('Site Beta');
    expect(body).not.toContain('Site Alpha');
    const unknown = await get('nobody.example.org', '/');
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toBe('Not found');
  });

  it('an article: 200 on its site with public fields only; 404 on the other site, as a draft, or a path no one has', async () => {
    await article(A, 'hello', { body: '<p>Hello <strong>world</strong></p>' });
    await article(A, 'secret-draft', {}, 'draft');
    const res = await get(HOST_A, '/hello/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('Title hello');
    // Rendered by the theme engine: the SEO head is the system's.
    expect(html).toContain('<title>Title hello · Site Alpha</title>');
    expect(html).toContain('<strong>world</strong>');
    expect(html).toContain(`<link rel="canonical" href="https://${HOST_A}/hello/">`);
    expect((await get(HOST_B, '/hello/')).status).toBe(404);
    // Not even resolved there: the projection read keeps to the requesting site.
    expect(await renderPort(renderDb).request(B, (port) => resolvePublicPathWith(port, { host: HOST_B, path: '/hello/' }))).toMatchObject({ kind: 'not_found', siteId: B });
    expect((await get(HOST_A, '/secret-draft/')).status).toBe(404);
    expect((await get(HOST_A, '/no-such-thing/')).status).toBe(404);
  });

  describe('HeoPress P07 batch 3: the head from the SEO data layer', () => {
    const seo = (siteId: string) => new SeoSettingsService({ db, siteId, actor: { userId: null } });
    const headOf = (html: string) => /<head>([\s\S]*?)<\/head>/.exec(html)?.[1] ?? '';
    const robotsOf = (html: string) => /<meta name="robots" content="([^"]*)">/.exec(html)?.[1] ?? null;

    it('tasks 1.2, 2.1, 2.11: an article — template title, SEO description, absolute self canonical, snippet directives, social metadata', async () => {
      await article(A, 'meta-post', { excerpt: 'The excerpt.', seo_description: 'The SEO description.' });
      const res = await get(HOST_A, '/meta-post/');
      expect(res.status).toBe(200);
      expect(res.headers.get('x-robots-tag')).toBeNull();
      const head = headOf(await res.text());
      expect(head).toContain('<title>Title meta-post · Site Alpha</title>');
      expect(head).toContain('<meta name="description" content="The SEO description.">');
      expect(head).toContain(`<link rel="canonical" href="https://${HOST_A}/meta-post/">`);
      expect(robotsOf(head)).toBe('max-image-preview:large');
      expect(head).toContain(`<meta property="og:url" content="https://${HOST_A}/meta-post/">`);
      expect(head).toContain('<meta property="og:type" content="article">');
      // The item's own SEO title is the whole title; its canonical override, when absolute.
      await article(A, 'own-title', { seo_title: 'An own title', canonical_url: 'https://example.org/original/' });
      const own = headOf(await (await get(HOST_A, '/own-title/')).text());
      expect(own).toContain('<title>An own title</title>');
      expect(own).toContain('<link rel="canonical" href="https://example.org/original/">');
    });

    it('task 1.4: a settings change shows at once — templates and snippet directives, on this site only', async () => {
      await article(A, 'tpl');
      await article(B, 'tpl');
      expect(headOf(await (await get(HOST_A, '/tpl/')).text())).toContain('<title>Title tpl · Site Alpha</title>');
      await seo(A).update({ version: 0, titleTemplate: '{site} | {title}', snippet: { maxSnippet: 50, maxImagePreview: 'standard' } });
      const head = headOf(await (await get(HOST_A, '/tpl/')).text());
      expect(head).toContain('<title>Site Alpha | Title tpl</title>');
      expect(robotsOf(head)).toBe('max-snippet:50, max-image-preview:standard');
      expect(headOf(await (await get(HOST_B, '/tpl/')).text())).toContain('<title>Title tpl · Site Beta</title>');
    });

    it('tasks 2.4, 2.12: one JSON-LD graph per page — the identity on the home, the article with its breadcrumb; a noindex page describes the site only', async () => {
      const graphsOf = (html: string) => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]!) as { '@graph': Array<Record<string, unknown>> });
      const typesOf = (html: string) => graphsOf(html)[0]!['@graph'].map((n) => n['@type']);
      // No identity yet: nothing made up.
      await article(A, 'ld-post', { excerpt: 'An excerpt.' });
      expect(typesOf(await (await get(HOST_A, '/')).text())).toEqual(['WebSite', 'WebPage']);
      // A person with a name and two profiles (spec "个人站点").
      await new SiteIdentityService({ db, siteId: A, actor: { userId: null } }).update({ version: 0, kind: 'person', name: 'Sam Example', sameAs: ['https://social.example.com/sam', 'https://code.example.com/sam'] });
      const home = await (await get(HOST_A, '/')).text();
      expect(graphsOf(home)).toHaveLength(1);
      const person = graphsOf(home)[0]!['@graph'].find((n) => n['@type'] === 'Person');
      expect(person).toEqual({ '@type': 'Person', '@id': `https://${HOST_A}/#identity`, name: 'Sam Example', url: `https://${HOST_A}/`, sameAs: ['https://social.example.com/sam', 'https://code.example.com/sam'] });
      expect(typesOf(home)).toEqual(['Person', 'WebSite', 'WebPage']);
      // The article: its page, breadcrumb (home → article) and the article itself; one graph.
      const post = await (await get(HOST_A, '/ld-post/')).text();
      expect(graphsOf(post)).toHaveLength(1);
      expect(typesOf(post)).toEqual(['Person', 'WebSite', 'WebPage', 'BreadcrumbList', 'BlogPosting']);
      const posting = graphsOf(post)[0]!['@graph'].find((n) => n['@type'] === 'BlogPosting')!;
      expect(posting).toMatchObject({ '@id': `https://${HOST_A}/ld-post/#article`, headline: 'Title ld-post', description: 'An excerpt.', author: { '@id': `https://${HOST_A}/#identity` } });
      expect(posting.dateModified).toBeDefined();
      // Not indexed: the site only (spec "不可收录页面").
      await article(A, 'ld-hidden', { seo_robots: 'noindex,follow' });
      expect(typesOf(await (await get(HOST_A, '/ld-hidden/')).text())).toEqual(['Person', 'WebSite']);
      // The other site's pages do not name this identity.
      await article(B, 'ld-post');
      expect(JSON.stringify(graphsOf(await (await get(HOST_B, '/ld-post/')).text()))).not.toContain('Sam Example');
    });

    it('task 2.4: FAQPage from the questions-and-answers field only — not from a heading that ends in a question mark', async () => {
      const graphOf = async (p: string) =>
        (JSON.parse(/<script type="application\/ld\+json">([^<]*)<\/script>/.exec(await (await get(HOST_A, p)).text())![1]!) as { '@graph': Array<Record<string, unknown>> })['@graph'];
      await article(A, 'faq-post', { body: '<h2>Why is the sky blue?</h2><p>Because of scattering.</p>', faq: [{ question: 'Why is the sky blue?', answer: 'Rayleigh scattering.' }] });
      await article(A, 'question-heading', { body: '<h2>Why is the sky blue?</h2><p>Because of scattering.</p>' });
      const faq = (await graphOf('/faq-post/')).find((n) => n['@type'] === 'FAQPage');
      expect(faq).toMatchObject({ mainEntity: [{ '@type': 'Question', name: 'Why is the sky blue?', acceptedAnswer: { '@type': 'Answer', text: 'Rayleigh scattering.' } }] });
      expect((await graphOf('/question-heading/')).some((n) => n['@type'] === 'FAQPage')).toBe(false);
      // The public row holds the questions and answers only (the rows' block ids are not public).
      const [row] = await db.select({ data: publicItemsTable.data }).from(publicItemsTable).where(and(eq(publicItemsTable.siteId, A), eq(publicItemsTable.path, '/faq-post')));
      expect(row!.data.faq).toEqual([{ question: 'Why is the sky blue?', answer: 'Rayleigh scattering.' }]);
    });

    const graphAt = async (host: string, p: string) => {
      const scripts = [...(await (await get(host, p)).text()).matchAll(/<script type="application\/ld\+json">([^<]*)<\/script>/g)];
      expect(scripts).toHaveLength(1);
      return (JSON.parse(scripts[0]![1]!) as { '@graph': Array<Record<string, unknown>> })['@graph'];
    };

    it("tasks 2.9, 2.10: an item's own Event is a node of the one graph, the page refers to it; what is refused is reported once; a noindex page carries none of it", async () => {
      const event = { '@context': 'https://schema.org', '@type': 'Event', '@id': '#event', name: 'Launch', startDate: '2026-11-01T10:00:00Z', location: { '@id': '#venue' } };
      // A reference to the page's own image: the page has it, and the stored diagnostics say nothing about it (Codex review of batch 5c).
      await article(A, 'ev-img', { seo_image: 'https://example.com/i.png', structured_data: JSON.stringify({ '@type': 'Event', '@id': '#e', image: { '@id': '#primaryimage' } }) });
      expect((await graphAt(HOST_A, '/ev-img/')).find((n) => n['@id'] === `https://${HOST_A}/ev-img/#e`)).toMatchObject({ image: { '@id': `https://${HOST_A}/ev-img/#primaryimage` } });
      await article(A, 'ev', { structured_data: JSON.stringify(event) });
      const graph = await graphAt(HOST_A, '/ev/');
      const url = `https://${HOST_A}/ev/`;
      expect(graph.find((n) => n['@id'] === `${url}#event`)).toEqual({ '@id': `${url}#event`, '@type': 'Event', name: 'Launch', startDate: '2026-11-01T10:00:00Z' });
      expect(graph.find((n) => n['@id'] === `${url}#webpage`)).toMatchObject({ about: [{ '@id': `${url}#event` }] });
      // Not a public field: the text itself is in no public data.
      const [row] = await db.select({ data: publicItemsTable.data }).from(publicItemsTable).where(and(eq(publicItemsTable.siteId, A), eq(publicItemsTable.path, '/ev')));
      expect(row!.data.structured_data).toBeUndefined();
      // Refused nodes: a second page, a node of another address, a second article.
      await article(A, 'ev-bad', {
        structured_data: JSON.stringify([{ '@type': 'WebPage' }, { '@type': 'Event', '@id': 'https://elsewhere.example.com/#x' }, { '@type': 'BlogPosting', '@id': '#post' }, { '@type': 'Event', '@id': '#ok' }]),
      });
      const bad = await graphAt(HOST_A, '/ev-bad/');
      expect(bad.filter((n) => n['@type'] === 'WebPage')).toHaveLength(1);
      expect(bad.filter((n) => n['@type'] === 'BlogPosting')).toHaveLength(1);
      expect(bad.map((n) => n['@id'])).toContain(`https://${HOST_A}/ev-bad/#ok`);
      // Not indexed: the site only, every contributed node reported as left out.
      await article(A, 'ev-hidden', { seo_robots: 'noindex,follow', structured_data: JSON.stringify(event) });
      expect((await graphAt(HOST_A, '/ev-hidden/')).map((n) => n['@type'])).toEqual(['WebSite']);
      // Rebuilt twice: each removal reported once.
      await rebuildSiteProjection(db, A);
      await rebuildSiteProjection(db, A);
      const report = await structuredDataReportOf(db, A);
      const codes = (p: string) => report.items.find((i) => i.path === p)?.diagnostics.map((d) => d.code);
      // The Event's reference to a venue the page does not have: removed (the final check), and reported.
      expect(codes('/ev')).toEqual(['dangling-reference']);
      expect(codes('/ev-bad')).toEqual(['reserved-type', 'foreign-id', 'reserved-type']);
      expect(codes('/ev-hidden')).toEqual(['ineligible-node']);
      expect(codes('/ev-img')).toBeUndefined();
      // Stored: only what the page keeps (Codex review of batch 5c) — nothing for the page that is not indexed.
      const stored = async (p: string) =>
        ((await db.select({ s: publicItemsTable.structured }).from(publicItemsTable).where(and(eq(publicItemsTable.siteId, A), eq(publicItemsTable.path, p))))[0]!.s as { nodes?: Array<{ fragment: string }> }).nodes?.map((n) => n.fragment);
      expect(await stored('/ev-bad')).toEqual(['ok']);
      expect(await stored('/ev-hidden')).toBeUndefined();
      // Canonical to another address: a declared duplicate carries nothing contributed — not stored, and reported.
      await article(A, 'ev-dup', { canonical_url: 'https://example.org/original/', structured_data: JSON.stringify(event) });
      expect((await graphAt(HOST_A, '/ev-dup/')).map((n) => n['@type'])).toEqual(['WebSite']);
      expect(await stored('/ev-dup')).toBeUndefined();
      expect((await structuredDataReportOf(db, A)).items.find((i) => i.path === '/ev-dup')?.diagnostics.map((d) => d.code)).toEqual(['ineligible-node']);
      expect(report.itemsWithDiagnostics).toBe(3);
      expect((await structuredDataReportOf(db, B)).items).toEqual([]);
    });

    it('task 2.9: extension contributions follow install, upgrade, disable and uninstall — warm caches, one site only; a site node takes no item body (2.10)', async () => {
      await article(A, 'x-post', { body: '<p>Public body.</p>' });
      await article(A, 'x-hidden', { seo_robots: 'noindex,follow', body: '<p>SECRET-HIDDEN-BODY</p>' });
      await article(B, 'x-post');
      const partner = (version: string, eventName: unknown) => ({
        siteId: A,
        key: 'seo-partner',
        name: 'seo-partner',
        version,
        type: 'hook',
        enabled: true,
        bundleUrl: 'https://example.com/partner.js',
        capabilities: ['seo:structured-data'],
        manifest: {
          structuredData: [
            { key: 'event', scope: 'item', collections: ['articles'], node: { '@type': 'Event', name: eventName } },
            // Claims the site, and tries to carry an item's body (scenario 贡献方夹带正文).
            { key: 'org', scope: 'site', node: { '@type': 'Organization', name: 'Partner', description: { $field: 'body' } } },
          ],
        },
      });
      const write = <T,>(fn: (tx: Database) => Promise<T>) => runSiteTransaction(db, A, (tx) => fn(tx as unknown as Database));
      const version = async () => (await db.select({ v: siteRenderVersions.version }).from(siteRenderVersions).where(eq(siteRenderVersions.siteId, A)))[0]!.v;
      const ids = async (p: string) => (await graphAt(HOST_A, p)).map((n) => n['@id']);
      const eventId = `https://${HOST_A}/x-post/#ext-seo-partner_event`;
      const orgId = `https://${HOST_A}/#ext-seo-partner_org`;
      // Warm: the pages cached before each change.
      const warm = async () => {
        for (const p of ['/x-post/', '/x-hidden/', '/']) await get(HOST_A, p);
        expect((await db.select({ key: renderCache.key }).from(renderCache).where(eq(renderCache.siteId, A))).length).toBeGreaterThan(0);
      };
      await warm();
      expect(await ids('/x-post/')).not.toContain(eventId);

      // Install (enabled, granted): materialised in the same transaction, the render version raised.
      let before = await version();
      const [row] = await write((tx) => tx.insert(extensions).values(partner('1.0.0', { $field: 'title' })).returning());
      expect(await version()).toBeGreaterThan(before);
      let graph = await graphAt(HOST_A, '/x-post/');
      expect(graph.find((n) => n['@id'] === eventId)).toEqual({ '@id': eventId, '@type': 'Event', name: 'Title x-post' });
      expect(graph.find((n) => n['@id'] === orgId)).toEqual({ '@id': orgId, '@type': 'Organization', name: 'Partner' });
      expect(await ids('/')).toContain(orgId);
      // Not indexed: neither node, and the hidden body in no page's structured data.
      expect(await ids('/x-hidden/')).toEqual([`https://${HOST_A}/#website`]);
      for (const p of ['/x-post/', '/x-hidden/', '/']) expect(JSON.stringify(await graphAt(HOST_A, p))).not.toMatch(/SECRET-HIDDEN-BODY|Public body/);
      // Site B: untouched.
      expect(JSON.stringify(await graphAt(HOST_B, '/x-post/'))).not.toContain('ext-seo-partner');
      const report = await structuredDataReportOf(db, A);
      expect(report.site.nodes).toEqual([{ source: 'extension:seo-partner', fragment: 'ext-seo-partner_org', type: 'Organization' }]);
      expect(report.site.diagnostics.map((d) => d.code)).toEqual(['site-node-item-field']);

      // Upgrade: a new version with another node — the warm pages follow.
      await warm();
      before = await version();
      await write((tx) => tx.update(extensions).set(partner('2.0.0', 'Renamed')).where(eq(extensions.id, row!.id)));
      expect(await version()).toBeGreaterThan(before);
      expect((await graphAt(HOST_A, '/x-post/')).find((n) => n['@id'] === eventId)).toMatchObject({ name: 'Renamed' });
      const [stored] = await db.select({ s: publicItemsTable.structured }).from(publicItemsTable).where(and(eq(publicItemsTable.siteId, A), eq(publicItemsTable.path, '/x-post')));
      const fingerprint = ((stored!.s as { nodes: Array<{ fingerprint?: string }> }).nodes[0]!).fingerprint;
      expect(fingerprint).toMatch(/^[0-9a-f]{32}$/);

      // Disable: gone at once.
      await warm();
      await write((tx) => tx.update(extensions).set({ enabled: false }).where(eq(extensions.id, row!.id)));
      expect(await ids('/x-post/')).not.toContain(eventId);
      expect(await ids('/')).not.toContain(orgId);
      // Enabled again, then uninstalled: gone again.
      await write((tx) => tx.update(extensions).set({ enabled: true }).where(eq(extensions.id, row!.id)));
      expect(await ids('/x-post/')).toContain(eventId);
      await warm();
      before = await version();
      await write((tx) => tx.delete(extensions).where(eq(extensions.id, row!.id)));
      expect(await version()).toBeGreaterThan(before);
      expect(await ids('/x-post/')).not.toContain(eventId);
      expect(await ids('/')).not.toContain(orgId);
      expect((await structuredDataReportOf(db, A)).site).toEqual({ nodes: [], diagnostics: [] });

      // Without the capability: nothing contributed, and the report says why. A change of an extension that contributes
      // nothing is not recorded: the render version stays.
      before = await version();
      await write((tx) => tx.insert(extensions).values({ ...partner('1.0.0', 'x'), capabilities: [] }));
      expect(await version()).toBe(before);
      expect(await ids('/x-post/')).not.toContain(eventId);
      await rebuildSiteProjection(db, A);
      expect((await structuredDataReportOf(db, A)).site.diagnostics).toEqual([
        { code: 'invalid-contribution', source: 'extension:seo-partner', message: 'not granted seo:structured-data: its structured data is not used' },
      ]);
      expect(await db.select().from(projectionRebuilds).where(eq(projectionRebuilds.siteId, A))).toEqual([]);

      // Two enabled extensions with the same key would name the same nodes: the second is left out, and the report says so.
      await write((tx) => tx.delete(extensions).where(eq(extensions.siteId, A)));
      await write((tx) => tx.insert(extensions).values([partner('1.0.0', 'first'), partner('1.0.0', 'second')]));
      const twice = await structuredDataReportOf(db, A);
      expect(twice.site.nodes).toEqual([{ source: 'extension:seo-partner', fragment: 'ext-seo-partner_org', type: 'Organization' }]);
      expect(twice.site.diagnostics.map((d) => d.code)).toEqual(['site-node-item-field', 'id-conflict']);
      expect((await graphAt(HOST_A, '/x-post/')).filter((n) => n['@id'] === eventId)).toHaveLength(1);
    });

    it('task 2.9: through ExtensionsService — install and uninstall materialise in their own transaction; a site node\'s dangling reference is reported (Codex review of batch 5c)', async () => {
      vi.spyOn(PermissionService.prototype, 'canAccess').mockImplementation(async (collection, action) => ({ collection, action, rule: null, fields: ['*'], presets: {}, validation: {}, sources: [] }));
      vi.spyOn(ExtensionVerifierService.prototype, 'verifyByMetadata').mockResolvedValue({ ok: true, isOfficial: false, reason: 'ok' } as never);
      try {
        await article(A, 's-post');
        await get(HOST_A, '/s-post/');
        const ctx = { siteId: A, userId: null, roleId: null, user: null, ip: null, headers: {}, apiKey: null } as never;
        const service = new ExtensionsService({ db, siteId: A, permissionCtx: ctx });
        const row = await service.installExtension({
          name: 'seo-service', version: '1.0.0', type: 'hook', enabled: true, bundleUrl: 'https://example.com/s.js', capabilities: ['seo:structured-data'],
          manifest: { structuredData: [{ key: 'org', scope: 'site', node: { '@type': 'Organization', name: 'Svc', member: { '@id': '#nowhere' } } }] },
        });
        // The service's key is `seo_service`: not a plain slug, so its fragment carries a tag of the whole key.
        const orgId = `https://${HOST_A}/#${contributionFragment('seo_service', 'org')}`;
        const ids = async () => (await graphAt(HOST_A, '/s-post/')).map((n) => n['@id']);
        // The reference to a node the graph does not have is removed.
        expect((await graphAt(HOST_A, '/s-post/')).find((n) => n['@id'] === orgId)).toEqual({ '@id': orgId, '@type': 'Organization', name: 'Svc' });
        const report = await structuredDataReportOf(db, A);
        expect(report.site.nodes.map((n) => n.type)).toEqual(['Organization']);
        expect(report.site.diagnostics.map((d) => d.code)).toEqual(['dangling-reference']);
        await service.uninstallExtension(row!.id);
        expect(await ids()).not.toContain(orgId);
        expect((await structuredDataReportOf(db, A)).site).toEqual({ nodes: [], diagnostics: [] });
      } finally {
        vi.restoreAllMocks();
      }
    });

    it('task 2.10: an item node naming a site node keeps the reference and reports nothing; without the primary domain the site nodes are still checked (Codex review of batch 5c)', async () => {
      const write = <T,>(fn: (tx: Database) => Promise<T>) => runSiteTransaction(db, A, (tx) => fn(tx as unknown as Database));
      const orgId = `https://${HOST_A}/#ext-seo-org_org`;
      await write((tx) =>
        tx.insert(extensions).values({
          siteId: A, key: 'seo-org', name: 'seo-org', version: '1', type: 'hook', enabled: true, bundleUrl: 'https://example.com/o.js', capabilities: ['seo:structured-data'],
          manifest: {
            structuredData: [
              { key: 'org', scope: 'site', node: { '@type': 'Organization', name: 'Org', member: { '@id': '#ext-seo-org_person' } } },
              { key: 'person', scope: 'site', node: { '@type': 'Person', name: 'Member' } },
              { key: 'post', scope: 'site', node: { '@type': 'Article', headline: 'not a site node' } },
            ],
          },
        }),
      );
      await article(A, 'ref-site', { structured_data: JSON.stringify({ '@type': 'Event', '@id': '#e', organizer: { '@id': orgId } }) });
      const graph = await graphAt(HOST_A, '/ref-site/');
      expect(graph.find((n) => n['@id'] === `https://${HOST_A}/ref-site/#e`)).toMatchObject({ organizer: { '@id': orgId } });
      let report = await structuredDataReportOf(db, A);
      expect(report.items.find((i) => i.path === '/ref-site')).toBeUndefined();
      expect(report.site.nodes.map((n) => n.fragment)).toEqual(['ext-seo-org_org', 'ext-seo-org_person']);
      expect(report.site.diagnostics.map((d) => d.code)).toEqual(['reserved-type']);
      // Item pages not indexed: the site nodes are still on the indexable home.
      await seo(A).update({ version: 0, index: { pageTypes: { item: false } } });
      expect((await graphAt(HOST_A, '/')).map((n) => n['@id'])).toContain(orgId);
      expect((await structuredDataReportOf(db, A)).site.nodes).toHaveLength(2);
      // The primary domain gone (aliases stay): the site nodes are still checked — the article is not listed — and on
      // whichever host answers, their references name that host's nodes.
      await runSiteTransaction(db, A, (tx) => tx.update(siteDomains).set({ status: 'pending' }).where(and(eq(siteDomains.siteId, A), eq(siteDomains.hostname, HOST_A))));
      report = await structuredDataReportOf(db, A);
      expect(report.site.nodes.map((n) => n.fragment)).toEqual(['ext-seo-org_org', 'ext-seo-org_person']);
      expect(report.site.diagnostics.map((d) => d.code)).toEqual(['reserved-type']);
      const org = (await graphAt(ALIAS_A, '/')).find((n) => String(n['@id']).endsWith('#ext-seo-org_org'))!;
      const host = new URL(String(org['@id'])).host;
      expect(new URL((org.member as { '@id': string })['@id']).host).toBe(host);
    });

    it('task 2.3: a page set to noindex — meta robots and X-Robots-Tag (GET, HEAD, 304), no canonical, no snippet directives', async () => {
      const a = await article(A, 'hidden-page', { seo_robots: 'noindex,follow' });
      const res = await get(HOST_A, '/hidden-page/');
      expect(res.status).toBe(200);
      expect(res.headers.get('x-robots-tag')).toBe('noindex');
      const head = headOf(await res.text());
      expect(robotsOf(head)).toBe('noindex');
      expect(head).not.toContain('rel="canonical"');
      const head2 = await app.request('/hidden-page/', { method: 'HEAD', headers: { host: HOST_A } });
      expect(head2.headers.get('x-robots-tag')).toBe('noindex');
      const notModified = await get(HOST_A, '/hidden-page/', { 'if-none-match': res.headers.get('etag')! });
      expect(notModified.status).toBe(304);
      expect(notModified.headers.get('x-robots-tag')).toBe('noindex');
      // Indexed again: the header goes.
      await items(A).patch('articles', a.id, { data: { seo_robots: 'index,follow' }, expectedVersion: a.version });
      const back = await get(HOST_A, '/hidden-page/');
      expect(back.headers.get('x-robots-tag')).toBeNull();
      expect(robotsOf(headOf(await back.text()))).toBe('max-image-preview:large');
    });

    it('task 2.8: site → page type → collection → page; tag pages not indexed, one indexed on its own; search never', async () => {
      const t1 = await term(A, 'tags', 'plain-tag');
      const t2 = await items(A).create('tags', { data: { name: 'Own tag', slug: 'own-tag', seo_robots: 'index' }, status: 'published' });
      expect(t2).toBeDefined();
      expect(t1).toBeDefined();
      await article(A, 'regular');
      await seo(A).update({ version: 0, index: { pageTypes: { taxonomy: false } } });
      const plain = await get(HOST_A, '/tag/plain-tag/');
      expect(plain.status).toBe(200);
      expect(plain.headers.get('x-robots-tag')).toBe('noindex');
      const ownTag = await get(HOST_A, '/tag/own-tag/');
      expect(ownTag.headers.get('x-robots-tag')).toBeNull();
      expect(robotsOf(headOf(await ownTag.text()))).toBe('max-image-preview:large');
      expect((await get(HOST_A, '/regular/')).headers.get('x-robots-tag')).toBeNull();
      // A collection default is more specific than the page type.
      await seo(A).update({ version: 1, index: { pageTypes: { taxonomy: false }, collections: { tags: true, articles: false } } });
      expect((await get(HOST_A, '/tag/plain-tag/')).headers.get('x-robots-tag')).toBeNull();
      expect((await get(HOST_A, '/regular/')).headers.get('x-robots-tag')).toBe('noindex');
      // The search page cannot be set indexable (no such setting), and is never indexed.
      expect((await seo(A).update({ version: 2, index: { pageTypes: { search: true } } }).catch((e: { code?: string }) => e.code))).toBe('SYSTEM_LIMIT');
      const search = await get(HOST_A, '/search/?q=x');
      expect(search.headers.get('x-robots-tag')).toBe('noindex');
      // The discovery outputs take the same result (Codex review of batch 12): the page-type default keeps the plain tag
      // out of the sitemap, the tag indexed on its own is listed.
      await seo(A).update({ version: 2, index: { pageTypes: { taxonomy: false } } });
      const shard = await (await get(HOST_A, '/sitemap-1.xml')).text();
      expect(shard).not.toContain(`https://${HOST_A}/tag/plain-tag/`);
      expect(shard).toContain(`<loc>https://${HOST_A}/tag/own-tag/</loc>`);
    });

    it('migration 0071: rows from before the structured column get a background refresh — the site keeps being served — which fills their FAQ; a second run adds no second mark', async () => {
      const a = await article(A, 'faq-before', { faq: [{ question: 'Why?', answer: 'Because.' }] });
      // As before migration 0070: the column empty, no marks.
      await owner`SELECT set_config('app.site_id', ${A}, false)`;
      await owner`UPDATE lumibase_public_items SET structured = '{}'::jsonb WHERE item_id = ${a.id}`;
      await owner`DELETE FROM lumibase_projection_rebuilds WHERE site_id IN (${A}, ${B})`;
      await owner`SELECT set_config('app.site_id', '', false)`;
      const migration = readFileSync(path.resolve(__dirname, '../../../../packages/database/drizzle/0071_structured_data_refresh.sql'), 'utf8');
      await owner.unsafe(migration);
      await owner.unsafe(migration);
      const marks = await db.select().from(projectionRebuilds).where(eq(projectionRebuilds.siteId, A));
      expect(marks.map((m) => m.reason)).toEqual(['refresh: structured data']);
      // Not maintenance: the site is served meanwhile (without the FAQ until the refresh).
      expect((await get(HOST_A, '/faq-before/')).status).toBe(200);
      await rebuildSiteProjection(db, A);
      expect(await db.select().from(projectionRebuilds).where(eq(projectionRebuilds.siteId, A))).toEqual([]);
      const [row] = await db.select({ s: publicItemsTable.structured }).from(publicItemsTable).where(eq(publicItemsTable.itemId, a.id));
      expect(row!.s).toEqual({ faq: [{ question: 'Why?', answer: 'Because.' }] });
    });

    it('migration 0052: rows projected before the column get each item\'s own setting, site by site; a second run writes nothing', async () => {
      const a1 = await article(A, 'bf-a1', { seo_robots: 'noindex,nofollow' });
      const a2 = await article(A, 'bf-a2');
      const b1 = await article(B, 'bf-b1', { seo_robots: 'index,nofollow' });
      // A projection row whose base item is gone (written past the services): left exactly as it is.
      const orphan = 'bf-orphan-row';
      await owner`INSERT INTO lumibase_public_items (item_id, site_id, collection, locale, path, data, card, updated_at, sanitizer, seo_robots)
                  VALUES (${orphan}, ${A}, 'articles', 'en', '/bf-orphan/', '{}'::jsonb, '{}'::jsonb, now(), 1, 'noindex,follow')`;
      const ids = [a1.id, a2.id, b1.id, orphan];
      // As before the column existed: nothing projected for the real items.
      await owner`UPDATE lumibase_public_items SET seo_robots = NULL WHERE item_id IN ${owner([a1.id, a2.id, b1.id])}`;
      const migration = readFileSync(path.resolve(__dirname, '../../../../packages/database/drizzle/0052_public_items_seo_robots_backfill.sql'), 'utf8');
      await owner.unsafe(migration);
      const after = async () =>
        Object.fromEntries((await owner`SELECT item_id, site_id, seo_robots, xmin::text AS x FROM lumibase_public_items WHERE item_id IN ${owner(ids)}`).map((r) => [r.item_id, r]));
      const first = await after();
      expect(first[a1.id]).toMatchObject({ site_id: A, seo_robots: 'noindex,nofollow' });
      // No value of its own (the field default is a form default, not stored): none projected.
      expect(first[a2.id]).toMatchObject({ site_id: A, seo_robots: null });
      expect(first[b1.id]).toMatchObject({ site_id: B, seo_robots: 'index,nofollow' });
      expect(first[orphan]).toMatchObject({ site_id: A, seo_robots: 'noindex,follow' });
      // Idempotent: the second run changes no row (no new row versions).
      await owner.unsafe(migration);
      const second = await after();
      for (const id of ids) expect(second[id]!.x, id).toBe(first[id]!.x);
      await owner`DELETE FROM lumibase_public_items WHERE item_id = ${orphan}`;
    });
  });

  it('task 2.5: article:modified_time is the real content time — an SEO-only edit or a site refresh keeps it, a content edit moves it', async () => {
    const a = await article(A, 'timed-post');
    const modifiedOf = async () => /<meta property="article:modified_time" content="([^"]+)">/.exec(await (await get(HOST_A, '/timed-post/')).text())?.[1];
    const publishedOf = async () => /<meta property="article:published_time" content="([^"]+)">/.exec(await (await get(HOST_A, '/timed-post/')).text())?.[1];
    const t0 = await modifiedOf();
    expect(t0).toBeDefined();
    expect(t0).toBe(await publishedOf());
    const version = async () => (await db.select({ v: itemsTable.version }).from(itemsTable).where(eq(itemsTable.id, a.id)))[0]!.v;
    await new Promise((r) => setTimeout(r, 5));
    await items(A).patch('articles', a.id, { data: { seo_description: 'Only SEO.' }, expectedVersion: await version() });
    await rebuildSiteProjection(db, A);
    expect(await modifiedOf()).toBe(t0);
    await items(A).patch('articles', a.id, { data: { title: 'A new title' }, expectedVersion: await version() });
    const t1 = await modifiedOf();
    expect(new Date(t1!).getTime()).toBeGreaterThan(new Date(t0!).getTime());
    // The first publication time stays (spec scenario "修改正文").
    expect(await publishedOf()).toBe(t0);
  });

  it('task 2.7: page 2 of a tag and of an author list is canonical to itself', async () => {
    const tag = await term(A, 'tags', 'many');
    const author = await term(A, 'authors', 'prolific');
    for (let i = 1; i <= 11; i++) await article(A, `many-${i}`, { tags: [tag.id], author: author.id });
    for (const list of ['/tag/many/', '/author/prolific/']) {
      const page2 = await get(HOST_A, `${list}?page=2`);
      expect(page2.status, list).toBe(200);
      expect(await page2.text()).toContain(`<link rel="canonical" href="https://${HOST_A}${list}?page=2">`);
      expect((await get(HOST_A, `${list}?page=3`)).status, list).toBe(404);
    }
  });

  it('only sanitised rich text is markup: a body that is plain text is escaped', async () => {
    // On B the body is a plain textarea: whatever it holds is text.
    await new SchemaService({ db, siteId: B }).updateField('articles', 'body', { interface: 'textarea' });
    await article(B, 'plain', { body: '<img src=x onerror=alert(1)>\n\nsecond <b>para</b>' });
    const html = await (await get(HOST_B, '/plain/')).text();
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>');
    expect(html).toContain('<p>&lt;img src=x onerror=alert(1)&gt;</p>');
    // On A it is rich text, sanitised by the projection: markup kept, scripts gone.
    await article(A, 'rich', { body: '<p>ok <em>yes</em></p><img src=x onerror=alert(1)><script>x()</script>' });
    const rich = await (await get(HOST_A, '/rich/')).text();
    expect(rich).toContain('<em>yes</em>');
    // The system's one JSON-LD script (P07) aside, no script and no handler.
    expect(withoutJsonLd(rich)).not.toMatch(/onerror|<script/);
  });

  it('301: an old slug, a redirect record, an alias host, a missing trailing slash — each straight to the final address', async () => {
    const a = await article(A, 'old-name');
    await items(A).patch('articles', a.id, { data: { slug: 'new-name' }, expectedVersion: a.version });
    const old = await get(HOST_A, '/old-name/');
    expect(old.status).toBe(301);
    expect(old.headers.get('location')).toBe(`https://${HOST_A}/new-name/`);
    const alias = await get(ALIAS_A, '/old-name/?ref=x');
    expect(alias.status).toBe(301);
    expect(alias.headers.get('location')).toBe(`https://${HOST_A}/new-name/?ref=x`);
    const slash = await get(HOST_A, '/new-name');
    expect(slash.status).toBe(301);
    expect(slash.headers.get('location')).toBe(`https://${HOST_A}/new-name/`);
    expect((await get(HOST_A, '/new-name/')).status).toBe(200);
  });

  it('410: a deleted once-public article; its path used again is 200', async () => {
    const a = await article(A, 'short-lived');
    await items(A).softDelete('articles', a.id);
    const gone = await get(HOST_A, '/short-lived/');
    expect(gone.status).toBe(410);
    expect(await gone.text()).not.toMatch(/at \w+ \(|\/src\//);
    await article(A, 'short-lived');
    expect((await get(HOST_A, '/short-lived/')).status).toBe(200);
  });

  it('home, category, tag and author lists, with pagination; search', async () => {
    const cat = await term(A, 'categories', 'news');
    const tag = await term(A, 'tags', 'go');
    const author = await term(A, 'authors', 'ada');
    const all = await term(A, 'categories', 'all');
    for (let i = 1; i <= 12; i++) {
      await article(A, `post-${String(i).padStart(2, '0')}`, {
        title: i === 7 ? 'Seventh Heaven' : `Post ${i}`,
        categories: i % 2 ? [cat.id, all.id] : [all.id],
        tags: i <= 3 ? [tag.id] : [],
        author: i === 12 ? author.id : null,
      });
    }
    const home = await (await get(HOST_A, '/')).text();
    expect(home.match(/<li>/g)).toHaveLength(10);
    expect(home).toContain('rel="next" href="/?page=2"');
    const page2 = await get(HOST_A, '/?page=2');
    expect(page2.status).toBe(200);
    const page2Html = await page2.text();
    expect(page2Html.match(/<li>/g)).toHaveLength(2);
    // Each page of a list is canonical to itself (P07, Codex review of batch 3), not to the first page.
    expect(home).toContain(`<link rel="canonical" href="https://${HOST_A}/">`);
    expect(page2Html).toContain(`<link rel="canonical" href="https://${HOST_A}/?page=2">`);
    const allPage2 = await (await get(HOST_A, '/category/all/?page=2')).text();
    expect(allPage2.match(/<li>/g)).toHaveLength(2);
    expect(allPage2).toContain(`<link rel="canonical" href="https://${HOST_A}/category/all/?page=2">`);
    expect(await (await get(HOST_A, '/category/all/')).text()).toContain(`<link rel="canonical" href="https://${HOST_A}/category/all/">`);
    expect((await get(HOST_A, '/?page=3')).status).toBe(404);
    expect((await get(HOST_A, '/?page=x')).status).toBe(404);
    // Past the last page of a category, tag or author list: 404 (P07 task 2.7; spec "分页越界"), never the first page.
    expect((await get(HOST_A, '/category/all/?page=7')).status).toBe(404);
    expect((await get(HOST_A, '/category/all/?page=3')).status).toBe(404);
    expect((await get(HOST_A, '/tag/go/?page=2')).status).toBe(404);
    expect((await get(HOST_A, '/author/ada/?page=2')).status).toBe(404);

    const category = await (await get(HOST_A, '/category/news/')).text();
    expect(category).toContain('Term news');
    expect(category.match(/<li>/g)).toHaveLength(6);
    expect((await (await get(HOST_A, '/tag/go/')).text()).match(/<li>/g)).toHaveLength(3);
    const byAuthor = await (await get(HOST_A, '/author/ada/')).text();
    expect(byAuthor.match(/<li>/g)).toHaveLength(1);
    expect(byAuthor).toContain('Post 12');

    const search = await get(HOST_A, '/search/?q=heaven');
    expect(search.status).toBe(200);
    const found = await search.text();
    expect(found).toContain('Seventh Heaven');
    expect(found.match(/<li>/g)).toHaveLength(1);
    expect(found).toContain('<meta name="robots" content="noindex">');
    // Not indexable, so never canonical and never in a discovery output (the page has no item: no discovery entry at all).
    expect(found).not.toContain('rel="canonical"');
    expect(search.headers.get('x-robots-tag')).toBe('noindex');
    // Escaped, never markup.
    const hostile = await (await get(HOST_A, '/search/?q=%3Cscript%3E')).text();
    // No script element; inside a quoted attribute value `<` is plain text.
    expect(withoutJsonLd(hostile).replace(/"[^"]*"/g, '""')).not.toMatch(/<script/i);
    expect(hostile).toContain('<title>&lt;script&gt; · Site Alpha</title>');
  });

  it('task 1.4: the three language entries (prefix, subdomain, domain); Accept-Language never changes the body; a language subdomain is not an alias', async () => {
    await article(A, 'hola', { locale: 'zh-CN', title: 'ZH title' });
    await article(A, 'konnichiwa', { locale: 'ja', title: 'JA title' });
    await article(A, 'bonjour', { locale: 'fr', title: 'FR title' });
    const zh = await get(HOST_A, '/zh/hola/');
    expect(zh.status).toBe(200);
    expect(await zh.text()).toContain('<html lang="zh-CN">');
    const ja = await get(JA_SUBDOMAIN, '/konnichiwa/');
    expect(ja.status).toBe(200);
    expect(await ja.text()).toContain('JA title');
    const fr = await get(FR_DOMAIN, '/bonjour/');
    expect(fr.status).toBe(200);
    expect(await fr.text()).toContain('FR title');
    // Each language's home is its own.
    expect(await (await get(JA_SUBDOMAIN, '/')).text()).toContain('JA title');
    expect(await (await get(HOST_A, '/zh/')).text()).toContain('ZH title');
    // Each language's home is canonical to that language's address (Codex review of batch 3), whichever entry answered.
    const homeOf = (locale: string) => renderPort(renderDb).request(A, async (_port, reads) => publicUrlOf(await reads.space(HOST_A), locale, '/'));
    const canonicalOf = async (host: string, p: string) => /<link rel="canonical" href="([^"]*)">/.exec(await (await get(host, p)).text())?.[1];
    for (const [host, p, locale] of [[JA_SUBDOMAIN, '/', 'ja'], [FR_DOMAIN, '/', 'fr'], [HOST_A, '/zh/', 'zh-CN'], [HOST_A, '/', 'en']] as const) {
      const expected = await homeOf(locale);
      expect(expected, locale).toMatch(/^https:\/\//);
      expect(await canonicalOf(host, p), `${host}${p}`).toBe(expected);
    }
    // One identity in every language, on the site's primary host; each language's WebSite at its own home (Codex review of batch 5a).
    await new SiteIdentityService({ db, siteId: A, actor: { userId: null } }).update({ version: 0, kind: 'organization', name: 'Alpha Org' });
    const graphOf = async (host: string, p: string) =>
      (JSON.parse(/<script type="application\/ld\+json">([^<]*)<\/script>/.exec(await (await get(host, p)).text())![1]!) as { '@graph': Array<Record<string, unknown>> })['@graph'];
    for (const [host, p, locale] of [[JA_SUBDOMAIN, '/', 'ja'], [FR_DOMAIN, '/', 'fr'], [HOST_A, '/zh/', 'zh-CN'], [JA_SUBDOMAIN, '/konnichiwa/', 'ja'], [FR_DOMAIN, '/bonjour/', 'fr']] as const) {
      const graph = await graphOf(host, p);
      expect(graph.find((n) => n['@type'] === 'Organization'), `${host}${p}`).toMatchObject({ '@id': `https://${HOST_A}/#identity`, url: `https://${HOST_A}/` });
      expect(graph.find((n) => n['@type'] === 'WebSite')!['@id'], `${host}${p}`).toBe(`${await homeOf(locale)}#website`);
    }
    // Under the subdomain strategy the Japanese home is on its own host: the identity stays on the primary host.
    await settings(A, { localeStrategy: 'subdomain' });
    expect(await homeOf('ja')).toBe(`https://${JA_SUBDOMAIN}/`);
    const jaGraph = await graphOf(JA_SUBDOMAIN, '/');
    expect(jaGraph.find((n) => n['@type'] === 'Organization')).toMatchObject({ '@id': `https://${HOST_A}/#identity`, url: `https://${HOST_A}/` });
    expect(jaGraph.find((n) => n['@type'] === 'WebSite')!['@id']).toBe(`https://${JA_SUBDOMAIN}/#website`);
    await settings(A, { localeStrategy: 'subdirectory' });
    // Another language's article is not on a language domain; on the primary domain it is where it lives.
    expect((await get(JA_SUBDOMAIN, '/bonjour/')).status).toBe(404);
    // Accept-Language: the same bytes, whatever it says.
    const plain = await (await get(HOST_A, '/zh/hola/')).text();
    for (const lang of ['ja', 'fr-FR,fr;q=0.9', 'en-US']) expect(await (await get(HOST_A, '/zh/hola/', { 'accept-language': lang })).text()).toBe(plain);
    expect((await get(HOST_A, '/', { 'accept-language': 'zh-CN' })).status).toBe(200);
    expect(await (await get(HOST_A, '/', { 'accept-language': 'zh-CN' })).text()).not.toContain('ZH title');
  });

  it('a language home on its entry domain is canonical to the language\'s address — every page, either trailing-slash policy (Codex review of batch 3)', async () => {
    for (let i = 1; i <= 11; i++) await article(A, `ja-${String(i).padStart(2, '0')}`, { locale: 'ja', title: `JA ${i}` });
    const canonicalOf = async (host: string, p: string) => {
      const res = await get(host, p);
      expect(res.status, `${host}${p}`).toBe(200);
      return /<link rel="canonical" href="([^"]*)">/.exec(await res.text())?.[1];
    };
    expect(await canonicalOf(JA_SUBDOMAIN, '/')).toBe(`https://${HOST_A}/ja/`);
    expect(await canonicalOf(JA_SUBDOMAIN, '/?page=2')).toBe(`https://${HOST_A}/ja/?page=2`);
    await settings(A, { trailingSlash: 'never' });
    expect(await canonicalOf(JA_SUBDOMAIN, '/')).toBe(`https://${HOST_A}/ja`);
    expect(await canonicalOf(JA_SUBDOMAIN, '/?page=2')).toBe(`https://${HOST_A}/ja?page=2`);
  });

  it('no administration surface on public hosts; only GET and HEAD', async () => {
    for (const host of [HOST_A, ALIAS_A, 'nobody.example.org']) {
      for (const path of ['/admin', '/admin/', '/api/v1/items/articles', '/API/x', '/internal/health', '/%61dmin', '/%41PI/v1/items', '/%69nternal/tls/ask', '/%E0%A4%A/x']) {
        const res = await get(host, path);
        // Not even an alias's redirect: nothing under these paths is the public site's.
        expect(res.status, `${host}${path}`).toBe(404);
      }
    }
    for (const method of ['POST', 'PUT', 'DELETE']) {
      expect((await app.request('/admin', { method, headers: { host: HOST_A } })).status, method).toBe(404);
      expect((await app.request('/api/v1/x', { method, headers: { host: ALIAS_A } })).status, method).toBe(404);
      expect((await app.request('/', { method, headers: { host: 'nobody.example.org' } })).status, method).toBe(404);
      expect((await app.request('/', { method, headers: { host: HOST_A } })).status, method).toBe(405);
    }
    const head = await app.request('/', { method: 'HEAD', headers: { host: HOST_A } });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
  });

  it('HeoPress P07 task 1.5: system paths are decided before content — never resolved as content, even an old route on one', async () => {
    await article(A, 'feeding-tips');
    expect((await get(HOST_A, '/feeding-tips/')).status).toBe(200);
    const old = await article(A, 'old-feed');
    // As a route from before this release would be (the upgrade check reports these; the renderer still never serves them).
    await owner`UPDATE lumibase_public_items SET path = '/feed.xml' WHERE item_id = ${old.id}`;
    expect(await renderPort(renderDb).request(A, (port) => resolvePublicPathWith(port, { host: HOST_A, path: '/feed.xml/' }))).toMatchObject({ kind: 'item' });
    // A current cached answer on a system path (as an older renderer could have stored) is not served either.
    const [v] = await db.select({ v: siteRenderVersions.version }).from(siteRenderVersions).where(eq(siteRenderVersions.siteId, A));
    const stale = cachedPage(200, 'cached content', null);
    const key = cacheKey({ mode: 'public', siteId: A, host: HOST_A, path: '/.well-known/security.txt', query: new URLSearchParams(), themeVersion: BUILTIN_THEME_ID, siteVersion: v?.v ?? 0 });
    await db.insert(renderCache).values({ key, siteId: A, siteVersion: v?.v ?? 0, status: 200, body: stale.body, etag: stale.etag, location: null, contentType: stale.contentType, headers: {}, expiresAt: new Date(Date.now() + 3_600_000) });
    // System paths no handler answers (yet), and spellings of the discovery files that are not theirs (P07 batch 6 answers
    // `/feed.xml` and `/sitemap.xml` themselves: tested with the discovery files).
    const paths = ['/feed.xml/', '/FEED.XML', '/%66eed.xml', '/robots.txt/', '/llms.txt/', '/sitemap.xml/', '/.well-known/security.txt', '/favicon.ico', '/rss'];
    for (const path of paths) {
      const res = await get(HOST_A, path);
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).toBe('Not found');
      // A plain alias goes to the primary domain first, as every path does (query kept).
      const alias = await get(ALIAS_A, `${path}?x=1`);
      expect(alias.status, `alias ${path}`).toBe(301);
      expect(alias.headers.get('location'), `alias ${path}`).toBe(`https://${HOST_A}${path}?x=1`);
    }
    // A malformed escape further along cannot become a redirect target: not found, never a 500 or a bad header.
    for (const path of ['/robots.txt/%zz', '/.well-known/a%']) {
      const res = await get(ALIAS_A, path);
      expect(res.status, path).toBe(404);
      expect(res.headers.get('location'), path).toBeNull();
    }
    // The route's own path is not content any more either: the discovery file answers it.
    expect((await get(HOST_A, '/feed.xml')).headers.get('content-type')).toBe('application/rss+xml; charset=utf-8');
    // A site waiting for a rebuild answers 503 on system paths too, on every host.
    await db.insert(projectionRebuilds).values({ siteId: A, reason: 'test' });
    for (const host of [HOST_A, ALIAS_A]) for (const p of ['/robots.txt', '/sitemap.xml']) expect((await get(host, p)).status, `${host}${p}`).toBe(503);
  });

  describe('HeoPress P07 batch 6: discovery files', () => {
    const text = async (host: string, p: string) => {
      const res = await get(host, p);
      expect(res.status, `${host}${p}`).toBe(200);
      return res.text();
    };
    const headOf = (html: string) => /<head>([\s\S]*?)<\/head>/.exec(html)?.[1] ?? '';
    const locs = (xml: string) => [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]!);
    const seo = (siteId: string) => new SeoSettingsService({ db, siteId, actor: { userId: null } });
    const seoVersion = async (siteId: string) => (await seo(siteId).get()).version;

    it('tasks 2.3, 2.8: a page indexed, then not — by its own switch, then by its collection\'s default — leaves the sitemap, the feeds, llms.txt, llms-full.txt and its Markdown copy (warm caches); indexed again, it is back', async () => {
      await seo(A).update({ version: await seoVersion(A), discovery: { newsSitemap: true } });
      const a = await article(A, 'five-places', { excerpt: 'Five.', body: '<p>FIVE-PLACES-BODY</p>' });
      await items(A).create('pages', { data: { title: 'Kept page', slug: 'kept-page', locale: 'en', body: '<p>KEPT-PAGE-BODY</p>' }, status: 'published' });
      const url = `https://${HOST_A}/five-places/`;
      const places = async () => ({
        sitemap: locs(await text(HOST_A, '/sitemap-1.xml')).includes(url),
        sitemapTxt: (await text(HOST_A, '/sitemap.txt')).split('\n').includes(url),
        news: locs(await text(HOST_A, '/news-sitemap.xml')).includes(url),
        rss: (await text(HOST_A, '/feed.xml')).includes(url),
        atom: (await text(HOST_A, '/atom.xml')).includes(url),
        llms: (await text(HOST_A, '/llms.txt')).includes(url),
        llmsFull: (await text(HOST_A, '/llms-full.txt')).includes('FIVE-PLACES-BODY'),
        markdown: (await get(HOST_A, '/five-places.md')).status === 200,
      });
      const all = (v: boolean) => ({ sitemap: v, sitemapTxt: v, news: v, rss: v, atom: v, llms: v, llmsFull: v, markdown: v });
      const version = async () => (await db.select({ v: itemsTable.version }).from(itemsTable).where(eq(itemsTable.id, a.id)))[0]!.v;
      expect(await places()).toEqual(all(true));
      // Warm: each answer cached.
      expect((await get(HOST_A, '/sitemap-1.xml')).headers.get('x-cache')).toMatch(/^hit/);
      // Its own switch (task 2.3).
      await items(A).patch('articles', a.id, { data: { seo_robots: 'noindex,follow' }, expectedVersion: await version() });
      expect(await places()).toEqual(all(false));
      await items(A).patch('articles', a.id, { data: { seo_robots: null }, expectedVersion: await version() });
      expect(await places()).toEqual(all(true));
      // Its collection's default (task 2.8): the same result everywhere; another collection's page stays.
      const off = await seo(A).get();
      await seo(A).update({ ...off.settings, version: off.version, index: { ...off.settings.index, collections: { articles: false } } });
      expect(await places()).toEqual(all(false));
      expect(locs(await text(HOST_A, '/sitemap-1.xml'))).toContain(`https://${HOST_A}/kept-page/`);
      expect(await text(HOST_A, '/llms-full.txt')).toContain('KEPT-PAGE-BODY');
      // The pages collection's own feeds (Codex review of batch 12): listed while pages are indexed by default, gone when not.
      const keptUrl = `https://${HOST_A}/kept-page/`;
      expect(await text(HOST_A, '/feed/pages.xml')).toContain(keptUrl);
      expect(await text(HOST_A, '/atom/pages.xml')).toContain(keptUrl);
      const both = await seo(A).get();
      await seo(A).update({ ...both.settings, version: both.version, index: { ...both.settings.index, collections: { articles: false, pages: false } } });
      expect(await text(HOST_A, '/feed/pages.xml')).not.toContain(keptUrl);
      expect(await text(HOST_A, '/atom/pages.xml')).not.toContain(keptUrl);
      expect(locs(await text(HOST_A, '/sitemap-1.xml'))).not.toContain(keptUrl);
      // The preset's `index,follow` sets nothing: the default still applies. A page's own `index` is more specific.
      await items(A).patch('articles', a.id, { data: { seo_robots: 'index,follow' }, expectedVersion: await version() });
      expect(await places()).toEqual(all(false));
      await items(A).patch('articles', a.id, { data: { seo_robots: 'index' }, expectedVersion: await version() });
      expect(await places()).toEqual(all(true));
    });

    it('Codex review of batch 12: the bounded scans read exactly the pages an own setting indexes — never the preset\'s `index,follow` — when the collection is not indexed by default', async () => {
      const values = ['index,follow', 'Follow , INDEX', 'follow,index,index', 'index', ' Index ', 'index,nofollow', 'nofollow,index,follow', 'noindex,index', 'noindex', 'follow', '', ' , index , ', null];
      const made = await Promise.all(values.map((v, i) => article(A, `pf-${i}`, { seo_robots: v })));
      expect(made).toHaveLength(values.length);
      const off = await seo(A).get();
      await seo(A).update({ ...off.settings, version: off.version, index: { ...off.settings.index, collections: { articles: false } } });
      const read = await renderPort(renderDb).request(A, (_p, reads) => reads.latest('en', 'articles', { offset: 0, limit: 100, listable: { defaultIndexable: false } }));
      const expected = values.flatMap((v, i) => (parseItemRobots(v).index === true ? [`/pf-${i}`] : []));
      expect(read.map((r) => r.path).sort()).toEqual(expected.sort());
      expect(expected).toEqual(['/pf-11', '/pf-3', '/pf-4', '/pf-5', '/pf-6']);
      // Indexed by default: every page but those saying noindex.
      const notNoindex = values.flatMap((v, i) => (parseItemRobots(v).index === false ? [] : [`/pf-${i}`])).sort();
      const all = await renderPort(renderDb).request(A, (_p, reads) => reads.latest('en', 'articles', { offset: 0, limit: 100, listable: { defaultIndexable: true } }));
      expect(all.map((r) => r.path).sort()).toEqual(notNoindex);
      // The llms lists' merge (round 2): the same rows, from either kind of stream.
      for (const defaultIndexable of [false, true]) {
        const merged = await renderPort(renderDb).request(A, (_p, reads) =>
          reads.llmsNewest({ streams: [{ collection: 'articles', locale: 'en', skip: 0, listable: { defaultIndexable } }], perStream: 100, limit: 100 }),
        );
        expect(merged.map((r) => r.path).sort(), String(defaultIndexable)).toEqual(defaultIndexable ? notNoindex : expected);
      }
    });

    it('task 3.1, 3.5: the sitemap index, its shard and sitemap.txt list the host\'s indexable pages — valid, and a publication shows at once', async () => {
      await article(A, 'sm-one', { excerpt: 'One.' });
      await article(A, 'sm-hidden', { seo_robots: 'noindex,follow' });
      await article(A, 'sm-dup', { canonical_url: 'https://example.org/original/' });
      await article(A, 'sm-draft', {}, 'draft');
      const index = await get(HOST_A, '/sitemap.xml');
      expect(index.headers.get('content-type')).toBe('application/xml; charset=utf-8');
      const indexXml = await index.text();
      expect(locs(indexXml)).toEqual([`https://${HOST_A}/sitemap-1.xml`]);
      expect(await schemaErrors(indexXml, 'sitemap.xsd')).toEqual([]);
      const shard = await text(HOST_A, '/sitemap-1.xml');
      expect(await schemaErrors(shard, 'sitemap.xsd')).toEqual([]);
      expect(locs(shard)).toContain(`https://${HOST_A}/`);
      expect(locs(shard)).toContain(`https://${HOST_A}/sm-one/`);
      // Not indexed, or canonical to another address: listed nowhere.
      expect(shard).not.toContain('sm-hidden');
      expect(shard).not.toContain('sm-dup');
      // A draft is in no discovery output (P07 task 8.2's invariant).
      expect(shard).not.toContain('sm-draft');
      // lastmod: the real content time.
      const [row] = await db.select({ t: publicItemsTable.contentModifiedAt }).from(publicItemsTable).where(and(eq(publicItemsTable.siteId, A), eq(publicItemsTable.path, '/sm-one')));
      expect(shard).toContain(`<loc>https://${HOST_A}/sm-one/</loc><lastmod>${row!.t!.toISOString()}</lastmod>`);
      // Language pages on this host are here; those on their own domains are not (they have their own sitemaps).
      expect((await get(HOST_A, '/sitemap-2.xml')).status).toBe(404);
      const txt = await get(HOST_A, '/sitemap.txt');
      expect(txt.headers.get('content-type')).toBe('text/plain; charset=utf-8');
      const lines = (await txt.text()).split('\n');
      expect(lines).toContain(`https://${HOST_A}/sm-one/`);
      expect(lines).not.toContain(`https://${HOST_A}/sm-draft/`);
      // Cached (warm), then a publication: in the sitemap at once (the render version keys the cache).
      expect((await get(HOST_A, '/sitemap-1.xml')).headers.get('x-cache')).toMatch(/^hit/);
      await article(A, 'sm-new');
      expect(locs(await text(HOST_A, '/sitemap-1.xml'))).toContain(`https://${HOST_A}/sm-new/`);
      // The other site lists its own only; an alias goes to the primary host.
      expect(await text(HOST_B, '/sitemap-1.xml')).not.toContain(HOST_A);
      expect((await get(ALIAS_A, '/sitemap.xml')).headers.get('location')).toBe(`https://${HOST_A}/sitemap.xml`);
      // A page's address is where it is listed: a French article lives on the primary host under /fr/ (the French
      // entry domain only answers for it), so the primary host lists it and the entry domain lists no other host's page.
      await article(A, 'sm-fr', { locale: 'fr' });
      expect(locs(await text(HOST_A, '/sitemap-1.xml'))).toContain(`https://${HOST_A}/fr/sm-fr/`);
      expect(locs(await text(FR_DOMAIN, '/sitemap-1.xml')).every((l) => l.startsWith(`https://${FR_DOMAIN}/`))).toBe(true);
    });

    it('task 3.1: 25,000 indexable articles are three shards of at most 10,000, each valid', async () => {
      // Projection rows written directly (the renderer reads nothing else); one indexable page each.
      await owner`SELECT set_config('app.site_id', ${B}, false)`;
      await owner`INSERT INTO lumibase_public_items (item_id, site_id, collection, locale, path, data, card, updated_at, published_at, sanitizer, content_modified_at)
                  SELECT 'bulk-' || g, ${B}, 'articles', 'en', '/bulk-' || g, jsonb_build_object('title', 'Bulk ' || g),
                         jsonb_build_object('url', 'https://' || ${HOST_B} || '/bulk-' || g || '/'), now(), now(), 1, now()
                    FROM generate_series(1, 25000) g`;
      await owner`SELECT set_config('app.site_id', '', false)`;
      try {
        const index = locs(await text(HOST_B, '/sitemap.xml'));
        expect(index).toEqual([1, 2, 3].map((n) => `https://${HOST_B}/sitemap-${n}.xml`));
        const counts: number[] = [];
        for (const n of [1, 2, 3]) {
          const shard = await text(HOST_B, `/sitemap-${n}.xml`);
          expect(await schemaErrors(shard, 'sitemap.xsd'), `shard ${n}`).toEqual([]);
          counts.push(locs(shard).length);
        }
        // The home and 25,000 articles.
        expect(counts).toEqual([10_000, 10_000, 5001]);
        expect((await get(HOST_B, '/sitemap-4.xml')).status).toBe(404);
        // Far past the end: not found from the item count alone.
        expect((await get(HOST_B, '/sitemap-999999.xml')).status).toBe(404);
      } finally {
        await owner`SELECT set_config('app.site_id', ${B}, false)`;
        await owner`DELETE FROM lumibase_public_items WHERE site_id = ${B} AND item_id LIKE 'bulk-%'`;
        await owner`SELECT set_config('app.site_id', '', false)`;
      }
    }, 120_000);

    it('task 3.3: RSS and Atom — full text with absolute links, the language\'s articles, collections; declared in the head; off when turned off', async () => {
      await article(A, 'fd-one', { excerpt: 'Ex.', body: '<p>Full <a href="/fd-other/">text</a> &amp; more.</p>' });
      await article(A, 'fd-hidden', { seo_robots: 'noindex,follow', body: '<p>hidden body</p>' });
      await article(A, 'fd-zh', { locale: 'zh-CN', body: '<p>中文</p>' });
      await items(A).create('pages', { data: { title: 'About', slug: 'about-us', locale: 'en', body: '<p>About body</p>' }, status: 'published' });
      const rssRes = await get(HOST_A, '/feed.xml');
      expect(rssRes.headers.get('content-type')).toBe('application/rss+xml; charset=utf-8');
      const rss = await rssRes.text();
      expect(await schemaErrors(rss, 'rss.xsd')).toEqual([]);
      expect(rss).toContain(`<link>https://${HOST_A}/fd-one/</link>`);
      expect(rss).toContain('Full &lt;a href=&quot;https://' + HOST_A + '/fd-other/&quot;&gt;text&lt;/a&gt; &amp;amp; more.');
      expect(rss).not.toContain('fd-hidden');
      expect(rss).not.toContain('中文');
      expect(rss).not.toContain('About body');
      const atom = await text(HOST_A, '/atom.xml');
      expect(await schemaErrors(atom, 'atom.xsd')).toEqual([]);
      expect(atom).toContain(`<id>https://${HOST_A}/fd-one/</id>`);
      expect(atom).not.toContain('fd-hidden');
      // Another language, a collection.
      const zh = await text(HOST_A, '/feed.zh-CN.xml');
      expect(zh).toContain('中文');
      expect(zh).toContain('<language>zh-CN</language>');
      const pages = await text(HOST_A, '/atom/pages.xml');
      expect(await schemaErrors(pages, 'atom.xsd')).toEqual([]);
      expect(pages).toContain('About body');
      expect((await get(HOST_A, '/feed.xx.xml')).status).toBe(404);
      // Declared in each page's head, for the page's language.
      const head = headOf(await (await get(HOST_A, '/fd-one/')).text());
      expect(head).toContain(`<link rel="alternate" type="application/rss+xml" title="Site Alpha" href="https://${HOST_A}/feed.xml">`);
      expect(head).toContain(`<link rel="alternate" type="application/atom+xml" title="Site Alpha" href="https://${HOST_A}/atom.xml">`);
      expect(headOf(await (await get(HOST_A, '/zh/fd-zh/')).text())).toContain(`href="https://${HOST_A}/feed.zh-CN.xml"`);
      // Pages a feed does not list never crowd out one it does (Codex review of batch 6): 120 newer pages not indexed.
      await owner`SELECT set_config('app.site_id', ${A}, false)`;
      await owner`INSERT INTO lumibase_public_items (item_id, site_id, collection, locale, path, data, card, updated_at, published_at, sanitizer, seo_robots, content_modified_at)
                  SELECT 'hidden-' || g, ${A}, 'articles', 'en', '/hidden-' || g, jsonb_build_object('title', 'Hidden ' || g),
                         jsonb_build_object('url', 'https://' || ${HOST_A} || '/hidden-' || g || '/'), now(), now() + interval '1 day', 1, 'noindex,follow', now()
                    FROM generate_series(1, 120) g`;
      // Rows written past the projection's maintenance: the render version raised by hand, as a refresh would.
      await owner`UPDATE lumibase_site_render_versions SET version = nextval('heopress_render_version_seq') WHERE site_id = ${A}`;
      await owner`SELECT set_config('app.site_id', '', false)`;
      const crowded = await text(HOST_A, '/feed.xml');
      expect(crowded).toContain(`<link>https://${HOST_A}/fd-one/</link>`);
      expect(crowded).not.toContain('Hidden ');
      // And 600 newer pages that pass the query's filter but are canonical to another address: the scan reads past the
      // first page of 500 rows to the listed one.
      await owner`SELECT set_config('app.site_id', ${A}, false)`;
      await owner`INSERT INTO lumibase_public_items (item_id, site_id, collection, locale, path, data, card, updated_at, published_at, sanitizer, content_modified_at)
                  SELECT 'dup-' || g, ${A}, 'articles', 'en', '/dup-' || g, jsonb_build_object('title', 'Dup ' || g, 'canonical_url', 'https://example.org/original-' || g || '/'),
                         jsonb_build_object('url', 'https://' || ${HOST_A} || '/dup-' || g || '/'), now(), now() + interval '2 days', 1, now()
                    FROM generate_series(1, 600) g`;
      await owner`UPDATE lumibase_site_render_versions SET version = nextval('heopress_render_version_seq') WHERE site_id = ${A}`;
      await owner`SELECT set_config('app.site_id', '', false)`;
      const paged = await text(HOST_A, '/feed.xml');
      expect(paged).toContain(`<link>https://${HOST_A}/fd-one/</link>`);
      expect(paged).not.toContain('Dup ');
      // One address per feed: the language exactly as the site names it, the default language without a suffix, no
      // `/rss.xml` alias, no collection feed of the articles.
      for (const p of ['/feed.zh-cn.xml', '/feed.en.xml', '/rss.xml', '/feed/articles.xml', '/atom/articles.zh-CN.xml']) expect((await get(HOST_A, p)).status, p).toBe(404);
      // A summary that is rich text (a site whose excerpt is a rich-text field): taken from the whole row (Codex review of batch 6).
      await new SchemaService({ db, siteId: B }).updateField('articles', 'excerpt', { interface: 'wysiwyg' });
      await article(B, 'rich-summary', { excerpt: '<p>Rich <strong>sum</strong>mary</p>' });
      // As plain text, in RSS and Atom alike (and in the head's description).
      expect(await text(HOST_B, '/feed.xml')).toContain('<description>Rich summary</description>');
      expect(await text(HOST_B, '/atom.xml')).toContain('<summary>Rich summary</summary>');
      expect(headOf(await (await get(HOST_B, '/rich-summary/')).text())).toContain('<meta name="description" content="Rich summary">');
      // A default language stored in another spelling (`zh-cn`) is the site's `zh-CN`: its feed is /feed.xml, declared so,
      // and the suffixed spelling is not a second address.
      await db.update(sites).set({ defaultLanguage: 'zh-cn' }).where(eq(sites.id, B));
      await settings(B, { availableLocales: ['zh-CN'] });
      await rebuildSiteProjection(db, B);
      await article(B, 'zh-default', { locale: 'zh-CN' });
      expect(await text(HOST_B, '/feed.xml')).toContain('/zh-default/');
      expect((await get(HOST_B, '/feed.zh-CN.xml')).status).toBe(404);
      expect(headOf(await (await get(HOST_B, '/zh-default/')).text())).toContain(`href="https://${HOST_B}/feed.xml"`);
      // Turned off: no feeds, none declared.
      await seo(A).update({ version: await seoVersion(A), discovery: { feeds: false } });
      expect((await get(HOST_A, '/feed.xml')).status).toBe(404);
      expect(headOf(await (await get(HOST_A, '/fd-one/')).text())).not.toContain('application/rss+xml');
    });

    it('task 3.7: the news sitemap — the last 48 hours, publication and language; declared in the index; its cache ends when an article leaves the window', async () => {
      expect((await get(HOST_A, '/news-sitemap.xml')).status).toBe(404);
      await seo(A).update({ version: await seoVersion(A), discovery: { newsSitemap: true, newsPublicationName: 'Alpha News' } });
      const fresh = await article(A, 'news-fresh');
      const old = await article(A, 'news-old');
      // First published three days ago.
      await db.update(itemsTable).set({ publishedAt: new Date(Date.now() - 72 * 3600_000) }).where(eq(itemsTable.id, old.id));
      await rebuildSiteProjection(db, A);
      expect(locs(await text(HOST_A, '/sitemap.xml'))).toContain(`https://${HOST_A}/news-sitemap.xml`);
      const news = await text(HOST_A, '/news-sitemap.xml');
      expect(await schemaErrors(news, 'sitemap.xsd')).toEqual([]);
      expect(locs(news)).toEqual([`https://${HOST_A}/news-fresh/`]);
      expect(news).toContain('<news:name>Alpha News</news:name><news:language>en</news:language>');
      // Still in the ordinary sitemap.
      expect(locs(await text(HOST_A, '/sitemap-1.xml'))).toContain(`https://${HOST_A}/news-old/`);
      // More than any fixed read would hold, all newer and none listable here (Codex review of batch 6): 2,500 on another
      // host, 2,500 not indexed. The article that is listable is still found.
      await owner`SELECT set_config('app.site_id', ${A}, false)`;
      await owner`INSERT INTO lumibase_public_items (item_id, site_id, collection, locale, path, data, card, updated_at, published_at, sanitizer, seo_robots, content_modified_at)
                  SELECT 'crowd-' || g, ${A}, 'articles', 'en', '/crowd-' || g, jsonb_build_object('title', 'Crowd ' || g),
                         jsonb_build_object('url', CASE WHEN g <= 2500 THEN 'https://other.example.net/crowd-' || g || '/' ELSE 'https://' || ${HOST_A} || '/crowd-' || g || '/' END),
                         now(), now() - interval '1 second' * g / 10000, 1, CASE WHEN g > 2500 THEN 'noindex,follow' END, now()
                    FROM generate_series(1, 5000) g`;
      await owner`UPDATE lumibase_site_render_versions SET version = nextval('heopress_render_version_seq') WHERE site_id = ${A}`;
      await owner`SELECT set_config('app.site_id', '', false)`;
      expect(locs(await text(HOST_A, '/news-sitemap.xml'))).toEqual([`https://${HOST_A}/news-fresh/`]);
      // And 600 newer ones on this host that pass the query's filter but are canonical to another address: read past the
      // first page of 500. (Dated just after the fresh article: the database's clock may run ahead of this one.)
      const [freshRow] = await db.select({ t: publicItemsTable.publishedAt }).from(publicItemsTable).where(eq(publicItemsTable.itemId, fresh.id));
      const freshAt = freshRow!.t!.toISOString();
      await owner`SELECT set_config('app.site_id', ${A}, false)`;
      await owner`INSERT INTO lumibase_public_items (item_id, site_id, collection, locale, path, data, card, updated_at, published_at, sanitizer, content_modified_at)
                  SELECT 'ndup-' || g, ${A}, 'articles', 'en', '/ndup-' || g, jsonb_build_object('title', 'Dup ' || g, 'canonical_url', 'https://example.org/n-' || g || '/'),
                         jsonb_build_object('url', 'https://' || ${HOST_A} || '/ndup-' || g || '/'), now(), ${freshAt}::timestamptz + interval '1 microsecond' * g, 1, now()
                    FROM generate_series(1, 600) g`;
      await owner`UPDATE lumibase_site_render_versions SET version = nextval('heopress_render_version_seq') WHERE site_id = ${A}`;
      await owner`SELECT set_config('app.site_id', '', false)`;
      expect(locs(await text(HOST_A, '/news-sitemap.xml'))).toEqual([`https://${HOST_A}/news-fresh/`]);
      // A clock that moves: warm the news sitemap, then cross the fresh article's 48-hour boundary — no stale answer.
      const [pub] = await db.select({ t: publicItemsTable.publishedAt }).from(publicItemsTable).where(eq(publicItemsTable.itemId, fresh.id));
      let clock = Date.now();
      const timed = createSiteClassic({ db: renderDb, now: () => clock, sweepIntervalMs: 0 });
      try {
        const at = (p: string) => timed.app.request(p, { headers: { host: HOST_A } });
        expect(locs(await (await at('/news-sitemap.xml')).text())).toEqual([`https://${HOST_A}/news-fresh/`]);
        expect((await at('/news-sitemap.xml')).headers.get('x-cache')).toBe('hit');
        clock = pub!.t!.getTime() + 48 * 3600_000 - 1000;
        expect(locs(await (await at('/news-sitemap.xml')).text())).toEqual([`https://${HOST_A}/news-fresh/`]);
        clock = pub!.t!.getTime() + 48 * 3600_000 + 1000;
        const after = await at('/news-sitemap.xml');
        expect(after.headers.get('x-cache')).toBe('miss');
        expect(locs(await after.text())).toEqual([]);
        // The shared level too: another process at the same time does not take the old answer, and the expired row is
        // replaced by the new one (no sweep has run).
        const shared = async () =>
          (await db.select({ body: renderCache.body, expiresAt: renderCache.expiresAt }).from(renderCache).where(and(eq(renderCache.siteId, A), sql`${renderCache.body} LIKE '%xmlns:news%'`)));
        const other = createSiteClassic({ db: renderDb, now: () => clock, sweepIntervalMs: 0 });
        try {
          expect(locs(await (await other.app.request('/news-sitemap.xml', { headers: { host: HOST_A } })).text())).toEqual([]);
          // Of the rows still valid at this time: only the new answer (rows of older versions have expired too).
          await vi.waitFor(async () => expect((await shared()).filter((r) => r.expiresAt.getTime() > clock).map((r) => locs(r.body))).toEqual([[]]));
        } finally {
          await other.close();
        }
        // An article whose publication is still ahead (a clock ahead of this one): the empty answer lasts until then.
        const later = await article(A, 'news-later');
        const laterAt = clock + 3600_000;
        await db.update(itemsTable).set({ publishedAt: new Date(laterAt) }).where(eq(itemsTable.id, later.id));
        await rebuildSiteProjection(db, A);
        expect(locs(await (await at('/news-sitemap.xml')).text())).toEqual([]);
        expect((await at('/news-sitemap.xml')).headers.get('x-cache')).toBe('hit');
        clock = laterAt + 1000;
        expect(locs(await (await at('/news-sitemap.xml')).text())).toEqual([`https://${HOST_A}/news-later/`]);
      } finally {
        await timed.close();
      }
    });
  });

  describe('HeoPress P07 batch 7: robots.txt and root files', () => {
    const seo = (siteId: string) => new SeoSettingsService({ db, siteId, actor: { userId: null } });
    const rootFiles = (siteId: string) => new RootFilesService({ db, siteId, actor: { userId: null, email: 'admin@example.com' } });

    it('task 3.2: robots.txt keeps the training crawlers out, not AI search or Googlebot; declares the sitemaps and feeds; per site', async () => {
      const plain = await get(HOST_A, '/robots.txt');
      expect(plain.status).toBe(200);
      expect(plain.headers.get('content-type')).toBe('text/plain; charset=utf-8');
      const before = await plain.text();
      expect(before).not.toContain('Disallow: /');
      expect(before).toContain(`Sitemap: https://${HOST_A}/sitemap.xml`);
      expect(before).toContain(`# Feed: https://${HOST_A}/feed.xml`);
      await seo(A).update({ version: 0, crawlers: { purposes: { training: 'disallow' }, contentSignal: true }, discovery: { newsSitemap: true } });
      const txt = await (await get(HOST_A, '/robots.txt')).text();
      const group = txt.split('\n\n').find((g) => g.includes('Disallow: /'))!;
      for (const ua of ['GPTBot', 'ClaudeBot', 'CCBot']) expect(group).toContain(`User-agent: ${ua}\n`);
      for (const ua of ['OAI-SearchBot', 'PerplexityBot', 'Googlebot']) expect(group).not.toContain(`User-agent: ${ua}\n`);
      expect(txt).toContain('Content-Signal: search=yes, ai-input=yes, ai-train=no');
      expect(txt).toContain(`Sitemap: https://${HOST_A}/news-sitemap.xml`);
      // The other site has its own policy; an alias goes to the primary host first.
      expect(await (await get(HOST_B, '/robots.txt')).text()).not.toContain('Disallow: /');
      expect((await get(ALIAS_A, '/robots.txt')).headers.get('location')).toBe(`https://${HOST_A}/robots.txt`);
    });

    it('task 3.8: a verification file is served at the root with its type; system names, bad names and large files are refused; per site; audited', async () => {
      const name = 'google0123abcd.html';
      await rootFiles(A).put(name, 'google-site-verification: google0123abcd.html');
      const res = await get(HOST_A, `/${name}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");
      expect(await res.text()).toBe('google-site-verification: google0123abcd.html');
      // 304 replays the same headers.
      const again = await get(HOST_A, `/${name}`, { 'if-none-match': res.headers.get('etag')! });
      expect(again.status).toBe(304);
      expect(again.headers.get('x-content-type-options')).toBe('nosniff');
      // Another site does not have it; the same name there is its own file.
      expect((await get(HOST_B, `/${name}`)).status).toBe(404);
      await rootFiles(B).put(name, 'site B');
      expect(await (await get(HOST_B, `/${name}`)).text()).toBe('site B');
      expect(await (await get(HOST_A, `/${name}`)).text()).toBe('google-site-verification: google0123abcd.html');
      // ads.txt as plain text; replaced at once (the render version moves), then gone.
      await rootFiles(A).put('ads.txt', 'example.com, pub-1, DIRECT');
      expect((await get(HOST_A, '/ads.txt')).headers.get('content-type')).toBe('text/plain; charset=utf-8');
      await rootFiles(A).put('ads.txt', 'example.com, pub-2, DIRECT');
      expect(await (await get(HOST_A, '/ads.txt')).text()).toBe('example.com, pub-2, DIRECT');
      await rootFiles(A).remove('ads.txt');
      expect((await get(HOST_A, '/ads.txt')).status).toBe(404);
      // Refused: what the system makes, names that are not one plain file name, controls, too large.
      const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code);
      for (const n of ['robots.txt', 'ROBOTS.TXT', 'sitemap.xml', 'sitemap-2.xml', 'sitemap.txt', 'news-sitemap.xml', 'llms.txt', 'llms-full.txt', 'feed.xml', 'atom.xml', `${'a'.repeat(32)}.txt`]) {
        expect(await code(rootFiles(A).put(n, 'x')), n).toBe('SYSTEM_FILE');
      }
      for (const n of ['.env', '.git', 'a/b.txt', 'evil.php', 'noext', '../x.txt', 'x.TXTX']) expect(await code(rootFiles(A).put(n, 'x')), n).toBe('INVALID_NAME');
      expect(await code(rootFiles(A).put('bin.txt', 'a\u0000b')), 'nul').toBe('INVALID_CONTENT');
      expect(await code(rootFiles(A).put('big.txt', 'x'.repeat(512 * 1024 + 1))), 'big').toBe('TOO_LARGE');
      // The IndexNow key file (P07 task 3.4): the key at /<key>.txt while IndexNow is on, on this site only; not a root file.
      const { settings: on } = await seo(A).update({ version: (await seo(A).get()).version, discovery: { indexNow: true } });
      const key = on.discovery.indexNowKey!;
      const keyFile = await get(HOST_A, `/${key}.txt`);
      expect(keyFile.status).toBe(200);
      expect(keyFile.headers.get('content-type')).toBe('text/plain; charset=utf-8');
      expect(await keyFile.text()).toBe(key);
      expect((await get(HOST_B, `/${key}.txt`)).status).toBe(404);
      expect(await code(rootFiles(A).put(`${key}.txt`, 'x')), 'key name').toBe('SYSTEM_FILE');
      await seo(A).update({ ...on, version: (await seo(A).get()).version, discovery: { ...on.discovery, indexNow: false } });
      expect((await get(HOST_A, `/${key}.txt`)).status).toBe(404);
      // The robots.txt the system makes is still the one served.
      expect(await (await get(HOST_A, '/robots.txt')).text()).toContain('User-agent: *');
      // Audited, in the site's own log.
      const events = await db.select({ event: auditLog.event, metadata: auditLog.metadata }).from(auditLog).where(and(eq(auditLog.siteId, A), inArray(auditLog.event, ['root_file_written', 'root_file_deleted'])));
      expect(events.map((e) => e.event).sort()).toEqual(['root_file_deleted', 'root_file_written', 'root_file_written', 'root_file_written']);
      expect(events.find((e) => e.event === 'root_file_deleted')!.metadata).toMatchObject({ filename: 'ads.txt' });
      expect((await rootFiles(A).list()).map((f) => f.filename)).toEqual([name]);
    });
  });

  describe('HeoPress P07 batch 9: llms.txt and Markdown copies', () => {
    const seo = (siteId: string) => new SeoSettingsService({ db, siteId, actor: { userId: null } });
    const headOf = (html: string) => /<head>([\s\S]*?)<\/head>/.exec(html)?.[1] ?? '';
    const setDiscovery = async (siteId: string, discovery: Record<string, unknown>) => {
      const { settings, version } = await seo(siteId).get();
      await seo(siteId).update({ ...settings, version, discovery: { ...settings.discovery, ...discovery } });
    };

    it('task 4.1: llms.txt names the site, its pages and recent articles and its discovery files; llms-full.txt their text; nothing not indexable', async () => {
      await article(A, 'llm-one', { excerpt: 'First excerpt.', body: '<h2>Part</h2><p>Body with <a href="/llm-two/">a link</a>.</p>' });
      await article(A, 'llm-hidden', { seo_robots: 'noindex,follow', body: '<p>SECRET-NOINDEX-BODY</p>' });
      await article(A, 'llm-dup', { canonical_url: 'https://example.org/original/', body: '<p>DUPLICATE-BODY</p>' });
      await items(A).create('pages', { data: { title: 'About us', slug: 'about-us', locale: 'en', excerpt: 'Who we are.', body: '<p>About body.</p>' }, status: 'published' });
      const res = await get(HOST_A, '/llms.txt');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
      const txt = await res.text();
      expect(txt.startsWith('# Site Alpha\n\n> Site Alpha.\n')).toBe(true);
      expect(txt).toContain(`## Pages\n- [About us](https://${HOST_A}/about-us/): Who we are.`);
      expect(txt).toContain(`- [Title llm-one](https://${HOST_A}/llm-one/): First excerpt.`);
      expect(txt).toContain(`- [RSS feed](https://${HOST_A}/feed.xml)`);
      expect(txt).toContain(`- [Full text](https://${HOST_A}/llms-full.txt)`);
      expect(txt).not.toMatch(/llm-hidden|llm-dup/);
      const full = await (await get(HOST_A, '/llms-full.txt')).text();
      expect(full).toContain(`# Title llm-one`);
      expect(full).toContain(`## Part\n\nBody with [a link](https://${HOST_A}/llm-two/).`);
      expect(full).toContain('About body.');
      expect(full).not.toMatch(/SECRET-NOINDEX-BODY|DUPLICATE-BODY/);
      // The other site lists its own only; turned off: not found.
      expect(await (await get(HOST_B, '/llms.txt')).text()).not.toContain('llm-one');
      await setDiscovery(A, { llms: false });
      expect((await get(HOST_A, '/llms.txt')).status).toBe(404);
      expect((await get(HOST_A, '/llms-full.txt')).status).toBe(404);
    });

    it('Codex review of batch 9: titles and descriptions stay text; a rich-text excerpt is described; any item collection is listed', async () => {
      await article(A, 'evil-title', { title: '<img src=x onerror=alert(1)> # [x]', excerpt: '<b>not bold</b>' });
      const txt = await (await get(HOST_A, '/llms.txt')).text();
      expect(txt).toContain('[\\<img src=x onerror=alert(1)\\> \\# \\[x\\]]');
      // No `<` that is not escaped (raw HTML).
      expect(txt).not.toMatch(/(^|[^\\])</);
      const md = await (await get(HOST_A, '/evil-title.md')).text();
      expect(md.startsWith('# \\<img src=x onerror=alert(1)\\> \\# \\[x\\]\n')).toBe(true);
      expect(md.split('- URL:')[0]).not.toMatch(/(^|[^\\])</);
      // A rich-text excerpt: its text is the description, in llms.txt and llms-full.txt.
      await new SchemaService({ db, siteId: A }).updateField('articles', 'excerpt', { interface: 'wysiwyg' });
      await article(A, 'rich-excerpt', { excerpt: '<p>Rich <strong>summary</strong></p>' });
      expect(await (await get(HOST_A, '/llms.txt')).text()).toContain(`- [Title rich-excerpt](https://${HOST_A}/rich-excerpt/): Rich summary`);
      expect(await (await get(HOST_A, '/llms-full.txt')).text()).toContain('# Title rich-excerpt\n\n> Rich summary');
      // A collection of the site's own whose pages are items: listed with the pages.
      const schema = new SchemaService({ db, siteId: A });
      await schema.createCollection({ name: 'guides' } as never);
      for (const f of [
        { name: 'title', type: 'string', interface: 'input' },
        { name: 'slug', type: 'string', interface: 'slug' },
        { name: 'locale', type: 'string', interface: 'input' },
      ]) await schema.createField('guides', f as never);
      const [cs] = await db.select().from(siteContentSettings).where(eq(siteContentSettings.siteId, A));
      await settings(A, { availableLocales: cs!.availableLocales, localePrefixes: cs!.localePrefixes, permalinks: { ...cs!.permalinks, guides: '/guides/:slug' } });
      await items(A).create('guides', { data: { title: 'A guide', slug: 'a-guide', locale: 'en' }, status: 'published' });
      expect(await (await get(HOST_A, '/llms.txt')).text()).toContain(`- [A guide](https://${HOST_A}/guides/a-guide/)`);
    });

    it('task 4.2: a page\'s Markdown copy — noindex, canonical Link, its facts and body; declared in the head; none for a page not indexed or when turned off; a real .md route first', async () => {
      await article(A, 'md-post', { excerpt: 'An excerpt.', body: '<p>Hello <strong>world</strong>.</p>' });
      const res = await get(HOST_A, '/md-post.md');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
      expect(res.headers.get('x-robots-tag')).toBe('noindex');
      expect(res.headers.get('link')).toBe(`<https://${HOST_A}/md-post/>; rel="canonical"`);
      const md = await res.text();
      expect(md).toMatch(new RegExp(`^# Title md-post\n\n> An excerpt\\.\n\n- URL: <https://${HOST_A.replace(/\./g, '\\.')}/md-post/>\n- Published: `));
      expect(md).toContain('Hello **world**.');
      // HEAD and 304 replay the headers.
      const again = await get(HOST_A, '/md-post.md', { 'if-none-match': res.headers.get('etag')! });
      expect(again.status).toBe(304);
      expect(again.headers.get('x-robots-tag')).toBe('noindex');
      // Declared in the page's head.
      expect(headOf(await (await get(HOST_A, '/md-post/')).text())).toContain(`<link rel="alternate" type="text/markdown" href="https://${HOST_A}/md-post.md">`);
      // Not indexed: no copy, none declared.
      await article(A, 'md-hidden', { seo_robots: 'noindex,follow' });
      expect((await get(HOST_A, '/md-hidden.md')).status).toBe(404);
      expect(headOf(await (await get(HOST_A, '/md-hidden/')).text())).not.toContain('text/markdown');
      // Only at its own address.
      expect((await get(HOST_A, '/md-post/.md')).status).toBe(404);
      expect((await get(HOST_B, '/md-post.md')).status).toBe(404);
      // A real route ending in `.md` is the page itself, not a copy of another.
      await article(A, 'guide');
      await article(A, 'guide.md', { body: '<p>REAL-MD-ROUTE</p>' });
      const real = await get(HOST_A, '/guide.md/');
      expect(real.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(await real.text()).toContain('REAL-MD-ROUTE');
      const bare = await get(HOST_A, '/guide.md');
      expect(bare.headers.get('content-type')).not.toBe('text/markdown; charset=utf-8');
      // And `/guide/` does not declare `/guide.md` as its copy: that address is the real route's (Codex review of batch 9).
      expect(headOf(await (await get(HOST_A, '/guide/')).text())).not.toContain('text/markdown');
      // A copy asked with a query: the same answer, not one shared row per query (Codex review of batch 9). Rows of the
      // current render version (earlier versions' rows wait for the sweep).
      const currentVersion = async () => (await db.select({ v: siteRenderVersions.version }).from(siteRenderVersions).where(eq(siteRenderVersions.siteId, A)))[0]!.v;
      await get(HOST_A, '/md-post.md');
      await vi.waitFor(async () => expect((await db.select({ k: renderCache.key }).from(renderCache).where(and(eq(renderCache.siteId, A), eq(renderCache.contentType, 'text/markdown; charset=utf-8'), eq(renderCache.siteVersion, await currentVersion())))).length).toBe(1));
      for (const q of ['?page=2', '?page=3', '?page=4']) expect((await get(HOST_A, `/md-post.md${q}`)).headers.get('content-type')).toBe('text/markdown; charset=utf-8');
      await new Promise((r) => setTimeout(r, 200));
      expect((await db.select({ k: renderCache.key }).from(renderCache).where(and(eq(renderCache.siteId, A), eq(renderCache.contentType, 'text/markdown; charset=utf-8'), eq(renderCache.siteVersion, await currentVersion())))).length).toBe(1);
      // Canonical to another address (spec seo/page-metadata "canonical 指向其他地址"): no copy, none declared, not in Atom.
      await article(A, 'md-dup', { canonical_url: 'https://example.org/original/' });
      expect((await get(HOST_A, '/md-dup.md')).status).toBe(404);
      expect(headOf(await (await get(HOST_A, '/md-dup/')).text())).not.toContain('text/markdown');
      expect(await (await get(HOST_A, '/atom.xml')).text()).not.toContain('md-dup');
      // Its facts after a content edit (spec "请求副本"): the real modification time.
      const edited = await article(A, 'md-edited', { body: '<p>First.</p>' });
      await new Promise((r) => setTimeout(r, 5));
      await items(A).patch('articles', edited.id, { data: { body: '<p>Second.</p>' }, expectedVersion: edited.version });
      const [editedRow] = await db.select({ m: publicItemsTable.contentModifiedAt, p: publicItemsTable.publishedAt }).from(publicItemsTable).where(eq(publicItemsTable.itemId, edited.id));
      expect(editedRow!.m!.getTime()).toBeGreaterThan(editedRow!.p!.getTime());
      const editedMd = await (await get(HOST_A, '/md-edited.md')).text();
      expect(editedMd).toContain(`- Modified: ${editedRow!.m!.toISOString()}`);
      expect(editedMd).toContain('Second.');
      // A page several segments deep (`/:year/:month/:slug`): its copy beside it.
      const [cs] = await db.select().from(siteContentSettings).where(eq(siteContentSettings.siteId, A));
      await settings(A, { availableLocales: cs!.availableLocales, localePrefixes: cs!.localePrefixes, permalinks: { ...cs!.permalinks, articles: '/:year/:month/:slug' } });
      const deep = await article(A, 'md-deep', { body: '<p>DEEP-BODY</p>' });
      const [deepRow] = await db.select({ url: sql<string>`${publicItemsTable.card} ->> 'url'` }).from(publicItemsTable).where(eq(publicItemsTable.itemId, deep.id));
      expect(deepRow!.url).toMatch(new RegExp(`^https://${HOST_A.replace(/\./g, '\\.')}/\\d{4}/\\d{2}/md-deep/$`));
      const deepCopy = await get(HOST_A, `${new URL(deepRow!.url).pathname.replace(/\/$/, '')}.md`);
      expect(deepCopy.status).toBe(200);
      expect(deepCopy.headers.get('link')).toBe(`<${deepRow!.url}>; rel="canonical"`);
      expect(await deepCopy.text()).toContain('DEEP-BODY');
      // Turned off: not found, not declared.
      await setDiscovery(A, { markdownCopies: false });
      expect((await get(HOST_A, '/md-post.md')).status).toBe(404);
      expect(headOf(await (await get(HOST_A, '/md-post/')).text())).not.toContain('text/markdown');
    });
  });

  it('a site waiting for a rebuild answers 503, the other site is unaffected', async () => {
    await article(A, 'during-rebuild');
    await db.insert(projectionRebuilds).values({ siteId: A, reason: 'test' });
    expect((await get(HOST_A, '/during-rebuild/')).status).toBe(503);
    // No redirect from stale data either: an alias, a missing slash, a home page.
    for (const [host, path] of [[ALIAS_A, '/during-rebuild/'], [HOST_A, '/during-rebuild'], [HOST_A, '/']] as const) {
      const res = await get(host, path);
      expect(res.status, `${host}${path}`).toBe(503);
      expect(res.headers.get('location')).toBeNull();
    }
    expect((await get(HOST_B, '/')).status).toBe(200);
    await rebuildSiteProjection(db, A);
    expect((await get(HOST_A, '/during-rebuild/')).status).toBe(200);
  });

  it('on a real port: the raw request target is used — absolute-form names the host, dot and empty segments are refused', async () => {
    await article(A, 'on-port');
    const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const { port } = server.address() as AddressInfo;
    const send = (path: string, host: string) =>
      new Promise<{ status: number; location?: string }>((resolve, reject) => {
        const req = httpRequest({ host: '127.0.0.1', port, path, headers: { host } }, (res) => {
          res.resume();
          res.on('end', () => resolve({ status: res.statusCode!, location: res.headers.location }));
        });
        req.on('error', reject);
        req.end();
      });
    try {
      expect(await send('/on-port/', HOST_A)).toMatchObject({ status: 200 });
      // Absolute-form: its authority is the host, the Host header does not count.
      expect(await send(`http://${HOST_A}/on-port/`, 'nobody.example.org')).toMatchObject({ status: 200 });
      expect(await send(`http://${HOST_A}`, HOST_B)).toMatchObject({ status: 200 });
      expect(await send(`http://${HOST_A}/admin`, HOST_A)).toMatchObject({ status: 404 });
      // An authority URL parsers read differently (userinfo, backslash) is refused, never another site.
      // (Node's parser may refuse some with 400 before the app sees them.)
      for (const target of [`http://${HOST_A}\\@${HOST_B}/`, `http://user@${HOST_B}/`, `http://${HOST_B}@${HOST_A}/`]) {
        expect([400, 404], target).toContain((await send(target, HOST_A)).status);
      }
      // Not normalised away: refused as paths no route can have.
      expect(await send('/x/../on-port/', HOST_A)).toMatchObject({ status: 404 });
      expect(await send('//on-port/', HOST_A)).toMatchObject({ status: 404 });
      // X-Forwarded-Host from an untrusted peer is ignored.
      const forwarded = await new Promise<number>((resolve, reject) => {
        const req = httpRequest({ host: '127.0.0.1', port, path: '/on-port/', headers: { host: HOST_B, 'x-forwarded-host': HOST_A } }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode!));
        });
        req.on('error', reject);
        req.end();
      });
      expect(forwarded).toBe(404);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('task 7.3: on a real port, X-Forwarded-Host counts only from a configured trusted proxy; an unknown host is 404, never a default site', async () => {
    await article(A, 'proxied', { title: 'Alpha proxied' });
    await article(B, 'proxied', { title: 'Beta proxied' });
    const listen = async (trusted: string | undefined) => {
      const svc = createSiteClassic({ db: renderDb, trustedProxies: trusted, sweepIntervalMs: 0 });
      const server = serve({ fetch: svc.app.fetch, port: 0, hostname: '127.0.0.1' });
      await new Promise<void>((resolve) => server.once('listening', () => resolve()));
      return { svc, server, port: (server.address() as AddressInfo).port };
    };
    const send = (port: number, headers: Record<string, string>) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = httpRequest({ host: '127.0.0.1', port, path: '/proxied/', headers }, (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (d: string) => (body += d));
          res.on('end', () => resolve({ status: res.statusCode!, body }));
        });
        req.on('error', reject);
        req.end();
      });
    // The proxy is this host (the test client connects from 127.0.0.1), by address and by range.
    for (const trusted of ['127.0.0.1', '127.0.0.0/8', '10.0.0.1, 127.0.0.1']) {
      const { svc, server, port } = await listen(trusted);
      try {
        const viaProxy = await send(port, { host: 'proxy.internal.example', 'x-forwarded-host': HOST_A });
        expect(viaProxy.status, trusted).toBe(200);
        expect(viaProxy.body).toContain('Alpha proxied');
        // The right-most value of a list (the one the proxy wrote); case and port normalised.
        const listed = await send(port, { host: HOST_A, 'x-forwarded-host': `${HOST_A}, ${HOST_B.toUpperCase()}:443` });
        expect(listed.body).toContain('Beta proxied');
        expect(listed.body).not.toContain('Alpha proxied');
        // A forwarded host no site has: 404, not the Host header's site and not a default site.
        const unknown = await send(port, { host: HOST_A, 'x-forwarded-host': 'nobody.example.org' });
        expect(unknown.status).toBe(404);
        expect(unknown.body).toBe('Not found');
        // No forwarded header: the Host header.
        expect((await send(port, { host: HOST_B })).body).toContain('Beta proxied');
      } finally {
        await new Promise((resolve) => server.close(resolve));
        await svc.close();
      }
    }
    // Not trusted (no list, or a list without this peer): the header is ignored, Host decides.
    for (const trusted of [undefined, '', '10.0.0.0/8', '::1', 'not-an-address', '127.0.0.1/999']) {
      const { svc, server, port } = await listen(trusted);
      try {
        const spoofed = await send(port, { host: HOST_B, 'x-forwarded-host': HOST_A });
        expect(spoofed.status, String(trusted)).toBe(200);
        expect(spoofed.body).toContain('Beta proxied');
        expect(spoofed.body).not.toContain('Alpha proxied');
        const unknown = await send(port, { host: 'nobody.example.org', 'x-forwarded-host': HOST_A });
        expect(unknown.status, String(trusted)).toBe(404);
        expect(unknown.body).toBe('Not found');
      } finally {
        await new Promise((resolve) => server.close(resolve));
        await svc.close();
      }
    }
  });

  it('task 1.2: the service runs as the rendering role — base and administration tables are refused', async () => {
    for (const table of ['lumibase_items', 'lumibase_users', 'lumibase_redirects', 'lumibase_cdc_change_events', 'lumibase_projection_dirty']) {
      await expect(renderClient.unsafe(`SELECT 1 FROM ${table} LIMIT 1`), table).rejects.toThrow(/permission denied/);
    }
    // A domain written in a site transaction is served at once (the projection follows the write).
    await runSiteTransaction(db, B, (tx) => tx.insert(siteDomains).values({ siteId: B, hostname: 'sc-b2.example.com', kind: 'custom', status: 'active', verifiedAt: new Date() }));
    const alias = await get('sc-b2.example.com', '/');
    expect(alias.status).toBe(301);
    expect(alias.headers.get('location')).toBe(`https://${HOST_B}/`);
  });
});
