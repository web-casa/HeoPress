import type { ChatOutcome } from './openai-compatible';
import { LlmGatewayError } from './gateway-error';

/**
 * Model-call governance (HeoPress P09 task 4.5; spec ai/cost-control "模型调用治理").
 *
 * Per model service — a site's provider, or an instance service, keyed by site and configuration fingerprint (a
 * site's providers carry that site's own key, so their limits are the site's) — the governor keeps:
 *
 *   - a rate limit: at most `ratePerMinute` attempts in any sliding minute;
 *   - a circuit breaker: `breakerFailures` service failures in a row open it for `breakerCooldownMs`; after that one
 *     trial attempt is let through (half-open) and its outcome closes or reopens it. Only service failures count —
 *     network errors, timeouts, 429 and 5xx (`isServiceFailure`). A request the service rejected as such (400, 401,
 *     422, an unreadable body, a policy refusal) neither counts nor resets the count.
 *
 * A call whose services are all limited or open is not failed: the gateway throws `LlmDeferredError` with the time
 * it may run (`retryAt`). A deferral is not a business failure: callers reschedule it without spending a retry
 * (`afterTaskFailure`). The same holds for the optional daily budget (deferred to the next local day).
 *
 * The state is per process (one CMS/worker process on a small VPS); several processes each enforce their own share.
 */

export interface GovernorConfig {
  ratePerMinute: number;
  breakerFailures: number;
  breakerCooldownMs: number;
}

function governorConfigFromEnv(env: Record<string, string | undefined> = process.env): GovernorConfig {
  const int = (raw: string | undefined, fallback: number, min: number) => {
    const n = Number(raw);
    return raw !== undefined && raw.trim() !== '' && Number.isInteger(n) && n >= min ? n : fallback;
  };
  return {
    // 0: no rate limit.
    ratePerMinute: int(env.HEOPRESS_LLM_RATE_LIMIT_PER_MINUTE, 60, 0),
    breakerFailures: int(env.HEOPRESS_LLM_BREAKER_FAILURES, 5, 1),
    breakerCooldownMs: int(env.HEOPRESS_LLM_BREAKER_COOLDOWN_SECONDS, 60, 1) * 1000,
  };
}

/** Why a call was deferred: none of these is a failure of the task. */
export type DeferralCode = 'RATE_LIMITED' | 'BREAKER_OPEN' | 'DAILY_BUDGET_EXHAUSTED';

/** A model call that may not run now; run it again at `retryAt`. It does not consume the task's retries. */
export class LlmDeferredError extends LlmGatewayError {
  readonly consumesRetry = false;
  constructor(
    code: DeferralCode,
    readonly retryAt: Date,
  ) {
    super(code, `The model call is deferred until ${retryAt.toISOString()}.`);
    this.name = 'LlmDeferredError';
  }
}

/** Whether an attempt's outcome is a failure of the service (counts towards the breaker). */
export function isServiceFailure(o: ChatOutcome): boolean {
  switch (o.kind) {
    case 'network':
    case 'timeout':
      return true;
    case 'http':
      return o.status === 429 || o.status >= 500;
    default:
      return false;
  }
}

interface ServiceState {
  /** Attempt start times inside the last minute. */
  window: number[];
  failures: number;
  openUntil: number | null;
  /** Half-open: the one trial attempt is out. */
  trial: boolean;
}

export type Admission = { ok: true } | { ok: false; code: 'RATE_LIMITED' | 'BREAKER_OPEN'; retryAt: number };

const MINUTE = 60_000;

export class ModelCallGovernor {
  private readonly services = new Map<string, ServiceState>();

  constructor(
    private readonly config: GovernorConfig = governorConfigFromEnv(),
    private readonly clock: () => number = Date.now,
  ) {}

  private state(key: string): ServiceState {
    let s = this.services.get(key);
    if (!s) {
      s = { window: [], failures: 0, openUntil: null, trial: false };
      this.services.set(key, s);
    }
    return s;
  }

