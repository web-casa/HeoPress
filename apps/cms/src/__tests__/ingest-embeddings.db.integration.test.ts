import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { ingestDedupIndex, ingestSourceDocuments, ingestSources, llmAttempts, llmCalls, type Database } from '@heopress/database';
import type { StorageObject, StorageProvider } from '@heopress/runtime';
import { createRuntime, outboundFetch, parseTrustedEndpoints } from '@heopress/runtime/node';
import { LlmGateway, LlmGatewayError } from '../services/llm/gateway';
import { LlmProviderService } from '../services/llm/provider-service';
import { runSiteTransaction } from '../services/rls-transaction';
import { extractDocument } from '../services/ingest/extract';
import { gatewayEmbedder, type NearDuplicateOptions } from '../services/ingest/near-duplicate';
import { operationIdFor, registerSourceDocument } from '../services/ingest/source-documents';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { createCrossSiteFixture, type CrossSiteFixture } from './helpers/cross-site-fixture';

/**
 * Embeddings through the model gateway (HeoPress P08 task 4.2; P04 design "统一出口"): the near-duplicate check embeds
 * a body with the site's `embedding` provider list — reserved, recorded per attempt and settled in the ledger like any
 * model call, failing over along the list — and skips with a reason on a site without one. The OpenAI-compatible
 * service is a loopback double (`POST /<provider>/embeddings`): a bag of words hashed into 64 dimensions.
 */

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

function bagOfWords(text: string): number[] {
  const v = new Array<number>(64).fill(0);
  for (const w of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    let h = 0;
    for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    v[h % 64]! += 1;
  }
  return v;
}

/** Per provider path: 'ok' answers, 'down' answers 503. */
const behaviour: Record<string, 'ok' | 'down'> = {};
const hits: string[] = [];

