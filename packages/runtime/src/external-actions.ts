/**
 * Side effects in other systems: send at most as often as is safe, and stop
 * for a human when the outcome cannot be known (HeoPress P03 tasks 3.4–3.5;
 * design "故障语义"; spec "外部动作结果状态").
 *
 * The queue delivers jobs at least once, so a handler that calls a webhook,
 * starts a deployment or sends a notification may run again after a crash or
 * a timeout. `performExternalAction` records every action in
 * `lumibase_external_actions` under its idempotency key and decides, from the
 * recorded state and what the target supports, whether sending is safe:
 *
 *   state       | what happens on the next attempt
 *   ------------|---------------------------------------------------------------
 *   not_sent    | send
 *   failed      | send again (the target confirmed it did not execute)
 *   succeeded   | nothing; the action is done
 *   unknown     | another attempt in flight            → wait (no send, no pause)
 *               | target status query says…
 *               |   not executed / failed              → send again
 *               |   processing                         → wait
 *               |   succeeded                          → record success, no send
 *               | target dedupes this key and the key
 *               |   is still inside its window         → send again, same key
 *               | otherwise                            → pause for reconciliation
 *
 * The row is set to `unknown` *before* sending, so a crash mid-send is
 * indistinguishable from a lost receipt — the safe reading.
 *
 * Every attempt holds a lease (`attemptTimeoutSeconds`). A status query may
 * use at most half of it, and a worker sends only after renewing a lease it
 * still holds; a worker whose lease ran out while it waited never sends,
 * because another worker may already have taken over. `send` receives a
 * signal that aborts when what is left of the lease runs out and must stop
 * by then; if renewing the lease took more than half of it, nothing is sent. A local unique key
 * is not an exactly-once guarantee across systems; only the target's own
 * idempotency or status can settle `unknown`.
 */
import type postgres from 'postgres';

/** The target confirmed the action did not take effect; retrying is safe. */
export class DefiniteFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DefiniteFailure';
  }
}

/** The action may or may not have taken effect: a timeout, a lost receipt. */
export class OutcomeUnknown extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutcomeUnknown';
  }
}

export type RemoteStatus = 'not_executed' | 'processing' | 'succeeded' | 'failed' | 'unknown';

export interface ExternalActionTarget<R> {
  /**
   * Perform the action. Throw `DefiniteFailure` only when the target confirms
   * it did not execute (e.g. connection refused before anything was sent, a
   * 4xx that rejects the request). Any other error counts as `OutcomeUnknown`.
   */
  send(ctx: { idempotencyKey: string; attempt: number; signal: AbortSignal }): Promise<R>;
  /** The target dedupes repeats of the same key for this long. */
  idempotencyWindowSeconds?: number;
  /** Ask the target what became of this key. */
  queryStatus?(idempotencyKey: string, signal: AbortSignal): Promise<RemoteStatus>;
}

export interface ExternalActionRef {
  idempotencyKey: string;
  kind: string;
  /** What is addressed, without secrets. */
  target: string;
  siteId?: string | null;
  /** How long one attempt may take before others treat it as stalled (default 120 s). */
  attemptTimeoutSeconds?: number;
}

export type ExternalActionResult<R> =
  | { state: 'succeeded'; sent: boolean; result?: R }
  | { state: 'failed'; error: string }
  | { state: 'unknown'; paused: boolean; reason: string };

interface Row {
  state: 'not_sent' | 'failed' | 'succeeded' | 'unknown';
  paused: boolean;
  attempts: number;
  in_flight: boolean;
  key_live: boolean;
}

