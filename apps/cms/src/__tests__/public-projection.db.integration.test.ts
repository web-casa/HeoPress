import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  collections,
  fields,
  gitIntegrations,
  gitPullRequests,
  items,
  projectionRebuilds,
  publicAlternates,
  publicHosts,
  publicItems,
  publicPathMemory,
  publicSites,
  redirects,
  routeTombstones,
  siteContentSettings,
  siteDomains,
  siteRenderVersions,
  sites,
  translationGroups,
  type Database,
} from '@heopress/database';
import { PreviewEnvManager } from '../modules/git-integration/preview';
import { ItemService } from '../services/item-service';
import { runSiteTransaction } from '../services/rls-transaction';
import { SchemaService } from '../services/schema-service';
import { ContentSettingsService } from '../services/site-network/content-settings-service';
import { ensureContentSettings } from '../services/site-network/preset-installer';
import { rebuildSiteProjection } from '../services/site-network/public-projection';
import { TranslationGroupService } from '../services/site-network/translation-group-service';
import { isTransaction } from '../services/site-network/translation-groups';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { createCrossSiteFixture, type CrossSiteFixture } from './helpers/cross-site-fixture';

/**
 * The public projection (HeoPress P06 task 1.2; design R1, R13, R14, R19, R22, R25, R26, R37):
 * written in the same transaction as the content, public fields only, tombstones for deleted public
 * items, the language switch across sites, render versions, and the database gate that turns a
 * forgotten refresh into a rebuild mark (or a refused commit in strict mode).
 */

const HOST = { a: 'pp-a.example.com', b: 'pp-b.example.com' } as const;

