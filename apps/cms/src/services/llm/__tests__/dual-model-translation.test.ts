/**
 * The built-in two-model translation service (HeoPress v1.4, spec ai/dual-model-translation), with stubbed providers:
 * deterministic draft/verify/revise behavior, wholesale refusal of a malformed draft, a reviewer failure that keeps the
 * draft, and a revision that must pass the same mechanical gates as the draft.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ChatCallInput, ChatCallResult } from '../gateway';
import { LlmGatewayError } from '../gateway-error';
import { LlmDeferredError } from '../governance';
import { DualModelTranslationService, applyReview, type DualModelSettingsReader } from '../dual-model-translation';
import { TranslationError, type TranslationRequest } from '../translation-service';

interface RecordedCall {
  providerId: string;
  input: ChatCallInput;
}

/** A gateway that answers each provider id with the given content (or throws the given error). */
function stubGateway(answers: Record<string, string | Error>): {
  calls: RecordedCall[];
  chatWithProvider: (providerId: string, input: ChatCallInput) => Promise<ChatCallResult>;
} {
  const calls: RecordedCall[] = [];
  return {
    calls,
    chatWithProvider: vi.fn(async (providerId: string, input: ChatCallInput) => {
      calls.push({ providerId, input });
      const answer = answers[providerId];
      if (answer instanceof Error) throw answer;
      return {
        response: { content: answer ?? '', toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 } },
        provider: `provider-${providerId}`,
        model: `model-${providerId}`,
        callId: `call-${providerId}`,
        attemptIds: [`attempt-${providerId}`],
      };
    }),
  };
}

const settings: DualModelSettingsReader = async () => ({ draftProviderId: 'p_draft', reviewProviderId: 'p_review' });

const request = (over: Partial<TranslationRequest> = {}): TranslationRequest => ({
  siteId: 'site_a',
  sourceLocale: 'en',
  targetLocale: 'zh-CN',
  segments: [
    { id: 's1', text: 'Hello ⟦P0⟧' },
    { id: 's2', text: 'World 2024' },
  ],
  glossary: [{ source: 'Hello', target: '你好' }],
  ...over,
});

const draftAnswer = (over: { s1?: string; s2?: string; order?: string[] } = {}) => {
  const byId: Record<string, string> = { s1: over.s1 ?? '你好 ⟦P0⟧', s2: over.s2 ?? '世界 2024' };
  const order = over.order ?? ['s1', 's2'];
  return JSON.stringify({ segments: order.map((id) => ({ id, target: byId[id] })) });
};
const reviewAnswer = (over: Partial<Record<'s1' | 's2', { verdict: 'ok' | 'revise'; revised?: string; reason?: string }>> = {}) =>
  JSON.stringify({
    segments: [
      { id: 's1', ...(over.s1 ?? { verdict: 'ok' }) },
      { id: 's2', ...(over.s2 ?? { verdict: 'ok' }) },
    ],
  });

const service = (answers: Record<string, string | Error>) => {
  const gateway = stubGateway(answers);
  return { gateway, svc: new DualModelTranslationService({ gateway, settings }) };
};

