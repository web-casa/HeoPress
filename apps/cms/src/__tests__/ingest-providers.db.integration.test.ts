import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { IngestProviderResource } from '@heopress/contracts/schemas';
import {
  ingestFetchAttempts,
  ingestHostSlots,
  ingestProviderSettings,
  ingestProviderUsage,
  ingestSourceDocuments,
  ingestSources,
  notifications,
  type Database,
} from '@heopress/database';
import type { KeyProvider, StorageObject, StorageProvider } from '@heopress/runtime';
import { classifyAddress, createRuntime, type AddressClass } from '@heopress/runtime/node';
import app from '../index';
import { setRuntimeFactory } from '../middleware/runtime';
import { runSiteTransaction } from '../services/rls-transaction';
import { RobotsCache } from '../services/ingest/robots';
import { DbHostLimiter } from '../services/ingest/host-limiter';
import { processSourceJob, setSourceRunner } from '../services/ingest/source-worker';
import { createIngestRunner, type IngestRunnerDeps } from '../services/ingest/url-runner';
import { IngestProviderService } from '../services/ingest/providers/settings';
import type { CrawlProvider, CrawlResult, ProviderId } from '../services/ingest/providers/types';
import { ProviderError } from '../services/ingest/providers/types';
import { CRAWL_PROVIDERS } from '../services/ingest/providers/registry';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { createCrossSiteFixture, type CrossSiteFixture } from './helpers/cross-site-fixture';

/**
 * External crawl services (HeoPress P08 tasks 3.3, 3.4, 3.6; spec ingest/crawling "访问拒绝不得绕过",
 * "采集服务预算与熔断", "外部采集服务插件"): the fallback chain stops at a 403 without calling later services and moves
 * on after a technical failure; an exhausted budget turns a service off for the site and notifies its
 * administrators; the breaker pauses a failing service; an internal target is refused before a service sees it; a
 * credential configured for site A is unusable for site B; a service without the administrator's consent is never
 * called; the API never returns a credential.
 */

const JWT_SECRET = 'ingest-providers-test-secret';
const KEK = Buffer.alloc(32, 7).toString('base64');

