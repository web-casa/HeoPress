import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  collections,
  importBatchItems,
  importBatches,
  items,
  publicItems,
  redirects,
  roles,
  siteContentSettings,
  sites,
  userSites,
  users,
  type Database,
} from '@heopress/database';
import { ItemService } from '../services/item-service';
import type { SiteTransaction } from '../services/rls-transaction';
import { ContentSettingsService } from '../services/site-network/content-settings-service';
import { upgradeSitePreset } from '../services/site-network/preset-installer';
import { TranslationGroupService } from '../services/site-network/translation-group-service';
import { convertAstroSite, writeBundle } from '../services/site-import/astro/convert';
import { assembleBundle, loadBundle, parseBundleRecords, type LoadedBundle } from '../services/site-import/bundle-reader';
import { SiteImportService, type ImportMediaStore } from '../services/site-import/import-service';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';

/**
 * Site import (HeoPress P12 tasks 6.2–6.4; spec migration/import-bundle): dry run writes nothing, importing twice adds
 * nothing and updates only what changed, nothing is public before activation, and activation re-checks safety, Hold,
 * internal-only, the activating person's permission and that nothing changed since the import — all or nothing.
 */

const SITE = 'site_p12_import_it';
const ADMIN = 'usr_p12_import_admin';

const header = { type: 'header', format: 'heopress-import', version: 1, source: 'astro', sourceSite: 'blog-example' };
const site = { type: 'site', settings: { defaultLocale: 'en', locales: ['en', 'zh-CN'], trailingSlash: 'always', permalinks: { articles: '/blog/:slug' } } };
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const PNG_SHA = sha(PNG);

function article(id: string, over: Record<string, unknown> = {}, data: Record<string, unknown> = {}) {
  return {
    type: 'item',
    externalId: id,
    collection: 'articles',
    locale: 'en',
    status: 'published',
    publishedAt: '2021-03-04T10:00:00Z',
    legacyPath: `/blog/${id}/`,
    data: { title: `Post ${id}`, slug: id, excerpt: `About ${id}`, body: `<p>Hello ${id}</p>`, ...data },
    ...over,
  };
}

function bundleOf(records: unknown[]): LoadedBundle {
  const text = records.map((r) => JSON.stringify(r)).join('\n');
  const { records: parsed, problems } = parseBundleRecords(text);
  expect(problems).toEqual([]);
  return assembleBundle(parsed, sha(text), async () => PNG);
}

