import type postgres from 'postgres';
import { classifyCacheValue, negativeCacheWireValue } from '../../cache-entry';
import type {
  CacheEntry,
  CacheEvent,
  CacheProvider,
  CacheSetOptions,
  UniqueCounterProvider,
} from '../../interfaces';

/**
 * Two-level cache on PostgreSQL (HeoPress P03 tasks 2.1, 2.2, 2.4; ADR-0002).
 *
 * L2 is the UNLOGGED table `lumibase_cache_entries`, shared by every process.
 * Each row records the generations of its tags at write time and a `version`
 * taken from a global sequence on every write. `invalidateByTag` bumps the
 * tag's generation in the logged table `lumibase_cache_tags`, deletes the
 * tagged rows and NOTIFYs.
 *
 * Every read is one query that checks the shared state (design "故障语义":
 * 每次读取校验共享标签代次). The reader passes the version of its L1 copy, if
 * any; the row comes back with its current version and current tag
 * generations, and with its value only when the version differs. So:
 *   - a value written or deleted by another process is never served from L1,
 *     however late (or lost) the notification;
 *   - a tagged entry written before an invalidation is never served, from L1
 *     or L2, even if its row survived;
 *   - an L1 hit saves transferring the value, not the round trip.
 *
 * NOTIFY (set, delete, increment, tag invalidation) only evicts L1 copies
 * early, to keep memory for live entries (NOTIFY 仅加速清理). On (re)subscribe
 * — after a dropped connection or a database restart — L1 is cleared.
 *
 * Counters (`increment`) reject on backend failure, as the interface requires.
 * Security budgets do not use this cache: see `PostgresRateLimiter`.
 */

const BACKEND = 'postgres';
const CACHE_NOTIFY_CHANNEL = 'heopress_cache';

type Notice = { t: 'tag'; tag: string } | { t: 'key'; key: string };

interface L1Entry {
  value: string;
  version: number;
  expiresAt: number;
}

export interface PostgresCacheOptions {
  /** Maximum entries held in process (default 5000). */
  l1MaxEntries?: number;
  /** L1 time-to-live in ms, capped by the entry's own TTL (default 2000; 0 disables L1). */
  l1TtlMs?: number;
  /** Interval in ms for purging expired rows (default 60000; 0 disables). */
  purgeIntervalMs?: number;
  /** NOTIFY channel (default `heopress_cache`). */
  channel?: string;
}

interface Row {
  value: string | null;
  version: string;
  gens: string[];
  current: string[];
  expires_ms: string | null;
}

export class PostgresCacheProvider implements CacheProvider, UniqueCounterProvider {
  onEvent?: (e: CacheEvent) => void;

  private readonly l1 = new Map<string, L1Entry>();
  private readonly l1MaxEntries: number;
  private readonly l1TtlMs: number;
  private readonly purgeIntervalMs: number;
  private readonly channel: string;
  /** False after close(): postgres.js may re-subscribe our callbacks after a reconnect. */
  private active = true;
  private warnedListen = false;
  private started: Promise<void> | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private unlisten: (() => Promise<void>) | null = null;

  constructor(
    private readonly sql: postgres.Sql,
    options: PostgresCacheOptions = {},
  ) {
    this.l1MaxEntries = options.l1MaxEntries ?? 5000;
    this.l1TtlMs = options.l1TtlMs ?? 2000;
    this.purgeIntervalMs = options.purgeIntervalMs ?? 60_000;
    this.channel = options.channel ?? CACHE_NOTIFY_CHANNEL;
  }

  /**
   * Subscribe to eviction notices and start the purge timer. Called lazily by
   * the first operation; safe to call repeatedly. Correctness does not depend
   * on it: without notices, stale L1 copies are simply caught on read.
   */
  start(): Promise<void> {
    if (!this.started) {
      this.started = this.subscribe().catch((err: unknown) => {
        this.started = null;
        if (!this.warnedListen) {
          this.warnedListen = true;
          console.warn('[cache] LISTEN failed — L1 copies are evicted on read only:', err instanceof Error ? err.message : err);
        }
      });
    }
    return this.started;
  }

  private async subscribe(): Promise<void> {
    await this.listenOnce();
    if (this.purgeIntervalMs > 0) {
      const purge = setInterval(() => void this.purgeExpired().catch(() => {}), this.purgeIntervalMs);
      purge.unref?.();
      this.timers.push(purge);
    }
  }

  /** LISTEN; postgres.js re-runs it after a dropped connection and calls `onListen` each time. */
  private async listenOnce(): Promise<void> {
    this.active = true;
    const sub = await this.sql.listen(
      this.channel,
      (payload) => this.onNotice(payload),
      () => this.onListen(),
    );
    this.unlisten = sub.unlisten;
  }

  /** (Re)subscribed: notices may have been missed, so drop every L1 copy. */
  private onListen(): void {
    if (this.active) this.l1.clear();
  }

