import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { autoPublishCandidates, items, llmAttempts, llmCalls, siteContentSettings, type Database } from '@heopress/database';
import { createRuntime, outboundFetch, parseTrustedEndpoints } from '@heopress/runtime/node';
import type { StorageObject, StorageProvider } from '@heopress/runtime';
import { AutonomyService } from '../services/autonomy-service';
import { operationIdFor, registerSourceDocument } from '../services/ingest/source-documents';
import { IngestSourceService } from '../services/ingest/source-service';
import { LlmGateway } from '../services/llm/gateway';
import { ModelCallGovernor } from '../services/llm/governance';
import { LlmProviderService } from '../services/llm/provider-service';
import { ContentPipeline } from '../services/pipeline/content-pipeline';
import { ContentSettingsService } from '../services/site-network/content-settings-service';
import { ensureContentSettings, upgradeSitePreset } from '../services/site-network/preset-installer';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { createCrossSiteFixture, type CrossSiteFixture } from './helpers/cross-site-fixture';

/**
 * HeoPress P09 task 6.1 — the nightly scenario, end to end against the real database: three English sources →
 * source documents (ingest registration) → translation into Chinese → SEO copy → quality gate → publish decision.
 * Only the trusted, licensed source's articles publish (L4); the others go to the review queue.
 *
 * The model is a local mock OpenAI-compatible service with fixed answers behind the real model gateway, so every call
 * goes through the ledger and is priced (1 USD / 1M input tokens, 2 USD / 1M output tokens). No key, no network.
 * The test prints one `P09_PIPELINE_BENCH` JSON line (time, calls, cost, counts) for docs/benchmarks/p09-pipeline.md.
 */

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

const KEK = Buffer.alloc(32, 9).toString('base64');
const DAY = 86_400_000;
const zh = (text: string) => (text.startsWith('<') ? text.replace(/>/, '>中文：') : `中文：${text}`);

/** A fixed answer for each kind of request the pipeline and the gate make (decided by the prompt, not by order). */
function answer(body: { messages?: Array<{ role: string; content: string }> }): { content: string; usage: { prompt_tokens: number; completion_tokens: number } } {
  const msgs = body.messages ?? [];
  const system = msgs.find((m) => m.role === 'system')?.content ?? '';
  const user = msgs.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
  const usage = { prompt_tokens: Math.ceil((system.length + user.length) / 4), completion_tokens: 0 };
  let content: string;
  if (system.includes('translate text segments')) {
    const payload = JSON.parse(user) as { segments: Array<{ id: string; text: string }> };
    content = JSON.stringify({ segments: payload.segments.map((s) => ({ id: s.id, text: zh(s.text) })) });
  } else if (system.includes('seoTitle')) {
    content = JSON.stringify({ seoTitle: '港口季度报告：渡轮与渔船', seoDescription: '示例镇港口本季度的渡轮与渔业数据，以及创纪录的客运量说明，来源为授权通讯社稿件。' });
  } else if (system.includes('"issues"')) {
    content = JSON.stringify({ issues: [] });
  } else if (system.includes('"verdict"')) {
    content = JSON.stringify({ verdict: 'PASS', reason: 'ok' });
  } else {
    content = '{}';
  }
  usage.completion_tokens = Math.ceil(content.length / 4);
  return { content, usage };
}

const STORIES = [
  'The harbour authority in Example Town reported a busy season for ferries and fishing boats, with record passenger numbers.',
  'A new cycle path along the Example River opened this week, linking three villages and the regional railway station.',
  'The Example Valley orchard cooperative expects an early apple harvest after a warm spring and a dry, sunny summer.',
  'Example City library extended its weekend opening hours and added a reading room for students during the exam period.',
  'Volunteers in Example Bay planted two thousand dune grasses to slow erosion before the autumn storm season begins.',
  'The Example Hills observatory will host open nights for families to watch the meteor shower through its large telescope.',
];

