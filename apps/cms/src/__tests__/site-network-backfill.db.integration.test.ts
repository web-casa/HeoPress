import { readFileSync } from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import { collections, itemNumbers, items, sites, type Database } from '@heopress/database';
import { connectDbFixtures, connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';

/**
 * The item-number back-fill of migration 0021 (HeoPress P05, design R11):
 * numbers already given are kept, items without one are numbered in
 * creation order after the highest number in use (or the counter's), the
 * counter follows, and running it again changes nothing. The statements are
 * taken from the migration file itself and run as the table owner.
 */

const SITE = 'site_p05_backfill_it';
const MIGRATION = path.resolve(__dirname, '../../../../packages/database/drizzle/0021_site_network_model.sql');

function numberingStatements(): string[] {
  const sqlText = readFileSync(MIGRATION, 'utf8');
  const start = sqlText.indexOf('-- Item numbers in creation order');
  const end = sqlText.indexOf('-- First publish times are unknown');
  return sqlText
    .slice(start, end)
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s && !s.split('\n').every((l) => l.trim().startsWith('--')));
}

describe.skipIf(!hasDbIntegrationUrl)('migration 0021 item-number back-fill — DB integration', () => {
  describe('as the table owner', () => {
    // A migration runs as the owner: the data and the statements both go through the fixtures connection.
    let fixtures: Database;
    let owner: postgres.Sql;
    let collectionId = '';

    beforeAll(async () => {
      await connectDbIntegration('site-network-backfill');
      fixtures = await connectDbFixtures('site-network-backfill');
      owner = (fixtures as unknown as { $client: postgres.Sql }).$client;
    });
    beforeEach(async () => {
      await fixtures.delete(sites).where(eq(sites.id, SITE));
      await fixtures.insert(sites).values({ id: SITE, name: 'Back-fill' });
      const [c] = await fixtures.insert(collections).values({ siteId: SITE, name: 'articles' }).returning({ id: collections.id });
      collectionId = c!.id;
    });
    afterAll(async () => {
      await fixtures?.delete(sites).where(eq(sites.id, SITE));
      await owner?.end({ timeout: 2 });
    });

    const run = async () => {
      for (const statement of numberingStatements()) await owner.unsafe(statement);
    };
    const numbers = async () =>
      (
        await fixtures
          .select({ title: items.data, number: items.number })
          .from(items)
          .where(and(eq(items.siteId, SITE), eq(items.collectionId, collectionId)))
          .orderBy(asc(items.createdAt))
      ).map((r) => [(r.title as { title: string }).title, r.number]);

    it('keeps given numbers, numbers the rest after the highest in use, and is repeatable', async () => {
      const t = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s));
      // Numbers 2 and 3 were given; number 1's item was deleted; two items have none yet.
      await fixtures.insert(items).values([
        { siteId: SITE, collectionId, data: { title: 'two' }, number: 2, createdAt: t(1) },
        { siteId: SITE, collectionId, data: { title: 'three' }, number: 3, createdAt: t(2) },
        { siteId: SITE, collectionId, data: { title: 'new-a' }, createdAt: t(3) },
        { siteId: SITE, collectionId, data: { title: 'new-b' }, createdAt: t(4) },
      ]);
      await run();
      expect(await numbers()).toEqual([['two', 2], ['three', 3], ['new-a', 4], ['new-b', 5]]);
      const [counter] = await fixtures.select().from(itemNumbers).where(and(eq(itemNumbers.siteId, SITE), eq(itemNumbers.collectionId, collectionId)));
      expect(counter!.last).toBe(5);
      // Again: nothing changes.
      await run();
      expect(await numbers()).toEqual([['two', 2], ['three', 3], ['new-a', 4], ['new-b', 5]]);
    });

    it('a counter higher than any number in use is respected (numbers of deleted items are not reused)', async () => {
      await fixtures.insert(itemNumbers).values({ siteId: SITE, collectionId, last: 9 });
      await fixtures.insert(items).values({ siteId: SITE, collectionId, data: { title: 'after-nine' } });
      await run();
      expect(await numbers()).toEqual([['after-nine', 10]]);
    });
  });
});
