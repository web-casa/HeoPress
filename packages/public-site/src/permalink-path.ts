import type { PermalinkSegment } from '@heopress/contracts/schemas';

/**
 * The path a permalink pattern gives an item (HeoPress P05 task 1.6; design
 * B). Pure: no database.
 *
 * Path contract: a stored path is `/`-separated decoded segments — Unicode
 * is fine (`/关于`), and a request path is percent-decoded before it is
 * matched. A value that goes into a segment (slug, category slug) is
 * trimmed and may not be `.` or `..`, nor contain `/`, `\`, `?`, `#`, `%`,
 * whitespace or control characters: such a slug is refused when saved.
 */

interface RouteInput {
  slug: string | null;
  number: number | null;
  date: Date;
  timezone: string;
  category: string | null;
  collection: string;
}

export type BuiltPath =
  | { ok: true; path: string }
  /** A value the pattern needs is not set (a draft without a slug): no route yet. */
  | { ok: false; reason: 'missing'; variable: string }
  /** A value cannot be a path segment. */
  | { ok: false; reason: 'invalid'; variable: string; value: string };

/** The date parts of `date` in `timezone` (`year`, two-digit `month` and `day`). */
function dateParts(date: Date, timezone: string): { year: string; month: string; day: string } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return { year: get('year'), month: get('month'), day: get('day') };
}

// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[/\\?#%\s\u0000-\u001f\u007f]/u;

/** Whether a value can be one path segment (after trimming). */
export function isValidSegment(value: string): boolean {
  const v = value.trim();
  return v !== '' && v !== '.' && v !== '..' && !FORBIDDEN.test(v);
}

export function buildPath(segments: PermalinkSegment[], input: RouteInput): BuiltPath {
  const out: string[] = [];
  const date = dateParts(input.date, input.timezone);
  const text = (variable: string, raw: string | null): BuiltPath | string => {
    if (raw === null || raw.trim() === '') return { ok: false, reason: 'missing', variable };
    if (!isValidSegment(raw)) return { ok: false, reason: 'invalid', variable, value: raw };
    return raw.trim();
  };
  for (const s of segments) {
    if (s.kind === 'literal') {
      out.push(s.value);
      continue;
    }
    let value: BuiltPath | string;
    switch (s.name) {
      case 'slug':
        value = text('slug', input.slug);
        break;
      case 'id':
        value = input.number === null ? { ok: false, reason: 'missing', variable: 'id' } : String(input.number);
        break;
      case 'year':
        value = date.year;
        break;
      case 'month':
        value = date.month;
        break;
      case 'day':
        value = date.day;
        break;
      case 'category':
        value = input.category === null ? 'uncategorized' : text('category', input.category);
        break;
      case 'collection':
        value = input.collection;
        break;
    }
    if (typeof value !== 'string') return value;
    out.push(value);
  }
  return { ok: true, path: `/${out.join('/')}` };
}

/** The longest request path the public resolver accepts, percent-encoded (and so the longest address it serves). */
export const MAX_URL_PATH = 2048;

/** A bare path as sent: segments percent-encoded, the trailing slash when the policy wants one. */
export function encodedPath(path: string, trailingSlash: boolean): string {
  if (path === '/') return '/';
  return `/${path.slice(1).split('/').map(encodeURIComponent).join('/')}${trailingSlash ? '/' : ''}`;
}
