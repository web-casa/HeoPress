import { encodedPath, MAX_URL_PATH } from '@heopress/public-site';
import { pathOf } from '@heopress/public-site';

/**
 * Reading redirect export files (HeoPress P05 tasks 1.7, 1.8; spec
 * content/site-network-model "批量导入重定向"; design B). Pure.
 *
 * Accepted formats (detected from the content when not named):
 * - `csv`: `from,to[,type]` with an optional header; `type` is `exact`
 *   (default) or `prefix`; a source ending in `/*` is a prefix too.
 * - `redirection`: the WordPress Redirection plugin's JSON export
 *   (`{ "redirects": [{ "url", "match_data": { "source": { "flag_regex",
 *   "flag_case", "flag_query", … } }, "action_type", "action_data": { "url" },
 *   "action_code", "match_type", "enabled" }] }`) or its CSV (`source,
 *   target, regex, code`, with or without the header).
 * - `yoast`: Yoast SEO Premium's redirect CSV (`Origin, Target, Type,
 *   Format` where Format is `plain` or `regex`).
 * - `rank_math`: Rank Math's redirection CSV (`source, matching,
 *   destination, type, status`).
 *
 * A record becomes an exact or prefix rule only when the rule does what the
 * plugin did; otherwise it is listed for a person with its original text and
 * the reason — nothing is dropped silently. Converted:
 * - plain paths, and absolute URLs on the site's primary domain or a plain
 *   alias (not a language entry domain: its paths are another language's);
 * - a source ending in `/*` (plain CSV): a prefix rule keeping the rest;
 * - exactly two regular-expression shapes, anchored at the start:
 *   `^/a/(.*)$ → /b/$1` (a prefix rule: the captured rest is appended at a
 *   segment boundary, as a prefix rule does) and `^/a$` or `^/a/?$ → /b`
 *   (an exact rule; a trailing slash is the same address here).
 * Not converted: any other regular expression; Rank Math `start`,
 * `contains`, `end` (they send many paths to one target: the rest is not
 * kept); records switched off in the export; actions other than a URL
 * redirect; conditional matches; queries or fragments; other hosts; codes
 * other than 301 and 308; case-insensitive matches; sources naming a host on
 * a site with language entry domains; paths too long to request or not
 * valid text. Conversions that only widen a match or keep more of the
 * request (a 308 answered as 301; a request with a query, or with the other
 * trailing slash form, redirected too, its query kept) carry a note.
 */

export type ImportFormat = 'csv' | 'redirection' | 'yoast' | 'rank_math';

interface ImportRecord {
  /** 1-based line (CSV) or entry number (JSON). */
  line: number;
  /** The record as it was in the file. */
  original: string;
}

export interface ConvertedRule extends ImportRecord {
  from: string;
  to: string;
  match: 'exact' | 'prefix';
  /** What the conversion changed (for the report). */
  notes?: string[];
}

export interface ManualRecord extends ImportRecord {
  reason: string;
}

export interface ParsedImport {
  format: ImportFormat;
  rules: ConvertedRule[];
  manual: ManualRecord[];
}

/** The site's hosts as an import sees them. */
export interface ImportHosts {
  /** The primary domain and plain aliases: an absolute URL there is a path of this site. */
  site: Set<string>;
  /** Language entry domains: their paths belong to another language. */
  languageEntries: Set<string>;
}

const stripBom = (text: string) => text.replace(/^﻿/, '');

/**
 * RFC 4180 CSV: quoted fields, doubled quotes, commas and line breaks (LF, CRLF or CR) inside quotes.
 * Returns rows with their starting line, or the line of a quote left open.
 */
export function parseCsv(text: string): { rows: Array<{ line: number; cells: string[]; raw: string }> } | { error: string } {
  const rows: Array<{ line: number; cells: string[]; raw: string }> = [];
  const src = stripBom(text);
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let quoteLine = 0;
  let line = 1;
  let rowLine = 1;
  let rowStart = 0;
  const pushRow = (end: number) => {
    cells.push(cell);
    if (!(cells.length === 1 && cells[0]!.trim() === '')) rows.push({ line: rowLine, cells, raw: src.slice(rowStart, end) });
    cells = [];
    cell = '';
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    const lineBreak = ch === '\n' || ch === '\r';
    const crlf = ch === '\r' && src[i + 1] === '\n';
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
        // Only a separator or the end of the row may follow a closing quote.
        const next = src[i + 1];
        if (next !== undefined && next !== ',' && next !== '\n' && next !== '\r') return { error: `text after a closing quote on line ${line}` };
      } else {
        cell += crlf ? '\r\n' : ch;
        if (crlf) i++;
        if (lineBreak) line++;
      }
      continue;
    }
    if (ch === '"' && cell === '') {
      quoted = true;
      quoteLine = line;
    } else if (ch === '"') {
      return { error: `a quote inside an unquoted field on line ${line}` };
    } else if (ch === ',') {
      cells.push(cell);
      cell = '';
    } else if (lineBreak) {
      pushRow(i);
      if (crlf) i++;
      line++;
      rowLine = line;
      rowStart = i + 1;
    } else cell += ch;
  }
  if (quoted) return { error: `a quote opened on line ${quoteLine} is never closed` };
  if (cell !== '' || cells.length > 0) pushRow(src.length);
  return { rows };
}

