import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { eventConsumerFailures, eventConsumers, sites, type Database } from '@heopress/database';
import { EventConsumerRunner, UnknownOutcomeError, type ChangeEvent, type EventConsumerDefinition } from '../consumer-runner';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../../__tests__/helpers/db-harness';

/**
 * The event consumption framework (HeoPress P04 tasks 8.2, 9.1; specs
 * platform/event-consumption, content/change-events "晚提交事件不被跳过"):
 * commit order with late commits read late (not skipped), crash recovery
 * without repeating side effects, retries then a dead letter that does not
 * block later events, unknown outcomes parked for a person, and site scope.
 */

const SITE = 'site_consumers_it';
const OTHER = 'site_consumers_other_it';

describe.skipIf(!hasDbIntegrationUrl)('event consumers — DB integration', () => {
  let db: Database;
  let raw: postgres.Sql;
  let n = 0;
  const consumerName = (label: string) => `test:${label}:${++n}:${Date.now()}`;

  beforeAll(async () => {
    db = await connectDbIntegration('event-consumers');
    raw = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => {} });
  });
  afterAll(async () => {
    if (db) {
      await db.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
      await db.delete(sites).where(eq(sites.id, OTHER)).catch(() => undefined);
      await db.execute(sql`DELETE FROM lumibase_event_consumers WHERE name LIKE 'test:%'`);
    }
    await raw?.end({ timeout: 1 });
  });

  beforeEach(async () => {
    for (const id of [SITE, OTHER]) {
      await db.delete(sites).where(eq(sites.id, id));
      await db.insert(sites).values({ id, name: id });
    }
  });

  /** Write one event in its own transaction (or in `tx`). */
  async function emit(itemId: string, site = SITE, tx: postgres.Sql | postgres.TransactionSql = raw): Promise<void> {
    await tx`INSERT INTO lumibase_cdc_change_events (id, site_id, collection, item_id, operation, actor_type, source)
             VALUES (${`ev_${itemId}_${Math.random().toString(36).slice(2, 8)}`}, ${site}, 'articles', ${itemId}, 'update', 'system', 'system')`;
  }

  function consumer(label: string, handle: EventConsumerDefinition['handle'], extra: Partial<EventConsumerDefinition> = {}) {
    return { name: consumerName(label), siteId: SITE, startFrom: 'head' as const, retryBaseMs: 0, handle, ...extra };
  }

  it('reads in commit order, and a transaction that commits late is read late — never skipped', async () => {
    const seen: string[] = [];
    const def = consumer('late', async (e) => {
      seen.push(e.itemId);
    });
    const runner = new EventConsumerRunner(db);
    await runner.register(def);

    // A starts and writes first, B writes and commits first.
    let commitA!: () => void;
    const aCommitted = raw.begin(async (tx) => {
      await emit('A', SITE, tx);
      await new Promise<void>((resolve) => (commitA = resolve));
    });
    await new Promise((r) => setTimeout(r, 100));
    await emit('B');

    // A is still open: B must wait behind it rather than move the position past A.
    await runner.runOnce(def);
    expect(seen).toEqual([]);

    // Long after any fixed safety delay, A commits.
    await new Promise((r) => setTimeout(r, 2500));
    commitA();
    await aCommitted;
    await runner.runOnce(def);
    expect(seen).toEqual(['A', 'B']);
  }, 15_000);

  it('a crash mid-batch: unfinished events are handled again, finished ones are not repeated', async () => {
    const sideEffects: string[] = [];
    let crashOn: string | null = 'e3';
    const handle: EventConsumerDefinition['handle'] = async (e) => {
      if (e.itemId === crashOn) return new Promise<void>(() => {}); // the process dies here
      sideEffects.push(e.itemId);
    };
    const def = consumer('crash', handle);
    const runner = new EventConsumerRunner(db);
    await runner.register(def);
    for (const id of ['e1', 'e2', 'e3', 'e4']) await emit(id);

    void runner.runOnce(def); // never finishes: "killed" while handling e3
    await new Promise((r) => setTimeout(r, 300));
    expect(sideEffects).toEqual(['e1', 'e2']);

    // The dead process's lease runs out; a new process takes over.
    crashOn = null;
    await db.update(eventConsumers).set({ leaseUntil: new Date(Date.now() - 1000) }).where(eq(eventConsumers.name, def.name));
    await new EventConsumerRunner(db).runOnce(def);
    expect(sideEffects).toEqual(['e1', 'e2', 'e3', 'e4']);
  });

  it('a failing event is retried in place with backoff, then dead-lettered — and then stops blocking', async () => {
    const handled: string[] = [];
    const attempts: number[] = [];
    const def = consumer(
      'dead',
      async (e, ctx) => {
        if (e.itemId === 'bad') {
          attempts.push(ctx.attempt);
          throw new Error('receiver says no');
        }
        handled.push(e.itemId);
      },
      { maxAttempts: 3 },
    );
    const runner = new EventConsumerRunner(db);
    await runner.register(def);
    for (const id of ['ok1', 'bad', 'ok2']) await emit(id);

    expect(await runner.runOnce(def)).toMatchObject({ handled: 1, failed: 1 });
    expect(handled).toEqual(['ok1']); // ok2 waits behind the failing event: order is kept
    await runner.runOnce(def);
    expect(await runner.runOnce(def)).toMatchObject({ dead: 1, handled: 1 });
    expect(attempts).toEqual([1, 2, 3]);
    expect(handled).toEqual(['ok1', 'ok2']);
    const [f] = await db.select().from(eventConsumerFailures).where(eq(eventConsumerFailures.consumer, def.name));
    expect(f).toMatchObject({ state: 'dead', attempts: 3, lastError: 'receiver says no' });
    await runner.runOnce(def);
    expect(attempts).toEqual([1, 2, 3]);
  });

  it('a retry waits for its backoff', async () => {
    let calls = 0;
    const def = consumer(
      'backoff',
      async () => {
        calls += 1;
        throw new Error('down');
      },
      { retryBaseMs: 60_000 },
    );
    const runner = new EventConsumerRunner(db);
    await runner.register(def);
    await emit('b1');
    await runner.runOnce(def);
    await runner.runOnce(def);
    expect(calls).toBe(1);
    await new EventConsumerRunner(db, () => new Date(Date.now() + 61_000)).runOnce(def);
    expect(calls).toBe(2);
  });

  it('an unknown outcome stops the consumer for a person; "done" records it and goes on', async () => {
    let calls = 0;
    const seen: string[] = [];
    const def = consumer('unknown', async (e) => {
      if (e.itemId === 'u1') {
        calls += 1;
        throw new UnknownOutcomeError('sent, but no answer');
      }
      seen.push(e.itemId);
    });
    const runner = new EventConsumerRunner(db);
    await runner.register(def);
    await emit('u1');
    await emit('u2');
    expect(await runner.runOnce(def)).toMatchObject({ unknown: 1, paused: true });
    await runner.runOnce(def);
    expect(calls).toBe(1);
    expect(seen).toEqual([]);
    const [f] = await db.select().from(eventConsumerFailures).where(eq(eventConsumerFailures.consumer, def.name));
    expect(f!.state).toBe('unknown');
    expect(await runner.resolveUnknown(def.name, f!.eventId, 'done')).toBe(true);
    await runner.runOnce(def);
    expect(calls).toBe(1);
    expect(seen).toEqual(['u2']);
    expect(await db.select().from(eventConsumerFailures).where(eq(eventConsumerFailures.consumer, def.name))).toHaveLength(0);
  });

  it('batches: all or nothing, retried together', async () => {
    const batches: string[][] = [];
    let fail = true;
    const def: EventConsumerDefinition = {
      name: consumerName('batch'),
      siteId: SITE,
      retryBaseMs: 0,
      batchSize: 10,
      handleBatch: async (events) => {
        batches.push(events.map((e) => e.itemId));
        if (fail) throw new Error('down');
      },
    };
    const runner = new EventConsumerRunner(db);
    await runner.register(def);
    for (const id of ['x1', 'x2', 'x3']) await emit(id);
    await runner.runOnce(def);
    fail = false;
    await runner.runOnce(def);
    expect(batches).toEqual([
      ['x1', 'x2', 'x3'],
      ['x1', 'x2', 'x3'],
    ]);
    expect(await db.select().from(eventConsumerFailures).where(eq(eventConsumerFailures.consumer, def.name))).toHaveLength(0);
  });

  it('a re-delivered event that was already handled is skipped (idempotency record)', async () => {
    const seen: string[] = [];
    const keys = new Set<string>();
    const def = consumer('dedupe', async (e: ChangeEvent, ctx) => {
      seen.push(e.itemId);
      keys.add(ctx.idempotencyKey);
    });
    const runner = new EventConsumerRunner(db);
    await runner.register(def);
    await emit('d1');
    await runner.runOnce(def);
    // Position lost (e.g. restored from an older backup): the event comes round again.
    await db.update(eventConsumers).set({ cursorTxid: null, cursorSeq: null }).where(eq(eventConsumers.name, def.name));
    await runner.runOnce(def);
    expect(seen.filter((id) => id === 'd1')).toHaveLength(1);
    expect([...keys][0]).toMatch(new RegExp(`^${def.name.replace(/[:.]/g, '\\$&')}:ev_d1_`));
  });

  it('a site-scoped consumer reads only its site', async () => {
    const seen: string[] = [];
    const def = consumer('scope', async (e) => {
      seen.push(`${e.siteId}/${e.itemId}`);
    });
    const runner = new EventConsumerRunner(db);
    await runner.register(def);
    await emit('mine');
    await emit('theirs', OTHER);
    await runner.runOnce(def);
    expect(seen).toEqual([`${SITE}/mine`]);
  });

  it('pauses after repeated failures and holds still until resumed', async () => {
    let fail = true;
    const seen: string[] = [];
    let pausedWith = '';
    const def = consumer(
      'pause',
      async (e) => {
        if (fail) throw new Error('down');
        seen.push(e.itemId);
      },
      {
        pauseAfterConsecutiveFailures: 2,
        maxAttempts: 10,
        onPaused: (reason: string) => {
          pausedWith = reason;
        },
      },
    );
    const runner = new EventConsumerRunner(db);
    await runner.register(def);
    for (const id of ['p1', 'p2', 'p3']) await emit(id);
    await runner.runOnce(def); // p1 fails
    expect((await runner.runOnce(def)).paused).toBe(true); // p1 fails again: paused
    expect(pausedWith).toMatch(/2 failures in a row: down/);
    expect((await runner.runOnce(def)).paused).toBe(true);
    fail = false;
    await runner.resume(def.name);
    await runner.runOnce(def);
    expect(seen).toEqual(['p1', 'p2', 'p3']);
  });

  it('a runner that stalled and lost its lease cannot move the position of the one that took over (Codex P04-2 #1)', async () => {
    let release!: () => void;
    let stalled = true;
    const seen: string[] = [];
    const def = consumer('fence', async (e) => {
      if (stalled && e.itemId === 'f1') {
        stalled = false;
        await new Promise<void>((r) => (release = r));
        return;
      }
      seen.push(e.itemId);
    });
    const runner = new EventConsumerRunner(db);
    await runner.register(def);
    await emit('f1');
    await emit('f2');
    const stale = runner.runOnce(def);
    await new Promise((r) => setTimeout(r, 200));
    // The lease runs out; another runner takes over and gets ahead.
    await db.update(eventConsumers).set({ leaseUntil: new Date(Date.now() - 1000) }).where(eq(eventConsumers.name, def.name));
    await new EventConsumerRunner(db).runOnce(def);
    expect(seen).toEqual(['f1', 'f2']);
    const [ahead] = await db.select().from(eventConsumers).where(eq(eventConsumers.name, def.name));
    release();
    expect((await stale).handled).toBe(0);
    const [after] = await db.select().from(eventConsumers).where(eq(eventConsumers.name, def.name));
    expect(after!.cursorSeq).toBe(ahead!.cursorSeq);
  });

  it('deciding the last event of an unknown batch does not skip the undecided ones before it (Codex P04-2 #2)', async () => {
    const def: EventConsumerDefinition = {
      name: consumerName('unknown-batch'),
      siteId: SITE,
      batchSize: 10,
      handleBatch: async () => {
        throw new UnknownOutcomeError('no answer');
      },
    };
    const runner = new EventConsumerRunner(db);
    await runner.register(def);
    for (const id of ['k1', 'k2', 'k3']) await emit(id);
    await runner.runOnce(def);
    const failures = await db.select().from(eventConsumerFailures).where(eq(eventConsumerFailures.consumer, def.name));
    expect(failures.map((f) => f.state)).toEqual(['unknown', 'unknown', 'unknown']);
    const [before] = await db.select().from(eventConsumers).where(eq(eventConsumers.name, def.name));
    const last = (await db.execute(sql`SELECT id FROM lumibase_cdc_change_events WHERE site_id = ${SITE} AND item_id = 'k3'`)) as unknown as Array<{ id: string }>;
    expect(await runner.resolveUnknown(def.name, last[0]!.id, 'done')).toBe(true);
    const [still] = await db.select().from(eventConsumers).where(eq(eventConsumers.name, def.name));
    expect(still!.cursorSeq).toBe(before!.cursorSeq); // k1, k2 still wait for a decision
    expect(await runner.resolveUnknown(def.name, null, 'done')).toBe(true);
    const [moved] = await db.select().from(eventConsumers).where(eq(eventConsumers.name, def.name));
    expect(moved!.cursorSeq).not.toBe(before!.cursorSeq);
    expect(await db.select().from(eventConsumerFailures).where(eq(eventConsumerFailures.consumer, def.name))).toHaveLength(0);
  });

  it('an event confirmed done is not handled again while an earlier one is retried (Codex P04-3 #3)', async () => {
    const seen: string[][] = [];
    let fail = true;
    const def: EventConsumerDefinition = {
      name: consumerName('done-not-again'),
      siteId: SITE,
      batchSize: 10,
      retryBaseMs: 0,
      handleBatch: async (events) => {
        seen.push(events.map((e) => e.itemId));
        if (fail) throw new UnknownOutcomeError('no answer');
      },
    };
    const runner = new EventConsumerRunner(db);
    await runner.register(def);
    for (const id of ['a', 'b']) await emit(id);
    await runner.runOnce(def);
    const ids = (await db.execute(sql`SELECT id, item_id FROM lumibase_cdc_change_events WHERE site_id = ${SITE} ORDER BY seq`)) as unknown as Array<{ id: string; item_id: string }>;
    expect(await runner.resolveUnknown(def.name, ids.find((r) => r.item_id === 'b')!.id, 'done')).toBe(true);
    expect(await runner.resolveUnknown(def.name, ids.find((r) => r.item_id === 'a')!.id, 'retry')).toBe(true);
    fail = false;
    await runner.runOnce(def);
    expect(seen).toEqual([['a', 'b'], ['a']]);
    const [state] = await db.select().from(eventConsumers).where(eq(eventConsumers.name, def.name));
    const last = (await db.execute(sql`SELECT seq FROM lumibase_cdc_change_events WHERE site_id = ${SITE} AND item_id = 'b'`)) as unknown as Array<{ seq: number }>;
    expect(state!.cursorSeq).toBe(Number(last[0]!.seq)); // moved over b too
  });

  it('an event already dead-lettered is passed over, not handled again (Codex P04-2 #8)', async () => {
    const seen: string[] = [];
    const def = consumer('already-dead', async (e) => {
      seen.push(e.itemId);
    });
    const runner = new EventConsumerRunner(db);
    await runner.register(def);
    await emit('gone');
    await emit('next');
    // A runner recorded the dead letter and stopped before moving on.
    const [ev] = (await db.execute(sql`SELECT id FROM lumibase_cdc_change_events WHERE site_id = ${SITE} AND item_id = 'gone'`)) as unknown as Array<{ id: string }>;
    await db.insert(eventConsumerFailures).values({ consumer: def.name, eventId: ev!.id, state: 'dead', attempts: 5 });
    await runner.runOnce(def);
    expect(seen).toEqual(['next']);
  });
});