export async function performExternalAction<R>(
  sql: postgres.Sql,
  ref: ExternalActionRef,
  target: ExternalActionTarget<R>,
): Promise<ExternalActionResult<R>> {
  const lease = Math.max(1, ref.attemptTimeoutSeconds ?? 120);
  await sql`
    INSERT INTO lumibase_external_actions (idempotency_key, site_id, kind, target)
    VALUES (${ref.idempotencyKey}, ${ref.siteId ?? null}, ${ref.kind}, ${ref.target})
    ON CONFLICT (idempotency_key) DO NOTHING`;

  const [row] = await sql<Row[]>`
    SELECT state, paused, attempts,
           COALESCE(in_flight_until > now(), false) AS in_flight,
           COALESCE(key_expires_at > now(), false) AS key_live
      FROM lumibase_external_actions WHERE idempotency_key = ${ref.idempotencyKey}`;
  if (!row) throw new Error(`external action ${ref.idempotencyKey} vanished`);

  if (row.state === 'succeeded') return { state: 'succeeded', sent: false };
  if (row.paused) return { state: 'unknown', paused: true, reason: 'awaiting manual reconciliation' };
  if (row.in_flight) return { state: 'unknown', paused: false, reason: 'an attempt is in flight' };

  // Claim the next attempt before deciding anything: only the worker whose
  // claim moved `attempts` from the value it observed acts, and every later
  // write is fenced on that attempt number, so a slow or stale worker can
  // neither resend on an outdated decision nor overwrite a newer outcome.
  const mine = await claim(sql, ref.idempotencyKey, row.attempts, lease, target.idempotencyWindowSeconds);
  if (mine === null) return { state: 'unknown', paused: false, reason: 'another worker took this attempt' };

  if (row.state === 'unknown') {
    if (target.queryStatus) {
      // Bounded: a slow answer counts as no answer, so the lease cannot
      // run out while this worker still means to act on it.
      const status = await withDeadline(
        (signal) => target.queryStatus!(ref.idempotencyKey, signal),
        (lease * 1000) / 2,
      ).catch((): RemoteStatus => 'unknown');
      if (status === 'succeeded') {
        await settle(sql, ref.idempotencyKey, mine, 'succeeded', null);
        return { state: 'succeeded', sent: false };
      }
      if (status === 'processing') {
        await settle(sql, ref.idempotencyKey, mine, 'unknown', 'the target is still processing');
        return { state: 'unknown', paused: false, reason: 'the target is still processing' };
      }
      if (status === 'not_executed' || status === 'failed') return send(sql, ref, target, mine, row.state);
    }
    if (target.idempotencyWindowSeconds && row.key_live) return send(sql, ref, target, mine, row.state);
    await sql`
      UPDATE lumibase_external_actions SET paused = true, in_flight_until = NULL, updated_at = now()
       WHERE idempotency_key = ${ref.idempotencyKey} AND attempts = ${mine}`;
    return { state: 'unknown', paused: true, reason: 'outcome unknown and the target cannot confirm it' };
  }

  return send(sql, ref, target, mine, row.state);
}

/**
 * Take the next attempt if nobody else did since `observed` was read. The row
 * becomes `unknown` with a lease; returns the attempt number, or null.
 */
async function claim(
  sql: postgres.Sql,
  key: string,
  observed: number,
  lease: number,
  idempotencyWindowSeconds: number | undefined,
): Promise<number | null> {
  const rows = await sql<{ attempts: number }[]>`
    UPDATE lumibase_external_actions
       SET state = 'unknown', attempts = attempts + 1,
           in_flight_until = now() + make_interval(secs => ${lease}),
           key_expires_at = CASE
             WHEN ${idempotencyWindowSeconds ?? null}::int IS NULL THEN NULL
             WHEN key_expires_at IS NULL THEN now() + make_interval(secs => ${idempotencyWindowSeconds ?? 0}::int)
             ELSE key_expires_at END,
           updated_at = now()
     WHERE idempotency_key = ${key} AND attempts = ${observed} AND NOT paused AND state <> 'succeeded'
       AND (in_flight_until IS NULL OR in_flight_until <= now())
     RETURNING attempts`;
  return rows[0]?.attempts ?? null;
}

