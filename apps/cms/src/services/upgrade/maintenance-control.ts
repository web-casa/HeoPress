/**
 * The owner side of the maintenance switch (HeoPress P13 tasks 2.1, 2.3): turning maintenance on and off and waiting
 * for every HeoPress process to drain (see `services/maintenance/write-gate.ts` for the process side).
 *
 * Drained means both:
 * - every live process (one that acknowledged in the last `livenessMs`) acknowledged the current epoch frozen, with
 *   its freeze hooks done and no write in flight; and
 * - no other session of this database holds a write transaction (`backend_xid` set) — the database's own view, which
 *   also catches a writer outside the gate.
 * The upgrade's own sessions identify themselves with `application_name = heopress-upgrade` and are not counted.
 */
import type { MaintenanceControlPort } from './ports';

export const UPGRADE_APPLICATION_NAME = 'heopress-upgrade';

/** The postgres.js tagged-template shape used here (a `postgres.Sql`). */
export type ControlSql = <T extends readonly object[] = Record<string, unknown>[]>(
  strings: TemplateStringsArray,
  ...values: unknown[]
) => PromiseLike<T>;

/** Server or client codes of a session that ended under the statement (terminated, shut down, socket closed). */
const CONNECTION_LOST = new Set(['57P01', '57P02', '57P03', 'CONNECTION_CLOSED', 'CONNECTION_ENDED', 'CONNECTION_DESTROYED', 'ECONNRESET', 'EPIPE']);

export function isConnectionLost(err: unknown): boolean {
  const code = err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
  return typeof code === 'string' && CONNECTION_LOST.has(code);
}

/**
 * The control statements run again on a new session when theirs was terminated: backups and restores of the
 * database terminate every session of it (`pg_terminate_backend`, `DROP DATABASE … WITH (FORCE)`), the upgrade's own
 * included, and the first statement after that fails with 57P01. Every control statement can run twice: `enter` is
 * conditional on the same upgrade (a repeat only advances the epoch), the others set absolute values or only read.
 */
function retryingSql(sql: ControlSql, sleep: (ms: number) => Promise<void>, attempts = 3): ControlSql {
  return (async <T extends readonly object[]>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T> => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await sql<T>(strings, ...values);
      } catch (err) {
        if (attempt >= attempts || !isConnectionLost(err)) throw err;
        await sleep(50 * attempt);
      }
    }
  }) as ControlSql;
}

