import { readFileSync } from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { BACKGROUND_REFRESH_REASONS, collections, fields, items, projectionRebuilds, publicAlternates, publicSites, siteContentSettings, siteDomains, siteRenderVersions, translationGroups, type Database } from '@heopress/database';
import { createRuntime } from '@heopress/runtime/node';
import { renderPort } from '@heopress/site-classic/read-port';
import { discoveryPageOf } from '@heopress/site-classic/view-model';
import { feedEntry, llmsEntry, sitemapEntry } from '@heopress/seo-geo';
import app from '../index';
import { setRuntimeFactory } from '../middleware/runtime';
import { ItemService } from '../services/item-service';
import { ContentSettingsService } from '../services/site-network/content-settings-service';
import { ensureContentSettings } from '../services/site-network/preset-installer';
import { rebuildSiteProjection } from '../services/site-network/public-projection';
import { SeoSettingsService } from '../services/site-network/seo-settings-service';
import { TranslationGroupService } from '../services/site-network/translation-group-service';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { createCrossSiteFixture, type CrossSiteFixture } from './helpers/cross-site-fixture';

/**
 * The language switch as hreflang (HeoPress P07 task 2.2; spec seo/page-metadata "双向 hreflang"): every member page of a
 * translation group lists the group's published, indexable members — itself included — and the same set on each;
 * a page not indexable lists none; another site's members only while both sites have cross-site translations on.
 * The group's x-default names one of those members and goes wherever it stops being one.
 */

const JWT_SECRET = 'hreflang-secret';
const HOST = { a: 'hl-a.example.com', b: 'hl-b.example.com' } as const;
const OWNER_URL = process.env.DATABASE_OWNER_URL?.trim() || undefined;