describe.skipIf(!hasDbIntegrationUrl)('P09 nightly scenario: 3 English sources → zh-CN → gate → publish or review', () => {
  let db: Database;
  let fx: CrossSiteFixture;
  let server: Server;
  let origin = '';
  let modelCalls = 0;

  beforeAll(async () => {
    db = await connectDbIntegration('p09-pipeline-scenario');
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        modelCalls++;
        const a = answer(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: a.content } }], usage: a.usage }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    fx = await createCrossSiteFixture(db, { prefix: 'p09n', jwtSecret: 'p09n-secret' });
  });
  afterAll(async () => {
    if (fx) await fx.teardown();
    if (server) await new Promise<void>((r) => server.close(() => r()));
  });

  it('only the trusted licensed source auto-publishes; every other article waits in the review queue', async () => {
    const siteId = fx.sites.a;
    const keys = createRuntime({ ...process.env, ENCRYPTION_KEY: KEK, HEOPRESS_ENV: 'development' }).keys;
    await upgradeSitePreset(db, siteId);
    await db.transaction((tx) => ensureContentSettings(tx as never, siteId));
    const [cs] = await db.select().from(siteContentSettings).where(eq(siteContentSettings.siteId, siteId));
    await new ContentSettingsService({ db, siteId, actor: { userId: null } }).update({
      availableLocales: ['en', 'zh-CN'],
      timezone: cs!.timezone,
      siteType: 'blog',
      trailingSlash: cs!.trailingSlash as 'always',
      localeStrategy: cs!.localeStrategy as 'subdirectory',
      localePrefixMode: cs!.localePrefixMode as 'default_at_root',
      localePrefixes: cs!.localePrefixes,
      permalinks: cs!.permalinks,
      allowCrossSiteTranslations: true,
      sponsorDisclosure: true,
      sponsorRel: true,
      version: cs!.version,
    } as never);

    // The model provider: the mock, priced, with a monthly budget.
    const providers = new LlmProviderService({ db, siteId, keys, instanceCurrency: 'USD' });
    const p = await providers.create({
      kind: 'openai_compatible',
      name: 'Mock',
      baseUrl: `${origin}/v1`,
      model: 'mock-translate-1',
      apiKey: 'sk-mock-not-a-secret',
      capabilities: { tools: true, json: true, maxContext: null },
      pricing: { kind: 'per_1m_tokens', inputMicros: 1_000_000, outputMicros: 2_000_000 },
      currency: 'USD',
      timeoutMs: 5000,
    });
    for (const t of ['chat', 'generation', 'translation', 'constitution'] as const) await providers.setRoute(t, [p.id]).catch(() => undefined);
    await providers.updateSettings({ currency: 'USD', monthlyBudgetMicros: 5_000_000, budgetTimezone: 'UTC' });
    const gateway = new LlmGateway({
      db,
      keys,
      env: {},
      fetch: (url: string, init: RequestInit) => outboundFetch(url, { ...init, purpose: 'service', trusted: parseTrustedEndpoints(origin) }),
      governor: new ModelCallGovernor({ ratePerMinute: 0, breakerFailures: 1000, breakerCooldownMs: 60_000 }),
    });
    const pipeline = new ContentPipeline({ db, siteId, gateway, urlChecker: async () => ({ ok: true, status: 200 }) });
    await new AutonomyService({ db, siteId }).setGrant('content-pipeline', 'publish', 4);

    // Three English sources, all licensed for derivatives; only the first is trusted.
    const admin = { isAdmin: true, userId: null };
    const svc = new IngestSourceService({ db, siteId, actor: admin });
    const terms = { licenceStatus: 'licensed', usageMode: 'licensed_derivative', commercialUse: true, reviewDueAt: new Date(Date.now() + 300 * DAY).toISOString() };
    const sourceDefs = [
      { name: 'TrustedWire', trustLevel: 'high' },
      { name: 'RegionalDaily', trustLevel: 'medium' },
      { name: 'CommunityBlog', trustLevel: 'low' },
    ];
    const storage = new MemoryStorage();
    const docs: Array<{ source: string; doc: string }> = [];
    const started = performance.now();
    for (const [i, def] of sourceDefs.entries()) {
      const s = await svc.create({ name: def.name, type: 'url', url: `https://${def.name.toLowerCase()}.example.com/`, scheduleTimes: ['02:00'], timezone: 'UTC' });
      await svc.reviseLicence(s.id, { evidence: `Agreement EX-${i + 1}`, trustLevel: def.trustLevel, ...terms });
      for (let j = 0; j < 2; j++) {
        const story = STORIES[i * 2 + j]!;
        const body = `<p>${story}</p><p>Details: run <code>apt install example-${i}${j}</code> and read the notice ${i}-${j}.</p>`;
        const url = `https://${def.name.toLowerCase()}.example.com/news/${j}`;
        const reg = await registerSourceDocument(
          { db, storage },
          {
            siteId,
            sourceId: s.id,
            run: null,
            operationId: operationIdFor(s.id, 'manual', url),
            url,
            page: { url, finalUrl: url, status: 200, contentType: 'text/html', headers: new Headers(), body: Buffer.from(`<html><body>${body}</body></html>`), durationMs: 2 },
            extracted: {
              title: story.split(',')[0]!.slice(0, 60),
              author: null,
              publishedAt: new Date(Date.now() - DAY),
              language: 'en',
              canonicalCandidate: null,
              bodyHtml: body,
              bodyText: body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
              contentHash: createHash('sha256').update(body).digest('hex'),
              hiddenContent: [],
              linkDensity: 0,
              ruleVersion: 'nightly@1',
            },
            startedAt: new Date(),
          },
        );
        docs.push({ source: def.name, doc: reg.documentId });
      }
    }
    const ingested = performance.now();

    const results: Array<{ source: string; itemId: string; gate: string; decision: string }> = [];
    for (const d of docs) {
      const res = await pipeline.produce({ mode: 'translate', sourceDocumentIds: [d.doc], targetLocale: 'zh-CN' });
      expect(res.status, res.reason ?? '').toBe('drafted');
      await pipeline.seoCopy(res.productionId);
      const gate = await pipeline.runGate(res.productionId);
      const proposal = await pipeline.proposePublish(res.productionId);
      results.push({ source: d.source, itemId: res.itemId!, gate: gate.status, decision: proposal.decision });
    }
    const finished = performance.now();

    const itemIds = results.map((r) => r.itemId);
    const rows = await db.select({ id: items.id, status: items.status, data: items.data }).from(items).where(and(eq(items.siteId, siteId), inArray(items.id, itemIds)));
    const statusOf = new Map(rows.map((r) => [r.id, r.status]));
    for (const r of rows) expect((r.data as { locale?: string }).locale).toBe('zh-CN');
    expect(results.every((r) => r.gate === 'passed'), JSON.stringify(results)).toBe(true);
    const published = results.filter((r) => statusOf.get(r.itemId) === 'published');
    const queued = await db.select().from(autoPublishCandidates).where(and(eq(autoPublishCandidates.siteId, siteId), eq(autoPublishCandidates.status, 'review')));
    expect(published.map((r) => r.source)).toEqual(['TrustedWire', 'TrustedWire']);
    expect(queued.map((c) => c.itemId).sort()).toEqual(results.filter((r) => r.source !== 'TrustedWire').map((r) => r.itemId).sort());
    for (const c of queued) expect((c.detail as { failures: Array<{ reason: string }> }).failures.map((f) => f.reason)).toContain('source_not_trusted');

    const attempts = await db.select().from(llmAttempts).where(eq(llmAttempts.siteId, siteId));
    expect(attempts.every((a) => a.billing === 'settled')).toBe(true);
    const costMicros = attempts.reduce((n, a) => n + Number(a.actualMicros ?? 0), 0);
    const capOf = new Map((await db.select({ id: llmCalls.id, capability: llmCalls.capability }).from(llmCalls).where(eq(llmCalls.siteId, siteId))).map((c) => [c.id, c.capability ?? 'other']));
    const byCapability: Record<string, number> = {};
    for (const a of attempts) {
      const k = capOf.get(a.callId) ?? 'other';
      byCapability[k] = (byCapability[k] ?? 0) + 1;
    }
    console.log(
      `P09_PIPELINE_BENCH ${JSON.stringify({
        sources: 3,
        documents: docs.length,
        published: published.length,
        review: queued.length,
        ingestMs: Math.round(ingested - started),
        pipelineMs: Math.round(finished - ingested),
        totalMs: Math.round(finished - started),
        modelRequests: modelCalls,
        ledgerAttempts: attempts.length,
        byCapability,
        inputTokens: attempts.reduce((n, a) => n + (a.inputTokens ?? 0), 0),
        outputTokens: attempts.reduce((n, a) => n + (a.outputTokens ?? 0), 0),
        costUsd: costMicros / 1_000_000,
      })}`,
    );
  });
});
