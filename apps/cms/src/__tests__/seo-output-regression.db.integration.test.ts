import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { ensureRenderRole, schema, siteContentSettings, siteDomains, sites, type Database } from '@heopress/database';
import { createSiteClassic, type SiteClassic } from '@heopress/site-classic';
import { ItemService } from '../services/item-service';
import { ContentSettingsService } from '../services/site-network/content-settings-service';
import { SeoSettingsService } from '../services/site-network/seo-settings-service';
import { SiteIdentityService } from '../services/site-network/site-identity-service';
import { TranslationGroupService } from '../services/site-network/translation-group-service';
import { upgradeSitePreset } from '../services/site-network/preset-installer';
import { rebuildSiteProjection } from '../services/site-network/public-projection';
import { connectDbIntegration, dbIntegrationUrl, hasDbIntegrationUrl } from './helpers/db-harness';

/**
 * The SEO output regression snapshot (HeoPress P07 task 9.2; specs seo/page-metadata, seo/crawl-discovery,
 * geo/machine-readable-content): three sites built through the CMS services — an English site and a Chinese site
 * whose articles are one cross-site translation group (both sites allow cross-site translations), and a third,
 * unrelated shop site with its own SEO settings — served by `site-classic` connected as the rendering role. Every
 * SEO output a crawler or an AI system reads is requested and recorded in one file snapshot per site
 * (`__snapshots__/seo-output-regression/*.txt`): the heads of the home, an article (with its hreflang alternates and
 * x-default), a page, the taxonomy and author pages, a noindex page; `robots.txt`, the sitemap index, its shard,
 * `sitemap.txt`, the news sitemap, RSS and Atom, `llms.txt`, `llms-full.txt`, a Markdown copy; their status,
 * content type, `X-Robots-Tag` and `Link` headers.
 *
 * Deterministic by construction: fixed site ids and hosts, every publication time given (`publishedAt`, so the real
 * content time — task 2.5 — is the same), the rendering service's clock fixed (the news sitemap's 48-hour window).
 * What still varies between runs is normalised before the comparison: generated item ids become their labels, an
 * ETag is recorded as present only (its value carries the render version, a sequence).
 *
 * A change to any SEO output fails here: review the diff and, when intended, update the snapshot
 * (`vitest --run -u` against an isolated database).
 *
 * Needs DATABASE_OWNER_URL (to provision this suite's own rendering role, as a deployment does).
 */

const RENDER_ROLE = 'heopress_render_seo_regression';
const OWNER_URL = process.env.DATABASE_OWNER_URL?.trim() || undefined;
/** The rendering service's clock: the news sitemap's window ends here. */
const NOW = Date.parse('2026-10-01T12:00:00Z');
const at = (iso: string) => new Date(iso);

const SITES = {
  en: { id: 'site_p07_seo_reg_en', host: 'heron-notes.example.com', name: 'Heron Notes', language: 'en' },
  zh: { id: 'site_p07_seo_reg_zh', host: 'heron-notes.example.cn', name: '鹭鸟笔记', language: 'zh-CN' },
  shop: { id: 'site_p07_seo_reg_shop', host: 'garden-shop.example.com', name: 'Example Garden Shop', language: 'en' },
} as const;
type SiteKey = keyof typeof SITES;
const SITE_IDS = Object.values(SITES).map((s) => s.id);
const PERMALINKS = { articles: '/:slug', pages: '/:slug', categories: '/category/:slug', tags: '/tag/:slug', authors: '/author/:slug' };
/** A fixed IndexNow key (not a credential: the key file is public by design), built so it does not read as a literal secret. */
const INDEXNOW_FIXED_ID = '0123456789abcdef'.repeat(2);

