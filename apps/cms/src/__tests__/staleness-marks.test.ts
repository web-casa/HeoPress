import { describe, expect, it } from 'vitest';
import {
  AUTO_STALE_REASON,
  DEFAULT_STALE_AFTER_DAYS,
  staleAfterDays,
  staleCutoff,
  STALE_AFTER_DAYS_ENV,
} from '../services/staleness/marks';
import { REVIEW_QUEUE_MAX_LIMIT, reviewQueueGroup, reviewQueueLimit } from '../services/staleness/queue';

/**
 * The pure parts of staleness detection (HeoPress v1.1; spec content/stale-content-queue): the threshold resolution,
 * the cutoff arithmetic, and how a review-queue row is counted in exactly one group.
 */

describe('staleness threshold', () => {
  it('defaults to a year and takes a positive day count from the environment', () => {
    expect(DEFAULT_STALE_AFTER_DAYS).toBe(365);
    expect(staleAfterDays({})).toBe(365);
    expect(staleAfterDays({ [STALE_AFTER_DAYS_ENV]: '30' })).toBe(30);
  });

  it('falls back to the default for values that are not a positive number of days', () => {
    for (const raw of ['', '   ', '0', '-5', 'soon', '12 days', 'NaN']) {
      expect(staleAfterDays({ [STALE_AFTER_DAYS_ENV]: raw }), raw).toBe(365);
    }
  });

  it('puts the cutoff exactly the threshold before now', () => {
    const now = new Date('2026-11-10T00:00:00.000Z');
    expect(staleCutoff(now, 1).toISOString()).toBe('2026-11-09T00:00:00.000Z');
    expect(staleCutoff(now, 365).toISOString()).toBe('2025-11-10T00:00:00.000Z');
  });

  it('names why an automatic mark exists without a lookup', () => {
    expect(AUTO_STALE_REASON).toBe('auto:stale');
  });
});

describe('review queue page size', () => {
  it('defaults to 50, keeps a smaller request and clamps to the maximum', () => {
    expect(reviewQueueLimit()).toBe(50);
    expect(reviewQueueLimit(10)).toBe(10);
    expect(reviewQueueLimit(REVIEW_QUEUE_MAX_LIMIT)).toBe(200);
    expect(reviewQueueLimit(5000)).toBe(200);
    expect(reviewQueueLimit(0)).toBe(1);
  });
});

describe('review queue grouping', () => {
  it('counts a row in exactly one group, marks first', () => {
    const since = new Date('2026-11-01T00:00:00.000Z');
    expect(reviewQueueGroup({ needsUpdateSince: since, needsUpdateSource: 'manual', editorialState: 'in_review' })).toBe('manual');
    expect(reviewQueueGroup({ needsUpdateSince: since, needsUpdateSource: 'auto', editorialState: 'in_review' })).toBe('auto');
    // A mark from before the source column existed (or a null source) is a person's mark, not the sweep's.
    expect(reviewQueueGroup({ needsUpdateSince: since, needsUpdateSource: null, editorialState: null })).toBe('manual');
    expect(reviewQueueGroup({ needsUpdateSince: null, needsUpdateSource: 'manual', editorialState: 'in_review' })).toBe('awaiting_review');
    expect(reviewQueueGroup({ needsUpdateSince: null, needsUpdateSource: null, editorialState: 'approved' })).toBeNull();
  });
});
