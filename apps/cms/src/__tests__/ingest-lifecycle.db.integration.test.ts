import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { crc32 } from 'node:zlib';
import postgres from 'postgres';
import sharp from 'sharp';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  cdcChangeEvents,
  ensureRenderRole,
  ingestDiscoveredUrls,
  ingestDocumentMedia,
  ingestHostSlots,
  ingestMedia,
  ingestProcessingJobs,
  ingestResearchLeads,
  ingestSourceDocuments,
  ingestSources,
  items,
  licenceLapseReviews,
  notifications,
  publicItems,
  schema,
  siteDomains,
  type Database,
} from '@heopress/database';
import { createSiteClassic, type SiteClassic } from '@heopress/site-classic';
import type { StorageObject, StorageProvider } from '@heopress/runtime';
import { classifyAddress, createRuntime, type AddressClass } from '@heopress/runtime/node';
import app from '../index';
import { setRuntimeFactory } from '../middleware/runtime';
import { ItemService } from '../services/item-service';
import { runSiteTransaction } from '../services/rls-transaction';
import { extractDocument } from '../services/ingest/extract';
import { DbHostLimiter } from '../services/ingest/host-limiter';
import { recordDerivation, sweepLicenceLapses } from '../services/ingest/licence-lapse';
import { RobotsCache } from '../services/ingest/robots';
import { IngestSiteSettingsService } from '../services/ingest/site-settings';
import { operationIdFor, registerSourceDocument } from '../services/ingest/source-documents';
import { processDocumentMedia, setMediaLicence } from '../services/ingest/source-media';
import { IngestSourceService } from '../services/ingest/source-service';
import { maintainIngestSites, type IngestRunnerDeps } from '../services/ingest/url-runner';
import { upgradeSitePreset } from '../services/site-network/preset-installer';
import { rebuildSiteProjection } from '../services/site-network/public-projection';
import { connectDbIntegration, dbIntegrationUrl, hasDbIntegrationUrl } from './helpers/db-harness';
import { createCrossSiteFixture, type CrossSiteFixture } from './helpers/cross-site-fixture';

/**
 * After registration (HeoPress P08 tasks 1.6, 1.7, 2.9; spec ingest/sources "授权失效后的已发布内容", "研究线索",
 * ingest/crawling "来源媒体处理"): a published article derived from a licensed source disappears from the public site
 * and its sitemap when the licence review is overdue, and stays hidden after the licence is renewed until a person
 * confirms it; research leads from a discovery-only source's allow-listed links, fetched under their own source's
 * terms; source media with their own licences, format from the bytes, pixel caps, one row per image.
 *
 * The public site is `site-classic` connected as a rendering role (as a deployment runs it). Pages and images are
 * served from loopback under example.* host names (an injected resolver); nothing leaves the machine.
 */

const JWT_SECRET = 'ingest-lifecycle-test-secret';
const RENDER_ROLE = 'heopress_render_ingest_lifecycle';
const OWNER_URL = process.env.DATABASE_OWNER_URL?.trim() || undefined;
const HOST = 'lifecycle-a.example.com';
const DAY = 86_400_000;

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

/** A PNG whose header claims `width`×`height` (the header is all a size check may read before decoding). */
function pngClaiming(base: Buffer, width: number, height: number): Buffer {
  const out = Buffer.from(base);
  // Signature (8) + IHDR length (4) + type (4): width and height follow, then the IHDR CRC over type + data (17 bytes).
  out.writeUInt32BE(width, 16);
  out.writeUInt32BE(height, 20);
  out.writeUInt32BE(crc32(out.subarray(12, 29)) >>> 0, 29);
  return out;
}

let server: Server;
let port = 0;
const served: string[] = [];
const routes = new Map<string, { status?: number; type: string; body: Buffer | string } | (() => { status?: number; type: string; body: Buffer | string })>();

