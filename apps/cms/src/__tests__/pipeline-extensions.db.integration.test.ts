import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { auditLog, extensions, ingestDiscoveredUrls, ingestSourceRuns, ingestSources, llmAttempts, llmCalls, type Database } from '@heopress/database';
import type { JobOptions, QueueProvider, StorageObject, StorageProvider } from '@heopress/runtime';
import { createRuntime, outboundFetch, parseTrustedEndpoints } from '@heopress/runtime/node';
import app from '../index';
import { setRuntimeFactory } from '../middleware/runtime';
import { CapabilityError, ExtensionSandbox } from '../extensions/sandbox';
import { PipelinePluginHost } from '../extensions/pipeline/host';
import { IngestSourceService } from '../services/ingest/source-service';
import { processSourceJob, setSourceRunner } from '../services/ingest/source-worker';
import { createIngestRunner, type IngestRunnerDeps } from '../services/ingest/url-runner';
import { RobotsCache } from '../services/ingest/robots';
import { LlmGateway, LlmGatewayError } from '../services/llm/gateway';
import { ModelCallGovernor } from '../services/llm/governance';
import { LlmProviderService } from '../services/llm/provider-service';
import { runSiteTransaction } from '../services/rls-transaction';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { createCrossSiteFixture, type CrossSiteFixture } from './helpers/cross-site-fixture';

/**
 * Pipeline extensions of plugins against the real database (HeoPress P12 tasks 4.1 and 4.4; spec
 * extensions/pipeline-extensions "插件信源适配器", "插件 AI 调用计费"). Plugins are inline bundles loaded through the
 * capability sandbox, the way the pipeline host loads them (development mode: unsigned bundles accepted). The model
 * service is a local mock; no request leaves the machine.
 *
 *   4.1  a plugin source type is offered to the site's editors; a source of it starts with the default terms (licence
 *        `unknown`, usage `discovery_only`); its address must be one of the plugin's declared hosts; the adapter's links
 *        are recorded and de-duplicated by the core and become ordinary fetch jobs; an adapter reaching a host it did not
 *        declare fails the run as `blocked`, and the refusal is recorded.
 *   4.4  a plugin's model call goes through the gateway: one ledger call with the `plugin` capability and the plugin as
 *        its origin, billed against the site budget; over the budget it is refused before anything is sent; the
 *        instance's shared key is never used for it; without `ai:generate` the sandbox refuses.
 */

const KEK = Buffer.alloc(32, 9).toString('base64');
const JOBS = 'jobs.example.com';

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

/** A job-board plugin: one adapter lists links, one reaches a host it never declared, one is registered but not declared. */
const JOBS_PLUGIN = `
export default (ctx) => {
  ctx.extensionPoints.register('source-adapters', {
    id: 'board',
    async discover(c) {
      const base = c.url.replace(/\\/+$/, '');
      return [
        base + '/jobs/1?utm_source=board',
        { url: base + '/jobs/1#apply', title: 'Again' },
        { url: base + '/jobs/2', title: 'Two', publishedAt: '2026-10-01T00:00:00Z' },
        42,
        { nope: true },
      ];
    },
  });
  ctx.extensionPoints.register('source-adapters', {
    id: 'sneaky',
    async discover() {
      await ctx.fetch('https://other.example.com/list.json');
      return [];
    },
  });
  ctx.extensionPoints.register('source-adapters', { id: 'hidden', discover: () => ['https://${JOBS}/hidden'] });
};
`;

/** A plugin that asks the site's model (through the sandbox) and returns what it got. */
const AI_PLUGIN = `
export default (ctx) => {
  ctx.extensionPoints.register('source-adapters', {
    id: 'ask',
    async discover(c) {
      const r = await ctx.ai.generate({ messages: [{ role: 'user', content: 'Links on ' + c.url }], key: c.source.id, maxOutputTokens: 100000 });
      return { answer: r, keys: Object.keys(r).sort() };
    },
  });
};
`;