class MemoryStorage implements StorageProvider {
  objects = new Map<string, Buffer>();
  async put(key: string, data: ReadableStream | Buffer): Promise<void> {
    this.objects.set(key, Buffer.isBuffer(data) ? data : Buffer.from(await new Response(data).arrayBuffer()));
  }
  async get(key: string): Promise<StorageObject | null> {
    const b = this.objects.get(key);
    return b ? { key, body: b, size: b.byteLength } : null;
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
  async list(prefix = ''): Promise<{ keys: string[] }> {
    return { keys: [...this.objects.keys()].filter((k) => k.startsWith(prefix)) };
  }
}

const ARTICLE_MD = `# Harbour season\n\n${'The harbour authority in Example Town reported a busy season for ferries, fishing boats and visiting yachts this year.\n\n'.repeat(5)}`;

let server: Server;
let port = 0;
let pageStatus = 200;
const served: string[] = [];

const boundary = {
  resolve: async (host: string) => [{ address: host.startsWith('internal.') ? '10.0.0.9' : '127.0.0.1', family: 4 }],
  classify: (ip: string): AddressClass => (ip === '127.0.0.1' ? 'public' : classifyAddress(ip)),
};

/** A fake service: records what it was asked, answers with an article or throws. */
function fakeProvider(id: ProviderId, behaviour: { fail?: () => Error; cost?: number } = {}) {
  const crawl = vi.fn(async (req: { url: string }): Promise<CrawlResult> => {
    if (behaviour.fail) throw behaviour.fail();
    return { finalUrl: req.url, title: 'Harbour season', markdown: ARTICLE_MD, metadata: {}, provider: id, durationMs: 3, ...(behaviour.cost === undefined ? {} : { cost: behaviour.cost }) };
  });
  const provider: CrawlProvider = { manifest: CRAWL_PROVIDERS[id].manifest, crawl };
  return { provider, crawl };
}

describe.skipIf(!hasDbIntegrationUrl)('ingest crawl services — DB integration', () => {
  let db: Database;
  let fx: CrossSiteFixture;
  let env: Record<string, unknown> = {};
  let keys: KeyProvider;
  let storage: MemoryStorage;
  let siteId: string;

  beforeAll(async () => {
    db = await connectDbIntegration('ingest-providers');
    env = { ...process.env, JWT_SECRET, HEOPRESS_ENV: 'development', ENCRYPTION_KEY: KEK };
    server = createServer((req, res: ServerResponse) => {
      served.push(req.url ?? '');
      if (req.url === '/robots.txt') return void res.writeHead(404).end();
      res.writeHead(pageStatus, { 'content-type': 'text/html; charset=utf-8' }).end(pageStatus === 200 ? '<html><body>ok</body></html>' : 'no');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as AddressInfo).port;
  });
  beforeEach(async () => {
    fx = await createCrossSiteFixture(db, { prefix: 'ingp', jwtSecret: JWT_SECRET });
    siteId = fx.sites.a;
    storage = new MemoryStorage();
    const runtime = createRuntime(env);
    keys = runtime.keys;
    setRuntimeFactory(() => ({ ...runtime, storage }));
    pageStatus = 200;
    served.length = 0;
    await db.delete(ingestHostSlots);
  });
  afterEach(async () => {
    setSourceRunner(null);
    setRuntimeFactory(null);
    if (fx) await fx.teardown();
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  const url = (host = 'news.example.com') => `http://${host}:${port}/news/harbour`;
  const inSite = <T,>(site: string, fn: Parameters<typeof runSiteTransaction<T>>[2]) => runSiteTransaction(db, site, fn);
  const service = (site = siteId) => new IngestProviderService({ db, siteId: site, keys, userId: null });

  /** Enable a service for a site with consent and a credential. */
  async function configure(provider: ProviderId, extra: Record<string, unknown> = {}, site = siteId) {
    return service(site).update(provider, { enabled: true, consent: true, credential: `key-${provider}-${site}`, ...extra });
  }

  async function addSource(target = url(), site = siteId): Promise<string> {
    return inSite(site, async (tx) => {
      const [row] = await tx
        .insert(ingestSources)
        .values({ siteId: site, name: `page ${Math.random()}`, type: 'url', url: target, scheduleTimes: ['08:00'], timezone: 'UTC' })
        .returning({ id: ingestSources.id });
      return row!.id;
    });
  }

  const deps = (providers: Partial<Record<ProviderId, CrawlProvider>>, extra: Partial<IngestRunnerDeps> = {}): IngestRunnerDeps => ({
    db,
    storage,
    limiter: new DbHostLimiter(db, { minIntervalMs: 0 }),
    fetch: { ...boundary, robots: new RobotsCache() },
    providers: { keys, providers, env: {} },
    ...extra,
  });

  const run = (sourceId: string, site = siteId) => processSourceJob({ db }, { siteId: site, sourceId, scheduledFor: new Date().toISOString() });
  const attempts = (site = siteId) => inSite(site, (tx) => tx.select().from(ingestFetchAttempts).where(eq(ingestFetchAttempts.siteId, site)).orderBy(ingestFetchAttempts.finishedAt));
  const docs = (site = siteId) => inSite(site, (tx) => tx.select().from(ingestSourceDocuments).where(eq(ingestSourceDocuments.siteId, site)));
  const lastFailure = async (sourceId: string) =>
    (await inSite(siteId, (tx) => tx.select().from(ingestSources).where(and(eq(ingestSources.siteId, siteId), eq(ingestSources.id, sourceId)))))[0]!.lastFailureCategory;

  it('403 from the site stops the chain: later services are never called', async () => {
    await configure('firecrawl');
    await configure('crawl4ai');
    const fc = fakeProvider('firecrawl');
    const c4 = fakeProvider('crawl4ai');
    pageStatus = 403;
    const sourceId = await addSource();
    setSourceRunner(createIngestRunner(deps({ firecrawl: fc.provider, crawl4ai: c4.provider })));
    expect(await run(sourceId)).toBe('failed');
    expect(fc.crawl).not.toHaveBeenCalled();
    expect(c4.crawl).not.toHaveBeenCalled();
    expect(await lastFailure(sourceId)).toBe('access_denied');
    expect((await attempts()).map((a) => [a.fetchProvider, a.failureCategory])).toEqual([['native', 'access_denied']]);
  });

  it('a technical failure hands the URL to the next service; its output becomes the source document', async () => {
    await configure('firecrawl', { position: 1 });
    await configure('crawl4ai', { position: 2 });
    const fc = fakeProvider('firecrawl', { fail: () => new ProviderError('firecrawl', 'network', 'firecrawl answered HTTP 502') });
    const c4 = fakeProvider('crawl4ai');
    pageStatus = 503;
    const sourceId = await addSource();
    setSourceRunner(createIngestRunner(deps({ firecrawl: fc.provider, crawl4ai: c4.provider })));
    expect(await run(sourceId)).toBe('succeeded');
    expect(fc.crawl).toHaveBeenCalledTimes(1);
    expect(c4.crawl).toHaveBeenCalledTimes(1);
    const [doc] = await docs();
    expect(doc).toMatchObject({ fetchMethod: 'provider', fetchProvider: 'crawl4ai', title: 'Harbour season', extractionRuleVersion: 'native-1+crawl4ai' });
    expect((await attempts()).map((a) => [a.fetchProvider, a.outcome, a.failureCategory])).toEqual([
      ['native', 'failed', 'network'],
      ['firecrawl', 'failed', 'network'],
      ['crawl4ai', 'succeeded', null],
    ]);
  });

  it('a source chain without native goes to the service; an internal target is refused before the service is called', async () => {
    await configure('firecrawl');
    const fc = fakeProvider('firecrawl');
    const sourceId = await addSource(url('internal.example.com'));
    await service().setChain(sourceId, { chain: ['firecrawl'] });
    setSourceRunner(createIngestRunner(deps({ firecrawl: fc.provider })));
    expect(await run(sourceId)).toBe('failed');
    expect(fc.crawl).not.toHaveBeenCalled();
    expect(await lastFailure(sourceId)).toBe('blocked');
    // And the public URL goes through.
    const ok = await addSource();
    await service().setChain(ok, { chain: ['firecrawl'] });
    expect(await run(ok)).toBe('succeeded');
    expect(fc.crawl).toHaveBeenCalledWith(expect.objectContaining({ url: url() }), expect.anything());
  });

  it('robots.txt disallowing the URL stops a service step too (access_denied)', async () => {
    await configure('firecrawl');
    const fc = fakeProvider('firecrawl');
    const robots = new RobotsCache();
    await robots.policyFor(`http://news.example.com:${port}`, 'HeoPressBot', async () => ({ kind: 'ok', body: 'User-agent: *\nDisallow: /news/' }));
    const sourceId = await addSource();
    await service().setChain(sourceId, { chain: ['firecrawl'] });
    setSourceRunner(createIngestRunner(deps({ firecrawl: fc.provider }, { fetch: { ...boundary, robots } })));
    expect(await run(sourceId)).toBe('failed');
    expect(fc.crawl).not.toHaveBeenCalled();
    expect(await lastFailure(sourceId)).toBe('access_denied');
  });

  it('budget: usage and cost per month; reaching the ceiling turns the service off for the site and notifies its administrators', async () => {
    // Ceiling 0.0025 USD; each call reports 0.001 USD.
    await configure('firecrawl', { monthlyBudgetUsd: 0.0025 });
    const fc = fakeProvider('firecrawl', { cost: 1000 });
    setSourceRunner(createIngestRunner(deps({ firecrawl: fc.provider })));
    for (let i = 0; i < 3; i++) {
      const s = await addSource(`${url()}?n=${i}`);
      await service().setChain(s, { chain: ['firecrawl'] });
      await run(s);
    }
    expect(fc.crawl).toHaveBeenCalledTimes(2);
    const [usage] = await inSite(siteId, (tx) => tx.select().from(ingestProviderUsage).where(eq(ingestProviderUsage.siteId, siteId)));
    expect(usage).toMatchObject({ provider: 'firecrawl', requests: 2, costMicros: 2000 });
    expect(usage!.exhaustedAt).not.toBeNull();
    const notes = await inSite(siteId, (tx) => tx.select().from(notifications).where(and(eq(notifications.siteId, siteId), eq(notifications.collection, 'ingest_provider_settings'))));
    expect(notes.map((n) => n.recipient)).toEqual([fx.users.adminA.id]);
    const listed = (await service().list()).find((p) => p.provider === 'firecrawl')!;
    expect(listed).toMatchObject({ unavailableReason: 'budget_exhausted', usage: { requests: 2, costUsd: 0.002, exhausted: true } });
    // Exhausted: not called again, no second notification.
    const again = await addSource(`${url()}?n=again`);
    await service().setChain(again, { chain: ['firecrawl'] });
    await run(again);
    expect(fc.crawl).toHaveBeenCalledTimes(2);
    expect(await inSite(siteId, (tx) => tx.select().from(notifications).where(and(eq(notifications.siteId, siteId), eq(notifications.collection, 'ingest_provider_settings'))))).toHaveLength(1);
    // Site B's budget is its own.
    expect((await service(fx.sites.b).list()).find((p) => p.provider === 'firecrawl')!.usage.requests).toBe(0);
    // Raising the ceiling turns it back on.
    expect((await service().update('firecrawl', { monthlyBudgetUsd: 1 })).unavailableReason).toBeNull();
  });

  it('breaker: N failures in a row pause the service for the site', async () => {
    await configure('firecrawl');
    const fc = fakeProvider('firecrawl', { fail: () => new ProviderError('firecrawl', 'network', 'HTTP 502') });
    const d = deps({ firecrawl: fc.provider });
    setSourceRunner(createIngestRunner({ ...d, providers: { ...d.providers!, env: { HEOPRESS_INGEST_PROVIDER_BREAKER_FAILURES: '2', HEOPRESS_INGEST_PROVIDER_BREAKER_MINUTES: '30' } } }));
    for (let i = 0; i < 3; i++) {
      const s = await addSource(`${url()}?b=${i}`);
      await service().setChain(s, { chain: ['firecrawl'] });
      await run(s);
    }
    expect(fc.crawl).toHaveBeenCalledTimes(2);
    const [row] = await inSite(siteId, (tx) => tx.select().from(ingestProviderSettings).where(and(eq(ingestProviderSettings.siteId, siteId), eq(ingestProviderSettings.provider, 'firecrawl'))));
    expect(row!.pausedUntil!.getTime()).toBeGreaterThan(Date.now() + 25 * 60_000);
    expect((await service().list()).find((p) => p.provider === 'firecrawl')!.unavailableReason).toBe('breaker_open');
  });

  it('a credential configured for site A is unusable for site B, even with the ciphertext copied over', async () => {
    await configure('firecrawl');
    const [a] = await inSite(siteId, (tx) => tx.select().from(ingestProviderSettings).where(and(eq(ingestProviderSettings.siteId, siteId), eq(ingestProviderSettings.provider, 'firecrawl'))));
    const siteB = fx.sites.b;
    await inSite(siteB, (tx) =>
      tx.insert(ingestProviderSettings).values({ siteId: siteB, provider: 'firecrawl', enabled: true, consentAt: new Date(), credentialCiphertext: a!.credentialCiphertext, credentialKeyId: a!.credentialKeyId }),
    );
    const seen: Array<string | null> = [];
    const fc: CrawlProvider = {
      manifest: CRAWL_PROVIDERS.firecrawl.manifest,
      crawl: vi.fn(async (req, ctx) => {
        seen.push(ctx.config.credential);
        return { finalUrl: req.url, title: 'Harbour season', markdown: ARTICLE_MD, metadata: {}, provider: 'firecrawl' as const, durationMs: 1 };
      }),
    };
    setSourceRunner(createIngestRunner(deps({ firecrawl: fc })));
    const b = await addSource(url(), siteB);
    await new IngestProviderService({ db, siteId: siteB, keys, userId: null }).setChain(b, { chain: ['firecrawl'] });
    expect(await run(b, siteB)).toBe('failed');
    expect(seen).toEqual([]);
    expect((await attempts(siteB)).map((x) => x.message)).toEqual([expect.stringContaining('not usable for this site')]);
    // Site A's own key works for A.
    const s = await addSource();
    await service().setChain(s, { chain: ['firecrawl'] });
    expect(await run(s)).toBe('succeeded');
    expect(seen).toEqual([`key-firecrawl-${siteId}`]);
  });

  it('without the administrator\'s consent a service is never sent a URL', async () => {
    await service().update('firecrawl', { enabled: true, credential: 'k' });
    const fc = fakeProvider('firecrawl');
    const s = await addSource();
    await service().setChain(s, { chain: ['firecrawl'] });
    setSourceRunner(createIngestRunner(deps({ firecrawl: fc.provider })));
    expect(await run(s)).toBe('failed');
    expect(fc.crawl).not.toHaveBeenCalled();
    expect((await service().list()).find((p) => p.provider === 'firecrawl')!.unavailableReason).toBe('no_consent');
  });

  it('API: administrators configure, the credential is write-only, members read, other sites are out of reach', async () => {
    const call = (path: string, method: string, headers: Record<string, string>, body?: unknown) =>
      app.request(`/api/v1/ingest/providers${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env);
    const admin = fx.headers('a', await fx.session('adminA', 'a'));
    const editor = fx.headers('a', await fx.session('onlyA', 'a'));
    const res = await call('/firecrawl', 'PATCH', admin, { enabled: true, consent: true, credential: 'fc-secret-value-1234', monthlyBudgetUsd: 5 });
    expect(res.status, await res.clone().text()).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('fc-secret-value');
    expect((JSON.parse(text) as { data: IngestProviderResource }).data).toMatchObject({ credentialSet: true, credentialHint: '1234', monthlyBudgetUsd: 5, hosts: ['api.firecrawl.dev'] });
    expect((await call('/firecrawl', 'PATCH', editor, { enabled: false })).status).toBe(403);
    const list = await (await call('', 'GET', editor)).text();
    expect(list).not.toContain('fc-secret-value');
    expect(list).not.toContain('credentialCiphertext');
    expect((await call('/unknown', 'PATCH', admin, {})).status).toBe(404);
    expect((await call('/cloudflare', 'PATCH', admin, { accountId: 'not-an-id' })).status).toBe(400);
    // Site B sees its own (unconfigured) settings only.
    const b = ((await (await call('', 'GET', fx.headers('b', await fx.session('adminB', 'b')))).json()) as { data: IngestProviderResource[] }).data;
    expect(b.find((p) => p.provider === 'firecrawl')).toMatchObject({ enabled: false, credentialSet: false });
    // Chains: per source, validated.
    const s = await addSource();
    expect((await call(`/chains/${s}`, 'PUT', admin, { chain: ['native', 'native'] })).status).toBe(400);
    const set = await call(`/chains/${s}`, 'PUT', admin, { chain: ['firecrawl', 'native'] });
    expect(((await set.json()) as { data: unknown }).data).toEqual({ chain: ['firecrawl', 'native'], custom: true });
    expect((await call(`/chains/${s}`, 'GET', fx.headers('b', await fx.session('adminB', 'b')))).status).toBe(404);
  });
});
