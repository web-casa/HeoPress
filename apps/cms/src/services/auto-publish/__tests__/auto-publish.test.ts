import { describe, expect, it } from 'vitest';
import { cadenceSlot, isSourceFresh, tierDecision } from '../auto-publish';
import { publishTransition } from '../locale-set';

const DAY = 86_400_000;

describe('auto-publish rules (P09 tasks 3.2, 3.3, 3.6, 3.7)', () => {
  it('tiers: L1/L2 review, L3 veto window, L4 immediate', () => {
    expect([0, 1, 2, 3, 4].map((l) => tierDecision(l as 0))).toEqual(['review_queue', 'review_queue', 'review_queue', 'veto_window', 'immediate']);
  });

  it('cadence: 30 ready with a limit of 10 → 10 a day, by the site\'s local day', () => {
    const now = new Date('2026-10-26T15:00:00Z');
    let published = 0;
    const out = [];
    for (let i = 0; i < 30; i++) {
      const slot = cadenceSlot({ now, timeZone: 'Asia/Shanghai', dailyLimit: 10, minIntervalMinutes: 0, publishedToday: published, lastPublishedAt: null, n: 1 });
      if (slot.ok) published++;
      out.push(slot);
    }
    expect(published).toBe(10);
    const deferred = out.filter((s) => !s.ok) as Array<{ reason: string; notBefore: Date }>;
    expect(deferred).toHaveLength(20);
    // 15:00Z is 23:00 in Shanghai: the next local day starts an hour later.
    expect(deferred[0]).toMatchObject({ reason: 'cadence_daily_limit', notBefore: new Date('2026-10-26T16:00:00Z') });
  });

  it('cadence: the minimum interval, and a set needing more slots than are left', () => {
    const now = new Date('2026-10-26T10:00:00Z');
    expect(cadenceSlot({ now, timeZone: 'UTC', dailyLimit: null, minIntervalMinutes: 30, publishedToday: 1, lastPublishedAt: new Date('2026-10-26T09:45:00Z'), n: 1 })).toEqual({ ok: false, reason: 'cadence_min_interval', notBefore: new Date('2026-10-26T10:15:00Z') });
    expect(cadenceSlot({ now, timeZone: 'UTC', dailyLimit: null, minIntervalMinutes: 30, publishedToday: 1, lastPublishedAt: new Date('2026-10-26T09:00:00Z'), n: 1 })).toEqual({ ok: true });
    expect(cadenceSlot({ now, timeZone: 'UTC', dailyLimit: 10, minIntervalMinutes: 0, publishedToday: 8, lastPublishedAt: null, n: 3 }).ok).toBe(false);
  });

  it('source freshness: 60 days by default; unknown age is not fresh', () => {
    const now = new Date('2026-10-26T00:00:00Z');
    expect(isSourceFresh(new Date(now.getTime() - 59 * DAY), now, 60)).toBe(true);
    expect(isSourceFresh(new Date(now.getTime() - 61 * DAY), now, 60)).toBe(false);
    expect(isSourceFresh(null, now, 60)).toBe(false);
  });

  it('publish transitions of the language set guard', () => {
    expect(publishTransition('draft', 'published')).toBe('publish');
    expect(publishTransition('published', 'draft')).toBe('unpublish');
    expect(publishTransition('published', 'published')).toBeNull();
    expect(publishTransition('draft', 'archived')).toBeNull();
  });
});
