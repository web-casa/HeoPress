import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';

/**
 * A site's static directory mount (v1.5, spec `rendering/static-directory-mount`).
 *
 * The Classic engine serves a mounted directory's files for paths no HeoPress route matches (entries, plugin routes and
 * system files win, always); the CMS validates the directory against the operator's `HEOPRESS_STATIC_ROOT` when it is
 * saved; the Astro build copies the directory into its artifact. This module is the one implementation of the rules the
 * three callers share:
 *
 *   - **request paths**: split before decoding, decoded twice (`%252e%252e` is `..`), and refused for `.`/`..`, NUL,
 *     control characters, backslashes, encoded slashes and over-long paths or segments;
 *   - **containment**: every component is `lstat`ed and must not be a symbolic link (recursion into symlinks is not
 *     followed), and the resolved file must still be under the directory;
 *   - **files only**: a directory answers through its `index.html`, with a 301 to the trailing-slash address when the
 *     request had none.
 *
 * Nothing here executes or interprets a file: bytes are read by the caller and sent as they are.
 */

/** Longest request path served (bytes of the path, before decoding). */
export const MAX_STATIC_PATH = 2048;
/** Most segments in a path. */
export const MAX_STATIC_SEGMENTS = 64;
/** Longest single segment, in bytes after decoding (the common file-system limit). */
export const MAX_STATIC_SEGMENT = 255;

export interface StaticPathIssue {
  reason: 'not_absolute' | 'too_long' | 'too_many_segments' | 'empty_segment' | 'bad_encoding' | 'traversal' | 'backslash' | 'nul' | 'control' | 'segment_too_long' | 'hidden';
}

export type StaticPathParse = { ok: true; segments: string[]; trailingSlash: boolean } | ({ ok: false } & StaticPathIssue);

/** Whether a decoded segment could name a file at all. */
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * The decoded segments of a request path, or why it cannot name a file under the mount.
 *
 * Splitting happens **before** decoding: an encoded slash (`%2f`) therefore never becomes a separator — it is refused
 * with the rest of the unsafe forms. Each segment is decoded twice, so a double-encoded traversal (`%252e%252e`) is
 * caught before anything touches the file system.
 */
export function parseStaticRequestPath(requestPath: string): StaticPathParse {
  if (!requestPath.startsWith('/')) return { ok: false, reason: 'not_absolute' };
  if (requestPath === '/') return { ok: true, segments: [], trailingSlash: true };
  if (Buffer.byteLength(requestPath) > MAX_STATIC_PATH) return { ok: false, reason: 'too_long' };
  const trailingSlash = requestPath.length > 1 && requestPath.endsWith('/');
  const raw = requestPath.split('/').slice(1);
  if (trailingSlash) raw.pop();
  if (raw.length > MAX_STATIC_SEGMENTS) return { ok: false, reason: 'too_many_segments' };
  const segments: string[] = [];
  for (const part of raw) {
    if (part === '') return { ok: false, reason: 'empty_segment' };
    let once: string;
    try {
      once = decodeURIComponent(part);
    } catch {
      return { ok: false, reason: 'bad_encoding' };
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(once);
    } catch {
      return { ok: false, reason: 'bad_encoding' };
    }
    if (decoded === '' || decoded === '.' || decoded === '..') return { ok: false, reason: 'traversal' };
    if (decoded.includes('/')) return { ok: false, reason: 'traversal' };
    if (decoded.includes('\\')) return { ok: false, reason: 'backslash' };
    if (decoded.includes('\u0000')) return { ok: false, reason: 'nul' };
    if (CONTROL.test(decoded)) return { ok: false, reason: 'control' };
    if (Buffer.byteLength(decoded) > MAX_STATIC_SEGMENT) return { ok: false, reason: 'segment_too_long' };
    // A hidden entry is not served (nor copied by the Astro build): an archive's `.git`, `.env` or editor files must never
    // become public because a directory was mounted. `.well-known` is a system path and never reaches the mount.
    if (decoded.startsWith('.')) return { ok: false, reason: 'hidden' };
    segments.push(decoded);
  }
  return { ok: true, segments, trailingSlash };
}

export type StaticFileResult =
  | { kind: 'file'; file: string; size: number; mtimeMs: number }
  /** A directory asked for without its trailing slash: 301 there, so the page's relative URLs resolve. */
  | { kind: 'redirect'; location: string }
  | { kind: 'missing'; reason: string };

/** Whether `candidate` is `root` itself or lies under it (both already resolved absolute paths). */
export function isInsideDirectory(root: string, candidate: string): boolean {
  const base = root.endsWith(sep) ? root : `${root}${sep}`;
  return candidate === root || candidate.startsWith(base);
}

