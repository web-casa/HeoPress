import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  auditLog,
  cdcChangeEvents,
  collections,
  fields,
  items,
  apiKeys,
  flows,
  permissions,
  policies,
  revisions,
  rolePolicies,
  translationBlockMap,
  roles,
  siteContentSettings,
  users,
  siteDomains,
  translationGroupMembers,
  translationGroups,
  userSites,
  type Database,
} from '@heopress/database';
import { createRuntime } from '@heopress/runtime/node';
import app from '../index';
import { setRuntimeFactory } from '../middleware/runtime';
import { ItemService } from '../services/item-service';
import { SchemaService } from '../services/schema-service';
import { PermissionService, __resetPermissionProcessCacheForTests } from '../services/permission-service';
import { sweepDuePublish } from '../services/scheduler-worker';
import { ContentSettingsService } from '../services/site-network/content-settings-service';
import { ensureContentSettings } from '../services/site-network/preset-installer';
import { resolvePublicPath } from '../services/site-network/public-path';
import { TranslationGroupService } from '../services/site-network/translation-group-service';
import { lockGroupsOf } from '../services/site-network/translation-groups';
import { MembershipChangedError, setBeforeCommitHook } from '../services/rls-transaction';
import { sites } from '@heopress/database';
import { deleteSite } from '../services/site-network/delete-site';
import { upgradeSitePreset } from '../services/site-network/preset-installer';
import { sharedFieldSyncConsumer } from '../services/site-network/shared-field-sync-consumer';
import { applyIntent } from '../services/site-network/shared-fields';
import { translationFreshnessConsumer } from '../services/site-network/freshness-consumer';
import { reconcileFreshness } from '../services/site-network/freshness';
import { htmlBlocks } from '../services/site-network/freshness-blocks';
import { notifications, sharedFieldSyncs } from '@heopress/database';
import type { ChangeEvent } from '../modules/events/consumer-runner';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { createCrossSiteFixture, type CrossSiteFixture } from './helpers/cross-site-fixture';

/**
 * Translation groups (HeoPress P05 tasks 4.1, 4.2, 4.4, 4.5; spec
 * i18n/translation-groups; design §0, D, R9, R18, R24): one published item
 * per language and group, on every publish path; cross-site members only
 * with both switches on; changes need edit permission on every site;
 * switching off hides the other site at once; an internal-only source is
 * never published nor public; the group's life cycle.
 */

const JWT_SECRET = 'translation-groups-secret';
const HOST = { a: 'tg-a.example.com', b: 'tg-b.example.com' } as const;

