import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { aiConversations, aiMessages, auditLog, llmAttempts, llmCalls, llmProviders, type Database } from '@heopress/database';
import { createRuntime, outboundFetch, parseTrustedEndpoints } from '@heopress/runtime/node';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';

// The native adapters (instance Anthropic/Gemini) go through the service fetch: controlled here.
const native = vi.hoisted(() => ({ bodies: [] as Array<Record<string, unknown>>, reply: (): Response => new Response('{}', { status: 500 }) }));
vi.mock('../services/service-fetch', () => ({
  serviceFetch: async (_url: string, init: RequestInit) => {
    native.bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return native.reply();
  },
}));
import { createCrossSiteFixture, type CrossSiteFixture } from './helpers/cross-site-fixture';
import { LlmGateway, LlmGatewayError } from '../services/llm/gateway';
import { ModelCallGovernor } from '../services/llm/governance';
import { LlmProviderService } from '../services/llm/provider-service';
import { recoverLlmLedger } from '../services/llm/recovery';
import { DecisionProviderError, createDecisionProvider } from '../services/decision-provider';
import { configuredLlm } from '../services/llm/bindings';
import { chatRunHistory } from '../services/ai-chat-run-history';
import { createPendingRun } from '../services/flow-run-service';

/**
 * The model gateway and its ledger (HeoPress P04 tasks 7.2–7.4; design
 * "模型提供方实施方案", state machine T1–T9), against a mock
 * OpenAI-compatible service and the real database.
 */

const KEK = Buffer.alloc(32, 5).toString('base64');
const KEY_A = 'sk-primary-key-never-in-the-ledger';
const KEY_B = 'sk-backup-key-never-in-the-ledger';

type Handler = (req: IncomingMessage, body: Record<string, unknown>, res: ServerResponse) => void;
const handlers: Record<string, Handler> = {};
const requests: Array<{ provider: string; auth: string | undefined }> = [];
let server: Server;
let origin = '';

const answer = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const ok = (content: string, usage?: { prompt_tokens?: number; completion_tokens?: number }) => (_req: IncomingMessage, _b: unknown, res: ServerResponse) =>
  answer(res, 200, { choices: [{ message: { content } }], ...(usage ? { usage } : {}) });
const never: Handler = () => undefined;

