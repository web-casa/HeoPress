/**
 * When a source runs next (HeoPress P08 task 1.4; spec ingest/sources "按计划采集").
 *
 * A source runs at local times of day (`HH:MM`) in its own IANA time zone, so
 * "08:00 Asia/Shanghai" and "08:00 America/New_York" are different instants
 * and stay right across daylight-saving changes:
 *
 *   - a time that does not exist that day (skipped by a spring-forward
 *     change, e.g. 02:30 in New York) runs as many minutes after the change as
 *     it fell into the gap (03:30), the way a wall clock moved forward reads;
 *   - a time that exists twice (fall-back change) runs once, at the earlier
 *     instant.
 *
 * Pure; time zone data from the runtime's Intl (Node ships full ICU).
 */

const DAY = 86_400_000;

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function localParts(timeZone: string, instant: number): LocalParts {
  const out: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(new Date(instant))) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return { year: out.year!, month: out.month!, day: out.day!, hour: out.hour!, minute: out.minute!, second: out.second! };
}

/** The zone's offset from UTC at `instant`, in milliseconds (east positive). */
export function zoneOffset(timeZone: string, instant: number): number {
  const p = localParts(timeZone, instant);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/**
 * The instant at which the wall clock in `timeZone` reads the given local date
 * and time; gaps and overlaps resolved as described above.
 */
export function zonedInstant(timeZone: string, year: number, month: number, day: number, hour: number, minute: number): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  // The offsets in force a day either side cover any single transition.
  const before = zoneOffset(timeZone, wall - DAY);
  const after = zoneOffset(timeZone, wall + DAY);
  const candidates = [...new Set([before, after])]
    .map((offset) => wall - offset)
    .filter((instant) => zoneOffset(timeZone, instant) === wall - instant)
    .sort((a, b) => a - b);
  if (candidates.length) return candidates[0]!;
  // In the gap: read with the offset before the change, which lands as far past the change as the time was into the gap.
  return wall - before;
}

function parseTime(t: string): [number, number] {
  const m = /^(\d{2}):(\d{2})$/.exec(t);
  if (!m) throw new Error(`Not a time of day: ${t}`);
  return [Number(m[1]), Number(m[2])];
}

/**
 * The first scheduled instant strictly after `after`. `times` are local
 * `HH:MM` values in `timeZone`. Throws on an empty schedule.
 */
export function nextRunAfter(times: readonly string[], timeZone: string, after: Date): Date {
  if (!times.length) throw new Error('A schedule needs at least one time.');
  const parsed = times.map(parseTime);
  const ref = after.getTime();
  const today = localParts(timeZone, ref);
  let best = Number.POSITIVE_INFINITY;
  // Yesterday through two days ahead in local dates: enough for any offset and transition.
  for (let d = -1; d <= 2; d += 1) {
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day + d));
    for (const [h, m] of parsed) {
      const at = zonedInstant(timeZone, date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), h, m);
      if (at > ref && at < best) best = at;
    }
  }
  return new Date(best);
}

/** Every scheduled instant in (`from`, `to`], in order (tests and previews). */
export function runsBetween(times: readonly string[], timeZone: string, from: Date, to: Date): Date[] {
  const out: Date[] = [];
  let cursor = from;
  for (;;) {
    const next = nextRunAfter(times, timeZone, cursor);
    if (next.getTime() > to.getTime()) return out;
    out.push(next);
    cursor = next;
    if (out.length > 10_000) throw new Error('Too many runs in range.');
  }
}
