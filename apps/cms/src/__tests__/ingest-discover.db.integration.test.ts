import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  ingestDedupIndex,
  ingestDiscoveredUrls,
  ingestEventClusters,
  ingestFetchAttempts,
  ingestHostSlots,
  ingestProcessingJobs,
  ingestSourceCursors,
  ingestSourceDocuments,
  ingestSourceRuns,
  ingestSources,
  userSites,
  type Database,
} from '@heopress/database';
import type { JobOptions, QueueProvider, StorageObject, StorageProvider } from '@heopress/runtime';
import { classifyAddress, createRuntime, type AddressClass } from '@heopress/runtime/node';
import app from '../index';
import { setRuntimeFactory } from '../middleware/runtime';
import { runSiteTransaction } from '../services/rls-transaction';
import { discoverSource, type FetchJobPayload } from '../services/ingest/discovery-runner';
import type { NearDuplicateEmbedder } from '../services/ingest/near-duplicate';
import { RobotsCache } from '../services/ingest/robots';
import { StaleRunError } from '../services/ingest/source-documents';
import { processSourceJob, setSourceRunner } from '../services/ingest/source-worker';
import { createIngestRunner, processFetchJob, type IngestRunnerDeps } from '../services/ingest/url-runner';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { createCrossSiteFixture, type CrossSiteFixture } from './helpers/cross-site-fixture';

/**
 * Discovery, bounded pagination and deduplication (HeoPress P08 tasks 1.3, 2.8, 4.1–4.4; spec ingest/sources,
 * ingest/crawling "有界分页与断点续采", ingest/deduplication). Recorded, synthetic feeds, sitemaps and list pages are
 * served from loopback under example.com host names (an injected resolver; `*.internal.test` resolves to an address
 * the boundary treats as internal). Nothing leaves the machine; embeddings come from a deterministic fake.
 */

const JWT_SECRET = 'ingest-discover-test-secret';
const HOUR = 3600_000;

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

class FakeQueue implements QueueProvider {
  jobs: Array<{ queue: string; data: unknown; options?: JobOptions }> = [];
  async enqueue<T>(queue: string, _name: string, data: T, options?: JobOptions): Promise<string> {
    this.jobs.push({ queue, data, options });
    return String(this.jobs.length);
  }
  process(): void {}
  async getStatus() {
    return null;
  }
}

/** Bag of words hashed into 256 dimensions: rewording a few words keeps the cosine high, other text does not. */
const fakeEmbedder: NearDuplicateEmbedder = {
  embed: async ({ text }) => {
    const v = new Array<number>(256).fill(0);
    for (const w of text.toLowerCase().match(/[a-z]+/g) ?? []) {
      let h = 0;
      for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      v[h % 256]! += 1;
    }
    return { embedding: v, model: 'fake-bow:256' };
  },
};

const para = (s: string, n = 5) => `<p>${s}</p>`.repeat(n);
const article = (title: string, body: string, extraHead = '') =>
  `<!doctype html><html lang="en"><head><title>${title}</title>${extraHead}</head><body><article><h1>${title}</h1>${body}</article></body></html>`;
const filler = (topic: string) =>
  para(`The ${topic} story continues with ordinary details about the town, the weather, the road works and the people who live there and work nearby.`);

interface Route {
  status?: number;
  type?: string;
  body: string | Buffer;
  headers?: Record<string, string>;
}

let server: Server;
let port = 0;
const routes = new Map<string, Route>();
const served: string[] = [];

const boundary = {
  resolve: async (hostname: string) => [{ address: hostname.endsWith('.internal.test') ? '127.0.0.2' : '127.0.0.1', family: 4 }],
  classify: (ip: string): AddressClass => (ip === '127.0.0.1' ? 'public' : ip === '127.0.0.2' ? 'internal' : classifyAddress(ip)),
};

