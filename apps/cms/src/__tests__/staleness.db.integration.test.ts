import { and, eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditLog, cdcChangeEvents, collections, items, type Database } from '@heopress/database';
import { createRuntime } from '@heopress/runtime/node';
import { setRuntimeFactory } from '../middleware/runtime';
import { AUTO_STALE_REASON } from '../services/staleness/marks';
import { sweepStaleContent } from '../services/staleness/detect';
import { connectDbFixtures, connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { createCrossSiteFixture, SHARED, type CrossSiteFixture } from './helpers/cross-site-fixture';

/**
 * Automatic staleness detection (HeoPress v1.1; spec content/stale-content-queue).
 *
 * The sweep marks published items nobody has touched for a year, never touches a person's mark, drafts, scheduled
 * future items or deleted rows, and clears an automatic mark once the item has been edited after it. It writes one
 * Change Feed event per changed row and no audit event; a second pass with nothing to do writes nothing.
 */

const NOW = new Date('2026-11-10T12:00:00.000Z');
const OLD = new Date(NOW.getTime() - 400 * 86_400_000);
const RECENT = new Date(NOW.getTime() - 86_400_000);

describe.skipIf(!hasDbIntegrationUrl)('automatic staleness detection — DB integration', () => {
  // The application role: the code under test, bound by row-level security.
  let db: Database;
  // The owner: fixtures and checks of the stored rows.
  let fixtures: Database;
  let fx: CrossSiteFixture;
  let articles = '';
  let articlesB = '';

  beforeAll(async () => {
    db = await connectDbIntegration('staleness');
    fixtures = await connectDbFixtures('staleness');
    const env: Record<string, unknown> = { ...process.env, JWT_SECRET: 'staleness-secret' };
    setRuntimeFactory(() => createRuntime(env));
  });
  beforeEach(async () => {
    fx = await createCrossSiteFixture(fixtures, { prefix: 'stale', jwtSecret: 'staleness-secret' });
    articles = await collectionId('a');
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

  /** An item with the fields this suite varies; everything else is the schema's default. */
  async function make(title: string, extra: Partial<typeof items.$inferInsert> = {}, site: 'a' | 'b' = 'a') {
    const [row] = await fixtures
      .insert(items)
      .values({
        siteId: fx.sites[site],
        collectionId: site === 'a' ? articles : articlesB,
        status: 'published',
        updatedAt: OLD,
        data: { title },
        ...extra,
      })
      .returning({ id: items.id });
    return row!.id;
  }

  const stored = async (id: string) => (await fixtures.select().from(items).where(eq(items.id, id)))[0]!;
  const eventCount = async (id: string) =>
    (await fixtures.select({ id: cdcChangeEvents.id }).from(cdcChangeEvents).where(eq(cdcChangeEvents.itemId, id))).length;
  const sweep = () => sweepStaleContent({ db, now: NOW, staleAfterDays: 365 });

  it('marks only the old, published, unmarked items — and leaves version, updated_at and manual marks alone', async () => {
    const stale = await make('Stale tutorial', { data: { title: 'Stale tutorial' } });
    const fresh = await make('Fresh tutorial', { updatedAt: RECENT });
    const draft = await make('Old draft', { status: 'draft' });
    const scheduled = await make('Scheduled later', { publishAt: new Date(NOW.getTime() + 86_400_000) });
    const deleted = await make('Deleted old', { deletedAt: RECENT });
    const manual = await make('Marked by a person', {
      needsUpdateSince: RECENT,
      needsUpdateReason: 'Prices changed',
      needsUpdateDueAt: new Date('2026-12-01T00:00:00.000Z'),
      needsUpdateSource: 'manual',
    });

    const results = await sweep();
    const a = results.find((r) => r.siteId === fx.sites.a)!;
    expect(a.marked).toEqual([stale]);
    expect(a.cleared).toEqual([]);

    const marked = await stored(stale);
    expect(marked.needsUpdateSince?.getTime()).toBe(NOW.getTime());
    expect(marked.needsUpdateReason).toBe(AUTO_STALE_REASON);
    expect(marked.needsUpdateSource).toBe('auto');
    expect(marked.needsUpdateDueAt).toBeNull();
    // A derived mark is not an edit: the row's version and `updated_at` are untouched.
    expect(marked.version).toBe(1);
    expect(marked.updatedAt.getTime()).toBe(OLD.getTime());

    for (const id of [fresh, draft, scheduled, deleted]) {
      const row = await stored(id);
      expect(row.needsUpdateSince, `item ${id}`).toBeNull();
      expect(row.needsUpdateSource, `item ${id}`).toBe('manual');
    }

    // The person's mark is exactly as it was, deadline included.
    const person = await stored(manual);
    expect(person.needsUpdateSource).toBe('manual');
    expect(person.needsUpdateSince?.getTime()).toBe(RECENT.getTime());
    expect(person.needsUpdateReason).toBe('Prices changed');
    expect(person.needsUpdateDueAt?.toISOString()).toBe('2026-12-01T00:00:00.000Z');

    // One Change Feed event for the change, and no audit event: a sweep is not a human action.
    const events = await fixtures.select().from(cdcChangeEvents).where(eq(cdcChangeEvents.itemId, stale));
    expect(events).toHaveLength(1);
    expect(events[0]!.changedFields).toEqual(['needs_update']);
    expect(events[0]!.source).toBe('system');
    expect(await fixtures.select().from(auditLog).where(like(auditLog.event, 'item_timeliness%'))).toHaveLength(0);
  });

  it('writes nothing on a second pass with nothing changed', async () => {
    const stale = await make('Stale once');
    await sweep();
    expect(await eventCount(stale)).toBe(1);

    const second = await sweep();
    expect(second.find((r) => r.siteId === fx.sites.a)).toEqual({ siteId: fx.sites.a, marked: [], cleared: [] });
    expect(await eventCount(stale)).toBe(1);
    expect((await stored(stale)).needsUpdateSince?.getTime()).toBe(NOW.getTime());
  });

  it('clears an automatic mark once the item is updated after the mark, and only then', async () => {
    const resolved = await make('Edited after the mark', {
      updatedAt: RECENT,
      needsUpdateSince: OLD,
      needsUpdateReason: AUTO_STALE_REASON,
      needsUpdateSource: 'auto',
    });
    const stillStale = await make('Still untouched', {
      updatedAt: OLD,
      // Marked after its last edit: the mark still describes the row, so it stays.
      needsUpdateSince: new Date(OLD.getTime() + 86_400_000),
      needsUpdateReason: AUTO_STALE_REASON,
      needsUpdateSource: 'auto',
    });
    // A manual mark is never cleared by the sweep, even after an edit.
    const manual = await make('Person decided', {
      updatedAt: RECENT,
      needsUpdateSince: OLD,
      needsUpdateReason: 'Rewrite the intro',
      needsUpdateSource: 'manual',
    });
    const before = await eventCount(resolved);

    const results = await sweep();
    const a = results.find((r) => r.siteId === fx.sites.a)!;
    expect(a.cleared).toEqual([resolved]);
    const cleared = await stored(resolved);
    expect(cleared.needsUpdateSince).toBeNull();
    expect(cleared.needsUpdateReason).toBeNull();
    expect(cleared.needsUpdateSource).toBeNull();
    expect(await eventCount(resolved)).toBe(before + 1);

    expect((await stored(stillStale)).needsUpdateSince).not.toBeNull();
    expect((await stored(manual)).needsUpdateSince?.getTime()).toBe(OLD.getTime());
    expect((await stored(manual)).needsUpdateSource).toBe('manual');
  });

  it('caps each site’s batch and picks up the rest on the next pass', async () => {
    const first = await make('First stale');
    const second = await make('Second stale');

    const one = await sweepStaleContent({ db, now: NOW, staleAfterDays: 365, limitPerSite: 1 });
    expect(one.find((r) => r.siteId === fx.sites.a)!.marked).toHaveLength(1);
    const markedAfterFirst = (await Promise.all([first, second].map(async (id) => Boolean((await stored(id)).needsUpdateSince)))).filter(Boolean);
    expect(markedAfterFirst).toHaveLength(1);

    // The remaining row is not lost: the next pass (any batch size) takes it.
    await sweep();
    for (const id of [first, second]) expect((await stored(id)).needsUpdateSource).toBe('auto');
  });

  it('resolves the threshold from the environment when the caller names none', async () => {
    // No `staleAfterDays`: the default 365 days applies, and this row is 400 days old.
    const stale = await make('Default threshold');
    const fresh = await make('Younger than the default', { updatedAt: RECENT });
    const results = await sweepStaleContent({ db, now: NOW });
    const a = results.find((r) => r.siteId === fx.sites.a)!;
    expect(a.marked).toEqual([stale]);
    expect((await stored(fresh)).needsUpdateSince).toBeNull();
  });

  it('runs each site in its own scope: site B’s stale item is marked for site B, not for site A', async () => {
    const a = await make('A stale', {}, 'a');
    const b = await make('B stale', {}, 'b');

    const results = await sweep();
    expect(results.find((r) => r.siteId === fx.sites.a)!.marked).toEqual([a]);
    expect(results.find((r) => r.siteId === fx.sites.b)!.marked).toEqual([b]);
    expect((await stored(a)).siteId).toBe(fx.sites.a);
    expect((await stored(b)).siteId).toBe(fx.sites.b);
  });
});