  /** Stop the timer and the LISTEN subscription (the SQL client stays open). */
  async close(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.active = false;
    this.l1.clear();
    await this.unlisten?.().catch(() => {});
    this.unlisten = null;
    this.started = null;
  }

  private emit(event: Omit<CacheEvent, 'backend'>): void {
    this.onEvent?.({ ...event, backend: BACKEND });
  }

  private onNotice(payload: string): void {
    if (!this.active) return;
    let notice: Notice;
    try {
      notice = JSON.parse(payload) as Notice;
    } catch {
      return;
    }
    if (notice.t === 'key') {
      this.l1.delete(notice.key);
    } else {
      // Tags are not kept per L1 entry; a tag notice is rare, so drop all.
      this.l1.clear();
    }
  }

  private writeL1(key: string, value: string, version: number, expiresAtMs: number | null): void {
    if (this.l1TtlMs <= 0) return;
    if (this.l1.size >= this.l1MaxEntries && !this.l1.has(key)) {
      const oldest = this.l1.keys().next().value;
      if (oldest !== undefined) this.l1.delete(oldest);
    }
    const ttlEnd = Date.now() + this.l1TtlMs;
    this.l1.set(key, { value, version, expiresAt: expiresAtMs === null ? ttlEnd : Math.min(ttlEnd, expiresAtMs) });
  }

  private keyNotice(key: string): string {
    return JSON.stringify({ t: 'key', key } satisfies Notice);
  }

  async getEntry<T>(key: string): Promise<CacheEntry<T>> {
    void this.start();
    let local = this.l1.get(key);
    if (local && local.expiresAt <= Date.now()) {
      this.l1.delete(key);
      local = undefined;
    }
    let rows: ReadonlyArray<Row>;
    try {
      rows = await this.sql<Row[]>`
        SELECT CASE WHEN e.version = ${local?.version ?? -1} THEN NULL ELSE e.value END AS value,
               e.version, e.tag_generations AS gens,
               ARRAY(SELECT COALESCE(t.generation, 0)
                       FROM unnest(e.tags) WITH ORDINALITY AS u(tag, ord)
                       LEFT JOIN lumibase_cache_tags t ON t.tag = u.tag
                      ORDER BY u.ord) AS current,
               (EXTRACT(EPOCH FROM e.expires_at) * 1000)::bigint AS expires_ms
          FROM lumibase_cache_entries e
         WHERE e.key = ${key} AND (e.expires_at IS NULL OR e.expires_at > now())`;
    } catch {
      this.emit({ op: 'getEntry', result: 'unavailable' });
      return { state: 'unavailable' };
    }
    const row = rows[0];
    const current = row?.current.map(Number) ?? [];
    if (!row || row.gens.map(Number).some((g, i) => g !== current[i])) {
      // Absent, expired, or written before one of its tags was invalidated.
      this.l1.delete(key);
      this.emit({ op: 'getEntry', result: 'miss' });
      return { state: 'miss' };
    }
    const version = Number(row.version);
    let raw: string;
    if (row.value !== null) {
      raw = row.value;
      this.writeL1(key, raw, version, row.expires_ms === null ? null : Number(row.expires_ms));
    } else if (local && local.version === version) {
      raw = local.value;
      this.l1.delete(key);
      this.l1.set(key, local); // LRU touch
    } else {
      this.emit({ op: 'getEntry', result: 'unavailable' });
      return { state: 'unavailable' };
    }
    let entry: CacheEntry<T>;
    try {
      entry = classifyCacheValue<T>(JSON.parse(raw) as unknown);
    } catch {
      this.emit({ op: 'getEntry', result: 'unavailable' });
      return { state: 'unavailable' };
    }
    this.emit({ op: 'getEntry', result: entry.state === 'hit' ? 'hit' : entry.state });
    return entry;
  }

  async get<T = string>(key: string): Promise<T | null> {
    const entry = await this.getEntry<T>(key);
    this.emit({ op: 'get', result: entry.state === 'hit' ? 'hit' : entry.state });
    return entry.state === 'hit' ? entry.value : null;
  }

  async set(key: string, value: string, options?: CacheSetOptions): Promise<void> {
    void this.start();
    const tags = [...new Set(options?.tags ?? [])];
    const ttl = options?.ttl && options.ttl > 0 ? options.ttl : null;
    this.l1.delete(key);
    try {
      await this.sql`
        WITH up AS (
          INSERT INTO lumibase_cache_entries AS e (key, value, tags, tag_generations, expires_at)
          VALUES (
            ${key}, ${value}, ${tags}::text[],
            ARRAY(SELECT COALESCE(t.generation, 0)
                    FROM unnest(${tags}::text[]) WITH ORDINALITY AS u(tag, ord)
                    LEFT JOIN lumibase_cache_tags t ON t.tag = u.tag
                   ORDER BY u.ord)::bigint[],
            CASE WHEN ${ttl}::int IS NULL THEN NULL ELSE now() + make_interval(secs => ${ttl}::int) END
          )
          ON CONFLICT (key) DO UPDATE
            SET value = EXCLUDED.value, tags = EXCLUDED.tags,
                tag_generations = EXCLUDED.tag_generations, expires_at = EXCLUDED.expires_at,
                version = nextval('lumibase_cache_version_seq')
          RETURNING 1
        )
        SELECT pg_notify(${this.channel}, ${this.keyNotice(key)}) FROM up`;
      this.emit({ op: 'set', result: 'ok' });
    } catch {
      // Fail soft like the Redis adapter: a cache write is an optimisation.
      this.emit({ op: 'set', result: 'error' });
    }
  }