describe.skipIf(!hasDbIntegrationUrl)('public projection — DB integration', () => {
  let db: Database;
  let fx: CrossSiteFixture;

  beforeAll(async () => {
    db = await connectDbIntegration('public-projection');
  });
  beforeEach(async () => {
    fx = await createCrossSiteFixture(db, { prefix: 'pjx', jwtSecret: 'pjx' });
    for (const site of ['a', 'b'] as const) {
      const siteId = fx.sites[site];
      await db.transaction((tx) => ensureContentSettings(tx as never, siteId));
      const [coll] = await db.select({ id: collections.id }).from(collections).where(and(eq(collections.siteId, siteId), eq(collections.name, 'articles')));
      await db.insert(fields).values([
        { siteId, collectionId: coll!.id, name: 'locale', type: 'string', interface: 'input' },
        { siteId, collectionId: coll!.id, name: 'body', type: 'text', interface: 'wysiwyg' },
        { siteId, collectionId: coll!.id, name: 'secret_note', type: 'string', interface: 'input', hidden: true },
        { siteId, collectionId: coll!.id, name: 'email', type: 'string', interface: 'input', classification: 'pii' },
        { siteId, collectionId: coll!.id, name: 'blob', type: 'json', interface: 'json-raw' },
        { siteId, collectionId: coll!.id, name: 'sponsored', type: 'boolean', interface: 'toggle' },
        { siteId, collectionId: coll!.id, name: 'sponsor_name', type: 'string', interface: 'input' },
        { siteId, collectionId: coll!.id, name: 'subtitle', type: 'string', interface: 'input' },
        // A hash behind a plain input interface: the storage type decides (design R19).
        { siteId, collectionId: coll!.id, name: 'pin', type: 'hash', interface: 'input' },
        { siteId, collectionId: coll!.id, name: 'gallery', type: 'json', interface: 'repeater', options: { fields: [
          { field: 'caption', type: 'string', meta: { interface: 'input' } },
          { field: 'code', type: 'hash', meta: { interface: 'input' } },
          { field: 'owner_email', type: 'string', classification: 'pii', meta: { interface: 'input' } },
        ] } },
      ]);
      await db.insert(siteDomains).values({ siteId, hostname: HOST[site], kind: 'custom', status: 'active', isPrimary: true, verifiedAt: new Date() });
      await settings(site, { availableLocales: ['en', 'zh-CN'], localePrefixes: { 'zh-CN': 'zh' }, permalinks: { articles: '/:slug' }, allowCrossSiteTranslations: true });
    }
    // The fixture wrote past the services: rebuild both sites, as a deployment does first (other suites' sites are not ours to touch).
    for (const site of ['a', 'b'] as const) await rebuildSiteProjection(db, fx.sites[site]);
  });
  afterAll(async () => {
    if (fx) await fx.teardown();
  });

  async function settings(site: 'a' | 'b', over: Record<string, unknown>) {
    const siteId = fx.sites[site];
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
      allowCrossSiteTranslations: r!.allowCrossSiteTranslations,
      sponsorDisclosure: true,
      sponsorRel: true,
      version: r!.version,
      ...over,
    } as never);
  }
  const svc = (site: 'a' | 'b') => new ItemService({ db, siteId: fx.sites[site] });
  const article = (site: 'a' | 'b', slug: string, extra: Record<string, unknown> = {}, status = 'published') =>
    svc(site).create('articles', { data: { title: slug, slug, locale: 'en', ...extra }, status }) as Promise<{ id: string; version: number }>;
  const versionOf = async (id: string) => (await db.select({ v: items.version }).from(items).where(eq(items.id, id)))[0]!.v;
  const rowOf = async (id: string) => (await db.select().from(publicItems).where(eq(publicItems.itemId, id)))[0];
  const renderVersion = async (site: 'a' | 'b') => (await db.select({ v: siteRenderVersions.version }).from(siteRenderVersions).where(eq(siteRenderVersions.siteId, fx.sites[site])))[0]?.v ?? 0;
  const marks = async () => db.select().from(projectionRebuilds).where(inArray(projectionRebuilds.siteId, [fx.sites.a, fx.sites.b]));
  const tombstone = async (site: 'a' | 'b', path: string) =>
    (await db.select().from(routeTombstones).where(and(eq(routeTombstones.siteId, fx.sites[site]), eq(routeTombstones.path, path))))[0];

  it('a published item is projected with its public fields only, in the same transaction; drafts are not', async () => {
    const before = await renderVersion('a');
    const a = await article('a', 'hello-p', {
      body:
        '<p data-block-id="b1">Hi<script>alert(1)</script><a href="javascript:x">x</a><a href="https://example.org" target="_blank">ok</a></p>' +
        '<video data-block-id="b2" src="https://img.example.com/v.mp4" controls preload="metadata" autoplay onplay="x()"></video><video src="javascript:alert(1)" controls></video>',
      secret_note: 'internal',
      email: 'someone@example.com',
      blob: { anything: 1 },
      undeclared: 'dropped',
      pin: '$argon2id$v=19$secret',
      gallery: [{ caption: 'c1', code: 'x', owner_email: 'o@example.com', extra: 1 }],
      sponsored: true,
      sponsor_name: 'Acme',
    });
    const row = await rowOf(a.id);
    expect(row).toBeDefined();
    expect(row!.path).toBe('/hello-p');
    expect(Object.keys(row!.data).sort()).toEqual(['body', 'gallery', 'locale', 'slug', 'sponsor_name', 'sponsored', 'title'].sort());
    expect(row!.data.gallery).toEqual([{ caption: 'c1' }]);
    expect(row!.data.body).not.toContain('<script');
    expect(row!.data.body).not.toContain('javascript:');
    expect(row!.data.body).toContain('rel="noopener noreferrer"');
    // A short video (ADR-0020): kept with its controls; no autoplay, no handlers, no script address.
    expect(row!.data.body).toContain('<video data-block-id="b2" src="https://img.example.com/v.mp4" controls preload="metadata"></video>');
    expect(row!.data.body).not.toMatch(/autoplay|onplay|javascript:alert/);
    expect(row!).toMatchObject({ sponsored: true, sponsorName: 'Acme' });
    expect((row!.card as { url: string }).url).toBe(`https://${HOST.a}/hello-p/`);
    expect(await renderVersion('a')).toBeGreaterThan(before);
    // Drafts are not projected; nothing was left for a rebuild.
    const d = await article('a', 'draft-p', {}, 'draft');
    expect(await rowOf(d.id)).toBeUndefined();
    expect(await marks()).toEqual([]);
  });

  it('unpublishing removes the row (404); deleting a once-public item leaves a 410 tombstone; reuse or a redirect clears it', async () => {
    const a = await article('a', 'gone');
    await svc('a').patch('articles', a.id, { status: 'draft', expectedVersion: await versionOf(a.id) });
    expect(await rowOf(a.id)).toBeUndefined();
    expect(await tombstone('a', '/gone')).toBeUndefined();
    // Unpublished, then deleted: it was public once → 410 (design R22).
    await svc('a').softDelete('articles', a.id);
    expect(await tombstone('a', '/gone')).toMatchObject({ itemId: a.id, locale: 'en' });
    // Hard delete of a public item too.
    const b = await article('a', 'gone-hard');
    await svc('a').hardDelete('articles', b.id);
    expect(await tombstone('a', '/gone-hard')).toMatchObject({ itemId: b.id });
    // The path is used again: no tombstone.
    await article('a', 'gone');
    expect(await tombstone('a', '/gone')).toBeUndefined();
    // A redirect from the other tombstoned path answers instead.
    await db.transaction(async (tx) => {
      await tx.insert(redirects).values({ siteId: fx.sites.a, scope: 'content', locale: 'en', fromPath: '/gone-hard', match: 'exact', toPath: '/gone', toLocale: 'en', source: 'manual' });
      const { flushPublicProjection } = await import('../services/site-network/public-projection');
      await flushPublicProjection(tx as never);
    });
    expect(await tombstone('a', '/gone-hard')).toBeUndefined();
    expect(await marks()).toEqual([]);
  });

  it('a slug change moves the projected path; a permalink change moves every article of the collection', async () => {
    const a = await article('a', 'old-slug');
    await svc('a').patch('articles', a.id, { data: { slug: 'new-slug' }, expectedVersion: await versionOf(a.id) });
    expect((await rowOf(a.id))!.path).toBe('/new-slug');
    const b = await article('a', 'other');
    // rebuildRoutes inside the settings transaction rewrites both routes.
    await settings('a', { permalinks: { articles: '/blog/:slug' } });
    expect((await rowOf(a.id))!.path).toBe('/blog/new-slug');
    expect((await rowOf(b.id))!.path).toBe('/blog/other');
    expect((await rowOf(b.id))!.card).toMatchObject({ url: `https://${HOST.a}/blog/other/` });
    expect(await marks()).toEqual([]);
  });

  it('metadata only: hiding a field takes it out of every projected row (design R37)', async () => {
    const a = await article('a', 'meta', { sponsor_name: 'Acme' });
    expect((await rowOf(a.id))!.data).toHaveProperty('sponsor_name', 'Acme');
    const before = await renderVersion('a');
    await new SchemaService({ db, siteId: fx.sites.a }).updateField('articles', 'sponsor_name', { hidden: true });
    expect((await rowOf(a.id))!.data).not.toHaveProperty('sponsor_name');
    expect(await renderVersion('a')).toBeGreaterThan(before);
    // Hidden on A does not touch B.
    const b = await article('b', 'meta-b', { sponsor_name: 'Acme' });
    expect((await rowOf(b.id))!.data).toHaveProperty('sponsor_name', 'Acme');
    expect(await marks()).toEqual([]);
  });

  it("the language switch across sites: both switches on, each site stores the other's URL; switching off removes it from both", async () => {
    const en = await article('a', 'lang-en');
    const zh = await article('b', 'lang-zh', { locale: 'zh-CN' });
    const groups = new TranslationGroupService({ db, siteId: fx.sites.a, actor: undefined, userId: null, itemsOn: (siteId, tx) => new ItemService({ db: tx as never, siteId }) });
    const g = await groups.create(en.id);
    await groups.addMember(g.id, { siteId: fx.sites.b, itemId: zh.id, expectedVersion: g.version });
    const alt = async (site: 'a' | 'b', itemId: string) =>
      (await db.select().from(publicAlternates).where(and(eq(publicAlternates.siteId, fx.sites[site]), eq(publicAlternates.itemId, itemId)))).map((r) => [r.locale, r.url]).sort();
    expect(await alt('a', en.id)).toEqual([
      ['en', `https://${HOST.a}/lang-en/`],
      ['zh-CN', `https://${HOST.b}/zh/lang-zh/`],
    ]);
    expect(await alt('b', zh.id)).toEqual([
      ['en', `https://${HOST.a}/lang-en/`],
      ['zh-CN', `https://${HOST.b}/zh/lang-zh/`],
    ]);
    const vA = await renderVersion('a');
    await settings('b', { allowCrossSiteTranslations: false });
    expect(await alt('a', en.id)).toEqual([['en', `https://${HOST.a}/lang-en/`]]);
    expect(await alt('b', zh.id)).toEqual([['zh-CN', `https://${HOST.b}/zh/lang-zh/`]]);
    // A's output changed because of B's switch: A's version rose too.
    expect(await renderVersion('a')).toBeGreaterThan(vA);
    // B's article unpublished: A no longer links to it (after switching back on).
    await settings('b', { allowCrossSiteTranslations: true });
    expect(await alt('a', en.id)).toHaveLength(2);
    await svc('b').patch('articles', zh.id, { status: 'draft', expectedVersion: await versionOf(zh.id) });
    expect(await alt('a', en.id)).toEqual([['en', `https://${HOST.a}/lang-en/`]]);
    void translationGroups;
    expect(await marks()).toEqual([]);
  });

  it('hosts: active domains only, with the primary; a domain change rebuilds the site', async () => {
    const hosts = async () =>
      (await db.select().from(publicHosts).where(eq(publicHosts.siteId, fx.sites.a))).map((h) => [h.hostname, h.isPrimary, h.primaryHostname]).sort();
    expect(await hosts()).toEqual([[HOST.a, true, HOST.a]]);
    const a = await article('a', 'moved');
    const NEW = 'pp-a2.example.com';
    // A new primary domain, written as the domain routes do (a site transaction).
    await runSiteTransaction(db, fx.sites.a, async (tx) => {
      await tx.update(siteDomains).set({ isPrimary: false }).where(eq(siteDomains.siteId, fx.sites.a));
      await tx.insert(siteDomains).values({ siteId: fx.sites.a, hostname: NEW, kind: 'custom', status: 'active', isPrimary: true, verifiedAt: new Date() });
      await tx.insert(siteDomains).values({ siteId: fx.sites.a, hostname: 'pp-a3.example.com', kind: 'custom', status: 'pending', isPrimary: false });
    });
    expect(await hosts()).toEqual([
      [HOST.a, false, NEW],
      [NEW, true, NEW],
    ]);
    expect((await rowOf(a.id))!.card).toMatchObject({ url: `https://${NEW}/moved/` });
    expect(await marks()).toEqual([]);
  });

  it('backfill consistency: a rebuild from scratch yields what the transactions maintained', async () => {
    const en = await article('a', 'bf-en', { body: '<p>x</p>', sponsor_name: 'n' });
    const zh = await article('b', 'bf-zh', { locale: 'zh-CN' });
    await article('a', 'bf-draft', {}, 'draft');
    const gone = await article('a', 'bf-gone');
    await svc('a').softDelete('articles', gone.id);
    const groups = new TranslationGroupService({ db, siteId: fx.sites.a, actor: undefined, userId: null, itemsOn: (siteId, tx) => new ItemService({ db: tx as never, siteId }) });
    const g = await groups.create(en.id);
    await groups.addMember(g.id, { siteId: fx.sites.b, itemId: zh.id, expectedVersion: g.version });
    const ours = [fx.sites.a, fx.sites.b];
    const snapshot = async () => ({
      items: (await db.select().from(publicItems).where(inArray(publicItems.siteId, ours)))
        .map(({ itemId, siteId, locale, path, data, card, sponsored, sponsorName }) => ({ itemId, siteId, locale, path, data, card, sponsored, sponsorName }))
        .sort((x, y) => (x.itemId < y.itemId ? -1 : 1)),
      alternates: (await db.select().from(publicAlternates).where(inArray(publicAlternates.siteId, ours)))
        .map(({ siteId, itemId, targetItemId, locale, url }) => [siteId, itemId, targetItemId, locale, url].join('|'))
        .sort(),
      hosts: (await db.select().from(publicHosts).where(inArray(publicHosts.siteId, ours))).map((h) => h.hostname).sort(),
      tombstones: (await db.select().from(routeTombstones).where(inArray(routeTombstones.siteId, ours))).map((t) => `${t.siteId}|${t.path}`).sort(),
    });
    const maintained = await snapshot();
    expect(maintained.items.length).toBeGreaterThan(0);
    // Wipe the rows a rebuild derives from the base tables (tombstones are history, kept), then rebuild.
    await db.delete(publicItems).where(inArray(publicItems.siteId, ours));
    await db.delete(publicAlternates).where(inArray(publicAlternates.siteId, ours));
    await db.delete(publicHosts).where(inArray(publicHosts.siteId, ours));
    for (const siteId of ours) await rebuildSiteProjection(db, siteId);
    expect(await snapshot()).toEqual(maintained);
    expect(await marks()).toEqual([]);
  });

  it('concurrency: hiding a field while an item is edited never republishes it; enabling both switches at once links both ways', async () => {
    for (let round = 0; round < 3; round++) {
      const a = await article('a', `race-${round}`, { subtitle: 'visible' });
      await Promise.all([
        svc('a').patch('articles', a.id, { data: { subtitle: `edited ${round}` }, expectedVersion: await versionOf(a.id) }),
        new SchemaService({ db, siteId: fx.sites.a }).updateField('articles', 'subtitle', { hidden: true }),
      ]);
      expect((await rowOf(a.id))!.data, `round ${round}`).not.toHaveProperty('subtitle');
      await new SchemaService({ db, siteId: fx.sites.a }).updateField('articles', 'subtitle', { hidden: false });
    }
    const en = await article('a', 'both-en');
    const zh = await article('b', 'both-zh', { locale: 'zh-CN' });
    const groups = new TranslationGroupService({ db, siteId: fx.sites.a, actor: undefined, userId: null, itemsOn: (siteId, tx) => new ItemService({ db: tx as never, siteId }) });
    const g = await groups.create(en.id);
    await groups.addMember(g.id, { siteId: fx.sites.b, itemId: zh.id, expectedVersion: g.version });
    const count = async (site: 'a' | 'b', itemId: string) =>
      (await db.select().from(publicAlternates).where(and(eq(publicAlternates.siteId, fx.sites[site]), eq(publicAlternates.itemId, itemId)))).length;
    for (let round = 0; round < 3; round++) {
      await settings('a', { allowCrossSiteTranslations: false });
      await settings('b', { allowCrossSiteTranslations: false });
      expect([await count('a', en.id), await count('b', zh.id)]).toEqual([1, 1]);
      await Promise.all([settings('a', { allowCrossSiteTranslations: true }), settings('b', { allowCrossSiteTranslations: true })]);
      expect([await count('a', en.id), await count('b', zh.id)], `round ${round}`).toEqual([2, 2]);
    }
    expect(await marks()).toEqual([]);
  });

  it('a rebuild restores what writes past the services broke: the 410 of a hard-deleted item, orphaned language-switch rows', async () => {
    const a = await article('a', 'bypass-gone');
    await svc('a').patch('articles', a.id, { status: 'draft', expectedVersion: await versionOf(a.id) });
    // Only the path memory still knows the item once it is deleted directly.
    await db.delete(items).where(eq(items.id, a.id));
    expect((await marks()).map((m) => m.siteId)).toContain(fx.sites.a);
    // A language-switch row left behind for an item in no group.
    const lone = await article('a', 'bypass-lone');
    await db.insert(publicAlternates).values({ siteId: fx.sites.a, itemId: lone.id, targetItemId: lone.id, locale: 'zh-CN', url: 'https://pp-a.example.com/zh/x/' });
    await rebuildSiteProjection(db, fx.sites.a);
    expect(await tombstone('a', '/bypass-gone')).toMatchObject({ itemId: a.id });
    expect(await db.select().from(publicPathMemory).where(eq(publicPathMemory.itemId, a.id))).toEqual([]);
    expect(await db.select().from(publicAlternates).where(eq(publicAlternates.itemId, lone.id))).toEqual([]);
    expect(await marks()).toEqual([]);
  });

  it('git preview environments: provisioning and teardown flush the projection (no rebuild marks)', async () => {
    await article('a', 'pr-copied');
    await db.insert(gitIntegrations).values({ id: 'pjx-int', siteId: fx.sites.a, provider: 'github', repoFullName: 'example/site', displayName: 'site', authMethod: 'pat' });
    await db.insert(gitPullRequests).values({ id: 'pjx-pr-7', siteId: fx.sites.a, integrationId: 'pjx-int', number: 7, title: 'pr', state: 'open', headSha: 'abc' });
    const manager = new PreviewEnvManager({ db, runtime: {} as never, siteId: fx.sites.a, integrationId: 'pjx-int', publicBaseUrl: 'https://cms.example.com', isDev: false });
    const eph = `${fx.sites.a}__pr-7`;
    // The ephemeral site is not the fixture's (no cascade from it): start clean, end clean.
    const clean = async () => {
      await db.delete(sites).where(eq(sites.id, eph));
      await db.delete(projectionRebuilds).where(eq(projectionRebuilds.siteId, eph));
    };
    await clean();
    onTestFinished(clean);
    const marksOf = async (site: string) => db.select().from(projectionRebuilds).where(eq(projectionRebuilds.siteId, site));
    await manager.ensureForPullRequest({ prId: 'pjx-pr-7', number: 7, state: 'open' });
    expect(await marksOf(eph)).toEqual([]);
    expect(await marksOf(fx.sites.a)).toEqual([]);
    expect(await db.select({ id: publicSites.siteId }).from(publicSites).where(eq(publicSites.siteId, eph))).toHaveLength(1);
    // The preview site has a content settings row, which its purge locks before its items (P07, Codex review of batch 4b).
    expect(await runSiteTransaction(db, eph, (tx) => tx.select().from(siteContentSettings).where(eq(siteContentSettings.siteId, eph)))).toHaveLength(1);
    const ownerUrl = process.env.DATABASE_OWNER_URL?.trim();
    expect(ownerUrl, 'DATABASE_OWNER_URL is required').toBeDefined();
    const holder = postgres(ownerUrl!, { max: 1, onnotice: () => {} });
    const watcher = postgres(ownerUrl!, { max: 1, onnotice: () => {} });
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let held!: (pid: number) => void;
    const holding = new Promise<number>((r) => (held = r));
    let itemsFree: boolean | null = null;
    try {
      const hold = holder.begin(async (tx) => {
        await tx`SELECT set_config('app.site_id', ${eph}, true)`;
        await tx`SELECT 1 FROM lumibase_site_content_settings WHERE site_id = ${eph} FOR UPDATE`;
        held((await tx`SELECT pg_backend_pid() AS pid`)[0]!.pid as number);
        await released;
        // The purge waits for the settings row: it has not locked an item row yet.
        itemsFree = (await tx`SELECT 1 FROM lumibase_items WHERE site_id = ${eph} FOR UPDATE NOWAIT`).length > 0;
      });
      const holderPid = await holding;
      // Refresh (purge + copy again) while the settings row is held.
      const refresh = manager.ensureForPullRequest({ prId: 'pjx-pr-7', number: 7, state: 'open' });
      const deadline = Date.now() + 10_000;
      for (;;) {
        const [w] = await watcher`SELECT count(*)::int AS n FROM pg_stat_activity WHERE ${holderPid}::int = ANY(pg_blocking_pids(pid))`;
        if ((w?.n ?? 0) >= 1) break;
        if (Date.now() > deadline) throw new Error('the purge never waited for the settings row');
        await new Promise((r) => setTimeout(r, 25));
      }
      release();
      await hold;
      await refresh;
    } finally {
      release();
      await holder.end({ timeout: 1 });
      await watcher.end({ timeout: 1 });
    }
    expect(itemsFree).toBe(true);
    await manager.destroy('pjx-pr-7');
    expect(await marksOf(eph)).toEqual([]);
    expect(await db.select().from(publicItems).where(eq(publicItems.siteId, eph))).toEqual([]);
  });

  it('a Drizzle transaction handle is told apart from the database (the outermost-retry rule, R30)', async () => {
    expect(isTransaction(db)).toBe(false);
    await db.transaction(async (tx) => {
      expect(isTransaction(tx)).toBe(true);
      await tx.transaction(async (sp) => expect(isTransaction(sp)).toBe(true));
    });
  });

  it('the gate: a write past the services becomes a rebuild mark; strict mode refuses it; a rebuild clears the marks it saw', async () => {
    const a = await article('a', 'raw');
    await db.update(items).set({ data: sql`jsonb_set(${items.data}, '{title}', '"changed raw"')` }).where(eq(items.id, a.id));
    expect((await marks()).map((m) => m.siteId)).toContain(fx.sites.a);
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL heopress.projection_gate = 'strict'`);
        await tx.update(items).set({ data: sql`jsonb_set(${items.data}, '{title}', '"strict"')` }).where(eq(items.id, a.id));
      }),
    ).rejects.toThrow(/public projection not refreshed/);
    await rebuildSiteProjection(db, fx.sites.a);
    expect(await marks()).toEqual([]);
    expect((await rowOf(a.id))!.data.title).toBe('changed raw');
  });
});
