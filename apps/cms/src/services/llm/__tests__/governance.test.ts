import { describe, expect, it } from 'vitest';
import { LlmDeferredError, ModelCallGovernor, afterTaskFailure, isServiceFailure, type TaskRetryState } from '../governance';
import { addDays, dayOf, dayStart, nextDayStart, planQuota } from '../daily';
import { LlmTranslationService, TranslationError, type TranslationService } from '../translation-service';
import type { ChatOutcome } from '../openai-compatible';

/** Model-call governance and daily limits (HeoPress P09 tasks 4.5, 4.6), with fixed outcomes and a fixed clock. */

const usage = { complete: false, inputTokens: null, outputTokens: null };
const http = (status: number): ChatOutcome => ({ kind: 'http', status, errorCode: `HTTP_${status}`, usage, retryAfterMs: null });
const OK: ChatOutcome = { kind: 'ok', content: 'x', toolCalls: [], usage };

describe('circuit breaker', () => {
  const make = (failures = 3) => {
    let now = 1_000_000;
    const g = new ModelCallGovernor({ ratePerMinute: 0, breakerFailures: failures, breakerCooldownMs: 30_000 }, () => now);
    return { g, advance: (ms: number) => (now += ms), now: () => now };
  };

  it('only network errors, timeouts, 429 and 5xx are service failures', () => {
    expect([http(503), http(500), http(429), { kind: 'network' } as ChatOutcome, { kind: 'timeout' } as ChatOutcome].every(isServiceFailure)).toBe(true);
    expect([http(400), http(401), http(422), { kind: 'bad_response', status: 200, usage } as ChatOutcome, { kind: 'cancelled' } as ChatOutcome].some(isServiceFailure)).toBe(false);
  });

  it('503 in a row opens it at the threshold; it reopens after a failed half-open trial and closes after a good one', () => {
    const { g, advance } = make(3);
    for (let i = 0; i < 3; i++) {
      expect(g.take('s').ok).toBe(true);
      g.record('s', http(503));
    }
    expect(g.take('s')).toMatchObject({ ok: false, code: 'BREAKER_OPEN' });
    advance(30_000);
    expect(g.take('s').ok).toBe(true); // the trial
    expect(g.take('s')).toMatchObject({ ok: false, code: 'BREAKER_OPEN' }); // one trial at a time
    g.record('s', http(503));
    expect(g.snapshot('s').open).toBe(true);
    advance(30_000);
    expect(g.take('s').ok).toBe(true);
    g.record('s', OK);
    expect(g.snapshot('s')).toMatchObject({ open: false, failures: 0 });
  });

  it('400 never counts, however many', () => {
    const { g } = make(2);
    for (let i = 0; i < 10; i++) {
      g.take('s');
      g.record('s', http(400));
    }
    expect(g.snapshot('s')).toMatchObject({ open: false, failures: 0 });
  });

  it('services are independent', () => {
    const { g } = make(1);
    g.take('a');
    g.record('a', http(502));
    expect(g.take('a').ok).toBe(false);
    expect(g.take('b').ok).toBe(true);
  });
});

describe('rate limit', () => {
  it('allows N per sliding minute and says when the next slot frees', () => {
    let now = 0;
    const g = new ModelCallGovernor({ ratePerMinute: 2, breakerFailures: 5, breakerCooldownMs: 1000 }, () => now);
    expect(g.take('s').ok).toBe(true);
    now = 10_000;
    expect(g.take('s').ok).toBe(true);
    expect(g.take('s')).toEqual({ ok: false, code: 'RATE_LIMITED', retryAt: 60_000 });
    now = 60_001;
    expect(g.take('s').ok).toBe(true);
  });
});

describe('retry accounting', () => {
  const state: TaskRetryState = { attempts: 1, maxAttempts: 3, notBefore: null };
  const now = new Date('2026-10-26T00:00:00Z');

  it('a rate-limit, breaker or daily-budget deferral reschedules without spending a retry', () => {
    for (const code of ['RATE_LIMITED', 'BREAKER_OPEN', 'DAILY_BUDGET_EXHAUSTED'] as const) {
      const retryAt = new Date('2026-10-26T01:00:00Z');
      const out = afterTaskFailure(state, new LlmDeferredError(code, retryAt), now);
      expect(out).toEqual({ action: 'reschedule', deferred: true, state: { attempts: 1, maxAttempts: 3, notBefore: retryAt } });
    }
  });

  it('a business failure spends one, and the last one fails the task', () => {
    expect(afterTaskFailure(state, new Error('bad'), now).state.attempts).toBe(2);
    expect(afterTaskFailure({ ...state, attempts: 2 }, new Error('bad'), now).action).toBe('fail');
  });

  it('a long outage never exhausts the retries', () => {
    let s = state;
    for (let i = 0; i < 100; i++) s = afterTaskFailure(s, new LlmDeferredError('BREAKER_OPEN', now), now).state;
    expect(s.attempts).toBe(1);
  });
});