describe.skipIf(!hasDbIntegrationUrl)('translation groups — DB integration', () => {
  let db: Database;
  let fx: CrossSiteFixture;
  let env: Record<string, unknown> = {};
  let runtime: ReturnType<typeof createRuntime>;

  beforeAll(async () => {
    db = await connectDbIntegration('translation-groups');
    env = { ...process.env, JWT_SECRET, HEOPRESS_ENV: 'development' };
    runtime = createRuntime(env);
    setRuntimeFactory(() => runtime);
  });
  beforeEach(async () => {
    fx = await createCrossSiteFixture(db, { prefix: 'tgr', jwtSecret: JWT_SECRET });
    for (const site of ['a', 'b'] as const) {
      const siteId = fx.sites[site];
      await db.transaction((tx) => ensureContentSettings(tx as never, siteId));
      const [coll] = await db.select({ id: collections.id }).from(collections).where(and(eq(collections.siteId, siteId), eq(collections.name, 'articles')));
      await db.insert(fields).values({ siteId, collectionId: coll!.id, name: 'locale', type: 'string', interface: 'input' });
      await db.insert(siteDomains).values({ siteId, hostname: HOST[site], kind: 'custom', status: 'active', isPrimary: true, verifiedAt: new Date() });
      await settings(site, { availableLocales: ['en', 'zh-CN', 'pt', 'vi', 'he', 'ja'], localePrefixes: { 'zh-CN': 'zh' }, permalinks: { articles: '/:slug' } });
    }
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
  const article = (site: 'a' | 'b', slug: string, locale: string, status = 'draft') =>
    itemsOf(site).create('articles', { data: { title: `${slug} ${locale}`, slug, locale }, status }) as Promise<{ id: string; version: number }>;
  const versionOf = async (id: string) => (await db.select({ v: items.version }).from(items).where(eq(items.id, id)))[0]!.v;
  const publish = async (site: 'a' | 'b', id: string) => itemsOf(site).patch('articles', id, { status: 'published', expectedVersion: await versionOf(id) });
  /** The service as the system sees it (every item readable and writable). */
  const groups = (site: 'a' | 'b' = 'a') =>
    new TranslationGroupService({ db, siteId: fx.sites[site], actor: undefined, userId: null, itemsOn: (siteId, tx) => new ItemService({ db: tx as never, siteId }) });
  const groupVersion = async (id: string) => (await db.select({ v: translationGroups.version }).from(translationGroups).where(eq(translationGroups.id, id)))[0]!.v;
  const codeOf = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code ?? String(e));
  const call = (path: string, method: string, headers: Record<string, string>, body?: unknown) =>
    app.request(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env);
  const as = async (who: 'adminA' | 'onlyA' | 'both', site: 'a' | 'b' = 'a') => fx.headers(site, await fx.session(who, site));
  /** Membership changes as the membership routes make them: cached permissions of the site go stale. */
  const permissionsChanged = async (siteId: string) => {
    await PermissionService.bumpVersion(runtime.cache, siteId);
    __resetPermissionProcessCacheForTests();
  };
  /** Make a fixture user an editor of site B too. */
  const editorOfB = async (user: 'onlyA') => {
    const [role] = await db.select({ id: roles.id }).from(roles).where(and(eq(roles.siteId, fx.sites.b), eq(roles.name, 'Editor')));
    await db.insert(userSites).values({ userId: fx.users[user].id, siteId: fx.sites.b, roleId: role!.id });
    await permissionsChanged(fx.sites.b);
  };

  it('spec "同语言重复发布": one published item per language and group, on edit and scheduled publishing', async () => {
    const en = await article('a', 'post', 'en', 'published');
    const zh1 = await article('a', 'post-zh', 'zh-CN', 'published');
    const zh2 = await article('a', 'post-zh-2', 'zh-CN');
    const g = await groups().create(en.id);
    await groups().addMember(g.id, { itemId: zh1.id, expectedVersion: g.version });
    await groups().addMember(g.id, { itemId: zh2.id, expectedVersion: await groupVersion(g.id) });
    expect(await codeOf(publish('a', zh2.id))).toBe('LOCALE_ALREADY_PUBLISHED');
    // Scheduled publishing refuses it the same way, recorded per item.
    await db.update(items).set({ publishAt: new Date(Date.now() - 1000) }).where(eq(items.id, zh2.id));
    await sweepDuePublish({ db });
    expect((await db.select({ s: items.status }).from(items).where(eq(items.id, zh2.id)))[0]!.s).toBe('draft');
    const failures = await db.select().from(auditLog).where(and(eq(auditLog.siteId, fx.sites.a), eq(auditLog.event, 'scheduled_publish_failed')));
    expect(failures.map((f) => (f.metadata as { code: string }).code)).toEqual(['LOCALE_ALREADY_PUBLISHED']);
    // A published item cannot join with a language already published; a published member cannot switch into one.
    const zh3 = await article('a', 'post-zh-3', 'zh-CN', 'published');
    expect(await codeOf(groups().addMember(g.id, { itemId: zh3.id, expectedVersion: await groupVersion(g.id) }))).toBe('LOCALE_ALREADY_PUBLISHED');
    expect(await codeOf(itemsOf('a').patch('articles', en.id, { data: { locale: 'zh-CN' }, expectedVersion: await versionOf(en.id) }))).toBe('LOCALE_ALREADY_PUBLISHED');
    // Unpublishing frees the language.
    await itemsOf('a').patch('articles', zh1.id, { status: 'draft', expectedVersion: await versionOf(zh1.id) });
    expect(await codeOf(publish('a', zh2.id))).toBe('ok');
    // A member's language follows its item (the group records it).
    await itemsOf('a').patch('articles', zh1.id, { data: { locale: 'pt' }, expectedVersion: await versionOf(zh1.id) });
    expect((await db.select({ l: translationGroupMembers.locale }).from(translationGroupMembers).where(eq(translationGroupMembers.itemId, zh1.id)))[0]!.l).toBe('pt');
  });

  it('spec "语言切换指向实际译文" (task 3.2): links go to the actual translations; a language without a public one has none', async () => {
    const en = await article('a', 'switch', 'en', 'published');
    const zh = await article('a', 'switch-zh', 'zh-CN', 'published');
    const pt = await article('a', 'switch-pt', 'pt');
    const g = await groups().create(en.id);
    await groups().addMember(g.id, { itemId: zh.id, expectedVersion: g.version });
    await groups().addMember(g.id, { itemId: pt.id, expectedVersion: await groupVersion(g.id) });
    expect(await groups().alternates('articles', en.id)).toEqual([
      { locale: 'en', url: `https://${HOST.a}/switch/`, current: true, indexable: true },
      { locale: 'zh-CN', url: `https://${HOST.a}/zh/switch-zh/`, current: false, indexable: true },
    ]);
  });

  it('concurrent publishes of two same-language members: exactly one wins', async () => {
    const en = await article('a', 'race', 'en');
    const zh1 = await article('a', 'race-zh-1', 'zh-CN');
    const zh2 = await article('a', 'race-zh-2', 'zh-CN');
    const g = await groups().create(en.id);
    await groups().addMember(g.id, { itemId: zh1.id, expectedVersion: g.version });
    await groups().addMember(g.id, { itemId: zh2.id, expectedVersion: await groupVersion(g.id) });
    const results = await Promise.all([codeOf(publish('a', zh1.id)), codeOf(publish('a', zh2.id))]);
    expect(results.sort()).toEqual(['LOCALE_ALREADY_PUBLISHED', 'ok']);
  });

  it('a publish racing a join is checked against the group it joined (design R13)', async () => {
    const en = await article('a', 'race-join', 'en', 'published');
    const zh1 = await article('a', 'race-join-zh', 'zh-CN', 'published');
    const x = await article('a', 'race-join-x', 'zh-CN');
    const g = await groups().create(en.id);
    await groups().addMember(g.id, { itemId: zh1.id, expectedVersion: g.version });
    const v = await groupVersion(g.id);
    const xVersion = await versionOf(x.id);
    // Hold x's row: the join waits for it first (holding the group), then the publish (which saw no group yet).
    const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
    let add!: Promise<string>;
    let pub!: Promise<string>;
    /** Wait until `n` sessions wait on a lock (this one, or behind another waiter: a row lock queues on its first waiter). */
    const blocked = async (tx: postgres.TransactionSql, n: number) => {
      let waiting = 0;
      for (let i = 0; i < 200 && waiting < n; i++) {
        if (i > 0) await new Promise((ok) => setTimeout(ok, 25));
        const [r] = await tx`SELECT count(*)::int AS n FROM pg_stat_activity
                             WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'`;
        waiting = r!.n;
      }
      expect(waiting, 'sessions waiting on a lock').toBeGreaterThanOrEqual(n);
    };
    try {
      await sql.begin(async (tx) => {
        await tx`SELECT 1 FROM lumibase_items WHERE id = ${x.id} FOR UPDATE`;
        add = codeOf(groups().addMember(g.id, { itemId: x.id, expectedVersion: v }));
        await blocked(tx, 1);
        pub = codeOf(itemsOf('a').patch('articles', x.id, { status: 'published', expectedVersion: xVersion }));
        await blocked(tx, 2);
      });
    } finally {
      await sql.end({ timeout: 1 });
    }
    expect(await add).toBe('ok');
    expect(await pub).toBe('LOCALE_ALREADY_PUBLISHED');
    expect((await db.select({ s: items.status }).from(items).where(eq(items.id, x.id)))[0]!.s).toBe('draft');
  });

  it('spec "一方未开启" / "双方开启": cross-site members need both switches; the switch data then lists both', async () => {
    const en = await article('a', 'cross', 'en', 'published');
    const zh = await article('b', 'cross-zh', 'zh-CN', 'published');
    const g = await groups().create(en.id);
    await settings('a', { allowCrossSiteTranslations: true });
    const refused = await groups()
      .addMember(g.id, { siteId: fx.sites.b, itemId: zh.id, expectedVersion: g.version })
      .catch((e: { code: string; details?: { siteId: string } }) => e);
    expect(refused).toMatchObject({ code: 'CROSS_SITE_DISABLED', details: { siteId: fx.sites.b } });
    expect(await codeOf(groups().addMember(g.id, { siteId: fx.sites.b, itemId: zh.id, expectedVersion: g.version }))).toBe('CROSS_SITE_DISABLED');
    await settings('b', { allowCrossSiteTranslations: true });
    await groups().addMember(g.id, { siteId: fx.sites.b, itemId: zh.id, expectedVersion: g.version });
    expect(await groups('a').alternates('articles', en.id)).toEqual([
      { locale: 'en', url: `https://${HOST.a}/cross/`, current: true, indexable: true },
      { locale: 'zh-CN', url: `https://${HOST.b}/zh/cross-zh/`, current: false, indexable: true },
    ]);
    expect((await groups('b').alternates('articles', zh.id)).map((a) => [a.locale, a.current])).toEqual([
      ['en', false],
      ['zh-CN', true],
    ]);
    // One event per site, each with that site's members only.
    const events = await db.select().from(cdcChangeEvents).where(and(eq(cdcChangeEvents.resource, 'translation_group'), eq(cdcChangeEvents.itemId, g.id)));
    const last = new Map(events.map((e) => [e.siteId, e.payload as { members: string[] }]));
    expect(last.get(fx.sites.a)?.members).toEqual([en.id]);
    expect(last.get(fx.sites.b)?.members).toEqual([zh.id]);
  });

  it('spec "关闭开关": either site switching off hides the other at once; records stay; the other site never shows drafts', async () => {
    await settings('a', { allowCrossSiteTranslations: true });
    await settings('b', { allowCrossSiteTranslations: true });
    const en = await article('a', 'off', 'en', 'published');
    const zh = await article('b', 'off-zh', 'zh-CN', 'published');
    const vi = await article('b', 'off-vi', 'vi');
    const g = await groups().create(en.id);
    await groups().addMember(g.id, { siteId: fx.sites.b, itemId: zh.id, expectedVersion: g.version });
    await groups().addMember(g.id, { siteId: fx.sites.b, itemId: vi.id, expectedVersion: await groupVersion(g.id) });

    // An editor of A only: B's published member as the public sees it, B's draft not at all.
    const editorA = await as('onlyA');
    const seen = (await (await call(`/api/v1/translation-groups/${g.id}`, 'GET', editorA)).json()) as { data: { members: Array<{ itemId: string }>; public: unknown[] } };
    expect(seen.data.members.map((m) => m.itemId)).toEqual([en.id]);
    expect(seen.data.public).toEqual([{ locale: 'zh-CN', url: `https://${HOST.b}/zh/off-zh/` }]);
    expect(JSON.stringify(seen)).not.toContain(vi.id);

    const before = await db.select({ id: cdcChangeEvents.id }).from(cdcChangeEvents).where(eq(cdcChangeEvents.resource, 'translation_group'));
    await settings('b', { allowCrossSiteTranslations: false });
    expect((await groups('a').alternates('articles', en.id)).map((a) => a.locale)).toEqual(['en']);
    expect((await groups('b').alternates('articles', zh.id)).map((a) => a.locale)).toEqual(['zh-CN']);
    const after = (await (await call(`/api/v1/translation-groups/${g.id}`, 'GET', editorA)).json()) as { data: { public: unknown[] } };
    expect(after.data.public).toEqual([]);
    // Kept for the record, and announced to both sites (their caches drop the switch data).
    expect(await db.select().from(translationGroupMembers).where(eq(translationGroupMembers.groupId, g.id))).toHaveLength(3);
    const announced = await db.select().from(cdcChangeEvents).where(and(eq(cdcChangeEvents.resource, 'translation_group'), eq(cdcChangeEvents.itemId, g.id)));
    const fresh = announced.filter((e) => !before.some((b) => b.id === e.id));
    expect(new Set(fresh.map((e) => e.siteId))).toEqual(new Set([fx.sites.a, fx.sites.b]));
    // While it is off, nothing new joins across the sites.
    const pt = await article('b', 'off-pt', 'pt');
    expect(await codeOf(groups().addMember(g.id, { siteId: fx.sites.b, itemId: pt.id, expectedVersion: await groupVersion(g.id) }))).toBe('CROSS_SITE_DISABLED');
  });

  it('spec "只有一个站点的权限": changing a group needs edit permission on every site; API keys stay on their site', async () => {
    await settings('a', { allowCrossSiteTranslations: true });
    await settings('b', { allowCrossSiteTranslations: true });
    const en = await article('a', 'perm', 'en');
    const zh = await article('b', 'perm-zh', 'zh-CN');
    const editorA = await as('onlyA');
    const created = await call('/api/v1/translation-groups', 'POST', editorA, { itemId: en.id });
    expect(created.status, await created.clone().text()).toBe(201);
    const g = ((await created.json()) as { data: { id: string; version: number } }).data;
    const add = { siteId: fx.sites.b, itemId: zh.id, expectedVersion: g.version };
    // Editor of A only; editor of A and reader of B; A's API key: all refused, nothing written.
    expect((await call(`/api/v1/translation-groups/${g.id}/members`, 'POST', editorA, add)).status).toBe(403);
    expect((await call(`/api/v1/translation-groups/${g.id}/members`, 'POST', await as('both'), add)).status).toBe(403);
    expect((await call(`/api/v1/translation-groups/${g.id}/members`, 'POST', fx.headers('a', fx.apiKeys.aEditor.token), add)).status).toBe(403);
    expect(await db.select().from(translationGroupMembers).where(eq(translationGroupMembers.itemId, zh.id))).toEqual([]);
    // An editor of both sites may.
    await editorOfB('onlyA');
    const ok = await call(`/api/v1/translation-groups/${g.id}/members`, 'POST', await as('onlyA'), add);
    expect(ok.status, await ok.clone().text()).toBe(200);
    // From then on, an editor of A alone can no longer change the group (B's member is involved).
    await db.delete(userSites).where(and(eq(userSites.userId, fx.users.onlyA.id), eq(userSites.siteId, fx.sites.b)));
    await permissionsChanged(fx.sites.b);
    const v = await groupVersion(g.id);
    expect((await call(`/api/v1/translation-groups/${g.id}/members/${zh.id}?expectedVersion=${v}`, 'DELETE', await as('onlyA'))).status).toBe(403);
    // A reader cannot create a group.
    const other = await article('a', 'perm-2', 'en');
    expect((await call('/api/v1/translation-groups', 'POST', fx.headers('a', fx.apiKeys.aReader.token), { itemId: other.id })).status).toBe(403);
    // Site B's principals cannot see A's group (no member of theirs readable).
    expect((await call(`/api/v1/translation-groups/${g.id}`, 'GET', fx.headers('b', fx.apiKeys.bEditor.token))).status).toBe(200);
    const bView = (await (await call(`/api/v1/translation-groups/${g.id}`, 'GET', fx.headers('b', fx.apiKeys.bEditor.token))).json()) as { data: { members: Array<{ itemId: string }> } };
    expect(bView.data.members.map((m) => m.itemId)).toEqual([zh.id]);
  });

  it('spec "英文原文只做内部来源" / "尝试发布仅内部条目": the internal-only source is never published nor public', async () => {
    const en = await article('a', 'only-source', 'en');
    const zh = await article('a', 'only-source-zh', 'zh-CN', 'published');
    const pt = await article('a', 'only-source-pt', 'pt', 'published');
    const vi = await article('a', 'only-source-vi', 'vi', 'published');
    const g = await groups().create(en.id);
    for (const m of [zh, pt, vi]) await groups().addMember(g.id, { itemId: m.id, expectedVersion: await groupVersion(g.id) });
    // Only the source, and only while unpublished.
    expect(await codeOf(groups().setInternalOnly(g.id, zh.id, true, await groupVersion(g.id)))).toBe('SOURCE_ONLY');
    await groups().setInternalOnly(g.id, en.id, true, await groupVersion(g.id));
    expect(await codeOf(publish('a', en.id))).toBe('INTERNAL_ONLY');
    await db.update(items).set({ publishAt: new Date(Date.now() - 1000) }).where(eq(items.id, en.id));
    await sweepDuePublish({ db });
    expect((await db.select({ s: items.status }).from(items).where(eq(items.id, en.id)))[0]!.s).toBe('draft');
    // The switch data has the three published languages; the English path is not found.
    expect((await groups().alternates('articles', zh.id)).map((a) => a.locale).sort()).toEqual(['pt', 'vi', 'zh-CN']);
    expect((await resolvePublicPath(db, { host: HOST.a, path: '/only-source/' })).kind).toBe('not_found');
    // Changing the source needs the mark cleared first; a published source cannot be marked.
    expect(await codeOf(groups().setSource(g.id, zh.id, await groupVersion(g.id)))).toBe('CLEAR_INTERNAL_FIRST');
    await groups().setInternalOnly(g.id, en.id, false, await groupVersion(g.id));
    await publish('a', en.id);
    expect(await codeOf(groups().setInternalOnly(g.id, en.id, true, await groupVersion(g.id)))).toBe('UNPUBLISH_FIRST');
  });

  it('a member without a language of its own follows the site default; a clash with a published language refuses the change', async () => {
    const en = await article('a', 'default-lang', 'en', 'published');
    const plain = (await itemsOf('a').create('articles', { data: { title: 'no locale', slug: 'default-lang-2' }, status: 'published' })) as { id: string };
    const pt = await article('a', 'default-lang-pt', 'pt', 'published');
    const g = await groups().create(en.id);
    // No locale of its own and the default is English (taken): it cannot join while published.
    expect(await codeOf(groups().addMember(g.id, { itemId: plain.id, expectedVersion: g.version }))).toBe('LOCALE_ALREADY_PUBLISHED');
    await itemsOf('a').patch('articles', plain.id, { status: 'draft', expectedVersion: await versionOf(plain.id) });
    await groups().addMember(g.id, { itemId: plain.id, expectedVersion: g.version });
    await groups().addMember(g.id, { itemId: pt.id, expectedVersion: await groupVersion(g.id) });
    const site = new ContentSettingsService({ db, siteId: fx.sites.a, actor: { userId: null } });
    await site.updateSite({ defaultLanguage: 'vi' });
    const localeOf = async (id: string) => (await db.select({ l: translationGroupMembers.locale }).from(translationGroupMembers).where(eq(translationGroupMembers.itemId, id)))[0]!.l;
    expect(await localeOf(plain.id)).toBe('vi');
    await publish('a', plain.id);
    // Published in Vietnamese now; a default of Portuguese would give the group two published pt versions.
    expect(await codeOf(site.updateSite({ defaultLanguage: 'pt' }))).toBe('LOCALE_ALREADY_PUBLISHED');
    expect(await localeOf(plain.id)).toBe('vi');
  });

  it('another site\'s item: one 403 whether it exists, is grouped or not (no existence oracle)', async () => {
    await settings('a', { allowCrossSiteTranslations: true });
    await settings('b', { allowCrossSiteTranslations: true });
    const en = await article('a', 'oracle', 'en');
    const free = await article('b', 'oracle-free', 'zh-CN');
    const grouped = await article('b', 'oracle-grouped', 'pt');
    await groups('b').create(grouped.id);
    const deleted = await article('b', 'oracle-deleted', 'vi');
    await itemsOf('b').softDelete('articles', deleted.id);
    const g = await groups().create(en.id);
    for (const headers of [await as('onlyA'), fx.headers('a', fx.apiKeys.aEditor.token)]) {
      const answers = [];
      for (const itemId of [free.id, grouped.id, deleted.id, 'no-such-item']) {
        const res = await call(`/api/v1/translation-groups/${g.id}/members`, 'POST', headers, { siteId: fx.sites.b, itemId, expectedVersion: g.version });
        answers.push([res.status, ((await res.json()) as { errors: Array<{ code: string }> }).errors[0]!.code]);
      }
      expect(new Set(answers.map((a) => JSON.stringify(a)))).toEqual(new Set([JSON.stringify([403, 'FORBIDDEN'])]));
    }
  });

  it('languages are compared in canonical form, read in the item\'s own site (he / iw)', async () => {
    await settings('a', { allowCrossSiteTranslations: true });
    await settings('b', { allowCrossSiteTranslations: true });
    const he = await article('a', 'canon', 'he', 'published');
    const iw = await article('b', 'canon-iw', 'iw', 'published');
    const g = await groups().create(he.id);
    expect(await codeOf(groups().addMember(g.id, { siteId: fx.sites.b, itemId: iw.id, expectedVersion: g.version }))).toBe('LOCALE_ALREADY_PUBLISHED');
  });

  it('a deleted member holds no language when the default language moves', async () => {
    const plain = (await itemsOf('a').create('articles', { data: { title: 'deleted plain', slug: 'deleted-plain' }, status: 'draft' })) as { id: string };
    const src = await article('a', 'deleted-src', 'vi');
    const pt = await article('a', 'deleted-pt', 'pt', 'published');
    const g = await groups().create(src.id);
    await groups().addMember(g.id, { itemId: plain.id, expectedVersion: g.version });
    await groups().addMember(g.id, { itemId: pt.id, expectedVersion: await groupVersion(g.id) });
    await publish('a', plain.id);
    await itemsOf('a').softDelete('articles', plain.id);
    await new ContentSettingsService({ db, siteId: fx.sites.a, actor: { userId: null } }).updateSite({ defaultLanguage: 'pt' });
    expect((await db.select({ l: translationGroupMembers.locale }).from(translationGroupMembers).where(eq(translationGroupMembers.itemId, plain.id)))[0]!.l).toBe('pt');
  });

  it('a transaction over many items takes their groups in ID order (design §0)', async () => {
    const [x, y] = [await article('a', 'order-x', 'en'), await article('a', 'order-y', 'en')];
    const gx = await groups().create(x.id);
    const gy = await groups().create(y.id);
    const [low, high] = [gx.id, gy.id].sort() as [string, string];
    const lowItem = low === gx.id ? x.id : y.id;
    const highItem = low === gx.id ? y.id : x.id;
    const blocker = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
    const probe = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
    try {
      let locking!: Promise<unknown>;
      await blocker.begin(async (tx) => {
        await tx`SELECT 1 FROM lumibase_translation_groups WHERE id = ${low} FOR UPDATE`;
        // Items given high first: the lower group is still taken first, so the higher one stays free meanwhile.
        locking = db.transaction((t) => lockGroupsOf(t as never, fx.sites.a, [highItem, lowItem]));
        for (let i = 0; i < 40; i++) await new Promise((ok) => setTimeout(ok, 25));
        const free = await probe.begin((p) => p`SELECT 1 FROM lumibase_translation_groups WHERE id = ${high} FOR UPDATE NOWAIT`.then(() => true, () => false));
        expect(free).toBe(true);
      });
      await locking;
    } finally {
      await blocker.end({ timeout: 1 });
      await probe.end({ timeout: 1 });
    }
  });

  it('a group changed and then dissolved in one transaction commits (R44)', async () => {
    const a = await article('a', 'one-tx-a', 'en');
    const b = await article('a', 'one-tx-b', 'pt');
    const g = await groups().create(a.id);
    await groups().addMember(g.id, { itemId: b.id, expectedVersion: g.version });
    await db.transaction(async (tx) => {
      const svc = new ItemService({ db: tx as never, siteId: fx.sites.a });
      await svc.hardDelete('articles', b.id);
      await svc.hardDelete('articles', a.id);
    });
    expect(await db.select().from(translationGroups).where(eq(translationGroups.id, g.id))).toEqual([]);
  });

  it('a batch holds its items: a join of one of them waits until the batch ends (R44)', async () => {
    const x = await article('a', 'batch-x', 'en');
    const y = await article('a', 'batch-y', 'pt');
    const other = await article('a', 'batch-other', 'vi');
    await groups().create(x.id);
    const g1 = await groups().create(other.id);
    let join!: Promise<string>;
    let settled = false;
    await db.transaction(async (tx) => {
      await lockGroupsOf(tx as never, fx.sites.a, [x.id, y.id]);
      join = codeOf(groups().addMember(g1.id, { itemId: y.id, expectedVersion: g1.version })).finally(() => {
        settled = true;
      });
      for (let i = 0; i < 12; i++) await new Promise((ok) => setTimeout(ok, 25));
      expect(settled).toBe(false);
      const svc = new ItemService({ db: tx as never, siteId: fx.sites.a });
      await svc.hardDelete('articles', y.id);
      await svc.hardDelete('articles', x.id);
    });
    expect(await join).toBe('NOT_FOUND');
  });

  it('deleting a collection or a site takes its items out of other sites\' groups (R44)', async () => {
    await settings('a', { allowCrossSiteTranslations: true });
    await settings('b', { allowCrossSiteTranslations: true });
    const en = await article('a', 'leave', 'en');
    const zh = await article('b', 'leave-zh', 'zh-CN');
    const g = await groups().create(en.id);
    await groups().addMember(g.id, { siteId: fx.sites.b, itemId: zh.id, expectedVersion: g.version });
    await new SchemaService({ db, siteId: fx.sites.b }).deleteCollection('articles');
    expect((await db.select({ s: translationGroups.siteIds }).from(translationGroups).where(eq(translationGroups.id, g.id)))[0]!.s).toEqual([fx.sites.a]);

  });

  it('deleting a site takes its items out of other sites\' groups (R44)', async () => {
    await settings('a', { allowCrossSiteTranslations: true });
    await settings('b', { allowCrossSiteTranslations: true });
    const en = await article('a', 'leave-site', 'en');
    const zh = await article('b', 'leave-site-zh', 'zh-CN');
    const g = await groups().create(en.id);
    await groups().addMember(g.id, { siteId: fx.sites.b, itemId: zh.id, expectedVersion: g.version });
    await deleteSite(db, fx.sites.b);
    expect(await db.select().from(sites).where(eq(sites.id, fx.sites.b))).toEqual([]);
    expect((await db.select({ s: translationGroups.siteIds }).from(translationGroups).where(eq(translationGroups.id, g.id)))[0]!.s).toEqual([fx.sites.a]);
    // The group's own site deleted: the group goes with it. (Another site stays: the last site is never deleted.)
    const keeper = `${fx.sites.a}_keeper`;
    await db.insert(sites).values({ id: keeper, name: 'Keeper' }).onConflictDoNothing();
    try {
      expect((await deleteSite(db, fx.sites.a)).outcome).toBe('deleted');
    } finally {
      await db.delete(sites).where(eq(sites.id, keeper));
    }
    expect(await db.select().from(translationGroups).where(eq(translationGroups.id, g.id))).toEqual([]);
  });

  for (const what of ['collection', 'site'] as const) {
    it(`deleting a ${what} waits for a join of its items already under way, then releases it (R46)`, async () => {
      await settings('a', { allowCrossSiteTranslations: true });
      await settings('b', { allowCrossSiteTranslations: true });
      const en = await article('a', `race-del-${what}`, 'en');
      const y = await article('b', `race-del-${what}-y`, 'zh-CN');
      const g = await groups().create(en.id);
      const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
      const waiting = async (tx: postgres.TransactionSql, n: number) => {
        let w = 0;
        for (let i = 0; i < 200 && w < n; i++) {
          if (i > 0) await new Promise((ok) => setTimeout(ok, 25));
          const [r] = await tx`SELECT count(*)::int AS n FROM pg_stat_activity
                               WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'`;
          w = r!.n;
        }
        expect(w, 'sessions waiting on a lock').toBeGreaterThanOrEqual(n);
      };
      let join!: Promise<string>;
      let removal!: Promise<string>;
      try {
        await sql.begin(async (tx) => {
          // The group is busy: the join (holding B's settings row FOR SHARE) waits for it; the deletion waits for the join.
          await tx`SELECT 1 FROM lumibase_translation_groups WHERE id = ${g.id} FOR UPDATE`;
          join = codeOf(groups().addMember(g.id, { siteId: fx.sites.b, itemId: y.id, expectedVersion: g.version }));
          await waiting(tx, 1);
          removal = codeOf(what === 'site' ? deleteSite(db, fx.sites.b) : new SchemaService({ db, siteId: fx.sites.b }).deleteCollection('articles'));
          await waiting(tx, 2);
        });
      } finally {
        await sql.end({ timeout: 1 });
      }
      expect([await join, await removal]).toEqual(['ok', 'ok']);
      expect((await db.select({ s: translationGroups.siteIds }).from(translationGroups).where(eq(translationGroups.id, g.id)))[0]!.s).toEqual([fx.sites.a]);
    });
  }

  it('releasing many members of one group writes the group once (R46)', async () => {
    const src = await article('a', 'many-src', 'en');
    const g = await groups().create(src.id);
    await settings('a', { allowCrossSiteTranslations: true });
    await settings('b', { allowCrossSiteTranslations: true });
    for (let i = 0; i < 4; i++) {
      const m = await article('b', `many-${i}`, 'pt');
      await groups().addMember(g.id, { siteId: fx.sites.b, itemId: m.id, expectedVersion: await groupVersion(g.id) });
    }
    const before = await groupVersion(g.id);
    await deleteSite(db, fx.sites.b);
    expect(await groupVersion(g.id)).toBe(before + 1);
  });

  describe('shared fields (task 4.6)', () => {
    /** Declare `version_number` shared in both sites' articles. */
    const declareShared = async () => {
      for (const site of ['a', 'b'] as const) {
        const siteId = fx.sites[site];
        const [coll] = await db.select({ id: collections.id, meta: collections.meta }).from(collections).where(and(eq(collections.siteId, siteId), eq(collections.name, 'articles')));
        await db.update(collections).set({ meta: { ...((coll!.meta as object) ?? {}), sharedFields: ['version_number'] } }).where(eq(collections.id, coll!.id));
        await db.insert(fields).values({ siteId, collectionId: coll!.id, name: 'version_number', type: 'string', interface: 'input' });
      }
    };
    const consumer = () => sharedFieldSyncConsumer({ db });
    const deliver = (resource: 'item' | 'translation_group', itemId: string) =>
      consumer().handle!({ id: `ev_${itemId}`, siteId: fx.sites.a, resource, collection: 'articles', itemId, operation: 'update', payload: null, changedFields: null, itemVersion: null, actorType: 'user', actorId: null, source: 'api', occurredAt: new Date(), txid: '1', seq: 1 } as ChangeEvent, { idempotencyKey: 'k', attempt: 1 });
    const valueOf = async (id: string) => ((await db.select({ d: items.data }).from(items).where(eq(items.id, id)))[0]!.d as { version_number?: string }).version_number;
    const intentsOf = (id: string) => db.select().from(sharedFieldSyncs).where(eq(sharedFieldSyncs.targetItemId, id));
    const asUser = (site: 'a' | 'b', userId: string) =>
      new ItemService({ db, siteId: fx.sites[site], userId, cdcActor: { type: 'user', id: userId }, permissionCtx: { userId, siteId: fx.sites[site], roleId: null, user: { id: userId, email: null, roles: [] }, ip: null, headers: {}, apiKey: null, principal: 'user' } });
    const setSharedOnSource = async (site: 'a' | 'b', id: string, v: string, svc = itemsOf(site)) =>
      svc.patch('articles', id, { data: { version_number: v }, expectedVersion: await versionOf(id) });

    it('spec "修改版本号": the source\'s change reaches every member, each with a new version; redelivery applies once', async () => {
      await declareShared();
      const en = await article('a', 'tool', 'en');
      const zh = await article('a', 'tool-zh', 'zh-CN');
      const ja = await article('a', 'tool-ja', 'pt');
      const g = await groups().create(en.id);
      await groups().addMember(g.id, { itemId: zh.id, expectedVersion: g.version });
      await groups().addMember(g.id, { itemId: ja.id, expectedVersion: await groupVersion(g.id) });
      const before = [await versionOf(zh.id), await versionOf(ja.id)];
      await setSharedOnSource('a', en.id, '2.1.0', asUser('a', fx.users.onlyA.id));
      await deliver('item', en.id);
      await deliver('item', en.id);
      expect([await valueOf(zh.id), await valueOf(ja.id)]).toEqual(['2.1.0', '2.1.0']);
      expect([await versionOf(zh.id), await versionOf(ja.id)]).toEqual(before.map((v) => v + 1));
      expect((await intentsOf(zh.id)).map((i) => i.status)).toEqual(['applied']);
    });

    it('spec "在译文中修改共享字段": a translation cannot change it; other fields it can', async () => {
      await declareShared();
      const en = await article('a', 'own', 'en');
      const zh = await article('a', 'own-zh', 'zh-CN');
      const g = await groups().create(en.id);
      await groups().addMember(g.id, { itemId: zh.id, expectedVersion: g.version });
      expect(await codeOf(setSharedOnSource('a', zh.id, '9.9'))).toBe('SHARED_FIELD_FROM_SOURCE');
      expect(await codeOf(itemsOf('a').patch('articles', zh.id, { data: { title: 'zh title' }, expectedVersion: await versionOf(zh.id) }))).toBe('ok');
    });

    it('spec "对部分成员站点没有权限": the other site\'s member waits, its editors are told once, one of them applies it', async () => {
      await declareShared();
      await settings('a', { allowCrossSiteTranslations: true });
      await settings('b', { allowCrossSiteTranslations: true });
      const en = await article('a', 'partial', 'en');
      const zhA = await article('a', 'partial-zh', 'zh-CN');
      const ptB = await article('b', 'partial-pt', 'pt');
      const g = await groups().create(en.id);
      await groups().addMember(g.id, { itemId: zhA.id, expectedVersion: g.version });
      await groups().addMember(g.id, { siteId: fx.sites.b, itemId: ptB.id, expectedVersion: await groupVersion(g.id) });
      const ptVersion = await versionOf(ptB.id);
      // An editor of A only saves the source: the save succeeds whatever happens next.
      await setSharedOnSource('a', en.id, '3.0', asUser('a', fx.users.onlyA.id));
      await deliver('item', en.id);
      await deliver('item', en.id);
      expect(await valueOf(zhA.id)).toBe('3.0');
      expect(await valueOf(ptB.id)).toBeUndefined();
      expect(await versionOf(ptB.id)).toBe(ptVersion);
      expect((await intentsOf(ptB.id)).map((i) => i.status)).toEqual(['blocked_permission']);
      const told = await db.select().from(notifications).where(and(eq(notifications.siteId, fx.sites.b), eq(notifications.item, ptB.id)));
      expect(told.map((n) => n.recipient).sort()).toEqual([fx.users.adminB.id, fx.users.onlyB.id].sort());
      // The group view marks it; B's editor applies it as themselves.
      const view = (await (await call(`/api/v1/translation-groups/${g.id}`, 'GET', fx.headers('b', await fx.session('onlyB', 'b')))).json()) as { data: { members: Array<{ itemId: string; sharedSync: unknown }> } };
      expect(view.data.members.find((m) => m.itemId === ptB.id)?.sharedSync).toEqual({ status: 'blocked_permission', fields: ['version_number'] });
      const applied = await call(`/api/v1/translation-groups/${g.id}/members/${ptB.id}/apply-shared`, 'POST', fx.headers('b', await fx.session('onlyB', 'b')));
      expect(applied.status, await applied.clone().text()).toBe(200);
      expect(await valueOf(ptB.id)).toBe('3.0');
      expect((await intentsOf(ptB.id))[0]).toMatchObject({ status: 'applied', resolvedBy: fx.users.onlyB.id });
    });

    it('a trigger whose permission was revoked before the sync is blocked (permissions at sync time)', async () => {
      await declareShared();
      await settings('a', { allowCrossSiteTranslations: true });
      await settings('b', { allowCrossSiteTranslations: true });
      await editorOfB('onlyA');
      const en = await article('a', 'revoked', 'en');
      const ptB = await article('b', 'revoked-pt', 'pt');
      const g = await groups().create(en.id);
      await groups().addMember(g.id, { siteId: fx.sites.b, itemId: ptB.id, expectedVersion: g.version });
      await setSharedOnSource('a', en.id, '4.0', asUser('a', fx.users.onlyA.id));
      await db.delete(userSites).where(and(eq(userSites.userId, fx.users.onlyA.id), eq(userSites.siteId, fx.sites.b)));
      await permissionsChanged(fx.sites.b);
      await deliver('item', en.id);
      expect((await intentsOf(ptB.id)).map((i) => i.status)).toEqual(['blocked_permission']);
      expect(await valueOf(ptB.id)).toBeUndefined();
    });

    it('Hold: a held published member is not changed (nor published); a held draft takes the value and stays a draft', async () => {
      await declareShared();
      const en = await article('a', 'held', 'en');
      const live = await article('a', 'held-live', 'zh-CN', 'published');
      const draft = await article('a', 'held-draft', 'pt');
      const g = await groups().create(en.id);
      await groups().addMember(g.id, { itemId: live.id, expectedVersion: g.version });
      await groups().addMember(g.id, { itemId: draft.id, expectedVersion: await groupVersion(g.id) });
      await db.update(items).set({ hold: true }).where(inArray(items.id, [live.id, draft.id]));
      await setSharedOnSource('a', en.id, '5.0');
      await deliver('item', en.id);
      expect((await intentsOf(live.id)).map((i) => i.status)).toEqual(['blocked_hold']);
      expect(await valueOf(live.id)).toBeUndefined();
      expect(await valueOf(draft.id)).toBe('5.0');
      expect((await db.select({ s: items.status }).from(items).where(eq(items.id, draft.id)))[0]!.s).toBe('draft');
    });

    it('spec "源条目被删除": no source freezes shared fields; a new source re-syncs the members that differ (new epoch)', async () => {
      await declareShared();
      const en = await article('a', 'frozen', 'en');
      const zh = await article('a', 'frozen-zh', 'zh-CN');
      const pt = await article('a', 'frozen-pt', 'pt');
      const g = await groups().create(en.id);
      await groups().addMember(g.id, { itemId: zh.id, expectedVersion: g.version });
      await groups().addMember(g.id, { itemId: pt.id, expectedVersion: await groupVersion(g.id) });
      await setSharedOnSource('a', en.id, '1.0');
      await deliver('item', en.id);
      await itemsOf('a').softDelete('articles', en.id);
      expect(await codeOf(setSharedOnSource('a', zh.id, '1.1'))).toBe('SHARED_FIELD_FROM_SOURCE');
      // The new source has its own value once it is the source; pt differs and follows it.
      const view = await groups().setSource(g.id, zh.id, await groupVersion(g.id));
      expect(view.sourceEpoch).toBe(2);
      await setSharedOnSource('a', zh.id, '1.1');
      await deliver('item', zh.id);
      expect(await valueOf(pt.id)).toBe('1.1');
      // Back to the old epoch's intents: a replayed old event changes nothing.
      await deliver('item', en.id);
      expect(await valueOf(pt.id)).toBe('1.1');
    });

    it('an intent is applied once, and only under the epoch it was written in (design R4, R24)', async () => {
      await declareShared();
      const en = await article('a', 'guard', 'en');
      const zh = await article('a', 'guard-zh', 'zh-CN');
      const pt = await article('a', 'guard-pt', 'pt');
      const g = await groups().create(en.id);
      await groups().addMember(g.id, { itemId: zh.id, expectedVersion: g.version });
      await groups().addMember(g.id, { itemId: pt.id, expectedVersion: await groupVersion(g.id) });
      await setSharedOnSource('a', en.id, '8.0');
      // A source epoch that moved on (a source set and set back) makes a pending intent stale.
      await db.update(translationGroups).set({ sourceEpoch: sql`${translationGroups.sourceEpoch} + 1` }).where(eq(translationGroups.id, g.id));
      const [stale] = await intentsOf(zh.id);
      const outcome = await applyIntent(db, stale!.id, fx.sites.a, { writer: async (_i, tx) => new ItemService({ db: tx as never, siteId: fx.sites.a }), person: async () => null }, { accept: ['pending'] });
      expect(outcome).toBe('superseded');
      expect(await valueOf(zh.id)).toBeUndefined();
      // An applied intent is never applied again, even if the member drifted since.
      await db.update(translationGroups).set({ sourceEpoch: sql`${translationGroups.sourceEpoch} - 1` }).where(eq(translationGroups.id, g.id));
      const [fresh] = await intentsOf(pt.id);
      expect(await applyIntent(db, fresh!.id, fx.sites.a, { writer: async (_i, tx) => new ItemService({ db: tx as never, siteId: fx.sites.a }), person: async () => null }, { accept: ['pending'] })).toBe('applied');
      await db.update(items).set({ data: sql`jsonb_set(${items.data}, '{version_number}', '"drifted"')` }).where(eq(items.id, pt.id));
      expect(await applyIntent(db, fresh!.id, fx.sites.a, { writer: async (_i, tx) => new ItemService({ db: tx as never, siteId: fx.sites.a }), person: async () => null }, { accept: ['pending'] })).toBe('skipped');
      expect(await valueOf(pt.id)).toBe('drifted');
    });

    it('work after the write runs once, for the attempt that committed: a rolled-back attempt leaves none (P07, Codex review of batch 4a)', async () => {
      await declareShared();
      const en = await article('a', 'once', 'en');
      const zh = await article('a', 'once-zh', 'zh-CN');
      const g = await groups().create(en.id);
      await groups().addMember(g.id, { itemId: zh.id, expectedVersion: g.version });
      await setSharedOnSource('a', en.id, '3.0');
      const [intent] = await intentsOf(zh.id);
      const after = vi.spyOn(ItemService.prototype as unknown as { afterUpdateWork: () => Promise<void> }, 'afterUpdateWork');
      // The first attempt is given up at its very end — the outer transaction's flush, the second call (the first ends the
      // write's own savepoint) — after the write queued its work: the transaction starts over.
      let calls = 0;
      let failed = false;
      const flush = setBeforeCommitHook(null);
      setBeforeCommitHook(async (tx) => {
        if (++calls === 2) {
          failed = true;
          throw new MembershipChangedError();
        }
        await flush?.(tx);
      });
      try {
        const outcome = await applyIntent(db, intent!.id, fx.sites.a, { writer: async (_i, tx) => new ItemService({ db: tx as never, rootDb: db, siteId: fx.sites.a }), person: async () => null }, { accept: ['pending'] });
        expect(outcome).toBe('applied');
      } finally {
        setBeforeCommitHook(flush);
      }
      expect(failed).toBe(true);
      expect(after).toHaveBeenCalledTimes(1);
      after.mockRestore();
      expect(await valueOf(zh.id)).toBe('3.0');
    });

    it('the work after a committed write is never repeated: its own transaction does not retry (P07, Codex review of batch 4a)', async () => {
      await declareShared();
      const en = await article('a', 'no-replay', 'en');
      const zh = await article('a', 'no-replay-zh', 'zh-CN');
      const g = await groups().create(en.id);
      await groups().addMember(g.id, { itemId: zh.id, expectedVersion: g.version });
      await setSharedOnSource('a', en.id, '4.0');
      const [intent] = await intentsOf(zh.id);
      const realtime = vi.spyOn(ItemService.prototype as unknown as { publishRealtimeEvent: () => Promise<void> }, 'publishRealtimeEvent');
      // The write's own savepoint (1st) and transaction (2nd) commit; the transaction of the work after it (3rd on) is
      // given up at its end, every time — after the realtime event went out.
      let calls = 0;
      const flush = setBeforeCommitHook(null);
      setBeforeCommitHook(async (tx) => {
        if (++calls >= 3) throw new MembershipChangedError();
        await flush?.(tx);
      });
      try {
        const outcome = await applyIntent(db, intent!.id, fx.sites.a, { writer: async (_i, tx) => new ItemService({ db: tx as never, rootDb: db, siteId: fx.sites.a }), person: async () => null }, { accept: ['pending'] });
        expect(outcome).toBe('applied');
      } finally {
        setBeforeCommitHook(flush);
      }
      expect(calls).toBe(3);
      expect(realtime).toHaveBeenCalledTimes(1);
      realtime.mockRestore();
      expect(await valueOf(zh.id)).toBe('4.0');
    });

    it('a trigger that is no longer valid writes nothing: revoked key, deactivated person (P1)', async () => {
      await declareShared();
      const en = await article('a', 'invalid', 'en');
      const zh = await article('a', 'invalid-zh', 'zh-CN');
      const g = await groups().create(en.id);
      await groups().addMember(g.id, { itemId: zh.id, expectedVersion: g.version });
      // A key of the site saves the source, then is revoked before the sync.
      const keySvc = new ItemService({ db, siteId: fx.sites.a, cdcActor: { type: 'api_key', id: fx.apiKeys.aEditor.id }, permissionCtx: { userId: null, siteId: fx.sites.a, roleId: null, user: null, ip: null, headers: {}, apiKey: { id: fx.apiKeys.aEditor.id }, principal: 'api_key' } });
      await setSharedOnSource('a', en.id, 'k1', keySvc);
      await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, fx.apiKeys.aEditor.id));
      await deliver('item', en.id);
      expect((await intentsOf(zh.id)).map((i) => i.status)).toEqual(['blocked_permission']);
      // A person deactivated after saving.
      await setSharedOnSource('a', en.id, 'u1', asUser('a', fx.users.onlyA.id));
      await db.update(users).set({ status: 'suspended' }).where(eq(users.id, fx.users.onlyA.id));
      await deliver('item', en.id);
      expect(await valueOf(zh.id)).toBeUndefined();
      expect((await intentsOf(zh.id)).find((i) => i.values.version_number === 'u1')?.status).toBe('blocked_permission');
    });

    it('a member removed while its sync waits, then added back, still gets the source\'s values', async () => {
      await declareShared();
      const en = await article('a', 'rejoin', 'en');
      const zh = await article('a', 'rejoin-zh', 'zh-CN');
      const g = await groups().create(en.id);
      await groups().addMember(g.id, { itemId: zh.id, expectedVersion: g.version });
      await setSharedOnSource('a', en.id, '6.0');
      await groups().removeMember(g.id, zh.id, await groupVersion(g.id));
      expect(await intentsOf(zh.id)).toEqual([]);
      await groups().addMember(g.id, { itemId: zh.id, expectedVersion: await groupVersion(g.id) });
      await deliver('translation_group', g.id);
      expect(await valueOf(zh.id)).toBe('6.0');
    });

    it('notifications only to those who could apply it (row rules); apply-shared tells nothing before permission', async () => {
      await declareShared();
      await settings('a', { allowCrossSiteTranslations: true });
      await settings('b', { allowCrossSiteTranslations: true });
      // A B user who may update only published articles (row rule): cannot apply it to a draft.
      const [role] = await db.insert(roles).values({ siteId: fx.sites.b, name: 'Live editor', adminAccess: false, appAccess: true }).returning({ id: roles.id });
      const [policy] = await db.insert(policies).values({ siteId: fx.sites.b, name: 'Live editor', key: 'tgr-live-editor', adminAccess: false, appAccess: true }).returning({ id: policies.id });
      await db.insert(permissions).values([
        { siteId: fx.sites.b, policyId: policy!.id, collection: 'articles', action: 'read', fields: ['*'] },
        { siteId: fx.sites.b, policyId: policy!.id, collection: 'articles', action: 'update', fields: ['*'], permissions: { status: { _eq: 'published' } } },
      ]);
      await db.insert(rolePolicies).values({ roleId: role!.id, policyId: policy!.id });
      await db.insert(userSites).values({ userId: fx.users.onlyA.id, siteId: fx.sites.b, roleId: role!.id });
      await permissionsChanged(fx.sites.b);
      const en = await article('a', 'tell', 'en');
      const ptB = await article('b', 'tell-pt', 'pt');
      const g = await groups().create(en.id);
      await groups().addMember(g.id, { siteId: fx.sites.b, itemId: ptB.id, expectedVersion: g.version });
      await setSharedOnSource('a', en.id, '2.0', asUser('a', fx.users.adminA.id));
      await deliver('item', en.id);
      const told = await db.select().from(notifications).where(and(eq(notifications.siteId, fx.sites.b), eq(notifications.item, ptB.id)));
      expect(told.map((n) => n.recipient).sort()).toEqual([fx.users.adminB.id, fx.users.onlyB.id].sort());
      // A reader of A asking about A's items: the same 403 for a member, a non-member and its blocked state.
      const other = await article('a', 'tell-other', 'vi');
      const reader = fx.headers('a', fx.apiKeys.aReader.token);
      const codes = [];
      for (const itemId of [en.id, other.id]) {
        const res = await call(`/api/v1/translation-groups/${g.id}/members/${itemId}/apply-shared`, 'POST', reader);
        codes.push(res.status);
      }
      expect(codes).toEqual([403, 403]);
      // An editor of A only, about B's member and about a B item outside the group: alike.
      const otherB = await article('b', 'tell-other-b', 'vi');
      const editorA = await as('adminA');
      const answers = [];
      for (const itemId of [ptB.id, otherB.id, 'no-such-item']) {
        const res = await call(`/api/v1/translation-groups/${g.id}/members/${itemId}/apply-shared`, 'POST', editorA);
        answers.push(`${res.status} ${await res.text()}`);
      }
      // The whole answer alike: status, code and message.
      expect(new Set(answers).size).toBe(1);
      expect(answers[0]).toMatch(/^403 .*FORBIDDEN/);
    });

    it('a sync is recorded as an integration write, its after-commit work runs after the commit (R3, R23)', async () => {
      await declareShared();
      const en = await article('a', 'after', 'en');
      const zh = await article('a', 'after-zh', 'zh-CN');
      const g = await groups().create(en.id);
      await groups().addMember(g.id, { itemId: zh.id, expectedVersion: g.version });
      const before = await versionOf(zh.id);
      await setSharedOnSource('a', en.id, '9.0');
      // A queue that looks at the database from outside when the write's after-commit work wakes it.
      const seen: number[] = [];
      // An active event flow of the site: its job is dispatched after the commit, through a fresh transaction.
      await db.insert(flows).values({ siteId: fx.sites.a, name: 'on article update', status: 'active', triggerType: 'event', triggerOptions: { collection: 'articles', action: 'update' } });
      const jobs: string[] = [];
      const queue = {
        enqueue: async (_q: string, name: string) => {
          jobs.push(name);
          seen.push(await versionOf(zh.id));
        },
        process: async () => {},
      } as never;
      const [intent] = await intentsOf(zh.id);
      await applyIntent(db, intent!.id, fx.sites.a, { writer: async (_i, tx) => new ItemService({ db: tx as never, rootDb: db, siteId: fx.sites.a, queue }), person: async () => null }, { accept: ['pending'] });
      expect(seen.length).toBeGreaterThan(0);
      expect(new Set(seen)).toEqual(new Set([before + 1]));
      expect(jobs).toContain('flow:event');
      const [rev] = await db.select().from(revisions).where(and(eq(revisions.itemId, zh.id), eq(revisions.itemVersion, before + 1)));
      expect(rev?.authorType).toBe('integration');
    });

    it('a category sync takes the settings row exclusively before the group (no lock upgrade, R14)', async () => {
      const siteId = fx.sites.a;
      // Shared `name` only: a before hook may still derive a new slug, so the sync takes the row exclusively.
      const [cat] = await db.insert(collections).values({ siteId, name: 'categories', label: 'Categories', meta: { sharedFields: ['name'] } }).returning({ id: collections.id });
      await db.insert(fields).values(['name', 'slug', 'locale'].map((name) => ({ siteId, collectionId: cat!.id, name, type: 'string', interface: 'input' })));
      const svc = itemsOf('a');
      const en = (await svc.create('categories', { data: { name: 'Tools', slug: 'tools', locale: 'en' } })) as { id: string };
      const zh = (await svc.create('categories', { data: { name: '工具', slug: 'tools-zh', locale: 'zh-CN' } })) as { id: string };
      const g = await groups().create(en.id);
      await groups().addMember(g.id, { itemId: zh.id, expectedVersion: g.version });
      await svc.patch('categories', en.id, { data: { name: 'Tools 2' }, expectedVersion: await versionOf(en.id) });
      const intent = (await intentsOf(zh.id)).find((i) => i.status === 'pending');
      const blocker = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
      const probe = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
      try {
        let applying!: Promise<unknown>;
        await blocker.begin(async (tx) => {
          await tx`SELECT 1 FROM lumibase_site_content_settings WHERE site_id = ${siteId} FOR SHARE`;
          let settled = false;
          applying = applyIntent(db, intent!.id, siteId, { writer: async (_i, t) => new ItemService({ db: t as never, rootDb: db, siteId }), person: async () => null }, { accept: ['pending'] }).finally(() => {
            settled = true;
          });
          for (let i = 0; i < 20; i++) await new Promise((ok) => setTimeout(ok, 25));
          // It waits for the settings row exclusively (a shared holder is enough to stop it).
          expect(settled).toBe(false);
          // Waiting for the settings row: it holds nothing of the group yet.
          const free = await probe.begin((p) => p`SELECT 1 FROM lumibase_translation_groups WHERE id = ${g.id} FOR UPDATE NOWAIT`.then(() => true, () => false));
          expect(free).toBe(true);
        });
        expect(await applying).toBe('applied');
      } finally {
        await blocker.end({ timeout: 1 });
        await probe.end({ timeout: 1 });
      }
      expect(((await db.select({ d: items.data }).from(items).where(eq(items.id, zh.id)))[0]!.d as { name: string }).name).toBe('Tools 2');
    });

    it('a member that joins, or a source that is set, takes the source\'s values (design R18)', async () => {
      await declareShared();
      const en = await article('a', 'join-sync', 'en');
      await setSharedOnSource('a', en.id, '7.0');
      const zh = await article('a', 'join-sync-zh', 'zh-CN');
      const g = await groups().create(en.id);
      await groups().addMember(g.id, { itemId: zh.id, expectedVersion: g.version });
      await deliver('translation_group', g.id);
      expect(await valueOf(zh.id)).toBe('7.0');
    });
  });

  describe('translation freshness (tasks 5.1–5.4)', () => {
    const body = (prefix: string, texts: string[]) => texts.map((t, i) => `<p data-block-id="${prefix}${i + 1}">${t}</p>`).join('');
    const addBody = async () => {
      for (const site of ['a', 'b'] as const) {
        const [coll] = await db.select({ id: collections.id }).from(collections).where(and(eq(collections.siteId, fx.sites[site]), eq(collections.name, 'articles')));
        await db.insert(fields).values({ siteId: fx.sites[site], collectionId: coll!.id, name: 'body', type: 'text', interface: 'wysiwyg' });
      }
    };
    const paragraphs = ['One', 'Two', 'Three', 'Four', 'Five'];
    const setup = async () => {
      await addBody();
      const en = (await itemsOf('a').create('articles', { data: { title: 'fresh', slug: 'fresh', locale: 'en', body: body('e', paragraphs) } })) as { id: string };
      const zh = (await itemsOf('a').create('articles', { data: { title: 'fresh zh', slug: 'fresh-zh', locale: 'zh-CN', body: body('z', ['一', '二', '三', '四', '五']) } })) as { id: string };
      const g = await groups().create(en.id);
      await groups().addMember(g.id, { itemId: zh.id, expectedVersion: g.version });
      await groups().writeMaps(g.id, { targetItemId: zh.id, pairs: [1, 2, 3, 4, 5].map((i) => ({ sourceKey: `body#e${i}`, targetKey: `body#z${i}` })) });
      return { en, zh, g };
    };
    const editBody = async (id: string, prefix: string, texts: string[], svc = itemsOf('a')) =>
      svc.patch('articles', id, { data: { body: body(prefix, texts) }, expectedVersion: await versionOf(id) });
    const changed = () => translationFreshnessConsumer({ db }).handle!;
    const deliverItem = (id: string) =>
      changed()({ id: `ev_${id}`, siteId: fx.sites.a, resource: 'item', collection: 'articles', itemId: id, operation: 'update', payload: null, changedFields: null, itemVersion: null, actorType: 'user', actorId: null, source: 'api', occurredAt: new Date(), txid: '1', seq: 1 } as ChangeEvent, { idempotencyKey: 'k', attempt: 1 });
    const mapsOf = async (id: string) =>
      Object.fromEntries((await db.select().from(translationBlockMap).where(eq(translationBlockMap.targetItemId, id))).map((m) => [m.targetKey, { stale: m.stale, reason: m.staleReason, human: m.humanEdited }]));
    const agent = () => new ItemService({ db, siteId: fx.sites.a, provenance: { authorType: 'agent' } });

    it('spec "修改一个段落": only the translation of the changed paragraph goes stale', async () => {
      const { en, zh } = await setup();
      await editBody(en.id, 'e', ['One', 'Two', 'Three, revised', 'Four', 'Five']);
      await deliverItem(en.id);
      const maps = await mapsOf(zh.id);
      expect(Object.entries(maps).filter(([, m]) => m.stale)).toEqual([['body#z3', { stale: true, reason: 'changed', human: false }]]);
    });

    it('spec "人工改过的段落" / "未改过的段落": a person\'s edit is kept and reviewed; only untouched stale blocks are candidates', async () => {
      const { en, zh } = await setup();
      // A person edits zh paragraph 3; an agent then rewrites paragraph 3 again: the mark stays.
      await editBody(zh.id, 'z', ['一', '二', '三（人工）', '四', '五']);
      await editBody(zh.id, 'z', ['一', '二', '三（AI）', '四', '五'], agent());
      expect((await mapsOf(zh.id))['body#z3']!.human).toBe(true);
      // An agent's own edit marks nothing.
      await editBody(zh.id, 'z', ['一（AI）', '二', '三（AI）', '四', '五'], agent());
      expect((await mapsOf(zh.id))['body#z1']!.human).toBe(false);
      await editBody(en.id, 'e', ['One', 'Two', 'Three, revised', 'Four', 'Five, revised']);
      await deliverItem(en.id);
      const res = await call(`/api/v1/translations/articles/${zh.id}/retranslate`, 'GET', await as('onlyA'));
      expect(res.status, await res.clone().text()).toBe(200);
      const { data } = (await res.json()) as { data: { candidates: Array<{ targetKey: string }>; review: Array<{ targetKey: string; humanEdited: boolean; reason: string }> } };
      expect(data.candidates.map((c) => c.targetKey)).toEqual(['body#z5']);
      expect(data.review).toEqual([{ targetKey: 'body#z3', sourceItemId: en.id, sourceKey: 'body#e3', reason: 'changed', humanEdited: true }]);
      // Nothing was translated or overwritten.
      expect(((await db.select({ d: items.data }).from(items).where(eq(items.id, zh.id)))[0]!.d as { body: string }).body).toContain('三（AI）');
    });

    it('spec "丢失正文事件": the periodic check finds a deleted block without its event; marks are never cleared', async () => {
      const { en, zh } = await setup();
      await editBody(zh.id, 'z', ['一', '二', '三', '四（人工）', '五']);
      // Paragraph 4 first changes (stale: changed), then is deleted with its event lost (written past the services).
      await editBody(en.id, 'e', ['One', 'Two', 'Three', 'Four, revised', 'Five']);
      await deliverItem(en.id);
      expect((await mapsOf(zh.id))['body#z4']).toMatchObject({ reason: 'changed' });
      await db.update(items).set({ data: sql`jsonb_set(${items.data}, '{body}', to_jsonb(${body('e', ['One', 'Two', 'Three'])}::text))` }).where(eq(items.id, en.id));
      await db.update(items).set({ data: sql`jsonb_set(${items.data}, '{body}', to_jsonb(${'<p data-block-id="z1">一</p><p data-block-id="z2">二（直改）</p><p data-block-id="z3">三</p><p data-block-id="z4">四（人工）</p><p data-block-id="z5">五</p>'}::text))` }).where(eq(items.id, zh.id));
      await reconcileFreshness(db, fx.sites.a);
      const maps = await mapsOf(zh.id);
      expect(maps['body#z4']).toEqual({ stale: true, reason: 'deleted', human: true });
      expect(maps['body#z5']).toMatchObject({ stale: true, reason: 'deleted' });
      // A target changed past the services is taken for a person's edit.
      expect(maps['body#z2']!.human).toBe(true);
      // Again: nothing cleared.
      await reconcileFreshness(db, fx.sites.a);
      expect((await mapsOf(zh.id))['body#z4']).toEqual({ stale: true, reason: 'deleted', human: true });
    });

    it('moved blocks go to review (R7); accepting clears the marks; re-mapping keeps a person\'s mark', async () => {
      const { en, zh, g } = await setup();
      const html = (order: number[]) => order.map((i) => `<p data-block-id="e${i}">${paragraphs[i - 1]}</p>`).join('');
      await itemsOf('a').patch('articles', en.id, { data: { body: html([1, 2, 5, 3, 4]) }, expectedVersion: await versionOf(en.id) });
      await deliverItem(en.id);
      expect((await mapsOf(zh.id))['body#z5']).toMatchObject({ stale: true, reason: 'moved' });
      expect((await mapsOf(zh.id))['body#z3']).toMatchObject({ stale: false });
      await editBody(zh.id, 'z', ['一', '二', '三', '四', '五（人工）']);
      // Re-mapping block 5 keeps the person's mark; a person accepting clears everything.
      await groups().writeMaps(g.id, { targetItemId: zh.id, pairs: [{ sourceKey: 'body#e5', targetKey: 'body#z5' }] });
      expect((await mapsOf(zh.id))['body#z5']).toEqual({ stale: false, reason: null, human: true });
      expect(await codeOf(groups().acceptMaps(g.id, { targetItemId: zh.id, expectedTargetVersion: await versionOf(zh.id) }))).toBe('FORBIDDEN');
      const accepted = await call(`/api/v1/translation-groups/${g.id}/block-map/accept`, 'POST', await as('onlyA'), { targetItemId: zh.id, expectedTargetVersion: await versionOf(zh.id) });
      expect(accepted.status, await accepted.clone().text()).toBe(200);
      expect(Object.values(await mapsOf(zh.id)).every((m) => !m.stale && !m.human)).toBe(true);
      // A reader cannot write maps.
      const denied = await call(`/api/v1/translation-groups/${g.id}/block-map`, 'POST', fx.headers('a', fx.apiKeys.aReader.token), { targetItemId: zh.id, pairs: [{ sourceKey: 'body#e1', targetKey: 'body#z1' }] });
      expect(denied.status).toBe(403);
    });

    it('block maps across sites: an API key of the translation\'s site cannot use the other site\'s source (P1)', async () => {
      await addBody();
      await settings('a', { allowCrossSiteTranslations: true });
      await settings('b', { allowCrossSiteTranslations: true });
      const en = (await itemsOf('a').create('articles', { data: { title: 'x', slug: 'xsite', locale: 'en', body: body('e', ['One']) } })) as { id: string };
      const zh = (await itemsOf('b').create('articles', { data: { title: 'x', slug: 'xsite-zh', locale: 'zh-CN', body: body('z', ['一']) } })) as { id: string };
      const g = await groups().create(en.id);
      await groups().addMember(g.id, { siteId: fx.sites.b, itemId: zh.id, expectedVersion: g.version });
      const res = await call(`/api/v1/translation-groups/${g.id}/block-map`, 'POST', fx.headers('b', fx.apiKeys.bEditor.token), { targetItemId: zh.id, pairs: [{ sourceKey: 'body#e1', targetKey: 'body#z1' }] });
      expect(res.status).toBe(403);
      expect(await mapsOf(zh.id)).toEqual({});
    });

    it('a partial acceptance judges the old baseline first: a move it does not cover stays found', async () => {
      const { en, zh, g } = await setup();
      const html = (order: number[]) => order.map((i) => `<p data-block-id="e${i}">${paragraphs[i - 1]}</p>`).join('');
      // Moved without an event; a person accepts block 1 only.
      await db.update(items).set({ data: sql`jsonb_set(${items.data}, '{body}', to_jsonb(${html([1, 2, 5, 3, 4])}::text))` }).where(eq(items.id, en.id));
      const accepted = await call(`/api/v1/translation-groups/${g.id}/block-map/accept`, 'POST', await as('onlyA'), { targetItemId: zh.id, expectedTargetVersion: await versionOf(zh.id), keys: ['body#z1'] });
      expect(accepted.status, await accepted.clone().text()).toBe(200);
      expect((await mapsOf(zh.id))['body#z5']).toMatchObject({ stale: true, reason: 'moved' });
      await reconcileFreshness(db, fx.sites.a);
      expect((await mapsOf(zh.id))['body#z5']).toMatchObject({ stale: true, reason: 'moved' });
    });

    it('the periodic check walks every source, past one batch', async () => {
      const first = await setup();
      const en2 = (await itemsOf('a').create('articles', { data: { title: 'f2', slug: 'fresh-2', locale: 'en', body: body('f', ['A']) } })) as { id: string };
      const zh2 = (await itemsOf('a').create('articles', { data: { title: 'f2 zh', slug: 'fresh-2-zh', locale: 'zh-CN', body: body('y', ['甲']) } })) as { id: string };
      const g2 = await groups().create(en2.id);
      await groups().addMember(g2.id, { itemId: zh2.id, expectedVersion: g2.version });
      await groups().writeMaps(g2.id, { targetItemId: zh2.id, pairs: [{ sourceKey: 'body#f1', targetKey: 'body#y1' }] });
      void first;
      // Both sources changed without events; batches of one.
      for (const [id, html] of [[en2.id, body('f', ['A, revised'])], [first.en.id, body('e', ['One, revised', 'Two', 'Three', 'Four', 'Five'])]] as const) {
        await db.update(items).set({ data: sql`jsonb_set(${items.data}, '{body}', to_jsonb(${html}::text))` }).where(eq(items.id, id));
      }
      const result = await reconcileFreshness(db, fx.sites.a, { batch: 1 });
      expect(result.sources).toBeGreaterThanOrEqual(2);
      expect((await mapsOf(zh2.id))['body#y1']).toMatchObject({ stale: true, reason: 'changed' });
      expect((await mapsOf(first.zh.id))['body#z1']).toMatchObject({ stale: true, reason: 'changed' });
    });

    it('a judgement never lowers a reason written meanwhile (source changed while the consumer waits)', async () => {
      const { en, zh, g } = await setup();
      await editBody(en.id, 'e', ['One, revised', 'Two', 'Three', 'Four', 'Five']);
      const blocker = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
      try {
        let judging!: Promise<unknown>;
        // A source change in progress (as setSource does): group held, maps already marked, not yet committed.
        await blocker.begin(async (tx) => {
          await tx`SELECT 1 FROM lumibase_translation_groups WHERE id = ${g.id} FOR UPDATE`;
          await tx`UPDATE lumibase_translation_block_map SET stale = true, stale_reason = 'source_changed' WHERE target_item_id = ${zh.id}`;
          judging = deliverItem(en.id);
          for (let i = 0; i < 12; i++) await new Promise((ok) => setTimeout(ok, 25));
        });
        await judging;
      } finally {
        await blocker.end({ timeout: 1 });
      }
      expect((await mapsOf(zh.id))['body#z1']).toMatchObject({ stale: true, reason: 'source_changed' });
    });

    const addSeo = async () => {
      for (const site of ['a', 'b'] as const) {
        const [coll] = await db.select({ id: collections.id }).from(collections).where(and(eq(collections.siteId, fx.sites[site]), eq(collections.name, 'articles')));
        await db.insert(fields).values(['seo_title', 'seo_description', 'seo_image', 'seo_robots', 'canonical_url'].map((name) => ({ siteId: fx.sites[site], collectionId: coll!.id, name, type: 'string', interface: 'input' })));
      }
    };

    it('spec "新建译文" / "修改源条目描述": a draft copies SEO but not canonical; only the SEO description goes stale', async () => {
      const { en, zh, g } = await setup();
      await addSeo();
      await itemsOf('a').patch('articles', en.id, {
        data: { seo_title: 'Title', seo_description: 'Desc', seo_image: 'img-1', seo_robots: 'index,follow', canonical_url: 'https://tg-a.example.com/fresh/' },
        expectedVersion: await versionOf(en.id),
      });
      const res = await call(`/api/v1/translation-groups/${g.id}/drafts`, 'POST', await as('onlyA'), { locale: 'ja' });
      expect(res.status, await res.clone().text()).toBe(201);
      const { data } = (await res.json()) as { data: { itemId: string } };
      const [draft] = await db.select({ data: items.data, status: items.status }).from(items).where(eq(items.id, data.itemId));
      expect(draft!.status).toBe('draft');
      expect(draft!.data).toMatchObject({ locale: 'ja', seo_title: 'Title', seo_description: 'Desc', seo_image: 'img-1', seo_robots: 'index,follow', canonical_url: null });
      expect(Object.keys(await mapsOf(data.itemId)).sort()).toEqual(['seo_description#$', 'seo_image#$', 'seo_title#$']);
      // Only the SEO description changes in the source: only that is stale; the body maps of zh are untouched.
      await itemsOf('a').patch('articles', en.id, { data: { seo_description: 'Desc, revised' }, expectedVersion: await versionOf(en.id) });
      await deliverItem(en.id);
      const maps = await mapsOf(data.itemId);
      expect(Object.entries(maps).filter(([, m]) => m.stale).map(([k, m]) => [k, m.reason])).toEqual([['seo_description#$', 'changed']]);
      expect(Object.values(await mapsOf(zh.id)).some((m) => m.stale)).toBe(false);
    });

    it('a draft of a preset collection (title and slug required) is created; a failing step leaves nothing behind', async () => {
      const P = 'site_tgr_preset';
      await db.delete(sites).where(eq(sites.id, P));
      await db.insert(sites).values({ id: P, name: 'Preset', defaultLanguage: 'en' });
      try {
        await upgradeSitePreset(db, P);
        const [r] = await db.select().from(siteContentSettings).where(eq(siteContentSettings.siteId, P));
        await new ContentSettingsService({ db, siteId: P, actor: { userId: null } }).update({
          availableLocales: ['en', 'ja'], timezone: r!.timezone, siteType: 'blog', trailingSlash: 'always', localeStrategy: 'subdirectory', localePrefixMode: 'default_at_root',
          localePrefixes: {}, permalinks: r!.permalinks, allowCrossSiteTranslations: false, sponsorDisclosure: true, sponsorRel: true, version: r!.version,
        } as never);
        const svc = new ItemService({ db, siteId: P });
        const src = (await svc.create('articles', { data: { title: 'Hello', slug: 'hello', locale: 'en', seo_description: 'D' }, status: 'published' })) as { id: string };
        const pg = new TranslationGroupService({ db, siteId: P, actor: undefined, userId: null, itemsOn: (siteId, tx) => new ItemService({ db: tx as never, rootDb: db, siteId }) });
        const g = await pg.create(src.id);
        const { itemId } = await pg.createDraft(g.id, { locale: 'ja' });
        const [draft] = await db.select({ data: items.data }).from(items).where(eq(items.id, itemId));
        expect(draft!.data).toMatchObject({ title: 'Hello', slug: 'hello', locale: 'ja', seo_description: 'D', canonical_url: null });
      } finally {
        await db.delete(sites).where(eq(sites.id, P));
      }
    });

    it('a draft started while a join adds a site starts over instead of deadlocking (lock order)', async () => {
      const { g } = await setup();
      await settings('a', { allowCrossSiteTranslations: true });
      await settings('b', { allowCrossSiteTranslations: true });
      const vB = (await itemsOf('b').create('articles', { data: { title: 'b', slug: 'lock-b', locale: 'vi', body: body('v', ['x']) } })) as { id: string };
      const [coll] = await db.select({ id: collections.id }).from(collections).where(and(eq(collections.siteId, fx.sites.b), eq(collections.name, 'articles')));
      const joiner = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
      const settingsHolder = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
      const waiting = async (n: number) => {
        let w = 0;
        for (let i = 0; i < 200 && w < n; i++) {
          if (i > 0) await new Promise((ok) => setTimeout(ok, 25));
          const [r] = await db.execute(sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`) as unknown as Array<{ n: number }>;
          w = r!.n;
        }
        expect(w, 'sessions waiting on a lock').toBeGreaterThanOrEqual(n);
      };
      let draft!: Promise<string>;
      let holder!: Promise<unknown>;
      try {
        await joiner.begin(async (tx) => {
          // A join of B in progress: the group held, B listed and its member written.
          await tx`SELECT 1 FROM lumibase_translation_groups WHERE id = ${g.id} FOR UPDATE`;
          await tx`UPDATE lumibase_translation_groups SET site_ids = ARRAY[${fx.sites.a}, ${fx.sites.b}]::text[], version = version + 1 WHERE id = ${g.id}`;
          await tx`INSERT INTO lumibase_translation_group_members (item_id, group_id, site_id, collection_id, locale, role) VALUES (${vB.id}, ${g.id}, ${fx.sites.b}, ${coll!.id}, 'vi', 'translation')`;
          draft = codeOf(groups().createDraft(g.id, { locale: 'ja' }));
          await waiting(1);
          // B's settings held exclusively by someone who then needs the group (a default language change).
          holder = settingsHolder.begin(async (h) => {
            await h`SELECT 1 FROM lumibase_site_content_settings WHERE site_id = ${fx.sites.b} FOR UPDATE`;
            await h`SELECT 1 FROM lumibase_translation_groups WHERE id = ${g.id} FOR UPDATE`;
          });
          await waiting(2);
        });
        await holder;
        expect(await draft).toBe('ok');
      } finally {
        await joiner.end({ timeout: 1 });
        await settingsHolder.end({ timeout: 1 });
      }
    });

    it('a draft whose joining is refused is not created at all (one transaction)', async () => {
      const { g } = await setup();
      await settings('a', { allowCrossSiteTranslations: true });
      await settings('b', { allowCrossSiteTranslations: true });
      const zhB = (await itemsOf('b').create('articles', { data: { title: 'b', slug: 'fresh-b', locale: 'vi', body: body('v', ['x']) } })) as { id: string };
      await groups().addMember(g.id, { siteId: fx.sites.b, itemId: zhB.id, expectedVersion: await groupVersion(g.id) });
      await settings('a', { allowCrossSiteTranslations: false });
      const before = (await db.select({ id: items.id }).from(items).where(eq(items.siteId, fx.sites.b))).length;
      expect(await codeOf(groups('b').createDraft(g.id, { locale: 'ja' }))).toBe('CROSS_SITE_DISABLED');
      expect((await db.select({ id: items.id }).from(items).where(eq(items.siteId, fx.sites.b))).length).toBe(before);
    });

    it('spec "源条目更新后": translation status per language — missing, draft, in review, published, stale', async () => {
      const { en, zh, g } = await setup();
      await publish('a', en.id);
      const pt = (await itemsOf('a').create('articles', { data: { title: 'pt', slug: 'status-pt', locale: 'pt', body: body('p', ['Um']) } })) as { id: string };
      await groups().addMember(g.id, { itemId: pt.id, expectedVersion: await groupVersion(g.id) });
      await db.update(items).set({ editorialState: 'in_review' }).where(eq(items.id, pt.id));
      const status = async () =>
        Object.fromEntries(
          ((await (await call(`/api/v1/items/articles/${en.id}/translation-status`, 'GET', await as('onlyA'))).json()) as { data: { locales: Array<{ locale: string; state: string }> } }).data.locales.map((l) => [l.locale, l.state]),
        );
      expect(await status()).toMatchObject({ en: 'published', 'zh-CN': 'draft', pt: 'in_review', vi: 'missing', ja: 'missing' });
      // Each readable member with its own state too.
      const full = ((await (await call(`/api/v1/items/articles/${en.id}/translation-status`, 'GET', await as('onlyA'))).json()) as { data: { members: Array<{ itemId: string; state: string }> } }).data.members;
      expect(Object.fromEntries(full.map((m) => [m.itemId, m.state]))).toEqual({ [en.id]: 'published', [zh.id]: 'draft', [pt.id]: 'in_review' });
      await publish('a', zh.id);
      expect((await status())['zh-CN']).toBe('published');
      await editBody(en.id, 'e', ['One', 'Two, revised', 'Three', 'Four', 'Five']);
      await deliverItem(en.id);
      expect((await status())['zh-CN']).toBe('stale');
      // A reader of the site may look; a caller of another site may not.
      expect((await call(`/api/v1/items/articles/${en.id}/translation-status`, 'GET', fx.headers('a', fx.apiKeys.aReader.token))).status).toBe(200);
      expect([401, 403, 404]).toContain((await call(`/api/v1/items/articles/${en.id}/translation-status`, 'GET', fx.headers('b', fx.apiKeys.bEditor.token))).status);
    });

    it('a former source deleted later keeps the other translations\' review records', async () => {
      const { en, zh, g } = await setup();
      const pt = (await itemsOf('a').create('articles', { data: { title: 'pt', slug: 'fresh-pt', locale: 'pt', body: body('p', ['Um']) } })) as { id: string };
      await groups().addMember(g.id, { itemId: pt.id, expectedVersion: await groupVersion(g.id) });
      await groups().setSource(g.id, pt.id, await groupVersion(g.id));
      await itemsOf('a').softDelete('articles', en.id);
      expect(new Set(Object.values(await mapsOf(zh.id)).map((m) => m.reason))).toEqual(new Set(['source_changed']));
    });

    it('the periodic check waits for a target write in progress: an agent\'s write is not taken for a person\'s', async () => {
      await addBody();
      await settings('a', { allowCrossSiteTranslations: true });
      await settings('b', { allowCrossSiteTranslations: true });
      const en = (await itemsOf('a').create('articles', { data: { title: 'w', slug: 'wait', locale: 'en', body: body('e', ['One']) } })) as { id: string };
      const zh = (await itemsOf('b').create('articles', { data: { title: 'w', slug: 'wait-zh', locale: 'zh-CN', body: body('z', ['一']) } })) as { id: string };
      const g = await groups().create(en.id);
      await groups().addMember(g.id, { siteId: fx.sites.b, itemId: zh.id, expectedVersion: g.version });
      await groups().writeMaps(g.id, { targetItemId: zh.id, pairs: [{ sourceKey: 'body#e1', targetKey: 'body#z1' }] });
      const blocker = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
      try {
        let checking!: Promise<unknown>;
        let settled = false;
        // A target write in progress (as ItemService does): group held, the body and the map hash updated, not committed.
        const newBody = body('z', ['一（AI）']);
        const hash = htmlBlocks('body', newBody)[0]!.hash;
        await blocker.begin(async (tx) => {
          await tx`SELECT 1 FROM lumibase_translation_groups WHERE id = ${g.id} FOR UPDATE`;
          await tx`UPDATE lumibase_items SET data = jsonb_set(data, '{body}', to_jsonb(${newBody}::text)) WHERE id = ${zh.id}`;
          await tx`UPDATE lumibase_translation_block_map SET target_hash = ${hash} WHERE target_item_id = ${zh.id} AND target_key = 'body#z1'`;
          // Only B's check: no source there, so it goes straight to the target side, which must wait.
          checking = reconcileFreshness(db, fx.sites.b).finally(() => {
            settled = true;
          });
          for (let i = 0; i < 12; i++) await new Promise((ok) => setTimeout(ok, 25));
          expect(settled).toBe(false);
        });
        await checking;
      } finally {
        await blocker.end({ timeout: 1 });
      }
      expect((await mapsOf(zh.id))['body#z1']!.human).toBe(false);
    });

    it('a deleted source keeps its maps for review; a deleted translation takes its maps', async () => {
      const { en, zh } = await setup();
      await itemsOf('a').softDelete('articles', en.id);
      expect(new Set(Object.values(await mapsOf(zh.id)).map((m) => m.reason))).toEqual(new Set(['source_removed']));
      await itemsOf('a').softDelete('articles', zh.id);
      expect(await mapsOf(zh.id)).toEqual({});
    });

    it('an internal-only source is still the freshness baseline (task 4.5); a new source makes the old maps stale; a leaving member takes its maps', async () => {
      const { en, zh, g } = await setup();
      await groups().setInternalOnly(g.id, en.id, true, await groupVersion(g.id));
      await editBody(en.id, 'e', ['One, revised', 'Two', 'Three', 'Four', 'Five']);
      await deliverItem(en.id);
      expect((await mapsOf(zh.id))['body#z1']).toMatchObject({ stale: true, reason: 'changed' });
      await groups().setInternalOnly(g.id, en.id, false, await groupVersion(g.id));
      await groups().setSource(g.id, zh.id, await groupVersion(g.id));
      // Every map of the old source goes to review, the already stale one included (the stronger reason).
      expect(new Set(Object.values(await mapsOf(zh.id)).map((m) => m.reason))).toEqual(new Set(['source_changed']));
      await groups().removeMember(g.id, en.id, await groupVersion(g.id));
      expect(await mapsOf(zh.id)).toEqual({});
    });
  });

  it('life cycle (design R9, R18, R24): source removal, deleted source, new source, versions', async () => {
    const en = await article('a', 'life', 'en');
    const zh = await article('a', 'life-zh', 'zh-CN');
    const g = await groups().create(en.id);
    expect(await codeOf(groups().addMember(g.id, { itemId: zh.id, expectedVersion: g.version + 5 }))).toBe('VERSION_CONFLICT');
    await groups().addMember(g.id, { itemId: zh.id, expectedVersion: g.version });
    expect(await codeOf(groups().create(zh.id))).toBe('ALREADY_IN_GROUP');
    expect(await codeOf(groups().removeMember(g.id, en.id, await groupVersion(g.id)))).toBe('CHANGE_SOURCE_FIRST');
    // Deleting the source leaves the group without one; its member row stays.
    await itemsOf('a').softDelete('articles', en.id);
    const [noSource] = await db.select().from(translationGroups).where(eq(translationGroups.id, g.id));
    expect(noSource).toMatchObject({ sourceItemId: null, sourceEpoch: 1 });
    expect(await codeOf(groups().setSource(g.id, en.id, noSource!.version))).toBe('SOURCE_DELETED');
    const view = await groups().setSource(g.id, zh.id, noSource!.version);
    expect(view).toMatchObject({ sourceItemId: zh.id, sourceEpoch: 2 });
    const roleOf = async (id: string) => (await db.select({ r: translationGroupMembers.role }).from(translationGroupMembers).where(eq(translationGroupMembers.itemId, id)))[0]?.r;
    expect([await roleOf(en.id), await roleOf(zh.id)]).toEqual(['translation', 'source']);
    // Deleting an item for good takes its membership; the last member's removal dissolves the group.
    await itemsOf('a').hardDelete('articles', en.id);
    expect(await roleOf(en.id)).toBeUndefined();
    expect(await groups().removeMember(g.id, zh.id, await groupVersion(g.id))).toBeNull();
    expect(await db.select().from(translationGroups).where(inArray(translationGroups.id, [g.id]))).toEqual([]);
  });
});