const lower = (cells: string[]) => cells.map((c) => c.trim().toLowerCase());

export function detectFormat(content: string): ImportFormat {
  const trimmed = stripBom(content).trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'redirection';
  const parsed = parseCsv(trimmed);
  const header = lower('rows' in parsed ? (parsed.rows[0]?.cells ?? []) : []);
  if (header.includes('origin') && header.includes('target')) return 'yoast';
  if (header.includes('destination') && (header.includes('source') || header.includes('sources'))) return 'rank_math';
  if (header.includes('source') && header.includes('target') && header.includes('regex')) return 'redirection';
  return 'csv';
}

type Path = { ok: true; path: string } | { ok: false; reason: string };

/**
 * A source or target as a bare decoded path: an absolute URL counts only on the site's primary domain or a
 * plain alias; no query or fragment; percent-decoded segments; no trailing slash (the site's slash policy
 * applies); short enough to be requested.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export function toPath(raw: string, hosts: ImportHosts): Path {
  let value = raw.trim();
  if (value === '') return { ok: false, reason: 'empty path' };
  if (LONE_SURROGATE.test(value)) return { ok: false, reason: 'not valid text (a broken character)' };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return { ok: false, reason: 'not a valid URL' };
    }
    const host = url.hostname.toLowerCase();
    if (hosts.languageEntries.has(host)) {
      return { ok: false, reason: `on a language entry domain (${host}): its paths are another language's, not this rule's` };
    }
    if (!hosts.site.has(host)) return { ok: false, reason: `a different host (${url.hostname}): only this site's paths can be redirected to` };
    if (url.search || url.hash) return { ok: false, reason: 'has a query or fragment' };
    value = url.pathname;
  }
  if (value.includes('?') || value.includes('#')) return { ok: false, reason: 'has a query or fragment' };
  if (!value.startsWith('/')) value = `/${value}`;
  const segments: string[] = [];
  for (const s of value.split('/').slice(1)) {
    if (s === '') continue; // trailing slash, doubled slashes
    let decoded: string;
    try {
      decoded = decodeURIComponent(s);
    } catch {
      return { ok: false, reason: 'cannot be decoded' };
    }
    if (decoded === '.' || decoded === '..' || decoded.includes('/')) return { ok: false, reason: 'not a plain path' };
    segments.push(decoded);
  }
  const path = pathOf(segments);
  // Requestable on every address: encoded, with a trailing slash and the longest language prefix (17).
  if (encodedPath(path, true).length + 17 > MAX_URL_PATH) return { ok: false, reason: 'too long to be requested' };
  return { ok: true, path };
}

/** A literal path inside a regular expression: no metacharacter at all (a `.` would match any character). */
const LITERAL = String.raw`\/[^().*+?[\]{}|\\^$]*`;
const PREFIX_REGEX = new RegExp(String.raw`^\^((?:${LITERAL})?)\/\(\.\*\)\$?$`);
const EXACT_REGEX = new RegExp(String.raw`^\^((?:${LITERAL})?)(?:\/\??)?\$$`);

/** The two regular-expression shapes that are plain rules, else null. */
function fromRegex(source: string, target: string): { from: string; to: string; match: 'exact' | 'prefix' } | null {
  const src = source.trim();
  const dst = target.trim();
  const prefix = PREFIX_REGEX.exec(src);
  // `^/a/(.*)$ → /b/$1` (or `→ /$1`): the rest goes after a segment boundary, as a prefix rule keeps it.
  if (prefix && /^[^$]*\/\$1$/.test(dst) && !dst.slice(0, -2).includes('$')) {
    return { from: prefix[1] || '/', to: dst.slice(0, -3) || '/', match: 'prefix' };
  }
  const exact = EXACT_REGEX.exec(src);
  if (exact && exact[1] && !dst.includes('$')) return { from: exact[1], to: dst, match: 'exact' };
  return null;
}

