import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  cdcChangeEvents,
  ingestFetchAttempts,
  ingestHostSlots,
  ingestSchedule,
  ingestProcessingJobs,
  ingestSnapshots,
  ingestSourceDocuments,
  ingestSourceRuns,
  ingestSources,
  type Database,
} from '@heopress/database';
import type { JobOptions, QueueProvider, StorageObject, StorageProvider } from '@heopress/runtime';
import { classifyAddress, createRuntime, type AddressClass } from '@heopress/runtime/node';
import app from '../index';
import { setRuntimeFactory } from '../middleware/runtime';
import { runSiteTransaction } from '../services/rls-transaction';
import { extractDocument } from '../services/ingest/extract';
import { RobotsCache } from '../services/ingest/robots';
import { DbHostLimiter } from '../services/ingest/host-limiter';
import { snapshotKey, sweepOrphanSnapshots, writeSnapshot } from '../services/ingest/snapshot-store';
import { operationIdFor, registerSourceDocument, ReplayMismatchError, StaleRunError, dispatchProcessingJobs } from '../services/ingest/source-documents';
import { processSourceJob, scheduleDueSources, setSourceRunner, sweepAbandonedRuns, type SourceJobPayload } from '../services/ingest/source-worker';
import { createIngestRunner, type IngestRunnerDeps } from '../services/ingest/url-runner';
import type { FetchedPage } from '../services/ingest/fetcher';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { createCrossSiteFixture, type CrossSiteFixture } from './helpers/cross-site-fixture';

/**
 * Fetching and registering source documents (HeoPress P08 tasks 2.2, 2.5, 2.7; spec ingest/crawling "规则版本与可恢复
 * 登记", "礼貌抓取"): a scheduled `url` source fetched end to end into a source document with its snapshot, attempt,
 * processing job and change event in one transaction; the three crash points of the snapshot-then-commit protocol
 * (object write failure, database rollback after the write, crash after the write) and their recovery; a stale
 * worker's writes refused; a replayed operation with other content refused; robots.txt feeding the source's health;
 * per-host limits held across processes; the snapshot only as an administrator's download.
 */

const JWT_SECRET = 'ingest-fetch-test-secret';
const HOUR = 3600_000;

