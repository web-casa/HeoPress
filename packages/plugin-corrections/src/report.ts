/**
 * Spam and validation of the public correction form (pure: no host, no I/O).
 *
 * The endpoint receives the fields of a browser form (`application/x-www-form-urlencoded` or JSON). Everything here runs
 * before a single item is written, so a refusal costs nothing and leaks nothing:
 *
 *   - `page_path` is a path on this site (`/notes/one/`), never a scheme, a host, a query, a fragment, a backslash or a
 *     `..` segment (checked again after percent-decoding). The endpoint never resolves the path, so a refusal never
 *     tells a stranger whether a page exists;
 *   - `excerpt` and `correction` are required, control characters are removed, markup is refused rather than sanitized
 *     (the correction is written into an operator's article, so it is plain text by contract) and each field has a cap;
 *   - `comment`, the reporter's name and the reporter's e-mail are optional; the e-mail is only syntax-checked here;
 *   - a filled honeypot (`website`) is accepted with the same neutral answer and dropped: the bot learns nothing.
 *
 * The parse result is data, never HTML.
 */

/** What the endpoint writes into a report item. */
interface ReportFields {
  pagePath: string;
  excerpt: string;
  correction: string;
  comment: string;
  reporterName: string;
  reporterEmail: string;
}

/** The one answer every accepted submission gets — valid, duplicated or trapped alike. */
export const NEUTRAL_ANSWER = 'Thanks. Reports are reviewed before a page is changed.';

/** Caps of the form's fields, in characters (the endpoint's body limit is the byte cap). */
export const REPORT_LIMITS = {
  pagePath: 512,
  excerpt: 1000,
  correction: 2000,
  comment: 2000,
  name: 120,
  email: 254,
} as const;

/** The field a bot fills and a person leaves alone. */
export const HONEYPOT_FIELD = 'website';

interface ReportFieldError {
  field: string;
  code:
    | 'required'
    | 'too_long'
    | 'not_a_path'
    | 'control_characters'
    | 'contains_markup'
    | 'invalid_email'
    | 'unexpected_type';
}

export type ReportParse =
  | { ok: true; trapped: boolean; fields: ReportFields | null }
  | { ok: false; errors: ReportFieldError[] };

/** C0/C1 controls (except tab and newline), DEL, and the bidi overrides that can reorder a page's text. */
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g;

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** Remove the control characters the form refuses to carry; normalize line endings. */
function stripControl(value: string): string {
  return value.replace(/\r\n?/g, '\n').replace(CONTROL, '');
}

function text(value: unknown): string {
  return typeof value === 'string' ? stripControl(value).trim() : '';
}

function singleLine(value: unknown): string {
  return text(value).replace(/\s+/g, ' ').trim();
}

const hasMarkup = (value: string): boolean => /[<>]/.test(value);

const EMAIL =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-](?:[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]{0,63})@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

/** Whether `value` is an address worth storing: one `@`, a dotted domain, no whitespace. */
function isEmailAddress(value: string): boolean {
  return value.length <= REPORT_LIMITS.email && EMAIL.test(value) && !value.includes('..');
}

/**
 * The path of a page on this site, or why it is not one. A leading slash, no scheme or host, no query or fragment, no
 * backslash or whitespace, no `.`/`..` segment — also after percent-decoding, so `/%2e%2e/` is refused too. The
 * reserved `/_` and `/api` prefixes are not pages: the extension endpoints and the CMS API live there.
 */
export function pagePathProblem(raw: string): 'required' | 'too_long' | 'not_a_path' | 'control_characters' | null {
  if (!raw) return 'required';
  if (/[\u0000-\u001f\u007f]/.test(raw)) return 'control_characters';
  if (raw.length > REPORT_LIMITS.pagePath) return 'too_long';
  if (!raw.startsWith('/') || raw.startsWith('//')) return 'not_a_path';
  if (raw === '/') return null;
  if (raw.startsWith('/_') || raw === '/api' || raw.startsWith('/api/')) return 'not_a_path';
  if (/[\\?#]/.test(raw) || /\s/.test(raw)) return 'not_a_path';
  const segments = raw.split('/').filter(Boolean);
  if (segments.length === 0) return 'not_a_path';
  for (const segment of segments) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return 'not_a_path';
    }
    if (decoded === '.' || decoded === '..') return 'not_a_path';
    if (/[/\\?#]/.test(decoded) || /\s/.test(decoded)) return 'not_a_path';
  }
  return null;
}

/**
 * Read one submission: the values a report item is made of, the neutral trap, or every field error at once (so a person
 * fixes the form in one pass). Nothing here reads or writes the site.
 */
export function parseReport(body: unknown): ReportParse {
  const input = obj(body);
  if (!input) return { ok: false, errors: [{ field: 'body', code: 'unexpected_type' }] };

  // A bot that fills the hidden field is answered exactly like a person and dropped: no item, no different answer.
  if (singleLine(input[HONEYPOT_FIELD]) !== '') return { ok: true, trapped: true, fields: null };

  const errors: ReportFieldError[] = [];
  const add = (field: string, code: ReportFieldError['code']) => errors.push({ field, code });

  const pagePath = singleLine(input.page_path);
  const pathProblem = pagePathProblem(pagePath);
  if (pathProblem === 'required') add('page_path', 'required');
  else if (pathProblem) add('page_path', pathProblem);

  const excerpt = text(input.excerpt);
  if (!excerpt) add('excerpt', 'required');
  else if (hasMarkup(excerpt)) add('excerpt', 'contains_markup');
  else if (excerpt.length > REPORT_LIMITS.excerpt) add('excerpt', 'too_long');

  const correction = text(input.correction);
  if (!correction) add('correction', 'required');
  else if (hasMarkup(correction)) add('correction', 'contains_markup');
  else if (correction.length > REPORT_LIMITS.correction) add('correction', 'too_long');

  const comment = text(input.comment);
  if (hasMarkup(comment)) add('comment', 'contains_markup');
  else if (comment.length > REPORT_LIMITS.comment) add('comment', 'too_long');

  const reporterName = singleLine(input.name);
  if (hasMarkup(reporterName)) add('name', 'contains_markup');
  else if (reporterName.length > REPORT_LIMITS.name) add('name', 'too_long');

  const reporterEmail = singleLine(input.email);
  if (reporterEmail && !isEmailAddress(reporterEmail)) add('email', 'invalid_email');

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, trapped: false, fields: { pagePath, excerpt, correction, comment, reporterName, reporterEmail } };
}
