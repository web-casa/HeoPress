import { describe, expect, it } from 'vitest';
import { LlmDeferredError } from '../llm/governance';
import { LlmGatewayError } from '../llm/gateway-error';
import { TranslationError } from '../llm/translation-service';
import {
  TRANSLATION_JOB_BACKOFF_BASE_MS,
  TRANSLATION_JOB_BACKOFF_MAX_MS,
  decideTranslationJobFailure,
  translationJobBackoffMs,
  translationJobErrorCode,
} from '../translation-job-policy';

/**
 * The retry policy table (HeoPress v1.4, spec `ai/translation-jobs`; design decision 5). This suite is the
 * specification of the three classes and of the attempt counter: a deferral must never spend a business retry, a
 * transient failure must, a permanent failure must stop at once.
 */

const NOW = new Date('2026-11-13T00:00:00.000Z');
const state = (attempts: number, maxAttempts = 3) => ({ attempts, maxAttempts });

describe('translation job retry policy', () => {
  describe('deferred: no business retry, the gateway’s own retry-after', () => {
    for (const code of ['RATE_LIMITED', 'BREAKER_OPEN', 'DAILY_BUDGET_EXHAUSTED'] as const) {
      it(`${code} requeues at retryAt with the attempt count unchanged`, () => {
        const retryAt = new Date(NOW.getTime() + 90_000);
        const decision = decideTranslationJobFailure(state(2), new LlmDeferredError(code, retryAt), NOW);
        expect(decision).toEqual({
          failureClass: 'deferred',
          code,
          attempts: 2,
          action: 'requeue',
          nextAttemptAt: retryAt,
        });
      });
    }

    it('a hundred deferrals never spend a retry', () => {
      let attempts = 0;
      for (let i = 0; i < 100; i++) {
        const decision = decideTranslationJobFailure(state(attempts), new LlmDeferredError('RATE_LIMITED', NOW), NOW);
        attempts = decision.attempts;
        expect(decision.action).toBe('requeue');
      }
      expect(attempts).toBe(0);
    });
  });

  describe('transient: one business retry, exponential backoff', () => {
    it('spends one attempt and waits one minute after the first failure', () => {
      const decision = decideTranslationJobFailure(state(0), new LlmGatewayError('HTTP_500', 'provider exploded'), NOW);
      expect(decision).toMatchObject({ failureClass: 'transient', code: 'HTTP_500', attempts: 1, action: 'requeue' });
      expect(decision.nextAttemptAt?.toISOString()).toBe('2026-11-13T00:01:00.000Z');
    });

    it('doubles the wait each time and caps it at thirty minutes', () => {
      expect([1, 2, 3, 4, 10].map(translationJobBackoffMs)).toEqual([
        TRANSLATION_JOB_BACKOFF_BASE_MS,
        120_000,
        240_000,
        480_000,
        TRANSLATION_JOB_BACKOFF_MAX_MS,
      ]);
    });

    it('ends the job when the last attempt fails, keeping the count it reached', () => {
      const decision = decideTranslationJobFailure(state(2), new LlmGatewayError('CHAIN_EXHAUSTED', 'all down'), NOW);
      expect(decision).toMatchObject({ failureClass: 'transient', code: 'CHAIN_EXHAUSTED', attempts: 3, action: 'fail' });
      expect(decision.nextAttemptAt).toBeNull();
    });

    it('treats an unknown error as transient and records a safe code', () => {
      const decision = decideTranslationJobFailure(state(0), new Error('sk-live-secret-leaked-into-message'), NOW);
      expect(decision).toMatchObject({ failureClass: 'transient', code: 'INTERNAL', action: 'requeue' });
    });

    it('a malformed maxAttempts still allows one attempt', () => {
      const decision = decideTranslationJobFailure({ attempts: 0, maxAttempts: 0 }, new Error('boom'), NOW);
      expect(decision.action).toBe('fail');
      expect(decision.attempts).toBe(1);
    });
  });

  describe('permanent: stop at once, no retry spent', () => {
    const permanent: Array<[string, unknown]> = [
      ['BAD_TRANSLATION', new TranslationError('BAD_TRANSLATION', 'the answer was not the requested segments')],
      ['SERVICE_UNAVAILABLE', new TranslationError('SERVICE_UNAVAILABLE', 'the selected service is not offered')],
      ['EMPTY_REQUEST', new TranslationError('EMPTY_REQUEST', 'nothing to translate')],
      ['LLM_NOT_CONFIGURED', new LlmGatewayError('LLM_NOT_CONFIGURED', 'no model')],
      ['BUDGET_EXCEEDED', new LlmGatewayError('BUDGET_EXCEEDED', 'month used up')],
      ['CAPABILITY_UNSUPPORTED', new LlmGatewayError('CAPABILITY_UNSUPPORTED', 'no tools')],
      ['PROVIDER_DISABLED', new LlmGatewayError('PROVIDER_DISABLED', 'disabled')],
      ['NOT_FOUND', new LlmGatewayError('NOT_FOUND', 'gone')],
      ['PROVIDER_UNAVAILABLE', new LlmGatewayError('PROVIDER_UNAVAILABLE', 'all disabled')],
      ['PRICE_NOT_CONFIGURED', new LlmGatewayError('PRICE_NOT_CONFIGURED', 'no price')],
    ];

    for (const [code, err] of permanent) {
      it(`${code} fails immediately with attempts unchanged`, () => {
        const decision = decideTranslationJobFailure(state(1), err, NOW);
        expect(decision).toEqual({
          failureClass: 'permanent',
          code,
          attempts: 1,
          action: 'fail',
          nextAttemptAt: null,
        });
      });
    }

    it('a caller cancellation is not retried', () => {
      const aborted = Object.assign(new Error('aborted'), { name: 'AbortError' });
      expect(decideTranslationJobFailure(state(0), aborted, NOW)).toMatchObject({
        failureClass: 'permanent',
        code: 'CANCELLED',
        action: 'fail',
      });
    });
  });

  it('the error code is a code, never the provider’s message', () => {
    expect(translationJobErrorCode(new Error('token=sk-abc123 provider said no'))).toBe('INTERNAL');
    expect(translationJobErrorCode(new LlmDeferredError('RATE_LIMITED', NOW))).toBe('RATE_LIMITED');
    expect(translationJobErrorCode(new LlmGatewayError('HTTP_503', 'busy'))).toBe('HTTP_503');
    expect(translationJobErrorCode('not even an error')).toBe('INTERNAL');
  });
});
