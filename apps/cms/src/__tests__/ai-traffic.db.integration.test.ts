import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { crawlDaily, crawlDailyPaths, crawlHits, ensureRenderRole, schema, siteContentSettings, siteDomains, sites, type Database } from '@heopress/database';
import { createSiteClassic, type SiteClassic } from '@heopress/site-classic';
import { renderPort } from '@heopress/site-classic/read-port';
import { AI_CRAWLERS, TrafficRecorder } from '@heopress/site-classic/ai-traffic';
import { AI_REFERRERS } from '@heopress/seo-geo';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ItemService } from '../services/item-service';
import { ContentSettingsService } from '../services/site-network/content-settings-service';
import { upgradeSitePreset } from '../services/site-network/preset-installer';
import { rebuildSiteProjection } from '../services/site-network/public-projection';
import { aiTrafficReport, purgeCrawlHits } from '../services/site-network/ai-traffic';
import { runSiteTransaction } from '../services/rls-transaction';
import { connectDbIntegration, dbIntegrationUrl, hasDbIntegrationUrl } from './helpers/db-harness';

/**
 * AI traffic end to end (HeoPress P07 tasks 6.1, 6.2, 6.4; spec analytics/ai-traffic): the rendering service, as its own
 * role, records what a known crawler or an AI-referred visitor asked for — through the checked entry only — and nothing
 * of the request beyond it (no address, User-Agent, referrer or query); previews and requests with a token are not
 * recorded; the details go after 7 days, the day totals stay; each site reads its own.
 */

const A = 'site_p07_traffic_a';
const B = 'site_p07_traffic_b';
const HOST_A = 'traffic-a.example.com';
const HOST_B = 'traffic-b.example.com';
const RENDER_ROLE = 'heopress_render_traffic_it';
const OWNER_URL = process.env.DATABASE_OWNER_URL?.trim() || undefined;
const PERPLEXITY_USER = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)';
const GPTBOT = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot';
const BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

