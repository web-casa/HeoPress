// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { AsyncLocalStorage } from 'node:async_hooks';
import { sql } from 'drizzle-orm';
import { siteContentSettings, type Database } from '@heopress/database';
import { ItemServiceError } from './item-service-error';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

function skipRlsInDev(): boolean {
  return process.env.HEOPRESS_ENV === 'development';
}

/**
 * Run `fn` inside a Drizzle transaction with `app.site_id` set_config applied
 * **inside** the same transaction (high-load-cache-readiness §12 / P16).
 *
 * `withRls` middleware sets the scope on the request connection before the
 * handler runs; an explicit `db.transaction()` starts a nested transaction
 * where that outer-local setting is not guaranteed to apply — callers that
 * write through a transaction must use this helper (or equivalent) instead.
 */
export async function runSiteTransaction<T>(
  db: Database,
  siteId: string,
  fn: (tx: Tx) => Promise<T>,
  opts: {
    isolationLevel?: 'read committed' | 'repeatable read' | 'serializable';
    /**
     * `false`: run once, never again — for a body with effects outside the database (realtime, queues, extension
     * hooks, caches: the work after an already committed write), which a retry would repeat. Still a boundary: the
     * transactions inside it do not retry either.
     */
    retry?: boolean;
  } = {},
): Promise<T> {
  return retryTransaction(
    () =>
      db.transaction(async (tx) => {
        if (!skipRlsInDev()) {
          await tx.execute(sql`SELECT set_config('app.site_id', ${siteId}, true)`);
        }
        const out = await fn(tx);
        // Last, before the commit (HeoPress P06): the public projection follows what this transaction wrote.
        if (beforeCommit) await beforeCommit(tx);
        return out;
      }, opts.isolationLevel ? { isolationLevel: opts.isolationLevel } : undefined),
    { conflicts: !isTransaction(db), attempts: opts.retry === false ? 1 : MEMBERSHIP_ATTEMPTS },
  );
}

/**
 * A site transaction for a body that writes items directly (workers, bulk maintenance): the site's content settings row
 * is held shared before the first item statement, the order of every item writer — a site or collection deletion takes
 * that row exclusively and then the item rows, so the opposite order could deadlock with it (P07, Codex review of batch
 * 4b; the items' statement trigger, migration 0061, would otherwise take it only after the item rows).
 */
export function runItemWriteTransaction<T>(db: Database, siteId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return runSiteTransaction(db, siteId, async (tx) => {
    await tx.execute(sql`SELECT 1 FROM ${siteContentSettings} WHERE ${siteContentSettings.siteId} = ${siteId} FOR SHARE`);
    return fn(tx);
  });
}

/**
 * A translation group's membership moved under a transaction (between an unlocked read and the lock, P05 design
 * R13; or a site joined a group while the projection's refresh waited for it, P07): the transaction starts over.
 */
export class MembershipChangedError extends Error {
  constructor() {
    super('The item joined or left a translation group meanwhile.');
    this.name = 'MembershipChangedError';
  }
}

/** How many times a transaction is run in all when it has to start over. */
export const MEMBERSHIP_ATTEMPTS = 3;

/** A deadlock (`40P01`) or serialization failure (`40001`), possibly wrapped by the driver or Drizzle. */
export function isRetryableConflict(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && typeof e === 'object' && depth < 4; e = (e as { cause?: unknown }).cause, depth++) {
    const code = (e as { code?: unknown }).code;
    if (code === '40P01' || code === '40001') return true;
  }
  return false;
}

/** Whether `db` is a transaction (Drizzle's transaction handles can roll back; the database cannot). */
export function isTransaction(db: unknown): boolean {
  return typeof (db as { rollback?: unknown } | null)?.rollback === 'function';
}

/** A write that had to start over and kept having to (409 to the client, whichever route it came through). */
export class RetryExhaustedError extends ItemServiceError {
  constructor() {
    super('RETRY_EXHAUSTED', 'The data this write depends on kept changing; try again.', 409);
    this.name = 'RetryExhaustedError';
  }
}

/**
 * The attempt a retry boundary is running: boundaries nested inside it do not retry on their own. Inactive once the
 * attempt is over — async work started inside it that outlives it then owns its own retries.
 */
