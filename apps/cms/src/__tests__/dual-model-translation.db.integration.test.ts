/**
 * The built-in two-model translation service against the real database and two mock OpenAI-compatible providers
 * (HeoPress v1.4, spec ai/dual-model-translation): both calls are separate, separately priced ledger rows; the same model
 * twice is refused when saving; a budget that cannot cover the draft sends nothing; a reviewer failure keeps the draft;
 * and a revision that breaks a placeholder is rejected while the draft is kept.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { llmAttempts, llmCalls, llmProviders, llmSiteSettings, sites, scopedDatabase, type Database } from '@heopress/database';
import { createRuntime, outboundFetch, parseTrustedEndpoints } from '@heopress/runtime/node';
import { connectDbFixtures, connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { LlmGateway, LlmGatewayError } from '../services/llm/gateway';
import { LlmProviderService } from '../services/llm/provider-service';
import { LlmUsageService } from '../services/llm/usage-service';
import { ModelCallGovernor } from '../services/llm/governance';
import { TranslationServiceRouter } from '../services/llm/translation-router';
import { TranslationError } from '../services/llm/translation-service';

const SITE = 'site_v14_dual_model';
const KEK = Buffer.alloc(32, 7).toString('base64');
const ENV = { HEOPRESS_ENV: 'development', HEOPRESS_VERSION: '1.4.0', LLM_PRICE_CURRENCY: 'USD' } as Record<string, unknown>;

const SEGMENTS = [
  { id: 's1', text: 'Hello ⟦P0⟧' },
  { id: 's2', text: 'World 2024' },
];
const DRAFT_OK = JSON.stringify({
  segments: [
    { id: 's1', target: '你好 ⟦P0⟧' },
    { id: 's2', target: '世界 2024' },
  ],
});
const REVIEW_OK = JSON.stringify({
  segments: [
    { id: 's1', verdict: 'ok' },
    { id: 's2', verdict: 'ok' },
  ],
});

interface Reply {
  status: number;
  body: unknown;
}
const replies: Record<string, () => Reply> = {};
const hits: string[] = [];
let server: Server;
let origin = '';

const CHAT = (content: string, prompt = 40, completion = 10): Reply => ({
  status: 200,
  body: { choices: [{ message: { content } }], usage: { prompt_tokens: prompt, completion_tokens: completion } },
});

describe.skipIf(!hasDbIntegrationUrl)('v1.4 two-model translation — DB integration', () => {
  let db: Database;
  let fixtures: Database;
  let keys: ReturnType<typeof createRuntime>['keys'];

  beforeAll(async () => {
    db = await connectDbIntegration('v14-dual-model');
    fixtures = await connectDbFixtures('v14-dual-model');
    keys = createRuntime({ ...process.env, ENCRYPTION_KEY: KEK, HEOPRESS_ENV: 'development' }).keys;
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      req.resume();
      req.on('end', () => {
        const [, provider = ''] = (req.url ?? '').split('/');
        hits.push(provider);
        const reply = (replies[provider] ?? (() => CHAT(DRAFT_OK)))();
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply.body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    if (fixtures) {
      await fixtures.delete(llmAttempts).where(eq(llmAttempts.siteId, SITE));
      await fixtures.delete(llmCalls).where(eq(llmCalls.siteId, SITE));
      await fixtures.delete(llmSiteSettings).where(eq(llmSiteSettings.siteId, SITE));
      await fixtures.delete(llmProviders).where(eq(llmProviders.siteId, SITE));
      await fixtures.delete(sites).where(inArray(sites.id, [SITE]));
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(async () => {
    await fixtures.delete(llmAttempts).where(eq(llmAttempts.siteId, SITE));
    await fixtures.delete(llmCalls).where(eq(llmCalls.siteId, SITE));
    await fixtures.delete(llmSiteSettings).where(eq(llmSiteSettings.siteId, SITE));
    await fixtures.delete(llmProviders).where(eq(llmProviders.siteId, SITE));
    await fixtures.delete(sites).where(inArray(sites.id, [SITE]));
    await fixtures.insert(sites).values({ id: SITE, name: SITE });
    hits.length = 0;
    for (const key of Object.keys(replies)) delete replies[key];
    replies.draft = () => CHAT(DRAFT_OK, 40, 10);
    replies.review = () => CHAT(REVIEW_OK, 50, 5);
  });

  const trustedFetch = (url: string, init: RequestInit) =>
    outboundFetch(url, { ...init, purpose: 'service', trusted: parseTrustedEndpoints(origin) });
  const gateway = () =>
    new LlmGateway({
      db,
      keys,
      env: ENV,
      fetch: trustedFetch,
      governor: new ModelCallGovernor({ ratePerMinute: 0, breakerFailures: 1000, breakerCooldownMs: 60_000 }),
    });
  const providers = () => new LlmProviderService({ db: scopedDatabase(db, { site: SITE }), siteId: SITE, keys, instanceCurrency: 'USD' });
  const router = () => new TranslationServiceRouter({ db: scopedDatabase(db, { site: SITE }), gateway: gateway(), env: ENV });
  const translate = (over: Record<string, unknown> = {}) =>
    router().translate({ siteId: SITE, sourceLocale: 'en', targetLocale: 'zh-CN', segments: SEGMENTS, ...over });
  const attempts = () => fixtures.select().from(llmAttempts).where(eq(llmAttempts.siteId, SITE)).orderBy(llmAttempts.seq);
  const calls = () => fixtures.select().from(llmCalls).where(eq(llmCalls.siteId, SITE));
  const codeOf = (promise: Promise<unknown>) => promise.then(() => 'resolved', (err: unknown) => (err instanceof Error && 'code' in err ? String((err as { code: unknown }).code) : String(err)));

  /** Two providers on the mock — the drafting one and the reviewing one — and the site's settings. */
  async function setup(options: { budget?: number | null } = {}) {
    const service = providers();
    const draft = await service.create({
      kind: 'openai_compatible',
      name: 'Draft',
      baseUrl: `${origin}/draft`,
      model: 'draft-model',
      apiKey: 'sk-draft',
      capabilities: { tools: true, json: true, maxContext: null },
      pricing: { kind: 'per_1m_tokens', inputMicros: 1_000_000, outputMicros: 2_000_000 },
      currency: 'USD',
      timeoutMs: 2000,
    });
    const review = await service.create({
      kind: 'openai_compatible',
      name: 'Review',
      baseUrl: `${origin}/review`,
      model: 'review-model',
      apiKey: 'sk-review',
      capabilities: { tools: true, json: true, maxContext: null },
      pricing: { kind: 'per_1m_tokens', inputMicros: 3_000_000, outputMicros: 4_000_000 },
      currency: 'USD',
      timeoutMs: 2000,
    });
    await service.updateSettings({
      currency: 'USD',
      monthlyBudgetMicros: options.budget ?? null,
      budgetTimezone: 'UTC',
      translationService: 'heopress:dual-model',
      translationDraftProviderId: draft.id,
      translationReviewProviderId: review.id,
    });
    return { service, draft, review };
  }

  it('two calls are ledgered and priced separately by their own bindings', async () => {
    await setup();
    const out = await translate();

    expect(out).toMatchObject({
      engine: 'heopress:dual-model',
      provider: 'Draft',
      model: 'draft-model',
      segments: [
        { id: 's1', text: '你好 ⟦P0⟧' },
        { id: 's2', text: '世界 2024' },
      ],
      verification: {
        draft: { provider: 'Draft', model: 'draft-model', callId: expect.any(String) },
        review: { provider: 'Review', model: 'review-model', callId: expect.any(String), ran: true },
        revisedSegments: 0,
        rejectedSegments: 0,
        segments: [
          { id: 's1', state: 'verified' },
          { id: 's2', state: 'verified' },
        ],
      },
    });
    expect(hits).toEqual(['draft', 'review']);

    const ledgerCalls = await calls();
    expect(ledgerCalls).toHaveLength(2);
    expect(ledgerCalls.every((call) => call.taskType === 'translation' && call.capability === 'translate' && call.status === 'completed')).toBe(true);
    expect(new Set(ledgerCalls.map((call) => call.id)).size).toBe(2);

    const rows = await attempts();
    expect(rows).toHaveLength(2);
    const modelOf = (row: (typeof rows)[number]) => (row.snapshot as { model?: string }).model;
    const draftRow = rows.find((row) => modelOf(row) === 'draft-model')!;
    const reviewRow = rows.find((row) => modelOf(row) === 'review-model')!;
    expect(draftRow).toMatchObject({ billing: 'settled', inputTokens: 40, outputTokens: 10, actualMicros: 40 + 20 });
    expect(reviewRow).toMatchObject({ billing: 'settled', inputTokens: 50, outputTokens: 5, actualMicros: 150 + 20 });
    expect(draftRow.providerId).not.toBe(reviewRow.providerId);
    expect(draftRow.callId).toBe(out.callId);

    const usage = await new LlmUsageService({ db: scopedDatabase(db, { site: SITE }), siteId: SITE, instanceCurrency: 'USD' }).usage();
    expect(usage.committedMicros).toBe(60 + 170);
    expect(usage.byModel.map((row) => [row.model, row.settledMicros])).toEqual([
      ['draft-model', 60],
      ['review-model', 170],
    ]);
  });

  it('refuses the same model twice when saving the settings', async () => {
    const { service, draft, review } = await setup();
    const update = (draftId: string, reviewId: string) =>
      service.updateSettings({
        currency: 'USD',
        monthlyBudgetMicros: null,
        budgetTimezone: 'UTC',
        translationService: 'heopress:dual-model',
        translationDraftProviderId: draftId,
        translationReviewProviderId: reviewId,
      });

    expect(await codeOf(update(draft.id, draft.id))).toBe('DUAL_MODEL_SAME_MODEL');

    // A second row with the same protocol, base URL and model is the same model, not a different binding.
    const duplicate = await service.create({
      kind: 'openai_compatible',
      name: 'Draft copy',
      baseUrl: `${origin}/draft`,
      model: 'draft-model',
      apiKey: 'sk-copy',
      capabilities: { tools: true, json: true, maxContext: null },
      pricing: { kind: 'per_1m_tokens', inputMicros: 1_000_000, outputMicros: 2_000_000 },
      currency: 'USD',
    });
    expect(await codeOf(update(duplicate.id, draft.id))).toBe('DUAL_MODEL_SAME_MODEL');
    // Two different bindings with different models are accepted.
    expect(await codeOf(update(draft.id, review.id))).toBe('resolved');
  });

  it('refuses the service without both bindings, and reads both back', async () => {
    const { service, draft } = await setup();
    expect(await codeOf(
      service.updateSettings({
        currency: 'USD',
        monthlyBudgetMicros: null,
        budgetTimezone: 'UTC',
        translationService: 'heopress:dual-model',
        translationDraftProviderId: draft.id,
        translationReviewProviderId: null,
      }),
    )).toBe('DUAL_MODEL_NOT_CONFIGURED');

    const settings = await service.settings();
    expect(settings.translationDraftProviderId).toBe(draft.id);
    expect(settings.translationReviewProviderId).toEqual(expect.any(String));
  });

  it('a budget exhausted before the draft pays no provider', async () => {
    await setup({ budget: 0 });
    expect(await codeOf(translate())).toBe('BUDGET_EXCEEDED');
    expect(hits).toEqual([]);
    expect(await attempts()).toEqual([]);
    const ledgerCalls = await calls();
    expect(ledgerCalls).toHaveLength(1);
    expect(ledgerCalls[0]!.status).toBe('failed');
  });

  it('a reviewer failure keeps the drafted text and marks it unverified', async () => {
    await setup();
    replies.review = () => CHAT('not the agreed JSON', 50, 5);
    const out = await translate();

    expect(out.segments.map((segment) => segment.text)).toEqual(['你好 ⟦P0⟧', '世界 2024']);
    expect(out.verification).toMatchObject({
      review: { provider: 'Review', model: 'review-model', callId: expect.any(String), ran: false, failure: 'BAD_REVIEW' },
      segments: [
        { id: 's1', state: 'unverified' },
        { id: 's2', state: 'unverified' },
      ],
    });
    expect(await attempts()).toHaveLength(2);
  });

  it('a revision that breaks a placeholder is rejected; the draft is kept', async () => {
    await setup();
    replies.review = () =>
      CHAT(JSON.stringify({ segments: [{ id: 's1', verdict: 'revise', revised: '你好' }, { id: 's2', verdict: 'ok' }] }), 50, 5);
    const out = await translate();

    expect(out.segments).toEqual([
      { id: 's1', text: '你好 ⟦P0⟧' },
      { id: 's2', text: '世界 2024' },
    ]);
    expect(out.verification).toMatchObject({
      revisedSegments: 0,
      rejectedSegments: 1,
      segments: [
        { id: 's1', state: 'rejected_verification', findings: expect.arrayContaining(['placeholder_missing']) },
        { id: 's2', state: 'verified' },
      ],
    });
  });

  it('accepts a revision that passes the gates', async () => {
    await setup();
    replies.review = () =>
      CHAT(JSON.stringify({ segments: [{ id: 's1', verdict: 'revise', revised: '您好 ⟦P0⟧', reason: 'more formal' }, { id: 's2', verdict: 'ok' }] }), 50, 5);
    const out = await translate();

    expect(out.segments[0]).toEqual({ id: 's1', text: '您好 ⟦P0⟧' });
    expect(out.verification).toMatchObject({
      revisedSegments: 1,
      rejectedSegments: 0,
      segments: [{ id: 's1', state: 'revised', reason: 'more formal' }, { id: 's2', state: 'verified' }],
    });
  });

  it('a disabled reviewing binding is a stale selection, not a silent single-model translation', async () => {
    const { service, review } = await setup();
    await service.update(review.id, { disabled: true });
    expect(await codeOf(translate())).toBe('SERVICE_UNAVAILABLE');
    expect(await calls()).toHaveLength(1); // only the draft call exists; no review call was made
    expect(await attempts()).toHaveLength(1);
  });

  it('a missing reviewing binding is refused at save time, leaving the selection usable', async () => {
    const { service } = await setup();
    expect(await codeOf(
      service.updateSettings({
        currency: 'USD',
        monthlyBudgetMicros: null,
        budgetTimezone: 'UTC',
        translationService: 'heopress:dual-model',
        translationDraftProviderId: null,
        translationReviewProviderId: null,
      }),
    )).toBe('DUAL_MODEL_NOT_CONFIGURED');
    const settings = await service.settings();
    expect(settings.translationService).toBe('heopress:dual-model');
    expect(settings.translationDraftProviderId).not.toBeNull();
  });

  it('a draft that is not exactly the requested segments fails without a review call', async () => {
    await setup();
    replies.draft = () => CHAT(JSON.stringify({ segments: [{ id: 's1', target: '你好 ⟦P0⟧' }] }));
    await expect(translate()).rejects.toBeInstanceOf(TranslationError);
    expect(hits).toEqual(['draft']);
    expect(await calls()).toHaveLength(1);
  });

  it('an unconfigured selection fails with SERVICE_UNAVAILABLE and no provider call', async () => {
    await fixtures.insert(llmSiteSettings).values({ siteId: SITE, currency: 'USD', budgetTimezone: 'UTC', translationService: 'heopress:dual-model' });
    expect(await codeOf(translate())).toBe('SERVICE_UNAVAILABLE');
    expect(hits).toEqual([]);
    expect(await calls()).toEqual([]);
  });

  it('a ledger failure is a gateway error, never silently settled', async () => {
    await setup({ budget: 0 });
    const err = await translate().catch((error: unknown) => error);
    expect(err).toBeInstanceOf(LlmGatewayError);
    expect((err as LlmGatewayError).code).toBe('BUDGET_EXCEEDED');
  });
});