function withDeadline<T>(run: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new OutcomeUnknown(`no answer within ${ms} ms`));
    }, ms);
  });
  return Promise.race([run(controller.signal), deadline]).finally(() => clearTimeout(timer));
}

async function send<R>(
  sql: postgres.Sql,
  ref: ExternalActionRef,
  target: ExternalActionTarget<R>,
  attempt: number,
  /** State before this attempt claimed the row, restored if nothing is sent. */
  prior: Row['state'],
): Promise<ExternalActionResult<R>> {
  // Renew the lease, but only if this attempt still holds it: after a slow
  // status query another worker may own the action, and sending now would
  // duplicate its side effect.
  const lease = Math.max(1, ref.attemptTimeoutSeconds ?? 120);
  // The renewed lease starts when the database runs the UPDATE, which is no
  // later than now: measure from here, so a slow answer shortens what is
  // left instead of extending it (Codex review 4, #6).
  const renewalIssued = Date.now();
  const renewed = await sql`
    UPDATE lumibase_external_actions
       SET in_flight_until = now() + make_interval(secs => ${lease}), updated_at = now()
     WHERE idempotency_key = ${ref.idempotencyKey} AND attempts = ${attempt}
       AND in_flight_until > now() AND NOT paused AND state = 'unknown'
     RETURNING 1`;
  if (renewed.length === 0) return { state: 'unknown', paused: false, reason: 'the attempt lease expired before sending; not sent' };
  const remainingMs = lease * 1000 - (Date.now() - renewalIssued);
  if (remainingMs < (lease * 1000) / 2) {
    // The answer took so long that another worker may take over before we
    // could finish: do not start the side effect.
    await settle(sql, ref.idempotencyKey, attempt, prior, 'lease renewal answered too late; not sent');
    return { state: 'unknown', paused: false, reason: 'lease renewal answered too late; not sent' };
  }
  try {
    const result = await withDeadline(
      (signal) => target.send({ idempotencyKey: ref.idempotencyKey, attempt, signal }),
      remainingMs,
    );
    await settle(sql, ref.idempotencyKey, attempt, 'succeeded', null);
    return { state: 'succeeded', sent: true, result };
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 2000);
    if (err instanceof DefiniteFailure) {
      await settle(sql, ref.idempotencyKey, attempt, 'failed', message);
      return { state: 'failed', error: message };
    }
    await settle(sql, ref.idempotencyKey, attempt, 'unknown', message);
    return { state: 'unknown', paused: false, reason: message };
  }
}

/** Record an outcome for `attempt` only; a newer attempt's outcome is never overwritten. */
async function settle(sql: postgres.Sql, key: string, attempt: number, state: Row['state'], error: string | null): Promise<void> {
  const rows = await sql`
    UPDATE lumibase_external_actions
       SET state = ${state}, last_error = ${error}, in_flight_until = NULL, updated_at = now()
     WHERE idempotency_key = ${key} AND attempts = ${attempt}
     RETURNING 1`;
  if (rows.length === 0) {
    console.warn(`[external-action] ${key}: outcome "${state}" of attempt ${attempt} arrived after a newer attempt; not recorded`);
  }
}

/**
 * Settle a paused action after checking with the other side by hand:
 * `succeeded` closes it; `not_executed` lets the next attempt send it.
 */
export async function resolveExternalAction(
  sql: postgres.Sql,
  idempotencyKey: string,
  resolution: 'succeeded' | 'not_executed',
  resolvedBy: string,
): Promise<boolean> {
  const rows = await sql`
    UPDATE lumibase_external_actions
       SET state = ${resolution === 'succeeded' ? 'succeeded' : 'not_sent'},
           paused = false, in_flight_until = NULL, resolved_by = ${resolvedBy}, updated_at = now()
     WHERE idempotency_key = ${idempotencyKey} AND state = 'unknown'
       AND (in_flight_until IS NULL OR in_flight_until <= now())
     RETURNING 1`;
  return rows.length > 0;
}
