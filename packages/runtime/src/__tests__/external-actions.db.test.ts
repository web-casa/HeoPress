import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  DefiniteFailure,
  OutcomeUnknown,
  performExternalAction,
  resolveExternalAction,
  type ExternalActionTarget,
  type RemoteStatus,
} from '../external-actions';
import { PG_URL, connectRuntimeDb, resetRuntimeTables } from './helpers/pg';

/**
 * External action outcomes (P03 tasks 3.4–3.5; spec "外部动作结果状态",
 * scenario "回执丢失且不支持幂等"). Each case scripts a target and counts
 * how often the side effect really reaches it.
 */

interface Scripted {
  target: ExternalActionTarget<string>;
  sends: string[];
}

function scripted(
  outcomes: Array<'ok' | 'timeout' | 'rejected'>,
  opts: { window?: number; status?: () => RemoteStatus } = {},
): Scripted {
  const sends: string[] = [];
  let i = 0;
  return {
    sends,
    target: {
      idempotencyWindowSeconds: opts.window,
      queryStatus: opts.status ? async () => opts.status!() : undefined,
      send: async ({ idempotencyKey }) => {
        sends.push(idempotencyKey);
        const outcome = outcomes[Math.min(i++, outcomes.length - 1)];
        if (outcome === 'timeout') throw new OutcomeUnknown('timed out waiting for the receipt');
        if (outcome === 'rejected') throw new DefiniteFailure('422 rejected');
        return 'receipt';
      },
    },
  };
}