class MemoryStorage implements StorageProvider {
  objects = new Map<string, Buffer>();
  failPuts = false;
  async put(key: string, data: ReadableStream | Buffer): Promise<void> {
    if (this.failPuts) throw new Error('object storage unavailable');
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

const article = (word: string) =>
  `<!doctype html><html lang="en"><head><title>Harbour ${word}</title><meta name="author" content="Jane Doe"></head><body><article><h1>Harbour ${word}</h1>${`<p>The harbour authority in Example Town reported a ${word} season for ferries, fishing boats and visiting yachts this year.</p>`.repeat(5)}</article></body></html>`;

let server: Server;
let port = 0;
let pageBody = article('busy');
let robotsBody = '';
const served: string[] = [];

/** Every host → 127.0.0.1, treated as a public address. */
const boundary = {
  resolve: async () => [{ address: '127.0.0.1', family: 4 }],
  classify: (ip: string): AddressClass => (ip === '127.0.0.1' ? 'public' : classifyAddress(ip)),
};

describe.skipIf(!hasDbIntegrationUrl)('ingest fetching — DB integration', () => {
  let db: Database;
  let fx: CrossSiteFixture;
  let storage: MemoryStorage;
  let env: Record<string, unknown> = {};
  let siteId: string;

  beforeAll(async () => {
    db = await connectDbIntegration('ingest-fetch');
    env = { ...process.env, JWT_SECRET, HEOPRESS_ENV: 'development' };
    server = createServer((req, res: ServerResponse) => {
      served.push(req.url ?? '');
      if (req.url === '/robots.txt') return void res.writeHead(200, { 'content-type': 'text/plain' }).end(robotsBody);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(pageBody);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as AddressInfo).port;
  });
  beforeEach(async () => {
    fx = await createCrossSiteFixture(db, { prefix: 'ingf', jwtSecret: JWT_SECRET });
    siteId = fx.sites.a;
    storage = new MemoryStorage();
    const runtime = createRuntime(env);
    setRuntimeFactory(() => ({ ...runtime, storage }));
    pageBody = article('busy');
    robotsBody = '';
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

  const url = (path = '/news/harbour') => `http://news.example.com:${port}${path}`;
  const runnerDeps = (extra: Partial<IngestRunnerDeps> = {}): IngestRunnerDeps => ({
    db,
    storage,
    limiter: new DbHostLimiter(db, { minIntervalMs: 0 }),
    fetch: { ...boundary, robots: new RobotsCache() },
    ...extra,
  });

  async function addUrlSource(target = url()): Promise<string> {
    return runSiteTransaction(db, siteId, async (tx) => {
      const [row] = await tx
        .insert(ingestSources)
        .values({ siteId, name: `page ${Math.random()}`, type: 'url', url: target, scheduleTimes: ['08:00'], timezone: 'UTC', licenceStatus: 'licensed', usageMode: 'facts_only' })
        .returning({ id: ingestSources.id });
      return row!.id;
    });
  }
  const inSite = <T,>(fn: Parameters<typeof runSiteTransaction<T>>[2]) => runSiteTransaction(db, siteId, fn);
  const docs = () => inSite((tx) => tx.select().from(ingestSourceDocuments).where(eq(ingestSourceDocuments.siteId, siteId)));
  const jobs = () => inSite((tx) => tx.select().from(ingestProcessingJobs).where(eq(ingestProcessingJobs.siteId, siteId)));
  const snaps = () => inSite((tx) => tx.select().from(ingestSnapshots).where(eq(ingestSnapshots.siteId, siteId)));
  const events = () =>
    inSite((tx) => tx.select().from(cdcChangeEvents).where(and(eq(cdcChangeEvents.siteId, siteId), eq(cdcChangeEvents.resource, 'source_document'))));
  const attempts = () => inSite((tx) => tx.select().from(ingestFetchAttempts).where(eq(ingestFetchAttempts.siteId, siteId)));

  /** A started run of `sourceId`, as the worker would hold it. */
  async function startRun(sourceId: string, scheduledFor = '2026-10-26T08:00:00.000Z') {
    const [run] = await inSite((tx) =>
      tx.insert(ingestSourceRuns).values({ siteId, sourceId, scheduledFor: new Date(scheduledFor), leaseUntil: new Date(Date.now() + HOUR) }).returning(),
    );
    return { runId: run!.id, generation: run!.generation, scheduledFor };
  }
  const pageOf = (html: string): FetchedPage => ({
    url: url(),
    finalUrl: url(),
    status: 200,
    contentType: 'text/html',
    headers: new Headers(),
    body: Buffer.from(html),
    durationMs: 5,
  });
  const register = (sourceId: string, run: { runId: string; generation: number; scheduledFor: string } | null, html: string, extra: { beforeCommit?: () => void } = {}) =>
    registerSourceDocument(
      { db, storage, ...extra },
      {
        siteId,
        sourceId,
        run: run && { runId: run.runId, generation: run.generation },
        operationId: operationIdFor(sourceId, run?.scheduledFor ?? 'manual', url()),
        url: url(),
        page: pageOf(html),
        extracted: extractDocument(html, url()),
        startedAt: new Date(),
      },
    );

  it('end to end: a scheduled `url` source becomes a source document with snapshot, attempt, processing job and event', async () => {
    const sourceId = await addUrlSource();
    await db.insert(ingestSchedule).values({ siteId, sourceId, nextRunAt: new Date(Date.now() - 1000) });
    const queue = new FakeQueue();
    const [job] = await scheduleDueSources({ db, queue });
    expect(job?.sourceId).toBe(sourceId);
    setSourceRunner(createIngestRunner(runnerDeps()));
    expect(await processSourceJob({ db, queue }, job as SourceJobPayload)).toBe('succeeded');

    const [doc] = await docs();
    expect(doc).toMatchObject({
      sourceId,
      url: url(),
      finalUrl: url(),
      title: 'Harbour busy',
      author: 'Jane Doe',
      language: 'en',
      fetchMethod: 'native',
      fetchProvider: 'native',
      licenceStatus: 'licensed',
      usageMode: 'facts_only',
      extractionRuleVersion: 'native-1',
      httpStatus: 200,
    });
    expect(doc!.bodyText).toContain('harbour authority');
    const [snap] = await snaps();
    expect(doc!.snapshotId).toBe(snap!.id);
    expect(storage.objects.get(snapshotKey(siteId, snap!.sha256))?.toString()).toBe(pageBody);
    expect(snap!.storageKey.startsWith(`sites/${siteId}/media/`)).toBe(false);
    expect(await jobs()).toEqual([expect.objectContaining({ sourceDocumentId: doc!.id, status: 'pending' })]);
    expect(await events()).toEqual([expect.objectContaining({ itemId: doc!.id, operation: 'create', collection: 'ingest_source_documents' })]);
    expect((await attempts()).map((a) => a.outcome)).toEqual(['succeeded']);
    expect(served).toEqual(['/robots.txt', '/news/harbour']);
    const [run] = await inSite((tx) => tx.select().from(ingestSourceRuns).where(eq(ingestSourceRuns.sourceId, sourceId)));
    expect(run).toMatchObject({ outcome: 'succeeded', itemsFound: 1, leaseUntil: null });

    // The outbox dispatcher hands the job to the queue once.
    expect(await dispatchProcessingJobs({ db, queue }, siteId)).toBe(1);
    expect(await dispatchProcessingJobs({ db, queue }, siteId)).toBe(0);
    expect(queue.jobs.filter((j) => j.queue === 'ingest-process')).toHaveLength(1);
  });

  it('robots.txt disallow: no page request, attempt and source health record access_denied', async () => {
    robotsBody = 'User-agent: HeoPressBot\nDisallow: /news/';
    const sourceId = await addUrlSource();
    setSourceRunner(createIngestRunner(runnerDeps()));
    expect(await processSourceJob({ db }, { siteId, sourceId, scheduledFor: new Date().toISOString() })).toBe('failed');
    expect(served).toEqual(['/robots.txt']);
    expect(await attempts()).toEqual([expect.objectContaining({ outcome: 'failed', failureCategory: 'access_denied' })]);
    const [source] = await inSite((tx) => tx.select().from(ingestSources).where(eq(ingestSources.id, sourceId)));
    expect(source).toMatchObject({ consecutiveFailures: 1, lastFailureCategory: 'access_denied' });
    expect(await docs()).toHaveLength(0);
  });

  it('a source URL pointing at an internal address is blocked (recorded as a security refusal)', async () => {
    const sourceId = await addUrlSource('http://10.0.0.5/admin');
    setSourceRunner(createIngestRunner(runnerDeps({ fetch: { robots: new RobotsCache() } })));
    expect(await processSourceJob({ db }, { siteId, sourceId, scheduledFor: new Date().toISOString() })).toBe('failed');
    const [source] = await inSite((tx) => tx.select().from(ingestSources).where(eq(ingestSources.id, sourceId)));
    expect(source!.lastFailureCategory).toBe('blocked');
  });

  it('object write failure: no document, no job, no event; the attempt says why; the run can be retried', async () => {
    const sourceId = await addUrlSource();
    storage.failPuts = true;
    setSourceRunner(createIngestRunner(runnerDeps()));
    expect(await processSourceJob({ db }, { siteId, sourceId, scheduledFor: '2026-10-26T08:00:00.000Z' })).toBe('failed');
    expect(await docs()).toHaveLength(0);
    expect(await jobs()).toHaveLength(0);
    expect(await events()).toHaveLength(0);
    expect(await attempts()).toEqual([expect.objectContaining({ outcome: 'failed', message: expect.stringContaining('object storage unavailable') })]);
    // The registered row without an object is an orphan: swept after the grace period.
    expect(await snaps()).toHaveLength(1);
    expect(await sweepOrphanSnapshots({ db, storage, graceMs: HOUR, now: () => new Date(Date.now() + 2 * HOUR) })).toHaveLength(1);
    expect(await snaps()).toHaveLength(0);
    storage.failPuts = false;
    expect(await processSourceJob({ db }, { siteId, sourceId, scheduledFor: '2026-10-26T09:00:00.000Z' })).toBe('succeeded');
    expect(await docs()).toHaveLength(1);
  });

  it('database rollback after the snapshot write: nothing registered; a retry within the grace period reuses the snapshot', async () => {
    const sourceId = await addUrlSource();
    const run = await startRun(sourceId);
    await expect(
      register(sourceId, run, pageBody, {
        beforeCommit: () => {
          throw new Error('connection lost before commit');
        },
      }),
    ).rejects.toThrow(/connection lost/);
    expect(await docs()).toHaveLength(0);
    expect(await jobs()).toHaveLength(0);
    expect(await events()).toHaveLength(0);
    const [orphan] = await snaps();
    expect(storage.objects.has(orphan!.storageKey)).toBe(true);
    // Inside the grace period the sweeper keeps it…
    expect(await sweepOrphanSnapshots({ db, storage, graceMs: HOUR })).toEqual([]);
    // …and the retry reuses it: one snapshot, one document, one job.
    const res = await register(sourceId, run, pageBody);
    expect(res.snapshotId).toBe(orphan!.id);
    expect(await snaps()).toHaveLength(1);
    expect(await docs()).toHaveLength(1);
    expect(await jobs()).toHaveLength(1);
    expect(await events()).toHaveLength(1);
    // Referenced: never swept, however old.
    expect(await sweepOrphanSnapshots({ db, storage, graceMs: HOUR, now: () => new Date(Date.now() + 48 * HOUR) })).toEqual([]);
    expect(storage.objects.has(orphan!.storageKey)).toBe(true);
  });

  it('crash after the snapshot write with no retry: the orphan is swept after the grace period; a later fetch writes it again', async () => {
    const sourceId = await addUrlSource();
    const snap = await writeSnapshot({ db, storage }, siteId, Buffer.from(pageBody));
    expect(await sweepOrphanSnapshots({ db, storage, graceMs: HOUR, now: () => new Date(Date.now() + HOUR / 2) })).toEqual([]);
    expect(await sweepOrphanSnapshots({ db, storage, graceMs: HOUR, now: () => new Date(Date.now() + 2 * HOUR) })).toEqual([snap.storageKey]);
    expect(storage.objects.has(snap.storageKey)).toBe(false);
    expect(await snaps()).toHaveLength(0);
    const res = await register(sourceId, await startRun(sourceId), pageBody);
    expect(res.duplicate).toBe(false);
    const [again] = await snaps();
    expect(again!.id).not.toBe(snap.id);
    expect(storage.objects.has(again!.storageKey)).toBe(true);
  });

  it('a retry of the same operation: same content → the existing document; different content → rejected', async () => {
    const sourceId = await addUrlSource();
    const run = await startRun(sourceId);
    const first = await register(sourceId, run, pageBody);
    const again = await register(sourceId, run, pageBody);
    expect(again).toMatchObject({ documentId: first.documentId, duplicate: true });
    await expect(register(sourceId, run, article('quiet'))).rejects.toBeInstanceOf(ReplayMismatchError);
    expect(await docs()).toHaveLength(1);
    expect(await jobs()).toHaveLength(1);
    expect(await events()).toHaveLength(1);
  });

  it('lease and generation: a run whose lease lapsed is taken over; the old worker cannot write documents or results', async () => {
    const sourceId = await addUrlSource();
    const payload = { siteId, sourceId, scheduledFor: '2026-10-26T08:00:00.000Z' };
    let release: () => void = () => undefined;
    let oldCtx: { runId: string; generation: number } | null = null;
    // Worker 1 starts the run and hangs inside the runner with a lease that lapses at once.
    setSourceRunner(async (ctx) => {
      oldCtx = { runId: ctx.runId, generation: ctx.generation };
      await new Promise<void>((r) => (release = r));
      return { itemsFound: 1 };
    });
    const worker1 = processSourceJob({ db, leaseMs: 1 }, payload);
    await expect.poll(() => oldCtx).not.toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    // Worker 2 (the redelivered job) takes the run over.
    let newGeneration = 0;
    setSourceRunner(async (ctx) => {
      newGeneration = ctx.generation;
      return { itemsFound: 0 };
    });
    expect(await processSourceJob({ db, leaseMs: HOUR }, payload)).toBe('succeeded');
    expect(newGeneration).toBe(2);
    // Worker 1 wakes up: its document write and its result are refused.
    await expect(register(sourceId, { ...oldCtx!, scheduledFor: payload.scheduledFor }, pageBody)).rejects.toBeInstanceOf(StaleRunError);
    release();
    expect(await worker1).toBe('stale');
    expect(await docs()).toHaveLength(0);
    const [run] = await inSite((tx) => tx.select().from(ingestSourceRuns).where(eq(ingestSourceRuns.sourceId, sourceId)));
    expect(run).toMatchObject({ generation: 2, outcome: 'succeeded', itemsFound: 0 });
  });

  it('a run abandoned by a dead worker is failed by the sweeper (no run stays `running` forever)', async () => {
    const sourceId = await addUrlSource();
    await inSite((tx) =>
      tx.insert(ingestSourceRuns).values({ siteId, sourceId, scheduledFor: new Date('2026-10-26T07:00:00Z'), leaseUntil: new Date(Date.now() - 2 * HOUR) }),
    );
    expect(await sweepAbandonedRuns({ db, graceMs: HOUR })).toHaveLength(1);
    const [run] = await inSite((tx) => tx.select().from(ingestSourceRuns).where(eq(ingestSourceRuns.sourceId, sourceId)));
    expect(run).toMatchObject({ outcome: 'failed', failureCategory: 'timeout' });
    expect(await sweepAbandonedRuns({ db, graceMs: HOUR })).toHaveLength(0);
  });

  it('per-host limits hold across processes: one slot and a minimum interval per host', async () => {
    const p1 = new DbHostLimiter(db, { concurrency: 1, minIntervalMs: 0 });
    const p2 = new DbHostLimiter(db, { concurrency: 1, minIntervalMs: 0 });
    const a = await p1.tryAcquire('shop.example.com');
    expect('release' in a).toBe(true);
    expect('waitMs' in (await p2.tryAcquire('shop.example.com'))).toBe(true);
    expect('release' in (await p2.tryAcquire('other.example.com'))).toBe(true);
    if ('release' in a) await a.release();
    expect('release' in (await p2.tryAcquire('shop.example.com'))).toBe(true);

    const spaced1 = new DbHostLimiter(db, { concurrency: 2, minIntervalMs: 60_000 });
    const spaced2 = new DbHostLimiter(db, { concurrency: 2, minIntervalMs: 60_000 });
    const first = await spaced1.tryAcquire('slow.example.com');
    expect('release' in first).toBe(true);
    const second = await spaced2.tryAcquire('slow.example.com');
    expect('waitMs' in second && second.waitMs).toBeGreaterThan(50_000);
  });

  it('the snapshot: administrators download it as an inert attachment; editors cannot; the media route cannot reach it', async () => {
    const sourceId = await addUrlSource();
    const { documentId } = await register(sourceId, await startRun(sourceId), pageBody);
    const admin = fx.headers('a', await fx.session('adminA', 'a'));
    const res = await app.request(`/api/v1/ingest/documents/${documentId}/snapshot`, { headers: admin }, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    expect(await res.text()).toBe(pageBody);

    const editor = fx.headers('a', await fx.session('onlyA', 'a'));
    expect((await app.request(`/api/v1/ingest/documents/${documentId}/snapshot`, { headers: editor }, env)).status).toBe(403);
    const other = fx.headers('b', await fx.session('adminB', 'b'));
    expect((await app.request(`/api/v1/ingest/documents/${documentId}/snapshot`, { headers: other }, env)).status).toBe(404);

    const [snap] = await snaps();
    for (const key of [snap!.storageKey, `../../${snap!.storageKey}`, `..%2F..%2F${snap!.storageKey}`]) {
      const media = await app.request(`/api/v1/media/${key}`, { headers: admin }, env);
      expect(media.status, key).not.toBe(200);
    }
  });
});
