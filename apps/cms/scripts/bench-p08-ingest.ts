/**
 * Scheduled ingestion end to end: 3 sources × 20 articles (HeoPress P08 task 5.1; results in docs/benchmarks/p08-ingest.md).
 *
 *   DATABASE_URL=<owner, disposable> HEOPRESS_BENCH_DISPOSABLE_DB=true npx tsx scripts/bench-p08-ingest.ts
 *
 * Starts a loopback fixture HTTP server with three hosts (an RSS feed, a sitemap and a list page with a next-page
 * link), 20 articles each (one image per article, no media licence, so it is recorded and not copied). Creates one
 * site (`bench_p08`) with one source of each type, then runs the three scheduled runs concurrently through the source
 * worker with fetches inline, as `serve.ts` does without a queue. Every fixture host resolves to 127.0.0.1, which only
 * this script treats as a public address; nothing leaves the machine. Prints duration, peak memory and document
 * counts, then removes the site.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq, sql } from 'drizzle-orm';
import { createDb, ingestDocumentMedia, ingestHostSlots, ingestSourceDocuments, ingestSourceRuns, ingestSources, sites } from '@heopress/database';
import type { StorageObject, StorageProvider } from '@heopress/runtime';
import { classifyAddress, type AddressClass } from '@heopress/runtime/node';
import { runSiteTransaction } from '../src/services/rls-transaction';
import { RobotsCache } from '../src/services/ingest/robots';
import { processSourceJob, setSourceRunner } from '../src/services/ingest/source-worker';
import { createIngestRunner } from '../src/services/ingest/url-runner';

const ARTICLES = 20;
const SITE = `bench_p08_${Date.now().toString(36)}`;
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
if (process.env.HEOPRESS_BENCH_DISPOSABLE_DB !== 'true') throw new Error('Set HEOPRESS_BENCH_DISPOSABLE_DB=true: this writes and deletes a site.');
const db = createDb(url);

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

const words = ['harbour', 'market', 'ferry', 'council', 'library', 'festival', 'bridge', 'school', 'museum', 'river', 'station', 'garden'];
/** A distinct, quality-passing article: its own topic words so neither exact nor near-duplicate checks merge them. */
function article(host: string, n: number): string {
  const topic = `${words[n % words.length]} ${words[(n * 7 + host.length) % words.length]} ${host.split('.')[0]} ${n}`;
  const para = Array.from(
    { length: 6 },
    (_, i) => `<p>Report ${n}.${i} from ${host}: the ${topic} update covers schedules, budgets and the people involved, item ${n * 31 + i}.</p>`,
  ).join('');
  return `<!doctype html><html lang="en"><head><title>${topic}</title></head><body><article><h1>${topic}</h1>${para}<img src="/img/${n}.png" alt=""></article></body></html>`;
}

const hosts = { rss: 'feed.example.com', sitemap: 'map.example.com', list: 'list.example.com' } as const;
let port = 0;
const at = (host: string, path: string) => `http://${host}:${port}${path}`;
function route(host: string, path: string): { type: string; body: string } | null {
  if (path === '/robots.txt') return { type: 'text/plain', body: 'User-agent: *\nAllow: /\n' };
  const m = /^\/a\/(\d+)$/.exec(path);
  if (m) return { type: 'text/html; charset=utf-8', body: article(host, Number(m[1])) };
  const ids = Array.from({ length: ARTICLES }, (_, i) => i);
  if (host === hosts.rss && path === '/feed.xml')
    return {
      type: 'application/rss+xml',
      body: `<?xml version="1.0"?><rss version="2.0"><channel><title>Feed</title>${ids.map((i) => `<item><title>A ${i}</title><link>${at(host, `/a/${i}`)}</link></item>`).join('')}</channel></rss>`,
    };
  if (host === hosts.sitemap && path === '/sitemap.xml')
    return {
      type: 'application/xml',
      body: `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${ids.map((i) => `<url><loc>${at(host, `/a/${i}`)}</loc></url>`).join('')}</urlset>`,
    };
  const page = /^\/list\/(\d+)$/.exec(path);
  if (host === hosts.list && page) {
    const p = Number(page[1]);
    const slice = ids.slice(p * 10, p * 10 + 10);
    const next = p * 10 + 10 < ARTICLES ? `<a class="next" href="/list/${p + 1}">Next</a>` : '';
    return { type: 'text/html; charset=utf-8', body: `<html><body>${slice.map((i) => `<div class="post"><a href="/a/${i}">A ${i}</a></div>`).join('')}${next}</body></html>` };
  }
  return null;
}