describe.skipIf(!hasDbIntegrationUrl)('AI traffic — DB integration', () => {
  let db: Database;
  let owner: postgres.Sql;
  let renderClient: postgres.Sql;
  let renderDb: Database;
  let service: SiteClassic;
  let recorder: TrafficRecorder;

  beforeAll(async () => {
    expect(OWNER_URL, 'DATABASE_OWNER_URL is required to provision the rendering role').toBeDefined();
    db = await connectDbIntegration('ai-traffic');
    owner = postgres(OWNER_URL!, { max: 1, onnotice: () => {} });
    const password = randomBytes(18).toString('hex');
    await owner.begin((tx) => ensureRenderRole(tx, { role: RENDER_ROLE, password }));
    const url = new URL(dbIntegrationUrl!);
    url.username = RENDER_ROLE;
    url.password = password;
    renderClient = postgres(url.toString(), { max: 2, onnotice: () => {} });
    renderDb = drizzle(renderClient, { schema }) as unknown as Database;
    recorder = new TrafficRecorder((hit) => renderPort(renderDb).recordCrawlHit(hit));
    service = createSiteClassic({ db: renderDb, traffic: recorder, sweepIntervalMs: 0 });
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
      { id: A, name: 'Traffic A', defaultLanguage: 'en' },
      { id: B, name: 'Traffic B', defaultLanguage: 'en' },
    ]);
    for (const id of [A, B]) await upgradeSitePreset(db, id);
    await db.insert(siteDomains).values([
      { siteId: A, hostname: HOST_A, kind: 'custom', status: 'active', isPrimary: true, verifiedAt: new Date() },
      { siteId: B, hostname: HOST_B, kind: 'custom', status: 'active', isPrimary: true, verifiedAt: new Date() },
    ]);
    for (const id of [A, B]) {
      const [r] = await db.select().from(siteContentSettings).where(eq(siteContentSettings.siteId, id));
      await new ContentSettingsService({ db, siteId: id, actor: { userId: null } }).update({
        availableLocales: r!.availableLocales, timezone: r!.timezone, siteType: 'blog', trailingSlash: 'always', localeStrategy: 'subdirectory',
        localePrefixMode: 'default_at_root', localePrefixes: {}, permalinks: { ...r!.permalinks, articles: '/:slug' },
        allowCrossSiteTranslations: false, sponsorDisclosure: true, sponsorRel: true, version: r!.version,
      } as never);
      await rebuildSiteProjection(db, id);
    }
    await new ItemService({ db, siteId: A }).create('articles', { data: { title: 'Read me', slug: 'read-me', locale: 'en', body: '<p>x</p>' }, status: 'published' });
  });

  const get = (host: string, path: string, headers: Record<string, string> = {}) => service.app.request(path, { headers: { host, ...headers } });
  const settle = async () => {
    await expect.poll(() => recorder.pending, { timeout: 5000 }).toBe(0);
  };
  const hitsOf = (siteId: string) => runSiteTransaction(db, siteId, (tx) => tx.select().from(crawlHits).where(eq(crawlHits.siteId, siteId)).orderBy(crawlHits.at));
  const dailyOf = (siteId: string) => runSiteTransaction(db, siteId, (tx) => tx.select().from(crawlDaily).where(eq(crawlDaily.siteId, siteId)));

  it('a user-triggered fetch, a training crawler on llms.txt, an AI-referred visit (by its utm_source): each recorded with what it was', async () => {
    expect((await get(HOST_A, '/read-me/', { 'user-agent': PERPLEXITY_USER, 'x-forwarded-for': '203.0.113.9' })).status).toBe(200);
    await get(HOST_A, '/llms.txt', { 'user-agent': GPTBOT });
    await get(HOST_A, '/robots.txt', { 'user-agent': GPTBOT });
    await get(HOST_A, '/read-me/?utm_source=chatgpt.com&utm_medium=x', { 'user-agent': BROWSER });
    // A second read of the page (a cache hit) counts too.
    await get(HOST_A, '/read-me/', { 'user-agent': PERPLEXITY_USER });
    // An ordinary visit: nothing.
    await get(HOST_A, '/read-me/', { 'user-agent': BROWSER, referer: 'https://www.google.com/' });
    await settle();
    const hits = await hitsOf(A);
    expect(hits.map((h) => [h.kind, h.agent, h.operator, h.purpose, h.resource, h.path, h.status])).toEqual([
      ['crawler', 'perplexity-user', 'Perplexity', 'user-fetch', 'page', '/read-me/', 200],
      ['crawler', 'gptbot', 'OpenAI', 'training', 'llms', '/llms.txt', 200],
      ['crawler', 'gptbot', 'OpenAI', 'training', 'robots', '/robots.txt', 200],
      ['referral', 'chatgpt', 'OpenAI', null, 'page', '/read-me/', 200],
      ['crawler', 'perplexity-user', 'Perplexity', 'user-fetch', 'page', '/read-me/', 200],
    ]);
    // Never the address, the User-Agent, the referrer or the query; the address only as a hash.
    const stored = JSON.stringify([...hits, ...(await dailyOf(A))]);
    for (const secret of ['203.0.113.9', 'Mozilla', 'utm_', 'chatgpt.com', 'google']) expect(stored).not.toContain(secret);
    // No address here (no socket, no trusted proxy): no hash. The hash itself: the renderer's unit tests.
    expect(hits[0]!.ipHash).toBeNull();
    const page = (await dailyOf(A)).find((d) => d.agent === 'perplexity-user');
    expect(page).toMatchObject({ kind: 'crawler', resource: 'page', path: '/read-me/', hits: 2 });
    // The other site has none.
    expect(await hitsOf(B)).toEqual([]);
  });

  it('a token in the query, an administration path: not recorded; the rendering role cannot write the tables itself, nor name another site', async () => {
    await get(HOST_A, '/read-me/?token=secret-preview-token', { 'user-agent': GPTBOT });
    // The preview origin: never recorded, whatever asks.
    const previewWrites: unknown[] = [];
    const previewed = new TrafficRecorder(async (hit) => void previewWrites.push(hit));
    const withPreview = createSiteClassic({
      db: renderDb,
      traffic: previewed,
      sweepIntervalMs: 0,
      preview: { origin: 'https://preview.traffic.example.net', cmsUrl: 'http://cms.internal', secret: 's'.repeat(32), fetch: () => Promise.resolve(new Response('{}', { status: 404 })) },
    });
    await withPreview.app.request(`/${A}/read-me/`, { headers: { host: 'preview.traffic.example.net', 'user-agent': GPTBOT, cookie: 'heopress_preview=tok' } });
    // A request on a public host through the same service is recorded (the check is not vacuous).
    await withPreview.app.request('/read-me/', { headers: { host: HOST_A, 'user-agent': GPTBOT } });
    expect(previewWrites).toHaveLength(1);
    expect(JSON.stringify(previewWrites)).not.toContain('preview');
    await withPreview.close();
    await get(HOST_A, '/admin/x', { 'user-agent': GPTBOT });
    await settle();
    expect(await hitsOf(A)).toEqual([]);
    // As the rendering role: no INSERT on the tables; the entry resolves the site from the host (an unknown host: nothing).
    const denied = async (q: Promise<unknown>) => {
      const err = await q.then(() => null, (e: unknown) => e as { message: string; cause?: { message?: string } });
      expect(String(err?.cause?.message ?? err?.message)).toMatch(/permission denied/);
    };
    await denied(renderDb.execute(sql`INSERT INTO lumibase_crawl_hits (site_id, kind, agent, operator, resource, path, status) VALUES (${A}, 'crawler', 'x', 'x', 'page', '/', 200)`));
    await denied(renderDb.execute(sql`SELECT * FROM lumibase_crawl_daily`));
    await renderDb.execute(sql`SELECT public.lumibase_record_crawl_hit('nowhere.example.com', 'crawler', 'gptbot', 'OpenAI', 'training', 'page', '/', NULL, 200)`);
    // Values the entry refuses are dropped: a query in the path, an unknown resource, a raw address as the hash.
    await renderDb.execute(sql`SELECT public.lumibase_record_crawl_hit(${HOST_A}, 'crawler', 'gptbot', 'OpenAI', 'training', 'page', '/x?token=1', NULL, 200)`);
    await renderDb.execute(sql`SELECT public.lumibase_record_crawl_hit(${HOST_A}, 'crawler', 'gptbot', 'OpenAI', 'training', 'admin', '/x', NULL, 200)`);
    await renderDb.execute(sql`SELECT public.lumibase_record_crawl_hit(${HOST_A}, 'crawler', 'gptbot', 'OpenAI', 'training', 'page', '/x', '203.0.113.9', 200)`);
    expect(await hitsOf(A)).toEqual([]);
    expect(await hitsOf(B)).toEqual([]);
  });

  it('Codex review of batch 11: no search engine, no encoded administration path; a 404 under one path; a crawler must say its purpose; a hash is kept as sent; a day keeps at most 10,000 paths', async () => {
    await get(HOST_A, '/read-me/', { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' });
    await get(HOST_A, '/%61dmin/settings', { 'user-agent': GPTBOT });
    await get(HOST_A, '/no-such-page-1/', { 'user-agent': GPTBOT });
    await get(HOST_A, '/no-such-page-2/', { 'user-agent': GPTBOT });
    await settle();
    const hits = await hitsOf(A);
    expect(hits.map((h) => [h.agent, h.path, h.status])).toEqual([
      ['gptbot', '(not found)', 404],
      ['gptbot', '(not found)', 404],
    ]);
    expect((await dailyOf(A)).map((d) => [d.path, d.hits])).toEqual([['(not found)', 2]]);
    // Straight through the entry, as the rendering role: a crawler without a purpose is dropped; a hash is kept.
    const port = renderPort(renderDb);
    await port.recordCrawlHit({ host: HOST_A, kind: 'crawler', agent: 'gptbot', operator: 'OpenAI', purpose: null, resource: 'page', path: '/x/', ipHash: null, status: 200 });
    await port.recordCrawlHit({ host: HOST_A, kind: 'crawler', agent: 'gptbot', operator: 'OpenAI', purpose: 'search-engine', resource: 'page', path: '/x/', ipHash: null, status: 200 });
    await port.recordCrawlHit({ host: HOST_A, kind: 'crawler', agent: 'gptbot', operator: 'OpenAI', purpose: 'training', resource: 'page', path: '/kept/', ipHash: 'ab'.repeat(16), status: 200 });
    const kept = (await hitsOf(A)).filter((h) => h.path !== '(not found)');
    expect(kept.map((h) => [h.path, h.ipHash])).toEqual([['/kept/', 'ab'.repeat(16)]]);
    // An agent the entry does not know, or a known one under another operator: dropped (round 2).
    await port.recordCrawlHit({ host: HOST_A, kind: 'crawler', agent: 'spoof-000001', operator: 'OpenAI', purpose: 'training', resource: 'page', path: '/s/', ipHash: null, status: 200 });
    await port.recordCrawlHit({ host: HOST_A, kind: 'crawler', agent: 'gptbot', operator: 'Somebody', purpose: 'training', resource: 'page', path: '/s/', ipHash: null, status: 200 });
    expect((await hitsOf(A)).some((h) => h.path === '/s/')).toBe(false);
    // A day already holding 9,999 distinct paths: one more new path is kept; then a path it has, read by another crawler,
    // is itself (the bound counts paths, not rows); a further new path is kept as `(other)`.
    await runSiteTransaction(db, A, (tx) =>
      tx.execute(sql`INSERT INTO lumibase_crawl_daily_paths (site_id, day, path)
        SELECT ${A}, (now() AT TIME ZONE 'UTC')::date, '/p' || g FROM generate_series(1, 9998) g`),
    );
    const at = (path: string, agent = 'gptbot', operator = 'OpenAI', purpose = 'training') =>
      port.recordCrawlHit({ host: HOST_A, kind: 'crawler', agent, operator, purpose, resource: 'page', path, ipHash: null, status: 200 });
    await at('/last-one/');
    await at('/last-one/', 'claudebot', 'Anthropic');
    await at('/brand-new/');
    const daily = await dailyOf(A);
    expect(daily.filter((d) => d.path === '/last-one/').map((d) => d.agent).sort()).toEqual(['claudebot', 'gptbot']);
    expect(daily.find((d) => d.path === '(other)')?.hits).toBe(1);
    expect(daily.some((d) => d.path === '/brand-new/')).toBe(false);
  });

  it('the entry\'s known agents are exactly the renderer\'s; rows of an older version are brought within the rules', async () => {
    // Every AI crawler and assistant the renderer knows, as the entry does — and nothing more in the migration's list.
    const known = async (kind: string, agent: string, operator: string, purpose: string | null) =>
      (await owner.unsafe('SELECT public.lumibase_ai_agent_known($1, $2, $3, $4) AS ok', [kind, agent, operator, purpose]))[0]!.ok as boolean;
    for (const c of AI_CRAWLERS) expect(await known('crawler', c.id, c.operator, c.purpose), c.id).toBe(true);
    for (const r of AI_REFERRERS) expect(await known('referral', r.id, r.operator, null), r.id).toBe(true);
    expect(await known('crawler', 'googlebot', 'Google', 'search-engine')).toBe(false);
    const listed = readFileSync(path.resolve(__dirname, '../../../../packages/database/drizzle/0088_record_crawl_hit_known_agents.sql'), 'utf8').match(/\('(crawler|referral)', '[a-z0-9.-]+'/g) ?? [];
    expect(listed.length).toBe(AI_CRAWLERS.length + AI_REFERRERS.length);
    // An older version's rows: a search engine, a crawler with no purpose; the reconciliation removes them.
    await runSiteTransaction(db, A, async (tx) => {
      await tx.insert(crawlHits).values({ siteId: A, kind: 'crawler', agent: 'googlebot', operator: 'Google', purpose: 'search-engine', resource: 'page', path: '/', status: 200 });
      await tx.insert(crawlDaily).values([
        { siteId: A, day: '2026-10-20', kind: 'crawler', agent: 'googlebot', operator: 'Google', purpose: 'search-engine', resource: 'page', path: '/', hits: 9 },
        { siteId: A, day: '2026-10-20', kind: 'crawler', agent: 'gptbot', operator: 'OpenAI', purpose: '', resource: 'page', path: '/', hits: 2 },
        { siteId: A, day: '2026-10-20', kind: 'crawler', agent: 'gptbot', operator: 'OpenAI', purpose: 'training', resource: 'page', path: '/kept/', hits: 3 },
      ]);
    });
    // The report never counts them, even before.
    expect((await aiTrafficReport(db, A, { days: 90, now: new Date('2026-10-21T00:00:00Z') })).totals.crawler).toBe(3);
    await owner.unsafe('SELECT public.lumibase_crawl_traffic_reconcile()');
    expect((await dailyOf(A)).map((d) => [d.agent, d.path])).toEqual([['gptbot', '/kept/']]);
    expect(await hitsOf(A)).toEqual([]);
  });

  it('Codex review of batch 11, round 3: an older version\'s error paths go under (not found); the hourly job reconciles from yesterday and keeps path lists from yesterday only', async () => {
    const today = new Date().toISOString().slice(0, 10);
    // As 0085 wrote them: a 404 under its own path (detail and total), next to a page read; an old day's path list.
    await runSiteTransaction(db, A, async (tx) => {
      await tx.insert(crawlHits).values([
        { siteId: A, kind: 'crawler', agent: 'gptbot', operator: 'OpenAI', purpose: 'training', resource: 'page', path: '/missing/', status: 404 },
        { siteId: A, kind: 'crawler', agent: 'gptbot', operator: 'OpenAI', purpose: 'training', resource: 'page', path: '/missing/', status: 404 },
        { siteId: A, kind: 'crawler', agent: 'gptbot', operator: 'OpenAI', purpose: 'training', resource: 'page', path: '/read/', status: 200 },
      ]);
      await tx.insert(crawlDaily).values([
        { siteId: A, day: today, kind: 'crawler', agent: 'gptbot', operator: 'OpenAI', purpose: 'training', resource: 'page', path: '/missing/', hits: 2 },
        { siteId: A, day: today, kind: 'crawler', agent: 'gptbot', operator: 'OpenAI', purpose: 'training', resource: 'page', path: '/read/', hits: 1 },
      ]);
      await tx.insert(crawlDailyPaths).values([
        { siteId: A, day: today, path: '/missing/' },
        { siteId: A, day: '2026-01-01', path: '/old/' },
      ]);
    });
    await purgeCrawlHits(db);
    expect((await dailyOf(A)).map((d) => [d.path, d.hits]).sort()).toEqual([['(not found)', 2], ['/read/', 1]]);
    expect((await hitsOf(A)).map((h) => h.path).sort()).toEqual(['(not found)', '(not found)', '/read/']);
    const paths = await runSiteTransaction(db, A, (tx) => tx.select({ day: crawlDailyPaths.day, path: crawlDailyPaths.path }).from(crawlDailyPaths).where(eq(crawlDailyPaths.siteId, A)));
    expect(paths).toEqual([{ day: today, path: '/read/' }]);
    // Round 4: the reconciliation failing (here: not allowed) fails the run, after every site was tried.
    const [role] = await db.execute(sql`SELECT current_user AS name`) as unknown as Array<{ name: string }>;
    await owner.unsafe(`REVOKE EXECUTE ON FUNCTION public.lumibase_crawl_traffic_reconcile(date, text) FROM ${role!.name}`);
    try {
      // Every site tried (the failures are all of them, both sites here among them), not the first only.
      const err = await purgeCrawlHits(db).then(() => null, (e: unknown) => e as Error);
      const [, failed, of] = /AI traffic maintenance failed for (\d+) of (\d+) sites/.exec(err?.message ?? '') ?? [];
      expect(Number(failed)).toBeGreaterThanOrEqual(2);
      expect(failed).toBe(of);
    } finally {
      await owner.unsafe(`GRANT EXECUTE ON FUNCTION public.lumibase_crawl_traffic_reconcile(date, text) TO ${role!.name}`);
    }
  });

  it('the details go after 7 days, the day totals stay; the report reads its site only', async () => {
    await get(HOST_A, '/read-me/', { 'user-agent': PERPLEXITY_USER });
    await get(HOST_A, '/read-me/?utm_source=perplexity.ai', { 'user-agent': BROWSER });
    await get(HOST_B, '/', { 'user-agent': GPTBOT });
    await settle();
    // An old detail (as if 8 days old), and its day total.
    await runSiteTransaction(db, A, async (tx) => {
      await tx.update(crawlHits).set({ at: sql`now() - interval '8 days'` }).where(and(eq(crawlHits.siteId, A), eq(crawlHits.agent, 'perplexity-user')));
    });
    expect(await purgeCrawlHits(db)).toBeGreaterThanOrEqual(1);
    expect((await hitsOf(A)).map((h) => h.agent)).toEqual(['perplexity']);
    expect((await dailyOf(A)).map((d) => d.agent).sort()).toEqual(['perplexity', 'perplexity-user']);
    const report = await aiTrafficReport(db, A, { days: 7 });
    expect(report.totals).toEqual({ crawler: 1, referral: 1 });
    expect(report.byDay).toHaveLength(1);
    expect(report.byDay[0]).toMatchObject({ userFetch: 1, referral: 1, training: 0 });
    expect(report.topCrawled).toEqual([{ path: '/read-me/', resource: 'page', hits: 1 }]);
    expect(report.topLanding).toEqual([{ path: '/read-me/', hits: 1, sources: ['perplexity'] }]);
    expect(report.byAgent.map((a) => a.agent).sort()).toEqual(['perplexity', 'perplexity-user']);
    // Site B's training crawler is B's.
    expect((await aiTrafficReport(db, B)).totals).toEqual({ crawler: 1, referral: 0 });
  });
});
