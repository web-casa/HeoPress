/**
 * The process write gate (HeoPress P13 tasks 2.1, 2.3; spec ops/upgrades "升级写入冻结与数据不丢失").
 *
 * Every HeoPress process (web, worker, all) runs one gate. It polls the maintenance switch (`lumibase_maintenance`,
 * set only by the upgrade command as the table owner) and, while maintenance is on:
 *
 * - refuses new writes: REST, Studio and MCP requests (`withWriteGate`), scheduled jobs (`scheduledJob`'s gate), event
 *   consumer passes and Astro passes ask `enter()` first and get `null`;
 * - runs the freeze hooks once per epoch: the queue workers stop fetching and wait for their active jobs, buffered
 *   audit entries are written;
 * - reports in `lumibase_maintenance_acks`: the epoch it has seen, whether its freeze hooks finished and how many
 *   writes it still has in flight. The upgrade waits until every live process reports the current epoch frozen with
 *   nothing in flight before it takes the final backup.
 *
 * The gate fails safe: a poll that cannot read the switch keeps the last state it read (a frozen process stays
 * frozen), and until the switch has been read once the process refuses writes, so a process that starts during an
 * upgrade and cannot read the switch at first does not write while it is invisible to the drain. A process starts
 * with one poll before it registers any worker, so a process started during maintenance never writes. A database
 * without the switch table (before migration 0120) has no upgrade to wait for: the gate is open.
 */
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

/** The postgres.js tagged-template shape the gate needs (a `postgres.Sql`). */
export type GateSql = <T extends readonly object[] = Record<string, unknown>[]>(
  strings: TemplateStringsArray,
  ...values: unknown[]
) => PromiseLike<T>;

export interface MaintenanceSnapshot {
  active: boolean;
  epoch: number;
  reason: string | null;
  step: string | null;
  toVersion: string | null;
  startedAt: string | null;
}

const INACTIVE: MaintenanceSnapshot = { active: false, epoch: 0, reason: null, step: null, toVersion: null, startedAt: null };

export interface WriteGateOptions {
  sql: GateSql;
  /** `web`, `worker` or `all`. */
  processRole: string;
  /** How often the switch is read (default 1000 ms). */
  pollMs?: number;
  /** An unchanged acknowledgement is written again after this long, as the liveness heartbeat (default 5000 ms). */
  heartbeatMs?: number;
  processId?: string;
  log?: (message: string) => void;
}

type Hook = () => Promise<void> | void;