const retryBoundary = new AsyncLocalStorage<{ active: boolean }>();

/**
 * The retry boundary of a transaction (HeoPress P06 R30, P07 Codex review of batch 4a). The outermost boundary runs
 * `attempt` again — at most `MEMBERSHIP_ATTEMPTS` runs in all — when it ends in `MembershipChangedError` (a
 * translation group's membership moved: the projection's refresh may start any site transaction over) or, with
 * `conflicts` (only where `attempt` is the outermost transaction: a savepoint retried inside a caller's transaction
 * would keep that transaction's locks and snapshot), in a deadlock or serialization failure. A boundary inside
 * another's attempt only runs it: the outer one owns the retries, so they never multiply. Exhausted: 409
 * `RETRY_EXHAUSTED`.
 */
export async function retryTransaction<T>(attempt: () => Promise<T>, opts: { conflicts: boolean; attempts?: number }): Promise<T> {
  // Known limit: async work started during an attempt that is still running when the attempt ends, and only then opens a
  // transaction, sees the attempt as active and does not retry on its own (no such work exists today).
  if (retryBoundary.getStore()?.active) return attempt();
  const attempts = opts.attempts ?? MEMBERSHIP_ATTEMPTS;
  for (let i = 0; ; i++) {
    const context = { active: true };
    try {
      return await retryBoundary.run(context, attempt);
    } catch (err) {
      if (attempts === 1) throw err;
      if (!(err instanceof MembershipChangedError) && !(opts.conflicts && isRetryableConflict(err))) throw err;
      if (i + 1 >= attempts) throw new RetryExhaustedError();
    } finally {
      context.active = false;
    }
  }
}

type BeforeCommit = (tx: Tx) => Promise<void>;
let beforeCommit: BeforeCommit | null = null;

/**
 * Register the work every site transaction does last before it commits (HeoPress P06: the public
 * projection flush, `services/site-network/public-projection.ts`). A hook rather than an import:
 * that module itself runs site transactions.
 */
export function setBeforeCommitHook(fn: BeforeCommit | null): BeforeCommit | null {
  const previous = beforeCommit;
  beforeCommit = fn;
  return previous;
}

export type { Tx as SiteTransaction };

/**
 * Run `fn` with `app.site_id` set to `siteId` inside an existing
 * transaction, then put back the value it had before (HeoPress P05, design
 * R12): scopes nest — A → B → C returns to B after C. Use the same `tx` for
 * every query inside; never interleave scopes on one transaction.
 *
 * When `fn` throws, the scope is restored if the transaction still accepts
 * statements (a business error the caller may catch and carry on after);
 * after an SQL error the transaction is failed anyway and rolls back, so the
 * failed restore is ignored and the original error is rethrown.
 */
const scopeStacks = new WeakMap<object, symbol[]>();

export async function withSiteScope<T>(tx: Tx, siteId: string, fn: () => Promise<T>): Promise<T> {
  // Scopes on one transaction nest strictly; two running side by side would restore each other's values.
  const stack = scopeStacks.get(tx) ?? [];
  scopeStacks.set(tx, stack);
  const token = Symbol(siteId);
  stack.push(token);
  try {
    return await runScoped(tx, siteId, fn);
  } finally {
    if (stack[stack.length - 1] !== token) {
      // eslint-disable-next-line no-unsafe-finally
      throw new Error('withSiteScope: site scopes on one transaction were interleaved; nest them, never run them side by side.');
    }
    stack.pop();
  }
}

async function runScoped<T>(tx: Tx, siteId: string, fn: () => Promise<T>): Promise<T> {
  if (skipRlsInDev()) return fn();
  const rows = (await tx.execute(sql`SELECT current_setting('app.site_id', true) AS v`)) as unknown as Array<{ v: string | null }>;
  const previous = rows[0]?.v ?? '';
  await tx.execute(sql`SELECT set_config('app.site_id', ${siteId}, true)`);
  let out: T;
  try {
    out = await fn();
  } catch (err) {
    await tx.execute(sql`SELECT set_config('app.site_id', ${previous}, true)`).catch(() => undefined);
    throw err;
  }
  await tx.execute(sql`SELECT set_config('app.site_id', ${previous}, true)`);
  return out;
}
