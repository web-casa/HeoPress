import { describe, expect, it } from 'vitest';
import {
  buildDigest,
  DEFAULT_REMINDER_REPEAT_DAYS,
  DIGEST_TITLE_LIMIT,
  digestTitle,
  REMINDER_REPEAT_DAYS_ENV,
  reminderCutoff,
  reminderRepeatDays,
  REVIEW_QUEUE_PATH,
} from '../services/staleness/reminders';

/**
 * The pure parts of review reminders (HeoPress v1.1; spec content/review-reminders): the repeat-interval resolution,
 * the cutoff arithmetic and the digest's shape (title bound, remainder count, queue link).
 */

describe('review reminder interval', () => {
  it('defaults to a week and takes a positive day count from the environment', () => {
    expect(DEFAULT_REMINDER_REPEAT_DAYS).toBe(7);
    expect(reminderRepeatDays({})).toBe(7);
    expect(reminderRepeatDays({ [REMINDER_REPEAT_DAYS_ENV]: '14' })).toBe(14);
  });

  it('falls back to the default for values that are not a positive number of days', () => {
    for (const raw of ['', '   ', '0', '-1', 'weekly', '7 days', 'NaN']) {
      expect(reminderRepeatDays({ [REMINDER_REPEAT_DAYS_ENV]: raw }), raw).toBe(7);
    }
  });

  it('puts the cutoff exactly the interval before now', () => {
    const now = new Date('2026-11-10T00:00:00.000Z');
    expect(reminderCutoff(now, 7).toISOString()).toBe('2026-11-03T00:00:00.000Z');
  });
});

describe('review reminder digest', () => {
  const dueAt = new Date('2026-11-01T00:00:00.000Z');
  const entry = (title: string) => ({ title, collection: 'articles', dueAt });

  it('names one item in the singular with its deadline and the queue link', () => {
    const digest = buildDigest([entry('Price list')]);
    expect(digest.subject).toBe('1 item due for review');
    expect(digest.message).toContain('1 item has reached its review date:');
    expect(digest.message).toContain('- "Price list" (articles) — due 2026-11-01');
    expect(digest.message).toContain(`Open the review queue: ${REVIEW_QUEUE_PATH}`);
  });

  it('lists at most five titles and counts the rest', () => {
    const digest = buildDigest(Array.from({ length: 7 }, (_, i) => entry(`Item ${i + 1}`)));
    expect(digest.subject).toBe('7 items due for review');
    expect(digest.message.split('\n').filter((line) => line.startsWith('- '))).toHaveLength(DIGEST_TITLE_LIMIT);
    expect(digest.message).toContain('and 2 more.');
  });

  it('keeps a title to one bounded line and never renders an empty one', () => {
    expect(digestTitle('  Two\nlines\there  ', 'fallback')).toBe('Two lines here');
    expect(digestTitle('   ', 'Untitled')).toBe('Untitled');
    expect(digestTitle('x'.repeat(200), 'fallback')).toHaveLength(120);
    expect(digestTitle('x'.repeat(200), 'fallback').endsWith('…')).toBe(true);
  });
});
