// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { compareKeyset } from '../modules/cdc/change-feed/subscription-state';
import {
  InMemoryRetentionStore,
  pruneChangeFeed,
  type InMemoryRetentionSubscription,
  type StaleSubscriptionNotice,
} from '../modules/cdc/change-feed/retention';

/**
 * Feature: cdc-extension-integration, Property 10: Retention & stale
 *
 * For any retention window and cursor state: prune SHALL delete exactly the
 * events older than the cutoff that every registered subscription has
 * confirmed; a subscription that lost events after its checkpoint (one that
 * was not registered) SHALL flip to `stale` (with a notification) and never
 * be silently skipped — an old checkpoint alone is not a loss (HeoPress P04,
 * Codex review P04-3 #8); runs are idempotent (Req 6.1, 6.3, 6.4).
 */

const NOW_MS = 1_900_000_000_000;
const DAY = 86_400_000;

const retentionDaysArb = fc.integer({ min: 1, max: 90 });

const eventArb = fc
  .record({ ageDays: fc.double({ min: 0, max: 120, noNaN: true }) })
  .map(({ ageDays }, ) => ({
    siteId: 'site_A',
    occurredAt: new Date(NOW_MS - ageDays * DAY),
  }));

const subArb: fc.Arbitrary<Omit<InMemoryRetentionSubscription, 'id' | 'name'>> = fc.record({
  siteId: fc.constant('site_A'),
  status: fc.constantFrom<'active' | 'paused' | 'dead' | 'stale'>(
    'active',
    'paused',
    'dead',
    'stale',
  ),
  cursor: fc.option(
    fc
      .double({ min: 0, max: 120, noNaN: true })
      .map((ageDays) => ({ occurredAtMs: NOW_MS - ageDays * DAY, eventId: 'e' })),
    { nil: null },
  ),
  // Mostly registered; some not (legacy rows) — only those can lose events.
  registered: fc.oneof(fc.constant(undefined), fc.constant(true), fc.constant(false)),
});