describe.skipIf(!hasDbIntegrationUrl)('near-duplicate embeddings through the model gateway — DB integration', () => {
  let db: Database;
  let fx: CrossSiteFixture;
  let keys: ReturnType<typeof createRuntime>['keys'];
  let server: Server;
  let origin = '';
  let site = '';

  beforeAll(async () => {
    db = await connectDbIntegration('ingest-embeddings');
    keys = createRuntime({ ...process.env, ENCRYPTION_KEY: KEK, HEOPRESS_ENV: 'development' }).keys;
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
      req.on('end', () => {
        const provider = (req.url ?? '').split('/')[1] ?? '';
        hits.push(`${provider}${(req.url ?? '').slice(provider.length + 1)}`);
        if (behaviour[provider] !== 'ok') return void res.writeHead(503, { 'content-type': 'application/json' }).end('{"error":{"message":"busy"}}');
        const body = JSON.parse(raw) as { input: string; model: string };
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({ data: [{ embedding: bagOfWords(body.input), index: 0 }], model: body.model, usage: { prompt_tokens: 40, total_tokens: 40 } }),
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  beforeEach(async () => {
    fx = await createCrossSiteFixture(db, { prefix: 'ingemb', jwtSecret: 'ingemb-secret' });
    site = fx.sites.a;
    hits.length = 0;
    for (const k of Object.keys(behaviour)) delete behaviour[k];
  });
  afterEach(async () => {
    if (fx) await fx.teardown();
  });
  afterAll(async () => {
    server?.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  const trustedFetch = (url: string, init: RequestInit) => outboundFetch(url, { ...init, purpose: 'service', trusted: parseTrustedEndpoints(origin) });
  const gateway = () => new LlmGateway({ db, keys, env: {}, fetch: trustedFetch });
  /** Two embedding providers on the double (paths /e1 and /e2), the `embedding` list → [e1, e2]; a chat model on `default`. */
  async function setup(siteId = site) {
    const svc = new LlmProviderService({ db, siteId, keys, instanceCurrency: 'USD' });
    const mk = (name: string, path: string) =>
      svc.create({
        kind: 'openai_compatible',
        name,
        baseUrl: `${origin}/${path}`,
        model: `embed-${path}`,
        apiKey: `sk-${path}-never-logged`,
        capabilities: { tools: false, json: false, maxContext: null },
        pricing: { kind: 'per_1m_tokens', inputMicros: 100_000, outputMicros: 0 },
        currency: 'USD',
        timeoutMs: 2000,
      });
    const e1 = await mk('Embed primary', 'e1');
    const e2 = await mk('Embed backup', 'e2');
    const chat = await svc.create({
      kind: 'openai_compatible',
      name: 'Chat',
      baseUrl: `${origin}/chat`,
      model: 'chat-model',
      apiKey: 'sk-chat',
      capabilities: { tools: true, json: true, maxContext: null },
      pricing: { kind: 'per_1m_tokens', inputMicros: 1, outputMicros: 1 },
      currency: 'USD',
      timeoutMs: 2000,
    });
    await svc.setRoute('default', [chat.id]);
    await svc.setRoute('embedding', [e1.id, e2.id]);
  }

  it('an embedding is a ledger call on the site’s embedding list, failing over to the next provider; never the default (chat) list', async () => {
    await setup();
    behaviour.e1 = 'down';
    behaviour.e2 = 'ok';
    const out = await gateway().embed({ siteId: site, origin: { kind: 'test' }, text: 'harbour ferries busy season' });
    expect(out).toMatchObject({ provider: 'Embed backup', model: 'embed-e2' });
    expect(out.embedding).toEqual(bagOfWords('harbour ferries busy season'));
    expect(hits).toEqual(['e1/embeddings', 'e2/embeddings']);
    const [call] = await runSiteTransaction(db, site, (tx) => tx.select().from(llmCalls).where(eq(llmCalls.siteId, site)));
    expect(call).toMatchObject({ taskType: 'embedding', status: 'completed' });
    const attempts = await runSiteTransaction(db, site, (tx) => tx.select().from(llmAttempts).where(eq(llmAttempts.siteId, site)).orderBy(llmAttempts.seq));
    expect(attempts.map((a) => a.outcome)).toEqual(['failed_transferable', 'succeeded']);
    // 40 input tokens at 0.1 per million: rounded up to one micro-unit.
    expect(attempts[1]).toMatchObject({ billing: 'settled', inputTokens: 40, outputTokens: 0 });
  });

  it('a site without an embedding list: not configured — even with a default (chat) list', async () => {
    const svc = new LlmProviderService({ db, siteId: site, keys, instanceCurrency: 'USD' });
    const chat = await svc.create({
      kind: 'openai_compatible',
      name: 'Chat',
      baseUrl: `${origin}/chat`,
      model: 'chat-model',
      apiKey: 'sk-chat',
      capabilities: { tools: true, json: true, maxContext: null },
      pricing: { kind: 'per_1m_tokens', inputMicros: 1, outputMicros: 1 },
      currency: 'USD',
      timeoutMs: 2000,
    });
    await svc.setRoute('default', [chat.id]);
    const g = gateway();
    expect(await g.embeddingConfigured(site)).toBe(false);
    await expect(g.embed({ siteId: site, origin: { kind: 'test' }, text: 'x' })).rejects.toMatchObject({ code: 'LLM_NOT_CONFIGURED' });
    expect(await gatewayEmbedder(g).embed({ siteId: site, text: 'x' })).toBeNull();
    expect(hits).toEqual([]);
    expect(LlmGatewayError).toBeDefined();
  });

  it('the near-duplicate check embeds through the gateway: a reworded copy is flagged; a site without a model skips with a reason', async () => {
    await setup();
    behaviour.e1 = 'ok';
    const storage = new MemoryStorage();
    const nearDuplicate: NearDuplicateOptions = { embedder: gatewayEmbedder(gateway()), threshold: 0.9, windowDays: 30, candidateLimit: 500 };
    const source = async (siteId: string) =>
      runSiteTransaction(db, siteId, async (tx) => {
        const [row] = await tx.insert(ingestSources).values({ siteId, name: `s ${Math.random()}`, type: 'url', url: 'https://news.example.com/', scheduleTimes: ['08:00'], timezone: 'UTC' }).returning();
        return row!.id;
      });
    const page = (title: string, sentence: string) =>
      `<!doctype html><html lang="en"><head><title>${title}</title></head><body><article><h1>${title}</h1>${`<p>${sentence}</p>`.repeat(5)}</article></body></html>`;
    const register = async (siteId: string, sourceId: string, url: string, html: string) =>
      registerSourceDocument(
        { db, storage, dedup: { nearDuplicate } },
        {
          siteId,
          sourceId,
          run: null,
          operationId: operationIdFor(sourceId, 'manual', url),
          url,
          page: { url, finalUrl: url, status: 200, contentType: 'text/html', headers: new Headers(), body: Buffer.from(html), durationMs: 1 },
          extracted: extractDocument(html, url),
          startedAt: new Date(),
        },
      );
    const s1 = await source(site);
    const first = await register(site, s1, 'https://news.example.com/a', page('Harbour busy', 'The harbour authority in Example Town reported a busy season for ferries, fishing boats and visiting yachts this year.'));
    const second = await register(site, s1, 'https://news.example.com/b', page('Harbour very busy', 'The harbour authority of Example Town reported a very busy season for ferries, fishing boats and visiting yachts this year.'));
    const docs = await runSiteTransaction(db, site, (tx) => tx.select().from(ingestSourceDocuments).where(eq(ingestSourceDocuments.siteId, site)));
    const byId = new Map(docs.map((d) => [d.id, d]));
    expect(byId.get(first.documentId)).toMatchObject({ nearDuplicateCheck: 'unique' });
    expect(byId.get(second.documentId)).toMatchObject({ nearDuplicateCheck: 'duplicate', duplicateOf: first.documentId, duplicateScope: 'same_site' });
    const [entry] = await db.select().from(ingestDedupIndex).where(and(eq(ingestDedupIndex.siteId, site), eq(ingestDedupIndex.documentId, first.documentId)));
    expect(entry!.embeddingModel).toBe('embed-e1:64');

    // Site B has no embedding model: skipped, with the reason.
    const s2 = await source(fx.sites.b);
    const other = await register(fx.sites.b, s2, 'https://news.example.com/c', page('Harbour busy', 'The harbour authority in Example Town reported a busy season for ferries, fishing boats and visiting yachts this year.'));
    const [doc] = await runSiteTransaction(db, fx.sites.b, (tx) => tx.select().from(ingestSourceDocuments).where(eq(ingestSourceDocuments.id, other.documentId)));
    expect(doc).toMatchObject({ nearDuplicateCheck: 'skipped', nearDuplicateReason: 'no_embedding_provider' });
  });
});