/** Every host → 127.0.0.1, treated as a public address. */
const boundary = {
  resolve: async () => [{ address: '127.0.0.1', family: 4 }],
  classify: (ip: string): AddressClass => (ip === '127.0.0.1' ? 'public' : classifyAddress(ip)),
};

const article = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><title>${title}</title></head><body><article><h1>${title}</h1>${body}</article></body></html>`;
const para = (s: string, n = 5) => `<p>${s}</p>`.repeat(n);

describe.skipIf(!hasDbIntegrationUrl)('ingest after registration — DB integration', () => {
  let db: Database;
  let fx: CrossSiteFixture;
  let storage: MemoryStorage;
  let siteId: string;
  let owner: postgres.Sql;
  let renderClient: postgres.Sql;
  let site: SiteClassic;
  let png: Buffer;

  beforeAll(async () => {
    expect(OWNER_URL, 'DATABASE_OWNER_URL is required to provision the rendering role').toBeDefined();
    db = await connectDbIntegration('ingest-lifecycle');
    owner = postgres(OWNER_URL!, { max: 1, onnotice: () => {} });
    const password = randomBytes(18).toString('hex');
    await owner.begin((tx) => ensureRenderRole(tx, { role: RENDER_ROLE, password }));
    const url = new URL(dbIntegrationUrl!);
    url.username = RENDER_ROLE;
    url.password = password;
    renderClient = postgres(url.toString(), { max: 2, onnotice: () => {} });
    site = createSiteClassic({ db: drizzle(renderClient, { schema }) as unknown as Database, traffic: false, sweepIntervalMs: 0 });
    png = await sharp({ create: { width: 8, height: 6, channels: 3, background: '#3366aa' } }).png().toBuffer();
    server = createServer((req, res) => {
      const path = (req.url ?? '').split('?')[0]!;
      served.push(`${req.headers.host?.split(':')[0]}${req.url}`);
      if (path === '/robots.txt') return void res.writeHead(200, { 'content-type': 'text/plain' }).end('');
      const r = routes.get(path);
      const route = typeof r === 'function' ? r() : r;
      if (!route) return void res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      res.writeHead(route.status ?? 200, { 'content-type': route.type }).end(route.body);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as AddressInfo).port;
  }, 60_000);
  beforeEach(async () => {
    fx = await createCrossSiteFixture(db, { prefix: 'inglc', jwtSecret: JWT_SECRET });
    siteId = fx.sites.a;
    storage = new MemoryStorage();
    const runtime = createRuntime({ ...process.env, JWT_SECRET, HEOPRESS_ENV: 'development' });
    setRuntimeFactory(() => ({ ...runtime, storage }));
    served.length = 0;
    routes.clear();
    await db.delete(ingestHostSlots);
  });
  afterEach(async () => {
    setRuntimeFactory(null);
    if (fx) await fx.teardown();
  });
  afterAll(async () => {
    server?.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await site?.close();
    await renderClient?.end({ timeout: 2 });
    await owner?.end({ timeout: 2 });
  });

  const at = (host: string, path: string) => `http://${host}:${port}${path}`;
  const inSite = <T,>(fn: Parameters<typeof runSiteTransaction<T>>[2]) => runSiteTransaction(db, siteId, fn);
  const env = { ...process.env, JWT_SECRET, HEOPRESS_ENV: 'development' };
  const api = async (path: string, init: RequestInit & { bearer: string }) =>
    app.request(`/api/v1${path}`, { ...init, headers: { ...fx.headers('a', init.bearer), 'content-type': 'application/json' } }, env);
  const admin = { isAdmin: true, userId: null };
  const sources = () => new IngestSourceService({ db, siteId, actor: admin });
  const runnerDeps = (extra: Partial<IngestRunnerDeps> = {}): IngestRunnerDeps => ({
    db,
    storage,
    limiter: new DbHostLimiter(db, { minIntervalMs: 0 }),
    fetch: { ...boundary, robots: new RobotsCache() },
    ...extra,
  });

  /** A source with the given terms (a licence revision with evidence, as an administrator sets them). */
  async function addSource(name: string, url: string, terms: Record<string, unknown> | null): Promise<string> {
    const s = await sources().create({ name, type: 'url', url, scheduleTimes: ['08:00'], timezone: 'UTC' });
    if (terms) await sources().reviseLicence(s.id, { evidence: 'Signed agreement EX-1', ...terms });
    return s.id;
  }

  /** Register a fetched page as a document of `sourceId` (the pipeline after the fetch). */
  async function register(sourceId: string, url: string, html: string): Promise<string> {
    const res = await registerSourceDocument(
      { db, storage },
      {
        siteId,
        sourceId,
        run: null,
        operationId: operationIdFor(sourceId, 'manual', url),
        url,
        page: { url, finalUrl: url, status: 200, contentType: 'text/html', headers: new Headers(), body: Buffer.from(html), durationMs: 3 },
        extracted: extractDocument(html, url),
        startedAt: new Date(),
      },
    );
    return res.documentId;
  }

  describe('licence lapse (task 1.6)', () => {
    async function publicSite() {
      await upgradeSitePreset(db, siteId);
      await db.insert(siteDomains).values({ siteId, hostname: HOST, kind: 'custom', status: 'active', isPrimary: true, verifiedAt: new Date() });
      await rebuildSiteProjection(db, siteId);
    }
    /** A public request; a redirect to the canonical form of the path (trailing slash) is followed once. */
    const get = async (path: string) => {
      let res = await site.app.request(path, { headers: { host: HOST } });
      const location = res.headers.get('location');
      if (res.status === 301 && location) res = await site.app.request(new URL(location, `http://${HOST}`).pathname, { headers: { host: HOST } });
      return { status: res.status, text: await res.text() };
    };

    /** A published article derived (rewritten) from a document of a licensed-derivative source whose review is due in a day. */
    async function derivedArticle() {
      await publicSite();
      const reviewDueAt = new Date(Date.now() + DAY).toISOString();
      const sourceId = await addSource('Wire', at('wire.example.com', '/a'), { licenceStatus: 'licensed', usageMode: 'licensed_derivative', commercialUse: true, reviewDueAt });
      const documentId = await register(sourceId, at('wire.example.com', '/a'), article('Harbour season', para('The harbour authority in Example Town reported a busy season for ferries and fishing boats.')));
      const created = (await new ItemService({ db, siteId }).create('articles', {
        data: { title: 'Harbour season, explained', slug: 'harbour-season', locale: 'en', body: '<p>Our own account of the busy harbour season.</p>' },
        status: 'published',
      })) as { id: string };
      await recordDerivation(db, { siteId, itemId: created.id, sourceDocumentId: documentId, operation: 'rewrite' });
      const [row] = await projected(created.id);
      path = row!.path;
      return { sourceId, itemId: created.id, reviewDueAt };
    }
    /** The article's public path (from its projection while it was public). */
    let path = '';
    const item = (id: string) => inSite(async (tx) => (await tx.select().from(items).where(eq(items.id, id)))[0]!);
    const projected = (id: string) => inSite((tx) => tx.select().from(publicItems).where(eq(publicItems.itemId, id)));
    const reviews = () => inSite((tx) => tx.select().from(licenceLapseReviews).where(eq(licenceLapseReviews.siteId, siteId)));

    it('review overdue: the derived article leaves the public site and its sitemap in one transaction with its event, and enters the review queue', async () => {
      const { itemId } = await derivedArticle();
      expect((await get(path)).status).toBe(200);
      expect((await get('/sitemap.txt')).text).toContain(path);

      // Before the due date nothing happens.
      expect(await sweepLicenceLapses({ db })).toEqual({ hidden: [], flagged: [] });
      // After it: hidden.
      const later = () => new Date(Date.now() + 2 * DAY);
      expect((await sweepLicenceLapses({ db, now: later })).hidden).toEqual([itemId]);
      expect(await item(itemId)).toMatchObject({ status: 'draft', hold: true });
      expect(await projected(itemId)).toEqual([]);
      expect((await get(path)).status).not.toBe(200);
      expect((await get('/sitemap.txt')).text).not.toContain(path);
      // The change event the existing consumers (cache, discovery files, IndexNow, Astro build) react to.
      const events = await inSite((tx) => tx.select().from(cdcChangeEvents).where(and(eq(cdcChangeEvents.siteId, siteId), eq(cdcChangeEvents.itemId, itemId))));
      expect(events.at(-1)).toMatchObject({ resource: 'item', collection: 'articles', operation: 'update', changedFields: ['status', 'hold'] });
      expect(events.at(-1)!.payload).toMatchObject({ reason: 'licence_lapse', lapse: 'review_overdue' });
      // The review queue and the withdrawal notice.
      expect(await reviews()).toEqual([expect.objectContaining({ itemId, reason: 'review_overdue', action: 'hidden', state: 'open', previousStatus: 'published' })]);
      const notes = await inSite((tx) => tx.select().from(notifications).where(and(eq(notifications.siteId, siteId), eq(notifications.item, itemId))));
      expect(notes.map((n) => n.subject)).toEqual(['Withdrawn: Harbour season, explained']);
      // A second sweep changes nothing.
      expect(await sweepLicenceLapses({ db, now: later })).toEqual({ hidden: [], flagged: [] });
      expect(await reviews()).toHaveLength(1);

      const list = await api('/ingest/licence-reviews', { bearer: await fx.session('onlyA', 'a') });
      expect(((await list.json()) as { data: Array<{ itemId: string; licenceEffective: boolean }> }).data).toEqual([
        expect.objectContaining({ itemId, licenceEffective: true }),
      ]);
    });

    it('licence renewed: the article stays hidden until a person with rights confirms it; then it is public and in the sitemap again', async () => {
      const { sourceId, itemId } = await derivedArticle();
      const overdue = new Date(Date.now() + 2 * DAY);
      await sweepLicenceLapses({ db, now: () => overdue });
      const [review] = await reviews();
      const adminSession = await fx.session('adminA', 'a');
      const resolve = (bearer: string) => api('/ingest/licence-reviews/resolve', { method: 'POST', bearer, body: JSON.stringify({ ids: [review!.id], decision: 'restore' }) });

      // Still overdue (at the real clock the review is not due yet, so move the due date into the past): refused.
      await sources().reviseLicence(sourceId, { evidence: 'Agreement EX-1', licenceStatus: 'licensed', usageMode: 'licensed_derivative', reviewDueAt: new Date(Date.now() - DAY).toISOString() });
      const refused = (await (await resolve(adminSession)).json()) as { data: { resolved: string[]; refused: Array<{ code: string }> } };
      expect(refused.data).toEqual({ resolved: [], refused: [expect.objectContaining({ code: 'LICENCE_NOT_EFFECTIVE' })] });

      // The administrator renews the evidence and extends the review: nothing is republished by itself.
      await sources().reviseLicence(sourceId, { evidence: 'Agreement EX-1, renewed', licenceStatus: 'licensed', usageMode: 'licensed_derivative', reviewDueAt: new Date(Date.now() + 90 * DAY).toISOString() });
      await sweepLicenceLapses({ db });
      expect(await item(itemId)).toMatchObject({ status: 'draft', hold: true });
      expect((await get(path)).status).not.toBe(200);
      // The item's own hold cannot be released past the review.
      const held = await item(itemId);
      const release = await api(`/items/articles/${itemId}/hold`, { method: 'DELETE', bearer: adminSession, body: JSON.stringify({ expectedVersion: held.version }) });
      expect(release.status).toBe(409);
      expect(JSON.stringify(await release.json())).toContain('LICENCE_REVIEW_OPEN');
      expect(await item(itemId)).toMatchObject({ hold: true });

      // Not by an API key, not by a member without administration.
      expect((await resolve(fx.apiKeys.aEditor.token)).status).toBe(403);
      expect((await resolve(await fx.session('onlyA', 'a'))).status).toBe(403);
      // A person with rights confirms it.
      const ok = await resolve(adminSession);
      expect(ok.status).toBe(200);
      expect(((await ok.json()) as { data: { resolved: string[] } }).data.resolved).toEqual([review!.id]);
      expect(await item(itemId)).toMatchObject({ status: 'published', hold: false });
      expect((await get(path)).status).toBe(200);
      expect((await get('/sitemap.txt')).text).toContain(path);
      expect(await reviews()).toEqual([expect.objectContaining({ state: 'restored', resolvedBy: fx.users.adminA.id })]);
      // The restored item is not hidden again by the same (now effective) licence.
      expect((await sweepLicenceLapses({ db })).hidden).toEqual([]);
    });

    it('policy `flag`: the article stays public and is queued for review; a revoked licence counts as a lapse', async () => {
      const { sourceId, itemId } = await derivedArticle();
      const put = await api('/ingest/settings', { method: 'PUT', bearer: await fx.session('adminA', 'a'), body: JSON.stringify({ licenceLapsePolicy: 'flag', primarySourcePatterns: [] }) });
      expect(put.status).toBe(200);
      // Revoked: the administrator withdraws the derivative use.
      await sources().reviseLicence(sourceId, { evidence: 'Agreement ended', licenceStatus: 'licensed', usageMode: 'facts_only' });
      expect(await sweepLicenceLapses({ db })).toEqual({ hidden: [], flagged: [itemId] });
      expect(await item(itemId)).toMatchObject({ status: 'published', hold: false });
      expect((await get(path)).status).toBe(200);
      expect(await reviews()).toEqual([expect.objectContaining({ reason: 'revoked', action: 'flagged', state: 'open' })]);
      // A source whose documents content derives from cannot be deleted.
      await expect(sources().remove(sourceId)).rejects.toMatchObject({ code: 'IN_USE' });
    });
  });

  describe('research leads (task 1.7)', () => {
    it('an allow-listed link of a discovery-only document becomes a lead, fetched under its own source; the other link does not; the lead inherits nothing', async () => {
      await new IngestSiteSettingsService({ db, siteId, userId: null }).update({ licenceLapsePolicy: 'hide', primarySourcePatterns: ['vendor.example.org/releases/'] });
      // The origin: discovery only, but otherwise generous terms — none of which may reach the lead.
      const origin = await addSource('Tech news', at('news.example.com', '/'), {
        licenceStatus: 'licensed',
        usageMode: 'discovery_only',
        commercialUse: true,
        trustLevel: 'high',
        attribution: 'Credit: Tech news',
      });
      routes.set('/releases/v2', { type: 'text/html', body: article('Version 2 release notes', para('Version 2 of the example toolkit ships a new scheduler, faster builds and an updated plugin interface.')) });
      routes.set('/post', { type: 'text/html', body: article('Opinion', para('An opinion piece about the release, written by a blogger who tried it.')) });
      const official = at('vendor.example.org', '/releases/v2');
      const blog = at('blog.example.net', '/post');
      const documentId = await register(
        origin,
        at('news.example.com', '/story'),
        article('Toolkit 2 is out', para(`The vendor announced version 2 in its <a href="${official}">release notes</a>; a <a href="${blog}">blogger</a> tried it first. The toolkit is used widely.`)),
      );

      // The origin document's body never enters processing: its job is a lead job.
      expect(await inSite((tx) => tx.select({ kind: ingestProcessingJobs.kind }).from(ingestProcessingJobs).where(eq(ingestProcessingJobs.sourceDocumentId, documentId)))).toEqual([{ kind: 'lead' }]);
      const leads = () => inSite((tx) => tx.select().from(ingestResearchLeads).where(eq(ingestResearchLeads.siteId, siteId)));
      expect(await leads()).toEqual([
        expect.objectContaining({ originSourceId: origin, originDocumentId: documentId, url: official, matchedPattern: 'vendor.example.org/releases/', status: 'pending' }),
      ]);

      await maintainIngestSites(runnerDeps());
      const [lead] = await leads();
      expect(lead).toMatchObject({ status: 'queued' });
      expect(lead!.leadSourceId).not.toBe(origin);
      expect(served).toContain('vendor.example.org/releases/v2');
      expect(served.some((s) => s.startsWith('blog.example.net'))).toBe(false);

      // Its own source: managed for the host, the default terms — not the origin's.
      const [leadSource] = await inSite((tx) => tx.select().from(ingestSources).where(eq(ingestSources.id, lead!.leadSourceId!)));
      expect(leadSource).toMatchObject({
        managedBy: 'research_leads',
        status: 'paused',
        licenceStatus: 'unknown',
        usageMode: 'discovery_only',
        commercialUse: false,
        trustLevel: 'low',
        attribution: null,
      });
      const [doc] = await inSite((tx) => tx.select().from(ingestSourceDocuments).where(and(eq(ingestSourceDocuments.siteId, siteId), eq(ingestSourceDocuments.sourceId, leadSource!.id))));
      expect(doc).toMatchObject({ url: official, title: 'Version 2 release notes', licenceStatus: 'unknown', usageMode: 'discovery_only', commercialUse: false });
      const [discovered] = await inSite((tx) => tx.select().from(ingestDiscoveredUrls).where(eq(ingestDiscoveredUrls.id, lead!.discoveredUrlId!)));
      expect(discovered).toMatchObject({ status: 'fetched', sourceDocumentId: doc!.id });
      // The managed source is never scheduled.
      await expect(sources().resume(leadSource!.id)).rejects.toMatchObject({ code: 'MANAGED_SOURCE' });
      // Members see the leads.
      const res = await api('/ingest/leads', { bearer: await fx.session('onlyA', 'a') });
      expect(((await res.json()) as { data: unknown[] }).data).toEqual([expect.objectContaining({ url: official, status: 'queued' })]);
    });
  });

  describe('source media (task 2.9)', () => {
    const img = (name: string) => at('img.example.com', `/img/${name}`);
    const refs = (documentId: string) =>
      inSite((tx) => tx.select().from(ingestDocumentMedia).where(and(eq(ingestDocumentMedia.siteId, siteId), eq(ingestDocumentMedia.documentId, documentId))));
    const media = () => inSite((tx) => tx.select().from(ingestMedia).where(eq(ingestMedia.siteId, siteId)));
    const licence = (name: string) => setMediaLicence(db, siteId, null, { url: img(name), evidence: 'Photographer licence PL-7', allowedUses: ['copy'] });
    const deps = () => ({ db, storage, limiter: new DbHostLimiter(db, { minIntervalMs: 0 }), fetch: { ...boundary, robots: new RobotsCache() } });
    const page = (imgs: string[]) =>
      article('Harbour photos', para('The harbour authority in Example Town published photographs of the busy season for ferries and boats.') + imgs.map((n) => `<p><img src="${img(n)}" width="100" height="100" alt="${n}"></p>`).join(''));

    it('unlicensed image not copied, wrong type and oversized pixels refused, a licensed one stored; the document is unaffected', async () => {
      const sourceId = await addSource('Photos', at('photos.example.com', '/'), { licenceStatus: 'licensed', usageMode: 'licensed_derivative' });
      routes.set('/img/ok.png', { type: 'image/png', body: png });
      routes.set('/img/unlicensed.png', { type: 'image/png', body: png });
      // Claims to be a PNG (URL and header): the bytes are HTML.
      routes.set('/img/fake.png', { type: 'image/png', body: '<html><script>alert(1)</script></html>' });
      // Small in the markup and in bytes; 20000×20000 in its header.
      routes.set('/img/huge.png', { type: 'image/png', body: pngClaiming(png, 20_000, 20_000) });
      for (const n of ['ok.png', 'fake.png', 'huge.png']) await licence(n);
      const documentId = await register(sourceId, at('photos.example.com', '/a'), page(['ok.png', 'unlicensed.png', 'fake.png', 'huge.png']));

      const outcome = await processDocumentMedia(deps(), siteId, documentId);
      expect([...outcome.values()].sort()).toEqual(['failed', 'failed', 'stored', 'unlicensed']);
      const byUrl = new Map((await refs(documentId)).map((r) => [r.url, r]));
      expect(byUrl.get(img('unlicensed.png'))).toMatchObject({ status: 'unlicensed', mediaId: null });
      expect(served).not.toContain('img.example.com/img/unlicensed.png');
      expect(byUrl.get(img('fake.png'))).toMatchObject({ status: 'failed' });
      expect(byUrl.get(img('fake.png'))!.reason).toMatch(/^unsupported_format/);
      expect(byUrl.get(img('huge.png'))!.reason).toMatch(/^too_many_pixels: 20000×20000/);
      const [stored] = await media();
      expect(stored).toMatchObject({ format: 'png', width: 8, height: 6, byteSize: png.byteLength });
      expect(byUrl.get(img('ok.png'))).toMatchObject({ status: 'stored', mediaId: stored!.id });
      expect(storage.objects.get(stored!.storageKey)?.equals(png)).toBe(true);
      expect(stored!.storageKey.startsWith(`ingest/media/${siteId}/`)).toBe(true);
      // The document is there whatever its images did; final refusals are not retried.
      expect(await inSite((tx) => tx.select({ id: ingestSourceDocuments.id }).from(ingestSourceDocuments).where(eq(ingestSourceDocuments.id, documentId)))).toHaveLength(1);
      expect((await processDocumentMedia(deps(), siteId, documentId)).size).toBe(0);
    });

    it('the same image from two documents at once is one media row; a retry after a failure does not duplicate it', async () => {
      const sourceId = await addSource('Photos', at('photos.example.com', '/'), null);
      routes.set('/img/shared.png', { type: 'image/png', body: png });
      let flaky = 0;
      routes.set('/img/flaky.png', () => (flaky++ === 0 ? { status: 503, type: 'text/plain', body: 'busy' } : { type: 'image/png', body: png }));
      await licence('shared.png');
      await licence('flaky.png');
      const one = await register(sourceId, at('photos.example.com', '/one'), page(['shared.png']));
      const two = await register(sourceId, at('photos.example.com', '/two'), article('Another view', para('A second article on the harbour, from another angle, with the same shared photograph of the boats.') + `<p><img src="${img('shared.png')}"></p>`));
      await Promise.all([processDocumentMedia(deps(), siteId, one), processDocumentMedia(deps(), siteId, two)]);
      expect(await media()).toHaveLength(1);
      const [m] = await media();
      expect([...(await refs(one)), ...(await refs(two))].map((r) => [r.status, r.mediaId])).toEqual([
        ['stored', m!.id],
        ['stored', m!.id],
      ]);

      // Fails before registration (503), then succeeds: one row (the same bytes as the shared image: the same row).
      const three = await register(sourceId, at('photos.example.com', '/three'), article('Third', para('A third harbour article about the ferries, the boats and the busy season in Example Town.') + `<p><img src="${img('flaky.png')}"></p>`));
      await processDocumentMedia(deps(), siteId, three);
      expect((await refs(three))[0]).toMatchObject({ status: 'failed', attempts: 1 });
      await processDocumentMedia(deps(), siteId, three);
      expect((await refs(three))[0]).toMatchObject({ status: 'stored', mediaId: m!.id, attempts: 2 });
      expect(await media()).toHaveLength(1);
    });
  });
});