describe.skipIf(!hasDbIntegrationUrl)('ingest discovery and deduplication — DB integration', () => {
  let db: Database;
  let fx: CrossSiteFixture;
  let storage: MemoryStorage;
  let env: Record<string, unknown> = {};
  let siteId: string;

  const at = (host: string, path: string) => `http://${host}:${port}${path}`;
  /** Serve `body` at `host` + `path`. */
  const serve = (host: string, path: string, route: Route | string, type = 'text/html; charset=utf-8') =>
    routes.set(`${host}${path}`, typeof route === 'string' ? { body: route, type } : route);

  beforeAll(async () => {
    db = await connectDbIntegration('ingest-discover');
    env = { ...process.env, JWT_SECRET, HEOPRESS_ENV: 'development' };
    server = createServer((req, res) => {
      const host = (req.headers.host ?? '').split(':')[0]!;
      const path = req.url ?? '/';
      served.push(`${host}${path}`);
      if (path === '/robots.txt') return void res.writeHead(404).end();
      const r = routes.get(`${host}${path}`);
      if (!r) return void res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      res.writeHead(r.status ?? 200, { 'content-type': r.type ?? 'text/html; charset=utf-8', ...r.headers }).end(r.body);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as AddressInfo).port;
  });
  beforeEach(async () => {
    fx = await createCrossSiteFixture(db, { prefix: 'ingd', jwtSecret: JWT_SECRET });
    siteId = fx.sites.a;
    storage = new MemoryStorage();
    const runtime = createRuntime(env);
    setRuntimeFactory(() => ({ ...runtime, storage }));
    routes.clear();
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

  const deps = (extra: Partial<IngestRunnerDeps> = {}): IngestRunnerDeps => ({
    db,
    storage,
    limiter: null,
    fetch: { ...boundary, robots: new RobotsCache() },
    ...extra,
  });
  const inSite = <T,>(fn: Parameters<typeof runSiteTransaction<T>>[2], site = siteId) => runSiteTransaction(db, site, fn);

  async function addSource(
    type: 'rss' | 'atom' | 'sitemap' | 'list_page',
    url: string,
    extra: Partial<typeof ingestSources.$inferInsert> = {},
    site = siteId,
  ): Promise<string> {
    return inSite(async (tx) => {
      const [row] = await tx
        .insert(ingestSources)
        .values({ siteId: site, name: `${type} ${Math.random()}`, type, url, scheduleTimes: ['08:00'], timezone: 'UTC', licenceStatus: 'licensed', usageMode: 'facts_only', ...extra })
        .returning({ id: ingestSources.id });
      return row!.id;
    }, site);
  }
  const docs = (site = siteId) => inSite((tx) => tx.select().from(ingestSourceDocuments).where(eq(ingestSourceDocuments.siteId, site)).orderBy(ingestSourceDocuments.createdAt), site);
  const discovered = () => inSite((tx) => tx.select().from(ingestDiscoveredUrls).where(eq(ingestDiscoveredUrls.siteId, siteId)));
  const runOf = async (sourceId: string) =>
    (await inSite((tx) => tx.select().from(ingestSourceRuns).where(eq(ingestSourceRuns.sourceId, sourceId)).orderBy(ingestSourceRuns.startedAt))).at(-1)!;
  const cursorOf = async (sourceId: string) =>
    (await inSite((tx) => tx.select().from(ingestSourceCursors).where(and(eq(ingestSourceCursors.siteId, siteId), eq(ingestSourceCursors.sourceId, sourceId)))))[0];

  /** Run a source for a slot through the worker; fetch jobs go to `queue` and are then processed one by one. */
  async function runSource(sourceId: string, d: IngestRunnerDeps, slot = '2026-10-26T08:00:00.000Z', site = siteId) {
    const queue = new FakeQueue();
    setSourceRunner(createIngestRunner({ ...d, queue }));
    const outcome = await processSourceJob({ db }, { siteId: site, sourceId, scheduledFor: slot });
    const fetches: string[] = [];
    for (const j of queue.jobs.filter((x) => x.queue === 'ingest-fetch')) fetches.push(await processFetchJob(d, j.data as FetchJobPayload));
    return { outcome, queue, fetches };
  }

  /** A started run of a source, as the worker would hold it. */
  async function startRun(sourceId: string, maxItems = 20) {
    const [run] = await inSite((tx) =>
      tx.insert(ingestSourceRuns).values({ siteId, sourceId, scheduledFor: new Date('2026-10-26T08:00:00Z'), leaseUntil: new Date(Date.now() + HOUR) }).returning(),
    );
    const [source] = await inSite((tx) => tx.select().from(ingestSources).where(eq(ingestSources.id, sourceId)));
    return { siteId, source: source!, runId: run!.id, generation: run!.generation, scheduledFor: '2026-10-26T08:00:00.000Z', maxItems };
  }

  // --- 1.3 discovery, one per type --------------------------------------------------------------------------------

  it('RSS: new links become fetch jobs and documents; a tracking-parameter variant is the same URL (one document)', async () => {
    const host = 'news.example.com';
    serve(host, '/a', article('Harbour season opens', filler('harbour')));
    serve(host, '/b', article('Market day moves', filler('market')));
    serve(
      host,
      '/feed.xml',
      `<?xml version="1.0"?><rss version="2.0"><channel><title>Example News</title>
        <item><title>Harbour</title><link>${at(host, '/a?utm_source=rss&amp;utm_medium=feed')}</link></item>
        <item><title>Harbour again</title><link>${at(host, '/a')}#comments</link></item>
        <item><title>Market</title><link>/b</link></item>
      </channel></rss>`,
      'application/rss+xml',
    );
    const sourceId = await addSource('rss', at(host, '/feed.xml'));
    const { outcome, queue, fetches } = await runSource(sourceId, deps());
    expect(outcome).toBe('succeeded');
    expect(queue.jobs.map((j) => j.options?.singletonKey)).toEqual([expect.stringMatching(/^ingest-fetch:/), expect.stringMatching(/^ingest-fetch:/)]);
    expect(fetches).toEqual(['fetched', 'fetched']);
    const d = await docs();
    expect(d.map((x) => x.normalizedUrl).sort()).toEqual([at(host, '/a'), at(host, '/b')]);
    expect(await runOf(sourceId)).toMatchObject({ outcome: 'succeeded', itemsFound: 2, itemsDiscovered: 3, itemsNew: 2, itemsDuplicate: 1 });
    // Fetched at the normalised URL: the tracking parameters never leave.
    expect(served.filter((s) => s.includes('utm_'))).toHaveLength(0);

    // The next slot: nothing new, nothing fetched again.
    served.length = 0;
    const again = await runSource(sourceId, deps(), '2026-10-27T08:00:00.000Z');
    expect(again.queue.jobs).toHaveLength(0);
    expect(await runOf(sourceId)).toMatchObject({ itemsDiscovered: 3, itemsNew: 0, itemsDuplicate: 3 });
    expect(served.filter((s) => !s.endsWith('/robots.txt'))).toEqual([`${host}/feed.xml`]);
    expect(await docs()).toHaveLength(2);

    // The Sources list shows the last run's counts.
    const res = await app.request('/api/v1/ingest/sources', { headers: fx.headers('a', await fx.session('adminA', 'a')) }, env);
    const body = (await res.json()) as { data: Array<{ id: string; lastRunStats: unknown }> };
    expect(body.data.find((s) => s.id === sourceId)?.lastRunStats).toEqual({ discovered: 3, new: 0, duplicate: 3, stopReason: null });
  });

  it('Atom: a discovered link to an internal address is refused at the boundary and recorded; nothing reaches it', async () => {
    const host = 'blog.example.com';
    serve(host, '/posts/ok', article('A fine post', filler('fine')));
    serve(
      host,
      '/atom.xml',
      `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Blog</title>
        <entry><title>ok</title><link href="${at(host, '/posts/ok')}"/></entry>
        <entry><title>admin</title><link href="${at('admin.internal.test', '/secrets')}"/></entry>
        <entry><title>script</title><link href="javascript:alert(1)"/></entry>
      </feed>`,
      'application/atom+xml',
    );
    const sourceId = await addSource('atom', at(host, '/atom.xml'));
    const { outcome, fetches } = await runSource(sourceId, deps());
    expect(outcome).toBe('succeeded');
    expect(fetches).toEqual(['fetched', 'refused']);
    const rows = await discovered();
    expect(rows.find((r) => r.url.includes('admin.internal.test'))).toMatchObject({ status: 'refused', reason: expect.stringMatching(/^blocked:/) });
    expect(rows.find((r) => r.url.startsWith('javascript:'))).toMatchObject({ status: 'refused', reason: 'only http and https URLs are fetched' });
    expect(served.some((s) => s.startsWith('admin.internal.test'))).toBe(false);
    const attempts = await inSite((tx) => tx.select().from(ingestFetchAttempts).where(eq(ingestFetchAttempts.sourceId, sourceId)));
    expect(attempts).toEqual(expect.arrayContaining([expect.objectContaining({ outcome: 'failed', failureCategory: 'blocked' })]));
    expect(await docs()).toHaveLength(1);
  });

  it('sitemap index (gzip child): each URL fetched once; /A vs /a and ?id=1 vs ?id=2 stay distinct documents', async () => {
    const host = 'docs.example.com';
    serve(host, '/guide/Install', article('Installing on Linux', filler('linux install')));
    serve(host, '/guide/install', article('Installing on macOS', filler('mac install')));
    serve(host, '/item?id=1', article('Item one', filler('first item')));
    serve(host, '/item?id=2', article('Item two', filler('second item')));
    const urlset = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      ${['/guide/Install', '/guide/install', '/item?id=1', '/item?id=2'].map((p) => `<url><loc>${at(host, p)}</loc></url>`).join('')}</urlset>`;
    serve(host, '/sitemap-pages.xml.gz', { body: gzipSync(Buffer.from(urlset)), type: 'application/x-gzip' });
    serve(
      host,
      '/sitemap.xml',
      `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>${at(host, '/sitemap-pages.xml.gz')}</loc></sitemap></sitemapindex>`,
      'application/xml',
    );
    const sourceId = await addSource('sitemap', at(host, '/sitemap.xml'));
    const { outcome, fetches } = await runSource(sourceId, deps());
    expect(outcome).toBe('succeeded');
    expect(fetches).toEqual(['fetched', 'fetched', 'fetched', 'fetched']);
    expect((await docs()).map((d) => new URL(d.normalizedUrl).pathname + new URL(d.normalizedUrl).search).sort()).toEqual([
      '/guide/Install',
      '/guide/install',
      '/item?id=1',
      '/item?id=2',
    ]);
  });

  it('list page (CSS selectors): item links found, next pages followed until a page comes back (cycle)', async () => {
    const host = 'archive.example.com';
    const listPage = (n: number, next: number) =>
      `<!doctype html><html><body><ul>${[1, 2].map((i) => `<li class="post"><a class="go" href="/story/${n}-${i}">S${n}.${i}</a></li>`).join('')}</ul><a class="older" href="/list/${next}">Older</a></body></html>`;
    for (let n = 1; n <= 5; n++) {
      serve(host, `/list/${n}`, listPage(n, n === 5 ? 2 : n + 1));
      for (const i of [1, 2]) serve(host, `/story/${n}-${i}`, article(`Story ${n} ${i}`, filler(`story ${n} ${i} plain`)));
    }
    const sourceId = await addSource('list_page', at(host, '/list/1'), { listSelectors: { item: 'li.post', link: 'a.go', nextPage: 'a.older' }, maxItemsPerRun: 50 });
    const { outcome } = await runSource(sourceId, deps());
    expect(outcome).toBe('succeeded');
    expect(await runOf(sourceId)).toMatchObject({ itemsDiscovered: 10, itemsNew: 10, stopReason: 'cycle' });
    expect(served.filter((s) => s.startsWith(`${host}/list/`))).toEqual([1, 2, 3, 4, 5].map((n) => `${host}/list/${n}`));
    expect((await cursorOf(sourceId))?.successCursor).toMatchObject({ page: at(host, '/list/5') });
  });

  // --- 2.8 bounded pagination ------------------------------------------------------------------------------------

  const pagedList = (host: string, pages: number, nextOf: (n: number) => string | null = (n) => (n < pages ? `/p/${n + 1}` : null)) => {
    for (let n = 1; n <= pages; n++) {
      const next = nextOf(n);
      serve(
        host,
        `/p/${n}`,
        `<!doctype html><html><body>${[1, 2].map((i) => `<div class="i"><a href="/s/${n}-${i}">x</a></div>`).join('')}${next ? `<a rel="next" href="${next}">next</a>` : ''}</body></html>`,
      );
      for (const i of [1, 2]) serve(host, `/s/${n}-${i}`, article(`entry ${n} ${i}`, filler(`entry ${n} ${i} plain`)));
    }
  };

  it('a "next" link that redirects to an internal address ends pagination; earlier pages are kept', async () => {
    const host = 'paged.example.com';
    pagedList(host, 2);
    serve(host, '/p/1', `<!doctype html><html><body><div class="i"><a href="/s/1-1">x</a></div><a rel="next" href="/p/evil">next</a></body></html>`);
    serve(host, '/p/evil', { status: 302, body: '', headers: { location: at('meta.internal.test', '/latest/meta-data') } });
    const sourceId = await addSource('list_page', at(host, '/p/1'), { listSelectors: { item: 'div.i', link: 'a' } });
    const ctx = await startRun(sourceId);
    const jobs: FetchJobPayload[] = [];
    const res = await discoverSource(deps(), ctx, async (j) => void jobs.push(j));
    expect(res.stats).toMatchObject({ discovered: 1, new: 1, stopReason: 'fetch_failed:blocked' });
    expect(served.some((s) => s.startsWith('meta.internal.test'))).toBe(false);
    const cursor = await cursorOf(sourceId);
    expect(cursor?.successCursor?.page).toBe(at(host, '/p/1'));
    expect(cursor?.attemptCursor?.page).toBe(at(host, '/p/evil'));
  });

  it('quota exhausted: pagination stops (success progress stays at the last done page); no quota at all fails the run as `quota`', async () => {
    const host = 'quota.example.com';
    pagedList(host, 5);
    const sourceId = await addSource('list_page', at(host, '/p/1'), { listSelectors: { item: 'div.i', link: 'a' } });
    let units = 2;
    const quota = { take: async () => units-- > 0 };
    const res = await discoverSource(deps({ quota }), await startRun(sourceId), async () => undefined);
    expect(res.stats).toMatchObject({ discovered: 4, stopReason: 'quota' });
    expect((await cursorOf(sourceId))?.successCursor).toEqual({ page: at(host, '/p/2'), next: at(host, '/p/3'), caughtUp: false });

    const none = { take: async () => false };
    const other = await addSource('list_page', at(host, '/p/1'), { listSelectors: { item: 'div.i', link: 'a' } });
    expect((await runSource(other, deps({ quota: none }))).outcome).toBe('failed');
    expect(await runOf(other)).toMatchObject({ outcome: 'failed', failureCategory: 'quota' });
  });

  it('caps on pages and duration; the next run backfills from the success cursor once the head is caught up', async () => {
    const host = 'backfill.example.com';
    pagedList(host, 4);
    const sourceId = await addSource('list_page', at(host, '/p/1'), { listSelectors: { item: 'div.i', link: 'a' }, maxItemsPerRun: 50 });
    await runSource(sourceId, deps({ limits: { maxPages: 2 } }));
    expect(await runOf(sourceId)).toMatchObject({ itemsNew: 4, stopReason: 'max_pages' });
    expect((await cursorOf(sourceId))?.successCursor).toMatchObject({ page: at(host, '/p/2'), next: at(host, '/p/3'), caughtUp: false });

    served.length = 0;
    await runSource(sourceId, deps({ limits: { maxPages: 3 } }), '2026-10-27T08:00:00.000Z');
    // Head page: nothing new → jump to page 3, then page 4 (the end).
    expect(served.filter((s) => s.includes('/p/'))).toEqual([`${host}/p/1`, `${host}/p/3`, `${host}/p/4`]);
    expect(await runOf(sourceId)).toMatchObject({ itemsNew: 4, stopReason: null });
    expect((await cursorOf(sourceId))?.successCursor).toMatchObject({ page: at(host, '/p/4'), next: null, caughtUp: true });

    const slow = await addSource('list_page', at(host, '/p/1'), { listSelectors: { item: 'div.i', link: 'a' } });
    const res = await discoverSource(deps({ limits: { maxDurationMs: 0 } }), await startRun(slow), async () => undefined);
    expect(res.stats.stopReason).toBe('max_duration');
  });

  it('lease expired: a worker that lost its run cannot write cursors or links', async () => {
    const host = 'lease.example.com';
    pagedList(host, 2);
    const sourceId = await addSource('list_page', at(host, '/p/1'), { listSelectors: { item: 'div.i', link: 'a' } });
    const ctx = await startRun(sourceId);
    // Another worker takes the run over (its lease lapsed): the generation moves on.
    await inSite((tx) => tx.update(ingestSourceRuns).set({ generation: sql`${ingestSourceRuns.generation} + 1` }).where(eq(ingestSourceRuns.id, ctx.runId)));
    await expect(discoverSource(deps(), ctx, async () => undefined)).rejects.toBeInstanceOf(StaleRunError);
    expect(await cursorOf(sourceId)).toBeUndefined();
    expect(await discovered()).toHaveLength(0);
  });

  // --- 4.1 / 4.3 exact dedup and canonical ---------------------------------------------------------------------------

  it('the same content under two URLs is one document; a malicious cross-origin canonical is neither fetched nor adopted', async () => {
    const host = 'copy.example.com';
    const body = filler('copied');
    serve(host, '/one', article('Copied story', body, `<link rel="canonical" href="https://attacker.example.org/one">`));
    serve(host, '/two', article('Copied story', body));
    serve(host, '/three', article('Different story', filler('different'), `<link rel="canonical" href="${at(host, '/one')}">`));
    serve(host, '/feed.xml', `<?xml version="1.0"?><rss><channel>${['/one', '/two', '/three'].map((p) => `<item><link>${at(host, p)}</link></item>`).join('')}</channel></rss>`, 'application/rss+xml');
    const sourceId = await addSource('rss', at(host, '/feed.xml'));
    const { fetches } = await runSource(sourceId, deps());
    expect(fetches).toEqual(['fetched', 'duplicate', 'fetched']);
    const d = await docs();
    expect(d.map((x) => x.normalizedUrl)).toEqual([at(host, '/one'), at(host, '/three')]);
    // The canonical is kept as a candidate only; nothing was requested from it.
    expect(d[0]!.canonicalCandidate).toBe('https://attacker.example.org/one');
    expect(served.some((s) => s.startsWith('attacker.example.org'))).toBe(false);
    // A same-origin canonical with different content does not merge either.
    expect(d[1]!.canonicalCandidate).toBe(at(host, '/one'));
    expect((await discovered()).find((r) => r.url === at(host, '/two'))).toMatchObject({ status: 'duplicate', sourceDocumentId: d[0]!.id });
    expect(await runOf(sourceId)).toMatchObject({ itemsDuplicate: 1 });
  });

  // --- 4.2 / 4.3 near duplicates -------------------------------------------------------------------------------------

  const reworded = (swap: boolean) =>
    article(
      swap ? 'Harbour reopens to ferries after storm' : 'Ferries return to the harbour after the storm',
      para(
        `${swap ? 'After the storm passed' : 'Once the storm had passed'}, the harbour authority in Example Town reopened the main quay to ferries, fishing boats and visiting yachts, and the coast guard confirmed that the channel is clear again.`,
        6,
      ),
    );

  it('a reworded copy of an article is flagged as a near duplicate of the earlier one (fake embedder); without a provider the check is skipped', async () => {
    const host = 'near.example.com';
    serve(host, '/first', reworded(false));
    serve(host, '/second', reworded(true));
    serve(host, '/other', article('Library opens new wing', para('The city library opened a new wing with reading rooms, a cafe, study desks and a children corner full of picture books and puzzles.', 6)));
    serve(host, '/feed.xml', `<?xml version="1.0"?><rss><channel>${['/first', '/second', '/other'].map((p) => `<item><link>${at(host, p)}</link></item>`).join('')}</channel></rss>`, 'application/rss+xml');
    const sourceId = await addSource('rss', at(host, '/feed.xml'));
    const nearDuplicate = { embedder: fakeEmbedder, threshold: 0.92, windowDays: 30, candidateLimit: 500 };
    await runSource(sourceId, deps({ dedup: { nearDuplicate } }));
    const [first, second, other] = await docs();
    expect(first).toMatchObject({ nearDuplicateCheck: 'unique', duplicateOf: null });
    expect(second).toMatchObject({ nearDuplicateCheck: 'duplicate', duplicateOf: first!.id, duplicateScope: 'same_site', duplicateSiteId: null });
    expect(second!.duplicateSimilarity).toBeGreaterThanOrEqual(0.92);
    expect(other).toMatchObject({ nearDuplicateCheck: 'unique' });
    // The index holds vectors and hashes, no text.
    expect(await db.select().from(ingestDedupIndex).where(eq(ingestDedupIndex.siteId, siteId))).toHaveLength(3);

    const plain = await addSource('rss', at(host, '/feed2.xml'));
    serve(host, '/feed2.xml', `<?xml version="1.0"?><rss><channel><item><link>${at(host, '/solo')}</link></item></channel></rss>`, 'application/rss+xml');
    serve(host, '/solo', article('Solo piece', filler('solo')));
    await runSource(plain, deps());
    expect((await docs()).find((d) => d.normalizedUrl.endsWith('/solo'))).toMatchObject({ nearDuplicateCheck: 'skipped', nearDuplicateReason: 'no_embedding_provider' });
  });

  it('cross-site near duplicate: evidence only for a caller with rights on the other site now; others get an anonymous flag', async () => {
    const host = 'cross.example.com';
    serve(host, '/b-first', reworded(false));
    serve(host, '/a-second', reworded(true));
    serve(host, '/b.xml', `<?xml version="1.0"?><rss><channel><item><link>${at(host, '/b-first')}</link></item></channel></rss>`, 'application/rss+xml');
    serve(host, '/a.xml', `<?xml version="1.0"?><rss><channel><item><link>${at(host, '/a-second')}</link></item></channel></rss>`, 'application/rss+xml');
    const nearDuplicate = { embedder: fakeEmbedder, threshold: 0.92, windowDays: 30, candidateLimit: 500 };
    const inB = await addSource('rss', at(host, '/b.xml'), {}, fx.sites.b);
    await runSource(inB, deps({ dedup: { nearDuplicate } }), '2026-10-26T08:00:00.000Z', fx.sites.b);
    const inA = await addSource('rss', at(host, '/a.xml'));
    await runSource(inA, deps({ dedup: { nearDuplicate } }));
    const [bDoc] = await docs(fx.sites.b);
    const [aDoc] = await docs();
    expect(aDoc).toMatchObject({ nearDuplicateCheck: 'duplicate', duplicateScope: 'cross_site', duplicateOf: bDoc!.id, duplicateSiteId: fx.sites.b });

    const evidence = async (user: 'onlyA' | 'both') => {
      const res = await app.request(`/api/v1/ingest/documents/${aDoc!.id}/duplicate`, { headers: fx.headers('a', await fx.session(user, 'a')) }, env);
      expect(res.status).toBe(200);
      return ((await res.json()) as { data: Record<string, unknown> }).data;
    };
    const anonymous = { scope: 'cross_site', duplicateElsewhere: true };
    expect(await evidence('onlyA')).toEqual(anonymous);
    // `both` only reads site B: still anonymous.
    expect(await evidence('both')).toEqual(anonymous);
    const text = JSON.stringify(await evidence('onlyA'));
    for (const secret of [fx.sites.b, bDoc!.id, bDoc!.url, bDoc!.title]) expect(text).not.toContain(secret);

    // Made an administrator of B: the evidence is there — checked live, so taking the role away takes it away again.
    const [adminB] = await db.select({ roleId: userSites.roleId }).from(userSites).where(and(eq(userSites.siteId, fx.sites.b), eq(userSites.userId, fx.users.adminB.id)));
    const membership = and(eq(userSites.siteId, fx.sites.b), eq(userSites.userId, fx.users.both.id));
    const [before] = await db.select({ roleId: userSites.roleId }).from(userSites).where(membership);
    await db.update(userSites).set({ roleId: adminB!.roleId }).where(membership);
    expect(await evidence('both')).toEqual({ scope: 'cross_site', similarity: aDoc!.duplicateSimilarity, document: { id: bDoc!.id, siteId: fx.sites.b, title: bDoc!.title, url: bDoc!.url } });
    await db.update(userSites).set({ roleId: before!.roleId }).where(membership);
    expect(await evidence('both')).toEqual(anonymous);

    // The documents list carries the flag, never the other site.
    const list = await app.request('/api/v1/ingest/documents', { headers: fx.headers('a', await fx.session('onlyA', 'a')) }, env);
    const listed = JSON.stringify(await list.json());
    expect(listed).toContain('"duplicateScope":"cross_site"');
    expect(listed).not.toContain(fx.sites.b);
  });

  // --- 4.4 event aggregation --------------------------------------------------------------------------------------

  it('three sources reporting the same release form one event: one representative is processed, two are supplementary; another release is separate', async () => {
    const host = 'events.example.com';
    const reports: Array<[string, string, string]> = [
      ['/r1', 'ExampleDB 5.2 Released With Faster Queries', 'The ExampleDB team shipped the release this morning with a faster planner, lower memory use and better replication.'],
      ['/r2', 'Example DB 5.2 is out: what changed', 'Version 5.2 of Example DB arrives with a rewritten planner and smaller indexes, according to the maintainers.'],
      ['/r3', 'Hands-on with ExampleDB v5.2', 'We installed the new ExampleDB build on three servers and measured query latency for a week.'],
      ['/r4', 'ExampleDB 5.3 Released', 'ExampleDB 5.3 adds logical replication and a new backup tool for large clusters.'],
    ];
    const ids: string[] = [];
    for (const [i, [path, title, lead]] of reports.entries()) {
      serve(host, path, article(title, para(`${lead} ${'Readers asked about upgrades, compatibility and the support window for older versions. '.repeat(2)}`, 4)));
      serve(host, `/feed${i}.xml`, `<?xml version="1.0"?><rss><channel><item><link>${at(host, path)}</link></item></channel></rss>`, 'application/rss+xml');
      const id = await addSource('rss', at(host, `/feed${i}.xml`));
      ids.push(id);
      await runSource(id, deps());
    }
    const d = await docs();
    expect(d).toHaveLength(4);
    const [r1, r2, r3, r4] = d;
    expect(r1).toMatchObject({ clusterRole: 'representative' });
    expect(r2).toMatchObject({ clusterRole: 'supplementary', eventClusterId: r1!.eventClusterId });
    expect(r3).toMatchObject({ clusterRole: 'supplementary', eventClusterId: r1!.eventClusterId });
    expect(r4).toMatchObject({ clusterRole: 'representative' });
    expect(r4!.eventClusterId).not.toBe(r1!.eventClusterId);
    const jobs = await inSite((tx) => tx.select().from(ingestProcessingJobs).where(eq(ingestProcessingJobs.siteId, siteId)));
    expect(jobs.map((j) => j.sourceDocumentId).sort()).toEqual([r1!.id, r4!.id].sort());
    const [cluster] = await inSite((tx) => tx.select().from(ingestEventClusters).where(eq(ingestEventClusters.id, r1!.eventClusterId!)));
    expect(cluster).toMatchObject({ representativeDocumentId: r1!.id, memberCount: 3 });
  });
});
