/**
 * The vocabulary the two halves of staleness detection share (HeoPress v1.1; spec content/stale-content-queue).
 *
 * A "needs update" mark has two writers and they must never be confused: an operator marking an item by hand
 * (`PUT …/timeliness`) and the hourly sweep deriving it from age (`services/staleness/detect.ts`). `needs_update_source`
 * records which one wrote it, so the sweep can skip anything a person decided and only ever clear its own marks; the
 * review queue groups by the same column.
 */

/**
 * The short reason an automatic mark carries. The queue shows it verbatim, so it has to say why without a lookup:
 * "stale" alone does not tell an editor whether the sweep or a colleague set the mark.
 */
export const AUTO_STALE_REASON = 'auto:stale';

/** How long a published item may stand unchanged before the sweep calls it stale. */
export const DEFAULT_STALE_AFTER_DAYS = 365;

/** Environment override for {@link DEFAULT_STALE_AFTER_DAYS}; a non-positive or unparseable value falls back. */
export const STALE_AFTER_DAYS_ENV = 'HEOPRESS_STALE_AFTER_DAYS';

/**
 * The threshold in days: `HEOPRESS_STALE_AFTER_DAYS` when it names a positive integer, the default otherwise.
 * `env` is injectable so the resolution is testable without touching `process.env`.
 */
export function staleAfterDays(env: Record<string, string | undefined> = process.env): number {
  const raw = env[STALE_AFTER_DAYS_ENV];
  // The whole value has to be a number: `Number('30 days')` is NaN, and a typo must fall back, not silently mean 30.
  const days = Number(raw);
  return Number.isInteger(days) && days > 0 ? days : DEFAULT_STALE_AFTER_DAYS;
}

/** The instant an item's `updated_at` must be older than to count as stale at `now` (whole days, exact). */
export function staleCutoff(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}