describe('the built-in two-model translation service', () => {
  it('sends the draft to the drafting binding with the strict JSON contract and the glossary/memory constraints', async () => {
    const { gateway, svc } = service({ p_draft: draftAnswer(), p_review: reviewAnswer() });
    await svc.translate(request({ memory: [{ source: 'Hello', target: '你好' }] }));

    expect(gateway.calls).toHaveLength(2);
    const draft = gateway.calls[0]!;
    expect(draft.providerId).toBe('p_draft');
    expect(draft.input).toMatchObject({ siteId: 'site_a', taskType: 'translation', capability: 'translate', tools: false });
    expect(draft.input.systemPrompt).toContain('JSON only');
    expect(draft.input.systemPrompt).toContain('"target"');
    expect(draft.input.systemPrompt).toContain('glossary');
    const payload = JSON.parse(String(draft.input.messages[0]!.content)) as Record<string, unknown>;
    expect(payload).toMatchObject({
      sourceLocale: 'en',
      targetLocale: 'zh-CN',
      glossary: [{ source: 'Hello', target: '你好' }],
      memory: [{ source: 'Hello', target: '你好' }],
      segments: [
        { id: 's1', text: 'Hello ⟦P0⟧' },
        { id: 's2', text: 'World 2024' },
      ],
    });
    // The review gets the source, the draft and the gate findings of the offending segments.
    const review = gateway.calls[1]!;
    expect(review.providerId).toBe('p_review');
    const reviewPayload = JSON.parse(String(review.input.messages[0]!.content)) as Record<string, unknown>;
    expect(reviewPayload.segments).toEqual([
      { id: 's1', source: 'Hello ⟦P0⟧', draft: '你好 ⟦P0⟧' },
      { id: 's2', source: 'World 2024', draft: '世界 2024' },
    ]);
    expect(reviewPayload.findings).toEqual([]);
  });

  it('returns the drafted text with the drafting binding and both call ids', async () => {
    const { svc } = service({ p_draft: draftAnswer(), p_review: reviewAnswer() });
    const out = await svc.translate(request());
    expect(out).toMatchObject({
      engine: 'heopress:dual-model',
      provider: 'provider-p_draft',
      model: 'model-p_draft',
      callId: 'call-p_draft',
      segments: [
        { id: 's1', text: '你好 ⟦P0⟧' },
        { id: 's2', text: '世界 2024' },
      ],
      verification: {
        draft: { provider: 'provider-p_draft', model: 'model-p_draft', callId: 'call-p_draft' },
        review: { provider: 'provider-p_review', model: 'model-p_review', callId: 'call-p_review', ran: true },
        revisedSegments: 0,
        rejectedSegments: 0,
        segments: [
          { id: 's1', state: 'verified', findings: [] },
          { id: 's2', state: 'verified', findings: [] },
        ],
      },
    });
  });

  it('is deterministic: the same inputs produce the same result', async () => {
    const first = await service({ p_draft: draftAnswer(), p_review: reviewAnswer() }).svc.translate(request());
    const second = await service({ p_draft: draftAnswer(), p_review: reviewAnswer() }).svc.translate(request());
    expect(second).toEqual(first);
  });

  it('refuses a draft that does not cover exactly the requested ids, in order, without paying for a review', async () => {
    const missing = service({ p_draft: JSON.stringify({ segments: [{ id: 's1', target: '你好 ⟦P0⟧' }] }), p_review: reviewAnswer() });
    await expect(missing.svc.translate(request())).rejects.toMatchObject({ name: 'TranslationError', code: 'BAD_TRANSLATION' });
    expect(missing.gateway.calls).toHaveLength(1);

    const reordered = service({ p_draft: draftAnswer({ order: ['s2', 's1'] }), p_review: reviewAnswer() });
    await expect(reordered.svc.translate(request())).rejects.toMatchObject({ code: 'BAD_TRANSLATION' });
    expect(reordered.gateway.calls).toHaveLength(1);

    const notJson = service({ p_draft: 'sure, here you go', p_review: reviewAnswer() });
    await expect(notJson.svc.translate(request())).rejects.toMatchObject({ code: 'BAD_TRANSLATION' });
    expect(notJson.gateway.calls).toHaveLength(1);
  });

  it('sends the gate findings of a defective draft to the reviewer, and does not accept it as verified', async () => {
    const { gateway, svc } = service({ p_draft: draftAnswer({ s1: '你好' }), p_review: reviewAnswer() });
    const out = await svc.translate(request());
    const reviewPayload = JSON.parse(String(gateway.calls[1]!.input.messages[0]!.content)) as { findings: unknown };
    expect(reviewPayload.findings).toEqual([{ id: 's1', codes: ['placeholder_missing'], detail: '⟦P0⟧' }]);
    expect(out.verification!.segments[0]).toMatchObject({ id: 's1', state: 'unverified', findings: ['placeholder_missing'] });
    expect(out.segments[0]!.text).toBe('你好');
  });

  it('accepts a revision only when it passes the same mechanical gates', async () => {
    const accepted = service({
      p_draft: draftAnswer({ s1: '你好' }),
      p_review: reviewAnswer({ s1: { verdict: 'revise', revised: '你好 ⟦P0⟧', reason: 'placeholder lost' } }),
    });
    const out = await accepted.svc.translate(request());
    expect(out.segments[0]).toEqual({ id: 's1', text: '你好 ⟦P0⟧' });
    expect(out.verification).toMatchObject({
      revisedSegments: 1,
      rejectedSegments: 0,
      segments: [{ id: 's1', state: 'revised', findings: ['placeholder_missing'], reason: 'placeholder lost' }, { id: 's2', state: 'verified' }],
    });

    const rejected = service({
      p_draft: draftAnswer({ s1: '你好' }),
      p_review: reviewAnswer({ s1: { verdict: 'revise', revised: '您好', reason: 'still no placeholder' } }),
    });
    const kept = await rejected.svc.translate(request());
    // The draft is kept, and the revision is marked as rejected verification.
    expect(kept.segments[0]).toEqual({ id: 's1', text: '你好' });
    expect(kept.verification).toMatchObject({
      revisedSegments: 0,
      rejectedSegments: 1,
      segments: [{ id: 's1', state: 'rejected_verification', findings: ['placeholder_missing', 'glossary_missing'] }, { id: 's2', state: 'verified' }],
    });
  });

  it('keeps the draft when the reviewer fails, and says the review did not run', async () => {
    const failed = service({ p_draft: draftAnswer(), p_review: new LlmGatewayError('NETWORK', 'connection reset') });
    const out = await failed.svc.translate(request());
    expect(out.segments.map((s) => s.text)).toEqual(['你好 ⟦P0⟧', '世界 2024']);
    expect(out.verification).toMatchObject({
      review: { provider: null, model: null, callId: null, ran: false, failure: 'NETWORK' },
      segments: [
        { id: 's1', state: 'unverified' },
        { id: 's2', state: 'unverified' },
      ],
    });
  });

  it('keeps the draft when the reviewer answers with something unusable, but records the review call', async () => {
    const { svc } = service({ p_draft: draftAnswer(), p_review: '{"segments":[]}' });
    const out = await svc.translate(request());
    expect(out.segments.map((s) => s.text)).toEqual(['你好 ⟦P0⟧', '世界 2024']);
    expect(out.verification).toMatchObject({
      review: { provider: 'provider-p_review', model: 'model-p_review', callId: 'call-p_review', ran: false, failure: 'BAD_REVIEW' },
    });
    expect(out.verification!.segments.every((s) => s.state === 'unverified')).toBe(true);
  });

  it('propagates a deferral or a cancellation during review instead of swallowing it', async () => {
    const deferred = service({ p_draft: draftAnswer(), p_review: new LlmDeferredError('DAILY_BUDGET_EXHAUSTED', new Date('2026-11-13T00:00:00Z')) });
    await expect(deferred.svc.translate(request())).rejects.toBeInstanceOf(LlmDeferredError);

    const controller = new AbortController();
    controller.abort();
    const cancelled = service({ p_draft: draftAnswer(), p_review: new LlmGatewayError('CANCELLED', 'cancelled') });
    await expect(cancelled.svc.translate(request({ signal: controller.signal }))).rejects.toBeInstanceOf(LlmGatewayError);
  });

  it('refuses an empty request, a same-locale request and an unconfigured service before any call', async () => {
    const { gateway, svc } = service({ p_draft: draftAnswer(), p_review: reviewAnswer() });
    await expect(svc.translate(request({ segments: [] }))).rejects.toMatchObject({ code: 'EMPTY_REQUEST' });
    await expect(svc.translate(request({ targetLocale: 'en' }))).rejects.toMatchObject({ code: 'BAD_TRANSLATION' });
    const unconfigured = new DualModelTranslationService({ gateway, settings: async () => null });
    await expect(unconfigured.translate(request())).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect(gateway.calls).toHaveLength(0);
  });

  it('distinguishes the two calls with persistent identities when a call key is given', async () => {
    const { gateway, svc } = service({ p_draft: draftAnswer(), p_review: reviewAnswer() });
    await svc.translate(request({ callKey: 'run:r1:step:1' }));
    expect(gateway.calls.map((c) => c.input.callKey)).toEqual(['run:r1:step:1:draft', 'run:r1:step:1:review']);
  });
});

describe('applyReview', () => {
  const source = [
    { id: 's1', text: 'Hello ⟦P0⟧' },
    { id: 's2', text: 'World 2024' },
  ];

  it('marks every segment unverified when the review produced no verdicts', () => {
    const out = applyReview({
      source,
      draft: [{ id: 's1', target: '你好 ⟦P0⟧' }, { id: 's2', target: '世界 2024' }],
      verdicts: null,
      sourceLocale: 'en',
      targetLocale: 'zh-CN',
    });
    expect(out.states.map((s) => s.state)).toEqual(['unverified', 'unverified']);
  });

  it('counts revisions and rejected revisions consistently with the states', () => {
    const out = applyReview({
      source,
      draft: [{ id: 's1', target: '你好' }, { id: 's2', target: '世界 2024' }],
      verdicts: [
        { id: 's1', verdict: 'revise', revised: '您好 ⟦P0⟧' },
        { id: 's2', verdict: 'revise', revised: '世界 2025' },
      ],
      sourceLocale: 'en',
      targetLocale: 'zh-CN',
    });
    expect(out.revisedSegments).toBe(1);
    expect(out.rejectedSegments).toBe(1);
    expect(out.states.map((s) => s.state)).toEqual(['revised', 'rejected_verification']);
  });
});