interface RawRule {
  line: number;
  original: string;
  from: string;
  to: string;
  match: 'exact' | 'prefix' | 'regex' | 'unsupported';
  /** Why a record is not a rule (with `unsupported`). */
  refusal?: string;
  status?: number;
  notes?: string[];
}

function convert(r: RawRule, hosts: ImportHosts): ConvertedRule | ManualRecord {
  const base = { line: r.line, original: r.original };
  if (r.match === 'unsupported') return { ...base, reason: r.refusal ?? 'unsupported matching' };
  if (r.status !== undefined && r.status !== 301 && r.status !== 308) {
    return { ...base, reason: `status ${r.status}: only permanent redirects (301) are imported` };
  }
  const notes = [...(r.notes ?? [])];
  if (r.status === 308) notes.push('308 in the export: answered with 301 here');
  let from = r.from;
  let to = r.to;
  let match: 'exact' | 'prefix' = r.match === 'prefix' ? 'prefix' : 'exact';
  if (r.match === 'regex') {
    const plain = fromRegex(r.from, r.to);
    if (!plain) return { ...base, reason: 'regular expression that is not a plain path or prefix rule' };
    ({ from, to, match } = plain);
  } else if (from.trim().endsWith('/*')) {
    from = from.trim().slice(0, -2) || '/';
    match = 'prefix';
  }
  if (to.trim() === '') return { ...base, reason: 'no target' };
  // A URL-layer rule applies on every domain of the site: a source naming one host keeps its meaning only when
  // the site has no language entry domains (aliases go to the primary domain anyway).
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(from.trim()) && hosts.languageEntries.size > 0) {
    return { ...base, reason: 'a source with a host: here the rule would apply on every domain of the site, its language entry domains too' };
  }
  const f = toPath(from, hosts);
  if (!f.ok) return { ...base, reason: `source ${f.reason}` };
  const t = toPath(to, hosts);
  if (!t.ok) return { ...base, reason: `target ${t.reason}` };
  return { ...base, from: f.path, to: t.path, match, ...(notes.length ? { notes } : {}) };
}

const truthy = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true';

/** One entry of the Redirection JSON export. */
function redirectionEntry(entry: unknown, i: number): RawRule {
  const e = (entry ?? {}) as Record<string, unknown>;
  const original = JSON.stringify(entry);
  const base = { line: i + 1, original, from: String(e.url ?? ''), to: '' };
  if (e.enabled === false || e.enabled === 0 || e.status === 'disabled') return { ...base, match: 'unsupported', refusal: 'switched off in the export' };
  const matchType = typeof e.match_type === 'string' && e.match_type !== '' ? e.match_type : 'url';
  if (matchType !== 'url') return { ...base, match: 'unsupported', refusal: `conditional redirect (${matchType})` };
  const actionType = typeof e.action_type === 'string' && e.action_type !== '' ? e.action_type : 'url';
  if (actionType !== 'url') return { ...base, match: 'unsupported', refusal: `action "${actionType}" is not a redirect to a URL` };
  const action = e.action_data;
  const to = typeof action === 'string' ? action : String((action as Record<string, unknown> | null)?.url ?? '');
  const flags = ((e.match_data as Record<string, unknown> | undefined)?.source ?? {}) as Record<string, unknown>;
  const regex = truthy(e.regex) || truthy(flags.flag_regex);
  // Matching only the exact case would miss paths the export redirected: not equivalent.
  if (truthy(flags.flag_case)) return { ...base, match: 'unsupported', refusal: 'case-insensitive matching (here a path matches with its exact case only)' };
  const notes: string[] = [];
  if (flags.flag_trailing === false) notes.push('the export matched the trailing slash exactly; here both forms redirect');
  if (flags.flag_query === 'exact' || flags.flag_query === undefined) notes.push('requests with a query are redirected too here (the query is kept)');
  if (flags.flag_query === 'ignore') notes.push('the export drops the query on redirect; here it is kept');
  return {
    ...base,
    to,
    match: regex ? 'regex' : 'exact',
    status: e.action_code === undefined ? undefined : Number(e.action_code),
    notes,
  };
}