/** The paths requested on each site, in this order (one snapshot section each). */
const REQUESTS: Record<SiteKey, string[]> = {
  en: [
    '/',
    '/heron-watching/',
    '/wetland-checklist/',
    '/about/',
    '/category/field-guides/',
    '/tag/wetlands/',
    '/author/ada/',
    '/members-notes/',
    '/search/?q=heron',
    '/robots.txt',
    '/sitemap.xml',
    '/sitemap-1.xml',
    '/sitemap.txt',
    '/news-sitemap.xml',
    '/feed.xml',
    '/atom.xml',
    '/feed/pages.xml',
    '/llms.txt',
    '/llms-full.txt',
    '/heron-watching.md',
    '/members-notes.md',
    '/unpublished-draft/',
  ],
  zh: [
    '/',
    '/heron-watching/',
    '/category/guides/',
    '/author/li-ming/',
    '/private-zh/',
    '/robots.txt',
    '/sitemap.xml',
    '/sitemap-1.xml',
    '/sitemap.txt',
    '/news-sitemap.xml',
    '/feed.xml',
    '/atom.xml',
    '/llms.txt',
    '/llms-full.txt',
    '/heron-watching.md',
  ],
  shop: [
    '/',
    '/spring-planting/',
    '/contact/',
    '/tag/seeds/',
    '/clearance-internal/',
    '/robots.txt',
    '/sitemap.xml',
    '/sitemap-1.xml',
    '/sitemap.txt',
    '/news-sitemap.xml',
    '/feed.xml',
    '/atom.xml',
    '/llms.txt',
    '/llms-full.txt',
    '/spring-planting.md',
    `/${INDEXNOW_FIXED_ID}.txt`,
  ],
};

/** The response headers a crawler acts on (the cache's own, `x-cache` and the ETag value, vary from run to run). */
const HEADERS = ['content-type', 'x-robots-tag', 'link', 'location', 'cache-control', 'vary'] as const;