describe.skipIf(!hasDbIntegrationUrl)('model gateway — DB integration', () => {
  let db: Database;
  let fx: CrossSiteFixture;
  let keys: ReturnType<typeof createRuntime>['keys'];
  let site = '';

  beforeAll(async () => {
    db = await connectDbIntegration('llm-gateway');
    keys = createRuntime({ ...process.env, ENCRYPTION_KEY: KEK, HEOPRESS_ENV: 'development' }).keys;
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
      req.on('end', () => {
        const provider = (req.url ?? '').split('/')[1] ?? '';
        requests.push({ provider, auth: req.headers.authorization });
        (handlers[provider] ?? never)(req, raw ? (JSON.parse(raw) as Record<string, unknown>) : {}, res);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  beforeEach(async () => {
    fx = await createCrossSiteFixture(db, { prefix: 'gw', jwtSecret: 'gw-secret' });
    site = fx.sites.a;
    requests.length = 0;
    for (const k of Object.keys(handlers)) delete handlers[k];
  });
  afterAll(async () => {
    if (fx) await fx.teardown();
    await new Promise<void>((r) => server.close(() => r()));
  });

  const trustedFetch = (url: string, init: RequestInit) => outboundFetch(url, { ...init, purpose: 'service', trusted: parseTrustedEndpoints(origin) });
  const gateway = (env: Record<string, string> = {}, fetch: typeof trustedFetch = trustedFetch, extra: Partial<ConstructorParameters<typeof LlmGateway>[0]> = {}) =>
    // A fresh governor per gateway: the shared one would carry rate and breaker state from test to test (HeoPress P09).
    new LlmGateway({ db, keys, env, fetch, governor: new ModelCallGovernor({ ratePerMinute: 0, breakerFailures: 1000, breakerCooldownMs: 1000 }), ...extra });
  /** A short grace period, so real lease timing can be exercised. */
  const GRACE = 200;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const providers = () => new LlmProviderService({ db, siteId: site, keys, instanceCurrency: 'USD' });
  /** Two providers on the mock service (paths /a and /b), the list chat → [a, b]. */
  const setup = async (opts: { budget?: number | null; timeoutMs?: number } = {}) => {
    const svc = providers();
    const mk = (name: string, path: string, apiKey: string) =>
      svc.create({
        kind: 'openai_compatible',
        name,
        baseUrl: `${origin}/${path}`,
        model: `model-${path}`,
        apiKey,
        capabilities: { tools: true, json: true, maxContext: null },
        pricing: { kind: 'per_1m_tokens', inputMicros: 1_000_000, outputMicros: 2_000_000 }, // 1 and 2 per million tokens
        currency: 'USD',
        timeoutMs: opts.timeoutMs ?? 1000,
      });
    const a = await mk('Primary', 'a', KEY_A);
    const b = await mk('Backup', 'b', KEY_B);
    await svc.setRoute('chat', [a.id, b.id]);
    if (opts.budget !== undefined) await svc.updateSettings({ currency: 'USD', monthlyBudgetMicros: opts.budget, budgetTimezone: 'UTC' });
    return { a, b };
  };
  const chat = (g: LlmGateway, over: Partial<Parameters<LlmGateway['chat']>[0]> = {}) =>
    g.chat({ siteId: site, taskType: 'chat', origin: { kind: 'test' }, messages: [{ role: 'user', content: 'hello' }], tools: false, maxOutputTokens: 100, ...over });
  const attempts = () => db.select().from(llmAttempts).where(eq(llmAttempts.siteId, site)).orderBy(llmAttempts.createdAt, llmAttempts.seq);
  const calls = () => db.select().from(llmCalls).where(eq(llmCalls.siteId, site));
  const codeOf = (p: Promise<unknown>) => p.then(() => 'resolved', (e: unknown) => (e instanceof LlmGatewayError ? e.code : String(e)));

  it('a successful call is settled at its real cost, and the call completes with the winner', async () => {
    await setup();
    handlers.a = ok('hi', { prompt_tokens: 10, completion_tokens: 5 });
    const out = await chat(gateway());
    expect(out).toMatchObject({ response: { content: 'hi' }, provider: 'Primary', model: 'model-a' });
    const [att] = await attempts();
    // 10 input tokens at 1 per million, 5 output at 2 per million, each rounded up to a micro-unit.
    expect(att).toMatchObject({ outcome: 'succeeded', billing: 'settled', actualMicros: 10 + 10, inputTokens: 10, outputTokens: 5, settledBy: 'auto', overspend: false });
    expect(requests[0]!.auth).toBe(`Bearer ${KEY_A}`);
    const [call] = await calls();
    expect(call).toMatchObject({ status: 'completed', winnerAttemptId: att!.id });
  });

  it('a success without usage still delivers the answer; the reservation stays as an unknown liability', async () => {
    await setup();
    handlers.a = ok('no usage');
    expect((await chat(gateway())).response.content).toBe('no usage');
    const [att] = await attempts();
    expect(att).toMatchObject({ outcome: 'succeeded', billing: 'unknown', actualMicros: null });
    expect(att!.reservedMicros).toBeGreaterThan(0);
  });

  it('the primary times out: the backup answers; two attempts, both kept, the answer says which model', async () => {
    await setup({ timeoutMs: 1000 });
    handlers.a = never;
    handlers.b = ok('from backup', { prompt_tokens: 10, completion_tokens: 10 });
    const out = await chat(gateway());
    expect(out).toMatchObject({ provider: 'Backup', model: 'model-b' });
    const [first, second] = await attempts();
    expect(first).toMatchObject({ outcome: 'failed_transferable', billing: 'unknown', errorCode: 'TIMEOUT', seq: 1 });
    expect(second).toMatchObject({ outcome: 'succeeded', billing: 'settled', seq: 2, previousAttemptId: first!.id });
  });

  it('the caller cancels: no failover, the call fails, the liability stays', async () => {
    await setup({ timeoutMs: 5000 });
    handlers.a = never;
    handlers.b = ok('should not be asked');
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 200);
    expect(await codeOf(chat(gateway(), { signal: stop.signal }))).toBe('CANCELLED');
    expect(requests.map((r) => r.provider)).toEqual(['a']);
    const [att] = await attempts();
    expect(att).toMatchObject({ outcome: 'failed_final', billing: 'unknown' });
    expect((await calls())[0]).toMatchObject({ status: 'failed', terminalReason: 'CANCELLED' });
  });

  it('over budget: refused before anything is sent', async () => {
    await setup({ budget: 10 }); // ten micro-units: less than any reservation
    handlers.a = ok('x', { prompt_tokens: 1, completion_tokens: 1 });
    expect(await codeOf(chat(gateway()))).toBe('BUDGET_EXCEEDED');
    expect(requests).toHaveLength(0);
    expect(await attempts()).toHaveLength(0);
    expect((await calls())[0]).toMatchObject({ status: 'failed', terminalReason: 'BUDGET_EXCEEDED' });
  });

  it('an actual cost above the reservation is recorded in full, alerted, and the next call refused', async () => {
    const { a } = await setup();
    // Room for the reservation, not for what is actually used.
    await providers().updateSettings({ currency: 'USD', monthlyBudgetMicros: 2_000, budgetTimezone: 'UTC' });
    handlers.a = ok('long', { prompt_tokens: 10, completion_tokens: 1_000_000 });
    await chat(gateway());
    const [att] = await attempts();
    expect(att).toMatchObject({ billing: 'settled', actualMicros: 10 + 2_000_000, overspend: true });
    const alerts = await db.select().from(auditLog).where(and(eq(auditLog.siteId, site), eq(auditLog.event, 'llm_cost_over_reservation')));
    expect(alerts).toHaveLength(1);
    expect(await codeOf(chat(gateway()))).toBe('BUDGET_EXCEEDED');
    void a;
  });

  it('a 429 without usage is an unknown liability and fails over; an error carrying usage is settled', async () => {
    await setup();
    handlers.a = (_r, _b, res) => answer(res, 429, { error: { code: 'rate_limit_exceeded' } });
    handlers.b = (_r, _b, res) => answer(res, 500, { error: {}, usage: { prompt_tokens: 7, completion_tokens: 0 } });
    expect(await codeOf(chat(gateway()))).toBe('CHAIN_EXHAUSTED');
    const [first, second] = await attempts();
    expect(first).toMatchObject({ outcome: 'failed_transferable', billing: 'unknown', errorCode: 'PROVIDER_HTTP_429:RATE_LIMITED' });
    expect(second).toMatchObject({ outcome: 'failed_transferable', billing: 'settled', actualMicros: 7 });
  });

  it('refused by the outbound boundary: a policy refusal does not fail over; refused before sending, it costs nothing', async () => {
    await setup();
    handlers.b = ok('b', { prompt_tokens: 1, completion_tokens: 1 });
    // Nothing trusted: /a is refused before connecting (a loopback address).
    const untrusted = (url: string, init: RequestInit) => outboundFetch(url, { ...init, purpose: 'service', trusted: parseTrustedEndpoints('') });
    expect(await codeOf(chat(gateway({}, untrusted)))).toBe('OUTBOUND_BLOCKED');
    expect(requests).toHaveLength(0);
    const all = await attempts();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ outcome: 'failed_final', billing: 'cancelled', actualMicros: 0, errorCode: 'OUTBOUND_BLOCKED' });
  });

  it('replaying a call key returns the stored answer without asking again; another request under it is refused', async () => {
    await setup();
    handlers.a = ok('once', { prompt_tokens: 1, completion_tokens: 1 });
    const first = await chat(gateway(), { callKey: 'run:1:step:1:call:1' });
    const again = await chat(gateway(), { callKey: 'run:1:step:1:call:1' });
    expect(again).toEqual(first); // the answer, and the same call and attempt ids
    expect(again.callId).toBeTruthy();
    expect(again.attemptIds).toHaveLength(1);
    expect(requests).toHaveLength(1);
    expect(await codeOf(chat(gateway(), { callKey: 'run:1:step:1:call:1', messages: [{ role: 'user', content: 'other' }] }))).toBe('CALL_DIGEST_MISMATCH');
  });

  it('a replay while the call is in flight is refused; nothing is sent twice', async () => {
    await setup({ timeoutMs: 3000 });
    let release: () => void = () => undefined;
    handlers.a = (_r, _b, res) => {
      release = () => answer(res, 200, { choices: [{ message: { content: 'late' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    };
    const running = chat(gateway(), { callKey: 'k-inflight' });
    await vi.waitFor(() => expect(requests.length).toBeGreaterThan(0));
    expect(await codeOf(chat(gateway(), { callKey: 'k-inflight' }))).toBe('CALL_IN_PROGRESS');
    release();
    expect((await running).response.content).toBe('late');
    expect(requests).toHaveLength(1);
  });

  /** An executor that reserves, then vanishes before sending (the hook throws). */
  const crashAfterReserve = (key: string) =>
    chat(gateway({}, trustedFetch, { graceMs: GRACE, hooks: { afterReserve: async () => { throw new Error('process gone'); } } }), { callKey: key, deadlineMs: 60_000 }).catch(() => undefined);

  it('after a crash, by real lease timing: recovery makes the attempt an unknown liability and ends the call nobody drives', async () => {
    await setup({ timeoutMs: 300 });
    await crashAfterReserve('k-crash');
    // Inside the grace period: nothing to recover yet.
    expect(await recoverLlmLedger(db, { graceMs: GRACE })).toEqual({ attempts: 0, calls: 0 });
    await sleep(300 + 2 * GRACE + 500); // generous: timing under load // the lease (timeout + grace), then the grace
    expect(await recoverLlmLedger(db, { graceMs: GRACE })).toEqual({ attempts: 1, calls: 1 });
    const [lost] = await attempts();
    expect(lost).toMatchObject({ outcome: 'lost', billing: 'unknown' });
    expect((await calls())[0]).toMatchObject({ status: 'failed', terminalReason: 'ABANDONED' });
    expect(requests).toHaveLength(0);
  });

  it('after a crash, a replay continues along the frozen chain once the leases ran out — not before', async () => {
    const { a } = await setup({ timeoutMs: 300 });
    handlers.b = ok('continued', { prompt_tokens: 1, completion_tokens: 1 });
    await crashAfterReserve('k-continue');
    const g = gateway({}, trustedFetch, { graceMs: GRACE });
    expect(await codeOf(chat(g, { callKey: 'k-continue' }))).toBe('CALL_IN_PROGRESS');
    // The chain is frozen: reordering the list now does not change what the replay does.
    await providers().setRoute('chat', [a.id]);
    await sleep(300 + 2 * GRACE + 500); // generous: timing under load
    const out = await chat(g, { callKey: 'k-continue' });
    expect(out.provider).toBe('Backup');
    expect((await attempts()).map((x) => [x.seq, x.outcome])).toEqual([
      [1, 'lost'],
      [2, 'succeeded'],
    ]);
    expect(out.attemptIds).toHaveLength(2);
  });

  it('a replay from the same process between two attempts is refused; the executor carries on', async () => {
    await setup();
    handlers.a = (_r, _b, res) => answer(res, 500, {});
    handlers.b = ok('b', { prompt_tokens: 1, completion_tokens: 1 });
    let replayed = '';
    const g: LlmGateway = gateway({}, trustedFetch, {
      hooks: {
        afterTransferableEnd: async () => {
          replayed = await codeOf(chat(g, { callKey: 'k-gap' }));
        },
      },
    });
    expect((await chat(g, { callKey: 'k-gap' })).provider).toBe('Backup');
    expect(replayed).toBe('CALL_IN_PROGRESS');
    expect((await attempts()).map((x) => x.seq)).toEqual([1, 2]);
  });

  it('after reservation, a provider moved to another endpoint with a new key: the old endpoint never gets the new key', async () => {
    const { a } = await setup();
    handlers.a = ok('should not be asked', { prompt_tokens: 1, completion_tokens: 1 });
    handlers.b = ok('b', { prompt_tokens: 1, completion_tokens: 1 });
    const g = gateway({}, trustedFetch, {
      hooks: {
        afterReserve: async (att) => {
          if (att.seq === 1) await providers().update(a.id, { baseUrl: `${origin}/c`, apiKey: 'sk-new-key-for-c' });
        },
      },
    });
    expect((await chat(g)).provider).toBe('Backup');
    expect(requests.map((r) => r.provider)).toEqual(['b']);
    expect(requests.some((r) => r.auth?.includes('sk-new-key-for-c'))).toBe(false);
    const [first] = await attempts();
    expect(first).toMatchObject({ outcome: 'failed_transferable', billing: 'cancelled', errorCode: 'PROVIDER_CHANGED' });
  });

  it('after reservation, a provider that no longer has a needed capability ends the call at no cost — no failover', async () => {
    const { a } = await setup();
    handlers.b = ok('b', { prompt_tokens: 1, completion_tokens: 1 });
    const g = gateway({}, trustedFetch, {
      hooks: {
        afterReserve: async (att) => {
          if (att.seq === 1) await db.update(llmProviders).set({ capabilities: { tools: false, json: true, maxContext: null } }).where(eq(llmProviders.id, a.id));
        },
      },
    });
    expect(await codeOf(chat(g, { tools: true }))).toBe('CAPABILITY_UNSUPPORTED');
    expect(requests).toHaveLength(0);
    const all = await attempts();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ outcome: 'failed_final', billing: 'cancelled', errorCode: 'CAPABILITY_UNSUPPORTED' });
  });

  it('time spent opening the key counts: a lease or a deadline that ran out meanwhile, or a cancellation, sends nothing', async () => {
    await setup({ timeoutMs: 300 });
    handlers.a = ok('should not be asked');
    handlers.b = ok('should not be asked either');
    // A key provider that takes longer than the whole lease (300 ms + grace).
    const slow = { ...keys, getKey: async (id: string) => (await sleep(800), keys.getKey(id)) } as typeof keys;
    expect(await codeOf(new LlmGateway({ db, keys: slow, env: {}, fetch: trustedFetch, graceMs: GRACE }).chat({
      siteId: site, taskType: 'chat', origin: { kind: 'test' }, messages: [{ role: 'user', content: 'x' }], tools: false, maxOutputTokens: 10, callKey: 'k-slow',
    }))).not.toBe('resolved');
    expect(requests).toHaveLength(0);
    // Cancelled while the key is opened.
    const stop = new AbortController();
    const slowish = { ...keys, getKey: async (id: string) => (setTimeout(() => stop.abort(), 10), await sleep(100), keys.getKey(id)) } as typeof keys;
    expect(await codeOf(new LlmGateway({ db, keys: slowish, env: {}, fetch: trustedFetch }).chat({
      siteId: site, taskType: 'chat', origin: { kind: 'test' }, messages: [{ role: 'user', content: 'y' }], tools: false, maxOutputTokens: 10, signal: stop.signal,
    }))).toBe('CANCELLED');
    expect(requests).toHaveLength(0);
  });

  it('a cancellation seen while the lease was lost is persisted: the replay obeys it; proven not sent, it costs nothing', async () => {
    await setup();
    handlers.a = ok('should not be asked');
    const stop = new AbortController();
    const g = gateway({}, trustedFetch, {
      hooks: {
        afterReserve: async () => {
          await db.execute(sql`UPDATE lumibase_llm_attempts SET lease_until = now() - interval '1 second' WHERE site_id = ${site}`);
          stop.abort();
        },
      },
    });
    expect(await codeOf(chat(g, { callKey: 'k-cancel', signal: stop.signal }))).toBe('CALL_IN_PROGRESS');
    expect((await calls())[0]!.cancelRequestedAt).not.toBeNull();
    const [att] = await attempts();
    expect(att).toMatchObject({ outcome: 'lost', billing: 'cancelled', actualMicros: 0 });
    // A replay with a fresh signal: still cancelled, nothing sent.
    await db.execute(sql`UPDATE lumibase_llm_calls SET lease_until = now() - interval '1 hour' WHERE site_id = ${site}`);
    expect(await codeOf(chat(gateway(), { callKey: 'k-cancel' }))).toBe('CANCELLED');
    expect(requests).toHaveLength(0);
  });

  it('the tool definitions are part of the call: a replay with other tools is another request', async () => {
    await setup();
    handlers.a = ok('x', { prompt_tokens: 1, completion_tokens: 1 });
    const tools = (description: string) => () => [{ name: 'lookup', description, parameters: { type: 'object' } }];
    await chat(gateway({}, trustedFetch, { tools: tools('v1') }), { callKey: 'k-tools', tools: true });
    expect(await codeOf(chat(gateway({}, trustedFetch, { tools: tools('v2') }), { callKey: 'k-tools', tools: true }))).toBe('CALL_DIGEST_MISMATCH');
  });

  it('a receipt arriving after its own lease expired keeps its usage, without taking the result', async () => {
    await setup({ timeoutMs: 3000 });
    let release: () => void = () => undefined;
    handlers.a = (_r, _b, res) => {
      release = () => answer(res, 200, { choices: [{ message: { content: 'too late' } }], usage: { prompt_tokens: 100, completion_tokens: 100 } });
    };
    const running = codeOf(chat(gateway(), { callKey: 'k-late' }));
    await vi.waitFor(() => expect(requests.length).toBeGreaterThan(0));
    await db.execute(sql`UPDATE lumibase_llm_attempts SET lease_until = now() - interval '1 second' WHERE site_id = ${site}`);
    release();
    expect(await running).toBe('CALL_IN_PROGRESS');
    const [att] = await attempts();
    expect(att).toMatchObject({ outcome: 'lost', billing: 'settled', actualMicros: 100 + 200 });
    expect((await calls())[0]).toMatchObject({ status: 'open', winnerAttemptId: null });
  });

  it('a capability or currency that no longer fits ends the call before sending', async () => {
    const { a, b } = await setup();
    await db.update(llmProviders).set({ capabilities: { tools: false, json: true, maxContext: null } }).where(eq(llmProviders.id, a.id));
    expect(await codeOf(chat(gateway(), { tools: true }))).toBe('CAPABILITY_UNSUPPORTED');
    await db.update(llmProviders).set({ capabilities: { tools: true, json: true, maxContext: null }, currency: 'EUR' }).where(eq(llmProviders.id, a.id));
    expect(await codeOf(chat(gateway()))).toBe('PRICE_CURRENCY_MISMATCH');
    expect(requests).toHaveLength(0);
    void b;
  });

  it('a list whose providers are all disabled is an error, not a fall back to the instance; the instance default needs a price', async () => {
    const { a, b } = await setup();
    for (const p of [a, b]) await providers().update(p.id, { disabled: true });
    const env = { LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-instance' };
    expect(await codeOf(chat(gateway(env)))).toBe('PROVIDER_UNAVAILABLE');
    expect(await codeOf(chat(gateway(env), { taskType: 'generation' }))).toBe('PRICE_NOT_CONFIGURED');
    expect(await codeOf(chat(gateway({}), { taskType: 'generation' }))).toBe('LLM_NOT_CONFIGURED');
  });

  it('the instance’s native protocol: the reserved output cap is the one sent, and a billed error keeps its usage', async () => {
    const env = { LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-instance', LLM_PRICE_INPUT_PER_1M: '1', LLM_PRICE_OUTPUT_PER_1M: '2' };
    native.bodies.length = 0;
    native.reply = () => new Response(JSON.stringify({ error: { type: 'overloaded_error' }, usage: { input_tokens: 40, output_tokens: 5 } }), { status: 529 });
    expect(await codeOf(chat(gateway(env), { taskType: 'generation', maxOutputTokens: 77 }))).toBe('CHAIN_EXHAUSTED');
    expect(native.bodies[0]).toMatchObject({ max_tokens: 77 });
    const [att] = await attempts();
    expect(att).toMatchObject({ source: 'instance', instanceRef: 'llm-default', outcome: 'failed_transferable', billing: 'settled', actualMicros: 40 + 10, errorCode: 'PROVIDER_HTTP_529' });
  });

  describe('the decision service through the ledger: each retry is an attempt', () => {
    const request = { state: { title: 'Post' }, questions: { spam: { type: 'noul', instructions: 'Spam?', criteria: { true: 'spam', false: 'ok' } } } } as never;
    const upstream = { model: 'jev-1', answers: { spam: { type: 'noul', noul: 0.1 } }, usage: { input_tokens: 10, output_tokens: 0 } };
    const decision = (env: Record<string, string>, g: LlmGateway = gateway()) =>
      createDecisionProvider(
        { DECISION_PROVIDER: 'typesafe', TYPESAFE_API_KEY: 'ts-key', DECISION_MAX_RETRIES: '2', DECISION_PRICE_PER_REQUEST: '0.01', ...env },
        { gateway: g, siteId: site, origin: { kind: 'decision' } },
      )!.provider;

    it('two retryable failures then an answer: three attempts, the answer billed per request', async () => {
      const replies = [503, 503, 200];
      native.reply = () => {
        const status = replies.shift()!;
        return status === 200 ? new Response(JSON.stringify(upstream)) : new Response('{}', { status });
      };
      const out = await decision({}).decide(request);
      expect(out.answers).toBeDefined();
      const all = await attempts();
      expect(all.map((a) => [a.seq, a.outcome, a.billing])).toEqual([
        [1, 'failed_transferable', 'unknown'],
        [2, 'failed_transferable', 'unknown'],
        [3, 'succeeded', 'settled'],
      ]);
      expect(all[2]).toMatchObject({ source: 'instance', instanceRef: 'decision', actualMicros: 10_000 });
    });

    it('a final status is one attempt and the service’s own error', async () => {
      native.reply = () => new Response('{}', { status: 401 });
      const err = await decision({}).decide(request).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DecisionProviderError);
      expect(err).toMatchObject({ code: 'DECISION_AUTH' });
      expect(await attempts()).toHaveLength(1);
    });

    it('a backoff longer than the call lease keeps the lease: the retry is sent, not refused', async () => {
      // After a send the call's lease is the attempt timeout plus grace (500 + 200 ms); the service asks for a 2 s wait.
      const replies = [503, 200];
      native.reply = () => {
        const status = replies.shift()!;
        return status === 200 ? new Response(JSON.stringify(upstream)) : new Response('{}', { status, headers: { 'retry-after': '2' } });
      };
      const out = await decision({ DECISION_ATTEMPT_TIMEOUT_MS: '500' }, gateway({}, trustedFetch, { graceMs: GRACE })).decide(request);
      expect(out.answers).toBeDefined();
      expect((await attempts()).map((a) => a.outcome)).toEqual(['failed_transferable', 'succeeded']);
    });

    it('after the last attempt there is no backoff', async () => {
      native.reply = () => new Response('{}', { status: 503, headers: { 'retry-after': '3' } });
      const started = Date.now();
      const err = await decision({ DECISION_MAX_RETRIES: '0' }).decide(request).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DecisionProviderError);
      expect(Date.now() - started).toBeLessThan(2000);
      expect(await attempts()).toHaveLength(1);
    });

    it('the LLM path: refusals are the service’s errors, and the answer names the model actually used', async () => {
      const { a, b } = await setup({ budget: 0 });
      await providers().setRoute('decision', [a.id, b.id]);
      const llmDecision = () => createDecisionProvider({ DECISION_PROVIDER: 'llm' }, { gateway: gateway(), siteId: site, origin: { kind: 'decision' } })!.provider;
      expect(await llmDecision().decide(request).catch((e: unknown) => e)).toMatchObject({ code: 'DECISION_REFUSED' });
      expect(requests).toHaveLength(0);
      await providers().updateSettings({ currency: 'USD', monthlyBudgetMicros: null, budgetTimezone: 'UTC' });
      handlers.a = (_r, _b, res) => answer(res, 503, {});
      handlers.b = ok(JSON.stringify({ answers: { spam: { noul: 0.2, confidence: 0.9 } } }), { prompt_tokens: 5, completion_tokens: 5 });
      expect(await llmDecision().decide(request)).toMatchObject({ provider: 'llm', model: 'Backup:model-b' });
      handlers.b = (_r, _b, res) => answer(res, 503, {});
      expect(await llmDecision().decide(request).catch((e: unknown) => e)).toMatchObject({ code: 'DECISION_UNAVAILABLE' });
    });

    it('without a price nothing is sent', async () => {
      native.bodies.length = 0;
      const err = await decision({ DECISION_PRICE_PER_REQUEST: '' }).decide(request).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: 'DECISION_REFUSED' });
      expect(native.bodies).toHaveLength(0);
    });
  });

  it('a heartbeat between attempts never shortens the call’s lease (one landing after the next send guard)', async () => {
    await setup();
    handlers.a = ok('hi', { prompt_tokens: 1, completion_tokens: 1 });
    let leftMs = 0;
    const g: LlmGateway = gateway({}, trustedFetch, {
      hooks: {
        afterReserve: async (att) => {
          await db.update(llmCalls).set({ leaseUntil: sql`now() + interval '60 seconds'` }).where(eq(llmCalls.id, att.callId));
          await (g as unknown as { renewCallLease(siteId: string, callId: string, ms: number): Promise<void> }).renewCallLease(site, att.callId, 400);
          const [row] = await db.select({ left: sql<number>`EXTRACT(EPOCH FROM (lease_until - now())) * 1000` }).from(llmCalls).where(eq(llmCalls.id, att.callId));
          leftMs = Number(row!.left);
        },
      },
    });
    await chat(g);
    expect(leftMs).toBeGreaterThan(30_000);
  });

  it('a heartbeat stuck behind a lock gives up within its bound', async () => {
    await setup();
    handlers.a = ok('hi', { prompt_tokens: 1, completion_tokens: 1 });
    let tookMs = 0;
    const g: LlmGateway = gateway({}, trustedFetch, {
      graceMs: GRACE,
      hooks: {
        afterReserve: async (att) => {
          let release!: () => void;
          const held = new Promise<void>((r) => (release = r));
          let locked!: () => void;
          const isLocked = new Promise<void>((r) => (locked = r));
          const holder = db.transaction(async (tx) => {
            await tx.execute(sql`SELECT 1 FROM lumibase_llm_calls WHERE id = ${att.callId} FOR UPDATE`);
            locked();
            await held;
          });
          await isLocked;
          const started = Date.now();
          await (g as unknown as { renewCallLease(siteId: string, callId: string, ms: number): Promise<void> })
            .renewCallLease(site, att.callId, 400)
            .catch(() => undefined);
          tookMs = Date.now() - started;
          release();
          await holder;
        },
      },
    });
    await chat(g);
    // The lock and statement timeouts are the grace period (200 ms); a little slack for the round trips.
    expect(tookMs).toBeLessThan(GRACE + 300);
  });

  it('generation and translation need no tools: a provider without tool calls serves them, and none are offered', async () => {
    const { a } = await setup();
    await db.update(llmProviders).set({ capabilities: { tools: false, json: true, maxContext: null } }).where(eq(llmProviders.id, a.id));
    await providers().setRoute('generation', [a.id]);
    const bodies: Array<Record<string, unknown>> = [];
    handlers.a = (_r, body, res) => {
      bodies.push(body);
      ok('done', { prompt_tokens: 1, completion_tokens: 1 })(_r, body, res);
    };
    const bound = gateway().providerFor({ siteId: site, taskType: 'generation', origin: { kind: 'test' } });
    expect((await bound.provider.chat([{ role: 'user', content: 'write' }])).content).toBe('done');
    expect(bodies[0]).not.toHaveProperty('tools');
  });

  it('a harness is available when only translation is routed; with neither, it is not', async () => {
    const { a } = await setup();
    const binding = { siteId: site, taskType: 'generation' as const, origin: { kind: 'test' } };
    await providers().setRoute('chat', []);
    expect(await configuredLlm(gateway(), binding, ['translation'])).toBeNull();
    await providers().setRoute('translation', [a.id]);
    expect(await configuredLlm(gateway(), binding)).toBeNull();
    const llm = await configuredLlm(gateway(), binding, ['translation']);
    handlers.a = ok('bonjour', { prompt_tokens: 1, completion_tokens: 1 });
    expect((await llm!.provider.chat([{ role: 'user', content: 'hello' }], { taskType: 'translation' })).content).toBe('bonjour');
  });

  it('a chat run’s history is frozen by its first delivery: the latest turns up to the run, its own site’s only', async () => {
    const [conv] = await db.insert(aiConversations).values({ siteId: site }).returning();
    const at = (ts: string) => sql`${ts}::timestamp`;
    // 25 earlier turns; the user's message a few microseconds before the run, in the same millisecond.
    for (let i = 0; i < 25; i++) {
      await db.insert(aiMessages).values({ conversationId: conv!.id, role: 'user', content: `old ${i}`, createdAt: at(`2026-01-01 00:00:${String(i).padStart(2, '0')}`) as never });
    }
    await db.insert(aiMessages).values({ conversationId: conv!.id, role: 'user', content: 'now', createdAt: at('2026-01-01 01:00:00.123200') as never });
    const run = await createPendingRun(db, { siteId: site, runType: 'ai_chat', input: {} });
    await db.execute(sql`UPDATE lumibase_flow_runs SET created_at = '2026-01-01 01:00:00.123456' WHERE id = ${run.id}`);
    // A later turn exists already.
    await db.insert(aiMessages).values({ conversationId: conv!.id, role: 'user', content: 'later', createdAt: at('2026-01-01 02:00:00') as never });
    const job = { runId: run.id, siteId: site, conversationId: conv!.id };
    const first = (await chatRunHistory(db, job)).map((m) => m.content);
    expect(first).toHaveLength(20);
    expect(first.at(-1)).toBe('now');
    expect(first[0]).toBe('old 6');
    // A message committed late with an earlier time, and this run's reply: the redelivery sends the same.
    await db.insert(aiMessages).values({ conversationId: conv!.id, role: 'user', content: 'late commit', createdAt: at('2026-01-01 00:59:00') as never });
    await db.insert(aiMessages).values({ conversationId: conv!.id, role: 'assistant', content: 'reply' });
    expect((await chatRunHistory(db, job)).map((m) => m.content)).toEqual(first);
    // A deleted conversation ends the run instead of sending part of it.
    await db.delete(aiMessages).where(and(eq(aiMessages.conversationId, conv!.id), eq(aiMessages.content, 'now')));
    await expect(chatRunHistory(db, job)).rejects.toThrow(/history was deleted/);
    // The same conversation id under another site's run reads nothing.
    const other = await createPendingRun(db, { siteId: fx.sites.b, runType: 'ai_chat', input: {} });
    expect(await chatRunHistory(db, { runId: other.id, siteId: fx.sites.b, conversationId: conv!.id })).toEqual([]);
  });

  describe('the capability probe: judged by what came back, each a ledger call of type probe', () => {
    const toolCall = (_r: IncomingMessage, _b: unknown, res: ServerResponse) =>
      answer(res, 200, { choices: [{ message: { content: null, tool_calls: [{ type: 'function', function: { name: 'heopress_probe', arguments: '{"ok":true}' } }] } }], usage: { prompt_tokens: 20, completion_tokens: 5 } });
    const bodies: Array<Record<string, unknown>> = [];
    const byKind = (tools: Handler, json: Handler): Handler => (req, body, res) => {
      bodies.push(body);
      (body.tools ? tools : json)(req, body, res);
    };
    beforeEach(() => {
      bodies.length = 0;
    });

    it('a provider that calls the tool and answers JSON passes both; the requests force the tool and ask for a JSON object', async () => {
      const { a } = await setup();
      handlers.a = byKind(toolCall, ok('{"ok": true}', { prompt_tokens: 10, completion_tokens: 3 }));
      expect(await gateway().probe(site, a.id, { kind: 'probe' })).toEqual({ tools: { ok: true }, json: { ok: true } });
      expect(bodies[0]).toMatchObject({ tool_choice: 'auto', tools: [{ function: { name: 'heopress_probe' } }] });
      expect(bodies[1]).toMatchObject({ response_format: { type: 'json_object' } });
      const probeCalls = await calls();
      expect(probeCalls.map((c) => [c.taskType, c.status])).toEqual([['probe', 'completed'], ['probe', 'completed']]);
      expect((await attempts()).map((x) => [x.billing, x.actualMicros])).toEqual([['settled', 20 + 10], ['settled', 10 + 6]]);
    });

    it('a 200 is not enough: no tool call, or no JSON object, fails — and is still billed; an error says which', async () => {
      const { a, b } = await setup();
      handlers.a = byKind(ok('I would rather not', { prompt_tokens: 1, completion_tokens: 1 }), ok('certainly!', { prompt_tokens: 1, completion_tokens: 1 }));
      expect(await gateway().probe(site, a.id, { kind: 'probe' })).toEqual({ tools: { ok: false, error: 'NO_TOOL_CALL' }, json: { ok: false, error: 'NOT_JSON' } });
      expect((await attempts()).every((x) => x.billing === 'settled')).toBe(true);
      handlers.b = (_r, _b, res) => answer(res, 401, { error: { message: 'bad key' } });
      expect(await gateway().probe(site, b.id, { kind: 'probe' })).toEqual({ tools: { ok: false, error: 'PROVIDER_HTTP_401' }, json: { ok: false, error: 'PROVIDER_HTTP_401' } });
      // Only the probed provider is ever asked: no failover.
      expect(requests.filter((r) => r.provider === 'b')).toHaveLength(2);
      expect(requests.filter((r) => r.provider === 'a')).toHaveLength(2);
    });

    it('a provider declared without tools is still probed (the probe finds out); over budget nothing is sent; a disabled one is refused', async () => {
      const { a, b } = await setup({ budget: 1_000_000 });
      await db.update(llmProviders).set({ capabilities: { tools: false, json: false, maxContext: null } }).where(eq(llmProviders.id, a.id));
      handlers.a = byKind(toolCall, ok('{}', { prompt_tokens: 1, completion_tokens: 1 }));
      expect(await gateway().probe(site, a.id, { kind: 'probe' })).toEqual({ tools: { ok: true }, json: { ok: true } });
      await providers().updateSettings({ currency: 'USD', monthlyBudgetMicros: 0, budgetTimezone: 'UTC' });
      requests.length = 0;
      expect(await gateway().probe(site, a.id, { kind: 'probe' })).toEqual({ tools: { ok: false, error: 'BUDGET_EXCEEDED' }, json: { ok: false, error: 'BUDGET_EXCEEDED' } });
      expect(requests).toHaveLength(0);
      await providers().update(b.id, { disabled: true });
      expect(await codeOf(gateway().probe(site, b.id, { kind: 'probe' }))).toBe('PROVIDER_DISABLED');
      expect(await codeOf(gateway().probe(fx.sites.b, a.id, { kind: 'probe' }))).toBe('NOT_FOUND');
    });

    it('a probe result is kept only for the configuration it probed', async () => {
      const { a } = await setup();
      const svc = providers();
      const basis = await svc.probeBasis(a.id);
      const verdicts = { tools: { ok: true }, json: { ok: false, error: 'NOT_JSON' } };
      const kept = await svc.recordProbe(a.id, basis, verdicts);
      expect(kept.recorded).toBe(true);
      expect(kept.provider.probe).toMatchObject(verdicts);
      // The model changed while a probe ran: its result is about the old one.
      const stale = await svc.probeBasis(a.id);
      await svc.update(a.id, { model: 'model-a2' });
      const dropped = await svc.recordProbe(a.id, stale, verdicts);
      expect(dropped.recorded).toBe(false);
      expect(dropped.provider.probe).toBeNull();
      // Two changes within the same application millisecond are still two versions.
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(new Date('2026-06-01T00:00:00.000Z'));
        await svc.update(a.id, { model: 'model-a3' });
        const before = await svc.probeBasis(a.id);
        await svc.update(a.id, { apiKey: 'sk-rotated-key' });
        expect((await svc.recordProbe(a.id, before, verdicts)).recorded).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('a provider that never answers reports a timeout, not an exhausted chain', async () => {
      const { a } = await setup();
      handlers.a = never;
      expect(await gateway({}, trustedFetch, { graceMs: GRACE }).probe(site, a.id, { kind: 'probe' })).toEqual({ tools: { ok: false, error: 'TIMEOUT' }, json: { ok: false, error: 'TIMEOUT' } });
    });
  });

  it('no key ever reaches the ledger, the logs, the audit log or an error — even when the provider echoes it (P04 7.3)', async () => {
    const captured: string[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation((...args: unknown[]) => void captured.push(args.map(String).join(' '))));
    const writes = [process.stdout, process.stderr].map((stream) =>
      vi.spyOn(stream, 'write').mockImplementation(((chunk: unknown) => (captured.push(String(chunk)), true)) as typeof stream.write),
    );
    const errors: string[] = [];
    try {
      const { a, b } = await setup({ budget: 10_000_000 });
      const echo: Handler = (req, body, res) => answer(res, 401, { error: { code: KEY_A, message: `bad key ${req.headers.authorization} ${KEY_B}`, echo: body } });
      // A key echoed in an error, a failover, a cost above the reservation (alerted and logged), a probe, a recovery sweep.
      handlers.a = echo;
      handlers.b = ok('ok', { prompt_tokens: 50_000, completion_tokens: 50_000 });
      await chat(gateway(), { maxOutputTokens: 1 });
      handlers.b = echo;
      await chat(gateway()).catch((e: unknown) => errors.push(String(e), JSON.stringify(e), (e as Error).stack ?? ''));
      for (const id of [a.id, b.id]) errors.push(JSON.stringify(await gateway().probe(site, id, { kind: 'probe' })));
      handlers.a = never;
      await chat(gateway({}, trustedFetch, { graceMs: GRACE }), { deadlineMs: 300 }).catch((e: unknown) => errors.push(String(e)));
      await sleep(3 * GRACE);
      await recoverLlmLedger(db, { graceMs: GRACE });
    } finally {
      for (const s of [...spies, ...writes]) s.mockRestore();
    }
    const audit = await db.select().from(auditLog).where(eq(auditLog.siteId, site));
    expect(audit.some((r) => r.event === 'llm_cost_over_reservation')).toBe(true);
    expect(captured.some((l) => l.includes('[llm-ledger]'))).toBe(true);
    const dump = JSON.stringify([await attempts(), await calls(), audit, captured, errors]);
    for (const secret of [KEY_A, KEY_B]) expect(dump).not.toContain(secret);
  });
});
