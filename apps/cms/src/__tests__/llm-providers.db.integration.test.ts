import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { llmAttempts, llmCalls, llmProviders, type Database } from '@heopress/database';
import { createRuntime } from '@heopress/runtime/node';
import { LLM_SECRET_MASK } from '@heopress/contracts/schemas';
import app from '../index';
import { setRuntimeFactory } from '../middleware/runtime';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { createCrossSiteFixture, type CrossSiteFixture } from './helpers/cross-site-fixture';

/**
 * Model providers per site (HeoPress P04 tasks 7.1–7.2, spec
 * platform/llm-providers), through the whole app: the key is sealed and
 * only ever shown as a mask; a base URL cannot carry credentials; prices are
 * in the site's currency, which locks once there is usage; a failover list
 * accepts only the site's own, enabled providers that declare what the task
 * needs; narrowing a provider a list relies on is refused; deleting is soft;
 * only a site's administrators see or change any of it, and only their own.
 */

const JWT_SECRET = 'llm-providers-test-secret';
const KEK = Buffer.alloc(32, 9).toString('base64');
const KEY = 'sk-deepseek-test-key-never-shown';

describe.skipIf(!hasDbIntegrationUrl)('model providers — DB integration', () => {
  let db: Database;
  let fx: CrossSiteFixture;
  let env: Record<string, unknown> = {};

  beforeAll(async () => {
    db = await connectDbIntegration('llm-providers');
    env = { ...process.env, JWT_SECRET, HEOPRESS_ENV: 'development', ENCRYPTION_KEY: KEK, LLM_PRICE_CURRENCY: 'USD' };
    const runtime = createRuntime(env);
    setRuntimeFactory(() => runtime);
  });
  beforeEach(async () => {
    fx = await createCrossSiteFixture(db, { prefix: 'llm', jwtSecret: JWT_SECRET });
  });
  afterAll(async () => {
    setRuntimeFactory(null);
    if (fx) await fx.teardown();
  });

  const as = async (who: 'adminA' | 'adminB' | 'onlyA', site: 'a' | 'b') => fx.headers(site, await fx.session(who, site));
  const call = (pathname: string, method: string, headers: Record<string, string>, body?: unknown) =>
    app.request(`/api/v1/llm${pathname}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env);
  const provider = (over: Record<string, unknown> = {}) => ({
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    apiKey: KEY,
    capabilities: { tools: true, json: true, maxContext: 64000 },
    pricing: { kind: 'per_1m_tokens', inputMicros: 270_000, outputMicros: 1_100_000 },
    currency: 'USD',
    ...over,
  });
  const create = async (headers: Record<string, string>, over: Record<string, unknown> = {}) => {
    const res = await call('/providers', 'POST', headers, provider(over));
    expect(res.status, await res.clone().text()).toBe(201);
    return ((await res.json()) as { data: { id: string } }).data;
  };
  const codeOf = async (res: Response) => ((await res.json()) as { errors: Array<{ code: string }> }).errors[0]!.code;

  it('the key is sealed and only a mask comes back', async () => {
    const a = await as('adminA', 'a');
    const res = await call('/providers', 'POST', a, provider());
    const text = await res.text();
    expect(res.status).toBe(201);
    expect(text).not.toContain(KEY);
    expect(JSON.parse(text).data).toMatchObject({ apiKey: LLM_SECRET_MASK, kind: 'openai_compatible', pricing: { kind: 'per_1m_tokens' }, disabled: false });
    for (const path of ['/providers', `/providers/${JSON.parse(text).data.id}`]) {
      expect(await (await call(path, 'GET', a)).text()).not.toContain(KEY);
    }
    const [row] = await db.select().from(llmProviders).where(eq(llmProviders.id, JSON.parse(text).data.id));
    expect(row!.secretCiphertext).toBeTruthy();
    expect(row!.secretCiphertext).not.toContain(KEY);
    // Same name on the same site: refused; on another site: fine.
    expect(await codeOf(await call('/providers', 'POST', a, provider()))).toBe('NAME_TAKEN');
    expect((await call('/providers', 'POST', await as('adminB', 'b'), provider())).status).toBe(201);
  });

  it('a base URL cannot carry credentials, a query string or a fragment', async () => {
    const a = await as('adminA', 'a');
    for (const baseUrl of ['https://api.example.com/v1?key=sk-x', 'https://user:pw@api.example.com/v1', 'https://api.example.com/v1#k', 'ftp://api.example.com', 'not-a-url']) {
      expect((await call('/providers', 'POST', a, provider({ baseUrl }))).status, baseUrl).toBe(400);
    }
    const p = await create(a);
    expect((await call(`/providers/${p.id}`, 'PATCH', a, { baseUrl: 'not-a-url' })).status).toBe(400);
  });

  it("prices are in the site's currency, which locks once there is usage", async () => {
    const a = await as('adminA', 'a');
    expect(await codeOf(await call('/providers', 'POST', a, provider({ currency: 'CNY' })))).toBe('PRICE_CURRENCY_MISMATCH');
    const p = await create(a);
    // Providers priced in USD: the site cannot move to CNY.
    expect(await codeOf(await call('/settings', 'PUT', a, { currency: 'CNY', monthlyBudgetMicros: null }))).toBe('PRICE_CURRENCY_MISMATCH');
    await call(`/providers/${p.id}`, 'DELETE', a);
    const moved = await call('/settings', 'PUT', a, { currency: 'CNY', monthlyBudgetMicros: 50_000_000, budgetTimezone: 'Asia/Shanghai' });
    expect(moved.status).toBe(200);
    expect(((await moved.json()) as { data: unknown }).data).toEqual({ currency: 'CNY', monthlyBudgetMicros: 50_000_000, budgetTimezone: 'Asia/Shanghai' });
    // Usage on record: the currency is locked; the budget can still change.
    const [c] = await db
      .insert(llmCalls)
      .values({ siteId: fx.sites.a, callKey: 'k1', taskType: 'chat', originKind: 'test', requestDigest: 'd', candidates: [], deadlineAt: new Date(), status: 'failed', terminalReason: 'TEST' })
      .returning();
    await db.insert(llmAttempts).values({
      siteId: fx.sites.a, callId: c!.id, seq: 1, position: 0, source: 'instance', instanceRef: 'llm-default', snapshot: {},
      requestDigest: 'd', period: '2026-10', outcome: 'failed_final', billing: 'cancelled', reservedMicros: 0,
    });
    expect(await codeOf(await call('/settings', 'PUT', a, { currency: 'USD', monthlyBudgetMicros: null }))).toBe('CURRENCY_LOCKED');
    expect((await call('/settings', 'PUT', a, { currency: 'CNY', monthlyBudgetMicros: 1 })).status).toBe(200);
    expect((await call('/settings', 'PUT', a, { currency: 'CNY', monthlyBudgetMicros: null, budgetTimezone: 'Mars/Olympus' })).status).toBe(400);
  });

  it('a failover list takes only enabled providers of the site that declare what the task needs', async () => {
    const a = await as('adminA', 'a');
    const tools = await create(a, { name: 'With tools' });
    const plain = await create(a, { name: 'No tools', capabilities: { tools: false, json: true, maxContext: null } });
    const theirs = await create(await as('adminB', 'b'), { name: 'Site B' });
    const set = (taskType: string, providerIds: string[]) => call('/routes', 'PUT', a, { taskType, providerIds });

    expect(await codeOf(await set('chat', [tools.id, plain.id]))).toBe('CAPABILITY_UNSUPPORTED'); // chat needs tools
    expect(await codeOf(await set('default', [plain.id]))).toBe('CAPABILITY_UNSUPPORTED'); // default stands in for chat
    expect((await set('generation', [plain.id, tools.id])).status).toBe(200);
    expect(await codeOf(await set('chat', [theirs.id]))).toBe('NOT_FOUND'); // another site's provider
    expect((await set('chat', [tools.id, tools.id])).status).toBe(400); // twice in one list
    expect((await set('chat', [tools.id])).status).toBe(200);

    const routes = ((await (await call('/routes', 'GET', a)).json()) as { data: Array<{ taskType: string; providers: Array<{ id: string; available: boolean }> }> }).data;
    expect(routes.find((r) => r.taskType === 'generation')!.providers.map((p) => p.id)).toEqual([plain.id, tools.id]);

    // A list relies on it: its tools cannot be taken away.
    expect(await codeOf(await call(`/providers/${tools.id}`, 'PATCH', a, { capabilities: { tools: false, json: true, maxContext: null } }))).toBe('CAPABILITY_UNSUPPORTED');
    // Disabled: cannot join a list; the lists that name it keep it (marked).
    await call(`/providers/${plain.id}`, 'PATCH', a, { disabled: true });
    expect(await codeOf(await set('translation', [plain.id]))).toBe('PROVIDER_DISABLED');
    // Deleted: gone from the list of providers, still named (unavailable) in its lists.
    expect((await call(`/providers/${tools.id}`, 'DELETE', a)).status).toBe(204);
    expect(((await (await call('/providers', 'GET', a)).json()) as { data: Array<{ id: string }> }).data.map((p) => p.id)).toEqual([plain.id]);
    const after = ((await (await call('/routes', 'GET', a)).json()) as { data: Array<{ taskType: string; providers: Array<{ id: string; available: boolean }> }> }).data;
    expect(after.find((r) => r.taskType === 'chat')!.providers).toEqual([expect.objectContaining({ id: tools.id, available: false })]);
    expect(await codeOf(await set('chat', [tools.id]))).toBe('NOT_FOUND');
    const [row] = await db.select().from(llmProviders).where(eq(llmProviders.id, tools.id));
    expect(row!.secretCiphertext).toBeNull(); // the key goes with it
  });

  it('creating a provider waits for a currency change in progress and sees its result (Codex P04-7.1 #3)', async () => {
    const a = await as('adminA', 'a');
    // Another transaction holds the site's ledger lock and is moving the site to CNY.
    let release: () => void = () => undefined;
    const holding = db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`heopress-llm-ledger:${fx.sites.a}`}))`);
      await tx.execute(sql`INSERT INTO lumibase_llm_site_settings (site_id, currency) VALUES (${fx.sites.a}, 'CNY')
                           ON CONFLICT (site_id) DO UPDATE SET currency = 'CNY'`);
      await new Promise<void>((r) => (release = r));
    });
    await new Promise((r) => setTimeout(r, 50));
    let done = false;
    const creating = Promise.resolve(call('/providers', 'POST', a, provider())).then((res) => {
      done = true;
      return res;
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(done).toBe(false); // waiting on the lock, not reading the old currency
    release();
    await holding;
    const res = await creating;
    expect(await codeOf(res)).toBe('PRICE_CURRENCY_MISMATCH');
  });

  it('the database refuses a provider without prices, an inconsistent call and a cross-call attempt chain (Codex P04-7.1 #5, #8)', async () => {
    const base = { siteId: fx.sites.a, kind: 'openai_compatible', baseUrl: 'https://api.example.com/v1', model: 'm', capabilities: {}, currency: 'USD' };
    await expect(db.insert(llmProviders).values({ ...base, name: 'n1', pricingKind: 'per_request', requestPriceMicros: null })).rejects.toThrow();
    await expect(db.insert(llmProviders).values({ ...base, name: 'n2', pricingKind: 'per_1m_tokens', inputPriceMicros: 1, outputPriceMicros: null })).rejects.toThrow();
    const callRow = { siteId: fx.sites.a, taskType: 'chat', originKind: 'test', requestDigest: 'd', candidates: [], deadlineAt: new Date() };
    await expect(db.insert(llmCalls).values({ ...callRow, callKey: 'c1', status: 'failed', terminalReason: 'X', result: { content: 'x' } })).rejects.toThrow();
    await expect(db.insert(llmCalls).values({ ...callRow, callKey: 'c2', status: 'open', result: { content: 'x' } })).rejects.toThrow();
    await expect(db.insert(llmCalls).values({ ...callRow, callKey: 'c3', status: 'completed', terminalReason: 'X', winnerAttemptId: 'w', result: {} })).rejects.toThrow();
    // An attempt's previous attempt must be of the same call.
    const [c1] = await db.insert(llmCalls).values({ ...callRow, callKey: 'k1', status: 'open' }).returning();
    const [c2] = await db.insert(llmCalls).values({ ...callRow, callKey: 'k2', status: 'open' }).returning();
    const attempt = { siteId: fx.sites.a, position: 0, source: 'instance', instanceRef: 'llm-default', snapshot: {}, requestDigest: 'd', period: '2026-10', outcome: 'failed_transferable', billing: 'unknown', reservedMicros: 0 };
    const [first] = await db.insert(llmAttempts).values({ ...attempt, callId: c1!.id, seq: 1 }).returning();
    await expect(db.insert(llmAttempts).values({ ...attempt, callId: c2!.id, seq: 1, previousAttemptId: first!.id })).rejects.toThrow();
    await expect(db.insert(llmAttempts).values({ ...attempt, callId: c1!.id, seq: 2, previousAttemptId: first!.id })).resolves.toBeDefined();
  });

  it("only the site's administrators manage its providers, and only their own", async () => {
    const a = await as('adminA', 'a');
    const p = await create(a);
    expect((await call('/providers', 'GET', await as('onlyA', 'a'))).status).toBe(403);
    expect((await call('/settings', 'PUT', await as('onlyA', 'a'), { currency: 'USD', monthlyBudgetMicros: 1 })).status).toBe(403);
    const b = await as('adminB', 'b');
    expect(((await (await call('/providers', 'GET', b)).json()) as { data: unknown[] }).data).toEqual([]);
    for (const [method, body] of [['GET'], ['PATCH', { name: 'x' }], ['DELETE']] as const) {
      expect((await call(`/providers/${p.id}`, method, b, body)).status).toBe(404);
    }
    // Probing is the same: administrators of the provider's own site, an enabled provider.
    expect((await call(`/providers/${p.id}/probe`, 'POST', await as('onlyA', 'a'))).status).toBe(403);
    expect((await call(`/providers/${p.id}/probe`, 'POST', b)).status).toBe(404);
    await call(`/providers/${p.id}`, 'PATCH', a, { disabled: true });
    expect(await codeOf(await call(`/providers/${p.id}/probe`, 'POST', a))).toBe('PROVIDER_DISABLED');
  });

  it('without the instance encryption key a key cannot be stored: 503 ENCRYPTION_NOT_CONFIGURED', async () => {
    const a = await as('adminA', 'a');
    const keyless = createRuntime({ ...env, ENCRYPTION_KEY: undefined });
    setRuntimeFactory(() => keyless);
    try {
      const res = await call('/providers', 'POST', a, provider());
      expect(res.status).toBe(503);
      expect(await codeOf(res)).toBe('ENCRYPTION_NOT_CONFIGURED');
      // Without a key to store, a provider can still be configured (e.g. a local server).
      expect((await call('/providers', 'POST', a, provider({ name: 'Local', apiKey: null }))).status).toBe(201);
    } finally {
      const runtime = createRuntime(env);
      setRuntimeFactory(() => runtime);
    }
  });
});
