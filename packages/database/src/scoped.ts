import { drizzle } from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';

import { schema, type Database } from './client';

/**
 * Site-scoped database handles (HeoPress P14 task 1.2, ADR-0023, design D1.4).
 *
 * `scopedDatabase(base, { site })` returns a Drizzle `Database` whose every statement runs with `app.site_id` set to
 * that site — the scope the row-level security policies (`app_site_id()`) read; `{ platform: true }` sets the platform
 * scope instead (global rows only, no site's rows). The scope is only ever set inside a transaction
 * (`set_config(…, true)`), never for the session, so a connection goes back to the pool without any scope:
 *
 *   - a statement outside a transaction becomes a short transaction: `BEGIN`, the scope, the statement, `COMMIT`, the
 *     scope and the statement pipelined on one connection;
 *   - an explicit transaction (`db.transaction`) sets the scope before its first statement — after a leading
 *     `SET TRANSACTION` (an isolation level), which must come first.
 *
 * The wrapper gives the Drizzle postgres-js driver what it calls on its client (`unsafe(…)` with `.values()`, `begin`,
 * `options`); `scoped.db.test.ts` covers the paths it takes with the pinned drizzle-orm and postgres versions. A scoped
 * handle can be re-scoped (`scopedDatabase(scoped, other)` scopes the same connection pool). `runSiteTransaction` /
 * `withSiteScope` still switch the site inside one transaction.
 */
export type DatabaseScope = { site: string } | { platform: true };

type Sql = postgres.Sql;
type TransactionSql = postgres.TransactionSql;
type Params = readonly unknown[] | undefined;

const RAW = Symbol('heopress.scoped.raw');
const scopes = new WeakMap<object, DatabaseScope>();
const cache = new WeakMap<object, Map<string, Database>>();
/** Handles kept per connection pool: a scope is cheap to build again, so this only bounds the memory. */
const CACHE_LIMIT = 512;

const SCOPE_SQL = `SELECT set_config('app.site_id', $1, true), set_config('app.platform_scope', $2, true)`;

function scopeParams(scope: DatabaseScope): [string, string] {
  return 'site' in scope ? [scope.site, ''] : ['', 'on'];
}

function scopeKey(scope: DatabaseScope): string {
  return 'site' in scope ? `site:${scope.site}` : 'platform';
}

/** The postgres.js pool behind a Drizzle handle (scoped or not). */
function rawClient(base: Database): Sql {
  const client = (base as unknown as { $client?: Sql & { [RAW]?: Sql } }).$client;
  if (!client || typeof client.unsafe !== 'function' || typeof client.begin !== 'function') {
    throw new TypeError('scopedDatabase: the base handle is not a Drizzle postgres-js database');
  }
  return client[RAW] ?? client;
}

/**
 * A statement outside a transaction: run in a short transaction with the scope set first. Lazy and thenable like a
 * postgres.js query (the driver awaits it, or calls `.values()` and awaits that).
 */
function scopedStatement(raw: Sql, params: [string, string], query: string, values: Params) {
  const run = (mode: 'objects' | 'values') =>
    raw.begin(async (tx) => {
      const scope = tx.unsafe(SCOPE_SQL, params);
      const statement = mode === 'values' ? tx.unsafe(query, values as never[]).values() : tx.unsafe(query, values as never[]);
      // Both are sent at once (pipelined); the statement fails too if the scope did.
      const [, result] = await Promise.all([scope, statement]);
      return result;
    });
  let objects: Promise<unknown> | undefined;
  const pending = () => (objects ??= run('objects'));
  return {
    values: () => run('values'),
    then: <A, B>(ok?: ((v: unknown) => A | PromiseLike<A>) | null, err?: ((e: unknown) => B | PromiseLike<B>) | null) => pending().then(ok, err),
    catch: <B>(err?: ((e: unknown) => B | PromiseLike<B>) | null) => pending().catch(err),
    finally: (fn?: (() => void) | null) => pending().finally(fn),
  };
}

const SET_TRANSACTION = /^\s*set\s+transaction\b/i;

/** A transaction's client that sets the scope before its first statement (after a leading `SET TRANSACTION`). */
function scopedTransaction(tx: TransactionSql, params: [string, string]): TransactionSql {
  let scoped: Promise<unknown> | undefined;
  const ensure = () => {
    if (!scoped) {
      scoped = tx.unsafe(SCOPE_SQL, params);
      // The next statement on this transaction fails with it; its own error is the one reported.
      scoped.then(undefined, () => undefined);
    }
  };
  return new Proxy(tx, {
    get(target, prop, receiver) {
      if (prop === 'unsafe') {
        return (query: string, values?: Params, options?: postgres.UnsafeQueryOptions) => {
          if (scoped || !SET_TRANSACTION.test(query)) ensure();
          return target.unsafe(query, values as never[], options);
        };
      }
      if (prop === 'savepoint') {
        return (...args: unknown[]) => {
          ensure();
          return (target.savepoint as (...a: unknown[]) => unknown)(...args);
        };
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

function scopedClient(raw: Sql, scope: DatabaseScope): Sql {
  const params = scopeParams(scope);
  const client = {
    [RAW]: raw,
    options: raw.options,
    parameters: raw.parameters,
    unsafe: (query: string, values?: Params) => scopedStatement(raw, params, query, values),
    begin: (...args: unknown[]) => {
      const fn = args.pop() as (tx: TransactionSql) => unknown;
      const run = (tx: TransactionSql) => fn(scopedTransaction(tx, params));
      return args.length > 0 ? raw.begin(args[0] as string, run as never) : raw.begin(run as never);
    },
    end: (options?: { timeout?: number }) => raw.end(options),
  };
  return client as unknown as Sql;
}

/**
 * A handle on the same connection pool as `base`, every statement in `scope`. Handles are reused per pool and scope.
 */
export function scopedDatabase(base: Database, scope: DatabaseScope): Database {
  if ('site' in scope && (typeof scope.site !== 'string' || scope.site.length === 0)) {
    throw new TypeError('scopedDatabase: a site scope needs a site id');
  }
  if (!('site' in scope) && scope.platform !== true) throw new TypeError('scopedDatabase: unknown scope');
  const raw = rawClient(base);
  let byScope = cache.get(raw);
  if (!byScope) cache.set(raw, (byScope = new Map()));
  const key = scopeKey(scope);
  const hit = byScope.get(key);
  if (hit) return hit;
  const db = drizzle(scopedClient(raw, scope), { schema }) as unknown as Database;
  scopes.set(db, 'site' in scope ? { site: scope.site } : { platform: true });
  if (byScope.size >= CACHE_LIMIT) byScope.delete(byScope.keys().next().value as string);
  byScope.set(key, db);
  return db;
}

/** The scope of a handle made by `scopedDatabase`, or null for any other handle (a root pool, a transaction). */
export function databaseScope(db: unknown): DatabaseScope | null {
  if (!db || typeof db !== 'object') return null;
  return scopes.get(db) ?? null;
}
