import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { decodeCdcCursor, encodeCdcCursor } from '@heopress/contracts/schemas';
import { cdcChangeEvents, cdcSubscriptions, sites, type Database } from '@heopress/database';
import { DrizzleCdcEventStore, FeedReader, CursorExpiredError, eventKeyset, eventPosition, type CdcEventStore } from '../feed-reader';
import { EventConsumerRunner, type ChangeEvent } from '../../../events/consumer-runner';
import { ReplayOutOfRetentionError, SubscriptionService } from '../subscription-service';
import { DrizzleRetentionStore, pruneChangeFeed } from '../retention';
import { createCdcDispatchPass, type SubscriptionDispatchStore } from '../dispatcher';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../../../__tests__/helpers/db-harness';

/**
 * Cursor positions and retention (Codex review P04 round 2, #3, #5, #10,
 * #11): acknowledgements are compared in the feed's order; replaying from a
 * time skips nothing at or after it; a consumer whose events were kept can
 * always continue, and only a cursor behind deleted events is expired;
 * retention runs for every site.
 */

const SITE = 'site_positions_it';
const DAY = 86_400_000;

describe.skipIf(!hasDbIntegrationUrl)('cursor positions and retention — DB integration', () => {
  let db: Database;

  beforeAll(async () => {
    db = await connectDbIntegration('cdc-positions');
  });
  afterAll(async () => {
    if (db) await db.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
  });
  beforeEach(async () => {
    await db.execute(sql`DELETE FROM lumibase_event_consumers WHERE site_id IS NULL`);
    await db.delete(sites).where(eq(sites.id, SITE));
    await db.insert(sites).values({ id: SITE, name: 'Positions IT' });
  });

  const service = () =>
    new SubscriptionService({ db, siteId: SITE, eventStore: new DrizzleCdcEventStore(db), retentionDays: 30 });
  const reader = () => new FeedReader({ store: new DrizzleCdcEventStore(db), siteId: SITE, retentionDays: 30 });
  const event = (id: string, occurredAt = new Date()) =>
    db.insert(cdcChangeEvents).values({
      id,
      siteId: SITE,
      collection: 'articles',
      itemId: id,
      operation: 'update',
      actorType: 'system',
      source: 'system',
      occurredAt,
    });

  it('#3 acks follow positions: a later event with a smaller id is still forward', async () => {
    // One transaction (a bulk write): same time, ids against position order.
    await db.transaction(async (tx) => {
      for (const id of ['zz-first', 'aa-second']) {
        await tx.insert(cdcChangeEvents).values({ id, siteId: SITE, collection: 'articles', itemId: id, operation: 'create', actorType: 'system', source: 'system' });
      }
    });
    const sub = await service().create({ name: 'puller', kind: 'pull', collections: [], operations: [], payload_mode: 'reference' } as never);
    const page = await reader().read(null, {}, 1);
    await service().ack(sub.id, page.nextCursor!);
    const second = await reader().read(page.events.length ? (await import('@heopress/contracts/schemas')).decodeCdcCursor(page.nextCursor!)! : null, {}, 1);
    expect(second.events.map((e) => e.id)).toEqual(['aa-second']);
    await expect(service().ack(sub.id, second.nextCursor!)).resolves.toBeTruthy();
    // Going back is still refused.
    await expect(service().ack(sub.id, page.nextCursor!)).rejects.toThrow();
  });

  it('#5 replaying from a time skips nothing at or after it, even when times and positions disagree', async () => {
    const t = Date.now() - 60_000;
    // Written first (lower position) but stamped later; written later but stamped earlier.
    await event('late-stamp', new Date(t + 10_000));
    await event('early-stamp', new Date(t - 10_000));
    const sub = await service().create({ name: 'replayer', kind: 'pull', collections: [], operations: [], payload_mode: 'reference' } as never);
    await service().replay(sub.id, { occurredAfter: new Date(t).toISOString() }, { type: 'user' });
    const [row] = await db.select().from(cdcSubscriptions).where(eq(cdcSubscriptions.id, sub.id));
    const page = await reader().read({ occurredAtMs: row!.cursorOccurredAt!.getTime(), eventId: row!.cursorId ?? '' }, {}, 10);
    expect(page.events.map((e) => e.id)).toContain('late-stamp');
  });

  it('#10 a registered consumer whose events were kept can continue past the retention period; only a cursor behind deleted events expires', async () => {
    await event('old-1', new Date(Date.now() - 45 * DAY));
    await event('old-2', new Date(Date.now() - 40 * DAY));
    await event('new-1');
    const [first] = await db.select().from(cdcChangeEvents).where(eq(cdcChangeEvents.id, 'old-1'));
    const cursor = eventKeyset({ ...first!, seq: Number(first!.seq) });
    const legacy = eventKeyset({ ...first!, txid: undefined, seq: undefined });
    // A pull consumer stopped right after old-1, 45 days ago.
    await db.execute(sql`
      INSERT INTO lumibase_event_consumers (name, site_id, cursor_txid, cursor_seq)
      SELECT 'test-positions:stalled', ${SITE}, txid, seq FROM lumibase_cdc_change_events WHERE id = 'old-1'`);
    await pruneChangeFeed({ store: new DrizzleRetentionStore(db), retentionDays: 30 }, SITE);
    const page = await reader().read(cursor, {}, 10);
    expect(page.events.map((e) => e.id)).toEqual(['old-2', 'new-1']);
    // A cursor without a position whose event is gone cannot be placed: expired.
    await expect(reader().read(legacy, {}, 10)).rejects.toBeInstanceOf(CursorExpiredError);

    // Once old-2 is deleted too, a cursor before it is expired.
    await db.execute(sql`DELETE FROM lumibase_event_consumers WHERE name = 'test-positions:stalled'`);
    await pruneChangeFeed({ store: new DrizzleRetentionStore(db), retentionDays: 30 }, SITE);
    await expect(reader().read(cursor, {}, 10)).rejects.toBeInstanceOf(CursorExpiredError);
    expect(encodeCdcCursor(cursor)).toBeTruthy();
  });

  it('#11 retention runs for every site, not only sites with push subscriptions', async () => {
    const pruned: string[] = [];
    const subs = { listActiveSiteIds: async () => [], listDispatchable: async () => [] } as unknown as SubscriptionDispatchStore;
    const pass = createCdcDispatchPass({
      buildDispatcher: () => ({}) as never,
      subscriptions: subs,
      prune: async (siteId) => {
        pruned.push(siteId);
      },
      listAllSiteIds: async () => [SITE, 'another-site'],
    });
    await pass();
    expect(pruned).toEqual([SITE, 'another-site']);
  });
  it('Codex P04-3 #1: positions order by transaction id as a number, not as text', async () => {
    // Transaction 10 sorts before 9 as text; numerically 9 comes first.
    const at = new Date(Date.now() - 60_000);
    for (const [id, txid, seq] of [['tx-ten', '10', 1], ['tx-nine', '9', 2]] as const) {
      await db.insert(cdcChangeEvents).values({ id, siteId: SITE, collection: 'articles', itemId: id, operation: 'update', actorType: 'system', source: 'system', occurredAt: at, txid, seq });
    }
    const seen: string[] = [];
    const def = { name: `test-positions:numeric:${Date.now()}`, siteId: SITE, batchSize: 1, startFrom: 'start' as const, handle: async (e: ChangeEvent) => void seen.push(e.id) };
    const runner = new EventConsumerRunner(db);
    await runner.register(def);
    await runner.runOnce(def);
    await runner.runOnce(def);
    expect(seen).toEqual(['tx-nine', 'tx-ten']);
    // Replay from a time starts just before the numerically first event.
    expect(await eventPosition(db, SITE, { occurredAtMs: at.getTime() - 1000, eventId: '' })).toEqual({ txid: '9', seq: 1 });
    await db.execute(sql`DELETE FROM lumibase_event_consumers WHERE name = ${def.name}`);
  });
  const pull = () => service().create({ name: `pull-${Date.now()}`, kind: 'pull', collections: [], operations: [], payload_mode: 'reference' } as never);
  const status = async (id: string) => (await db.select().from(cdcSubscriptions).where(eq(cdcSubscriptions.id, id)))[0]!.status;
  const positionOf = async (eventId: string) => {
    const [r] = (await db.execute(sql`SELECT txid::text AS txid, seq FROM lumibase_cdc_change_events WHERE id = ${eventId}`)) as unknown as Array<{ txid: string; seq: number }>;
    return { txid: r!.txid, seq: Number(r!.seq) };
  };
  const registry = async (subId: string) => {
    const [r] = (await db.execute(sql`SELECT cursor_txid::text AS txid, cursor_seq AS seq FROM lumibase_event_consumers WHERE name = ${`cdc-subscription:${subId}`}`)) as unknown as Array<{ txid: string | null; seq: number | null }>;
    return r && r.txid ? { txid: r.txid, seq: Number(r.seq) } : null;
  };

  it('Codex P04-3 #4: after a replay from a time, reading on and acknowledging works', async () => {
    const t = Date.now() - 60_000;
    await event('before-t', new Date(t - 10_000));
    await event('after-t', new Date(t + 10_000));
    const sub = await pull();
    const replayed = await service().replay(sub.id, { occurredAfter: new Date(t).toISOString() }, { type: 'user' });
    const page = await reader().read(decodeCdcCursor(replayed.cursor!), {}, 10);
    expect(page.events.map((e) => e.id)).toEqual(['after-t']);
    await expect(service().ack(sub.id, page.nextCursor!)).resolves.toBeTruthy();
    expect(await registry(sub.id)).toEqual(await positionOf('after-t'));
  });

  it('Codex P04-3 #5: the cursor a subscription reports keeps its exact position after its event is pruned', async () => {
    await event('acked-old', new Date(Date.now() - 45 * DAY));
    await event('unread', new Date(Date.now() - 40 * DAY));
    const sub = await pull();
    const first = await reader().read(null, {}, 1);
    await service().ack(sub.id, first.nextCursor!);
    await pruneChangeFeed({ store: new DrizzleRetentionStore(db), retentionDays: 30 }, SITE); // deletes acked-old only
    const record = await service().get(sub.id);
    const page = await reader().read(decodeCdcCursor(record.cursor!), {}, 10);
    expect(page.events.map((e) => e.id)).toEqual(['unread']);
  });

  it('Codex P04-3 #6: a replay from a time is refused when an event after that time was deleted', async () => {
    const t = Date.now() - 41 * DAY;
    await event('deleted-after-t', new Date(Date.now() - 40 * DAY));
    await event('kept-after-t');
    const sub = await pull();
    await db.execute(sql`DELETE FROM lumibase_event_consumers WHERE name = ${`cdc-subscription:${sub.id}`}`);
    await db.update(cdcSubscriptions).set({ status: 'dead' }).where(eq(cdcSubscriptions.id, sub.id));
    await pruneChangeFeed({ store: new DrizzleRetentionStore(db), retentionDays: 30 }, SITE);
    expect(await db.select({ id: cdcChangeEvents.id }).from(cdcChangeEvents).where(eq(cdcChangeEvents.siteId, SITE))).toEqual([{ id: 'kept-after-t' }]);
    await expect(service().replay(sub.id, { occurredAfter: new Date(t).toISOString() }, { type: 'user' })).rejects.toBeInstanceOf(ReplayOutOfRetentionError);
    // A time after every deleted event is complete.
    await expect(service().replay(sub.id, { occurredAfter: new Date(Date.now() - DAY).toISOString() }, { type: 'user' })).resolves.toBeTruthy();
  });

  it('Codex P04-3 #7: events pruned between the expiry check and the read are a 410, not a silent gap', async () => {
    await event('e1', new Date(Date.now() - 45 * DAY));
    await event('e2', new Date(Date.now() - 44 * DAY));
    await event('e3');
    const real = new DrizzleCdcEventStore(db);
    const racing: CdcEventStore = Object.create(real) as CdcEventStore;
    let pruned = false;
    racing.listAfter = async (...args) => {
      if (!pruned) {
        pruned = true;
        await pruneChangeFeed({ store: new DrizzleRetentionStore(db), retentionDays: 30 }, SITE); // deletes e1, e2
      }
      return real.listAfter(...args);
    };
    const cursor = eventKeyset({ ...(await db.select().from(cdcChangeEvents).where(eq(cdcChangeEvents.id, 'e1')))[0]!, seq: undefined, txid: undefined });
    cursor.position = await positionOf('e1');
    const r = new FeedReader({ store: racing, siteId: SITE, retentionDays: 30 });
    await expect(r.read(cursor, {}, 10)).rejects.toBeInstanceOf(CursorExpiredError);
  });

  it('Codex P04-3 #8: a subscription with an old checkpoint that lost nothing stays active', async () => {
    await event('old-acked', new Date(Date.now() - 45 * DAY));
    const sub = await pull();
    await service().ack(sub.id, (await reader().read(null, {}, 1)).nextCursor!);
    await event('new-one');
    const result = await pruneChangeFeed({ store: new DrizzleRetentionStore(db), retentionDays: 30 }, SITE);
    expect(result.prunedEvents).toBe(1);
    expect(result.staleSubscriptions).toEqual([]);
    expect(await status(sub.id)).toBe('active');
  });

  it('Codex P04-3 #2: a replay waits for a prune of the same site and then sees what it deleted', async () => {
    const t = Date.now() - 41 * DAY;
    await event('soon-deleted', new Date(Date.now() - 40 * DAY));
    await event('stays');
    const sub = await pull();
    const pos = await positionOf('soon-deleted');
    const other = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
    try {
      // A prune in progress: it holds the site's feed lock while it deletes.
      const pruning = other.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${`cdc-feed:${SITE}`}))`;
        await new Promise((r) => setTimeout(r, 300));
        await tx`DELETE FROM lumibase_cdc_change_events WHERE id = 'soon-deleted'`;
        await tx`INSERT INTO lumibase_cdc_prune_marks (site_id, txid, seq, deleted_until)
                 VALUES (${SITE}, ${pos.txid}::xid8, ${pos.seq}, ${new Date(Date.now() - 40 * DAY).toISOString()}::timestamptz)`;
      });
      await new Promise((r) => setTimeout(r, 100));
      const replay = service().replay(sub.id, { occurredAfter: new Date(t).toISOString() }, { type: 'user' });
      await pruning;
      await expect(replay).rejects.toBeInstanceOf(ReplayOutOfRetentionError);
    } finally {
      await other.end({ timeout: 1 });
    }
  });

  it('Codex P04-3 #2: concurrent acknowledgements leave the registry where the checkpoint is', async () => {
    for (let i = 0; i < 6; i++) await event(`c${i}`);
    const sub = await pull();
    const tokens: string[] = [];
    let cursor: ReturnType<typeof decodeCdcCursor> = null;
    for (let i = 0; i < 6; i++) {
      const page = await reader().read(cursor, {}, 1);
      tokens.push(page.nextCursor!);
      cursor = decodeCdcCursor(page.nextCursor!);
    }
    await Promise.allSettled(tokens.map((tk) => service().ack(sub.id, tk)));
    const [row] = await db.select().from(cdcSubscriptions).where(eq(cdcSubscriptions.id, sub.id));
    expect(await registry(sub.id)).toEqual(await positionOf(row!.cursorId!));
  });
});