/** A file's metadata, read without following a symbolic link. */
async function regularFile(file: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const st = await lstat(file);
    if (st.isSymbolicLink() || !st.isFile()) return null;
    return { size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

/**
 * The file a request path names under `mountReal` (a resolved absolute directory), or why there is none.
 *
 * Every component is `lstat`ed before it is used: a symbolic link anywhere in the path is refused (recursion into
 * symbolic links is not followed), and the file's resolved path is checked once more against the directory. A missing
 * file, an unreadable directory and an escape attempt all come back as `missing`: the caller answers the site's 404 and
 * never says which of them it was.
 */
export async function resolveStaticFile(mountReal: string, requestPath: string): Promise<StaticFileResult> {
  const parsed = parseStaticRequestPath(requestPath);
  if (!parsed.ok) return { kind: 'missing', reason: parsed.reason };
  // The declared-URL list is the mount's metadata, not a public file.
  if (parsed.segments.length === 1 && parsed.segments[0] === 'static-urls.txt') return { kind: 'missing', reason: 'metadata' };
  let current = mountReal;
  for (let i = 0; i < parsed.segments.length; i++) {
    current = join(current, parsed.segments[i]!);
    let st;
    try {
      st = await lstat(current);
    } catch {
      return { kind: 'missing', reason: 'absent' };
    }
    if (st.isSymbolicLink()) return { kind: 'missing', reason: 'symlink' };
    const last = i === parsed.segments.length - 1;
    if (!last) {
      if (!st.isDirectory()) return { kind: 'missing', reason: 'not_a_directory' };
      continue;
    }
    if (st.isDirectory()) {
      // The directory's index; a request without the trailing slash is redirected there first.
      const index = join(current, 'index.html');
      const info = await regularFile(index);
      if (!info) return { kind: 'missing', reason: 'no_index' };
      if (!(await contained(mountReal, index))) return { kind: 'missing', reason: 'escape' };
      if (!parsed.trailingSlash) return { kind: 'redirect', location: `${requestPath}/` };
      return { kind: 'file', file: index, ...info };
    }
    if (!st.isFile()) return { kind: 'missing', reason: 'not_a_file' };
    if (parsed.trailingSlash) return { kind: 'missing', reason: 'file_as_directory' };
    if (!(await contained(mountReal, current))) return { kind: 'missing', reason: 'escape' };
    return { kind: 'file', file: current, size: st.size, mtimeMs: st.mtimeMs };
  }
  // The mount's own root: its index.
  if (parsed.segments.length === 0) {
    const index = join(mountReal, 'index.html');
    const info = await regularFile(index);
    if (!info) return { kind: 'missing', reason: 'no_index' };
    if (!(await contained(mountReal, index))) return { kind: 'missing', reason: 'escape' };
    return { kind: 'file', file: index, ...info };
  }
  return { kind: 'missing', reason: 'absent' };
}

/**
 * The directory a stored mount names, resolved and checked against the operator's root; null when it cannot be served
 * (no root configured, the directory is gone, or a symbolic link moved it outside the root after it was saved).
 */
export async function resolveMountDirectory(root: string | null | undefined, directory: string | null | undefined): Promise<string | null> {
  if (!root?.trim() || !directory) return null;
  try {
    const rootReal = await realpath(root.trim());
    const real = await realpath(directory);
    if (!isInsideDirectory(rootReal, real)) return null;
    return (await stat(real)).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

/**
 * A mount's `static-urls.txt` (the sitemap's declared URLs), with a stamp of its identity: the file is read only when it
 * is a regular file (a symbolic link is not followed), and the stamp lets the sitemap memory notice an edit without a
 * publication.
 */
export async function readStaticMountUrls(directory: string): Promise<{ text: string; stamp: string } | null> {
  const file = join(directory, 'static-urls.txt');
  try {
    const st = await lstat(file);
    if (st.isSymbolicLink() || !st.isFile()) return null;
    return { text: await readFile(file, 'utf8'), stamp: `${Math.floor(st.mtimeMs)}-${st.size}` };
  } catch {
    return null;
  }
}

/** The file's resolved path is still under the directory (belt and braces after the component checks). */
async function contained(mountReal: string, file: string): Promise<boolean> {
  try {
    return isInsideDirectory(mountReal, await realpath(file));
  } catch {
    return false;
  }
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  xhtml: 'application/xhtml+xml; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject',
  wasm: 'application/wasm',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
  wav: 'audio/wav',
};

/** The extension a file name ends with, lowercased (`''` when none). */
export function staticExtension(filename: string): string {
  const base = filename.slice(filename.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** The type a file is served as: by extension only, never sniffed; unknown names are opaque bytes. */
export function staticContentType(filename: string): string {
  return CONTENT_TYPES[staticExtension(filename)] ?? 'application/octet-stream';
}

/** Files whose bytes a browser may cache for a year: the ones a page loads rather than navigates to. */
const IMMUTABLE = new Set([
  'css', 'js', 'mjs', 'map', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'wasm',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'bmp', 'svg',
  'mp4', 'webm', 'mp3', 'ogg', 'wav',
]);

/**
 * The caching policy of a mounted file, by kind: an HTML document is revalidated every time (it is a page of the site and
 * may change as the operator edits the directory); a resource a page loads is long-lived and immutable; anything else
 * (text, XML, JSON, archives) is short-lived.
 */
export function staticCacheControl(filename: string): string {
  const ext = staticExtension(filename);
  if (ext === 'html' || ext === 'htm' || ext === 'xhtml') return 'public, max-age=0, must-revalidate';
  if (IMMUTABLE.has(ext)) return 'public, max-age=31536000, immutable';
  return 'public, max-age=300';
}

/** The representation validators of a file: a weak `ETag` from its modification time and size, its `Last-Modified`. */
export function staticValidators(info: { size: number; mtimeMs: number }): { etag: string; lastModified: string } {
  return {
    etag: `W/"${Math.floor(info.mtimeMs).toString(16)}-${info.size.toString(16)}"`,
    lastModified: new Date(Math.floor(info.mtimeMs / 1000) * 1000).toUTCString(),
  };
}

/** Whether the request already has this representation (`If-None-Match` first, then `If-Modified-Since`). */
export function staticNotModified(headers: { ifNoneMatch?: string | null; ifModifiedSince?: string | null }, info: { size: number; mtimeMs: number }): boolean {
  const { etag } = staticValidators(info);
  if (headers.ifNoneMatch !== undefined && headers.ifNoneMatch !== null) {
    if (headers.ifNoneMatch.trim() === '*') return true;
    // A weak comparison: W/"x" matches "x" and any etag in a list.
    const bare = etag.replace(/^W\//, '');
    return headers.ifNoneMatch
      .split(',')
      .map((t) => t.trim().replace(/^W\//, ''))
      .some((t) => t === bare);
  }
  if (headers.ifModifiedSince) {
    const since = Date.parse(headers.ifModifiedSince);
    return Number.isFinite(since) && Math.floor(info.mtimeMs / 1000) * 1000 <= since;
  }
  return false;
}

/**
 * The top-level segments the mount never answers, whatever it contains: the engine's administration paths, the theme and
 * plugin asset prefixes, the platform's own health and metrics endpoints (the edge routes them to the CMS) and the
 * studio's private paths.
 */
const RESERVED_SEGMENTS = new Set(['admin', 'api', 'internal', '_theme', '_ext', '_astro', 'health', 'healthz', 'metrics', 'studio', 'setup', 'scim']);

/**
 * The system files the mount never answers, by their first segment: the discovery files and `.well-known`. Named
 * explicitly rather than through `isSystemPathSegment` because the system's root-file rule covers *every* one-segment
 * `.html`/`.txt`/… name — and an archive's `/about.html` is exactly what this feature is for. The engine lets such a
 * path fall through when the site has no root file of that name, so a real root file still wins (`app.ts`).
 */
const SYSTEM_SEGMENTS: readonly RegExp[] = [
  /^robots\.txt$/,
  /^sitemap(-\d{1,6})?\.xml$/,
  /^sitemap\.txt$/,
  /^news-sitemap(-\d{1,6})?\.xml$/,
  /^(feed|rss|atom)([-_.][a-z0-9-]+)*$/,
  /^llms(-full)?\.txt$/,
  /^\.?well-known$/,
];

/** Why a first path segment is not the mount's to answer (`null`: it may be). */
export function mountReservedReason(firstSegment: string): string | null {
  const s = firstSegment.toLowerCase();
  if (RESERVED_SEGMENTS.has(s)) return 'reserved';
  if (SYSTEM_SEGMENTS.some((re) => re.test(s))) return 'system';
  return null;
}

export interface StaticUrlIssue {
  /** 1-based line number, for the operator's log. */
  line: number;
  reason: string;
}

/**
 * The `static-urls.txt` of a mount: one absolute path per line, blank lines and `#` comments ignored. A line is used only
 * when it is a safe path this engine could serve — an invalid one is reported (line and reason, never the line's own
 * bytes) and skipped so the sitemap is still made.
 */
export function parseStaticUrls(text: string): { paths: string[]; invalid: StaticUrlIssue[] } {
  const paths: string[] = [];
  const invalid: StaticUrlIssue[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line === '' || line.startsWith('#')) continue;
    const parsed = parseStaticRequestPath(line);
    if (!parsed.ok) {
      invalid.push({ line: i + 1, reason: parsed.reason });
      continue;
    }
    if (line.includes('?') || line.includes('#')) {
      invalid.push({ line: i + 1, reason: 'query_or_fragment' });
      continue;
    }
    if (line.startsWith('//')) {
      invalid.push({ line: i + 1, reason: 'not_absolute' });
      continue;
    }
    paths.push(parsed.trailingSlash || parsed.segments.length === 0 ? line : line.replace(/\/+$/, ''));
  }
  return { paths, invalid };
}

/** The declared URLs of a mount, made absolute on one host, de-duplicated in order (invalid lines reported). */
export function staticUrlsOn(host: string, text: string): { urls: string[]; invalid: StaticUrlIssue[] } {
  const { paths, invalid } = parseStaticUrls(text);
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const path of paths) {
    const url = `https://${host}${path}`;
    if (seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return { urls, invalid };
}