describe('local days', () => {
  it('the next day starts at the site midnight', () => {
    expect(nextDayStart(new Date('2026-10-26T15:59:00Z'), 'Asia/Shanghai').toISOString()).toBe('2026-10-26T16:00:00.000Z');
    expect(nextDayStart(new Date('2026-10-26T16:00:00Z'), 'Asia/Shanghai').toISOString()).toBe('2026-10-27T16:00:00.000Z');
    expect(dayOf(new Date('2026-10-26T16:00:00Z'), 'Asia/Shanghai')).toBe('2026-10-27');
  });

  it('across DST: New York days of 23 and 25 hours', () => {
    // 2026-03-08 springs forward, 2026-11-01 falls back.
    expect(nextDayStart(new Date('2026-03-08T12:00:00Z'), 'America/New_York').toISOString()).toBe('2026-03-09T04:00:00.000Z');
    expect(dayStart(new Date('2026-03-08T12:00:00Z'), 'America/New_York').toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(nextDayStart(new Date('2026-11-01T12:00:00Z'), 'America/New_York').toISOString()).toBe('2026-11-02T05:00:00.000Z');
    expect(dayStart(new Date('2026-11-01T12:00:00Z'), 'America/New_York').toISOString()).toBe('2026-11-01T04:00:00.000Z');
    expect(dayStart(new Date('2026-11-02T04:30:00Z'), 'America/New_York').toISOString()).toBe('2026-11-01T04:00:00.000Z');
  });

  it('adds calendar days', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
});

describe('daily processing quota plan', () => {
  const items = Array.from({ length: 25 }, (_, i) => ({ id: `d${String(i).padStart(2, '0')}`, priority: i % 3, eligibleAt: new Date(i * 1000) }));

  it('25 eligible with a limit of 10: 10 today, 10 tomorrow, 5 the day after, by priority', () => {
    const plan = planQuota(items, 10, 0, '2026-10-26');
    expect(plan.admitted).toHaveLength(10);
    const prio = (id: string) => items.find((i) => i.id === id)!.priority;
    expect(plan.admitted.every((id) => prio(id) === 2) || plan.admitted.every((id) => prio(id) >= 1)).toBe(true);
    const order = [...plan.admitted, ...plan.deferred.map((d) => d.id)].map(prio);
    expect(order).toEqual([...order].sort((a, b) => b - a));
    expect(plan.deferred.map((d) => d.day)).toEqual([...Array(10).fill('2026-10-27'), ...Array(5).fill('2026-10-28')]);
  });

  it('counts what today already admitted; no limit admits all', () => {
    expect(planQuota(items, 10, 7, '2026-10-26').admitted).toHaveLength(3);
    expect(planQuota(items, null, 0, '2026-10-26').admitted).toHaveLength(25);
  });
});

describe('LLM translation service', () => {
  const gateway = (content: string) => ({
    chat: async () => ({ response: { content, toolCalls: [] }, provider: 'P', model: 'm', callId: 'c1', attemptIds: ['a1'] }),
  });
  const req = { siteId: 's', sourceLocale: 'en', targetLocale: 'zh-CN', segments: [{ id: 'a', text: 'Run `npm i`' }, { id: 'b', text: 'Bye' }] };

  it('returns the segments in the requested order', async () => {
    const svc: TranslationService = new LlmTranslationService(gateway(JSON.stringify({ segments: [{ id: 'b', text: '再见' }, { id: 'a', text: '运行 `npm i`' }] })));
    const out = await svc.translate(req);
    expect(out).toMatchObject({ engine: 'llm', callId: 'c1', segments: [{ id: 'a', text: '运行 `npm i`' }, { id: 'b', text: '再见' }] });
  });

  it('refuses an answer that is not exactly the requested segments', async () => {
    await expect(new LlmTranslationService(gateway('{"segments":[{"id":"a","text":"x"}]}')).translate(req)).rejects.toBeInstanceOf(TranslationError);
    await expect(new LlmTranslationService(gateway('not json')).translate(req)).rejects.toBeInstanceOf(TranslationError);
  });
});