/** Wait until `n` sessions are blocked by the backend `pid` (never by anything else running meanwhile). */
async function blockedBy(watcher: postgres.Sql, pid: number, n: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const [w] = await watcher`SELECT count(*)::int AS n FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))`;
    if ((w?.n ?? 0) >= n) return;
    if (Date.now() > deadline) throw new Error(`fewer than ${n} sessions blocked by ${pid}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Wait until `n` sessions wait, directly or through other waiters, on the backend `pid` (its wait graph only). */
async function waitingOn(watcher: postgres.Sql, pid: number, n: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const [w] = await watcher`
      WITH RECURSIVE waiting(pid) AS (
        SELECT a.pid FROM pg_stat_activity a WHERE ${pid}::int = ANY(pg_blocking_pids(a.pid))
        UNION
        SELECT a.pid FROM pg_stat_activity a JOIN waiting w ON w.pid = ANY(pg_blocking_pids(a.pid))
      ) SELECT count(*)::int AS n FROM waiting`;
    if ((w?.n ?? 0) >= n) return;
    if (Date.now() > deadline) throw new Error(`fewer than ${n} sessions waiting on ${pid}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe.skipIf(!hasDbIntegrationUrl)('hreflang and x-default — DB integration', () => {
  let db: Database;
  let fx: CrossSiteFixture;
  let env: Record<string, unknown> = {};

  beforeAll(async () => {
    db = await connectDbIntegration('hreflang');
    env = { ...process.env, JWT_SECRET, HEOPRESS_ENV: 'development' };
    const runtime = createRuntime(env);
    setRuntimeFactory(() => runtime);
  });
  beforeEach(async () => {
    fx = await createCrossSiteFixture(db, { prefix: 'hrl', jwtSecret: JWT_SECRET });
    for (const site of ['a', 'b'] as const) {
      const siteId = fx.sites[site];
      await db.transaction((tx) => ensureContentSettings(tx as never, siteId));
      const [coll] = await db.select({ id: collections.id }).from(collections).where(and(eq(collections.siteId, siteId), eq(collections.name, 'articles')));
      await db.insert(fields).values([
        { siteId, collectionId: coll!.id, name: 'locale', type: 'string', interface: 'input' },
        { siteId, collectionId: coll!.id, name: 'seo_robots', type: 'string', interface: 'select-dropdown' },
      ]);
      await db.insert(siteDomains).values({ siteId, hostname: HOST[site], kind: 'custom', status: 'active', isPrimary: true, verifiedAt: new Date() });
      await settings(site, { availableLocales: ['en', 'zh-CN', 'ja', 'pt'], localePrefixes: { 'zh-CN': 'zh' }, permalinks: { articles: '/:slug' }, allowCrossSiteTranslations: true });
    }
    // The fixture wrote past the services: rebuild both sites, as a deployment does first.
    for (const site of ['a', 'b'] as const) await rebuildSiteProjection(db, fx.sites[site]);
  });
  afterAll(async () => {
    setRuntimeFactory(null);
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
  const itemsOf = (site: 'a' | 'b') => new ItemService({ db, siteId: fx.sites[site] });
  const article = (site: 'a' | 'b', slug: string, locale: string) =>
    itemsOf(site).create('articles', { data: { title: slug, slug, locale }, status: 'published' }) as Promise<{ id: string; version: number }>;
  const versionOf = async (id: string) => (await db.select({ v: items.version }).from(items).where(eq(items.id, id)))[0]!.v;
  const robots = async (site: 'a' | 'b', id: string, value: string) =>
    itemsOf(site).patch('articles', id, { data: { seo_robots: value }, expectedVersion: await versionOf(id) });
  const groups = (site: 'a' | 'b' = 'a') =>
    new TranslationGroupService({ db, siteId: fx.sites[site], actor: undefined, userId: null, itemsOn: (siteId, tx) => new ItemService({ db: tx as never, siteId }) });
  const groupRow = async (id: string) => (await db.select().from(translationGroups).where(eq(translationGroups.id, id)))[0]!;
  const alt = async (site: 'a' | 'b', itemId: string) =>
    (await db.select().from(publicAlternates).where(and(eq(publicAlternates.siteId, fx.sites[site]), eq(publicAlternates.itemId, itemId)))).map((r) => [r.locale, r.url]).sort();
  const renderVersion = async (site: 'a' | 'b') =>
    (await db.select({ v: siteRenderVersions.version }).from(siteRenderVersions).where(eq(siteRenderVersions.siteId, fx.sites[site])))[0]?.v ?? 0;
  const codeOf = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code ?? String(e));
  const URL_EN = `https://${HOST.a}/en-post/`;
  const URL_ZH = `https://${HOST.b}/zh/zh-post/`;
  const URL_JA = `https://${HOST.a}/ja/ja-post/`;

  /** en and ja on A, zh on B, one group. */
  async function group() {
    const en = await article('a', 'en-post', 'en');
    const ja = await article('a', 'ja-post', 'ja');
    const zh = await article('b', 'zh-post', 'zh-CN');
    const g = await groups().create(en.id);
    await groups().addMember(g.id, { itemId: ja.id, expectedVersion: g.version });
    await groups().addMember(g.id, { siteId: fx.sites.b, itemId: zh.id, expectedVersion: (await groupRow(g.id)).version });
    return { en, ja, zh, groupId: g.id };
  }

  it('every member lists the same indexable set, itself included; a member set to noindex leaves every list, and lists none itself', async () => {
    const { en, ja, zh } = await group();
    const all = [['en', URL_EN], ['ja', URL_JA], ['zh-CN', URL_ZH]];
    for (const [site, id] of [['a', en.id], ['a', ja.id], ['b', zh.id]] as const) expect(await alt(site, id), id).toEqual(all);
    // The Chinese translation is not to be indexed: the English and Japanese pages no longer name it.
    await robots('b', zh.id, 'noindex,follow');
    for (const id of [en.id, ja.id]) expect(await alt('a', id)).toEqual([['en', URL_EN], ['ja', URL_JA]]);
    expect(await alt('b', zh.id)).toEqual([]);
    // Indexed again: back everywhere.
    await robots('b', zh.id, 'index,follow');
    expect(await alt('b', zh.id)).toEqual(all);
    // A member unpublished (no published translation in that language): not listed.
    await itemsOf('a').patch('articles', ja.id, { status: 'draft', expectedVersion: await versionOf(ja.id) });
    expect(await alt('b', zh.id)).toEqual([['en', URL_EN], ['zh-CN', URL_ZH]]);
  });

  it('task 2.6: a member set to noindex — no discovery entry anywhere, out of the others\' alternates, flagged in the language switch API; its page still answers', async () => {
    const { en, ja, zh } = await group();
    const discovery = (site: 'a' | 'b', id: string) =>
      renderPort(db).request(fx.sites[site], async (_p, reads) => {
        const [info, row, alternates] = await Promise.all([reads.site(), reads.item(id), reads.alternates(id)]);
        const page = discoveryPageOf(info!, row!, alternates);
        return { page, sitemap: sitemapEntry(page), entries: [sitemapEntry(page), feedEntry(page), llmsEntry(page)] };
      });
    const before = await discovery('a', en.id);
    expect(before.entries.every((e) => e !== null)).toBe(true);
    expect(before.sitemap!.alternates.map((a) => a.locale).sort()).toEqual(['en', 'ja', 'zh-CN']);
    // The real content time (task 2.5), not the row's update time.
    expect(before.page.modifiedAt).toBe(before.page.publishedAt);
    await robots('a', ja.id, 'noindex,follow');
    expect((await discovery('a', ja.id)).entries).toEqual([null, null, null]);
    for (const [site, id] of [['a', en.id], ['b', zh.id]] as const) {
      expect((await discovery(site, id)).sitemap!.alternates.map((a) => a.locale).sort(), id).toEqual(['en', 'zh-CN']);
    }
    // The page itself stays crawlable, with the directive.
    const page = await renderPort(db).request(fx.sites.a, (_p, reads) => reads.item(ja.id));
    expect(page?.seoRobots).toBe('noindex,follow');
    // The editors' language switch still lists it, flagged: hreflang takes the indexable ones only.
    const headers = fx.headers('a', await fx.session('both', 'a'));
    const res = await app.request(`/api/v1/items/articles/${en.id}/alternates`, { headers }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ locale: string; indexable: boolean; current: boolean }> };
    expect(body.data.map((a) => [a.locale, a.indexable, a.current]).sort()).toEqual([['en', true, true], ['ja', false, false], ['zh-CN', true, false]]);
  });

  it("a site's SEO settings decide its members: another site's switch changes with them, and that site's render version rises", async () => {
    const { en, zh } = await group();
    const vA = await renderVersion('a');
    await new SeoSettingsService({ db, siteId: fx.sites.b, actor: { userId: null } }).update({ version: 0, index: { site: false } });
    expect(await alt('a', en.id)).toEqual([['en', URL_EN], ['ja', URL_JA]]);
    expect(await alt('b', zh.id)).toEqual([]);
    expect(await renderVersion('a')).toBeGreaterThan(vA);
    // Cross-site translations off: each site keeps its own members only.
    await new SeoSettingsService({ db, siteId: fx.sites.b, actor: { userId: null } }).update({ version: 1, index: { site: true } });
    await settings('b', { allowCrossSiteTranslations: false });
    expect(await alt('a', en.id)).toEqual([['en', URL_EN], ['ja', URL_JA]]);
    expect(await alt('b', zh.id)).toEqual([['zh-CN', URL_ZH]]);
  });

  it('task 2.8: a collection its site does not index by default leaves every alternates list — on the other site too; set back, it returns', async () => {
    const { en, ja, zh } = await group();
    const all = [['en', URL_EN], ['ja', URL_JA], ['zh-CN', URL_ZH]];
    const seoB = new SeoSettingsService({ db, siteId: fx.sites.b, actor: { userId: null } });
    await seoB.update({ version: 0, index: { collections: { articles: false } } });
    for (const id of [en.id, ja.id]) expect(await alt('a', id), id).toEqual([['en', URL_EN], ['ja', URL_JA]]);
    expect(await alt('b', zh.id)).toEqual([]);
    // The member's own `index` is more specific than its collection's default.
    await robots('b', zh.id, 'index');
    expect(await alt('a', en.id)).toEqual(all);
    await robots('b', zh.id, 'index,follow');
    expect(await alt('a', en.id)).toEqual([['en', URL_EN], ['ja', URL_JA]]);
    await seoB.update({ version: 1, index: { collections: {} } });
    for (const [site, id] of [['a', en.id], ['a', ja.id], ['b', zh.id]] as const) expect(await alt(site, id), id).toEqual(all);
  });

  it('x-default: one member on every list; gone everywhere while it is not indexable, when cleared or when it leaves', async () => {
    const { en, ja, zh, groupId } = await group();
    // Only a published, indexable member; only a member.
    await robots('a', ja.id, 'noindex,follow');
    expect(await codeOf(groups().setXDefault(groupId, ja.id, (await groupRow(groupId)).version))).toBe('X_DEFAULT_NOT_INDEXABLE');
    const outsider = await article('a', 'outsider', 'en');
    expect(await codeOf(groups().setXDefault(groupId, outsider.id, (await groupRow(groupId)).version))).toBe('NOT_A_MEMBER');
    expect(await codeOf(groups().setXDefault(groupId, en.id, 1))).toBe('VERSION_CONFLICT');
    await robots('a', ja.id, 'index,follow');

    const view = await groups().setXDefault(groupId, en.id, (await groupRow(groupId)).version);
    expect(view.xDefaultItemId).toBe(en.id);
    const withDefault = [['en', URL_EN], ['ja', URL_JA], ['x-default', URL_EN], ['zh-CN', URL_ZH]];
    for (const [site, id] of [['a', en.id], ['a', ja.id], ['b', zh.id]] as const) expect(await alt(site, id), id).toEqual(withDefault);
    // The member stops being indexable: no x-default anywhere (the setting stays, for when it is again).
    await robots('a', en.id, 'noindex,follow');
    expect(await alt('b', zh.id)).toEqual([['ja', URL_JA], ['zh-CN', URL_ZH]]);
    expect((await groupRow(groupId)).xDefaultItemId).toBe(en.id);
    await robots('a', en.id, 'index,follow');
    expect(await alt('b', zh.id)).toEqual(withDefault);
    // Deleted: not public, so not listed — nor as x-default.
    await itemsOf('a').softDelete('articles', en.id);
    expect(await alt('b', zh.id)).toEqual([['ja', URL_JA], ['zh-CN', URL_ZH]]);
  });

  it('x-default: cleared explicitly, and when its member leaves the group', async () => {
    const { en, zh, groupId } = await group();
    await groups().setXDefault(groupId, zh.id, (await groupRow(groupId)).version);
    expect(await alt('a', en.id)).toContainEqual(['x-default', URL_ZH]);
    await groups().setXDefault(groupId, null, (await groupRow(groupId)).version);
    expect(await alt('a', en.id)).not.toContainEqual(['x-default', URL_ZH]);
    await groups().setXDefault(groupId, zh.id, (await groupRow(groupId)).version);
    await groups().removeMember(groupId, zh.id, (await groupRow(groupId)).version);
    expect((await groupRow(groupId)).xDefaultItemId).toBeNull();
    expect((await alt('a', en.id)).map(([l]) => l)).toEqual(['en', 'ja']);
  });

  it('the x-default route: edit permission on every member site is needed — the same 403 whatever the target; a malformed body is refused', async () => {
    const { en, ja, groupId } = await group();
    await robots('a', ja.id, 'noindex,follow');
    // A member deleted since it joined (B's member stays: the caller has no permission there).
    const gone = await itemsOf('a').create('articles', { data: { title: 'gone', slug: 'gone', locale: 'pt' }, status: 'draft' }) as { id: string };
    await groups().addMember(groupId, { itemId: gone.id, expectedVersion: (await groupRow(groupId)).version });
    await itemsOf('a').softDelete('articles', gone.id);
    const outsider = await article('a', 'outsider', 'en');
    const version = (await groupRow(groupId)).version;
    const onlyA = fx.headers('a', await fx.session('onlyA', 'a'));
    // A valid member, a member not indexable, a deleted member, an item not in the group, an unknown id: nothing told apart.
    for (const itemId of [en.id, ja.id, gone.id, outsider.id, 'no-such-item']) {
      const res = await app.request(`/api/v1/translation-groups/${groupId}/x-default`, { method: 'PUT', headers: onlyA, body: JSON.stringify({ itemId, expectedVersion: version }) }, env);
      expect(res.status, itemId).toBe(403);
      expect(((await res.json()) as { errors: Array<{ code: string }> }).errors[0]!.code, itemId).toBe('FORBIDDEN');
    }
    expect((await groupRow(groupId)).xDefaultItemId).toBeNull();
    const bad = await app.request(`/api/v1/translation-groups/${groupId}/x-default`, { method: 'PUT', headers: onlyA, body: JSON.stringify({ itemId: en.id }) }, env);
    expect(bad.status).toBe(400);
  });

  it('x-default: a hard delete of its item clears it (ON DELETE SET NULL) and refreshes every member site in the same transaction', async () => {
    const { en, zh, groupId } = await group();
    await groups().setXDefault(groupId, en.id, (await groupRow(groupId)).version);
    expect(await alt('b', zh.id)).toContainEqual(['x-default', URL_EN]);
    const vB = await renderVersion('b');
    expect(await itemsOf('a').hardDelete('articles', en.id)).toBe(true);
    expect((await groupRow(groupId)).xDefaultItemId).toBeNull();
    expect(await alt('b', zh.id)).toEqual([['ja', URL_JA], ['zh-CN', URL_ZH]]);
    expect(await renderVersion('b')).toBeGreaterThan(vB);
    expect(await db.select().from(projectionRebuilds).where(inArray(projectionRebuilds.siteId, [fx.sites.a, fx.sites.b]))).toEqual([]);
  });

  it('concurrency: a site\'s SEO change and a member\'s indexing change of one group, at once, end in the final state (the group row serialises them)', async () => {
    expect(OWNER_URL, 'DATABASE_OWNER_URL is required').toBeDefined();
    const { en, ja, zh, groupId } = await group();
    const holder = postgres(OWNER_URL!, { max: 1, onnotice: () => {} });
    const watcher = postgres(OWNER_URL!, { max: 1, onnotice: () => {} });
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let held!: () => void;
    const holding = new Promise<void>((r) => (held = r));
    let holderPid = 0;
    try {
      // Another transaction holds the group row: both writers below reach the language-switch refresh and wait there.
      const hold = holder.begin(async (tx) => {
        holderPid = (await tx`SELECT pg_backend_pid() AS pid`)[0]!.pid as number;
        await tx`SELECT 1 FROM lumibase_translation_groups WHERE id = ${groupId} FOR UPDATE`;
        held();
        await released;
      });
      await holding;
      const seo = new SeoSettingsService({ db, siteId: fx.sites.b, actor: { userId: null } }).update({ version: 0, index: { site: false } });
      const noindex = robots('a', ja.id, 'noindex,follow');
      // Both waiting before the group row is released: B's SEO write on the group row (held here), A's item write on the
      // group row or on B's settings row (held by the SEO write) — both in the wait graph rooted at this holder, which
      // counts these two sessions only, nothing else running meanwhile.
      try {
        await waitingOn(watcher, holderPid, 2);
      } finally {
        release();
        await hold;
        await Promise.allSettled([seo, noindex]);
      }
      await Promise.all([seo, noindex]);
    } finally {
      release();
      await holder.end({ timeout: 1 });
      await watcher.end({ timeout: 1 });
    }
    // Final state: B not indexed (zh out), ja noindex — only en is listed, on en's page alone.
    expect(await alt('a', en.id)).toEqual([['en', URL_EN]]);
    expect(await alt('a', ja.id)).toEqual([]);
    expect(await alt('b', zh.id)).toEqual([]);
  });

  it('concurrency: SEO settings of two member sites at once both settle (a deadlock between their settings rows is retried, design R30)', async () => {
    const { en, zh } = await group();
    expect(OWNER_URL, 'DATABASE_OWNER_URL is required').toBeDefined();
    const update = (site: 'a' | 'b') => new SeoSettingsService({ db, siteId: fx.sites[site], actor: { userId: null } }).update({ version: 0, titleTemplate: `{title} · ${site}` });
    // Each write holds its site's settings row, then waits on its site's SEO lock — held here until both arrived: then each
    // site-wide refresh asks for the other's settings row (the group), a certain deadlock. The victim starts over (R30).
    const holder = postgres(OWNER_URL!, { max: 1, onnotice: () => {} });
    const watcher = postgres(OWNER_URL!, { max: 1, onnotice: () => {} });
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let held!: () => void;
    const holding = new Promise<void>((r) => (held = r));
    let holderPid = 0;
    try {
      const hold = holder.begin(async (tx) => {
        holderPid = (await tx`SELECT pg_backend_pid() AS pid`)[0]!.pid as number;
        for (const site of [fx.sites.a, fx.sites.b].sort()) await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`heopress:seo-settings:${site}`}, 0))`;
        held();
        await released;
      });
      await holding;
      const both = Promise.allSettled([update('a'), update('b')]);
      // Both writes blocked by this holder's advisory locks (so each already holds its own settings row), nothing else counted.
      await blockedBy(watcher, holderPid, 2);
      release();
      await hold;
      const results = await both;
      expect(results.map((r) => (r.status === 'rejected' ? String(r.reason) : r.status))).toEqual(['fulfilled', 'fulfilled']);
    } finally {
      release();
      await holder.end({ timeout: 1 });
      await watcher.end({ timeout: 1 });
    }
    for (const site of ['a', 'b'] as const) {
      const [s] = await db.select({ seo: publicSites.seo }).from(publicSites).where(eq(publicSites.siteId, fx.sites[site]));
      expect(s!.seo).toMatchObject({ titleTemplate: `{title} · ${site}` });
    }
    expect(await alt('a', en.id)).toEqual([['en', URL_EN], ['ja', URL_JA], ['zh-CN', URL_ZH]]);
    expect(await alt('b', zh.id)).toEqual([['en', URL_EN], ['ja', URL_JA], ['zh-CN', URL_ZH]]);
  });

  it('a domain deletion takes the site\'s settings row before the domain row, as a site deletion does (no lock cycle; Codex review of batch 4b)', async () => {
    expect(OWNER_URL, 'DATABASE_OWNER_URL is required').toBeDefined();
    const [extra] = await db.insert(siteDomains).values({ siteId: fx.sites.a, hostname: 'hl-extra.example.com', kind: 'custom', status: 'active', isPrimary: false, verifiedAt: new Date() }).returning();
    const holder = postgres(OWNER_URL!, { max: 1, onnotice: () => {} });
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let held!: () => void;
    const holding = new Promise<void>((r) => (held = r));
    let domainFree: boolean | null = null;
    let holderPid = 0;
    const watcher = postgres(OWNER_URL!, { max: 1, onnotice: () => {} });
    const headers = fx.headers('a', await fx.session('adminA', 'a'));
    try {
      const hold = holder.begin(async (tx) => {
        holderPid = (await tx`SELECT pg_backend_pid() AS pid`)[0]!.pid as number;
        await tx`SELECT set_config('app.site_id', ${fx.sites.a}, true)`;
        await tx`SELECT 1 FROM lumibase_site_content_settings WHERE site_id = ${fx.sites.a} FOR UPDATE`;
        held();
        await released;
        // The deletion waits for this row: it has not touched the domain row yet.
        domainFree = (await tx`SELECT 1 FROM lumibase_site_domains WHERE id = ${extra!.id} FOR UPDATE NOWAIT`).length === 1;
      });
      await holding;
      const del = app.request(`/api/v1/domains/${extra!.id}`, { method: 'DELETE', headers }, env);
      // The deletion is blocked by the holder (on the settings row) before the probe looks at the domain row.
      await blockedBy(watcher, holderPid, 1);
      release();
      await hold;
      expect((await del).status).toBe(204);
    } finally {
      release();
      await holder.end({ timeout: 1 });
      await watcher.end({ timeout: 1 });
    }
    expect(domainFree).toBe(true);
  });

  it.each([
    ['an item write (locks the group before writing)', 'item'],
    ["a site's SEO settings (reaches the group in the projection's refresh)", 'seo'],
    ['a publication date change (a write no service retry wraps: the transaction boundary itself starts it over)', 'publishedAt'],
  ] as const)('concurrency: a site joining the group while %s waits for it starts the write over — no deadlock with that site\'s settings writer', async (_label, kind) => {
    expect(OWNER_URL, 'DATABASE_OWNER_URL is required').toBeDefined();
    const en = await article('a', 'en-post', 'en');
    const ja = await article('a', 'ja-post', 'ja');
    const zh = await article('b', 'zh-post', 'zh-CN');
    const g = await groups().create(en.id);
    await groups().addMember(g.id, { itemId: ja.id, expectedVersion: g.version });
    const [zhColl] = await db.select({ id: collections.id }).from(collections).where(and(eq(collections.siteId, fx.sites.b), eq(collections.name, 'articles')));
    const conn = () => postgres(OWNER_URL!, { max: 1, onnotice: () => {} });
    const [joiner, writer, watcher] = [conn(), conn(), conn()];
    const gate = () => {
      let open!: () => void;
      const opened = new Promise<void>((r) => (open = r));
      return { open, opened };
    };
    const [joinHeld, commitJoin, writerHolds, endWriter] = [gate(), gate(), gate(), gate()];
    let joinerPid = 0;
    let writerPid = 0;
    // Until the session `pid` is (or is no longer) blocked by any other: exactly that session, nothing else running counts.
    const blocked = async (pid: number, yes: boolean) => {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const [w] = await watcher`SELECT cardinality(pg_blocking_pids(${pid}::int))::int AS n`;
        if (((w?.n ?? 0) > 0) === yes) return;
        if (Date.now() > deadline) throw new Error(`${pid} ${yes ? 'never blocked' : 'still blocked'}`);
        await new Promise((r) => setTimeout(r, 25));
      }
    };
    try {
      // 1. A join of site B: holds the group, B's member written, not yet committed.
      const join = joiner.begin(async (tx) => {
        joinerPid = (await tx`SELECT pg_backend_pid() AS pid`)[0]!.pid as number;
        await tx`SELECT 1 FROM lumibase_translation_groups WHERE id = ${g.id} FOR UPDATE`;
        await tx`UPDATE lumibase_translation_groups SET site_ids = ARRAY[${fx.sites.a}, ${fx.sites.b}], version = version + 1 WHERE id = ${g.id}`;
        await tx`INSERT INTO lumibase_translation_group_members (item_id, group_id, site_id, collection_id, locale, role) VALUES (${zh.id}, ${g.id}, ${fx.sites.b}, ${zhColl!.id}, 'zh-CN', 'translation')`;
        joinHeld.open();
        await commitJoin.opened;
      });
      await joinHeld.opened;
      // 2. A write of site A: it locks A's settings (the group's only site it saw) and waits for the group.
      const write =
        kind === 'item'
          ? robots('a', ja.id, 'noindex,follow')
          : kind === 'seo'
            ? new SeoSettingsService({ db, siteId: fx.sites.a, actor: { userId: null } }).update({ version: 0, titleTemplate: '{title} | {site}' })
            : versionOf(ja.id).then((v) => itemsOf('a').setPublishedAt('articles', ja.id, { publishedAt: new Date('2026-01-02T00:00:00Z'), expectedVersion: v }));
      // It waits for the join's group row (exactly that session; nothing else running counts).
      await blockedBy(watcher, joinerPid, 1);
      // 3. A writer of B's settings, as the content settings service is: B's settings exclusively, then the group (queued after the refresh).
      const settingsWriter = writer.begin(async (tx) => {
        writerPid = (await tx`SELECT pg_backend_pid() AS pid`)[0]!.pid as number;
        await tx`SELECT 1 FROM lumibase_site_content_settings WHERE site_id = ${fx.sites.b} FOR UPDATE`;
        writerHolds.open();
        await tx`SELECT 1 FROM lumibase_translation_groups WHERE id = ${g.id} FOR UPDATE`;
        await endWriter.opened;
      });
      await writerHolds.opened;
      // The settings writer waits for the group too (queued behind the write, which waits for the join).
      await blocked(writerPid, true);
      // 4. The join commits: the refresh gets the group first and finds B. Locking B's settings now would wait for the
      //    writer, which waits for the group — a deadlock. It starts over instead, releasing the group to the writer.
      //    Were it to deadlock, the writer is the one PostgreSQL gives up (it began waiting first, so its
      //    deadlock_timeout runs out first and it detects the cycle), and the writer is a bare connection that never
      //    retries: a deadlock shows as its 40P01, whatever retries the write itself has.
      commitJoin.open();
      await join;
      // The writer gets the group (only once the refresh let go of it) and finishes; the refresh's retry then completes.
      const writerDone = settingsWriter.then(() => 'ok', (e: { code?: string }) => e.code ?? String(e));
      await blocked(writerPid, false);
      endWriter.open();
      expect(await writerDone).toBe('ok');
      await write;
    } finally {
      commitJoin.open();
      endWriter.open();
      for (const c of [joiner, writer, watcher]) await c.end({ timeout: 1 });
    }
    // The join itself was written past the services: refresh the sites as the rebuild worker would.
    for (const site of [fx.sites.a, fx.sites.b]) await rebuildSiteProjection(db, site);
    if (kind === 'item') {
      expect(await alt('a', en.id)).toEqual([['en', URL_EN], ['zh-CN', URL_ZH]]);
      expect(await alt('a', ja.id)).toEqual([]);
    } else {
      expect(await alt('a', en.id)).toEqual([['en', URL_EN], ['ja', URL_JA], ['zh-CN', URL_ZH]]);
    }
    expect((await alt('b', zh.id)).map(([l]) => l)).toContain('zh-CN');
  });

  it('x-default: the foreign key itself clears it when the item row goes past the services (ON DELETE SET NULL)', async () => {
    expect(OWNER_URL, 'DATABASE_OWNER_URL is required').toBeDefined();
    const { en, groupId } = await group();
    await groups().setXDefault(groupId, en.id, (await groupRow(groupId)).version);
    const owner = postgres(OWNER_URL!, { max: 1, onnotice: () => {} });
    try {
      await owner.begin(async (tx) => {
        // The membership goes with the item (cascade); the x-default is left set until the item row is deleted.
        expect((await tx`SELECT x_default_item_id FROM lumibase_translation_groups WHERE id = ${groupId}`)[0]?.x_default_item_id).toBe(en.id);
        await tx`DELETE FROM lumibase_items WHERE id = ${en.id}`;
        expect((await tx`SELECT x_default_item_id FROM lumibase_translation_groups WHERE id = ${groupId}`)[0]?.x_default_item_id).toBeNull();
      });
    } finally {
      await owner.end({ timeout: 1 });
    }
  });

  it('migration 0056: sites with members get a background refresh mark — not maintenance — which the worker clears', async () => {
    expect(OWNER_URL, 'DATABASE_OWNER_URL is required').toBeDefined();
    await group();
    const owner = postgres(OWNER_URL!, { max: 1, onnotice: () => {} });
    const migration = readFileSync(path.resolve(__dirname, '../../../../packages/database/drizzle/0056_language_switch_refresh.sql'), 'utf8');
    const ours = () => db.select().from(projectionRebuilds).where(inArray(projectionRebuilds.siteId, [fx.sites.a, fx.sites.b]));
    expect(await ours()).toEqual([]);
    try {
      await owner.unsafe(migration);
      // Twice: one mark per site.
      await owner.unsafe(migration);
    } finally {
      await owner.end({ timeout: 1 });
    }
    const marks = await ours();
    expect(marks.map((m) => [m.siteId, m.reason]).sort()).toEqual([
      [fx.sites.a, 'refresh: language switch indexing'],
      [fx.sites.b, 'refresh: language switch indexing'],
    ].sort());
    // The rendering service keeps serving the sites meanwhile.
    for (const site of [fx.sites.a, fx.sites.b]) expect(await renderPort(db).request(site, (_p, reads) => reads.rebuilding())).toBe(false);
    expect(BACKGROUND_REFRESH_REASONS).toContain('refresh: language switch indexing');
    // A mark of any other reason is maintenance, as before — one that only looks like a refresh too (exact reasons, not a prefix).
    await db.insert(projectionRebuilds).values({ siteId: fx.sites.a, reason: 'refresh: something else' });
    expect(await renderPort(db).request(fx.sites.a, (_p, reads) => reads.rebuilding())).toBe(true);
    await db.insert(projectionRebuilds).values({ siteId: fx.sites.b, reason: 'test' });
    expect(await renderPort(db).request(fx.sites.b, (_p, reads) => reads.rebuilding())).toBe(true);
    // The worker's rebuild of each site clears its marks.
    for (const site of [fx.sites.a, fx.sites.b]) await rebuildSiteProjection(db, site);
    expect(await ours()).toEqual([]);
  });
});
