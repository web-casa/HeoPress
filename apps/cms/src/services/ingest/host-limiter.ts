import { and, eq, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { ingestHostSlots, type Database } from '@heopress/database';
import { IngestFetchError } from './failure';

/**
 * Per-host politeness (HeoPress P08 task 2.2; spec ingest/crawling "礼貌抓取").
 *
 * Held in the database, not in the process: every CMS process runs the ingest queue workers, so two processes may
 * fetch from the same host at once. A host has `concurrency` slots (`lumibase_ingest_host_slots`); a fetch takes a free
 * slot under a lease and may start only when `minIntervalMs` has passed since the host's last start. Slots are taken
 * under a transaction-scoped advisory lock on the host, so the check and the take are one step across processes. A
 * lease that is never released (the process died) lapses after `leaseMs`.
 *
 * Defaults: 1 request at a time per host, 2 s apart (`HEOPRESS_INGEST_HOST_CONCURRENCY`,
 * `HEOPRESS_INGEST_HOST_INTERVAL_MS`).
 */

export type ReleaseHost = () => Promise<void>;

export interface HostLimiter {
  acquire(host: string, signal?: AbortSignal): Promise<ReleaseHost>;
}

export interface HostLimiterOptions {
  concurrency?: number;
  minIntervalMs?: number;
  leaseMs?: number;
  /** Longest wait for a slot before the fetch fails as `timeout` (retryable). */
  maxWaitMs?: number;
  now?: () => Date;
}

export function hostLimiterOptionsFromEnv(env: Record<string, string | undefined> = process.env): HostLimiterOptions {
  const num = (v: string | undefined, d: number, min: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= min ? Math.floor(n) : d;
  };
  return {
    concurrency: num(env.HEOPRESS_INGEST_HOST_CONCURRENCY, 1, 1),
    minIntervalMs: num(env.HEOPRESS_INGEST_HOST_INTERVAL_MS, 2000, 0),
  };
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

export class DbHostLimiter implements HostLimiter {
  private readonly concurrency: number;
  private readonly minIntervalMs: number;
  private readonly leaseMs: number;
  private readonly maxWaitMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly db: Database,
    opts: HostLimiterOptions = {},
  ) {
    this.concurrency = Math.max(1, opts.concurrency ?? 1);
    this.minIntervalMs = Math.max(0, opts.minIntervalMs ?? 2000);
    this.leaseMs = opts.leaseMs ?? 60_000;
    this.maxWaitMs = opts.maxWaitMs ?? 120_000;
    this.now = opts.now ?? (() => new Date());
  }

  /** One attempt: a release function, or how long to wait before trying again. */
  async tryAcquire(host: string): Promise<{ release: ReleaseHost } | { waitMs: number }> {
    const key = host.toLowerCase();
    const holder = nanoid();
    const outcome = await this.db.transaction(async (tx): Promise<{ waitMs: number } | { slot: number }> => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ingest-host:${key}`}, 0))`);
      const now = this.now();
      const slots = await tx.select().from(ingestHostSlots).where(eq(ingestHostSlots.host, key));
      const lastStart = Math.max(0, ...slots.map((s) => s.lastStartedAt?.getTime() ?? 0));
      const intervalLeft = lastStart + this.minIntervalMs - now.getTime();
      if (intervalLeft > 0) return { waitMs: intervalLeft };
      for (let slot = 0; slot < this.concurrency; slot++) {
        const row = slots.find((s) => s.slot === slot);
        const free = !row || !row.holder || !row.leaseUntil || row.leaseUntil.getTime() <= now.getTime();
        if (!free) continue;
        const values = { host: key, slot, holder, leaseUntil: new Date(now.getTime() + this.leaseMs), lastStartedAt: now };
        await tx
          .insert(ingestHostSlots)
          .values(values)
          .onConflictDoUpdate({ target: [ingestHostSlots.host, ingestHostSlots.slot], set: { holder, leaseUntil: values.leaseUntil, lastStartedAt: now } });
        return { slot };
      }
      const soonest = Math.min(...slots.map((s) => (s.leaseUntil?.getTime() ?? now.getTime()) - now.getTime()));
      return { waitMs: Math.max(50, Math.min(soonest, 1000)) };
    });
    if ('waitMs' in outcome) return { waitMs: outcome.waitMs };
    const slot = outcome.slot;
    return {
      release: async () => {
        await this.db
          .update(ingestHostSlots)
          .set({ holder: null, leaseUntil: null })
          .where(and(eq(ingestHostSlots.host, key), eq(ingestHostSlots.slot, slot), eq(ingestHostSlots.holder, holder)));
      },
    };
  }

  async acquire(host: string, signal?: AbortSignal): Promise<ReleaseHost> {
    const started = Date.now();
    for (;;) {
      const got = await this.tryAcquire(host);
      if ('release' in got) return got.release;
      if (Date.now() - started + got.waitMs > this.maxWaitMs) {
        throw new IngestFetchError('timeout', `host ${host} stayed busy for longer than ${this.maxWaitMs} ms`);
      }
      await sleep(got.waitMs, signal);
    }
  }
}