const inline = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;

// The mock model service.
const hits: Array<{ authorization: string | undefined; body: Record<string, unknown> }> = [];
let server: Server;
let origin = '';

describe.skipIf(!hasDbIntegrationUrl)('pipeline extensions — DB integration (P12 tasks 4.1, 4.4)', () => {
  let db: Database;
  let fx: CrossSiteFixture;
  let site = '';
  let keys: ReturnType<typeof createRuntime>['keys'];
  const env = { HEOPRESS_ENV: 'development' } as Record<string, unknown>;

  beforeAll(async () => {
    db = await connectDbIntegration('pipeline-extensions');
    keys = createRuntime({ ...process.env, ENCRYPTION_KEY: KEK, HEOPRESS_ENV: 'development' }).keys;
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        hits.push({ authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown> });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: `https://${JOBS}/jobs/9` } }], usage: { prompt_tokens: 30, completion_tokens: 8 } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  beforeEach(async () => {
    fx = await createCrossSiteFixture(db, { prefix: 'pext', jwtSecret: 'pext-secret' });
    site = fx.sites.a;
    hits.length = 0;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    setSourceRunner(null);
    setRuntimeFactory(null);
    await db.delete(extensions).where(eq(extensions.siteId, site));
    if (fx) await fx.teardown();
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  async function install(name: string, source: string, capabilities: string[], manifest: Record<string, unknown>, extra: Partial<typeof extensions.$inferInsert> = {}) {
    const [row] = await db
      .insert(extensions)
      .values({ siteId: site, name, version: '1.0.0', type: 'hook', bundleUrl: inline(source), enabled: true, capabilities, requestedCapabilities: capabilities, manifest: { name, version: '1.0.0', ...manifest }, ...extra })
      .returning();
    return row!;
  }

  /** The pipeline host with the sandbox the tests use (inline bundles are trusted here). */
  const host = (gateway?: LlmGateway) =>
    new PipelinePluginHost({
      db,
      env,
      gateway: gateway ?? null,
      sandboxFor: (_siteId, deps) => {
        const sandbox = new ExtensionSandbox(env as never, deps);
        vi.spyOn(sandbox as unknown as { isTrustedBundleUrl(url: string): boolean }, 'isTrustedBundleUrl').mockReturnValue(true);
        return sandbox;
      },
    });

  const sources = () => new IngestSourceService({ db, siteId: site, actor: { isAdmin: true, userId: null } });
  const inSite = <T,>(fn: Parameters<typeof runSiteTransaction<T>>[2]) => runSiteTransaction(db, site, fn);
  const refusal = (p: Promise<unknown>) => p.then(() => 'resolved', (e: unknown) => (e as { code?: string }).code ?? String(e));

  // ── 4.1 source adapters ─────────────────────────────────────────────

  describe('source adapters (4.1)', () => {
    const jobsManifest = { sourceAdapters: [{ id: 'board', label: 'Job board' }, { id: 'sneaky', label: 'Sneaky list' }] };
    const jobsCaps = ['ext:source-adapters', `http:fetch:${JOBS}`];

    const deps = (queue: FakeQueue): IngestRunnerDeps => ({
      db,
      storage: new MemoryStorage(),
      limiter: null,
      queue,
      fetch: { robots: new RobotsCache() },
      sourceAdapters: (siteId, ref) => host().sourceAdapter(siteId, ref),
    });
    async function run(sourceId: string, slot: string) {
      const queue = new FakeQueue();
      setSourceRunner(createIngestRunner(deps(queue)));
      const outcome = await processSourceJob({ db }, { siteId: site, sourceId, scheduledFor: slot });
      const [last] = await inSite((tx) => tx.select().from(ingestSourceRuns).where(eq(ingestSourceRuns.sourceId, sourceId)).orderBy(ingestSourceRuns.startedAt)).then((r) => r.slice(-1));
      return { outcome, queue, run: last! };
    }

    it('a plugin source type is offered; its sources start with the default terms; the address must be a declared host', async () => {
      await install('acme-jobs', JOBS_PLUGIN, jobsCaps, jobsManifest);
      expect(await sources().adapters()).toEqual([
        expect.objectContaining({ ref: 'acme-jobs#board', plugin: 'acme-jobs', label: 'Job board', hosts: [JOBS] }),
        expect.objectContaining({ ref: 'acme-jobs#sneaky', hosts: [JOBS] }),
      ]);

      // The same list over the API, for the Sources page.
      const httpEnv = { ...process.env, JWT_SECRET: 'pext-secret', HEOPRESS_ENV: 'development' };
      const runtime = createRuntime(httpEnv);
      setRuntimeFactory(() => ({ ...runtime, storage: new MemoryStorage() }));
      const res = await app.request('/api/v1/ingest/sources/adapters', { headers: fx.headers('a', await fx.session('adminA', 'a')) }, httpEnv);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { data: Array<{ ref: string }> }).data.map((a) => a.ref)).toEqual(['acme-jobs#board', 'acme-jobs#sneaky']);

      const created = await sources().create({ name: 'Board', type: 'plugin', adapter: 'acme-jobs#board', url: `https://${JOBS}/board`, scheduleTimes: ['08:00'], timezone: 'UTC' } as never);
      expect(created).toMatchObject({ type: 'plugin', adapter: 'acme-jobs#board', licenceStatus: 'unknown', usageMode: 'discovery_only' });

      // A host the plugin did not declare, an adapter nobody offers, a plugin source without an adapter: refused.
      expect(await refusal(sources().create({ name: 'Elsewhere', type: 'plugin', adapter: 'acme-jobs#board', url: 'https://other.example.com/board', scheduleTimes: ['08:00'], timezone: 'UTC' } as never))).toBe('HOST_NOT_DECLARED');
      expect(await refusal(sources().create({ name: 'Ghost', type: 'plugin', adapter: 'acme-jobs#hidden', url: `https://${JOBS}/x`, scheduleTimes: ['08:00'], timezone: 'UTC' } as never))).toBe('UNKNOWN_ADAPTER');
      expect(await refusal(sources().create({ name: 'None', type: 'plugin', url: `https://${JOBS}/x`, scheduleTimes: ['08:00'], timezone: 'UTC' } as never))).toBe('VALIDATION');
      expect(await refusal(sources().update(created.id, { url: 'https://other.example.com/board' } as never))).toBe('HOST_NOT_DECLARED');

      // Disabled, or waiting for a permission re-confirmation: the type is no longer offered.
      await db.update(extensions).set({ permissionsStatus: 'pending' }).where(and(eq(extensions.siteId, site), eq(extensions.name, 'acme-jobs')));
      expect(await sources().adapters()).toEqual([]);
    });

    it('the adapter only discovers: its links are normalised, de-duplicated and become ordinary fetch jobs', async () => {
      await install('acme-jobs', JOBS_PLUGIN, jobsCaps, jobsManifest);
      const { id } = await sources().create({ name: 'Board', type: 'plugin', adapter: 'acme-jobs#board', url: `https://${JOBS}/board`, scheduleTimes: ['08:00'], timezone: 'UTC' } as never);
      const first = await run(id, '2026-10-26T08:00:00.000Z');
      expect(first.outcome).toBe('succeeded');
      expect(first.run).toMatchObject({ outcome: 'succeeded', itemsDiscovered: 3, itemsNew: 2, itemsDuplicate: 1 });
      expect(first.queue.jobs.map((j) => j.queue)).toEqual(['ingest-fetch', 'ingest-fetch']);
      const urls = await inSite((tx) => tx.select().from(ingestDiscoveredUrls).where(eq(ingestDiscoveredUrls.siteId, site)));
      expect(urls.map((u) => u.normalizedUrl).sort()).toEqual([`https://${JOBS}/board/jobs/1`, `https://${JOBS}/board/jobs/2`]);

      // The next slot: the same links are already known; nothing is fetched again.
      const second = await run(id, '2026-10-27T08:00:00.000Z');
      expect(second.run).toMatchObject({ outcome: 'succeeded', itemsNew: 0, itemsDuplicate: 3 });
      expect(second.queue.jobs).toEqual([]);
    });

    it('an adapter reaching a host it did not declare fails the run as blocked; the refusal is recorded', async () => {
      await install('acme-jobs', JOBS_PLUGIN, jobsCaps, jobsManifest);
      const { id } = await sources().create({ name: 'Sneaky', type: 'plugin', adapter: 'acme-jobs#sneaky', url: `https://${JOBS}/list`, scheduleTimes: ['08:00'], timezone: 'UTC' } as never);
      const { run: r, queue } = await run(id, '2026-10-26T08:00:00.000Z');
      expect(r).toMatchObject({ outcome: 'failed', failureCategory: 'blocked' });
      expect(queue.jobs).toEqual([]);
      const [source] = await inSite((tx) => tx.select().from(ingestSources).where(eq(ingestSources.id, id)));
      expect(source!.lastFailureCategory).toBe('blocked');
      await vi.waitFor(async () => {
        const denied = await db.select().from(auditLog).where(and(eq(auditLog.siteId, site), eq(auditLog.event, 'extension_capability_denied')));
        expect(denied.map((d) => d.metadata)).toEqual([expect.objectContaining({ extensionName: 'acme-jobs', capability: 'http:fetch:other.example.com', operation: 'fetch' })]);
      });
    });

    it('an adapter that is declared but no longer offered (plugin disabled) fails the run without running plugin code', async () => {
      await install('acme-jobs', JOBS_PLUGIN, jobsCaps, jobsManifest);
      const { id } = await sources().create({ name: 'Board', type: 'plugin', adapter: 'acme-jobs#board', url: `https://${JOBS}/board`, scheduleTimes: ['08:00'], timezone: 'UTC' } as never);
      await db.update(extensions).set({ enabled: false }).where(and(eq(extensions.siteId, site), eq(extensions.name, 'acme-jobs')));
      const { run: r, queue } = await run(id, '2026-10-26T08:00:00.000Z');
      expect(r).toMatchObject({ outcome: 'failed' });
      expect(r.message).toContain('acme-jobs#board');
      expect(queue.jobs).toEqual([]);
    });
  });

  // ── 4.4 model calls ─────────────────────────────────────────────────

  describe('model calls (4.4)', () => {
    const aiManifest = { sourceAdapters: [{ id: 'ask', label: 'Ask the model' }] };
    const trustedFetch = (url: string, init: RequestInit) => outboundFetch(url, { ...init, purpose: 'service', trusted: parseTrustedEndpoints(origin) });
    const governor = () => new ModelCallGovernor({ ratePerMinute: 0, breakerFailures: 1000, breakerCooldownMs: 60_000 });
    const gateway = (gatewayEnv: Record<string, string> = {}) => new LlmGateway({ db, keys, env: gatewayEnv, fetch: trustedFetch, governor: governor() });

    async function siteModel(budget: number | null) {
      const svc = new LlmProviderService({ db, siteId: site, keys, instanceCurrency: 'USD' });
      const p = await svc.create({
        kind: 'openai_compatible',
        name: 'Site model',
        baseUrl: `${origin}/a`,
        model: 'model-a',
        apiKey: 'sk-site',
        capabilities: { tools: true, json: true, maxContext: null },
        pricing: { kind: 'per_1m_tokens', inputMicros: 1_000_000, outputMicros: 2_000_000 },
        currency: 'USD',
        timeoutMs: 2000,
      });
      await svc.setRoute('generation', [p.id]);
      await svc.updateSettings({ currency: 'USD', monthlyBudgetMicros: budget, budgetTimezone: 'UTC', dailyBudgetMicros: null, dailyProcessingLimit: null });
    }
    const ask = async (h: PipelinePluginHost, name = 'acme-ai') => {
      const adapter = await h.sourceAdapter(site, `${name}#ask`);
      expect(adapter).not.toBeNull();
      return adapter!.discover({ url: `https://${JOBS}/board`, maxItems: 5, signal: new AbortController().signal, source: { id: 'src1', name: 'Board' } });
    };
    const ledger = () => db.select().from(llmCalls).where(eq(llmCalls.siteId, site));

    it('a plugin model call is one ledger call with the plugin capability and origin, billed; the plugin gets text, never a key', async () => {
      await siteModel(1_000_000);
      await install('acme-ai', AI_PLUGIN, ['ext:source-adapters', 'ai:generate', `http:fetch:${JOBS}`], aiManifest);
      const out = (await ask(host(gateway()))) as { answer: { content: string; callId: string; usage: unknown }; keys: string[] };
      expect(out.keys).toEqual(['callId', 'content', 'usage']);
      expect(out.answer.content).toBe(`https://${JOBS}/jobs/9`);
      expect(hits).toHaveLength(1);
      // The site's own provider, without tools, the output capped.
      expect(hits[0]!.authorization).toBe('Bearer sk-site');
      expect(hits[0]!.body.tools).toBeUndefined();
      expect(hits[0]!.body.max_tokens).toBe(4000);

      const [call] = await ledger();
      expect(call).toMatchObject({ id: out.answer.callId, capability: 'plugin', originKind: 'extension', originId: 'acme-ai', status: 'completed' });
      const [attempt] = await db.select().from(llmAttempts).where(eq(llmAttempts.callId, call!.id));
      expect(attempt).toMatchObject({ billing: 'settled', outcome: 'succeeded' });
      expect(attempt!.actualMicros).toBeGreaterThan(0);

      // The same key replays the recorded answer: billed once.
      await ask(host(gateway()));
      expect(hits).toHaveLength(1);
      expect(await ledger()).toHaveLength(1);
    });

    it('over the site budget the call is refused before anything is sent', async () => {
      await siteModel(0);
      await install('acme-ai', AI_PLUGIN, ['ext:source-adapters', 'ai:generate', `http:fetch:${JOBS}`], aiManifest);
      const err = await ask(host(gateway())).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(LlmGatewayError);
      expect((err as LlmGatewayError).code).toBe('BUDGET_EXCEEDED');
      expect(hits).toEqual([]);
      expect(await db.select().from(llmAttempts).where(eq(llmAttempts.siteId, site))).toEqual([]);
    });

    it("never the instance's shared key: without a site model the plugin's call is not configured", async () => {
      await install('acme-ai', AI_PLUGIN, ['ext:source-adapters', 'ai:generate', `http:fetch:${JOBS}`], aiManifest);
      // An instance default with a key and a price: core features could use it; a plugin may not.
      const shared = gateway({ LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-shared', LLM_PRICE_INPUT_PER_1M: '1', LLM_PRICE_OUTPUT_PER_1M: '2' });
      expect(await refusal(ask(host(shared)))).toBe('LLM_NOT_CONFIGURED');
      expect(hits).toEqual([]);
      expect(await ledger()).toEqual([]);
    });

    it('without the ai:generate capability the sandbox refuses the call', async () => {
      await siteModel(1_000_000);
      await install('acme-noai', AI_PLUGIN, ['ext:source-adapters', `http:fetch:${JOBS}`], aiManifest);
      const err = await ask(host(gateway()), 'acme-noai').then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(CapabilityError);
      expect((err as Error).message).toContain('ai:generate');
      expect(hits).toEqual([]);
      expect(await ledger()).toEqual([]);
    });
  });
});