export class WriteGate {
  readonly processId: string;
  private readonly sql: GateSql;
  private readonly processRole: string;
  private readonly pollMs: number;
  private readonly heartbeatMs: number;
  private readonly log: (message: string) => void;
  private state: MaintenanceSnapshot = INACTIVE;
  private inflight = 0;
  /** The epoch whose freeze (or thaw) hooks have all finished. */
  private settledEpoch = -1;
  private readonly freezeHooks: Hook[] = [];
  private readonly thawHooks: Hook[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private polling: Promise<void> | null = null;
  private lastAck: { epoch: number; frozen: boolean; inflight: number; at: number } | null = null;
  private readFailed = false;
  /** Whether the switch has been read at least once. */
  private known = false;

  constructor(options: WriteGateOptions) {
    this.sql = options.sql;
    this.processRole = options.processRole;
    this.pollMs = options.pollMs ?? 1000;
    this.heartbeatMs = options.heartbeatMs ?? 5000;
    this.processId = options.processId ?? `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
    this.log = options.log ?? ((m) => console.warn(`[maintenance] ${m}`));
  }

  /** Whether writes are refused now. */
  isFrozen(): boolean {
    return !this.known || this.state.active;
  }

  snapshot(): MaintenanceSnapshot {
    return { ...this.state };
  }

  /**
   * Start one write. Returns the function that ends it, or null while writes are frozen (the caller must not write).
   * The returned function is idempotent.
   */
  enter(): (() => void) | null {
    if (this.isFrozen()) return null;
    this.inflight += 1;
    let left = false;
    return () => {
      if (left) return;
      left = true;
      this.inflight -= 1;
      // The last write of a draining process: tell the upgrade now instead of at the next poll.
      if (this.state.active && this.inflight === 0) void this.poll();
    };
  }

  /** Run on every freeze, after new writes are refused (e.g. pause the queue workers). */
  onFreeze(hook: Hook): void {
    this.freezeHooks.push(hook);
  }

  /** Run when maintenance ends (e.g. resume the queue workers). */
  onThaw(hook: Hook): void {
    this.thawHooks.push(hook);
  }

  /** Read the switch once, then keep polling. */
  async start(): Promise<void> {
    await this.poll();
    this.timer = setInterval(() => void this.poll(), this.pollMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.polling?.catch(() => {});
    try {
      await this.sql`DELETE FROM lumibase_maintenance_acks WHERE process_id = ${this.processId}`;
    } catch {
      /* the upgrade treats a silent process as gone after its liveness window */
    }
  }

  /** One poll: read the switch, settle the hooks for a new epoch, acknowledge. Concurrent calls share one run. */
  poll(): Promise<void> {
    if (!this.polling) {
      this.polling = this.pollOnce().finally(() => {
        this.polling = null;
      });
    }
    return this.polling;
  }

  private async pollOnce(): Promise<void> {
    let rows: Array<Record<string, unknown>>;
    try {
      rows = [
        ...(await this.sql<Array<Record<string, unknown>>>`
          SELECT active, epoch, reason, step, to_version, started_at FROM lumibase_maintenance WHERE id = 1`),
      ];
      if (this.readFailed) this.log('maintenance switch readable again');
      this.readFailed = false;
    } catch (err) {
      if (!this.known && (err as { code?: unknown } | null)?.code === '42P01') {
        // No switch table yet (a database before migration 0120): nothing can turn maintenance on.
        this.known = true;
        this.log('no maintenance switch in this database (migration 0120 not applied); writes are not gated');
        return;
      }
      // Keep the last state: a frozen process stays frozen until it can read the switch again (and a process that
      // never read it stays closed).
      if (!this.readFailed) this.log(`cannot read the maintenance switch (${err instanceof Error ? err.name : 'error'}); keeping the last state`);
      this.readFailed = true;
      return;
    }
    const row = rows[0];
    const next: MaintenanceSnapshot = row
      ? {
          active: row.active === true,
          epoch: Number(row.epoch ?? 0),
          reason: (row.reason as string | null) ?? null,
          step: (row.step as string | null) ?? null,
          toVersion: (row.to_version as string | null) ?? null,
          startedAt: row.started_at ? new Date(row.started_at as string | Date).toISOString() : null,
        }
      : INACTIVE;
    const changed = next.epoch !== this.state.epoch || next.active !== this.state.active;
    this.state = next;
    this.known = true;
    if (changed || this.settledEpoch !== next.epoch) {
      const hooks = next.active ? this.freezeHooks : this.thawHooks;
      const results = await Promise.allSettled(hooks.map(async (h) => h()));
      const failed = results.filter((r) => r.status === 'rejected').length;
      // Settled only when every hook finished: a failed freeze hook keeps the process from acknowledging, and the
      // next poll tries again.
      if (failed === 0 && this.state.epoch === next.epoch && this.state.active === next.active) this.settledEpoch = next.epoch;
      else if (failed > 0) this.log(`${failed} ${next.active ? 'freeze' : 'thaw'} hook(s) failed; retrying`);
    }
    await this.acknowledge();
  }

  private async acknowledge(): Promise<void> {
    const epoch = this.state.epoch;
    const frozen = this.state.active && this.settledEpoch === epoch;
    const inflight = this.inflight;
    const now = Date.now();
    const last = this.lastAck;
    if (last && last.epoch === epoch && last.frozen === frozen && last.inflight === inflight && now - last.at < this.heartbeatMs) return;
    try {
      await this.sql`
        INSERT INTO lumibase_maintenance_acks (process_id, process_role, epoch, frozen, inflight, seen_at)
        VALUES (${this.processId}, ${this.processRole}, ${epoch}, ${frozen}, ${inflight}, now())
        ON CONFLICT (process_id) DO UPDATE
          SET epoch = EXCLUDED.epoch, frozen = EXCLUDED.frozen, inflight = EXCLUDED.inflight, seen_at = now()`;
      this.lastAck = { epoch, frozen, inflight, at: now };
    } catch {
      /* acknowledged at the next poll */
    }
  }
}

let processGate: WriteGate | null = null;

/** The gate of this process (null outside the Node server, e.g. in unit tests of the app). */
export function processWriteGate(): WriteGate | null {
  return processGate;
}

export function setProcessWriteGate(gate: WriteGate | null): void {
  processGate = gate;
}
