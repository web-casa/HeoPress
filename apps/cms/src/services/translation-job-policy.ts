import { LlmDeferredError } from './llm/governance';
import { LlmGatewayError } from './llm/gateway-error';
import { TranslationError } from './llm/translation-service';

/**
 * The retry policy of durable translation jobs (HeoPress v1.4, spec `ai/translation-jobs`; design decision 5).
 *
 * Three classes, and only three:
 *
 *   - `deferred`  — the model call may not run now (rate limit, open breaker, daily budget). The gateway already said
 *                   when: the job waits until that `retryAt`, and the task's **business retry budget is untouched**.
 *                   This is the hard rule of spec `ai/cost-control`: a deferral is not a failure of the task.
 *   - `transient` — the attempt failed in a way that may succeed later (provider error, timeout, network, an exhausted
 *                   candidate chain). It spends one business retry; with budget left the job waits out an exponential
 *                   backoff, otherwise it ends `failed`.
 *   - `permanent` — retrying cannot help (an answer that is not the requested segments, a translation service that is
 *                   not configured or not offered, an exhausted monthly budget, a request that cannot be translated).
 *                   The job ends at once. Permanent failures do not spend a business retry: there is no further attempt
 *                   to budget for, and the reason is recorded in the job's `last_error_code`.
 *
 * Pure functions and constants only: the unit test (`translation-job-policy.test.ts`) is the specification of this
 * table, and the worker (`translation-job-worker.ts`) is its only caller.
 */

type TranslationJobFailureClass = 'deferred' | 'transient' | 'permanent';

export interface TranslationJobRetryState {
  /** Business retries already spent. */
  attempts: number;
  maxAttempts: number;
}

export interface TranslationJobDecision {
  failureClass: TranslationJobFailureClass;
  /** A safe code, never provider text. */
  code: string;
  /** Business retries spent after this decision (unchanged for a deferral or a permanent failure). */
  attempts: number;
  /** `requeue`: back to `queued`; `fail`: terminal. */
  action: 'requeue' | 'fail';
  /** When it may run again (`requeue` only). */
  nextAttemptAt: Date | null;
}

/** First backoff step: one minute. */
export const TRANSLATION_JOB_BACKOFF_BASE_MS = 60_000;
/** Never wait longer than half an hour between two business retries. */
export const TRANSLATION_JOB_BACKOFF_MAX_MS = 30 * 60_000;

/**
 * The wait before business retry number `attempts` (1 → 60 s, 2 → 120 s, 3 → 240 s, … capped at 30 minutes).
 * No jitter: one VPS, a handful of jobs, and an operator who can read the next attempt time off the API.
 */
export function translationJobBackoffMs(attempts: number): number {
  const step = Math.max(1, Math.trunc(attempts));
  return Math.min(TRANSLATION_JOB_BACKOFF_MAX_MS, TRANSLATION_JOB_BACKOFF_BASE_MS * 2 ** (step - 1));
}

/**
 * Codes that end a job at once. `DUAL_MODEL_NOT_CONFIGURED` / `DUAL_MODEL_SAME_MODEL` are the provider service's save
 * time refusals (they never reach a job) but are listed because the API may surface the same codes; keeping them here
 * makes the policy table complete rather than surprising.
 */
const PERMANENT_CODES: ReadonlySet<string> = new Set([
  'BAD_TRANSLATION',
  'EMPTY_REQUEST',
  'SERVICE_UNAVAILABLE',
  'LLM_NOT_CONFIGURED',
  'NOT_CONFIGURED',
  'DUAL_MODEL_NOT_CONFIGURED',
  'DUAL_MODEL_SAME_MODEL',
  'BUDGET_EXCEEDED',
  'CAPABILITY_UNSUPPORTED',
  'NOT_FOUND',
  'PROVIDER_DISABLED',
  'PROVIDER_UNAVAILABLE',
  'PRICE_NOT_CONFIGURED',
  'CALL_DIGEST_MISMATCH',
  'CALL_RESULT_EXPIRED',
  'CANCELLED',
  'VALIDATION',
]);

/** The safe error code of anything thrown while running a job. */
export function translationJobErrorCode(err: unknown): string {
  if (err instanceof LlmDeferredError) return err.code;
  if (err instanceof TranslationError) return err.code;
  if (err instanceof LlmGatewayError) return err.code;
  if (err instanceof Error && err.name === 'AbortError') return 'CANCELLED';
  return 'INTERNAL';
}

/** What to do after an attempt threw. `now` is the caller's clock (tests pass a fixed time). */
export function decideTranslationJobFailure(
  state: TranslationJobRetryState,
  err: unknown,
  now: Date = new Date(),
): TranslationJobDecision {
  // A deferral is not a failure: wait for the gateway's own time, keep the business retry budget.
  if (err instanceof LlmDeferredError) {
    return {
      failureClass: 'deferred',
      code: err.code,
      attempts: state.attempts,
      action: 'requeue',
      nextAttemptAt: err.retryAt,
    };
  }

  const code = translationJobErrorCode(err);
  if (PERMANENT_CODES.has(code)) {
    return { failureClass: 'permanent', code, attempts: state.attempts, action: 'fail', nextAttemptAt: null };
  }

  const attempts = state.attempts + 1;
  if (attempts >= Math.max(1, state.maxAttempts)) {
    return { failureClass: 'transient', code, attempts, action: 'fail', nextAttemptAt: null };
  }
  return {
    failureClass: 'transient',
    code,
    attempts,
    action: 'requeue',
    nextAttemptAt: new Date(now.getTime() + translationJobBackoffMs(attempts)),
  };
}
