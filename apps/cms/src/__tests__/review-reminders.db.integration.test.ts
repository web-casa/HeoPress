import { and, eq, inArray, like } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  auditLog,
  cdcChangeEvents,
  collections,
  items,
  notifications,
  permissions,
  roles,
  userSites,
  users,
  type Database,
} from '@heopress/database';
import { createRuntime } from '@heopress/runtime/node';
import app from '../index';
import { setRuntimeFactory } from '../middleware/runtime';
import { __resetPermissionProcessCacheForTests } from '../services/permission-service';
import { sendReviewReminders } from '../services/staleness/reminders';
import { connectDbFixtures, connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { createCrossSiteFixture, SHARED, type CrossSiteFixture } from './helpers/cross-site-fixture';

/**
 * Review reminders (HeoPress v1.1; spec content/review-reminders).
 *
 * A marked item whose deadline has arrived notifies the people who can resolve it — one digest per person, not one
 * notification per item — and is stamped so the same reminder is not repeated until the repeat interval passes. The
 * watermark is per item (a re-mark re-arms it), the digest respects each recipient's row rules, and a run with nothing
 * due writes nothing: no notification, no stamped row, no Change Feed event, no audit entry.
 */

const NOW = new Date('2026-11-10T12:00:00.000Z');
const DUE = new Date(NOW.getTime() - 2 * 60 * 60 * 1000);
const DAY = 86_400_000;
const JWT_SECRET = 'review-reminders-secret';
const QUEUE = '/content/review-queue';

describe.skipIf(!hasDbIntegrationUrl)('review reminders — DB integration', () => {
  // The application role: the code under test, bound by row-level security.
  let db: Database;
  // The owner: fixtures and checks of the stored rows.
  let fixtures: Database;
  let fx: CrossSiteFixture;
  let env: Record<string, unknown> = {};
  let articlesA = '';
  let articlesB = '';

  beforeAll(async () => {
    db = await connectDbIntegration('review-reminders');
    fixtures = await connectDbFixtures('review-reminders');
    env = { ...process.env, JWT_SECRET, HEOPRESS_ENV: 'development' };
    setRuntimeFactory(() => createRuntime(env));
  });
  beforeEach(async () => {
    fx = await createCrossSiteFixture(fixtures, { prefix: 'rmd', jwtSecret: JWT_SECRET });
    __resetPermissionProcessCacheForTests();
    articlesA = await collectionId('a');
    articlesB = await collectionId('b');
  });
  afterAll(async () => {
    setRuntimeFactory(null);
    if (fx) await fx.teardown();
  });

  async function collectionId(site: 'a' | 'b') {
    const [row] = await fixtures
      .select({ id: collections.id })
      .from(collections)
      .where(and(eq(collections.siteId, fx.sites[site]), eq(collections.name, SHARED.collection)));
    return row!.id;
  }

  /** A due, manually marked item; `extra` varies the one field a case is about. */
  async function make(title: string, extra: Partial<typeof items.$inferInsert> = {}, site: 'a' | 'b' = 'a') {
    const [row] = await fixtures
      .insert(items)
      .values({
        siteId: fx.sites[site],
        collectionId: site === 'a' ? articlesA : articlesB,
        status: 'published',
        data: { title },
        needsUpdateSince: new Date(DUE.getTime() - DAY),
        needsUpdateReason: 'Prices changed',
        needsUpdateDueAt: DUE,
        needsUpdateSource: 'manual',
        updatedAt: new Date(DUE.getTime() - DAY),
        ...extra,
      })
      .returning({ id: items.id });
    return row!.id;
  }

  const stored = async (id: string) => (await fixtures.select().from(items).where(eq(items.id, id)))[0]!;
  const inbox = async (site: 'a' | 'b', userId: string) =>
    fixtures
      .select()
      .from(notifications)
      .where(and(eq(notifications.siteId, fx.sites[site]), eq(notifications.recipient, userId)));
  const run = (now: Date = NOW) => sendReviewReminders({ db, now });
  const siteResult = (results: Awaited<ReturnType<typeof run>>, site: 'a' | 'b') =>
    results.find((r) => r.siteId === fx.sites[site])!;
  const titleLines = (message: string | null) => (message ?? '').split('\n').filter((line) => line.startsWith('- '));

  it('notifies each member who can act, once, with a digest — and stamps the item', async () => {
    const id = await make('Price list 2026');

    const results = await run();
    const a = siteResult(results, 'a');
    expect(a.reminded).toEqual([id]);
    // Editors of A (onlyA, both) and its administrator; the fixture's admin bypass needs no policy row.
    expect(a.recipients.map((r) => r.userId).sort()).toEqual([fx.users.onlyA.id, fx.users.both.id, fx.users.adminA.id].sort());

    const notes = await inbox('a', fx.users.onlyA.id);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.subject).toBe('1 item due for review');
    expect(notes[0]!.message).toContain('"Price list 2026" (articles)');
    expect(notes[0]!.message).toContain(`due ${DUE.toISOString().slice(0, 10)}`);
    expect(notes[0]!.message).toContain(QUEUE);
    // One digest spans items and collections: naming one would be a lie.
    expect(notes[0]!.collection).toBeNull();
    expect(notes[0]!.item).toBeNull();
    expect(notes[0]!.sender).toBeNull();
    expect(notes[0]!.pushed).toBe(false);

    const row = await stored(id);
    expect(row.needsUpdateRemindedAt?.getTime()).toBe(NOW.getTime());
    // A reminder is not an edit: version and `updated_at` are untouched, and it is not an audit/Change Feed event.
    expect(row.version).toBe(1);
    expect(row.updatedAt.getTime()).toBe(DUE.getTime() - DAY);
    expect(await fixtures.select().from(auditLog).where(like(auditLog.event, 'item_timeliness%'))).toHaveLength(0);
    expect(await fixtures.select().from(cdcChangeEvents).where(eq(cdcChangeEvents.itemId, id))).toHaveLength(0);
  });

  it('writes nothing on a second run the same day', async () => {
    const id = await make('Price list 2026');
    await run();
    const before = (await inbox('a', fx.users.onlyA.id)).length;

    const second = await run();
    expect(siteResult(second, 'a')).toEqual({ siteId: fx.sites.a, reminded: [], recipients: [] });
    expect(await inbox('a', fx.users.onlyA.id)).toHaveLength(before);
    expect((await stored(id)).needsUpdateRemindedAt?.getTime()).toBe(NOW.getTime());
  });

  it('does not remind an item whose deadline has not arrived, or one that is no longer marked', async () => {
    const later = await make('Due tomorrow', { needsUpdateDueAt: new Date(NOW.getTime() + DAY) });
    const cleared = await make('Mark was cleared', {
      needsUpdateSince: null,
      needsUpdateReason: null,
      needsUpdateSource: null,
      // A leftover deadline alone must not remind: `needs_update_since` is the truth of whether a mark exists.
      needsUpdateDueAt: DUE,
    });
    const undated = await make('No deadline', { needsUpdateDueAt: null });

    const results = await run();
    expect(siteResult(results, 'a').reminded).toEqual([]);
    expect(await inbox('a', fx.users.onlyA.id)).toHaveLength(0);
    for (const id of [later, cleared, undated]) {
      expect((await stored(id)).needsUpdateRemindedAt, `item ${id}`).toBeNull();
    }
  });

  it('reminds an ignored item again once the repeat interval has passed, and only then', async () => {
    const overdue = await make('Ignored for 8 days', { needsUpdateRemindedAt: new Date(NOW.getTime() - 8 * DAY) });
    const inside = await make('Reminded 6 days ago', { needsUpdateRemindedAt: new Date(NOW.getTime() - 6 * DAY) });

    const results = await run();
    expect(siteResult(results, 'a').reminded).toEqual([overdue]);
    const notes = await inbox('a', fx.users.onlyA.id);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.message).toContain('Ignored for 8 days');
    expect(notes[0]!.message).not.toContain('Reminded 6 days ago');

    expect((await stored(overdue)).needsUpdateRemindedAt?.getTime()).toBe(NOW.getTime());
    // Inside the interval the old watermark stands: it must not be pushed forward by a run that skipped it.
    expect((await stored(inside)).needsUpdateRemindedAt?.getTime()).toBe(NOW.getTime() - 6 * DAY);
  });

  it('lists at most five titles in one digest and counts the rest', async () => {
    const ids: string[] = [];
    for (let i = 1; i <= 7; i += 1) ids.push(await make(`Due item ${i}`));

    await run();
    const notes = await inbox('a', fx.users.onlyA.id);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.subject).toBe('7 items due for review');
    expect(titleLines(notes[0]!.message)).toHaveLength(5);
    expect(notes[0]!.message).toContain('and 2 more.');
    expect(notes[0]!.message).toContain(QUEUE);
    // Every covered item is stamped, not just the five named: the digest's "and N more" is the same reminder.
    for (const id of ids) {
      expect((await stored(id)).needsUpdateRemindedAt?.getTime()).toBe(NOW.getTime());
    }
  });

  it('skips a member who can only read, and keeps each site to its own members', async () => {
    const id = await make('B-only due item', {}, 'b');

    const results = await run();
    expect(siteResult(results, 'a').recipients).toEqual([]);
    const b = siteResult(results, 'b');
    expect(b.reminded).toEqual([id]);
    expect(b.recipients.map((r) => r.userId).sort()).toEqual([fx.users.onlyB.id, fx.users.adminB.id].sort());
    // `both` is a reader of B: no permission to resolve the mark, so no reminder.
    expect(await inbox('b', fx.users.both.id)).toHaveLength(0);
    expect(await inbox('b', fx.users.onlyB.id)).toHaveLength(1);
    expect(await inbox('a', fx.users.onlyA.id)).toHaveLength(0);
  });

  it('skips a suspended member: they cannot sign in, so they cannot act', async () => {
    await fixtures.update(users).set({ status: 'suspended' }).where(eq(users.id, fx.users.onlyA.id));
    const id = await make('Due for someone active');

    await run();
    expect(await inbox('a', fx.users.onlyA.id)).toHaveLength(0);
    expect(await inbox('a', fx.users.adminA.id)).toHaveLength(1);
    expect((await stored(id)).needsUpdateRemindedAt?.getTime()).toBe(NOW.getTime());
  });

  it('writes no notification and no watermark when nobody can act', async () => {
    const id = await make('Nobody can resolve this');
    const [reader] = await fixtures
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.siteId, fx.sites.a), eq(roles.name, 'Reader')));
    // The editors become readers (no `update`), and the only administrator cannot sign in.
    await fixtures
      .update(userSites)
      .set({ roleId: reader!.id })
      .where(and(eq(userSites.siteId, fx.sites.a), inArray(userSites.userId, [fx.users.onlyA.id, fx.users.both.id])));
    await fixtures.update(users).set({ status: 'suspended' }).where(eq(users.id, fx.users.adminA.id));
    __resetPermissionProcessCacheForTests();

    const results = await run();
    expect(siteResult(results, 'a').recipients).toEqual([]);
    expect(await fixtures.select().from(notifications)).toHaveLength(0);
    // Not stamped: once someone can act, the item must still be pending a reminder.
    expect((await stored(id)).needsUpdateRemindedAt).toBeNull();
  });

  it('filters the digest by the recipient’s row rule', async () => {
    // The site's editors may update only published items; the administrator bypasses the rule.
    await fixtures
      .update(permissions)
      .set({ permissions: { status: { _eq: 'published' } } })
      .where(and(eq(permissions.siteId, fx.sites.a), eq(permissions.collection, SHARED.collection), eq(permissions.action, 'update')));
    __resetPermissionProcessCacheForTests();
    const draft = await make('Still a draft', { status: 'draft' });
    const live = await make('Live and due', { status: 'published' });

    await run();
    const editorNote = (await inbox('a', fx.users.onlyA.id))[0]!;
    expect(titleLines(editorNote.message)).toEqual([expect.stringContaining('Live and due')]);
    expect(editorNote.message).not.toContain('Still a draft');
    // The administrator sees both, so both items are covered by the run as a whole.
    expect(titleLines((await inbox('a', fx.users.adminA.id))[0]!.message)).toHaveLength(2);
    for (const id of [draft, live]) {
      expect((await stored(id)).needsUpdateRemindedAt?.getTime()).toBe(NOW.getTime());
    }
  });

  it('runs each site in its own scope', async () => {
    const a = await make('A due', {}, 'a');
    const b = await make('B due', {}, 'b');

    await run();
    expect((await stored(a)).siteId).toBe(fx.sites.a);
    expect((await stored(b)).siteId).toBe(fx.sites.b);
    // Notifications land on the site of their item and are addressed to that site's members only.
    const all = await fixtures.select().from(notifications);
    expect(all.filter((n) => n.recipient === fx.users.onlyA.id).every((n) => n.siteId === fx.sites.a)).toBe(true);
    expect(all.filter((n) => n.recipient === fx.users.onlyB.id).every((n) => n.siteId === fx.sites.b)).toBe(true);
    expect(all.every((n) => n.siteId === fx.sites.a || n.siteId === fx.sites.b)).toBe(true);
  });

  it('re-arms the watermark when a mark is re-set through the API, and clears it when the mark is cleared', async () => {
    const markPath = () => `/api/v1/items/${SHARED.collection}/${fx.items.a}/timeliness`;
    const headers = { ...(await fx.headers('a', await fx.session('onlyA', 'a'))) };
    const call = (method: string, body?: unknown) =>
      app.request(markPath(), { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env);

    // A mark with a deadline that has passed.
    const marked = await call('PUT', { reason: 'Prices changed', dueAt: '2026-11-01T00:00:00Z', expectedVersion: 1 });
    expect(marked.status, await marked.clone().text()).toBe(200);
    expect((await fixtures.select().from(items).where(eq(items.id, fx.items.a)))[0]!.needsUpdateRemindedAt).toBeNull();

    await run();
    expect((await stored(fx.items.a)).needsUpdateRemindedAt?.getTime()).toBe(NOW.getTime());
    expect(await inbox('a', fx.users.onlyA.id)).toHaveLength(1);

    // Re-marking is a new decision with a new deadline: the old reminder must not silence it.
    const remarked = await call('PUT', { reason: 'Prices changed again', dueAt: '2026-11-05T00:00:00Z', expectedVersion: 2 });
    expect(remarked.status, await remarked.clone().text()).toBe(200);
    expect((await stored(fx.items.a)).needsUpdateRemindedAt).toBeNull();
    await run();
    expect(await inbox('a', fx.users.onlyA.id)).toHaveLength(2);

    // Clearing resets it too, and a cleared mark never reminds.
    const cleared = await app.request(
      markPath(),
      { method: 'DELETE', headers: { ...headers, 'if-match': '"3"' } },
      env,
    );
    expect(cleared.status, await cleared.clone().text()).toBe(200);
    expect((await stored(fx.items.a)).needsUpdateRemindedAt).toBeNull();
    await run();
    expect(await inbox('a', fx.users.onlyA.id)).toHaveLength(2);
  });
});
