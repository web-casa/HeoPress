import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq, inArray } from 'drizzle-orm';
import { items, redirects, siteContentSettings, siteDomains, sites, type Database } from '@heopress/database';
import type { AppEnv } from '../env';
import { domainsRouter } from '../routes/domains';
import { redirectsRouter } from '../routes/redirects';
import { verifyDomainClaim } from '../services/domains/domain-verification';
import { withPublicSite } from '../middleware/public-site';
import { ItemService } from '../services/item-service';
import { ContentSettingsError, ContentSettingsService } from '../services/site-network/content-settings-service';
import { checkEntryLocale, isEntryLocaleTaken } from '../services/site-network/language-entries';
import { upgradeSitePreset } from '../services/site-network/preset-installer';
import { resolvePublicPath, type PublicPathRequest } from '../services/site-network/public-path';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';

/**
 * Public path resolution (HeoPress P05 tasks 1.6, 3.1, 3.3–3.5; spec
 * i18n/locale-routing, content/site-network-model "固定链接", "别名域名一次
 * 跳转"; design B, R33–R37): the three language URL strategies, both
 * subdirectory modes, the trailing slash policy, language entry domains,
 * one 301 to a fixed point across alias, prefix, slug and slash, loops, and
 * that the language never comes from Accept-Language.
 */

const SITE = 'site_p05_public_path_it';
const ZH_FIRST = 'site_p05_public_path_zh_it';
const MAIN = 'pp-main.example.com';
const ALIAS = 'pp-alias.example.com';
const ZH_HOST = 'pp.example.cn';
const ZH_FIRST_HOST = 'pp-zh.example.com';
const OWNER_URL = process.env.DATABASE_OWNER_URL?.trim() || undefined;
const MIGRATION_0023 = join(__dirname, '../../../../packages/database/drizzle/0023_site_domains_entry_locale_unique.sql');

