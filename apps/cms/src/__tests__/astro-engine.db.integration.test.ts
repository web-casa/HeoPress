import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { astroBuilds, astroSites, ensureRenderRole, schema, siteContentSettings, siteDomains, sites, type Database } from '@heopress/database';
import { createSiteClassic, type SiteClassic } from '@heopress/site-classic';
import { exportPageData } from '@heopress/site-classic/page-data';
import { buildSiteGeneration, liveGeneration, pageFile, templateDir, type SiteBuildOptions } from '@heopress/site-astro';
import type { PageDataSnapshot } from '@heopress/contracts/page-data';
import { ItemService } from '../services/item-service';
import { ContentSettingsService } from '../services/site-network/content-settings-service';
import { TranslationGroupService } from '../services/site-network/translation-group-service';
import { upgradeSitePreset } from '../services/site-network/preset-installer';
import { rebuildSiteProjection } from '../services/site-network/public-projection';
import { AstroEngine, astroReconciliation } from '../services/astro/astro-engine';
import { connectDbIntegration, dbIntegrationUrl, hasDbIntegrationUrl } from './helpers/db-harness';

/**
 * The Astro engine against the real data path (HeoPress P11 tasks 3.2–3.6; spec rendering/astro-engine).
 *
 * SEO / GEO equivalence (task 3.4): one site's data — two languages across a cross-site translation group (hreflang and
 * x-default), a category, an author, a sponsored article with an outside link, a page, a noindex page — is rendered by
 * the Classic engine (as the rendering role) and, through the read-only page data interface, built by the Astro engine
 * with the official starter theme. For every page the canonical, hreflang, JSON-LD, robots, title, description and
 * Markdown copy declaration are compared; robots.txt, the sitemaps, the feeds, llms.txt, llms-full.txt and the Markdown
 * copies byte for byte; the sponsored article's disclosure and `rel` attributes too (task 3.6).
 *
 * The engine (tasks 3.2, 3.3, 3.5): five publications within a minute are one build containing all five; a late older
 * build does not go live; a failed build keeps the live version; a lost event is repaired by reconciliation.
 *
 * Needs DATABASE_OWNER_URL (to provision this suite's rendering role, as a deployment does).
 */

const RENDER_ROLE = 'heopress_render_astro_engine';
const OWNER_URL = process.env.DATABASE_OWNER_URL?.trim() || undefined;
const NOW = Date.parse('2026-10-01T12:00:00Z');
const at = (iso: string) => new Date(iso);
const SITES = {
  en: { id: 'site_p11_astro_en', host: 'astro-notes.example.com', name: 'Astro Notes', language: 'en' },
  zh: { id: 'site_p11_astro_zh', host: 'astro-notes.example.cn', name: '星笔记', language: 'zh-CN' },
} as const;
const SITE_IDS = Object.values(SITES).map((s) => s.id);
const PERMALINKS = { articles: '/:slug', pages: '/:slug', categories: '/category/:slug', tags: '/tag/:slug', authors: '/author/:slug' };