  async setNegative(key: string, options?: { ttl?: number }): Promise<void> {
    await this.set(key, negativeCacheWireValue(), options);
    this.emit({ op: 'setNegative', result: 'ok' });
  }

  async delete(key: string): Promise<void> {
    void this.start();
    this.l1.delete(key);
    try {
      await this.sql`
        WITH d AS (DELETE FROM lumibase_cache_entries WHERE key = ${key})
        SELECT pg_notify(${this.channel}, ${this.keyNotice(key)})`;
      this.emit({ op: 'delete', result: 'ok' });
    } catch {
      this.emit({ op: 'delete', result: 'error' });
    }
  }

  async invalidateByTag(tag: string): Promise<void> {
    void this.start();
    try {
      await this.sql`
        WITH g AS (
          INSERT INTO lumibase_cache_tags AS t (tag, generation) VALUES (${tag}, 1)
          ON CONFLICT (tag) DO UPDATE SET generation = t.generation + 1
          RETURNING generation
        ),
        d AS (DELETE FROM lumibase_cache_entries WHERE tags @> ARRAY[${tag}]::text[])
        SELECT g.generation, pg_notify(${this.channel}, ${JSON.stringify({ t: 'tag', tag } satisfies Notice)})
          FROM g`;
      this.l1.clear();
      this.emit({ op: 'invalidateByTag', result: 'ok' });
    } catch (err) {
      this.emit({ op: 'invalidateByTag', result: 'error' });
      // Unlike a failed write, a failed invalidation would leave stale data
      // visible, so the caller must know.
      throw err;
    }
  }

  async increment(key: string, by = 1, opts?: { ttl?: number }): Promise<number> {
    void this.start();
    const ttl = opts?.ttl && opts.ttl > 0 ? opts.ttl : null;
    this.l1.delete(key);
    const rows = await this.sql<{ value: string }[]>`
      WITH up AS (
        INSERT INTO lumibase_cache_entries AS e (key, value, expires_at)
        VALUES (${key}, ${String(by)},
                CASE WHEN ${ttl}::int IS NULL THEN NULL ELSE now() + make_interval(secs => ${ttl}::int) END)
        ON CONFLICT (key) DO UPDATE SET
          value = CASE WHEN e.expires_at IS NOT NULL AND e.expires_at <= now()
                       THEN ${String(by)}
                       ELSE (e.value::numeric + ${by}::numeric)::text END,
          expires_at = CASE WHEN e.expires_at IS NOT NULL AND e.expires_at <= now()
                            THEN EXCLUDED.expires_at ELSE e.expires_at END,
          tags = '{}', tag_generations = '{}',
          version = nextval('lumibase_cache_version_seq')
        RETURNING value
      )
      SELECT up.value, pg_notify(${this.channel}, ${this.keyNotice(key)}) FROM up`;
    const value = Number(rows[0]?.value);
    if (!Number.isFinite(value)) throw new Error(`cache increment produced a non-numeric value for ${key}`);
    return value;
  }

  async addUnique(key: string, member: string, opts?: { ttl?: number }): Promise<void> {
    void this.start();
    const ttl = opts?.ttl && opts.ttl > 0 ? opts.ttl : null;
    // The TTL is fixed by the key's first live member, like Redis EXPIRE NX.
    // A member whose window has ended joins the new window.
    await this.sql`
      INSERT INTO lumibase_cache_unique_members AS m (key, member, expires_at)
      VALUES (
        ${key}, ${member},
        COALESCE(
          (SELECT max(expires_at) FROM lumibase_cache_unique_members WHERE key = ${key} AND expires_at > now()),
          CASE WHEN ${ttl}::int IS NULL THEN NULL ELSE now() + make_interval(secs => ${ttl}::int) END
        )
      )
      ON CONFLICT (key, member) DO UPDATE SET expires_at = EXCLUDED.expires_at
        WHERE m.expires_at IS NOT NULL AND m.expires_at <= now()`;
  }

  async countUnique(key: string): Promise<number> {
    const rows = await this.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM lumibase_cache_unique_members
       WHERE key = ${key} AND (expires_at IS NULL OR expires_at > now())`;
    return rows[0]?.n ?? 0;
  }

  /** Delete expired rows. Expired rows are never served; this only reclaims space. */
  async purgeExpired(): Promise<void> {
    await this.sql`DELETE FROM lumibase_cache_entries WHERE expires_at < now()`;
    await this.sql`DELETE FROM lumibase_cache_unique_members WHERE expires_at < now()`;
  }
}
