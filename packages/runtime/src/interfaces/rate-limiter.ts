// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
/**
 * Distributed fixed-window rate limiter (high-load-cache-readiness Req 12;
 * design §8).
 */
export interface RateLimitConsumeResult {
  /** Whether this consume is within budget. */
  allowed: boolean;
  /** Requests remaining in the current window after this consume. */
  remaining: number;
  /** Epoch seconds when the window resets. */
  resetAt: number;
}

export interface RateLimiterProvider {
  /**
   * Atomically consume one unit of budget for `key`.
   *
   * Implementations use one atomic upsert (PostgreSQL) or an equivalent atomic
   * backend. Denied requests still increment the counter.
   */
  consume(
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<RateLimitConsumeResult>;
}
