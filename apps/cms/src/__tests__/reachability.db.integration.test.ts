import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { crawlDaily, reachabilityReports, reachabilitySites, siteContentSettings, siteDomains, sites, type Database } from '@heopress/database';
import { effectiveSeoSettings } from '@heopress/contracts/schemas';
import { OutboundBlockedError } from '@heopress/runtime/node';
import { robotsTxt, type ReachabilityPlatform } from '@heopress/seo-geo';
import { ItemService } from '../services/item-service';
import { ContentSettingsService } from '../services/site-network/content-settings-service';
import { upgradeSitePreset } from '../services/site-network/preset-installer';
import { rebuildSiteProjection } from '../services/site-network/public-projection';
import { SeoSettingsService } from '../services/site-network/seo-settings-service';
import {
  processReachabilityChecks,
  ReachabilityError,
  reachabilityViewOf,
  requestReachabilityCheck,
  runReachabilityCheck,
  type ProbeFetch,
  type ReachabilityReport,
} from '../services/site-network/reachability';
import { runSiteTransaction } from '../services/rls-transaction';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';

/**
 * The online reachability check (HeoPress P07 task 3.9; spec seo/crawl-discovery "线上可达性体检"): only the site's
 * verified domains are checked (an unbound, pending, other site's or alias domain is refused); a block and a wrong type
 * are reported with the platform's advice; a turned-off copy and a noindex page are not reported. No request leaves the
 * process: a fake site answers through the injected fetch.
 */

const A = 'site_p07_reach_a';
const B = 'site_p07_reach_b';
const HOST_A = 'reach-a.example.com';
const HOST_B = 'reach-b.example.com';

interface FakeSite {
  /** Answers a crawler's User-Agent with 403. */
  blockUa?: RegExp;
  /** The Markdown copies' type (the scenario of a static host serving them as octet-stream). */
  mdType?: string;
  /** Serves the copies (a stale cache after they were turned off). */
  copiesServed?: boolean;
  /** Drops the noindex header of a noindex page (a proxy stripping it). */
  stripNoindex?: boolean;
  /** The robots.txt it serves, if not the site's own. */
  robots?: string;
  /** On the French language entry domain: its home answers 500, its noindex page lost its noindex, a copy is served there. */
  entryHome500?: boolean;
  entryStripNoindex?: boolean;
  entryCopyServed?: boolean;
  /** No answer to these User-Agents the first `times` requests (a timeout). */
  timeoutUa?: { ua: RegExp; times: number };
}

const HOST_FR = 'fr-reach-a.example.com';