describe.skipIf(!hasDbIntegrationUrl)('site import — DB integration', () => {
  let db: Database;
  const stored: string[] = [];
  const media: ImportMediaStore = {
    put: async ({ key }) => {
      stored.push(key);
      return { url: `https://media.example.com/${key}` };
    },
  };

  beforeAll(async () => {
    db = await connectDbIntegration('site-import');
  });
  beforeEach(async () => {
    stored.length = 0;
    await db.execute(sql`DELETE FROM lumibase_cache_entries WHERE key LIKE ${`%${SITE}%`}`);
    await db.delete(sites).where(eq(sites.id, SITE));
    await db.delete(users).where(eq(users.id, ADMIN));
    await db.insert(sites).values({ id: SITE, name: 'Import', defaultLanguage: 'en' });
    await upgradeSitePreset(db, SITE);
    const [r] = await db.select().from(siteContentSettings).where(eq(siteContentSettings.siteId, SITE));
    await new ContentSettingsService({ db, siteId: SITE, actor: { userId: null } }).update({
      availableLocales: ['en', 'zh-CN', 'id'],
      timezone: r!.timezone,
      siteType: 'blog',
      trailingSlash: 'always',
      localeStrategy: 'subdirectory',
      localePrefixMode: 'default_at_root',
      localePrefixes: { 'zh-CN': 'zh' },
      permalinks: { ...r!.permalinks, articles: '/blog/:slug', pages: '/docs/:slug' },
      allowCrossSiteTranslations: false,
      sponsorDisclosure: r!.sponsorDisclosure,
      sponsorRel: r!.sponsorRel,
      version: r!.version,
    } as never);
    await db.insert(users).values({ id: ADMIN, email: 'import-admin@example.com', status: 'active' });
    const [role] = await db.insert(roles).values({ siteId: SITE, name: 'Administrator', adminAccess: true, appAccess: true }).returning({ id: roles.id });
    await db.insert(userSites).values({ userId: ADMIN, siteId: SITE, roleId: role!.id });
  });
  afterAll(async () => {
    await db?.delete(sites).where(eq(sites.id, SITE));
    await db?.delete(users).where(eq(users.id, ADMIN));
  });

  const service = () => new SiteImportService({ db, siteId: SITE, actor: { userId: ADMIN, email: 'import-admin@example.com' }, media });
  const publisher = (userId = ADMIN) => (tx: SiteTransaction) =>
    new ItemService({
      db: tx as unknown as Database,
      rootDb: db,
      siteId: SITE,
      userId,
      cdcActor: { type: 'user', id: userId },
      localeSetWrite: true,
      permissionCtx: { userId, siteId: SITE, roleId: null, user: { id: userId, email: null, roles: [] }, ip: null, headers: {}, apiKey: null, principal: 'user' },
    });
  const importBundle = async (b: LoadedBundle) => {
    const dry = await service().dryRun(b);
    const done = await service().import(dry.batchId, b, dry.reportHash);
    return { ...dry, done };
  };
  const liveItems = async () => db.select({ id: items.id, status: items.status, data: items.data, version: items.version }).from(items).where(and(eq(items.siteId, SITE), isNull(items.deletedAt)));
  const articlesCount = async () => {
    const [coll] = await db.select({ id: collections.id }).from(collections).where(and(eq(collections.siteId, SITE), eq(collections.name, 'articles')));
    return (await db.select({ id: items.id }).from(items).where(and(eq(items.siteId, SITE), eq(items.collectionId, coll!.id)))).length;
  };
  const publicCount = async () => (await db.select({ id: publicItems.itemId }).from(publicItems).where(eq(publicItems.siteId, SITE))).length;

  const BASE = () => [
    header,
    site,
    { type: 'collection', source: 'blog', collection: 'articles' },
    { type: 'media', id: 'img-1', path: 'blog/one.png', size: PNG.length, sha256: PNG_SHA, mimeType: 'image/png' },
    article('one', { translationKey: 'one' }, { body: '<p>One</p><img src="heopress-media:img-1" alt="x">' }),
    article('one-zh', { locale: 'zh-CN', translationKey: 'one', legacyPath: '/zh/blog/one-zh/' }),
    article('two', { legacyPath: '/2021/two/' }),
    article('draft', { status: 'draft' }),
    { type: 'redirect', from: '/old-two/', to: '/blog/two/' },
    { type: 'licence', subject: 'two', licence: 'own', attribution: 'Example Team' },
  ];

  it('the dry run writes nothing and reports creates, path changes and the batch', async () => {
    const dry = await service().dryRun(bundleOf(BASE()));
    expect(await articlesCount()).toBe(0);
    expect(stored).toEqual([]);
    expect(dry.report.summary).toMatchObject({ create: 4, update: 0, unchanged: 0, failed: 0, media: 1, groups: 1, batch: 3 });
    expect(dry.report.pathChanges).toEqual([{ externalId: 'two', from: '/2021/two/', to: '/blog/two/' }]);
    const [batch] = await db.select().from(importBatches).where(eq(importBatches.id, dry.batchId));
    expect(batch!.status).toBe('planned');
  });

  it('spec "重复导入": importing the same bundle twice adds nothing; a changed record updates only that item', async () => {
    await importBundle(bundleOf(BASE()));
    expect(await articlesCount()).toBe(4);
    expect(stored).toHaveLength(1);
    const before = new Map((await liveItems()).map((i) => [i.id, i.version]));
    // Everything is a draft: nothing public before activation.
    expect((await liveItems()).every((i) => i.status === 'draft')).toBe(true);
    expect(await publicCount()).toBe(0);
    const img = (await liveItems()).find((i) => (i.data as { slug?: string }).slug === 'one')!;
    expect((img.data as { body: string }).body).toContain('https://media.example.com/import/');

    const again = await importBundle(bundleOf(BASE()));
    expect(again.report.summary).toMatchObject({ create: 0, update: 0, unchanged: 4, media: 0 });
    expect(await articlesCount()).toBe(4);
    expect(new Map((await liveItems()).map((i) => [i.id, i.version]))).toEqual(before);

    const changed = BASE().map((r) => ((r as { externalId?: string }).externalId === 'two' ? article('two', { legacyPath: '/2021/two/' }, { title: 'Post two, revised' }) : r));
    const third = await importBundle(bundleOf(changed));
    expect(third.report.summary).toMatchObject({ create: 0, update: 1, unchanged: 3 });
    const after = await liveItems();
    expect(await articlesCount()).toBe(4);
    for (const i of after) {
      const slug = (i.data as { slug: string }).slug;
      expect(i.version, slug).toBe(slug === 'two' ? before.get(i.id)! + 1 : before.get(i.id));
    }
  });

  it('spec "导入批次激活": activation publishes the batch together, writes redirects and keeps the historical import marking', async () => {
    const { batchId } = await importBundle(bundleOf(BASE()));
    const result = await service().activate(batchId, publisher());
    expect(result.blocked).toEqual([]);
    expect(result.activated).toBe(true);
    const live = await liveItems();
    expect(live.filter((i) => i.status === 'published').map((i) => (i.data as { slug: string }).slug).sort()).toEqual(['one', 'one-zh', 'two']);
    expect(live.find((i) => (i.data as { slug: string }).slug === 'draft')!.status).toBe('draft');
    expect(await publicCount()).toBe(3);
    const rules = await db.select({ from: redirects.fromPath, to: redirects.toPath, source: redirects.source }).from(redirects).where(eq(redirects.siteId, SITE));
    expect(rules.map((r) => r.from).sort()).toEqual(['/2021/two', '/old-two']);
    const two = live.find((i) => (i.data as { slug: string }).slug === 'two')!;
    expect((two.data as { source_license?: string }).source_license).toBe('own');
    expect(await service().historicalImport(two.id)).toMatchObject({ batchId, externalId: 'two' });
  });

  it('spec "安全检查失败": an item whose body had a script blocks the batch; nothing goes public', async () => {
    const records = BASE().map((r) => ((r as { externalId?: string }).externalId === 'two' ? article('two', {}, { body: '<p>x</p><script>alert(1)</script><a href="javascript:alert(1)">y</a>' }) : r));
    const { batchId, report } = await importBundle(bundleOf(records));
    expect(report.safety).toEqual([{ externalId: 'two', issues: ['script element', 'script or data URL'] }]);
    const two = (await liveItems()).find((i) => (i.data as { slug: string }).slug === 'two')!;
    expect((two.data as { body: string }).body).not.toMatch(/script|javascript/);
    const result = await service().activate(batchId, publisher());
    expect(result.activated).toBe(false);
    expect(result.blocked).toEqual([expect.objectContaining({ externalId: 'two', code: 'SAFETY_CHECK_FAILED' })]);
    expect((await liveItems()).every((i) => i.status === 'draft')).toBe(true);
    expect(await publicCount()).toBe(0);
    const [batch] = await db.select().from(importBatches).where(eq(importBatches.id, batchId));
    expect(batch!.status).toBe('imported');
    expect(batch!.activationReport).toMatchObject({ activated: false });
  });

  it('spec "预演后内容被修改": an item edited after the import blocks activation until it is dry-run again', async () => {
    const { batchId } = await importBundle(bundleOf(BASE()));
    const one = (await liveItems()).find((i) => (i.data as { slug: string }).slug === 'one')!;
    await new ItemService({ db, siteId: SITE, userId: ADMIN }).patch('articles', one.id, { data: { title: 'Edited' }, expectedVersion: one.version });
    const result = await service().activate(batchId, publisher());
    expect(result.blocked).toEqual([expect.objectContaining({ externalId: 'one', code: 'CHANGED_SINCE_DRY_RUN' })]);
    expect(await publicCount()).toBe(0);
    // A new dry run and import keep the edit (the record did not change) and pin it; then the batch activates.
    const again = await importBundle(bundleOf(BASE()));
    expect(again.report.items.find((i) => i.externalId === 'one')).toMatchObject({ action: 'unchanged' });
    const [old] = await db.select().from(importBatches).where(eq(importBatches.id, batchId));
    expect(old!.status).toBe('superseded');
    expect((await service().activate(again.batchId, publisher())).activated).toBe(true);
    expect((await liveItems()).find((i) => i.id === one.id)!.data).toMatchObject({ title: 'Edited' });
  });

  it('a held item blocks activation', async () => {
    const { batchId } = await importBundle(bundleOf(BASE()));
    const two = (await liveItems()).find((i) => (i.data as { slug: string }).slug === 'two')!;
    await db.update(items).set({ hold: true }).where(eq(items.id, two.id));
    const result = await service().activate(batchId, publisher());
    expect(result.blocked.map((b) => b.code)).toContain('ITEM_HELD');
    expect(await publicCount()).toBe(0);
  });

  it('spec "预演后撤权": the activating person must still be able to publish; otherwise nothing is published', async () => {
    const { batchId } = await importBundle(bundleOf(BASE()));
    await db.delete(userSites).where(and(eq(userSites.userId, ADMIN), eq(userSites.siteId, SITE)));
    await db.execute(sql`DELETE FROM lumibase_cache_entries WHERE key LIKE ${`%${SITE}%`}`);
    const result = await service().activate(batchId, publisher());
    expect(result.activated).toBe(false);
    expect(result.blocked.length).toBe(3);
    expect(new Set(result.blocked.map((b) => b.code)).size).toBe(1);
    expect(result.blocked[0]!.code).toBe('NO_PUBLISH_PERMISSION');
    expect((await liveItems()).every((i) => i.status === 'draft')).toBe(true);
    expect(await publicCount()).toBe(0);
    expect(await db.select().from(redirects).where(eq(redirects.siteId, SITE))).toEqual([]);
  });

  it('an internal-only item slipped into the batch blocks it; internal-only items of the bundle are never in it', async () => {
    const records = [...BASE(), article('src', { internalOnly: true, translationKey: 'src' }), article('src-zh', { locale: 'zh-CN', translationKey: 'src' })];
    const { batchId, report } = await importBundle(bundleOf(records));
    expect(report.summary.batch).toBe(4);
    const members = await db.select().from(importBatchItems).where(eq(importBatchItems.batchId, batchId));
    const ids = new Map((await liveItems()).map((i) => [(i.data as { slug: string }).slug, i.id]));
    expect(members.map((m) => m.itemId)).not.toContain(ids.get('src'));
    // The English source of "one" is made internal only after the import.
    const groups = new TranslationGroupService({ db, siteId: SITE, actor: undefined, userId: null, itemsOn: (s, tx) => new ItemService({ db: tx as unknown as Database, siteId: s }) });
    const g = (await groups.forItem(ids.get('one')!))!;
    await groups.setInternalOnly(g.id, ids.get('one')!, true, g.version);
    const result = await service().activate(batchId, publisher());
    expect(result.blocked.map((b) => [b.externalId, b.code])).toContainEqual(['one', 'INTERNAL_ONLY']);
    expect(await publicCount()).toBe(0);
  });

  it('a dry run is stale once the site changed', async () => {
    const b = bundleOf(BASE());
    const dry = await service().dryRun(b);
    await new ItemService({ db, siteId: SITE }).create('articles', { data: { title: 'Taken', slug: 'two', locale: 'en' }, status: 'draft' });
    await expect(service().import(dry.batchId, b, dry.reportHash)).rejects.toMatchObject({ code: 'REPORT_STALE' });
    expect(await articlesCount()).toBe(1);
  });

  it('task 7.2: the fixture Astro site converts, dry-runs (unknown components and path changes reported) and activates', async () => {
    const root = path.join(__dirname, '../services/site-import/__tests__/fixtures/astro-site');
    const conversion = await convertAstroSite(root, JSON.parse(await readFile(path.join(root, 'heopress-import.json'), 'utf8')));
    const out = await mkdtemp(path.join(tmpdir(), 'heopress-astro-it-'));
    try {
      await writeBundle(out, conversion);
      const b = await loadBundle(out);
      const dry = await service().dryRun(b);
      expect(dry.report.summary).toMatchObject({ create: 8, failed: 0, media: 3, batch: 7 });
      expect(dry.report.unconverted).toContainEqual({ externalId: 'blog/post.en', what: 'conversion', detail: 'Unknown component <ComparisonTable> at line 18: kept as a custom-component block.' });
      expect(dry.report.pathChanges).toEqual(
        expect.arrayContaining([
          { externalId: 'news/launch', from: '/news/launch/', to: '/blog/launch/' },
          { externalId: 'news/launch-zh', from: '/zh/news/launch-zh/', to: '/zh/blog/launch-zh/' },
        ]),
      );
      const done = await service().import(dry.batchId, b, dry.reportHash);
      expect(done.report.summary.create).toBe(8);
      const en = (await liveItems()).find((i) => (i.data as { slug: string; locale: string }).slug === 'post' && (i.data as { locale: string }).locale === 'en')!;
      expect((en.data as { body: string }).body).toContain('data-component="ComparisonTable"');
      expect((en.data as { body: string }).body).toMatch(/<img src="https:\/\/media\.example\.com\/import\/[0-9a-f]{64}\.png"/);
      const result = await service().activate(dry.batchId, publisher());
      expect(result.blocked).toEqual([]);
      expect(await publicCount()).toBe(7);
      const rules = (await db.select({ from: redirects.fromPath }).from(redirects).where(eq(redirects.siteId, SITE))).map((r) => r.from).sort();
      expect(rules).toEqual(expect.arrayContaining(['/news/launch', '/old-post', '/legacy']));
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });
});
