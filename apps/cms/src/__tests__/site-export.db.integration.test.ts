import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  agentAutonomyGrants,
  autoPublishSettings,
  collections,
  fields,
  ingestSources,
  items,
  publicHosts,
  roles,
  siteContentSettings,
  siteDomains,
  sites,
  siteThemes,
  storageProfiles,
  themeVersions,
  translationGroupMembers,
  userSites,
  users,
  type Database,
} from '@heopress/database';
import type { KeyProvider } from '@heopress/runtime';
import { LocalFileStorageProvider } from '@heopress/runtime/docker';
import { IngestSourceService } from '../services/ingest/source-service';
import { ItemService } from '../services/item-service';
import { runSiteTransaction, type SiteTransaction } from '../services/rls-transaction';
import { SchemaService } from '../services/schema-service';
import { ContentSettingsService } from '../services/site-network/content-settings-service';
import { TranslationGroupService } from '../services/site-network/translation-group-service';
import { SiteImportService } from '../services/site-import/import-service';
import { exportSite, SiteExportError } from '../services/site-export/export-service';
import { importAsNewSite, SiteImportNewError } from '../services/site-export/import-new-site';
import { provisionSite } from '../services/sites/site-provisioning';
import { StorageProfileService } from '../services/storage/storage-profile-service';
import { ThemeService } from '../services/themes/theme-service';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';

/**
 * Single-site export and "import as new site" (HeoPress P13 tasks 1.2, 1.6; spec ops/backup-restore "单站点导出与导入",
 * "单站导出安全范围"): only a site administrator exports; the bundle holds the site's content, schema, theme and media
 * and nothing of another site; the new site gets new IDs (relations and block IDs remapped), no domain, paused
 * sources, no auto-publishing; and a person's activation makes it whole.
 */

const SRC = 'site_p13_export_src';
const OTHER = 'site_p13_export_other';
const NEW = 'site_p13_export_new';
const SITE_ADMIN = 'usr_p13_export_site_admin';
const OUTSIDER = 'usr_p13_export_outsider';
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
const keys = {} as KeyProvider;