describe.skipIf(!hasDbIntegrationUrl)('SEO output regression snapshot, three sites — DB integration (P07 task 9.2)', () => {
  let db: Database;
  let owner: postgres.Sql;
  let renderClient: postgres.Sql;
  let service: SiteClassic;
  /** Generated ids → their labels (normalisation). */
  const labels = new Map<string, string>();

  beforeAll(async () => {
    expect(OWNER_URL, 'DATABASE_OWNER_URL is required to provision the rendering role').toBeDefined();
    db = await connectDbIntegration('seo-output-regression');
    owner = postgres(OWNER_URL!, { max: 1, onnotice: () => {} });
    const password = randomBytes(18).toString('hex');
    await owner.begin((tx) => ensureRenderRole(tx, { role: RENDER_ROLE, password }));
    const url = new URL(dbIntegrationUrl!);
    url.username = RENDER_ROLE;
    url.password = password;
    renderClient = postgres(url.toString(), { max: 2, onnotice: () => {} });
    // A fixed clock, no AI traffic writes, no background sweep: the answers depend on the content only.
    service = createSiteClassic({ db: drizzle(renderClient, { schema }) as unknown as Database, now: () => NOW, traffic: false, sweepIntervalMs: 0 });
    await buildSites();
  }, 120_000);
  afterAll(async () => {
    await db?.delete(sites).where(inArray(sites.id, SITE_IDS));
    await service?.close();
    await renderClient?.end({ timeout: 2 });
    await owner?.end({ timeout: 2 });
  });

  const items = (site: SiteKey) => new ItemService({ db, siteId: SITES[site].id });
  const seo = (site: SiteKey) => new SeoSettingsService({ db, siteId: SITES[site].id, actor: { userId: null } });
  const identity = (site: SiteKey) => new SiteIdentityService({ db, siteId: SITES[site].id, actor: { userId: null } });
  const groups = (site: SiteKey) =>
    new TranslationGroupService({ db, siteId: SITES[site].id, actor: undefined, userId: null, itemsOn: (siteId, tx) => new ItemService({ db: tx as never, siteId }) });

  /** One item, published at a given time (its first publication: the content time is the same, task 2.5). */
  async function publish(site: SiteKey, collection: string, label: string, publishedAt: string, data: Record<string, unknown>, status = 'published') {
    const created = (await items(site).create(collection, { data, status, publishedAt: at(publishedAt) })) as { id: string };
    labels.set(created.id, `<${site}:${label}>`);
    return created.id;
  }

  async function contentSettings(site: SiteKey, over: Record<string, unknown>) {
    const siteId = SITES[site].id;
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
      allowCrossSiteTranslations: false,
      sponsorDisclosure: true,
      sponsorRel: true,
      version: r!.version,
      ...over,
    } as never);
  }

  async function buildSites() {
    await db.delete(sites).where(inArray(sites.id, SITE_IDS));
    await db.insert(sites).values([
      { id: SITES.en.id, name: SITES.en.name, defaultLanguage: 'en', descriptor: 'Notes on herons and the wetlands they live in.' },
      { id: SITES.zh.id, name: SITES.zh.name, defaultLanguage: 'zh-CN', descriptor: '关于鹭鸟与湿地的观察笔记。' },
      { id: SITES.shop.id, name: SITES.shop.name, defaultLanguage: 'en' },
    ]);
    for (const id of SITE_IDS) await upgradeSitePreset(db, id);
    await db.insert(siteDomains).values(
      (Object.keys(SITES) as SiteKey[]).map((k) => ({ siteId: SITES[k].id, hostname: SITES[k].host, kind: 'custom', status: 'active', isPrimary: true, verifiedAt: at('2026-09-01T00:00:00Z') })),
    );
    // The English and the Chinese site translate each other (both sides allow it); the shop translates nothing.
    await contentSettings('en', { availableLocales: ['en'], allowCrossSiteTranslations: true });
    await contentSettings('zh', { availableLocales: ['zh-CN'], timezone: 'Asia/Shanghai', allowCrossSiteTranslations: true });
    await contentSettings('shop', { availableLocales: ['en'], siteType: 'catalog' });
    // The domains above were written past the services: rebuild, as a deployment does first.
    for (const id of SITE_IDS) await rebuildSiteProjection(db, id);

    // Site identities (task 2.12): an organisation, a person, a local business.
    await identity('en').update({
      version: 0,
      kind: 'organization',
      name: 'Heron Notes Collective',
      logo: 'https://heron-notes.example.com/media/logo.png',
      email: 'editors@example.com',
      sameAs: ['https://social.example.com/heron-notes', 'https://video.example.com/heron-notes'],
    });
    await identity('zh').update({ version: 0, kind: 'person', name: '李明', sameAs: ['https://social.example.cn/liming'] });
    await identity('shop').update({
      version: 0,
      kind: 'local_business',
      name: 'Example Garden Shop',
      telephone: '+1 555 0100',
      address: { streetAddress: '1 Example Road', addressLocality: 'Springfield', addressRegion: 'EX', postalCode: '00001', addressCountry: 'US' },
    });

    // SEO settings: the English site keeps training crawlers out and has a news sitemap; the Chinese site limits
    // snippets; the shop has its own title template, no Markdown copies, tag pages not indexed, IndexNow on and
    // Content-Signal lines.
    await seo('en').update({ version: 0, crawlers: { purposes: { training: 'disallow' } }, discovery: { newsSitemap: true, newsPublicationName: 'Heron Notes' } });
    await seo('zh').update({ version: 0, snippet: { maxSnippet: 160, maxImagePreview: 'large' } });
    await seo('shop').update({
      version: 0,
      titleTemplate: '{title} — {site}',
      index: { pageTypes: { taxonomy: false } },
      crawlers: { purposes: { training: 'disallow', search: 'allow' }, overrides: { bytespider: 'disallow' }, contentSignal: true },
      discovery: { markdownCopies: false, indexNow: true, indexNowKey: INDEXNOW_FIXED_ID },
    });

    // The English site: a category, a tag, an author; two articles (one in the news window), a page, a noindex page, a draft.
    const fieldGuides = await publish('en', 'categories', 'field-guides', '2026-09-01T00:00:00Z', { name: 'Field guides', slug: 'field-guides', description: 'Guides for the field.' });
    const wetlands = await publish('en', 'tags', 'wetlands', '2026-09-01T00:00:00Z', { name: 'Wetlands', slug: 'wetlands' });
    const ada = await publish('en', 'authors', 'ada', '2026-09-01T00:00:00Z', { name: 'Ada Example', slug: 'ada', bio: 'Birder and editor.' });
    const enArticle = await publish('en', 'articles', 'heron-watching', '2026-10-01T06:00:00Z', {
      title: 'Watching herons at dawn',
      slug: 'heron-watching',
      locale: 'en',
      excerpt: 'Where and when to see herons feeding.',
      seo_description: 'A field guide to watching grey herons at dawn.',
      seo_image: 'https://heron-notes.example.com/media/heron.jpg',
      body:
        '<h2>Before sunrise</h2><p>Herons feed in the shallows. See also the <a href="/wetland-checklist/">wetland checklist</a>.</p>' +
        '<p><img src="https://heron-notes.example.com/media/heron-dawn.jpg" alt="A grey heron at dawn"></p>',
      faq: [{ question: 'When do herons feed?', answer: 'Mostly at dawn and dusk.' }],
      categories: [fieldGuides],
      primary_category: fieldGuides,
      tags: [wetlands],
      author: ada,
    });
    await publish('en', 'articles', 'wetland-checklist', '2026-09-15T09:00:00Z', {
      title: 'Wetland birding checklist',
      slug: 'wetland-checklist',
      locale: 'en',
      excerpt: 'What to pack for a morning in the marsh.',
      body: '<p>Binoculars, boots and patience.</p>',
      categories: [fieldGuides],
      tags: [wetlands],
      author: ada,
    });
    await publish('en', 'pages', 'about', '2026-09-01T00:00:00Z', { title: 'About Heron Notes', slug: 'about', locale: 'en', excerpt: 'Who writes these notes.', body: '<p>We are birders.</p>' });
    await publish('en', 'pages', 'members-notes', '2026-09-02T00:00:00Z', {
      title: 'Members notes',
      slug: 'members-notes',
      locale: 'en',
      seo_robots: 'noindex,follow',
      body: '<p>NOINDEX-MEMBERS-BODY</p>',
    });
    await publish('en', 'articles', 'unpublished-draft', '2026-09-03T00:00:00Z', { title: 'Unpublished draft', slug: 'unpublished-draft', locale: 'en', body: '<p>DRAFT-BODY</p>' }, 'draft');

    // The Chinese site: the English article's translation (same slug, another host), a category, an author, a noindex article.
    const guides = await publish('zh', 'categories', 'guides', '2026-09-01T00:00:00Z', { name: '观鸟指南', slug: 'guides' });
    const liMing = await publish('zh', 'authors', 'li-ming', '2026-09-01T00:00:00Z', { name: '李明', slug: 'li-ming' });
    const zhArticle = await publish('zh', 'articles', 'heron-watching', '2026-10-01T08:00:00Z', {
      title: '黎明观鹭',
      slug: 'heron-watching',
      locale: 'zh-CN',
      excerpt: '何时何地观察鹭鸟觅食。',
      body: '<h2>日出之前</h2><p>鹭鸟在浅水中觅食。</p>',
      categories: [guides],
      primary_category: guides,
      author: liMing,
    });
    await publish('zh', 'articles', 'private-zh', '2026-09-20T00:00:00Z', { title: '内部笔记', slug: 'private-zh', locale: 'zh-CN', seo_robots: 'noindex,follow', body: '<p>NOINDEX-ZH-BODY</p>' });

    // One translation group across the two sites (task 2.2), the English article its x-default.
    const group = await groups('en').create(enArticle);
    const joined = await groups('en').addMember(group.id, { siteId: SITES.zh.id, itemId: zhArticle, expectedVersion: group.version });
    await groups('en').setXDefault(group.id, enArticle, joined.version);
    labels.set(group.id, '<group:heron-watching>');

    // The shop: an article, a page, a tag (not indexed by its page type), a noindex article.
    const seeds = await publish('shop', 'tags', 'seeds', '2026-09-01T00:00:00Z', { name: 'Seeds', slug: 'seeds' });
    await publish('shop', 'articles', 'spring-planting', '2026-09-10T10:00:00Z', {
      title: 'Spring planting guide',
      slug: 'spring-planting',
      locale: 'en',
      excerpt: 'What to sow in spring.',
      body: '<p>Sow peas early.</p>',
      tags: [seeds],
    });
    await publish('shop', 'pages', 'contact', '2026-09-01T00:00:00Z', { title: 'Contact', slug: 'contact', locale: 'en', body: '<p>Call us.</p>' });
    await publish('shop', 'articles', 'clearance-internal', '2026-09-11T00:00:00Z', {
      title: 'Clearance (internal)',
      slug: 'clearance-internal',
      locale: 'en',
      seo_robots: 'noindex,nofollow',
      body: '<p>NOINDEX-SHOP-BODY</p>',
    });
  }

  /**
   * Generated ids → labels: item and group ids by what they are, the editor's block ids (`data-block-id`, stamped on
   * each rich-text block when it is saved, kept in the feeds' full text) numbered in order of first appearance.
   * Anything else stays as served.
   */
  const normalise = (text: string) => {
    let out = text;
    for (const [id, label] of labels) out = out.split(id).join(label);
    const blocks = new Map<string, string>();
    return out.replace(/(data-block-id=(?:&quot;|"))([A-Za-z0-9_-]+)/g, (_m, attr: string, id: string) => {
      if (!blocks.has(id)) blocks.set(id, `<block:${blocks.size + 1}>`);
      return `${attr}${blocks.get(id)!}`;
    });
  };

  /** A head, one tag a line, its JSON-LD graph pretty-printed. */
  function headOf(html: string): string {
    const head = /<head>([\s\S]*?)<\/head>/.exec(html)?.[1];
    if (head === undefined) return '(no head)';
    const graphs: string[] = [];
    const tags = head
      .replace(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g, (_m, json: string) => {
        graphs.push(JSON.stringify(JSON.parse(json), null, 2));
        return `<script type="application/ld+json">#${graphs.length}</script>`;
      })
      .replace(/>\s*</g, '>\n<')
      .trim();
    return [tags, ...graphs.map((g, i) => `--- JSON-LD #${i + 1}\n${g}`)].join('\n');
  }

  async function snapshotOf(site: SiteKey): Promise<string> {
    const { host } = SITES[site];
    const sections: string[] = [`# ${host} (${SITES[site].id})`];
    for (const path of REQUESTS[site]) {
      const res = await service.app.request(path, { headers: { host } });
      const lines = [`## GET https://${host}${path}`, `status: ${res.status}`];
      for (const name of HEADERS) {
        const value = res.headers.get(name);
        if (value !== null) lines.push(`${name}: ${value}`);
      }
      // The value carries the render version (a sequence): recorded as present only.
      if (res.headers.get('etag') !== null) lines.push('etag: <present>');
      // An HTML answer (a page, or a 404 for a path that is not one): its head is what a crawler reads.
      const body = await res.text();
      lines.push('', res.headers.get('content-type')?.startsWith('text/html') ? headOf(body) : body.replace(/\s+$/, ''));
      sections.push(lines.join('\n'));
    }
    return `${normalise(sections.join('\n\n'))}\n`;
  }

  it.each(Object.keys(SITES) as SiteKey[])('the SEO outputs of the %s site match the recorded snapshot', async (site) => {
    await expect(await snapshotOf(site)).toMatchFileSnapshot(`./__snapshots__/seo-output-regression/${SITES[site].host}.txt`);
  });

  it('the snapshot is stable: a second request of every output answers the same (warm caches included)', async () => {
    for (const site of Object.keys(SITES) as SiteKey[]) expect(await snapshotOf(site), site).toBe(await snapshotOf(site));
  });
});
