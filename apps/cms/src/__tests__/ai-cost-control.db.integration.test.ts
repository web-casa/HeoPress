import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { agentFreezes, aiPipelinePauses, llmAttempts, llmCalls, notifications, type Database } from '@heopress/database';
import type { AiCapability } from '@heopress/contracts/schemas';
import { createRuntime, outboundFetch, parseTrustedEndpoints } from '@heopress/runtime/node';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { createCrossSiteFixture, type CrossSiteFixture } from './helpers/cross-site-fixture';
import { LlmGateway, LlmGatewayError } from '../services/llm/gateway';
import { LlmProviderService } from '../services/llm/provider-service';
import { LlmDeferredError, ModelCallGovernor, serviceKey } from '../services/llm/governance';
import { PipelineControlService, PipelinePausedError, assertPipelineRunnable, pipelineState } from '../services/llm/pipeline-control';
import { claimDailyProcessing } from '../services/llm/daily';
import { LlmTranslationService } from '../services/llm/translation-service';
import { gatewayEmbedder } from '../services/ingest/near-duplicate';
import { runSiteTransaction } from '../services/rls-transaction';

/**
 * Cost control and model-call governance (HeoPress P09 tasks 1.11, 4.2, 4.4–4.7; spec ai/cost-control), against a
 * mock OpenAI-compatible service with fixed answers and the real database.
 */

const KEK = Buffer.alloc(32, 7).toString('base64');

interface Reply {
  status: number;
  body: unknown;
}
/** What each mock provider (path /a, /b) answers next. */
const replies: Record<string, () => Reply> = {};
const hits: string[] = [];
let server: Server;
let origin = '';

const CHAT_OK = (): Reply => ({
  status: 200,
  body: { choices: [{ message: { content: JSON.stringify({ segments: [{ id: 's1', text: '你好' }] }) } }], usage: { prompt_tokens: 40, completion_tokens: 10 } },
});
const EMBED_OK = (): Reply => ({ status: 200, body: { data: [{ embedding: [0.1, 0.2, 0.3] }], usage: { prompt_tokens: 12 } } });
const STATUS = (status: number) => (): Reply => ({ status, body: { error: { message: 'mock' } } });