describe.skipIf(!hasDbIntegrationUrl)('single-site export and import as new site — DB integration', () => {
  let db: Database;
  let root = '';
  let bootstrapId = '';
  let createdBootstrap = false;
  let defaultStorage: LocalFileStorageProvider;
  const ids: Record<string, string> = {};

  const itemsOn = (siteId: string) => new ItemService({ db, siteId });
  const create = async (siteId: string, collection: string, data: Record<string, unknown>, status: 'published' | 'draft' = 'published') =>
    ((await itemsOn(siteId).create(collection, { data, status, ...(status === 'published' ? { publishedAt: new Date('2026-09-01T00:00:00Z') } : {}) })) as { id: string }).id;
  async function settings(siteId: string, locales: string[]) {
    const [r] = await db.select().from(siteContentSettings).where(eq(siteContentSettings.siteId, siteId));
    await new ContentSettingsService({ db, siteId, actor: { userId: null } }).update({
      availableLocales: locales,
      timezone: 'Asia/Shanghai',
      siteType: 'blog',
      trailingSlash: 'always',
      localeStrategy: 'subdirectory',
      localePrefixMode: 'default_at_root',
      localePrefixes: {},
      permalinks: r!.permalinks,
      allowCrossSiteTranslations: true,
      sponsorDisclosure: true,
      sponsorRel: true,
      version: r!.version,
    } as never);
  }

  beforeAll(async () => {
    db = await connectDbIntegration('site-export');
    root = await mkdtemp(path.join(tmpdir(), 'hp-site-export-'));
    defaultStorage = new LocalFileStorageProvider(path.join(root, 'default'));
    await db.delete(sites).where(inArray(sites.id, [SRC, OTHER, NEW]));
    await db.delete(users).where(inArray(users.id, [SITE_ADMIN, OUTSIDER]));
    const [boot] = await db.select({ id: users.id }).from(users).where(eq(users.isBootstrap, true)).limit(1);
    if (boot) bootstrapId = boot.id;
    else {
      bootstrapId = 'usr_p13_export_bootstrap';
      await db.insert(users).values({ id: bootstrapId, email: 'bootstrap-p13@example.com', status: 'active', isBootstrap: true });
      createdBootstrap = true;
    }
    await provisionSite(db, { id: SRC, name: 'Export source', defaultLanguage: 'en' }, bootstrapId);
    await provisionSite(db, { id: OTHER, name: 'Other site', defaultLanguage: 'zh-CN' }, bootstrapId);
    await settings(SRC, ['en']);
    await settings(OTHER, ['zh-CN']);
    await db.insert(users).values([
      { id: SITE_ADMIN, email: 'site-admin-p13@example.com', status: 'active' },
      { id: OUTSIDER, email: 'outsider-p13@example.com', status: 'active' },
    ]);
    // The site administrator of SRC; the outsider administers OTHER only.
    for (const [user, site] of [
      [SITE_ADMIN, SRC],
      [OUTSIDER, OTHER],
    ] as const) {
      const [role] = await runSiteTransaction(db, site, (tx) => tx.insert(roles).values({ siteId: site, name: `Admin ${user}`, adminAccess: true, appAccess: true }).returning({ id: roles.id }));
      await runSiteTransaction(db, site, (tx) => tx.insert(userSites).values({ userId: user, siteId: site, roleId: role!.id }));
    }

    // A custom collection beside the preset.
    await runSiteTransaction(db, SRC, async (tx) => {
      const schema = new SchemaService({ db: tx as unknown as Database, siteId: SRC });
      await schema.createCollection({ name: 'products', label: 'Product' });
      await schema.createField('products', { name: 'sku', type: 'string', interface: 'input', label: 'SKU' });
      await schema.createField('products', { name: 'api_token', type: 'string', interface: 'input', label: 'Shop token' });
    });

    // Media on a public local profile: a PNG the body shows, and an SVG an import does not take.
    const profiles = (tx: SiteTransaction) => new StorageProfileService({ db: tx as unknown as Database, siteId: SRC, keys, defaultStorage, storageDir: path.join(root, 'storage') });
    await runSiteTransaction(db, SRC, async (tx) => {
      const p = profiles(tx);
      await p.bind((await p.create({ name: 'local', driver: 'local', publicBaseUrl: 'https://media-src.example.com' })).id);
    });
    for (const [key, bytes, type] of [
      ['photos/a.png', PNG, 'image/png'],
      ['icons/logo.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml'],
    ] as const) {
      const at = await runSiteTransaction(db, SRC, (tx) => profiles(tx).writeLocation(key));
      await at.storage.put(at.objectKey, bytes, { contentType: type });
      await runSiteTransaction(db, SRC, (tx) => profiles(tx).recordWrite(key, at, { contentType: type, size: bytes.length }));
    }

    ids.guides = await create(SRC, 'categories', { name: 'Guides', slug: 'guides' });
    ids.moon = await create(SRC, 'tags', { name: 'Moon', slug: 'moon' });
    ids.ada = await create(SRC, 'authors', { name: 'Ada Example', slug: 'ada' });
    ids.article = await create(SRC, 'articles', {
      title: 'Watching the Moon',
      slug: 'moon-watching',
      locale: 'en',
      body: '<h2>Phases</h2><p>See it.</p><img src="https://media-src.example.com/sites/site_p13_export_src/media/photos/a.png" alt="moon">',
      categories: [ids.guides],
      tags: [ids.moon],
      primary_category: ids.guides,
      author: ids.ada,
    });
    ids.draft = await create(SRC, 'articles', { title: 'Draft notes', slug: 'draft-notes', locale: 'en', body: '<p>Not yet.</p>', author: ids.ada }, 'draft');
    ids.page = await create(SRC, 'pages', { title: 'About', slug: 'about', locale: 'en', body: '<p>About us.</p>' });
    ids.product = await create(SRC, 'products', { sku: 'TEL-1', api_token: 'tok-short' });
    ids.zh = await create(OTHER, 'articles', { title: '赏月', slug: 'moon-watching', locale: 'zh-CN', body: '<p>其他站点的内容。</p>' });
    const groups = new TranslationGroupService({ db, siteId: SRC, actor: undefined, userId: null, itemsOn: (siteId, tx) => new ItemService({ db: tx as never, siteId }) });
    const group = await groups.create(ids.article);
    await groups.addMember(group.id, { siteId: OTHER, itemId: ids.zh, expectedVersion: group.version });

    const themes = new ThemeService({ db, siteId: SRC, actor: { userId: bootstrapId } });
    const version = await themes.installStarter('minimal');
    await themes.activate(version.id);

    const src = new IngestSourceService({ db, siteId: SRC, actor: { userId: bootstrapId, isAdmin: true } });
    await src.create({ name: 'Night sky feed', type: 'rss', url: 'https://feeds.example.com/sky.xml', scheduleTimes: ['08:00', '20:00'], timezone: 'UTC' });
    await runSiteTransaction(db, SRC, (tx) => tx.insert(autoPublishSettings).values({ siteId: SRC, vetoWindowMinutes: 45, dailyLimit: 12, requiredLocales: ['en'] }));
    await runSiteTransaction(db, SRC, (tx) => tx.insert(agentAutonomyGrants).values({ siteId: SRC, agentRole: 'content-pipeline', capability: 'publish', level: 4 }));
    await runSiteTransaction(db, SRC, (tx) => tx.insert(siteDomains).values({ siteId: SRC, hostname: 'src-p13.example.com', kind: 'custom', status: 'active', isPrimary: true, verifiedAt: new Date() }));
  });

  afterAll(async () => {
    await db?.delete(sites).where(inArray(sites.id, [SRC, OTHER, NEW]));
    await db?.delete(users).where(inArray(users.id, [SITE_ADMIN, OUTSIDER]));
    if (createdBootstrap) await db?.delete(users).where(eq(users.id, bootstrapId));
    if (root) await rm(root, { recursive: true, force: true });
  });

  const deps = () => ({ db, keys, defaultStorage, storageDir: path.join(root, 'storage') });
  const bundleDir = () => path.join(root, 'bundle');

  it('spec "站点级导出越权失败": an administrator of another site cannot export this one; nothing is written', async () => {
    const dir = path.join(root, 'forbidden');
    await expect(exportSite(deps(), { siteId: SRC, actor: { userId: OUTSIDER }, dir })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(exportSite(deps(), { siteId: SRC, actor: { userId: null }, dir })).rejects.toBeInstanceOf(SiteExportError);
    expect(await readdir(dir).catch(() => [])).toEqual([]);
  });

  it('the site administrator exports content, schema, theme and media — nothing of another site, no secret, no domain', async () => {
    const report = await exportSite(deps(), { siteId: SRC, actor: { userId: SITE_ADMIN }, dir: bundleDir() });
    expect(report.items).toBe(7);
    expect(report.media).toBe(1);
    expect(report.theme).toBe('minimal');
    expect(report.sources).toBe(1);
    expect(report.otherSiteMembers).toBeGreaterThanOrEqual(1);
    expect(report.dropped.map((d) => d.detail).join('\n')).toMatch(/icons\/logo\.svg/);
    expect(report.dropped.map((d) => d.detail).join('\n')).toMatch(/api_token/);
    const text = await readFile(path.join(bundleDir(), 'bundle.ndjson'), 'utf8');
    expect(text).not.toContain(OTHER);
    expect(text).not.toContain(ids.zh);
    expect(text).not.toContain('其他站点');
    expect(text).not.toContain('tok-short');
    expect(text).not.toContain('src-p13.example.com');
    expect(text).not.toContain('media-src.example.com');
    expect(text).toContain('heopress-media:m-');
    const records = text
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { type: string; members?: string[] });
    expect(records.filter((r) => r.type === 'relation').length).toBeGreaterThanOrEqual(4);
    expect(records.find((r) => r.type === 'translationGroup')?.members).toEqual([ids.article]);
    expect(records.some((r) => r.type === 'theme')).toBe(true);
  });

  it('a new site needs media storage for a bundle with media (checked before anything is created)', async () => {
    await expect(importAsNewSite(deps(), { dir: bundleDir(), siteId: NEW, name: 'Copy', actor: { userId: bootstrapId } })).rejects.toBeInstanceOf(SiteImportNewError);
    await expect(importAsNewSite(deps(), { dir: bundleDir(), siteId: NEW, name: 'Copy', actor: { userId: SITE_ADMIN }, mediaPublicBaseUrl: 'https://media-new.example.com' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await db.select().from(sites).where(eq(sites.id, NEW))).toEqual([]);
  });

  it('spec "导入为新站点": new IDs, relations remapped, no domain, paused sources, no auto-publish; activation makes it whole', async () => {
    const report = await importAsNewSite(deps(), { dir: bundleDir(), siteId: NEW, name: 'Copy', actor: { userId: bootstrapId }, mediaPublicBaseUrl: 'https://media-new.example.com' });
    expect(report.import.summary.failed).toBe(0);
    expect(report.relations.failed).toEqual([]);
    expect(report.schema.collectionsCreated).toEqual(['products']);
    expect(report.theme).toMatchObject({ name: 'minimal', activated: true });

    // No domain, no host, no grant; sources paused with default terms; thresholds copied.
    expect(await db.select().from(siteDomains).where(eq(siteDomains.siteId, NEW))).toEqual([]);
    expect(await db.select().from(publicHosts).where(eq(publicHosts.siteId, NEW))).toEqual([]);
    const [newSite] = await db.select().from(sites).where(eq(sites.id, NEW));
    expect(newSite!.domain).toBeNull();
    const state = await runSiteTransaction(db, NEW, async (tx) => ({
      grants: await tx.select().from(agentAutonomyGrants).where(eq(agentAutonomyGrants.siteId, NEW)),
      sources: await tx.select().from(ingestSources).where(eq(ingestSources.siteId, NEW)),
      auto: await tx.select().from(autoPublishSettings).where(eq(autoPublishSettings.siteId, NEW)),
      profiles: await tx.select().from(storageProfiles).where(eq(storageProfiles.siteId, NEW)),
      settings: await tx.select().from(siteContentSettings).where(eq(siteContentSettings.siteId, NEW)),
      theme: await tx.select({ templates: themeVersions.templates }).from(siteThemes).innerJoin(themeVersions, eq(themeVersions.id, siteThemes.themeVersionId)).where(eq(siteThemes.siteId, NEW)),
      members: await tx.select().from(translationGroupMembers).where(eq(translationGroupMembers.siteId, NEW)),
      productFields: await tx
        .select({ name: fields.name })
        .from(fields)
        .innerJoin(collections, eq(collections.id, fields.collectionId))
        .where(and(eq(fields.siteId, NEW), eq(collections.name, 'products'))),
    }));
    expect(state.grants).toEqual([]);
    expect(state.sources).toHaveLength(1);
    expect(state.sources[0]).toMatchObject({ status: 'paused', licenceStatus: 'unknown', trustLevel: 'low', scheduleTimes: ['08:00', '20:00'] });
    expect(state.auto[0]).toMatchObject({ vetoWindowMinutes: 45, dailyLimit: 12, requiredLocales: ['en'] });
    expect(state.profiles.map((p) => [p.driver, p.publicBaseUrl, p.secretCiphertext])).toEqual([['local', 'https://media-new.example.com', null]]);
    expect(state.settings[0]!.timezone).toBe('Asia/Shanghai');
    expect(state.settings[0]!.allowCrossSiteTranslations).toBe(false);
    expect(state.productFields.map((f) => f.name).sort()).toEqual(['api_token', 'sku']);
    const [srcTheme] = await runSiteTransaction(db, SRC, (tx) => tx.select({ templates: themeVersions.templates }).from(siteThemes).innerJoin(themeVersions, eq(themeVersions.id, siteThemes.themeVersionId)).where(eq(siteThemes.siteId, SRC)));
    expect(state.theme[0]!.templates).toEqual(srcTheme!.templates);
    // The cross-site member stayed where it was: the new group has the new article only.
    expect(state.members).toHaveLength(1);

    // Content: everything, as drafts, under new IDs, relations pointing at the new site's items.
    const rows = await runSiteTransaction(db, NEW, (tx) =>
      tx.select({ id: items.id, status: items.status, data: items.data, collection: collections.name }).from(items).innerJoin(collections, eq(collections.id, items.collectionId)).where(and(eq(items.siteId, NEW), isNull(items.deletedAt))),
    );
    expect(rows).toHaveLength(7);
    expect(rows.every((r) => r.status === 'draft')).toBe(true);
    for (const old of Object.values(ids)) expect(rows.map((r) => r.id)).not.toContain(old);
    const byData = (coll: string, slug: string) => rows.find((r) => r.collection === coll && (r.data as { slug?: string }).slug === slug)!;
    const article = byData('articles', 'moon-watching').data as Record<string, unknown>;
    expect(article.categories).toEqual([byData('categories', 'guides').id]);
    expect(article.tags).toEqual([byData('tags', 'moon').id]);
    expect(article.primary_category).toBe(byData('categories', 'guides').id);
    expect(article.author).toBe(byData('authors', 'ada').id);
    expect(String(article.body)).toMatch(/https:\/\/media-new\.example\.com\/sites\/site_p13_export_new\/media\/import\/[0-9a-f]{64}\.png/);
    expect(String(article.body)).not.toContain(SRC);
    const product = rows.find((r) => r.collection === 'products')!.data as Record<string, unknown>;
    expect(product.sku).toBe('TEL-1');
    expect(product.api_token ?? null).toBeNull();
    // Block IDs are the new site's own.
    const [srcArticle] = await runSiteTransaction(db, SRC, (tx) => tx.select({ data: items.data }).from(items).where(and(eq(items.siteId, SRC), eq(items.id, ids.article!))));
    const blockIds = (html: string) => [...html.matchAll(/data-block-id="([^"]+)"/g)].map((m) => m[1]);
    const before = blockIds(String((srcArticle!.data as Record<string, unknown>).body));
    const after = blockIds(String(article.body));
    expect(after.length).toBeGreaterThan(0);
    for (const b of before) expect(after).not.toContain(b);

    // A person activates the batch: what the old site had published is published, relations intact.
    const publisher = (tx: SiteTransaction) =>
      new ItemService({
        db: tx as unknown as Database,
        rootDb: db,
        siteId: NEW,
        userId: bootstrapId,
        cdcActor: { type: 'user', id: bootstrapId },
        localeSetWrite: true,
        permissionCtx: { userId: bootstrapId, siteId: NEW, roleId: null, user: { id: bootstrapId, email: null, roles: [] }, ip: null, headers: {}, apiKey: null, principal: 'user' },
      });
    const activation = await new SiteImportService({ db, siteId: NEW, actor: { userId: bootstrapId } }).activate(report.batchId, publisher);
    expect(activation.blocked).toEqual([]);
    expect(activation.activated).toBe(true);
    const published = await runSiteTransaction(db, NEW, (tx) => tx.select({ id: items.id }).from(items).where(and(eq(items.siteId, NEW), eq(items.status, 'published'))));
    expect(published).toHaveLength(6);
    const sources = new IngestSourceService({ db, siteId: NEW, actor: { userId: bootstrapId, isAdmin: true } });
    expect((await sources.resume(state.sources[0]!.id)).status).toBe('active');
  });
});