describe.skipIf(!hasDbIntegrationUrl)('Astro engine — DB integration (P11 tasks 3.2–3.6)', () => {
  let db: Database;
  let owner: postgres.Sql;
  let renderClient: postgres.Sql;
  let renderDb: Database;
  let classic: SiteClassic;
  let root: string;
  let clock = NOW;
  const now = () => new Date(clock);

  const items = (siteId: string) => new ItemService({ db, siteId });
  async function publish(siteId: string, collection: string, publishedAt: string, data: Record<string, unknown>) {
    return ((await items(siteId).create(collection, { data, status: 'published', publishedAt: at(publishedAt) })) as { id: string }).id;
  }
  async function contentSettings(siteId: string, over: Record<string, unknown>) {
    const [r] = await db.select().from(siteContentSettings).where(eq(siteContentSettings.siteId, siteId));
    await new ContentSettingsService({ db, siteId, actor: { userId: null } }).update({
      availableLocales: r!.availableLocales,
      timezone: 'UTC',
      siteType: 'blog',
      trailingSlash: 'always',
      localeStrategy: 'subdirectory',
      localePrefixMode: 'default_at_root',
      localePrefixes: {},
      permalinks: PERMALINKS,
      allowCrossSiteTranslations: true,
      sponsorDisclosure: true,
      sponsorRel: true,
      version: r!.version,
      ...over,
    } as never);
  }

  beforeAll(async () => {
    expect(OWNER_URL, 'DATABASE_OWNER_URL is required to provision the rendering role').toBeDefined();
    db = await connectDbIntegration('astro-engine');
    owner = postgres(OWNER_URL!, { max: 1, onnotice: () => {} });
    const password = randomBytes(18).toString('hex');
    await owner.begin((tx) => ensureRenderRole(tx, { role: RENDER_ROLE, password }));
    const url = new URL(dbIntegrationUrl!);
    url.username = RENDER_ROLE;
    url.password = password;
    renderClient = postgres(url.toString(), { max: 2, onnotice: () => {} });
    renderDb = drizzle(renderClient, { schema }) as unknown as Database;
    classic = createSiteClassic({ db: renderDb, now: () => NOW, traffic: false, sweepIntervalMs: 0 });
    root = await mkdtemp(join(tmpdir(), 'heopress-astro-db-'));

    await db.delete(sites).where(inArray(sites.id, SITE_IDS));
    await db.insert(sites).values([
      { id: SITES.en.id, name: SITES.en.name, defaultLanguage: 'en', descriptor: 'Notes on the night sky.' },
      { id: SITES.zh.id, name: SITES.zh.name, defaultLanguage: 'zh-CN' },
    ]);
    for (const id of SITE_IDS) await upgradeSitePreset(db, id);
    await db.insert(siteDomains).values(
      Object.values(SITES).map((s) => ({ siteId: s.id, hostname: s.host, kind: 'custom', status: 'active', isPrimary: true, verifiedAt: at('2026-09-01T00:00:00Z') })),
    );
    await contentSettings(SITES.en.id, { availableLocales: ['en'] });
    await contentSettings(SITES.zh.id, { availableLocales: ['zh-CN'] });
    for (const id of SITE_IDS) await rebuildSiteProjection(db, id);

    const guides = await publish(SITES.en.id, 'categories', '2026-09-01T00:00:00Z', { name: 'Guides', slug: 'guides', description: 'Observing guides.' });
    const ada = await publish(SITES.en.id, 'authors', '2026-09-01T00:00:00Z', { name: 'Ada Example', slug: 'ada' });
    const en = await publish(SITES.en.id, 'articles', '2026-09-30T06:00:00Z', {
      title: 'Watching the Moon',
      slug: 'moon-watching',
      locale: 'en',
      excerpt: 'When the Moon is best seen.',
      seo_description: 'A guide to watching the Moon.',
      body: '<h2>Phases</h2><p>See the <a href="/telescopes/">telescope notes</a>.</p>',
      faq: [{ question: 'When is the Moon brightest?', answer: 'At full Moon.' }],
      categories: [guides],
      primary_category: guides,
      author: ada,
    });
    await publish(SITES.en.id, 'articles', '2026-09-20T06:00:00Z', {
      title: 'Telescopes for beginners',
      slug: 'telescopes',
      locale: 'en',
      excerpt: 'Our sponsor lends telescopes.',
      body: '<p>Borrow one from <a href="https://lenses.example.org/rent">Example Lenses</a> or read <a href="/moon-watching/">our guide</a>.</p>',
      sponsored: true,
      sponsor_name: 'Example Lenses',
      author: ada,
    });
    await publish(SITES.en.id, 'pages', '2026-09-01T00:00:00Z', { title: 'About', slug: 'about', locale: 'en', body: '<p>We watch the sky.</p>' });
    await publish(SITES.en.id, 'pages', '2026-09-02T00:00:00Z', { title: 'Members', slug: 'members', locale: 'en', seo_robots: 'noindex,follow', body: '<p>Members only.</p>' });
    const zh = await publish(SITES.zh.id, 'articles', '2026-09-30T08:00:00Z', { title: '赏月', slug: 'moon-watching', locale: 'zh-CN', body: '<p>月相。</p>' });
    const groups = new TranslationGroupService({ db, siteId: SITES.en.id, actor: undefined, userId: null, itemsOn: (siteId, tx) => new ItemService({ db: tx as never, siteId }) });
    const group = await groups.create(en);
    const joined = await groups.addMember(group.id, { siteId: SITES.zh.id, itemId: zh, expectedVersion: group.version });
    await groups.setXDefault(group.id, en, joined.version);
  }, 180_000);

  afterAll(async () => {
    await db?.delete(sites).where(inArray(sites.id, SITE_IDS));
    await classic?.close();
    await renderClient?.end({ timeout: 2 });
    await owner?.end({ timeout: 2 });
    if (root) await rm(root, { recursive: true, force: true });
    await rm(join(templateDir(), 'themes', '.operator'), { recursive: true, force: true });
  });

  const engine = (over: Partial<ConstructorParameters<typeof AstroEngine>[0]> = {}) => new AstroEngine({ db, renderDb, root, now, debounceMs: 60_000, ...over });

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
      markdown: all(/<link rel="alternate" type="text\/markdown" href="([^"]*)">/g),
      feeds: all(/<link rel="alternate" type="(application\/(?:rss|atom)\+xml)" title="[^"]*" href="([^"]*)">/g),
      meta: all(/<meta (?:property|name)="((?:og|twitter|article):[^"]*)" content="([^"]*)">/g).sort(),
      jsonLd: [...head.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]!) as unknown),
    };
  }
  const disclosureOf = (html: string) => [...html.matchAll(/<aside class="heopress-disclosure" role="note">([^<]*)<\/aside>/g)].map((m) => m[1]);
  const bodyOf = (html: string) => /<div class="heopress-body">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? null;
  const relsOf = (html: string | null) => [...(html ?? '').matchAll(/<a ([^>]*)>/g)].map((m) => `${/href="([^"]*)"/.exec(m[1]!)?.[1]} rel=${/rel="([^"]*)"/.exec(m[1]!)?.[1] ?? ''}`);

  let snapshot: PageDataSnapshot;
  let live: string;

  it('builds the site from the read-only page data interface with the official starter theme (task 3.1)', async () => {
    const e = engine();
    await e.enable(SITES.en.id, 'official:starter');
    const report = await e.buildNow(SITES.en.id, 'enable');
    expect(report.status, report.error).toBe('succeeded');
    snapshot = await exportPageData({ db: renderDb, siteId: SITES.en.id, now: () => NOW });
    expect(report.revision).toBe(snapshot.revision);
    live = join(root, SITES.en.id, 'current');
    expect(await liveGeneration(root, SITES.en.id)).toBe(report.generation);
    expect(snapshot.pages.map((p) => p.path)).toEqual(expect.arrayContaining(['/', '/moon-watching/', '/telescopes/', '/about/', '/members/', '/category/guides/', '/author/ada/']));
    // Never a draft or a database row beyond the public projection; no secrets in the output.
    expect(JSON.stringify(snapshot)).not.toMatch(/password|DATABASE_URL|token_hash/i);
  });

  it('Classic and Astro say the same: canonical, hreflang, JSON-LD, robots, head metadata (task 3.4)', async () => {
    for (const page of snapshot.pages) {
      const res = await classic.app.request(page.path, { headers: { host: SITES.en.host } });
      expect(res.status, page.path).toBe(200);
      const fromClassic = seoOf(await res.text());
      const fromAstro = seoOf(await readFile(pageFile(live, page.path), 'utf8'));
      expect(fromAstro, page.path).toEqual(fromClassic);
      expect(page.xRobotsTag ?? null, page.path).toBe(res.headers.get('x-robots-tag'));
    }
    const moon = seoOf(await readFile(pageFile(live, '/moon-watching/'), 'utf8'));
    expect(moon.hreflang).toEqual([`en https://${SITES.en.host}/moon-watching/`, `x-default https://${SITES.en.host}/moon-watching/`, `zh-CN https://${SITES.zh.host}/moon-watching/`].sort());
    expect(moon.canonical).toEqual([`https://${SITES.en.host}/moon-watching/`]);
    expect(moon.jsonLd).toHaveLength(1);
    expect(seoOf(await readFile(pageFile(live, '/members/'), 'utf8')).robots[0]).toContain('noindex');
  });

  it('Classic and Astro serve the same robots.txt, sitemaps, feeds, llms.txt and Markdown copies (task 3.4)', async () => {
    const paths = snapshot.files.map((f) => f.path);
    expect(paths).toEqual(expect.arrayContaining(['/robots.txt', '/sitemap.xml', '/sitemap.txt', '/llms.txt', '/llms-full.txt', '/feed.xml', '/atom.xml', '/moon-watching.md']));
    expect(paths.some((p) => /^\/sitemap-\d+\.xml$/.test(p))).toBe(true);
    for (const file of snapshot.files) {
      const res = await classic.app.request(file.path, { headers: { host: SITES.en.host } });
      expect(res.status, file.path).toBe(200);
      expect(await readFile(join(live, file.path), 'utf8'), file.path).toBe(await res.text());
      expect(file.headers['x-robots-tag'] ?? null, file.path).toBe(res.headers.get('x-robots-tag'));
    }
  });

  it('a sponsored article: the same disclosure and the same rel attributes (task 3.6)', async () => {
    for (const path of ['/telescopes/', '/']) {
      const fromClassic = await (await classic.app.request(path, { headers: { host: SITES.en.host } })).text();
      const fromAstro = await readFile(pageFile(live, path), 'utf8');
      expect(disclosureOf(fromAstro), path).toEqual(disclosureOf(fromClassic));
      expect(disclosureOf(fromAstro).length, path).toBeGreaterThan(0);
    }
    const c = bodyOf(await (await classic.app.request('/telescopes/', { headers: { host: SITES.en.host } })).text());
    const a = bodyOf(await readFile(pageFile(live, '/telescopes/'), 'utf8'));
    expect(relsOf(a)).toEqual(relsOf(c));
    expect(relsOf(a)).toContain('https://lenses.example.org/rent rel=sponsored');
  });

  it('five publications within a minute are one build that contains all five (task 3.2)', async () => {
    const e = engine();
    const before = await db.select().from(astroBuilds).where(eq(astroBuilds.siteId, SITES.en.id));
    for (let i = 1; i <= 5; i++) {
      await publish(SITES.en.id, 'articles', `2026-09-2${i}T00:00:00Z`, { title: `Night ${i}`, slug: `night-${i}`, locale: 'en', body: `<p>Night ${i}.</p>` });
      expect(await e.request(SITES.en.id)).toBe(true);
      clock += 10_000;
    }
    expect(await e.runDue()).toEqual([]);
    clock += 61_000;
    const reports = await e.runDue();
    expect(reports).toHaveLength(1);
    expect(reports[0]!.status, reports[0]!.error).toBe('succeeded');
    expect(await e.runDue()).toEqual([]);
    const after = await db.select().from(astroBuilds).where(eq(astroBuilds.siteId, SITES.en.id));
    expect(after.length - before.length).toBe(1);
    for (let i = 1; i <= 5; i++) expect((await readFile(pageFile(live, `/night-${i}/`), 'utf8')).includes(`Night ${i}`)).toBe(true);
  });

  it('a failed build keeps the live version and the old generation (task 3.3)', async () => {
    const e = engine({ build: async () => ({ ok: false, stage: 'build', error: 'template error' }) });
    const liveBefore = await liveGeneration(root, SITES.en.id);
    const report = await e.buildNow(SITES.en.id, 'event');
    expect(report.status).toBe('failed');
    expect(await liveGeneration(root, SITES.en.id)).toBe(liveBefore);
    expect(await readFile(pageFile(live, '/moon-watching/'), 'utf8')).toContain('Watching the Moon');
    const [row] = await db.select().from(astroSites).where(eq(astroSites.siteId, SITES.en.id));
    expect(row!.activeGeneration).toBe(liveBefore);
  });

  it('an older build finishing after a newer one went live is not activated (task 3.5)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = engine({ build: async (o: SiteBuildOptions) => (await gate, buildSiteGeneration(o)) });
    const fast = engine();
    const older = slow.buildNow(SITES.en.id, 'event');
    // Let the slow one take its generation first.
    await new Promise((r) => setTimeout(r, 300));
    const newer = await fast.buildNow(SITES.en.id, 'event');
    expect(newer.status, newer.error).toBe('succeeded');
    release();
    const late = await older;
    expect(late.generation).toBeLessThan(newer.generation);
    expect(late.status).toBe('superseded');
    expect(await liveGeneration(root, SITES.en.id)).toBe(newer.generation);
  });

  it('a lost event is repaired by the 5-minute reconciliation (task 3.5)', async () => {
    const e = engine();
    // A publication whose event never reached the consumer.
    await publish(SITES.en.id, 'articles', '2026-09-29T00:00:00Z', { title: 'Lost event', slug: 'lost-event', locale: 'en', body: '<p>Lost.</p>' });
    const hook = astroReconciliation(e);
    expect(hook.name).toBe('astro');
    expect(hook.intervalMs).toBe(300_000);
    const report = await hook.run();
    expect(report.requested).toContain(SITES.en.id);
    clock += 61_000;
    const [built] = await e.runDue();
    expect(built?.status, built?.error).toBe('succeeded');
    expect(await readFile(pageFile(live, '/lost-event/'), 'utf8')).toContain('Lost event');
    expect((await hook.run()).requested).not.toContain(SITES.en.id);
  });

  it('a build stuck past its deadline is failed by reconciliation', async () => {
    const [site] = await db.select().from(astroSites).where(eq(astroSites.siteId, SITES.en.id));
    await db.insert(astroBuilds).values({ siteId: SITES.en.id, generation: site!.generation + 100, theme: 'official:starter', reason: 'event', deadlineAt: new Date(clock - 1000) });
    const report = await engine().reconcile();
    expect(report.stuck).toContain(`${SITES.en.id}#${site!.generation + 100}`);
    const [row] = await db.select().from(astroBuilds).where(and(eq(astroBuilds.siteId, SITES.en.id), eq(astroBuilds.generation, site!.generation + 100)));
    expect(row!.status).toBe('failed');
  });

  it('v1 accepts official and operator themes only', async () => {
    await expect(engine().enable(SITES.en.id, 'https://themes.example.com/x.tgz')).rejects.toThrow(/not an accepted theme/);
  });
});
