// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A leader-locked cron callback must AWAIT its work (reviewer R3).
 *
 * ## The defect
 *
 * Every cron registration in `serve.ts` was shaped like:
 *
 * ```ts
 * leaderLockedCallback('job', ttl, () => {
 *   void doWork().catch(log);
 * }, lockOpts)
 * ```
 *
 * `void doWork()` discards the promise, so the callback returns `undefined`
 * synchronously. `leaderLockedCallback` does `await fn()`, which completes
 * immediately, and then releases the lock — while the work is still running. The
 * lock therefore guaranteed nothing for **any** of these jobs. All nine had the
 * same shape, so this is a class, not one mistake: `goal-dispatch` is just the
 * job where the consequence is visible as two runs for one drift.
 *
 * ## Two halves
 *
 * A source scan alone would pass on a callback that is `async` but still forgets
 * to await inside, and a behavioural test alone would not stop the next
 * registration from being written the old way. Both are here.
 *
 * Evidence class: the source scan reads the real `serve.ts`. The behavioural
 * half — the advisory lock is held until an awaited function resolves, so the
 * next slot of the same job is skipped as an overlap — runs against PostgreSQL
 * in packages/runtime/src/__tests__/scheduled-jobs.db.test.ts (HeoPress P03
 * replaced the Redis lock).
 *
 * **Validates: #455 / reviewer R3 — the lock is held for the duration of the work**
 */

const SERVE = readFileSync(join(__dirname, '..', 'serve.ts'), 'utf8');

describe('serve.ts cron callbacks hold the leader lock', () => {
  it('registers no callback that discards its work with `void`', () => {
    // The exact shape that caused the bug. Matching on it rather than on "does
    // this file contain `void`" keeps the check specific enough to be actionable.
    const discarded = SERVE.match(/\(\) => \{\n\s*void /g) ?? [];
    expect(discarded, 'cron callbacks must await, not `void`, their work').toEqual([]);
  });

  it('every scheduledJob is given an async function', () => {
    const registrations = [...SERVE.matchAll(/scheduledJob\(\s*\n?\s*'([^']+)'[\s\S]{0,200}?\n(\s*)(async )?\(\) => \{/g)];
    expect(registrations.length, 'found the cron registrations').toBeGreaterThanOrEqual(9);

    const notAsync = registrations.filter((m) => m[3] === undefined).map((m) => m[1]);
    expect(notAsync, 'these jobs release the lock before their work finishes').toEqual([]);
  });
});
