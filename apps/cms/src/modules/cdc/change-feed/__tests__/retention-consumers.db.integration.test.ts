import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { cdcChangeEvents, cdcSubscriptions, sites, type Database } from '@heopress/database';
import { DrizzleRetentionStore, pruneChangeFeed, DEFAULT_RETENTION_DAYS } from '../retention';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../../../__tests__/helpers/db-harness';

/**
 * Event retention follows the consumers (HeoPress P04 task 8.4; spec
 * content/change-events "事件保留"): an event older than the retention
 * period (30 days by default) is removed only when every registered
 * consumer has confirmed it. A consumer that stopped 40 days ago keeps the
 * events it has not reached; a dead subscription no longer holds anything.
 */

const SITE = 'site_retention_consumers_it';
const DAY = 86_400_000;

describe.skipIf(!hasDbIntegrationUrl)('retention keeps what a consumer has not confirmed — DB integration', () => {
  let db: Database;
  const name = (label: string) => `test-retention:${label}`;

  beforeAll(async () => {
    db = await connectDbIntegration('retention-consumers');
  });
  afterAll(async () => {
    if (!db) return;
    await db.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
  });
  beforeEach(async () => {
    // Global consumers left by other suites (e.g. search sync) would rightly
    // hold these events; this suite is about the ones it registers.
    await db.execute(sql`DELETE FROM lumibase_event_consumers WHERE site_id IS NULL`);
    await db.delete(sites).where(eq(sites.id, SITE));
    await db.insert(sites).values({ id: SITE, name: 'Retention IT' });
  });

  async function event(id: string, ageDays: number): Promise<void> {
    await db.insert(cdcChangeEvents).values({
      id,
      siteId: SITE,
      collection: 'articles',
      itemId: id,
      operation: 'update',
      actorType: 'system',
      source: 'system',
      occurredAt: new Date(Date.now() - ageDays * DAY),
    });
  }
  /** Register a consumer (site-scoped) standing just after `eventId`, or before everything. */
  async function consumer(label: string, eventId: string | null, status = 'active'): Promise<void> {
    await db.execute(sql`
      INSERT INTO lumibase_event_consumers (name, site_id, cursor_txid, cursor_seq, status)
      SELECT ${name(label)}, ${SITE}, e.txid, e.seq, ${status}
        FROM (SELECT 1) one LEFT JOIN lumibase_cdc_change_events e ON e.id = ${eventId}`);
  }
  const remaining = async () =>
    (await db.select({ id: cdcChangeEvents.id }).from(cdcChangeEvents).where(eq(cdcChangeEvents.siteId, SITE)).orderBy(cdcChangeEvents.seq)).map(
      (r) => r.id,
    );
  const prune = () => pruneChangeFeed({ store: new DrizzleRetentionStore(db), retentionDays: DEFAULT_RETENTION_DAYS }, SITE);

  it('the default retention period is 30 days', () => {
    expect(DEFAULT_RETENTION_DAYS).toBe(30);
  });

  it('a consumer stopped 40 days ago keeps its unconfirmed events; confirmed ones past 30 days go', async () => {
    await event('old1', 45);
    await event('old2', 40);
    await event('old3', 35);
    await event('new1', 1);
    await consumer('current', 'new1'); // has confirmed everything
    await consumer('stalled', 'old1'); // stopped 40 days ago, right after old1
    const result = await prune();
    expect(result.prunedEvents).toBe(1);
    expect(await remaining()).toEqual(['old2', 'old3', 'new1']);
  });

  it('a paused consumer still holds its events; a dead one does not', async () => {
    await event('e1', 40);
    await consumer('paused', null, 'paused');
    await prune();
    expect(await remaining()).toEqual(['e1']);
    await db.execute(sql`UPDATE lumibase_event_consumers SET status = 'dead' WHERE name = ${name('paused')}`);
    await prune();
    expect(await remaining()).toEqual([]);
  });

  it('a subscription is a consumer too: a lagging one keeps its events, a dead one releases them', async () => {
    await event('s1', 40);
    await event('s2', 39);
    const [sub] = await db
      .insert(cdcSubscriptions)
      .values({ siteId: SITE, name: 'lagging', kind: 'pull', cursorOccurredAt: new Date(Date.now() - 40 * DAY), cursorId: 's1' })
      .returning({ id: cdcSubscriptions.id });
    await prune();
    expect(await remaining()).toEqual(['s2']); // s1 was confirmed, s2 was not
    await db.update(cdcSubscriptions).set({ status: 'dead' }).where(eq(cdcSubscriptions.id, sub!.id));
    await prune();
    expect(await remaining()).toEqual([]);
  });

  afterAll(async () => {
    if (db) await db.execute(sql`DELETE FROM lumibase_event_consumers WHERE name LIKE 'test-retention:%'`);
  });
});
