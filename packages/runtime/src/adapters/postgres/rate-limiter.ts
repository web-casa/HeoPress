import type postgres from 'postgres';
import type { RateLimitConsumeResult, RateLimiterProvider } from '../../interfaces';

/**
 * Fixed-window rate limiter on the logged table `lumibase_rate_limit_windows`
 * (HeoPress P03 tasks 2.3–2.4).
 *
 * One atomic upsert per consume: a window that has ended restarts at 1,
 * otherwise the count goes up (denied requests count too). The table is logged,
 * so a crash or restart does not reset a budget. Any database error is thrown;
 * callers guarding security endpoints treat that as "deny" (fail closed).
 */
export class PostgresRateLimiter implements RateLimiterProvider {
  constructor(private readonly sql: postgres.Sql) {}

  async consume(key: string, limit: number, windowSeconds: number): Promise<RateLimitConsumeResult> {
    const window = Math.max(1, Math.floor(windowSeconds));
    const rows = await this.sql<{ count: number; reset_at: string }[]>`
      INSERT INTO lumibase_rate_limit_windows AS w (key, window_start, window_seconds, count)
      VALUES (${key}, now(), ${window}, 1)
      ON CONFLICT (key) DO UPDATE SET
        count = CASE WHEN w.window_start + make_interval(secs => w.window_seconds) <= now()
                     THEN 1 ELSE w.count + 1 END,
        window_start = CASE WHEN w.window_start + make_interval(secs => w.window_seconds) <= now()
                            THEN now() ELSE w.window_start END,
        window_seconds = CASE WHEN w.window_start + make_interval(secs => w.window_seconds) <= now()
                              THEN EXCLUDED.window_seconds ELSE w.window_seconds END
      RETURNING count,
                ceil(EXTRACT(EPOCH FROM window_start + make_interval(secs => window_seconds)))::bigint AS reset_at`;
    const row = rows[0];
    if (!row) throw new Error('rate limiter upsert returned no row');
    return {
      allowed: row.count <= limit,
      remaining: Math.max(0, limit - row.count),
      resetAt: Number(row.reset_at),
    };
  }

  /** Delete windows that ended more than a day ago (housekeeping only). */
  async purgeExpired(): Promise<void> {
    await this.sql`
      DELETE FROM lumibase_rate_limit_windows
       WHERE window_start + make_interval(secs => window_seconds) < now() - interval '1 day'`;
  }
}
