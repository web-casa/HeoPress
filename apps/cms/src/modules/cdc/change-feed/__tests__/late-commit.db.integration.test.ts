import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { decodeCdcCursor } from '@heopress/contracts/schemas';
import { sites, type Database } from '@heopress/database';
import { DrizzleCdcEventStore, FeedReader } from '../feed-reader';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../../../__tests__/helpers/db-harness';

/**
 * The Change Feed does not skip late commits (HeoPress P04 task 9.1; spec
 * content/change-events "晚提交事件不被跳过"; docs/known-issues.md): a write
 * transaction that started first and commits after a later one — long after
 * the old 2 s safety lag — is still read, in commit order, by a reader that
 * pages with cursors.
 */

const SITE = 'site_late_commit_it';

describe.skipIf(!hasDbIntegrationUrl)('Change Feed late commits — DB integration', () => {
  let db: Database;
  let raw: postgres.Sql;

  beforeAll(async () => {
    db = await connectDbIntegration('cdc-late-commit');
    raw = postgres(process.env.DATABASE_URL!, { max: 3, onnotice: () => {} });
  });
  afterAll(async () => {
    if (db) await db.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
    await raw?.end({ timeout: 1 });
  });
  beforeEach(async () => {
    await db.delete(sites).where(eq(sites.id, SITE));
    await db.insert(sites).values({ id: SITE, name: 'Late commit IT' });
  });

  const emit = (tx: postgres.Sql | postgres.TransactionSql, itemId: string) =>
    tx`INSERT INTO lumibase_cdc_change_events (id, site_id, collection, item_id, operation, actor_type, source)
       VALUES (${`ev_${itemId}_${Math.random().toString(36).slice(2, 8)}`}, ${SITE}, 'articles', ${itemId}, 'update', 'system', 'system')`;
  const reader = () => new FeedReader({ store: new DrizzleCdcEventStore(db), siteId: SITE, retentionDays: 30 });

  it('a transaction committing after a later one, beyond any fixed delay, is still read', async () => {
    await emit(raw, 'before');
    const first = await reader().read(null, {}, 100);
    expect(first.events.map((e) => e.itemId)).toEqual(['before']);
    const cursor = decodeCdcCursor(first.nextCursor!)!;

    let commitA!: () => void;
    const a = raw.begin(async (tx) => {
      await emit(tx, 'A');
      await new Promise<void>((resolve) => (commitA = resolve));
    });
    await new Promise((r) => setTimeout(r, 100));
    await emit(raw, 'B');

    // While A may still commit, the reader does not move past it.
    const during = await reader().read(cursor, {}, 100);
    expect(during.events).toEqual([]);

    await new Promise((r) => setTimeout(r, 2500));
    commitA();
    await a;
    const after = await reader().read(cursor, {}, 100);
    expect(after.events.map((e) => e.itemId)).toEqual(['A', 'B']);
  }, 15_000);
});