export interface MaintenanceControlOptions {
  /** Owner connection to production. */
  sql: ControlSql;
  /** A process silent for longer is treated as gone (default 30 s; processes acknowledge at least every 5 s). */
  livenessMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class MaintenanceControl implements MaintenanceControlPort {
  private readonly sql: ControlSql;
  private readonly livenessMs: number;
  private readonly pollMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(options: MaintenanceControlOptions) {
    this.livenessMs = options.livenessMs ?? 30_000;
    this.pollMs = options.pollMs ?? 250;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.sql = retryingSql(options.sql, this.sleep);
    this.now = options.now ?? Date.now;
  }

  async enter(info: { upgradeId: string; fromVersion: string; toVersion: string }): Promise<number> {
    const rows = await this.sql<Array<{ epoch: string | number }>>`
      INSERT INTO lumibase_maintenance (id, active, epoch, reason, upgrade_id, from_version, to_version, step, started_at, updated_at)
      VALUES (1, true, 1, 'upgrade', ${info.upgradeId}, ${info.fromVersion}, ${info.toVersion}, 'drain', now(), now())
      ON CONFLICT (id) DO UPDATE
        SET active = true, epoch = lumibase_maintenance.epoch + 1, reason = 'upgrade', upgrade_id = EXCLUDED.upgrade_id,
            from_version = EXCLUDED.from_version, to_version = EXCLUDED.to_version, step = 'drain',
            started_at = CASE WHEN lumibase_maintenance.active THEN lumibase_maintenance.started_at ELSE now() END,
            updated_at = now()
        WHERE lumibase_maintenance.active = false OR lumibase_maintenance.upgrade_id = EXCLUDED.upgrade_id
      RETURNING epoch`;
    if (!rows[0]) {
      const held = await this.state();
      throw new Error(`maintenance is already on for upgrade ${held.upgradeId ?? '(unknown)'}; finish or roll back that one first`);
    }
    return Number(rows[0].epoch);
  }

  async step(step: string): Promise<void> {
    await this.sql`UPDATE lumibase_maintenance SET step = ${step}, updated_at = now() WHERE id = 1`;
  }

  async exit(upgradeId: string): Promise<void> {
    await this.sql`
      UPDATE lumibase_maintenance
         SET active = false, epoch = epoch + 1, step = NULL, started_at = NULL, updated_at = now()
       WHERE id = 1 AND active AND upgrade_id = ${upgradeId}`;
  }

  async state(): Promise<{ active: boolean; upgradeId: string | null }> {
    const rows = await this.sql<Array<{ active: boolean; upgrade_id: string | null }>>`
      SELECT active, upgrade_id FROM lumibase_maintenance WHERE id = 1`;
    return { active: rows[0]?.active === true, upgradeId: rows[0]?.upgrade_id ?? null };
  }

  /** What still holds the drain up now (empty: drained). */
  async pending(epoch: number): Promise<string[]> {
    const waiting: string[] = [];
    const acks = await this.sql<Array<{ process_id: string; process_role: string; epoch: string | number; frozen: boolean; inflight: number }>>`
      SELECT process_id, process_role, epoch, frozen, inflight FROM lumibase_maintenance_acks
       WHERE seen_at > now() - make_interval(secs => ${this.livenessMs / 1000})
       ORDER BY process_id`;
    for (const a of acks) {
      if (Number(a.epoch) !== epoch) waiting.push(`process ${a.process_id} (${a.process_role}) has not seen the freeze yet`);
      else if (!a.frozen) waiting.push(`process ${a.process_id} (${a.process_role}) is still pausing its workers`);
      else if (a.inflight > 0) waiting.push(`process ${a.process_id} (${a.process_role}) has ${a.inflight} write(s) in flight`);
    }
    const writers = await this.sql<Array<{ pid: number; usename: string | null; application_name: string | null }>>`
      SELECT pid, usename, application_name FROM pg_stat_activity
       WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_xid IS NOT NULL
         AND coalesce(application_name, '') <> ${UPGRADE_APPLICATION_NAME}`;
    for (const w of writers) waiting.push(`session ${w.pid} (${w.usename ?? 'unknown role'}${w.application_name ? `, ${w.application_name}` : ''}) has an open write transaction`);
    return waiting;
  }

  async drain(epoch: number, timeoutMs: number): Promise<{ ok: boolean; waitingFor: string[] }> {
    const deadline = this.now() + timeoutMs;
    let waiting: string[] = [];
    for (;;) {
      waiting = await this.pending(epoch);
      if (waiting.length === 0) return { ok: true, waitingFor: [] };
      if (this.now() >= deadline) return { ok: false, waitingFor: waiting };
      await this.sleep(this.pollMs);
    }
  }
}

/** The installed plugins and their declared HeoPress range (for the compatibility check). */
export async function listInstalledPlugins(
  sql: ControlSql,
): Promise<Array<{ siteId: string | null; name: string; enabled: boolean; manifest: { heopress?: string; compatibleWith?: string } }>> {
  const rows = await sql<Array<{ site_id: string | null; name: string; enabled: boolean; manifest: unknown }>>`
    SELECT site_id, name, enabled, manifest FROM lumibase_extensions ORDER BY name, site_id`;
  return rows.map((r) => {
    const m = r.manifest && typeof r.manifest === 'object' ? (r.manifest as Record<string, unknown>) : {};
    const manifest: { heopress?: string; compatibleWith?: string } = {};
    if (typeof m.heopress === 'string') manifest.heopress = m.heopress;
    if (typeof m.compatibleWith === 'string') manifest.compatibleWith = m.compatibleWith;
    return { siteId: r.site_id, name: r.name, enabled: r.enabled, manifest };
  });
}
