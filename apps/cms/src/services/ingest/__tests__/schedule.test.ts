import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { nextRunAfter, runsBetween, zonedInstant, zoneOffset } from '../schedule';

/** Source schedules in their own time zones (HeoPress P08 task 1.4). */

const at = (s: string) => new Date(s);

describe('zonedInstant', () => {
  it('reads a wall-clock time in the zone', () => {
    expect(new Date(zonedInstant('Asia/Shanghai', 2026, 10, 26, 8, 0)).toISOString()).toBe('2026-10-26T00:00:00.000Z');
    expect(new Date(zonedInstant('America/New_York', 2026, 7, 1, 8, 0)).toISOString()).toBe('2026-07-01T12:00:00.000Z');
    expect(new Date(zonedInstant('America/New_York', 2026, 12, 1, 8, 0)).toISOString()).toBe('2026-12-01T13:00:00.000Z');
    expect(new Date(zonedInstant('UTC', 2026, 1, 1, 0, 0)).toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('a time skipped by spring-forward runs as far past the change as it fell into the gap', () => {
    // New York, 2026-03-08: 02:00 EST → 03:00 EDT. 02:30 does not exist; it runs at 03:30 EDT (07:30Z).
    expect(new Date(zonedInstant('America/New_York', 2026, 3, 8, 2, 30)).toISOString()).toBe('2026-03-08T07:30:00.000Z');
  });

  it('a time that exists twice (fall-back) is the earlier instant', () => {
    // New York, 2026-11-01: 02:00 EDT → 01:00 EST. 01:30 happens at 05:30Z and 06:30Z.
    expect(new Date(zonedInstant('America/New_York', 2026, 11, 1, 1, 30)).toISOString()).toBe('2026-11-01T05:30:00.000Z');
  });

  it('offsets come from the zone at that instant', () => {
    expect(zoneOffset('Asia/Kolkata', Date.UTC(2026, 0, 1))).toBe(5.5 * 3_600_000);
    expect(zoneOffset('Europe/London', Date.UTC(2026, 6, 1))).toBe(3_600_000);
  });
});

describe('nextRunAfter', () => {
  it('daily 08:00 in two zones: different instants', () => {
    const now = at('2026-10-26T01:00:00Z');
    expect(nextRunAfter(['08:00'], 'Asia/Shanghai', now).toISOString()).toBe('2026-10-27T00:00:00.000Z');
    expect(nextRunAfter(['08:00'], 'America/New_York', now).toISOString()).toBe('2026-10-26T12:00:00.000Z');
  });

  it('strictly after: the slot itself is not next', () => {
    const slot = at('2026-10-26T00:00:00Z');
    expect(nextRunAfter(['08:00'], 'Asia/Shanghai', slot).toISOString()).toBe('2026-10-27T00:00:00.000Z');
  });

  it('several times a day, in order', () => {
    const runs = runsBetween(['20:00', '08:00'], 'Asia/Shanghai', at('2026-10-26T00:00:00Z'), at('2026-10-27T12:00:00Z'));
    expect(runs.map((d) => d.toISOString())).toEqual(['2026-10-26T12:00:00.000Z', '2026-10-27T00:00:00.000Z', '2026-10-27T12:00:00.000Z']);
  });

  it('across spring-forward and fall-back, a daily time runs exactly once a day', () => {
    for (const tz of ['America/New_York', 'Europe/Berlin', 'Australia/Sydney']) {
      for (const time of ['01:30', '02:30', '08:00']) {
        const runs = runsBetween([time], tz, at('2026-01-01T00:00:00Z'), at('2027-01-01T00:00:00Z'));
        expect(runs.length, `${tz} ${time}`).toBeGreaterThanOrEqual(364);
        expect(runs.length, `${tz} ${time}`).toBeLessThanOrEqual(366);
        const days = runs.map((d) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, dateStyle: 'short' }).format(d));
        expect(new Set(days).size, `${tz} ${time}: one run per local day`).toBe(days.length);
      }
    }
  });

  it('property: the next run is after the reference, within two days, and on the schedule', () => {
    const zones = ['UTC', 'Asia/Shanghai', 'America/New_York', 'Europe/London', 'Australia/Lord_Howe', 'Asia/Kathmandu'];
    fc.assert(
      fc.property(
        fc.constantFrom(...zones),
        fc.array(fc.tuple(fc.integer({ min: 0, max: 23 }), fc.integer({ min: 0, max: 59 })), { minLength: 1, maxLength: 4 }),
        fc.integer({ min: Date.UTC(2025, 0, 1), max: Date.UTC(2028, 0, 1) }),
        (tz, pairs, ref) => {
          const times = pairs.map(([h, m]) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
          const next = nextRunAfter(times, tz, new Date(ref)).getTime();
          expect(next).toBeGreaterThan(ref);
          expect(next - ref).toBeLessThanOrEqual(2 * 86_400_000);
          // Asking again from any point between the reference and the run finds the same run: none skipped.
          const mid = ref + Math.floor((next - ref) / 2);
          expect(nextRunAfter(times, tz, new Date(mid)).getTime()).toBe(next);
          expect(nextRunAfter(times, tz, new Date(next - 1)).getTime()).toBe(next);
        },
      ),
    );
  });

  it('rejects an empty schedule and malformed times', () => {
    expect(() => nextRunAfter([], 'UTC', new Date())).toThrow();
    expect(() => nextRunAfter(['8:00'], 'UTC', new Date())).toThrow();
  });
});