describe.skipIf(!hasDbIntegrationUrl)('AI cost control — DB integration', () => {
  let db: Database;
  let fx: CrossSiteFixture;
  let keys: ReturnType<typeof createRuntime>['keys'];
  let site = '';

  beforeAll(async () => {
    db = await connectDbIntegration('ai-cost-control');
    keys = createRuntime({ ...process.env, ENCRYPTION_KEY: KEK, HEOPRESS_ENV: 'development' }).keys;
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      req.resume();
      req.on('end', () => {
        const [, provider = '', ...rest] = (req.url ?? '').split('/');
        const kind = rest.join('/') === 'embeddings' ? 'embed' : 'chat';
        hits.push(`${provider}:${kind}`);
        const fallback = kind === 'embed' ? EMBED_OK : CHAT_OK;
        const r = (replies[`${provider}:${kind}`] ?? replies[provider] ?? fallback)();
        res.writeHead(r.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(r.body));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  beforeEach(async () => {
    fx = await createCrossSiteFixture(db, { prefix: 'cost', jwtSecret: 'cost-secret' });
    site = fx.sites.a;
    hits.length = 0;
    for (const k of Object.keys(replies)) delete replies[k];
  });
  afterAll(async () => {
    if (fx) await fx.teardown();
    await new Promise<void>((r) => server.close(() => r()));
  });

  const trustedFetch = (url: string, init: RequestInit) => outboundFetch(url, { ...init, purpose: 'service', trusted: parseTrustedEndpoints(origin) });
  const unlimited = () => new ModelCallGovernor({ ratePerMinute: 0, breakerFailures: 1000, breakerCooldownMs: 60_000 });
  const gateway = (extra: Partial<ConstructorParameters<typeof LlmGateway>[0]> = {}) =>
    new LlmGateway({ db, keys, env: {}, fetch: trustedFetch, governor: unlimited(), ...extra });
  const providers = () => new LlmProviderService({ db, siteId: site, keys, instanceCurrency: 'USD' });

  /** Providers a (primary) and b (backup) on the mock; every task type routes to [a, b] (embedding: [a]). */
  const setup = async (settings: { budget?: number | null; daily?: number | null; dailyProcessing?: number | null } = {}) => {
    const svc = providers();
    const mk = (path: string) =>
      svc.create({
        kind: 'openai_compatible',
        name: `P-${path}`,
        baseUrl: `${origin}/${path}`,
        model: `model-${path}`,
        apiKey: `sk-${path}`,
        capabilities: { tools: true, json: true, maxContext: null },
        pricing: { kind: 'per_1m_tokens', inputMicros: 1_000_000, outputMicros: 2_000_000 },
        currency: 'USD',
        timeoutMs: 2000,
      });
    const a = await mk('a');
    const b = await mk('b');
    for (const t of ['chat', 'generation', 'translation'] as const) await svc.setRoute(t, [a.id, b.id]);
    await svc.setRoute('embedding', [a.id]);
    await svc.updateSettings({
      currency: 'USD',
      monthlyBudgetMicros: settings.budget ?? null,
      budgetTimezone: 'UTC',
      dailyBudgetMicros: settings.daily ?? null,
      dailyProcessingLimit: settings.dailyProcessing ?? null,
    });
    return { a, b };
  };
  const attempts = () => db.select().from(llmAttempts).where(eq(llmAttempts.siteId, site)).orderBy(llmAttempts.createdAt, llmAttempts.seq);
  const calls = () => db.select().from(llmCalls).where(eq(llmCalls.siteId, site));
  const codeOf = (p: Promise<unknown>) => p.then(() => 'resolved', (e: unknown) => (e instanceof LlmGatewayError ? e.code : String(e)));
  const activePauses = () => db.select().from(aiPipelinePauses).where(and(eq(aiPipelinePauses.siteId, site), isNull(aiPipelinePauses.liftedAt)));

  /** One call of a capability, the way its feature makes it. */
  const invoke = (g: LlmGateway, capability: AiCapability, opts: { callKey?: string; signal?: AbortSignal } = {}): Promise<unknown> => {
    if (capability === 'ingest_embedding') {
      return g.embed({ siteId: site, origin: { kind: 'ingest_near_duplicate' }, capability, text: 'A source document body.', ...opts });
    }
    if (capability === 'translate' || capability === 'workbench_trial') {
      return new LlmTranslationService(g).translate({
        siteId: site,
        capability,
        sourceLocale: 'en',
        targetLocale: 'zh-CN',
        segments: [{ id: 's1', text: 'Hello' }],
        ...opts,
      });
    }
    return g.chat({
      siteId: site,
      taskType: 'generation',
      capability,
      origin: { kind: capability },
      systemPrompt: `You do ${capability}.`,
      messages: [{ role: 'user', content: `${capability} this source document` }],
      tools: false,
      maxOutputTokens: 200,
      ...opts,
    });
  };

  // ── 4.7: the coverage matrix ─────────────────────────────────────────

  const MATRIX: AiCapability[] = ['ingest_embedding', 'translate', 'rewrite', 'write', 'seo_copy', 'value_assessment', 'workbench_trial', 'flow', 'fact_check'];

  describe.each(MATRIX)('capability %s goes through the ledger and the site budget', (capability) => {
    const kind = capability === 'ingest_embedding' ? 'embed' : 'chat';

    it('allow + settle: one ledger call with the capability, settled with its tokens and cost', async () => {
      await setup({ budget: 1_000_000 });
      await invoke(gateway(), capability);
      const [call] = await calls();
      expect(call).toMatchObject({ capability, status: 'completed' });
      const [att] = await attempts();
      expect(att).toMatchObject({ billing: 'settled', outcome: 'succeeded' });
      expect(att!.inputTokens).toBeGreaterThan(0);
      expect(att!.actualMicros).toBeGreaterThan(0);
    });

    it('reserve: the attempt holds a reservation while in flight', async () => {
      await setup({ budget: 1_000_000 });
      let seen: { billing: string; reservedMicros: number } | undefined;
      await invoke(gateway({ hooks: { afterReserve: async (a) => void (seen = { billing: a.billing, reservedMicros: a.reservedMicros }) } }), capability);
      expect(seen?.billing).toBe('reserved');
      expect(seen!.reservedMicros).toBeGreaterThan(0);
    });

    it('deny: over the budget nothing is sent, the call fails BUDGET_EXCEEDED and the pipeline pauses', async () => {
      await setup({ budget: 0 });
      expect(await codeOf(invoke(gateway(), capability))).toBe('BUDGET_EXCEEDED');
      expect(hits).toEqual([]);
      expect(await attempts()).toEqual([]);
      expect((await activePauses()).map((p) => p.reason)).toEqual(['budget']);
    });

    it('fail: a final error keeps the liability on record and fails the call', async () => {
      await setup({ budget: 1_000_000 });
      replies[`a:${kind}`] = STATUS(400);
      replies[`b:${kind}`] = STATUS(400);
      expect(await codeOf(invoke(gateway(), capability))).not.toBe('resolved');
      const [call] = await calls();
      expect(call!.status).toBe('failed');
      const atts = await attempts();
      expect(atts.length).toBeGreaterThan(0);
      // Sent without a usage report: an unknown liability, never silently released.
      expect(atts.every((a) => a.billing === 'unknown')).toBe(true);
    });

    it('cancel: cancelled before sending, the reservation is released at no cost', async () => {
      await setup({ budget: 1_000_000 });
      const ctl = new AbortController();
      expect(await codeOf(invoke(gateway({ hooks: { afterReserve: async () => ctl.abort() } }), capability, { signal: ctl.signal }))).toBe('CANCELLED');
      const [att] = await attempts();
      expect(att).toMatchObject({ billing: 'cancelled', actualMicros: 0 });
      expect(hits).toEqual([]);
    });

    it('replay: the same execution key returns the recorded answer, never settles twice', async () => {
      await setup({ budget: 1_000_000 });
      const key = `run:matrix:${capability}:1`;
      const first = await invoke(gateway(), capability, { callKey: key });
      const second = await invoke(gateway(), capability, { callKey: key });
      expect(second).toEqual(first);
      expect(hits).toHaveLength(1);
      const atts = await attempts();
      expect(atts).toHaveLength(1);
      expect(atts[0]!.billing).toBe('settled');
    });
  });

  // ── 4.2 / 4.4: the monthly budget ────────────────────────────────────

  it('budget used up: the pipeline pauses and administrators are notified once', async () => {
    await setup({ budget: 0 });
    const g = gateway();
    await codeOf(invoke(g, 'rewrite'));
    await codeOf(invoke(g, 'rewrite'));
    const notes = await db.select().from(notifications).where(and(eq(notifications.siteId, site), eq(notifications.collection, 'ai_pipeline')));
    expect(notes.map((n) => n.recipient)).toEqual([fx.users.adminA.id]);
    await expect(runSiteTransaction(db, site, (tx) => assertPipelineRunnable(tx, site))).rejects.toBeInstanceOf(PipelinePausedError);
  });

  it('two tasks race for a remainder that pays for one call: only one gets it', async () => {
    await setup({ budget: 1_000_000 });
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let reserved = 0;
    let reservedSeen!: () => void;
    const seen = new Promise<void>((r) => (reservedSeen = r));
    const first = invoke(gateway({ hooks: { afterReserve: async (a) => { reserved = a.reservedMicros; reservedSeen(); await held; } } }), 'write');
    await seen;
    // The remainder now pays for half of one more reservation: the second task must not get it.
    await providers().updateSettings({ currency: 'USD', monthlyBudgetMicros: Math.floor(reserved * 1.5), budgetTimezone: 'UTC' });
    const second = await codeOf(invoke(gateway(), 'write'));
    release();
    await first;
    expect(second).toBe('BUDGET_EXCEEDED');
    const atts = await attempts();
    expect(atts).toHaveLength(1);
    expect(atts[0]!.billing).toBe('settled');
  });

  it('a new month lifts only the budget pause; a manual pause and the kill switch stay', async () => {
    await setup({ budget: 0 });
    await codeOf(invoke(gateway(), 'rewrite'));
    await new PipelineControlService({ db, siteId: site, userId: fx.users.adminA.id }).pause('manual', 'editor review');
    await db.insert(agentFreezes).values({ siteId: site, scope: 'site', reason: 'test', frozenBy: fx.users.adminA.id });
    const now = new Date();
    const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 2));
    const state = await pipelineState(db, site, nextMonth);
    expect(state.reasons.sort()).toEqual(['kill_switch', 'manual']);
    const budgetRows = await db.select().from(aiPipelinePauses).where(and(eq(aiPipelinePauses.siteId, site), eq(aiPipelinePauses.reason, 'budget')));
    expect(budgetRows[0]).toMatchObject({ liftedBy: 'system:new_month' });
    // Lifting the manual pause still leaves the kill switch.
    const after = await new PipelineControlService({ db, siteId: site, userId: fx.users.adminA.id, now: () => nextMonth }).resume('manual');
    expect(after).toMatchObject({ paused: true, reasons: ['kill_switch'] });
  });

  it('the same month does not lift a budget pause', async () => {
    await setup({ budget: 0 });
    await codeOf(invoke(gateway(), 'rewrite'));
    expect((await pipelineState(db, site)).reasons).toEqual(['budget']);
  });

  // ── 4.5: governance ──────────────────────────────────────────────────

  it('503 in a row opens the breaker: the backup answers, then the call is deferred without a ledger call', async () => {
    const { a } = await setup();
    const governor = new ModelCallGovernor({ ratePerMinute: 0, breakerFailures: 2, breakerCooldownMs: 60_000 });
    replies.a = STATUS(503);
    replies.b = STATUS(503);
    const g = gateway({ governor });
    // Call 1: a 503, b 503 — each counts once.
    expect(await codeOf(invoke(g, 'rewrite'))).toBe('CHAIN_EXHAUSTED');
    // Call 2: both reach the threshold and open.
    expect(await codeOf(invoke(g, 'rewrite'))).toBe('CHAIN_EXHAUSTED');
    const fp = (await calls())[0]!.candidates as Array<{ fingerprint: string; providerId: string }>;
    expect(governor.snapshot(serviceKey(site, fp.find((c) => c.providerId === a.id)!.fingerprint)).open).toBe(true);
    const callsBefore = (await calls()).length;
    const err = await invoke(g, 'rewrite').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmDeferredError);
    expect((err as LlmDeferredError).code).toBe('BREAKER_OPEN');
    expect((err as LlmDeferredError).consumesRetry).toBe(false);
    // Deferred, not failed: no call row was left behind.
    expect((await calls()).length).toBe(callsBefore);
  });

  it('an open breaker on the primary moves the call to the backup model', async () => {
    await setup();
    const governor = new ModelCallGovernor({ ratePerMinute: 0, breakerFailures: 1, breakerCooldownMs: 60_000 });
    replies.a = STATUS(503);
    const g = gateway({ governor });
    await invoke(g, 'rewrite'); // a 503 (opens), b answers
    hits.length = 0;
    await invoke(g, 'rewrite');
    expect(hits).toEqual(['b:chat']);
  });

  it('400 does not count towards the breaker', async () => {
    await setup();
    const governor = new ModelCallGovernor({ ratePerMinute: 0, breakerFailures: 1, breakerCooldownMs: 60_000 });
    replies.a = STATUS(400);
    const g = gateway({ governor });
    await invoke(g, 'rewrite'); // a 400 (transfers), b answers
    const [call] = await calls();
    const cands = call!.candidates as Array<{ fingerprint: string }>;
    expect(governor.snapshot(serviceKey(site, cands[0]!.fingerprint))).toMatchObject({ open: false, failures: 0 });
  });

  it('the rate limit defers the call once every service used its minute', async () => {
    await setup();
    const g = gateway({ governor: new ModelCallGovernor({ ratePerMinute: 1, breakerFailures: 5, breakerCooldownMs: 60_000 }) });
    await invoke(g, 'rewrite'); // a
    await invoke(g, 'rewrite'); // a is limited: b
    const err = await invoke(g, 'rewrite').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmDeferredError);
    expect((err as LlmDeferredError).code).toBe('RATE_LIMITED');
    expect(hits).toEqual(['a:chat', 'b:chat']);
  });

  it('the daily budget defers to the next local day, and the next day the call runs', async () => {
    await setup();
    // Shanghai: UTC+8, no DST.
    await db.execute(
      sql`INSERT INTO lumibase_site_content_settings (site_id, timezone) VALUES (${site}, 'Asia/Shanghai')
        ON CONFLICT (site_id) DO UPDATE SET timezone = 'Asia/Shanghai'`,
    );
    const day1 = new Date();
    let reserved = 0;
    await invoke(gateway({ now: () => day1, hooks: { afterReserve: async (a) => void (reserved = a.reservedMicros) } }), 'write');
    // What is left today (the daily budget less the 60 spent) is less than one more reservation.
    await providers().updateSettings({ currency: 'USD', monthlyBudgetMicros: null, budgetTimezone: 'UTC', dailyBudgetMicros: reserved + 30 });
    const err = await invoke(gateway({ now: () => day1 }), 'write').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmDeferredError);
    expect((err as LlmDeferredError).code).toBe('DAILY_BUDGET_EXHAUSTED');
    const retryAt = (err as LlmDeferredError).retryAt;
    // Midnight in Shanghai is 16:00 UTC.
    expect(retryAt.getUTCHours()).toBe(16);
    expect(retryAt.getUTCMinutes()).toBe(0);
    expect(retryAt.getTime()).toBeGreaterThan(day1.getTime());
    // The attempts are stamped by the database clock: the next local day starts with no spending.
    await db.execute(sql`UPDATE lumibase_llm_attempts SET created_at = created_at - interval '1 day' WHERE site_id = ${site}`);
    await expect(invoke(gateway({ now: () => day1 }), 'write')).resolves.toBeTruthy();
  });

  // ── 4.6: the daily processing quota ──────────────────────────────────

  it('25 eligible documents with a daily limit of 10: 10 today, the rest by priority on later days', async () => {
    await setup({ dailyProcessing: 10 });
    const base = Date.UTC(2026, 9, 1);
    const items = Array.from({ length: 25 }, (_, i) => ({ id: `doc-${String(i).padStart(2, '0')}`, priority: i % 5, eligibleAt: new Date(base + i * 1000) }));
    const now = new Date(Date.UTC(2026, 9, 26, 3));
    const plan = await claimDailyProcessing({ db, now: () => now }, site, items);
    expect(plan.admitted).toHaveLength(10);
    // The highest priorities first.
    expect(plan.admitted.every((id) => items.find((i) => i.id === id)!.priority >= 3)).toBe(true);
    expect(plan.deferred).toHaveLength(15);
    expect(plan.deferred.filter((d) => d.day === '2026-10-27')).toHaveLength(10);
    expect(plan.deferred.filter((d) => d.day === '2026-10-28')).toHaveLength(5);
    // The same day again: nothing left; two schedulers never exceed the limit together.
    const again = await Promise.all([claimDailyProcessing({ db, now: () => now }, site, items), claimDailyProcessing({ db, now: () => now }, site, items)]);
    expect(again.flatMap((p) => p.admitted)).toEqual([]);
  });

  it('concurrent claims on a fresh day admit no more than the limit', async () => {
    await setup({ dailyProcessing: 10 });
    const items = Array.from({ length: 8 }, (_, i) => ({ id: `d${i}`, priority: 1, eligibleAt: new Date(0) }));
    const now = new Date(Date.UTC(2026, 9, 26, 3));
    const plans = await Promise.all([1, 2, 3].map(() => claimDailyProcessing({ db, now: () => now }, site, items)));
    expect(plans.reduce((n, p) => n + p.admitted.length, 0)).toBe(10);
  });

  // ── 1.11: translation billing ────────────────────────────────────────

  it('a translation is a ledger call of the translation route, billed to the site', async () => {
    await setup({ budget: 1_000_000 });
    const out = await new LlmTranslationService(gateway()).translate({
      siteId: site,
      sourceLocale: 'en',
      targetLocale: 'zh-CN',
      segments: [{ id: 's1', text: 'Hello' }],
      glossary: [{ source: 'HeoPress', target: 'HeoPress' }],
    });
    expect(out).toMatchObject({ engine: 'llm', segments: [{ id: 's1', text: '你好' }], provider: 'P-a' });
    const [call] = await calls();
    expect(call).toMatchObject({ id: out.callId, taskType: 'translation', capability: 'translate', status: 'completed' });
    const [att] = await attempts();
    expect(att).toMatchObject({ billing: 'settled', inputTokens: 40, outputTokens: 10, actualMicros: 40 + 20 });
  });

  it('P08 ingest embeddings are ledger calls of capability ingest_embedding', async () => {
    await setup();
    const embedder = gatewayEmbedder(gateway());
    const out = await embedder.embed({ siteId: site, text: 'body' });
    expect(out?.embedding).toEqual([0.1, 0.2, 0.3]);
    const [call] = await calls();
    expect(call).toMatchObject({ capability: 'ingest_embedding', originKind: 'ingest_near_duplicate' });
  });
});