describe.skipIf(!PG_URL)('external actions (PostgreSQL)', () => {
  let sql: postgres.Sql;
  const ref = (key: string) => ({ idempotencyKey: key, kind: 'webhook', target: 'webhook:wh_1', siteId: 'site-a' });

  beforeAll(async () => {
    sql = await connectRuntimeDb(6);
  });
  beforeEach(async () => {
    await resetRuntimeTables(sql);
  });
  afterAll(async () => {
    await sql?.end({ timeout: 1 });
  });

  const stateOf = async (key: string) =>
    (await sql<{ state: string; paused: boolean; attempts: number }[]>`
      SELECT state, paused, attempts FROM lumibase_external_actions WHERE idempotency_key = ${key}`)[0];

  it('a success is sent once and never again', async () => {
    const t = scripted(['ok']);
    expect(await performExternalAction(sql, ref('a1'), t.target)).toMatchObject({ state: 'succeeded', sent: true });
    expect(await performExternalAction(sql, ref('a1'), t.target)).toMatchObject({ state: 'succeeded', sent: false });
    expect(t.sends).toHaveLength(1);
  });

  it('lost receipt, no idempotency, no status query: unknown and paused, never resent', async () => {
    const t = scripted(['timeout', 'ok']);
    expect(await performExternalAction(sql, ref('a2'), t.target)).toMatchObject({ state: 'unknown', paused: false });
    expect(await performExternalAction(sql, ref('a2'), t.target)).toMatchObject({ state: 'unknown', paused: true });
    expect(await performExternalAction(sql, ref('a2'), t.target)).toMatchObject({ state: 'unknown', paused: true });
    expect(t.sends).toHaveLength(1);
    expect(await stateOf('a2')).toMatchObject({ state: 'unknown', paused: true });
  });

  it('a confirmed failure is safe to retry', async () => {
    const t = scripted(['rejected', 'ok']);
    expect(await performExternalAction(sql, ref('a3'), t.target)).toMatchObject({ state: 'failed' });
    expect(await performExternalAction(sql, ref('a3'), t.target)).toMatchObject({ state: 'succeeded', sent: true });
    expect(t.sends).toHaveLength(2);
  });

  it('lost receipt, target dedupes the key: resent with the same key inside the window', async () => {
    const t = scripted(['timeout', 'ok'], { window: 3600 });
    await performExternalAction(sql, ref('a4'), t.target);
    expect(await performExternalAction(sql, ref('a4'), t.target)).toMatchObject({ state: 'succeeded', sent: true });
    expect(t.sends).toEqual(['a4', 'a4']);
  });

  it('lost receipt after the idempotency window expired: paused, not resent', async () => {
    const t = scripted(['timeout', 'ok'], { window: 3600 });
    await performExternalAction(sql, ref('a5'), t.target);
    await sql`UPDATE lumibase_external_actions SET key_expires_at = now() - interval '1 second' WHERE idempotency_key = 'a5'`;
    expect(await performExternalAction(sql, ref('a5'), t.target)).toMatchObject({ state: 'unknown', paused: true });
    expect(t.sends).toHaveLength(1);
  });

  it('authoritative status "not executed": resent; "processing": waited for, not resent, not paused', async () => {
    let status: RemoteStatus = 'processing';
    const t = scripted(['timeout', 'ok'], { status: () => status });
    await performExternalAction(sql, ref('a6'), t.target);
    expect(await performExternalAction(sql, ref('a6'), t.target)).toMatchObject({ state: 'unknown', paused: false });
    expect(t.sends).toHaveLength(1);
    status = 'not_executed';
    expect(await performExternalAction(sql, ref('a6'), t.target)).toMatchObject({ state: 'succeeded', sent: true });
    expect(t.sends).toHaveLength(2);
  });

  it('authoritative status "succeeded": recorded without resending', async () => {
    const t = scripted(['timeout'], { status: () => 'succeeded' });
    await performExternalAction(sql, ref('a7'), t.target);
    expect(await performExternalAction(sql, ref('a7'), t.target)).toMatchObject({ state: 'succeeded', sent: false });
    expect(t.sends).toHaveLength(1);
  });

  it('a crash mid-send reads as unknown, and a concurrent attempt is not duplicated', async () => {
    // Worker A claimed the attempt and is still sending (its lease is live).
    let release!: () => void;
    const slow: ExternalActionTarget<string> = {
      send: () => new Promise((r) => (release = () => r('late receipt'))),
    };
    const first = performExternalAction(sql, ref('a8'), slow);
    await new Promise((r) => setTimeout(r, 100));
    const t = scripted(['ok']);
    expect(await performExternalAction(sql, ref('a8'), t.target)).toMatchObject({ state: 'unknown', paused: false });
    expect(t.sends).toHaveLength(0);
    release();
    expect(await first).toMatchObject({ state: 'succeeded' });

    // Worker B crashed after claiming: state unknown, lease run out.
    await sql`INSERT INTO lumibase_external_actions (idempotency_key, kind, target, state, attempts, in_flight_until)
              VALUES ('a9', 'webhook', 'webhook:wh_1', 'unknown', 1, now() - interval '1 second')`;
    expect(await performExternalAction(sql, ref('a9'), t.target)).toMatchObject({ state: 'unknown', paused: true });
    expect(t.sends).toHaveLength(0);
  });

  it('a late outcome from an expired attempt never overwrites a newer one (Codex review 2, #1)', async () => {
    // Attempt 1 hangs past its lease; attempt 2 is told "not executed",
    // resends and succeeds; then attempt 1 finally fails.
    let failLate!: () => void;
    const hanging: ExternalActionTarget<string> = {
      send: () => new Promise((_, reject) => (failLate = () => reject(new DefiniteFailure('late 422')))),
    };
    const first = performExternalAction(sql, { ...ref('c1'), attemptTimeoutSeconds: 1 }, hanging);
    await new Promise((r) => setTimeout(r, 1200)); // lease expired
    const t = scripted(['ok'], { status: () => 'not_executed' });
    expect(await performExternalAction(sql, ref('c1'), t.target)).toMatchObject({ state: 'succeeded', sent: true });
    failLate();
    await first;
    expect(await stateOf('c1')).toMatchObject({ state: 'succeeded' });
    expect(await performExternalAction(sql, ref('c1'), t.target)).toMatchObject({ state: 'succeeded', sent: false });
    expect(t.sends).toHaveLength(1);
  });

  it('two workers recovering the same unknown action: only one queries and resends (Codex review 2, #2)', async () => {
    await sql`INSERT INTO lumibase_external_actions (idempotency_key, kind, target, state, attempts)
              VALUES ('c2', 'webhook', 'webhook:wh_1', 'unknown', 1)`;
    let queries = 0;
    const sends: string[] = [];
    const target: ExternalActionTarget<string> = {
      queryStatus: async () => {
        queries += 1;
        await new Promise((r) => setTimeout(r, 100));
        return 'not_executed';
      },
      send: async ({ idempotencyKey }) => {
        sends.push(idempotencyKey);
        throw new OutcomeUnknown('receipt lost again');
      },
    };
    const results = await Promise.all([performExternalAction(sql, ref('c2'), target), performExternalAction(sql, ref('c2'), target)]);
    expect(sends).toHaveLength(1);
    expect(queries).toBe(1);
    expect(results.map((r) => r.state)).toEqual(['unknown', 'unknown']);
  });

  it('a worker whose lease ran out during a slow status query never sends (Codex review 3, #1)', async () => {
    await sql`INSERT INTO lumibase_external_actions (idempotency_key, kind, target, state, attempts)
              VALUES ('c3', 'webhook', 'webhook:wh_1', 'unknown', 1)`;
    const sends: number[] = [];
    let slow = true;
    const target: ExternalActionTarget<string> = {
      queryStatus: async () => {
        if (slow) {
          slow = false;
          await new Promise((r) => setTimeout(r, 2500)); // past the 1 s lease
        }
        return 'not_executed';
      },
      send: async ({ attempt }) => {
        sends.push(attempt);
        return 'receipt';
      },
    };
    const short = { ...ref('c3'), attemptTimeoutSeconds: 1 };
    const a = performExternalAction(sql, short, target);
    await new Promise((r) => setTimeout(r, 1200)); // A's lease expired
    const b = await performExternalAction(sql, short, target);
    const aResult = await a;
    // A's query was cut off at half its lease, so A never acted on the stale "not executed".
    expect(sends.length).toBeLessThanOrEqual(1);
    expect(aResult.state).not.toBe('succeeded');
    expect(b.state === 'succeeded' ? sends : []).toHaveLength(b.state === 'succeeded' ? 1 : 0);
  });

  it('the lease guard itself: an attempt that lost its lease does not send', async () => {
    await sql`INSERT INTO lumibase_external_actions (idempotency_key, kind, target, state, attempts)
              VALUES ('c4', 'webhook', 'webhook:wh_1', 'unknown', 1)`;
    const sends: number[] = [];
    const target: ExternalActionTarget<string> = {
      // Answers inside the deadline, but the lease is taken away meanwhile.
      queryStatus: async () => {
        await sql`UPDATE lumibase_external_actions SET in_flight_until = now() - interval '1 second' WHERE idempotency_key = 'c4'`;
        return 'not_executed';
      },
      send: async ({ attempt }) => {
        sends.push(attempt);
        return 'receipt';
      },
    };
    expect(await performExternalAction(sql, ref('c4'), target)).toMatchObject({ state: 'unknown', paused: false });
    expect(sends).toEqual([]);
  });

  it('a lease renewal whose answer arrives late never leads to a send (Codex review 4, #6)', async () => {
    // A pool whose answer to the renewal UPDATE is delayed past the lease.
    const slowRenewal = new Proxy(sql, {
      apply(targetFn, thisArg, args: [TemplateStringsArray, ...unknown[]]) {
        const q = Reflect.apply(targetFn, thisArg, args) as Promise<unknown>;
        const text = args[0]?.join?.('') ?? '';
        if (text.includes('SET in_flight_until = now() + make_interval') && text.includes("state = 'unknown'") && !text.includes('attempts + 1')) {
          return q.then(async (r) => {
            await new Promise((res) => setTimeout(res, 1300));
            return r;
          });
        }
        return q;
      },
    }) as typeof sql;
    const sends: number[] = [];
    const target: ExternalActionTarget<string> = {
      send: async ({ attempt }) => {
        sends.push(attempt);
        return 'receipt';
      },
    };
    const short = { ...ref('c5'), attemptTimeoutSeconds: 1 };
    const a = performExternalAction(slowRenewal, short, target);
    await new Promise((r) => setTimeout(r, 1150)); // A's renewed lease has run out in the database
    const t = scripted(['ok'], { status: () => 'not_executed' });
    const b = await performExternalAction(sql, short, t.target);
    const aResult = await a;
    expect(sends).toEqual([]); // A never sent
    expect(aResult.state).toBe('unknown');
    expect(b).toMatchObject({ state: 'succeeded', sent: true });
    expect(t.sends).toHaveLength(1);
  });

  it('manual reconciliation settles a paused action', async () => {
    const t = scripted(['timeout', 'ok']);
    await performExternalAction(sql, ref('b1'), t.target);
    await performExternalAction(sql, ref('b1'), t.target); // pauses
    expect(await resolveExternalAction(sql, 'b1', 'not_executed', 'ops@example.com')).toBe(true);
    expect(await performExternalAction(sql, ref('b1'), t.target)).toMatchObject({ state: 'succeeded', sent: true });
    expect(t.sends).toHaveLength(2);

    const u = scripted(['timeout']);
    await performExternalAction(sql, ref('b2'), u.target);
    await performExternalAction(sql, ref('b2'), u.target);
    expect(await resolveExternalAction(sql, 'b2', 'succeeded', 'ops@example.com')).toBe(true);
    expect(await performExternalAction(sql, ref('b2'), u.target)).toMatchObject({ state: 'succeeded', sent: false });
    expect(u.sends).toHaveLength(1);
  });
});