  /** Whether the breaker keeps this service out now (no attempt is taken). */
  breaker(key: string): Admission {
    const s = this.services.get(key);
    if (!s || s.openUntil === null) return { ok: true };
    const now = this.clock();
    if (now < s.openUntil) return { ok: false, code: 'BREAKER_OPEN', retryAt: s.openUntil };
    // Half-open: only one trial at a time.
    if (s.trial) return { ok: false, code: 'BREAKER_OPEN', retryAt: now + Math.min(this.config.breakerCooldownMs, MINUTE) };
    return { ok: true };
  }

  /** Take an attempt for this service: the breaker, then the rate limit. Nothing is taken when refused. */
  take(key: string): Admission {
    const gate = this.breaker(key);
    if (!gate.ok) return gate;
    const s = this.state(key);
    const now = this.clock();
    if (this.config.ratePerMinute > 0) {
      s.window = s.window.filter((t) => t > now - MINUTE);
      if (s.window.length >= this.config.ratePerMinute) return { ok: false, code: 'RATE_LIMITED', retryAt: s.window[0]! + MINUTE };
      s.window.push(now);
    }
    if (s.openUntil !== null) s.trial = true;
    return { ok: true };
  }

  /** The outcome of an attempt taken with `take`. */
  record(key: string, outcome: ChatOutcome): void {
    const s = this.state(key);
    if (outcome.kind === 'ok') {
      s.failures = 0;
      s.openUntil = null;
      s.trial = false;
      return;
    }
    if (!isServiceFailure(outcome)) {
      // The request's own fault: the service answered. A half-open trial that got an answer closes the breaker.
      if (s.trial) {
        s.openUntil = null;
        s.trial = false;
        s.failures = 0;
      }
      return;
    }
    s.failures += 1;
    if (s.trial || s.failures >= this.config.breakerFailures) {
      s.openUntil = this.clock() + this.config.breakerCooldownMs;
      s.failures = 0;
      s.trial = false;
    }
  }

  /** Test and status view. */
  snapshot(key: string): { failures: number; open: boolean; recentAttempts: number } {
    const s = this.services.get(key);
    const now = this.clock();
    return { failures: s?.failures ?? 0, open: Boolean(s?.openUntil && now < s.openUntil), recentAttempts: s?.window.filter((t) => t > now - MINUTE).length ?? 0 };
  }
}

/** The process's governor: every gateway of this process shares it. */
let shared: ModelCallGovernor | null = null;
export function sharedGovernor(): ModelCallGovernor {
  shared ??= new ModelCallGovernor();
  return shared;
}

/** The governor's key of a model service for a site. */
export const serviceKey = (siteId: string, fingerprint: string) => `${siteId}:${fingerprint}`;

/** A queued AI task's retry state. */
export interface TaskRetryState {
  /** Business retries spent. */
  attempts: number;
  maxAttempts: number;
  notBefore: Date | null;
}

/**
 * What a task does after its step threw: a deferral reschedules it at `retryAt` with its retry count unchanged; any
 * other error spends a retry (`backoffMs` later), or ends it once they are spent.
 */
export function afterTaskFailure(
  state: TaskRetryState,
  err: unknown,
  now: Date,
  backoffMs = 60_000,
): { action: 'reschedule' | 'fail'; state: TaskRetryState; deferred: boolean } {
  if (err instanceof LlmDeferredError) {
    return { action: 'reschedule', deferred: true, state: { ...state, notBefore: err.retryAt } };
  }
  const attempts = state.attempts + 1;
  if (attempts >= state.maxAttempts) return { action: 'fail', deferred: false, state: { ...state, attempts, notBefore: null } };
  return { action: 'reschedule', deferred: false, state: { ...state, attempts, notBefore: new Date(now.getTime() + backoffMs) } };
}