describe.skipIf(!hasDbIntegrationUrl)('public path resolution — DB integration', () => {
  let db: Database;

  beforeAll(async () => {
    db = await connectDbIntegration('public-path');
  });
  beforeEach(async () => {
    await db.delete(sites).where(inArray(sites.id, [SITE, ZH_FIRST]));
    await db.insert(sites).values([
      { id: SITE, name: 'Public path', defaultLanguage: 'en' },
      { id: ZH_FIRST, name: 'Public path zh', defaultLanguage: 'zh-CN' },
    ]);
    await upgradeSitePreset(db, SITE);
    await upgradeSitePreset(db, ZH_FIRST);
    await db.insert(siteDomains).values([
      { siteId: SITE, hostname: MAIN, kind: 'custom', status: 'active', isPrimary: true, verifiedAt: new Date() },
      { siteId: SITE, hostname: ALIAS, kind: 'custom', status: 'active', verifiedAt: new Date() },
      { siteId: ZH_FIRST, hostname: ZH_FIRST_HOST, kind: 'custom', status: 'active', isPrimary: true, verifiedAt: new Date() },
    ]);
    await settings(SITE, { availableLocales: ['en', 'zh-CN'], localePrefixes: { 'zh-CN': 'zh' }, permalinks: { articles: '/:slug', pages: '/:slug', categories: '/category/:slug' } });
  });
  afterAll(async () => {
    await db?.delete(sites).where(inArray(sites.id, [SITE, ZH_FIRST]));
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
  const page = (slug: string, locale = 'en', status = 'published', siteId = SITE) =>
    new ItemService({ db, siteId }).create('pages', { data: { title: slug, slug, locale }, status }) as Promise<{ id: string; version: number }>;
  const resolve = (host: string, path: string, query?: string) => resolvePublicPath(db, { host, path, ...(query ? { query } : {}) });
  const entryDomain = (hostname: string, locale: string) =>
    db.insert(siteDomains).values({ siteId: SITE, hostname, kind: 'custom', status: 'active', entryLocale: locale, verifiedAt: new Date() });
  /** Wait until `n` sessions are blocked by THIS owner session (located by pg_blocking_pids, not counted database-wide). */
  const blockedByMe = async (sql: postgres.TransactionSql, n: number) => {
    let blocked = 0;
    for (let i = 0; i < 100 && blocked < n; i++) {
      const [r] = await sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE pg_backend_pid() = ANY(pg_blocking_pids(pid))`;
      blocked = r!.n;
      if (blocked < n) await new Promise((res) => setTimeout(res, 50));
    }
    if (blocked < n) throw new Error(`only ${blocked} of ${n} sessions waited on the settings lock`);
  };
  /** Hold the site's settings row exclusively, run `during` (with the owner session), then let go. */
  const holdingSettings = async (during: (sql: postgres.TransactionSql) => Promise<void>) => {
    const owner = postgres(OWNER_URL!, { max: 1, onnotice: () => {} });
    try {
      await owner.begin(async (sql) => {
        await sql`SELECT 1 FROM lumibase_site_content_settings WHERE site_id = ${SITE} FOR UPDATE`;
        await during(sql);
      });
    } finally {
      await owner.end({ timeout: 1 });
    }
  };

  it('spec "默认语言在根路径": /guide/ is the English page, /zh/guide-cn/ the Chinese one; the default prefix and a missing slash 301', async () => {
    const en = await page('guide');
    const zh = await page('guide-cn', 'zh-CN');
    expect(await resolve(MAIN, '/guide/')).toMatchObject({ kind: 'item', itemId: en.id, locale: 'en', url: `https://${MAIN}/guide/` });
    expect(await resolve(MAIN, '/zh/guide-cn/')).toMatchObject({ kind: 'item', itemId: zh.id, locale: 'zh-CN' });
    expect(await resolve(MAIN, '/guide', 'utm=1')).toEqual({ kind: 'redirect', status: 301, siteId: SITE, location: `https://${MAIN}/guide/?utm=1` });
    expect(await resolve(MAIN, '/en/guide/')).toMatchObject({ kind: 'redirect', location: `https://${MAIN}/guide/` });
    // Each language has its own slug: the Chinese page is not under the English path, nor the reverse.
    expect(await resolve(MAIN, '/zh/guide/')).toMatchObject({ kind: 'not_found', reason: 'no_route' });
    expect(await resolve(MAIN, '/guide-cn/')).toMatchObject({ kind: 'not_found', reason: 'no_route' });
  });

  it('drafts and deleted items are not public; their paths are not found (no slash redirect for nothing)', async () => {
    await page('draft-page', 'en', 'draft');
    expect(await resolve(MAIN, '/draft-page/')).toMatchObject({ kind: 'not_found', reason: 'no_route' });
    expect(await resolve(MAIN, '/draft-page')).toMatchObject({ kind: 'not_found', reason: 'no_route' });
    const gone = await page('gone');
    await new ItemService({ db, siteId: SITE }).softDelete('pages', gone.id);
    expect(await resolve(MAIN, '/gone/')).toMatchObject({ kind: 'not_found' });
  });

  it('spec "全部语言带前缀": default zh-cn, / redirects to /zh-cn/; unprefixed paths are no address', async () => {
    await settings(ZH_FIRST, { availableLocales: ['zh-CN', 'en'], localePrefixMode: 'all_prefixed', localePrefixes: { 'zh-CN': 'zh-cn' }, permalinks: { pages: '/:slug' } });
    const home = await page('jiao-cheng', 'zh-CN', 'published', ZH_FIRST);
    expect(await resolve(ZH_FIRST_HOST, '/')).toMatchObject({ kind: 'redirect', location: `https://${ZH_FIRST_HOST}/zh-cn/` });
    expect(await resolve(ZH_FIRST_HOST, '/zh-cn/jiao-cheng/')).toMatchObject({ kind: 'item', itemId: home.id, locale: 'zh-CN' });
    expect(await resolve(ZH_FIRST_HOST, '/jiao-cheng/')).toMatchObject({ kind: 'not_found' });
  });

  it('spec "数字编号且不带尾斜杠": /10/ answers 301 to /10', async () => {
    await settings(SITE, { trailingSlash: 'never', permalinks: { articles: '/:id', pages: '/:slug', categories: '/category/:slug' } });
    const a = (await new ItemService({ db, siteId: SITE }).create('articles', { data: { title: 'Ten', slug: 'ten', locale: 'en' }, status: 'published' })) as { id: string };
    const [row] = await db.select({ number: items.number }).from(items).where(eq(items.id, a.id));
    const n = row!.number!;
    expect(await resolve(MAIN, `/${n}/`)).toMatchObject({ kind: 'redirect', location: `https://${MAIN}/${n}` });
    expect(await resolve(MAIN, `/${n}`)).toMatchObject({ kind: 'item', itemId: a.id, url: `https://${MAIN}/${n}` });
  });

  it('spec "独立域名策略" and the subdomain strategy: a language entry domain resolves in its language without a redirect', async () => {
    await entryDomain(ZH_HOST, 'zh-CN');
    await settings(SITE, { localeStrategy: 'domain' });
    const zh = await page('astro-jiao-cheng', 'zh-CN');
    const en = await page('astro-guide');
    expect(await resolve(ZH_HOST, '/astro-jiao-cheng/')).toMatchObject({ kind: 'item', itemId: zh.id, locale: 'zh-CN', url: `https://${ZH_HOST}/astro-jiao-cheng/` });
    expect(await resolve(MAIN, '/astro-guide/')).toMatchObject({ kind: 'item', itemId: en.id, locale: 'en' });
    // No prefixes under this strategy; the Chinese page is not on the main domain.
    expect(await resolve(MAIN, '/zh/astro-jiao-cheng/')).toMatchObject({ kind: 'not_found' });
    expect(await resolve(MAIN, '/astro-jiao-cheng/')).toMatchObject({ kind: 'not_found' });

    await db.update(siteDomains).set({ hostname: `zh.${MAIN}` }).where(eq(siteDomains.hostname, ZH_HOST));
    await settings(SITE, { localeStrategy: 'subdomain' });
    expect(await resolve(`zh.${MAIN}`, '/astro-jiao-cheng/')).toMatchObject({ kind: 'item', itemId: zh.id, locale: 'zh-CN' });
  });

  it('spec "子目录策略": /zh/astro-jiao-cheng/ is the Chinese version; a language entry domain still means its language', async () => {
    const zh = await page('astro-jiao-cheng', 'zh-CN');
    expect(await resolve(MAIN, '/zh/astro-jiao-cheng/')).toMatchObject({ kind: 'item', itemId: zh.id, locale: 'zh-CN' });
    await entryDomain(ZH_HOST, 'zh-CN');
    expect(await resolve(ZH_HOST, '/astro-jiao-cheng/')).toMatchObject({ kind: 'item', itemId: zh.id });
  });

  it('spec "别名域名一次跳转": alias host, old language prefix, old slug, wrong slash — one 301 to the final address, a fixed point', async () => {
    await settings(SITE, { localePrefixes: { 'zh-CN': 'cn' } });
    const p = await page('old', 'zh-CN');
    await new ItemService({ db, siteId: SITE }).patch('pages', p.id, { data: { slug: 'new' }, expectedVersion: p.version });
    await settings(SITE, { localePrefixes: { 'zh-CN': 'zh' } });
    const first = await resolve(ALIAS, '/cn/old', 'ref=x');
    expect(first).toEqual({ kind: 'redirect', status: 301, siteId: SITE, location: `https://${MAIN}/zh/new/?ref=x` });
    expect(await resolve(MAIN, '/zh/new/', 'ref=x')).toMatchObject({ kind: 'item', itemId: p.id });
    // Switching the prefix back leaves no loop: the live prefix answers.
    await settings(SITE, { localePrefixes: { 'zh-CN': 'cn' } });
    expect(await resolve(MAIN, '/zh/new/')).toMatchObject({ kind: 'redirect', location: `https://${MAIN}/cn/new/` });
    expect(await resolve(MAIN, '/cn/new/')).toMatchObject({ kind: 'item', itemId: p.id });
    const urlRules = await db.select().from(redirects).where(eq(redirects.siteId, SITE));
    expect(urlRules.filter((r) => r.scope === 'url').map((r) => `${r.fromPath}->${r.toPath}`)).toEqual(['/zh->/cn']);
  });

  it('the P04 middleware sends an alias straight to the final address: one 301 across prefix, slug and slash', async () => {
    await settings(SITE, { localePrefixes: { 'zh-CN': 'cn' } });
    const p = await page('old', 'zh-CN');
    await new ItemService({ db, siteId: SITE }).patch('pages', p.id, { data: { slug: 'new' }, expectedVersion: p.version });
    await settings(SITE, { localePrefixes: { 'zh-CN': 'zh' } });
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('db', db);
      await next();
    });
    app.use('*', withPublicSite());
    app.get('*', (c) => c.text('rendered'));
    const res = await app.request(`http://${ALIAS}/cn/old?ref=x`, { headers: { host: ALIAS } });
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe(`https://${MAIN}/zh/new/?ref=x`);
  });

  it('several prefixes renamed at once: each old address keeps its own language; a prefix live again has no rule', async () => {
    await settings(SITE, { availableLocales: ['en', 'zh-CN', 'fr'], localePrefixes: { 'zh-CN': 'cn', fr: 'fr' } });
    const zh = await page('wen-zhang', 'zh-CN');
    // Chinese cn → fr, French fr → de, in one save.
    await settings(SITE, { localePrefixes: { 'zh-CN': 'fr', fr: 'de' } });
    const url = await db.select().from(redirects).where(eq(redirects.siteId, SITE));
    // /zh → /cn (the earlier move) follows Chinese to /fr; French's old /fr is Chinese's now: no rule from it.
    expect(url.filter((r) => r.scope === 'url').map((r) => `${r.fromPath}->${r.toPath}`).sort()).toEqual(['/cn->/fr', '/zh->/fr']);
    expect(await resolve(MAIN, '/cn/wen-zhang/')).toMatchObject({ kind: 'redirect', location: `https://${MAIN}/fr/wen-zhang/` });
    expect(await resolve(MAIN, '/fr/wen-zhang/')).toMatchObject({ kind: 'item', itemId: zh.id, locale: 'zh-CN' });
  });

  it('a prefix that becomes live without any language moving (all_prefixed) drops the old rule from it', async () => {
    await settings(SITE, { localePrefixes: { 'zh-CN': 'cn' } });
    await settings(SITE, { localePrefixes: { 'zh-CN': 'zh' } });
    expect((await db.select().from(redirects).where(eq(redirects.siteId, SITE))).map((r) => r.fromPath)).toEqual(['/cn']);
    await settings(SITE, { localePrefixMode: 'all_prefixed', localePrefixes: { en: 'cn', 'zh-CN': 'zh' } });
    expect(await db.select().from(redirects).where(eq(redirects.siteId, SITE))).toEqual([]);
    expect(await resolve(MAIN, '/')).toMatchObject({ kind: 'redirect', location: `https://${MAIN}/cn/` });
  });

  it('on a language entry domain (subdirectory strategy) an old slug redirects on that domain', async () => {
    await entryDomain(ZH_HOST, 'zh-CN');
    const p = await page('old', 'zh-CN');
    await new ItemService({ db, siteId: SITE }).patch('pages', p.id, { data: { slug: 'new' }, expectedVersion: p.version });
    expect(await resolve(ZH_HOST, '/old/')).toMatchObject({ kind: 'redirect', location: `https://${ZH_HOST}/new/` });
    expect(await resolve(MAIN, '/zh/old/')).toMatchObject({ kind: 'redirect', location: `https://${MAIN}/zh/new/` });
  });

  it('a settings change that would close a redirect loop is refused; nothing changes', async () => {
    // /y (English) → Chinese /x; /fr/x → /y: harmless while Chinese is under /zh, a loop if it moves to /fr.
    await db.insert(redirects).values([
      { siteId: SITE, scope: 'content', locale: 'en', fromPath: '/y', match: 'exact', toPath: '/x', toLocale: 'zh-CN', source: 'manual' },
      { siteId: SITE, scope: 'url', locale: '', fromPath: '/fr/x', match: 'exact', toPath: '/y', toLocale: '', source: 'manual' },
    ]);
    const err = await settings(SITE, { localePrefixes: { 'zh-CN': 'fr' } }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'REDIRECT_CONFLICT', status: 409 });
    const [row] = await db.select().from(siteContentSettings).where(eq(siteContentSettings.siteId, SITE));
    expect(row!.localePrefixes).toMatchObject({ 'zh-CN': 'zh' });
  });

  it('R36 holds for the final rule set: a rule that cannot take effect blocks any settings change until it is fixed', async () => {
    await db.insert(redirects).values({ siteId: SITE, scope: 'content', locale: 'zh-CN', fromPath: '/b', match: 'exact', toPath: '/b', toLocale: 'zh-CN', source: 'manual' });
    expect(await settings(SITE, { localePrefixes: { 'zh-CN': 'fr' } }).catch((e: { code?: string }) => e.code)).toBe('REDIRECT_CONFLICT');
    expect(await settings(SITE, { timezone: 'Asia/Shanghai' }).catch((e: { code?: string }) => e.code)).toBe('REDIRECT_CONFLICT');
  });

  it('a new default language is checked too: it must not turn the language rules into a loop', async () => {
    await settings(SITE, { availableLocales: ['en', 'fr'], localePrefixMode: 'all_prefixed', localePrefixes: { en: 'en', fr: 'fr' } });
    // /fr → / → /en is fine while English is the default; with French as default, / → /fr → / loops.
    await db.insert(redirects).values({ siteId: SITE, scope: 'url', locale: '', fromPath: '/fr', match: 'exact', toPath: '/', toLocale: '', source: 'manual' });
    const svc = new ContentSettingsService({ db, siteId: SITE, actor: { userId: null } });
    expect(await svc.updateSite({ defaultLanguage: 'fr' }).catch((e: { code?: string }) => e.code)).toBe('REDIRECT_CONFLICT');
    const [site] = await db.select({ lang: sites.defaultLanguage }).from(sites).where(eq(sites.id, SITE));
    expect(site!.lang).toBe('en');
  });

  it('R34 for slug changes: a slug redirect that would join a loop with URL rules is refused; nothing changes', async () => {
    // URL rule /b → /a; renaming the live page a → b would add the content rule /a → /b.
    await db.insert(redirects).values({ siteId: SITE, scope: 'url', locale: '', fromPath: '/b', match: 'exact', toPath: '/a', toLocale: '', source: 'manual' });
    const p = await page('a');
    const err = await new ItemService({ db, siteId: SITE }).patch('pages', p.id, { data: { slug: 'b' }, expectedVersion: p.version }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'REDIRECT_CONFLICT', status: 409 });
    expect(await resolve(MAIN, '/a/')).toMatchObject({ kind: 'item', itemId: p.id });
    expect((await db.select().from(redirects).where(eq(redirects.siteId, SITE))).map((r) => r.scope)).toEqual(['url']);
  });

  it('a settings change whose route rebuild closes a loop, or lands on a reserved path, is a 409 — not a 500', async () => {
    const p = await page('a');
    await db.insert(redirects).values({ siteId: SITE, scope: 'url', locale: '', fromPath: '/renamed/a', match: 'exact', toPath: '/a', toLocale: '', source: 'manual' });
    const loop = await settings(SITE, { permalinks: { articles: '/:slug', pages: '/renamed/:slug', categories: '/category/:slug' } }).catch((e: unknown) => e);
    expect(loop).toBeInstanceOf(ContentSettingsError);
    expect(loop).toMatchObject({ code: 'REDIRECT_CONFLICT', status: 409 });
    const reserved = await settings(SITE, { permalinks: { articles: '/:slug', pages: '/api/:slug', categories: '/category/:slug' } }).catch((e: unknown) => e);
    expect(reserved).toBeInstanceOf(ContentSettingsError);
    expect(reserved).toMatchObject({ code: 'PATH_RESERVED', status: 409 });
    expect(await resolve(MAIN, '/a/')).toMatchObject({ kind: 'item', itemId: p.id });
  });

  describe('language entries joining the address space are checked against the redirects (R36)', () => {
    // Domain strategy, French without an address yet: French /a → /b and URL /b → /a are inert; with a French entry domain they loop.
    beforeEach(async () => {
      await settings(SITE, { availableLocales: ['en', 'fr'], localeStrategy: 'domain' });
      await db.insert(redirects).values([
        { siteId: SITE, scope: 'content', locale: 'fr', fromPath: '/a', match: 'exact', toPath: '/b', toLocale: 'fr', source: 'manual' },
        { siteId: SITE, scope: 'url', locale: '', fromPath: '/b', match: 'exact', toPath: '/a', toLocale: '', source: 'manual' },
      ]);
    });
    const domainsApi = () => {
      const app = new Hono<AppEnv>();
      app.use('*', async (c, next) => {
        (c as unknown as { env: Record<string, unknown> }).env = { HEOPRESS_FREE_DOMAIN_SUFFIX: 'pp-free.example.com' };
        c.set('db', db);
        c.set('siteId', SITE);
        c.set('runtime', { cache: undefined } as unknown as AppEnv['Variables']['runtime']);
        await next();
      });
      app.route('/api/v1/domains', domainsRouter);
      return app;
    };

    it('a free subdomain (live at once) created as the language entry is refused (409); nothing is inserted', async () => {
      const res = await domainsApi().request('/api/v1/domains', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'subdomain', hostname: 'fr', entryLocale: 'fr' }) });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ errors: [{ code: 'REDIRECT_CONFLICT' }] });
      expect(await db.select().from(siteDomains).where(eq(siteDomains.hostname, 'fr.pp-free.example.com'))).toEqual([]);
    });

    it.skipIf(!OWNER_URL)('verification takes the settings lock before touching the domain row', async () => {
      const [d] = await db
        .insert(siteDomains)
        .values({ siteId: SITE, hostname: 'later.pp-main.example.com', kind: 'custom', status: 'pending', verificationToken: 'tok', verificationExpiresAt: new Date(Date.now() + 3_600_000) })
        .returning();
      let outcome: Promise<unknown> | undefined;
      await holdingSettings(async (sql) => {
        outcome = verifyDomainClaim(db, SITE, d!, { txt: async () => ['tok'], httpFile: async () => null });
        await blockedByMe(sql, 1);
        // Blocked on the settings row, the domain row still free: settings first, then the domain.
        const free = await sql`SELECT id FROM lumibase_site_domains WHERE id = ${d!.id} FOR UPDATE NOWAIT`.then(
          () => true,
          () => false,
        );
        expect(free).toBe(true);
      });
      expect(await outcome!).toMatchObject({ verified: true });
    });

    it('a language set while the DNS probe runs is checked when the domain goes live: it stays pending', async () => {
      const [d] = await db
        .insert(siteDomains)
        .values({ siteId: SITE, hostname: 'later.pp-main.example.com', kind: 'custom', status: 'pending', verificationToken: 'tok', verificationExpiresAt: new Date(Date.now() + 3_600_000) })
        .returning();
      let resume: (records: string[]) => void = () => {};
      const probed = new Promise<string[]>((res) => (resume = res));
      const outcome = verifyDomainClaim(db, SITE, d!, { txt: () => probed, httpFile: async () => null });
      // Meanwhile the pending domain is given the language (allowed: it is not live).
      const res = await domainsApi().request(`/api/v1/domains/${d!.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entryLocale: 'fr' }) });
      expect(res.status).toBe(200);
      resume(['tok']);
      expect(await outcome).toMatchObject({ verified: false, reason: 'REDIRECT_CONFLICT' });
      const [after] = await db.select().from(siteDomains).where(eq(siteDomains.id, d!.id));
      expect(after).toMatchObject({ status: 'pending', entryLocale: 'fr' });
    });

    it('giving a live domain the language is refused (409), the domain unchanged', async () => {
      const [d] = await db.insert(siteDomains).values({ siteId: SITE, hostname: 'fr.pp-main.example.com', kind: 'custom', status: 'active', verifiedAt: new Date() }).returning();
      const res = await domainsApi().request(`/api/v1/domains/${d!.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entryLocale: 'fr' }) });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ errors: [{ code: 'REDIRECT_CONFLICT' }] });
      const [after] = await db.select().from(siteDomains).where(eq(siteDomains.id, d!.id));
      expect(after!.entryLocale).toBeNull();
    });

    it('verifying a pending language entry does not make it live', async () => {
      const [d] = await db
        .insert(siteDomains)
        .values({ siteId: SITE, hostname: 'fr.pp-main.example.com', kind: 'custom', status: 'pending', entryLocale: 'fr', verificationToken: 'tok', verificationExpiresAt: new Date(Date.now() + 3_600_000) })
        .returning();
      const outcome = await verifyDomainClaim(db, SITE, d!, { txt: async () => ['tok'], httpFile: async () => null });
      expect(outcome).toMatchObject({ verified: false, reason: 'REDIRECT_CONFLICT' });
      const [after] = await db.select().from(siteDomains).where(eq(siteDomains.id, d!.id));
      expect(after!.status).toBe('pending');
    });
  });

  describe('the redirects API (site administrators): list, check, delete to repair', () => {
    const api = (auth: Record<string, unknown>) => {
      const app = new Hono<AppEnv>();
      app.use('*', async (c, next) => {
        c.set('db', db);
        c.set('siteId', SITE);
        c.set('auth', auth as never);
        await next();
      });
      app.route('/api/v1/redirects', redirectsRouter);
      return app;
    };
    const admin = { type: 'user', raw: { dev: true }, roles: ['admin'] };

    it('two independent bad loops block settings changes; one delete of both repairs the site', async () => {
      const bad = await db
        .insert(redirects)
        .values([
          { siteId: SITE, scope: 'url', locale: '', fromPath: '/bad/one', match: 'exact', toPath: '/bad/one', toLocale: '', source: 'manual' },
          { siteId: SITE, scope: 'url', locale: '', fromPath: '/bad/two', match: 'exact', toPath: '/bad/three', toLocale: '', source: 'manual' },
          { siteId: SITE, scope: 'url', locale: '', fromPath: '/bad/three', match: 'exact', toPath: '/bad/two', toLocale: '', source: 'manual' },
          { siteId: SITE, scope: 'url', locale: '', fromPath: '/fine', match: 'exact', toPath: '/ok', toLocale: '', source: 'manual' },
        ])
        .returning({ id: redirects.id, from: redirects.fromPath });
      expect(await settings(SITE, { timezone: 'Asia/Shanghai' }).catch((e: { code?: string }) => e.code)).toBe('REDIRECT_CONFLICT');

      const listed = (await (await api(admin).request('/api/v1/redirects?check=1')).json()) as { data: unknown[]; meta: { total: number; rejected: Array<{ id: string; reason: string }> } };
      expect(listed.meta.total).toBe(4);
      const badIds = bad.filter((b) => b.from.startsWith('/bad/')).map((b) => b.id);
      expect(listed.meta.rejected.map((r) => r.id).sort()).toEqual([...badIds].sort());

      const del = async (ids: string[]) =>
        (await (await api(admin).request('/api/v1/redirects/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids }) })).json()) as {
          data: { deleted: string[]; rejected: Array<{ id: string }> };
        };
      // Deleting one loop is never refused; the answer names the loop still left.
      const first = await del([badIds[0]!]);
      expect(first.data.deleted).toEqual([badIds[0]]);
      expect(first.data.rejected.map((r) => r.id).sort()).toEqual(badIds.slice(1).sort());
      expect(await del(badIds.slice(1))).toEqual({ data: { deleted: expect.arrayContaining(badIds.slice(1)), rejected: [] } });
      await settings(SITE, { timezone: 'Asia/Shanghai' });
      expect((await db.select().from(redirects).where(eq(redirects.siteId, SITE))).map((r) => r.fromPath)).toEqual(['/fine']);
    });

    it('pages are stable: an exact and a prefix rule from one path each appear once', async () => {
      await db.insert(redirects).values([
        { siteId: SITE, scope: 'url', locale: '', fromPath: '/same', match: 'exact', toPath: '/x', toLocale: '', source: 'manual' },
        { siteId: SITE, scope: 'url', locale: '', fromPath: '/same', match: 'prefix', toPath: '/y', toLocale: '', source: 'manual' },
      ]);
      const pageOf = async (offset: number) =>
        ((await (await api(admin).request(`/api/v1/redirects?limit=1&offset=${offset}`)).json()) as { data: Array<{ id: string; match: string }> }).data;
      const [first, second] = [await pageOf(0), await pageOf(1)];
      expect([first[0]!.match, second[0]!.match]).toEqual(['exact', 'prefix']);
    });

    it('anyone but a site administrator is refused', async () => {
      expect((await api({ type: 'anonymous' }).request('/api/v1/redirects')).status).toBe(403);
      expect((await api({ type: 'anonymous' }).request('/api/v1/redirects/delete', { method: 'POST', body: '{"ids":["x"]}' })).status).toBe(403);
    });
  });

  it('paths stay requestable: a slug too long once encoded is refused; a longer request is a bad path', async () => {
    expect(await page('关'.repeat(300)).catch((e: { code?: string }) => e.code)).toBe('PATH_TOO_LONG');
    expect(await page('a'.repeat(2100)).catch((e: { code?: string }) => e.code)).toBe('PATH_TOO_LONG');
    const longest = await page('b'.repeat(2048 - 19));
    expect(await resolve(MAIN, `/${'b'.repeat(2048 - 19)}`)).toMatchObject({ kind: 'redirect' });
    expect(await resolve(MAIN, `/${'b'.repeat(2048 - 19)}/`)).toMatchObject({ kind: 'item', itemId: longest.id });
    expect(await resolve(MAIN, `/${'c'.repeat(2048)}`)).toMatchObject({ kind: 'not_found', reason: 'bad_path' });
  });

  describe.skipIf(!OWNER_URL)('migration 0023 (as the table owner)', () => {
    it('duplicate language entries from before P05: one stays (active first, then oldest), the others become aliases and say why', async () => {
      const owner = postgres(OWNER_URL!, { max: 1, onnotice: () => {} });
      const [dedupe, createIndex] = readFileSync(MIGRATION_0023, 'utf8').split('--> statement-breakpoint');
      const rolledBack = new Error('rolled back');
      let rows: Array<{ hostname: string; entry_locale: string | null; status_reason: string | null }> = [];
      try {
        await owner
          .begin(async (sql) => {
            await sql`DROP INDEX site_domains_site_entry_locale_unique`;
            await sql`INSERT INTO lumibase_site_domains (id, site_id, hostname, kind, status, entry_locale, created_at) VALUES
              ('dup-old-pending', ${SITE}, 'fr1.pp-main.example.com', 'custom', 'pending', 'fr', now() - interval '3 days'),
              ('dup-active', ${SITE}, 'fr2.pp-main.example.com', 'custom', 'active', 'fr', now() - interval '2 days'),
              ('dup-new-pending', ${SITE}, 'fr3.pp-main.example.com', 'custom', 'pending', 'fr', now() - interval '1 day'),
              ('dup-disabled', ${SITE}, 'fr4.pp-main.example.com', 'custom', 'disabled', 'fr', now() - interval '4 days'),
              ('dup-case', ${SITE}, 'fr5.pp-main.example.com', 'custom', 'pending', 'FR', now() - interval '5 days')`;
            await sql.unsafe(dedupe!);
            // The index the migration creates next holds on what is left.
            await sql.unsafe(createIndex!);
            rows = await sql`SELECT hostname, entry_locale, status_reason FROM lumibase_site_domains WHERE id LIKE 'dup-%' ORDER BY hostname`;
            throw rolledBack;
          })
          .catch((e: unknown) => {
            if (e !== rolledBack) throw e;
          });
      } finally {
        await owner.end({ timeout: 1 });
      }
      expect(rows.map((r) => [r.hostname, r.entry_locale])).toEqual([
        ['fr1.pp-main.example.com', null],
        ['fr2.pp-main.example.com', 'fr'],
        ['fr3.pp-main.example.com', null],
        ['fr4.pp-main.example.com', 'fr'],
        // Another spelling of the same language is a duplicate too.
        ['fr5.pp-main.example.com', null],
      ]);
      expect(rows[0]!.status_reason).toContain('[P05] Language entry "fr" cleared');
    });
  });

  it('a loop in stored rules is not found (with a warning), never a redirect', async () => {
    await db.insert(redirects).values([
      { siteId: SITE, scope: 'content', locale: 'en', fromPath: '/x', match: 'exact', toPath: '/y', toLocale: 'en', source: 'manual' },
      { siteId: SITE, scope: 'content', locale: 'en', fromPath: '/y', match: 'exact', toPath: '/x', toLocale: 'en', source: 'manual' },
    ]);
    expect(await resolve(MAIN, '/x/')).toMatchObject({ kind: 'not_found', reason: 'redirect_loop' });
  });

  it('an unknown host, and a path no route can have', async () => {
    expect(await resolve('nobody.example.org', '/')).toMatchObject({ kind: 'not_found', reason: 'unknown_host', siteId: null });
    expect(await resolve(MAIN, '/%E0%A4%A')).toMatchObject({ kind: 'not_found', reason: 'bad_path' });
    expect(await resolve(MAIN, '/a//b')).toMatchObject({ kind: 'not_found', reason: 'bad_path' });
    expect(await resolve(MAIN, '/a/../b')).toMatchObject({ kind: 'not_found', reason: 'bad_path' });
    // Unicode slugs are decoded for matching and encoded in the address.
    const p = await page('关于');
    expect(await resolve(MAIN, `/${encodeURIComponent('关于')}/`)).toMatchObject({ kind: 'item', itemId: p.id, url: `https://${MAIN}/${encodeURIComponent('关于')}/` });
  });

  it('spec "不同浏览器语言": the language never comes from Accept-Language — the resolver takes no headers', async () => {
    const zh = await page('guide-cn', 'zh-CN');
    const request: PublicPathRequest = { host: MAIN, path: '/zh/guide-cn/' };
    const a = await resolvePublicPath(db, request);
    const b = await resolvePublicPath(db, { ...request });
    expect(a).toEqual(b);
    expect(a).toMatchObject({ itemId: zh.id, locale: 'zh-CN' });
    // The contract, in the source: nothing on the resolution path reads the header.
    const publicSite = join(__dirname, '../../../../packages/public-site/src');
    for (const file of [
      join(__dirname, '../services/site-network/public-path.ts'),
      join(__dirname, '../services/site-network/content-routes.ts'),
      join(publicSite, 'resolve-path.ts'),
      join(publicSite, 'path-space.ts'),
      join(publicSite, 'redirect-engine.ts'),
      join(publicSite, 'space.ts'),
    ]) {
      const source = readFileSync(file, 'utf8');
      expect(source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''), file).not.toMatch(/accept-language/i);
    }
  });

  describe('registering language entry domains (task 3.4)', () => {
    const api = () => {
      const app = new Hono<AppEnv>();
      app.use('*', async (c, next) => {
        (c as unknown as { env: Record<string, unknown> }).env = {};
        c.set('db', db);
        c.set('siteId', SITE);
        c.set('runtime', { cache: undefined } as unknown as AppEnv['Variables']['runtime']);
        await next();
      });
      app.route('/api/v1/domains', domainsRouter);
      return app;
    };
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await api().request(`/api/v1/domains${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const text = await res.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(`${method} ${path} answered ${res.status}: ${text.slice(0, 200)}`);
      }
      return { status: res.status, body: parsed as { data?: { id: string; entryLocale: string | null }; errors?: Array<{ code: string }> } };
    };

    it('only one of the site\'s other languages, stored in the site\'s spelling, one domain per language, never the primary', async () => {
      expect((await call('POST', '', { kind: 'custom', hostname: 'fr.pp-main.example.com', entryLocale: 'fr' })).body.errors?.[0]?.code).toBe('LOCALE_NOT_AVAILABLE');
      expect((await call('POST', '', { kind: 'custom', hostname: 'en.pp-main.example.com', entryLocale: 'en' })).body.errors?.[0]?.code).toBe('DEFAULT_LOCALE');
      const ok = await call('POST', '', { kind: 'custom', hostname: 'zh.pp-main.example.com', entryLocale: 'zh-cn' });
      expect(ok.status).toBe(201);
      expect(ok.body.data?.entryLocale).toBe('zh-CN');
      const second = await call('POST', '', { kind: 'custom', hostname: 'cn.pp-main.example.com', entryLocale: 'zh-CN' });
      expect(second).toMatchObject({ status: 409, body: { errors: [{ code: 'ENTRY_TAKEN' }] } });
      const [primary] = await db.select().from(siteDomains).where(eq(siteDomains.hostname, MAIN));
      expect((await call('PATCH', `/${primary!.id}`, { entryLocale: 'zh-CN' })).body.errors?.[0]?.code).toBe('PRIMARY_DOMAIN');
      // A language entry cannot be made primary.
      const [entry] = await db.select().from(siteDomains).where(eq(siteDomains.hostname, 'zh.pp-main.example.com'));
      await db.update(siteDomains).set({ status: 'active', verifiedAt: new Date() }).where(eq(siteDomains.id, entry!.id));
      expect((await call('POST', `/${entry!.id}/primary`)).body.errors?.[0]?.code).toBe('LANGUAGE_ENTRY');
    });

    it.skipIf(!OWNER_URL)('a domain made primary while a language request waits is seen under the lock: refused', async () => {
      const [d] = await db.insert(siteDomains).values({ siteId: SITE, hostname: 'race.pp-main.example.com', kind: 'custom', status: 'active', verifiedAt: new Date() }).returning();
      let answer: Promise<{ status: number; body: { errors?: Array<{ code: string }> } }> | undefined;
      await holdingSettings(async (sql) => {
        answer = call('PATCH', `/${d!.id}`, { entryLocale: 'zh-CN' });
        await blockedByMe(sql, 1);
        await sql`UPDATE lumibase_site_domains SET is_primary = (id = ${d!.id}) WHERE site_id = ${SITE}`;
      });
      expect(await answer!).toMatchObject({ status: 422, body: { errors: [{ code: 'PRIMARY_DOMAIN' }] } });
      const [after] = await db.select().from(siteDomains).where(eq(siteDomains.id, d!.id));
      expect(after).toMatchObject({ isPrimary: true, entryLocale: null });
    });

    it.skipIf(!OWNER_URL)('a language set while a primary switch waits is seen under the lock: refused', async () => {
      const [d] = await db.insert(siteDomains).values({ siteId: SITE, hostname: 'race.pp-main.example.com', kind: 'custom', status: 'active', verifiedAt: new Date() }).returning();
      let answer: Promise<{ status: number; body: { errors?: Array<{ code: string }> } }> | undefined;
      await holdingSettings(async (sql) => {
        answer = call('POST', `/${d!.id}/primary`);
        await blockedByMe(sql, 1);
        await sql`UPDATE lumibase_site_domains SET entry_locale = 'zh-CN' WHERE id = ${d!.id}`;
      });
      expect(await answer!).toMatchObject({ status: 409, body: { errors: [{ code: 'LANGUAGE_ENTRY' }] } });
      const [after] = await db.select().from(siteDomains).where(eq(siteDomains.id, d!.id));
      expect(after).toMatchObject({ isPrimary: false, entryLocale: 'zh-CN' });
    });

    it('two registrations racing for one language: the index keeps one', async () => {
      expect(await checkEntryLocale(db, SITE, 'zh-CN', { id: null, isPrimary: false })).toBe('zh-CN');
      await entryDomain('zh1.pp-main.example.com', 'zh-CN');
      const err = await entryDomain('zh2.pp-main.example.com', 'zh-CN').catch((e: unknown) => e);
      expect(isEntryLocaleTaken(err)).toBe(true);
    });
  });
});