describe('Feature: cdc-extension-integration, Property 10: Retention & stale', () => {
  it('prunes exactly the events past the cutoff and flips exactly the lagging subs to stale', async () => {
    await fc.assert(
      fc.asyncProperty(
        retentionDaysArb,
        fc.array(eventArb, { maxLength: 30 }),
        fc.array(subArb, { maxLength: 10 }),
        async (retentionDays, events, subSeeds) => {
          const cutoffMs = NOW_MS - retentionDays * DAY;
          const subs = subSeeds.map((s, i) => ({ ...s, id: `sub_${i}`, name: `s${i}` }));
          const store = new InMemoryRetentionStore(
            structuredClone(subs),
            events.map((e, i) => ({ ...e, id: `evt_${i}` })),
            [],
          );
          const notices: StaleSubscriptionNotice[] = [];
          const result = await pruneChangeFeed(
            {
              store,
              retentionDays,
              now: () => new Date(NOW_MS),
              notifyStale: (n) => {
                notices.push(n);
              },
            },
            'site_A',
          );

          // Events (HeoPress P04, spec content/change-events "事件保留"): an
          // event goes only when it is past the cutoff AND every subscription
          // that is not dead has confirmed it; a lagging one keeps its events.
          const registered = subs.filter((s) => s.status !== 'dead' && s.registered !== false);
          const prunable = (e: { id: string; occurredAt: Date }) =>
            e.occurredAt.getTime() < cutoffMs &&
            registered.every(
              (s) => s.cursor !== null && compareKeyset({ occurredAtMs: e.occurredAt.getTime(), eventId: e.id }, s.cursor) <= 0,
            );
          const withIds = events.map((e, i) => ({ ...e, id: `evt_${i}` }));
          const expectedKept = withIds.filter((e) => !prunable(e)).length;
          expect(store.events).toHaveLength(expectedKept);
          expect(result.prunedEvents).toBe(events.length - expectedKept);
          expect(store.events.every((e) => !prunable(e))).toBe(true);

          // Subs: active/paused that lost an event after their checkpoint → stale + notice.
          const pruned = withIds.filter(prunable).map((e) => ({ occurredAtMs: e.occurredAt.getTime(), eventId: e.id }));
          const expectedStale = subs.filter(
            (s) =>
              (s.status === 'active' || s.status === 'paused') &&
              pruned.some((p) => s.cursor === null || compareKeyset(p, s.cursor) > 0),
          );
          // A registered subscription never loses events.
          expect(expectedStale.every((s) => s.registered === false)).toBe(true);
          expect(new Set(result.staleSubscriptions)).toEqual(
            new Set(expectedStale.map((s) => s.id)),
          );
          expect(notices).toHaveLength(expectedStale.length);
          for (const s of expectedStale) {
            expect(store.subs.find((x) => x.id === s.id)!.status).toBe('stale');
          }
          // dead/stale/null-cursor không bao giờ bị đụng.
          for (const s of subs) {
            if (!expectedStale.some((x) => x.id === s.id)) {
              expect(store.subs.find((x) => x.id === s.id)!.status).toBe(s.status);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('a subscription goes stale exactly when an event after its checkpoint was deleted, never for an old checkpoint alone', async () => {
    // Registered subscriptions read recently; unregistered ones stopped long
    // ago — so events between the two are often deleted (the case under test).
    const cursorAt = (min: number, max: number) =>
      fc.double({ min, max, noNaN: true }).map((ageDays) => ({ occurredAtMs: NOW_MS - ageDays * DAY, eventId: 'e' }));
    const subSeedArb = fc.oneof(
      fc.record({ cursor: cursorAt(0, 20), registered: fc.constant(true) }),
      fc.record({ cursor: cursorAt(0, 120), registered: fc.constant(false) }),
    );
    let lost = 0;
    await fc.assert(
      fc.asyncProperty(
        // Short retention and old events: most of them are past the cutoff,
        // so deletions — and losses for unregistered readers — are common.
        fc.integer({ min: 1, max: 30 }),
        fc.array(
          fc.double({ min: 31, max: 120, noNaN: true }).map((ageDays) => ({ siteId: 'site_A', occurredAt: new Date(NOW_MS - ageDays * DAY) })),
          { minLength: 1, maxLength: 20 },
        ),
        fc.array(subSeedArb, { minLength: 1, maxLength: 6 }),
        async (retentionDays, events, seeds) => {
          const subs = seeds.map((s, i) => ({ ...s, id: `sub_${i}`, name: `s${i}`, siteId: 'site_A', status: 'active' as const }));
          const store = new InMemoryRetentionStore(structuredClone(subs), events.map((e, i) => ({ ...e, id: `evt_${i}` })), []);
          const result = await pruneChangeFeed({ store, retentionDays, now: () => new Date(NOW_MS) }, 'site_A');
          const pruned = store.pruned;
          for (const s of subs) {
            const lostEvents = pruned.some((p) => compareKeyset(p, s.cursor) > 0);
            expect(result.staleSubscriptions.includes(s.id)).toBe(lostEvents);
            if (s.registered) expect(lostEvents).toBe(false);
            if (lostEvents) lost += 1;
          }
        },
      ),
      { numRuns: 200 },
    );
    expect(lost).toBeGreaterThan(0); // the case is really generated
  });

  it('is idempotent: a second run at the same instant prunes nothing and notifies nobody', async () => {
    await fc.assert(
      fc.asyncProperty(
        retentionDaysArb,
        fc.array(eventArb, { maxLength: 20 }),
        fc.array(subArb, { maxLength: 8 }),
        async (retentionDays, events, subSeeds) => {
          const subs = subSeeds.map((s, i) => ({ ...s, id: `sub_${i}`, name: `s${i}` }));
          const store = new InMemoryRetentionStore(
            structuredClone(subs),
            events.map((e, i) => ({ ...e, id: `evt_${i}` })),
          );
          const deps = { store, retentionDays, now: () => new Date(NOW_MS) };
          await pruneChangeFeed(deps, 'site_A');
          const second = await pruneChangeFeed(deps, 'site_A');
          expect(second.prunedEvents).toBe(0);
          expect(second.staleSubscriptions).toHaveLength(0);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('never touches another site', async () => {
    const store = new InMemoryRetentionStore(
      [{ id: 'b1', name: 'b', siteId: 'site_B', status: 'active', cursor: { occurredAtMs: 0, eventId: 'e' } }],
      [{ id: 'eb', siteId: 'site_B', occurredAt: new Date(0) }],
    );
    const result = await pruneChangeFeed(
      { store, retentionDays: 1, now: () => new Date(NOW_MS) },
      'site_A',
    );
    expect(result.prunedEvents).toBe(0);
    expect(store.events).toHaveLength(1);
    expect(store.subs[0]!.status).toBe('active');
  });
});