function rawRules(content: string, format: ImportFormat): RawRule[] | { error: string } {
  const text = stripBom(content);
  if (format === 'redirection' && /^\s*[[{]/.test(text)) {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { error: 'not valid JSON' };
    }
    const list = Array.isArray(json) ? json : (json as { redirects?: unknown }).redirects;
    if (!Array.isArray(list)) return { error: 'no "redirects" list in the JSON' };
    return list.map(redirectionEntry);
  }
  const parsed = parseCsv(text);
  if ('error' in parsed) return parsed;
  const rows = parsed.rows;
  if (rows.length === 0) return [];
  const header = lower(rows[0]!.cells);
  const col = (...names: string[]) => header.findIndex((h) => names.includes(h));
  const cell = (cells: string[], i: number) => (i >= 0 ? (cells[i] ?? '').trim() : '');
  const status = (v: string) => (v === '' ? undefined : Number(v));

  if (format === 'yoast') {
    const [o, t, ty, fo] = [col('origin'), col('target'), col('type'), col('format')];
    return rows.slice(1).map((r) => ({
      line: r.line,
      original: r.raw,
      from: cell(r.cells, o),
      to: cell(r.cells, t),
      match: cell(r.cells, fo).toLowerCase() === 'regex' ? 'regex' : 'exact',
      status: status(cell(r.cells, ty)),
    }));
  }
  if (format === 'rank_math') {
    const [s, m, d, ty, st] = [col('source', 'sources'), col('matching', 'comparison'), col('destination'), col('type', 'header_code'), col('status')];
    return rows.slice(1).map((r) => {
      const how = cell(r.cells, m).toLowerCase() || 'exact';
      const base = { line: r.line, original: r.raw, from: cell(r.cells, s), to: cell(r.cells, d), status: status(cell(r.cells, ty)) };
      if (st >= 0 && cell(r.cells, st).toLowerCase() === 'inactive') return { ...base, match: 'unsupported', refusal: 'switched off in the export' } satisfies RawRule;
      if (how === 'exact') return { ...base, match: 'exact' } satisfies RawRule;
      if (how === 'regex') return { ...base, match: 'regex' } satisfies RawRule;
      // start / contains / end send many paths to one target: a prefix rule would keep the rest instead.
      return { ...base, match: 'unsupported', refusal: `matching "${how}" sends many paths to one target; it is not a path or prefix rule` } satisfies RawRule;
    });
  }
  if (format === 'redirection') {
    // The CSV may come without its header: then the columns are source, target, regex, code.
    const hasHeader = header.includes('source') && header.includes('target');
    const [s, t, rx, code, st] = hasHeader ? [col('source'), col('target'), col('regex'), col('code'), col('status')] : [0, 1, 2, 3, -1];
    return rows.slice(hasHeader ? 1 : 0).map((r) => {
      const base = { line: r.line, original: r.raw, from: cell(r.cells, s), to: cell(r.cells, t), status: status(cell(r.cells, code)) };
      if (st >= 0 && ['disabled', 'inactive'].includes(cell(r.cells, st).toLowerCase())) return { ...base, match: 'unsupported', refusal: 'switched off in the export' } satisfies RawRule;
      return { ...base, match: truthy(cell(r.cells, rx).toLowerCase()) || cell(r.cells, rx).toLowerCase() === 'yes' ? 'regex' : 'exact' } satisfies RawRule;
    });
  }
  // Plain CSV: from,to[,type] with an optional header.
  const hasHeader = header[0] === 'from' || header[0] === 'source';
  return rows.slice(hasHeader ? 1 : 0).map((r) => {
    const type = cell(r.cells, 2).toLowerCase();
    const known = type === '' || type === 'exact' || type === '301' || type === 'prefix';
    return {
      line: r.line,
      original: r.raw,
      from: cell(r.cells, 0),
      to: cell(r.cells, 1),
      match: !known ? 'unsupported' : type === 'prefix' ? 'prefix' : 'exact',
      refusal: known ? undefined : `unknown type "${type}"`,
    } satisfies RawRule;
  });
}

/** Read an export file into rules and records for a person. */
export function parseRedirectImport(content: string, hosts: ImportHosts, format?: ImportFormat): ParsedImport | { error: string } {
  const detected = format ?? detectFormat(content);
  const raw = rawRules(content, detected);
  if (!Array.isArray(raw)) return raw;
  const rules: ConvertedRule[] = [];
  const manual: ManualRecord[] = [];
  const seen = new Map<string, number>();
  for (const r of raw) {
    const out = convert(r, hosts);
    if ('reason' in out) {
      manual.push(out);
      continue;
    }
    // The same source twice in one file: the first one counts.
    const key = `${out.match}\u0000${out.from}`;
    const first = seen.get(key);
    if (first !== undefined) {
      manual.push({ line: out.line, original: out.original, reason: `same source as line ${first}` });
      continue;
    }
    seen.set(key, out.line);
    rules.push(out);
  }
  return { format: detected, rules, manual };
}
