import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { auditLog, cdcChangeEvents, collections, contentVersions, fields, items, sites, type Database } from '@heopress/database';
import { ItemService } from '../item-service';
import { EditorialService } from '../editorial-service';
import { ContentVersionService } from '../content-version-service';
import { sweepDuePublish } from '../scheduler-worker';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';

/**
 * Content changes and their change events commit together (HeoPress P04 task
 * 8.1; spec content/change-events "内容修改与变更事件同事务提交", ADR-0011):
 * when the event cannot be written the change rolls back and the caller gets
 * an error; every kind of change — create, edit, publish, delete, hold,
 * scheduled publish, editorial transition — leaves exactly its event, in the
 * same transaction.
 *
 * The failure is injected with a trigger, created through the owner
 * connection (DATABASE_OWNER_URL; the application role may not create
 * triggers).
 */

const SITE = 'site_event_same_tx_it';
const OWNER_URL = process.env.DATABASE_OWNER_URL?.trim() || undefined;

describe.skipIf(!hasDbIntegrationUrl)('content changes and change events commit together — DB integration', () => {
  let db: Database;
  let itemId = '';

  beforeAll(async () => {
    db = await connectDbIntegration('event-same-tx');
  });
  afterAll(async () => {
    if (!db) return;
    await db.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
  });

  const svc = () => new ItemService({ db, siteId: SITE });
  const stored = async () => (await db.select().from(items).where(eq(items.id, itemId)))[0]!;
  const eventsFor = (id = itemId) =>
    db
      .select({
        operation: cdcChangeEvents.operation,
        itemVersion: cdcChangeEvents.itemVersion,
        changedFields: cdcChangeEvents.changedFields,
        txid: sql<string>`${cdcChangeEvents.txid}::text`,
      })
      .from(cdcChangeEvents)
      .where(and(eq(cdcChangeEvents.siteId, SITE), eq(cdcChangeEvents.itemId, id)))
      .orderBy(cdcChangeEvents.seq);

  beforeEach(async () => {
    await db.delete(sites).where(eq(sites.id, SITE));
    await db.insert(sites).values({ id: SITE, name: 'Event same tx IT' });
    const [coll] = await db
      .insert(collections)
      .values({ siteId: SITE, name: 'articles', label: 'Articles' })
      .returning({ id: collections.id });
    await db.insert(fields).values({ siteId: SITE, collectionId: coll!.id, name: 'title', type: 'string', interface: 'input' });
    itemId = ((await svc().create('articles', { data: { title: 'v1' } })) as { id: string }).id;
  });

  it('every change leaves its event with the version it produced — one per change', async () => {
    await svc().patch('articles', itemId, { data: { title: 'v2' }, expectedVersion: 1 });
    await svc().patch('articles', itemId, { status: 'published', expectedVersion: 2 });
    await svc().setHold('articles', itemId, true, 3);
    await svc().softDelete('articles', itemId);
    const events = await eventsFor();
    expect(events.map((e) => [e.operation, e.itemVersion])).toEqual([
      ['create', 1],
      ['update', 2],
      ['update', 3],
      ['update', 4],
      ['delete', 5],
    ]);
    expect(events[3]!.changedFields).toEqual(['hold']);
  });

  it('the event is written in the change’s own transaction', async () => {
    // Write the change inside an outer transaction and compare transaction ids.
    const sameTx = await db.transaction(async (tx) => {
      const own = await tx.execute(sql`SELECT pg_current_xact_id()::text AS id`);
      await new ItemService({ db: tx as unknown as Database, siteId: SITE }).patch('articles', itemId, {
        data: { title: 'in tx' },
        expectedVersion: 1,
      });
      return (own as unknown as Array<{ id: string }>)[0]!.id;
    });
    const events = await eventsFor();
    expect(events.at(-1)!.txid).toBe(sameTx);
  });

  it('each change and its event are one transaction: the event carries the transaction that wrote the row', async () => {
    // Through the service's own connection (not an outer transaction handed to it), so an event
    // written on another connection or after the change committed has another transaction id.
    const rowTx = async () =>
      ((await db.execute(sql`SELECT xmin::text AS x FROM ${items} WHERE ${items.id} = ${itemId}`)) as unknown as Array<{ x: string }>)[0]!.x;
    const lastEventTx = async () => {
      const last = (await eventsFor()).at(-1)!;
      // xid8 → the 32-bit xid a row's xmin holds.
      return (BigInt(last.txid) % 4294967296n).toString();
    };
    expect(await lastEventTx()).toBe(await rowTx()); // the create
    await svc().patch('articles', itemId, { data: { title: 'v2' }, expectedVersion: 1 });
    expect(await lastEventTx()).toBe(await rowTx());
    await svc().patch('articles', itemId, { status: 'published', expectedVersion: 2 });
    expect(await lastEventTx()).toBe(await rowTx());
    await svc().setHold('articles', itemId, true, 3);
    expect(await lastEventTx()).toBe(await rowTx());
    await svc().softDelete('articles', itemId);
    expect(await lastEventTx()).toBe(await rowTx());
  });

  const versions = () => new ContentVersionService({ db, siteId: SITE, userId: null, items: svc() });
  const versionEvents = () =>
    db
      .select({ operation: cdcChangeEvents.operation, changedFields: cdcChangeEvents.changedFields, txid: sql<string>`${cdcChangeEvents.txid}::text` })
      .from(cdcChangeEvents)
      .where(and(eq(cdcChangeEvents.siteId, SITE), eq(cdcChangeEvents.resource, 'content_version')))
      .orderBy(cdcChangeEvents.seq);

  it('a named version and its event are one transaction too (create, update, delete)', async () => {
    const versionTx = async () =>
      ((await db.execute(sql`SELECT xmin::text AS x FROM ${contentVersions} WHERE ${contentVersions.siteId} = ${SITE} AND ${contentVersions.key} = 'draft-2'`)) as unknown as Array<{ x: string }>)[0]!.x;
    const lastTx = async () => (BigInt((await versionEvents()).at(-1)!.txid) % 4294967296n).toString();
    await versions().create('articles', itemId, 'draft-2', 'Second draft');
    expect(await lastTx()).toBe(await versionTx());
    await versions().update('articles', itemId, 'draft-2', { name: 'Renamed' });
    expect(await lastTx()).toBe(await versionTx());
    await versions().remove('articles', itemId, 'draft-2');
    expect((await versionEvents()).map((e) => [e.operation, e.changedFields])).toEqual([
      ['create', ['draft-2']],
      ['update', ['draft-2']],
      ['delete', ['draft-2']],
    ]);
  });

  it('scheduled publishing and editorial transitions write their events too', async () => {
    await db.update(items).set({ publishAt: new Date(Date.now() - 60_000) }).where(eq(items.id, itemId));
    expect(await sweepDuePublish({ db })).toBe(1);
    const second = ((await svc().create('articles', { data: { title: 'review me' } })) as { id: string }).id;
    await new EditorialService({ db, siteId: SITE, userId: null }).submitReview('articles', second);
    expect((await eventsFor()).map((e) => [e.operation, e.itemVersion, e.changedFields])).toEqual([
      ['create', 1, null],
      ['update', 2, ['status']],
    ]);
    expect((await eventsFor(second)).map((e) => [e.operation, e.itemVersion])).toEqual([
      ['create', 1],
      ['update', 2],
    ]);
  });

  describe.skipIf(!OWNER_URL)('when the event cannot be written', () => {
    let owner: postgres.Sql;
    beforeAll(async () => {
      owner = postgres(OWNER_URL!, { max: 1, onnotice: () => {} });
      await owner.unsafe(`
        CREATE OR REPLACE FUNCTION heopress_test_refuse_event() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.site_id = '${SITE}' AND (NEW.operation <> 'create' OR NEW.resource = 'content_version') THEN
            RAISE EXCEPTION 'injected change event failure';
          END IF;
          RETURN NEW;
        END $$`);
    });
    afterAll(async () => {
      await owner?.unsafe(`DROP TRIGGER IF EXISTS heopress_test_refuse_event ON lumibase_cdc_change_events`).catch(() => undefined);
      await owner?.unsafe(`DROP FUNCTION IF EXISTS heopress_test_refuse_event()`).catch(() => undefined);
      await owner?.end({ timeout: 1 });
    });
    const refuse = () =>
      owner.unsafe(`CREATE TRIGGER heopress_test_refuse_event BEFORE INSERT ON lumibase_cdc_change_events
                    FOR EACH ROW EXECUTE FUNCTION heopress_test_refuse_event()`);
    const allow = () => owner.unsafe(`DROP TRIGGER IF EXISTS heopress_test_refuse_event ON lumibase_cdc_change_events`);

    it('an edit rolls back and the caller gets the error', async () => {
      await refuse();
      try {
        await expect(svc().patch('articles', itemId, { data: { title: 'lost?' }, expectedVersion: 1 })).rejects.toThrow();
        await expect(svc().softDelete('articles', itemId)).rejects.toThrow();
        await expect(svc().setHold('articles', itemId, true, 1)).rejects.toThrow();
      } finally {
        await allow();
      }
      const row = await stored();
      expect(row).toMatchObject({ version: 1, hold: false, deletedAt: null });
      expect(row.data).toEqual({ title: 'v1' });
      expect((await eventsFor()).map((e) => e.operation)).toEqual(['create']);
    });

    it('a named version rolls back with its event: not created, not renamed, not deleted', async () => {
      await versions().create('articles', itemId, 'kept', 'Kept');
      await refuse();
      try {
        await expect(versions().create('articles', itemId, 'lost', 'Lost')).rejects.toThrow();
        await expect(versions().update('articles', itemId, 'kept', { name: 'Renamed?' })).rejects.toThrow();
        await expect(versions().remove('articles', itemId, 'kept')).rejects.toThrow();
      } finally {
        await allow();
      }
      const rows = await db.select({ key: contentVersions.key, name: contentVersions.name }).from(contentVersions).where(eq(contentVersions.siteId, SITE));
      expect(rows).toEqual([{ key: 'kept', name: 'Kept' }]);
      expect((await versionEvents()).map((e) => e.operation)).toEqual(['create']);
    });

    it('a scheduled publish rolls back too, and is published by a later sweep', async () => {
      await db.update(items).set({ publishAt: new Date(Date.now() - 60_000) }).where(eq(items.id, itemId));
      await refuse();
      try {
        // One item that cannot be published is rolled back and recorded; the sweep goes on (HeoPress P05).
        expect(await sweepDuePublish({ db })).toBe(0);
      } finally {
        await allow();
      }
      expect((await stored()).status).toBe('draft');
      const failures = await db.select().from(auditLog).where(and(eq(auditLog.siteId, SITE), eq(auditLog.event, 'scheduled_publish_failed')));
      expect(failures.map((f) => (f.metadata as { itemId: string }).itemId)).toEqual([itemId]);
      expect(await sweepDuePublish({ db })).toBe(1);
    });
  });
});