const server = createServer((req, res) => {
  const host = (req.headers.host ?? '').split(':')[0]!;
  const r = route(host, req.url ?? '/');
  if (!r) return void res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  res.writeHead(200, { 'content-type': r.type }).end(r.body);
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
port = (server.address() as AddressInfo).port;

const boundary = {
  resolve: async () => [{ address: '127.0.0.1', family: 4 }],
  classify: (ip: string): AddressClass => (ip === '127.0.0.1' ? 'public' : classifyAddress(ip)),
};

let peakRss = process.memoryUsage().rss;
const sampler = setInterval(() => (peakRss = Math.max(peakRss, process.memoryUsage().rss)), 50);

try {
  await db.delete(sites).where(eq(sites.id, SITE));
  await db.delete(ingestHostSlots);
  await db.insert(sites).values({ id: SITE, name: 'Bench P08' });
  const sourceIds = await runSiteTransaction(db, SITE, async (tx) => {
    const base = { siteId: SITE, scheduleTimes: ['08:00'], timezone: 'UTC', licenceStatus: 'licensed' as const, usageMode: 'facts_only' as const, maxItemsPerRun: ARTICLES };
    const rows = await tx
      .insert(ingestSources)
      .values([
        { ...base, name: 'RSS', type: 'rss', url: at(hosts.rss, '/feed.xml') },
        { ...base, name: 'Sitemap', type: 'sitemap', url: at(hosts.sitemap, '/sitemap.xml') },
        { ...base, name: 'List', type: 'list_page', url: at(hosts.list, '/list/0'), listSelectors: { item: '.post', link: 'a', nextPage: 'a.next' } },
      ])
      .returning({ id: ingestSources.id });
    return rows.map((r) => r.id);
  });

  setSourceRunner(createIngestRunner({ db, storage: new MemoryStorage(), limiter: null, fetch: { ...boundary, robots: new RobotsCache() } }));
  const slot = new Date().toISOString().slice(0, 14) + '00:00.000Z';
  const started = performance.now();
  const outcomes = await Promise.all(sourceIds.map((sourceId) => processSourceJob({ db }, { siteId: SITE, sourceId, scheduledFor: slot })));
  const seconds = (performance.now() - started) / 1000;

  const counts = await runSiteTransaction(db, SITE, async (tx) => ({
    documents: (await tx.select({ n: sql<number>`count(*)::int` }).from(ingestSourceDocuments).where(eq(ingestSourceDocuments.siteId, SITE)))[0]!.n,
    perSource: await tx
      .select({ sourceId: ingestSourceDocuments.sourceId, n: sql<number>`count(*)::int` })
      .from(ingestSourceDocuments)
      .where(eq(ingestSourceDocuments.siteId, SITE))
      .groupBy(ingestSourceDocuments.sourceId),
    media: (await tx.select({ n: sql<number>`count(*)::int` }).from(ingestDocumentMedia).where(eq(ingestDocumentMedia.siteId, SITE)))[0]!.n,
    runs: await tx.select({ outcome: ingestSourceRuns.outcome, itemsFound: ingestSourceRuns.itemsFound }).from(ingestSourceRuns).where(eq(ingestSourceRuns.siteId, SITE)),
  }));
  clearInterval(sampler);
  const rss = process.memoryUsage();
  console.log(
    JSON.stringify(
      {
        outcomes,
        seconds: Number(seconds.toFixed(2)),
        peakRssMiB: Math.round(Math.max(peakRss, rss.rss) / 1048576),
        maxRssMiB: Math.round(process.resourceUsage().maxRSS / 1024),
        expectedDocuments: ARTICLES * 3,
        ...counts,
      },
      null,
      2,
    ),
  );
  if (counts.documents !== ARTICLES * 3) process.exitCode = 1;
} catch (err) {
  console.error(err instanceof Error ? `${err.message} ${String((err as { cause?: unknown }).cause ?? "")}` : err);
  process.exitCode = 1;
} finally {
  clearInterval(sampler);
  setSourceRunner(null);
  await db.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
  server.close();
  process.exit(process.exitCode ?? 0);
}