describe.skipIf(!hasDbIntegrationUrl)('online reachability check — DB integration', () => {
  let db: Database;

  beforeAll(async () => {
    db = await connectDbIntegration('reachability');
  });
  afterAll(async () => {
    await db?.delete(sites).where(inArray(sites.id, [A, B]));
  });
  beforeEach(async () => {
    await db.delete(sites).where(inArray(sites.id, [A, B]));
    await db.insert(sites).values([
      { id: A, name: 'Reach A', defaultLanguage: 'en' },
      { id: B, name: 'Reach B', defaultLanguage: 'en' },
    ]);
    for (const id of [A, B]) await upgradeSitePreset(db, id);
    await db.insert(siteDomains).values([
      { siteId: A, hostname: HOST_A, kind: 'custom', status: 'active', isPrimary: true, verifiedAt: new Date() },
      { siteId: A, hostname: 'alias-a.example.com', kind: 'custom', status: 'active', isPrimary: false, verifiedAt: new Date() },
      { siteId: A, hostname: 'pending-a.example.com', kind: 'custom', status: 'pending' },
      { siteId: B, hostname: HOST_B, kind: 'custom', status: 'active', isPrimary: true, verifiedAt: new Date() },
    ]);
    for (const id of [A, B]) {
      const [r] = await db.select().from(siteContentSettings).where(eq(siteContentSettings.siteId, id));
      await new ContentSettingsService({ db, siteId: id, actor: { userId: null } }).update({
        availableLocales: r!.availableLocales, timezone: r!.timezone, siteType: 'blog', trailingSlash: 'always', localeStrategy: 'subdirectory',
        localePrefixMode: 'default_at_root', localePrefixes: {}, permalinks: { articles: '/:slug', pages: '/:slug' },
        allowCrossSiteTranslations: false, sponsorDisclosure: true, sponsorRel: true, version: r!.version,
      } as never);
      await rebuildSiteProjection(db, id);
    }
    const items = new ItemService({ db, siteId: A });
    await items.create('articles', { data: { title: 'Hidden', slug: 'hidden', locale: 'en', excerpt: 'Not indexed.', body: '<p>Hidden.</p>', seo_robots: 'noindex,follow' }, status: 'published' });
    await items.create('articles', { data: { title: 'Open', slug: 'open', locale: 'en', excerpt: 'Indexed.', body: '<p>Open.</p>' }, status: 'published' });
  });

  const seoOf = async (siteId: string) => effectiveSeoSettings((await new SeoSettingsService({ db, siteId, actor: { userId: null } }).get()).settings);
  const setDiscovery = async (siteId: string, discovery: Record<string, unknown>) => {
    const svc = new SeoSettingsService({ db, siteId, actor: { userId: null } });
    const { settings, version } = await svc.get();
    await svc.update({ ...settings, version, discovery: { ...settings.discovery, ...discovery } });
  };

  /** A site as a well-configured server answers it, with the faults `f` asks for; every request recorded. */
  const fakeSite = async (siteId: string, f: FakeSite = {}) => {
    const seo = await seoOf(siteId);
    const calls: Array<{ url: string; ua: string }> = [];
    const answer = (body: string, type: string, status = 200, headers: Record<string, string> = {}) => new Response(body, { status, headers: { 'content-type': type, ...headers } });
    const notFound = () => answer('<html><head><title>Not found</title><meta name="robots" content="noindex"></head></html>', 'text/html; charset=utf-8', 404);
    const page = (robots: string, header = true) =>
      answer(`<html><head><meta name="robots" content="${header ? robots : 'max-image-preview:large'}"></head><body>x</body></html>`, 'text/html; charset=utf-8', 200, header && robots.includes('noindex') ? { 'x-robots-tag': robots } : {});
    const fetch: ProbeFetch = async (url, init) => {
      const ua = init.headers['user-agent'] ?? '';
      calls.push({ url, ua });
      if (f.blockUa?.test(ua)) return answer('<html><head><title>Forbidden</title></head></html>', 'text/html', 403);
      if (f.timeoutUa?.ua.test(ua) && f.timeoutUa.times-- > 0) throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
      const { host, pathname } = new URL(url);
      const d = seo.discovery;
      const entry = host === HOST_FR;
      // The French pages: under /fr/ on the primary domain (their canonical addresses), at their content paths on the entry domain.
      const local = pathname.replace(/^\/fr\//, '/');
      if (entry || pathname !== local) {
        if (entry && pathname === '/') return f.entryHome500 ? answer('oops', 'text/html', 500) : page('max-image-preview:large');
        if (local === '/' || local === '/salut/') return page('max-image-preview:large');
        if (local === '/cache/') return page('noindex', !(entry ? f.entryStripNoindex : f.stripNoindex));
        // A copy is served at the canonical address only (the primary domain's).
        if (local === '/salut.md') return (entry ? f.entryCopyServed : d.markdownCopies) ? answer('# Salut\n', 'text/markdown; charset=utf-8', 200, { 'x-robots-tag': 'noindex' }) : notFound();
        if (!entry) return notFound();
      }
      switch (pathname) {
        case '/robots.txt':
          return answer(f.robots ?? robotsTxt({ settings: seo, origin: `https://${host}` }), 'text/plain; charset=utf-8');
        case '/sitemap.xml':
          return answer('<?xml version="1.0"?><sitemapindex/>', 'application/xml; charset=utf-8');
        case '/sitemap.txt':
          return answer(`https://${host}/open/\n`, 'text/plain; charset=utf-8');
        case '/llms.txt':
        case '/llms-full.txt':
          return d.llms ? answer('# Reach\n', 'text/plain; charset=utf-8') : notFound();
        case '/news-sitemap.xml':
          return d.newsSitemap ? answer('<urlset/>', 'application/xml; charset=utf-8') : notFound();
        case '/feed.xml':
          return d.feeds ? answer('<rss/>', 'application/rss+xml; charset=utf-8') : notFound();
        case '/atom.xml':
          return d.feeds ? answer('<feed/>', 'application/atom+xml; charset=utf-8') : notFound();
        case '/':
          return page('max-image-preview:large');
        case '/open/':
          return page('max-image-preview:large');
        case '/hidden/':
          return page('noindex', !f.stripNoindex);
        case '/open.md':
          return d.markdownCopies || f.copiesServed ? answer('# Open\n', f.mdType ?? 'text/markdown; charset=utf-8', 200, { 'x-robots-tag': 'noindex' }) : notFound();
        default:
          return notFound();
      }
    };
    return { fetch, calls };
  };

  const run = async (siteId: string, fetch: ProbeFetch, platform: ReachabilityPlatform = 'vps', sampleScan?: number) =>
    (await runReachabilityCheck(db, siteId, { platform, hosts: null }, { fetch, sleep: async () => undefined, sampleScan }))!;
  /** Site A in English and French (subdirectory strategy) with an active French entry domain. */
  const withFrenchEntry = async () => {
    const [r] = await db.select().from(siteContentSettings).where(eq(siteContentSettings.siteId, A));
    await new ContentSettingsService({ db, siteId: A, actor: { userId: null } }).update({
      availableLocales: ['en', 'fr'], timezone: r!.timezone, siteType: 'blog', trailingSlash: 'always', localeStrategy: 'subdirectory',
      localePrefixMode: 'default_at_root', localePrefixes: {}, permalinks: { articles: '/:slug', pages: '/:slug' },
      allowCrossSiteTranslations: false, sponsorDisclosure: true, sponsorRel: true, version: r!.version,
    } as never);
    await db.insert(siteDomains).values({ siteId: A, hostname: HOST_FR, kind: 'custom', status: 'active', isPrimary: false, entryLocale: 'fr', verifiedAt: new Date() });
    await rebuildSiteProjection(db, A);
  };
  const failures = (r: ReachabilityReport) => [
    ...r.checks.filter((c) => !c.ok).map((c) => `${c.code} ${c.kind} ${c.url}`),
    ...r.crawlers.filter((c) => !c.ok).map((c) => `${c.code} ${c.crawler}`),
  ];

  it('scenario 未绑定域名: an unbound, pending, alias or other site\'s domain is refused; nothing is requested', async () => {
    for (const host of ['unbound.example.com', 'pending-a.example.com', 'alias-a.example.com', HOST_B, '169.254.169.254', 'localhost']) {
      const err = await requestReachabilityCheck(db, A, { hosts: [host] }).catch((e: unknown) => e);
      expect(err, host).toBeInstanceOf(ReachabilityError);
      expect((err as ReachabilityError).code, host).toBe('DOMAIN_NOT_VERIFIED');
      expect((err as ReachabilityError).status).toBe(422);
    }
    expect(await db.select().from(reachabilitySites).where(eq(reachabilitySites.siteId, A))).toEqual([]);
    // Its own verified domain: accepted (any case, a trailing dot).
    await requestReachabilityCheck(db, A, { hosts: [`${HOST_A.toUpperCase()}.`], platform: 'cloudflare' });
    const [state] = await db.select().from(reachabilitySites).where(eq(reachabilitySites.siteId, A));
    expect(state).toMatchObject({ hosts: [HOST_A], platform: 'cloudflare' });
    expect(state!.requestedAt).not.toBeNull();
    // A site with no verified domain: nothing to check.
    await db.update(siteDomains).set({ status: 'disabled' }).where(eq(siteDomains.siteId, B));
    await expect(requestReachabilityCheck(db, B, {})).rejects.toMatchObject({ code: 'NO_VERIFIED_DOMAIN' });
    await expect(requestReachabilityCheck(db, A, { platform: 'heroku' })).rejects.toMatchObject({ code: 'INVALID' });
  });

  it('a well-configured site: no fault — the noindex page answers with noindex, robots.txt is the site\'s; requests only to the verified host', async () => {
    const site = await fakeSite(A);
    const report = await run(A, site.fetch);
    expect(failures(report)).toEqual([]);
    expect(report.summary.errors).toBe(0);
    expect(report.hosts).toEqual([{ hostname: HOST_A, primary: true, locale: null, reachable: true, skipped: null }]);
    const hidden = report.checks.find((c) => c.url === `https://${HOST_A}/hidden/`)!;
    expect(hidden).toMatchObject({ kind: 'page', expected: 'public', ok: true, status: 200 });
    expect(report.checks.find((c) => c.url === `https://${HOST_A}/hidden.md`)).toMatchObject({ expected: 'absent', ok: true, status: 404 });
    expect(report.checks.find((c) => c.url === `https://${HOST_A}/open.md`)).toMatchObject({ expected: 'public', ok: true });
    // Every simulated crawler result is marked so, with the note.
    expect(report.crawlers.length).toBeGreaterThan(0);
    expect(report.crawlers.every((c) => c.simulated === true && c.outcome === 'served')).toBe(true);
    expect(report.simulationNote).toMatch(/Simulated/);
    expect(new Set(site.calls.map((c) => new URL(c.url).host))).toEqual(new Set([HOST_A]));
    expect(site.calls.some((c) => /GPTBot\/1\.0/.test(c.ua))).toBe(true);
    // The report is kept in the site's scope, and shown.
    const view = await reachabilityViewOf(db, A);
    expect(view.report?.summary.errors).toBe(0);
    expect(view.hosts.map((h) => h.hostname)).toEqual([HOST_A]);
    // Another site sees its own (none); row-level security on the reports: rls.db.test.ts.
    expect((await reachabilityViewOf(db, B)).report).toBeNull();
    expect(await runSiteTransaction(db, A, (tx) => tx.select({ errors: reachabilityReports.errors }).from(reachabilityReports).where(eq(reachabilityReports.siteId, A)))).toEqual([{ errors: 0 }]);
  });

  it('scenario 站点关闭了 Markdown 副本 + noindex 页: copies, feeds and llms off — verified not public, not reported', async () => {
    await setDiscovery(A, { markdownCopies: false, feeds: false, llms: false });
    const report = await run(A, (await fakeSite(A)).fetch);
    expect(failures(report)).toEqual([]);
    const copy = report.checks.find((c) => c.url === `https://${HOST_A}/open.md`)!;
    expect(copy).toMatchObject({ expected: 'absent', ok: true, status: 404, because: 'Markdown copies are off' });
    for (const path of ['/llms.txt', '/feed.xml', '/atom.xml']) expect(report.checks.find((c) => c.url === `https://${HOST_A}${path}`), path).toMatchObject({ expected: 'absent', ok: true });
    // Served though off (a stale cache): exposed, with the advice to purge.
    const stale = await run(A, (await fakeSite(A, { copiesServed: true })).fetch, 'cloudflare');
    expect(stale.checks.find((c) => c.url === `https://${HOST_A}/open.md`)).toMatchObject({ ok: false, code: 'exposed', severity: 'error' });
    expect(stale.checks.find((c) => c.code === 'exposed')!.advice).toMatch(/purge/i);
  });

  it('a noindex page that loses its noindex on the way is reported', async () => {
    const report = await run(A, (await fakeSite(A, { stripNoindex: true })).fetch);
    expect(failures(report)).toEqual([`missing-noindex page https://${HOST_A}/hidden/`]);
  });

  it('scenario CDN 拦截 AI 爬虫: robots allows GPTBot, the home page answers it 403 — reported as blocked, simulated, with Cloudflare advice', async () => {
    const report = await run(A, (await fakeSite(A, { blockUa: /GPTBot/ })).fetch, 'cloudflare');
    expect(failures(report)).toEqual(['crawler-blocked gptbot']);
    const gpt = report.crawlers.find((c) => c.crawler === 'gptbot')!;
    expect(gpt).toMatchObject({ simulated: true, allowedByRobots: true, status: 403, outcome: 'blocked', severity: 'error' });
    expect(gpt.detail).toMatch(/robots\.txt allows GPTBot/);
    expect(gpt.advice).toMatch(/Cloudflare/);
    // The site keeps training crawlers out: the same 403 is as chosen — no fault.
    const svc = new SeoSettingsService({ db, siteId: A, actor: { userId: null } });
    const { settings, version } = await svc.get();
    await svc.update({ ...settings, version, crawlers: { ...settings.crawlers, purposes: { ...settings.crawlers.purposes, training: 'disallow' } } });
    const chosen = await run(A, (await fakeSite(A, { blockUa: /GPTBot/ })).fetch, 'cloudflare');
    expect(failures(chosen)).toEqual([]);
    expect(chosen.crawlers.find((c) => c.crawler === 'gptbot')).toMatchObject({ allowedByRobots: false, outcome: 'kept-out', ok: true });
  });

  it('a CDN-managed robots.txt that keeps out what the site lets in is reported', async () => {
    const report = await run(A, (await fakeSite(A, { robots: 'User-agent: ClaudeBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n' })).fetch, 'cloudflare');
    expect(failures(report)).toEqual(['robots-differs claudebot']);
    expect(report.crawlers.find((c) => c.code === 'robots-differs')!.advice).toMatch(/managed robots\.txt/);
  });

  it('scenario Markdown 副本类型错误: a copy served as application/octet-stream — a type error, with the platform\'s header setting', async () => {
    const report = await run(A, (await fakeSite(A, { mdType: 'application/octet-stream' })).fetch, 'netlify');
    expect(failures(report)).toEqual([`wrong-type markdown-copy https://${HOST_A}/open.md`]);
    const copy = report.checks.find((c) => c.code === 'wrong-type')!;
    expect(copy.contentType).toBe('application/octet-stream');
    expect(copy.advice).toContain('/*.md\n  Content-Type: text/markdown; charset=utf-8');
  });

  it('an AI crawler the site lets in that stopped reading it: a hint; one it keeps out: none', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const day = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
    await runSiteTransaction(db, A, (tx) =>
      tx.insert(crawlDaily).values(
        ['claudebot', 'bytespider'].flatMap((agent) =>
          Array.from({ length: 14 }, (_, i) => ({ siteId: A, day: day(4 + i), kind: 'crawler', agent, operator: 'x', purpose: 'training', resource: 'page', path: '/', hits: 12 })),
        ),
      ),
    );
    const svc = new SeoSettingsService({ db, siteId: A, actor: { userId: null } });
    const { settings, version } = await svc.get();
    await svc.update({ ...settings, version, crawlers: { ...settings.crawlers, overrides: { bytespider: 'disallow' } } });
    const report = await run(A, (await fakeSite(A)).fetch, 'vercel');
    expect(report.traffic.map((t) => [t.agent, t.kind])).toEqual([['claudebot', 'stopped']]);
    expect(report.traffic[0]!.detail).toMatch(/CDN or firewall/);
    expect(report.traffic[0]!.advice).toMatch(/Vercel/);
    expect(report.summary.warnings).toBe(1);
  });

  it('the worker runs what was asked for; a domain disabled since is skipped and never requested; then a minute before the next', async () => {
    await db.update(siteDomains).set({ entryLocale: 'fr' }).where(eq(siteDomains.hostname, 'alias-a.example.com'));
    await requestReachabilityCheck(db, A, { hosts: [HOST_A, 'alias-a.example.com'] });
    await db.update(siteDomains).set({ status: 'disabled' }).where(eq(siteDomains.hostname, 'alias-a.example.com'));
    const site = await fakeSite(A);
    const done = await processReachabilityChecks(db, { fetch: site.fetch, sleep: async () => undefined });
    expect(done).toEqual([{ siteId: A, status: 'done' }]);
    const view = await reachabilityViewOf(db, A);
    expect(view.run).toMatchObject({ requested: false, status: 'done' });
    expect(view.report!.hosts.find((h) => h.hostname === 'alias-a.example.com')!.skipped).toMatch(/No longer a verified domain/);
    expect(site.calls.every((c) => new URL(c.url).host === HOST_A)).toBe(true);
    await expect(requestReachabilityCheck(db, A, {})).rejects.toMatchObject({ code: 'TOO_SOON', status: 429 });
    await requestReachabilityCheck(db, A, {}, new Date(Date.now() + 120_000));
    expect((await reachabilityViewOf(db, A)).run.requested).toBe(true);
  });

  it('a language entry domain under the subdirectory strategy: its home, pages, noindex page, copies and crawlers are checked at its own addresses', async () => {
    await withFrenchEntry();
    const items = new ItemService({ db, siteId: A });
    await items.create('articles', { data: { title: 'Caché', slug: 'cache', locale: 'fr', excerpt: 'Non.', body: '<p>Non.</p>', seo_robots: 'noindex,follow' }, status: 'published' });
    await items.create('articles', { data: { title: 'Salut', slug: 'salut', locale: 'fr', excerpt: 'Oui.', body: '<p>Oui.</p>' }, status: 'published' });

    const report = await run(A, (await fakeSite(A)).fetch);
    expect(failures(report)).toEqual([]);
    expect(report.hosts.map((h) => [h.hostname, h.reachable])).toEqual([[HOST_A, true], [HOST_FR, true]]);
    const fr = report.checks.filter((c) => c.host === HOST_FR);
    const at = (kind: string, url: string) => fr.find((c) => c.kind === kind && c.url === url);
    expect(at('home', `https://${HOST_FR}/`)).toMatchObject({ ok: true, status: 200 });
    expect(at('page', `https://${HOST_FR}/salut/`)).toMatchObject({ ok: true, expected: 'public' });
    expect(at('page', `https://${HOST_FR}/cache/`)).toMatchObject({ ok: true, expected: 'public', because: expect.stringMatching(/not indexable/) });
    // The copy lives at the canonical address (the primary domain's /fr/salut.md), not on the entry domain.
    expect(at('markdown-copy', `https://${HOST_FR}/salut.md`)).toMatchObject({ ok: true, expected: 'absent', because: expect.stringMatching(/canonical address only/) });
    expect(report.checks.find((c) => c.url === `https://${HOST_A}/fr/salut.md`)).toMatchObject({ ok: true, expected: 'public' });
    expect(report.crawlers.filter((c) => c.host === HOST_FR).every((c) => c.outcome === 'served')).toBe(true);

    // On the entry domain: a 500 home, a noindex page that lost its noindex, a copy served — each reported.
    const broken = await run(A, (await fakeSite(A, { entryHome500: true, entryStripNoindex: true, entryCopyServed: true })).fetch);
    expect(failures(broken)).toEqual([
      `error-status home https://${HOST_FR}/`,
      `exposed markdown-copy https://${HOST_FR}/salut.md`,
      `missing-noindex page https://${HOST_FR}/cache/`,
    ]);
    // The browser gets a 500 there: the crawlers are inconclusive, not blamed.
    expect(broken.crawlers.filter((c) => c.host === HOST_FR).every((c) => c.outcome === 'inconclusive' && c.ok)).toBe(true);
  });

  it('a dominant language does not crowd out the entry domain\'s: older French pages are still sampled on it', async () => {
    await withFrenchEntry();
    const items = new ItemService({ db, siteId: A });
    await items.create('articles', { data: { title: 'Caché', slug: 'cache', locale: 'fr', excerpt: 'Non.', body: '<p>Non.</p>', seo_robots: 'noindex,follow' }, status: 'published' });
    await items.create('articles', { data: { title: 'Salut', slug: 'salut', locale: 'fr', excerpt: 'Oui.', body: '<p>Oui.</p>' }, status: 'published' });
    // Many newer English pages than the bound looks at (3 rows a language here, standing for the real bound).
    for (let i = 0; i < 6; i++) await items.create('articles', { data: { title: `New ${i}`, slug: `new-${i}`, locale: 'en', excerpt: 'New.', body: '<p>New.</p>' }, status: 'published' });
    const report = await run(A, (await fakeSite(A)).fetch, 'vps', 3);
    const fr = report.checks.filter((c) => c.host === HOST_FR && c.kind === 'page').map((c) => [c.url, c.because]);
    expect(fr).toEqual([
      [`https://${HOST_FR}/salut/`, 'A listable page'],
      [`https://${HOST_FR}/cache/`, 'A page that is not indexable: it answers and says noindex'],
    ]);
    // The primary domain is sampled too (its newest pages, of every language it serves).
    expect(report.checks.filter((c) => c.host === HOST_A && c.kind === 'page').length).toBeGreaterThan(0);
  });

  it('a simulated crawler request with no answer is asked again; no answer twice is inconclusive, never a block', async () => {
    const once = await fakeSite(A, { timeoutUa: { ua: /GPTBot/, times: 1 } });
    const retried = await run(A, once.fetch);
    expect(retried.crawlers.find((c) => c.crawler === 'gptbot')).toMatchObject({ outcome: 'served', ok: true, status: 200 });
    expect(once.calls.filter((c) => /GPTBot/.test(c.ua))).toHaveLength(2);
    const twice = await run(A, (await fakeSite(A, { timeoutUa: { ua: /GPTBot/, times: 2 } })).fetch);
    expect(twice.crawlers.find((c) => c.crawler === 'gptbot')).toMatchObject({ outcome: 'inconclusive', ok: true, code: null, status: null });
    expect(failures(twice)).toEqual([]);
  });

  it('every robots meta tag counts: a later noindex (or googlebot noindex) after an index tag is a noindex', async () => {
    const pages: Record<string, string> = {
      '/hidden/': '<meta name="robots" content="index, follow"><meta name="robots" content="noindex">',
      '/open/': '<meta name="robots" content="max-image-preview:large"><meta name="GoogleBot" content="noindex">',
    };
    const base = await fakeSite(A, { stripNoindex: true });
    const fetch: ProbeFetch = async (url, init) => {
      const html = pages[new URL(url).pathname];
      return html ? new Response(`<html><head>${html}</head></html>`, { headers: { 'content-type': 'text/html' } }) : base.fetch(url, init);
    };
    const report = await run(A, fetch);
    // The noindex page says noindex in its second tag: no fault; the open page says noindex to Googlebot: a fault.
    expect(failures(report)).toEqual([`unexpected-noindex page https://${HOST_A}/open/`]);
  });

  it('a host that does not answer is not asked the rest; the outbound policy\'s refusal is reported, not thrown', async () => {
    const refused: ProbeFetch = async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: new OutboundBlockedError(`${HOST_A} resolves to a non-public address`) });
    };
    const report = await run(A, refused);
    expect(report.hosts[0]!.reachable).toBe(false);
    const robots = report.checks.find((c) => c.kind === 'robots')!;
    expect(robots).toMatchObject({ ok: false, code: 'unreachable', error: `refused by the outbound policy: ${HOST_A} resolves to a non-public address` });
    expect(report.checks.filter((c) => c.skipped).length).toBe(report.checks.length - 1);
    expect(report.crawlers.every((c) => c.outcome === 'skipped')).toBe(true);
  });
});
