// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
/**
 * Shared scheduled-rotation glue for the AuditRotator
 * (admin-setup-wizard task 11.4; Req 15.5; design §10.2).
 *
 * Task 11.3 built the {@link AuditRotator} (the *what* — the two-table
 * retention prune). Task 11.4 is the *when/where*: actually firing
 * `rotate()` on a schedule. `serve.ts` (the Node entrypoint) schedules it with
 * `node-cron` at `0 * * * *` (hourly); this module is the shared entry so the
 * wiring is unit-testable without standing up the process. (The Cloudflare
 * Cron Trigger path was removed in HeoPress P02.)
 *
 * ── Why a thin wrapper and not just `new AuditRotator(db).rotate()` ──
 *
 * `rotate()` is already best-effort and never throws (task 11.3), but
 * the caller wants a one-line log of the pruned count.
 * {@link runScheduledRotation} gives both a single promise that logs
 * the count and, defensively, swallows anything `rotate()` might ever
 * throw in the future — so neither a cron tick nor a `scheduled`
 * invocation can ever reject.
 *
 * **Validates: Requirements 15.5**
 *
 * References: requirements §15.5; design.md §10.2.
 */

import type { Database } from '@heopress/database';
import { AuditRotator, type RotateResult } from './rotator';

/** Log prefix shared with the rest of the CMS runtime logs. */
const LOG_PREFIX = '[heopress-cms]';

/**
 * Construct the {@link AuditRotator} both entrypoints use.
 *
 * Kept as a one-liner factory so the construction lives in exactly one
 * place: if the rotator ever needs extra wiring (an injected clock, a
 * pre-resolved `retentionDays`), it changes here and both runtimes pick
 * it up. The rotator self-resolves `HEOPRESS_AUDIT_RETENTION_DAYS` from
 * the ambient env defensively (see `rotator.ts`), so no env plumbing is
 * required from the caller.
 */
export function buildAuditRotator(db: Database): AuditRotator {
  return new AuditRotator({ db });
}

/**
 * Run one audit-log retention prune and log the outcome. Designed to be
 * the body of a `node-cron` tick in `serve.ts`.
 *
 * NEVER throws: `AuditRotator.rotate()` is already best-effort, but we
 * wrap defensively so a future change can't turn a cron tick into an
 * unhandled rejection. On the (currently
 * unreachable) error path it logs and resolves to `{ deleted: 0 }`.
 *
 * @param db    a Drizzle client built from the runtime connection.
 * @param log   injectable logger (defaults to `console`) so the test can
 *              assert the pruned-count line without capturing stdout.
 * @returns the {@link RotateResult} from the prune.
 */
export async function runScheduledRotation(
  db: Database,
  log: Pick<Console, 'log' | 'error'> = console,
): Promise<RotateResult> {
  try {
    const result = await buildAuditRotator(db).rotate();
    log.log(`${LOG_PREFIX} audit rotation pruned ${result.deleted} rows`);
    return result;
  } catch (err) {
    // Defensive only — rotate() does not throw today (task 11.3).
    log.error(`${LOG_PREFIX} audit rotation failed unexpectedly`, err);
    return { deleted: 0 };
  }
}
