// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  collections,
  contentReviews,
  items,
  sites,
  users,
  scopedDatabase,
  type Database,
} from '@heopress/database';
import { ItemService, ItemServiceError } from '../item-service';
import { EditorialService } from '../editorial-service';
import { connectDbFixtures, connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';

/**
 * DB-backed editorial workflow integration (task 8.6; Req 8, 9). Skips when
 * DATABASE_URL is unset/unreachable.
 *
 * **Validates: Requirements 8.2, 8.3, 9.1, 9.3**
 */

const SITE = 'site_editorial_it';
const GATED = 'gated_articles';
const OPEN = 'open_articles';

describe.skipIf(!hasDbIntegrationUrl)('Editorial workflow — DB integration', () => {
  let db: Database;
  // The owner: test data and checks of the stored rows (row-level security binds the application role `db`).
  let fixtures: Database;
  let gatedId: string;

  beforeAll(async () => {
    db = await connectDbIntegration('editorial');
    fixtures = await connectDbFixtures('editorial');
  });

  afterAll(async () => {
    if (!fixtures) return;
    await fixtures.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
  });

  beforeEach(async () => {
    await fixtures.delete(sites).where(eq(sites.id, SITE));
    await fixtures.delete(users).where(eq(users.id, 'author')).catch(() => undefined);
    await fixtures.delete(users).where(eq(users.id, 'reviewer')).catch(() => undefined);
    await fixtures.insert(sites).values({ id: SITE, name: 'Editorial IT' });
    await fixtures.insert(users).values([
      { id: 'author', email: 'author@test.local' },
      { id: 'reviewer', email: 'reviewer@test.local' },
    ]);
    const [gated] = await fixtures
      .insert(collections)
      .values({ siteId: SITE, name: GATED, label: 'Gated', meta: { editorialWorkflow: true, requireSeparateReviewer: true } })
      .returning({ id: collections.id });
    gatedId = gated!.id;
    await fixtures
      .insert(collections)
      .values({ siteId: SITE, name: OPEN, label: 'Open', meta: {} });
  });

  const svc = (userId?: string) => new ItemService({ db: scopedDatabase(db, { site: SITE }), siteId: SITE, userId: userId ?? null });
  const editorial = (userId: string) => new EditorialService({ db: scopedDatabase(db, { site: SITE }), siteId: SITE, userId });

  it('blocks direct draft -> published on a workflow collection (Req 8.2)', async () => {
    const item = await svc('author').create(GATED, { data: { title: 'X' } });
    await expect(
      svc('author').patch(GATED, item.id, { status: 'published', expectedVersion: item.version }),
    ).rejects.toMatchObject({ code: 'EDITORIAL_GATE_REQUIRED', status: 409 });
  });

  it('allows the review -> approve -> published path with a separate reviewer', async () => {
    const item = await svc('author').create(GATED, { data: { title: 'Y' } });

    await editorial('author').submitReview(GATED, item.id, { assignedTo: 'reviewer' });
    let [row] = await fixtures.select().from(items).where(eq(items.id, item.id));
    expect(row!.editorialState).toBe('in_review');

    // Same author cannot approve (separate-reviewer rule).
    await expect(editorial('author').approve(GATED, item.id)).rejects.toMatchObject({
      code: 'SEPARATE_REVIEWER_REQUIRED',
    });

    // A different reviewer approves → editorial_state approved.
    await editorial('reviewer').approve(GATED, item.id, { reason: 'ok' });
    [row] = await fixtures.select().from(items).where(eq(items.id, item.id));
    expect(row!.editorialState).toBe('approved');

    const reviews = await fixtures.select().from(contentReviews).where(eq(contentReviews.itemId, item.id));
    expect(reviews[0]!.status).toBe('approved');
    expect(reviews[0]!.decidedBy).toBe('reviewer');

    // Now publish is allowed (current state is approved).
    const published = await svc('author').patch(GATED, item.id, { status: 'published', expectedVersion: row!.version });
    expect(published.status).toBe('published');
  });

  it('leaves workflow-off collections unchanged: draft -> published directly (Req 8.3)', async () => {
    const item = await svc('author').create(OPEN, { data: { title: 'Z' } });
    const published = await svc('author').patch(OPEN, item.id, { status: 'published', expectedVersion: item.version });
    expect(published.status).toBe('published');
  });

  it('rejects with reason returns the item to draft', async () => {
    const item = await svc('author').create(GATED, { data: { title: 'R' } });
    await editorial('author').submitReview(GATED, item.id);
    await editorial('reviewer').reject(GATED, item.id, { reason: 'needs work' });
    const [row] = await fixtures.select().from(items).where(eq(items.id, item.id));
    expect(row!.editorialState).toBe('rejected');
    const reviews = await fixtures.select().from(contentReviews).where(eq(contentReviews.itemId, item.id));
    expect(reviews[0]!.status).toBe('rejected');
    expect(reviews[0]!.reason).toBe('needs work');
    void ItemServiceError;
  });
});
