import { createHash } from 'node:crypto';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  findCredentialFields,
  IMPORT_BUNDLE_MEDIA_DIR,
  IMPORT_BUNDLE_RECORDS_FILE,
  ImportHeaderSchema,
  ImportRecordSchema,
  type ImportCollection,
  type ImportHeader,
  type ImportItem,
  type ImportLicence,
  type ImportMedia,
  type ImportRecord,
  type ImportRedirect,
  type ImportRevision,
  type ImportSite,
  type ImportTranslationGroup,
} from '@heopress/contracts/schemas';

/**
 * Reading and checking an import bundle (HeoPress P12 tasks 6.1, 6.4; spec migration/import-bundle "导入包内容",
 * "导入安全").
 *
 * Everything here happens before anything is written, and every problem is reported with where it is (line and
 * field, or media path) rather than thrown one at a time:
 *   - each line is one record that the bundle schema accepts; the header comes first, once;
 *   - no key names a secret or credential, no value looks like one (`findCredentialFields`);
 *   - size and count limits: the records file, a line, items, media files, a media file, all media;
 *   - media paths are plain relative paths inside `media/` (no `..`, no absolute path, no backslash, no symbolic
 *     link out), the file is the size and SHA-256 the manifest says, and its first bytes are the declared type;
 *   - external IDs are unique; translation groups, licences and revisions name records that exist.
 */

export interface BundleLimits {
  recordsFileBytes: number;
  lineBytes: number;
  records: number;
  items: number;
  mediaFiles: number;
  mediaFileBytes: number;
  mediaTotalBytes: number;
}

export const DEFAULT_BUNDLE_LIMITS: BundleLimits = {
  recordsFileBytes: 64 * 1024 * 1024,
  lineBytes: 4 * 1024 * 1024,
  records: 200_000,
  items: 50_000,
  mediaFiles: 20_000,
  mediaFileBytes: 50 * 1024 * 1024,
  mediaTotalBytes: 4 * 1024 * 1024 * 1024,
};

export interface BundleProblem {
  /** 1-based line of `bundle.ndjson`, when the problem is on one. */
  line?: number;
  /** Where in the record (or the media path). */
  at?: string;
  code: string;
  message: string;
}

export interface LoadedBundle {
  header: ImportHeader;
  namespace: string;
  site: ImportSite | null;
  collections: ImportCollection[];
  items: ImportItem[];
  groups: ImportTranslationGroup[];
  redirects: ImportRedirect[];
  media: ImportMedia[];
  licences: ImportLicence[];
  revisions: ImportRevision[];
  /** SHA-256 of the records file. */
  hash: string;
  /** Read a listed media file (already checked). */
  readMedia(m: ImportMedia): Promise<Buffer>;
}

export class BundleInvalidError extends Error {
  constructor(readonly problems: BundleProblem[]) {
    super(`The import bundle is not valid: ${problems.length} problem(s), first: ${problems[0]?.message ?? 'unknown'}`);
    this.name = 'BundleInvalidError';
  }
}

/** Whether `p` is a safe relative path: forward slashes, no empty, `.` or `..` segment, nothing absolute. */
export function isSafeRelativePath(p: string): boolean {
  if (!p || p.length > 1000) return false;
  if (p.includes('\\') || p.includes('\0') || p.startsWith('/') || /^[a-zA-Z]:/.test(p)) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/** Whether the first bytes of a file are of `mime`. */
export function sniffMatches(mime: string, head: Buffer): boolean {
  const at = (offset: number, bytes: number[]) => bytes.every((b, i) => head[offset + i] === b);
  const ascii = (offset: number, s: string) => head.subarray(offset, offset + s.length).toString('latin1') === s;
  switch (mime) {
    case 'image/jpeg':
      return at(0, [0xff, 0xd8, 0xff]);
    case 'image/png':
      return at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'image/gif':
      return ascii(0, 'GIF87a') || ascii(0, 'GIF89a');
    case 'image/webp':
      return ascii(0, 'RIFF') && ascii(8, 'WEBP');
    case 'image/avif':
      return ascii(4, 'ftyp') && (ascii(8, 'avif') || ascii(8, 'avis'));
    case 'video/mp4':
      return ascii(4, 'ftyp');
    case 'video/webm':
      return at(0, [0x1a, 0x45, 0xdf, 0xa3]);
    case 'application/pdf':
      return ascii(0, '%PDF-');
    default:
      return false;
  }
}

/** Parse and check the records (no file system): what `loadBundle` does with the text of `bundle.ndjson`. */
export function parseBundleRecords(text: string, limits: BundleLimits = DEFAULT_BUNDLE_LIMITS): { records: Array<{ line: number; record: ImportRecord }>; problems: BundleProblem[] } {
  const problems: BundleProblem[] = [];
  const records: Array<{ line: number; record: ImportRecord }> = [];
  if (Buffer.byteLength(text) > limits.recordsFileBytes) {
    return { records, problems: [{ code: 'BUNDLE_TOO_LARGE', message: `bundle.ndjson is larger than ${limits.recordsFileBytes} bytes.` }] };
  }
  const lines = text.split('\n');
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!.replace(/\r$/, '');
    if (raw.trim() === '') continue;
    const line = i + 1;
    if (++count > limits.records) {
      problems.push({ line, code: 'TOO_MANY_RECORDS', message: `More than ${limits.records} records.` });
      break;
    }
    if (Buffer.byteLength(raw) > limits.lineBytes) {
      problems.push({ line, code: 'LINE_TOO_LARGE', message: `The record is larger than ${limits.lineBytes} bytes.` });
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      problems.push({ line, code: 'INVALID_JSON', message: 'The line is not JSON.' });
      continue;
    }
    // Secrets first: a record carrying one is refused whatever else is wrong with it, and its value is never echoed.
    const secrets = findCredentialFields(value);
    if (secrets.length > 0) {
      for (const at of secrets) problems.push({ line, at, code: 'CREDENTIAL_FIELD', message: `"${at}" looks like a secret or credential; import bundles never carry them.` });
      continue;
    }
    const parsed = ImportRecordSchema.safeParse(value);
    if (!parsed.success) {
      for (const issue of parsed.error.issues.slice(0, 10)) {
        problems.push({ line, at: issue.path.join('.'), code: 'SCHEMA', message: issue.message });
      }
      continue;
    }
    records.push({ line, record: parsed.data });
  }
  const first = records[0];
  if (!first || first.record.type !== 'header' || first.line !== (lines.findIndex((l) => l.trim() !== '') + 1)) {
    if (!problems.some((p) => p.line === 1)) problems.push({ line: 1, code: 'HEADER_MISSING', message: 'The first record must be the header.' });
  }
  if (records.filter((r) => r.record.type === 'header').length > 1) problems.push({ code: 'HEADER_DUPLICATE', message: 'More than one header.' });
  if (records.filter((r) => r.record.type === 'site').length > 1) problems.push({ code: 'SITE_DUPLICATE', message: 'More than one site record.' });
  return { records, problems };
}

/** Cross-record checks: unique IDs, references that resolve, item count. */
function checkReferences(records: Array<{ line: number; record: ImportRecord }>, limits: BundleLimits): BundleProblem[] {
  const problems: BundleProblem[] = [];
  const itemIds = new Map<string, ImportItem>();
  const mediaIds = new Set<string>();
  const mediaPaths = new Set<string>();
  let itemCount = 0;
  let mediaCount = 0;
  for (const { line, record } of records) {
    if (record.type === 'item') {
      if (++itemCount > limits.items) {
        problems.push({ line, code: 'TOO_MANY_ITEMS', message: `More than ${limits.items} items.` });
        break;
      }
      if (itemIds.has(record.externalId)) problems.push({ line, at: 'externalId', code: 'DUPLICATE_ID', message: `Item "${record.externalId}" is listed twice.` });
      itemIds.set(record.externalId, record);
      if (record.internalOnly && !record.translationKey) problems.push({ line, at: 'internalOnly', code: 'INTERNAL_WITHOUT_GROUP', message: 'An internal-only item is a translation source: give it a translation key.' });
    } else if (record.type === 'media') {
      if (++mediaCount > limits.mediaFiles) {
        problems.push({ line, code: 'TOO_MANY_MEDIA', message: `More than ${limits.mediaFiles} media files.` });
        break;
      }
      if (mediaIds.has(record.id)) problems.push({ line, at: 'id', code: 'DUPLICATE_ID', message: `Media "${record.id}" is listed twice.` });
      mediaIds.add(record.id);
      if (!isSafeRelativePath(record.path)) problems.push({ line, at: 'path', code: 'PATH_UNSAFE', message: `Media path "${record.path}" is not a plain relative path inside media/.` });
      else if (mediaPaths.has(record.path)) problems.push({ line, at: 'path', code: 'DUPLICATE_PATH', message: `Media path "${record.path}" is listed twice.` });
      mediaPaths.add(record.path);
      if (record.size > limits.mediaFileBytes) problems.push({ line, at: 'size', code: 'MEDIA_TOO_LARGE', message: `Media "${record.path}" is larger than ${limits.mediaFileBytes} bytes.` });
    }
  }
  for (const { line, record } of records) {
    if (record.type === 'translationGroup') {
      for (const m of record.members) if (!itemIds.has(m)) problems.push({ line, at: 'members', code: 'UNKNOWN_ITEM', message: `Translation group "${record.key}" names unknown item "${m}".` });
      if (record.source && !record.members.includes(record.source)) problems.push({ line, at: 'source', code: 'SOURCE_NOT_MEMBER', message: 'The source must be one of the members.' });
    } else if (record.type === 'licence') {
      const known = record.subject.startsWith('media:') ? mediaIds.has(record.subject.slice(6)) : itemIds.has(record.subject);
      if (!known) problems.push({ line, at: 'subject', code: 'UNKNOWN_SUBJECT', message: `Licence record names unknown "${record.subject}".` });
    } else if (record.type === 'revision') {
      if (!itemIds.has(record.externalId)) problems.push({ line, at: 'externalId', code: 'UNKNOWN_ITEM', message: `Revision names unknown item "${record.externalId}".` });
    }
  }
  return problems;
}

/** Assemble checked records into a bundle (media not read). */
export function assembleBundle(records: Array<{ line: number; record: ImportRecord }>, hash: string, readMedia: LoadedBundle['readMedia']): LoadedBundle {
  const of = <T extends ImportRecord['type']>(type: T) => records.map((r) => r.record).filter((r): r is Extract<ImportRecord, { type: T }> => r.type === type);
  const header = ImportHeaderSchema.parse(of('header')[0]);
  return {
    header,
    namespace: `${header.source}:${header.sourceSite}`,
    site: of('site')[0] ?? null,
    collections: of('collection'),
    items: of('item'),
    groups: of('translationGroup'),
    redirects: of('redirect'),
    media: of('media'),
    licences: of('licence'),
    revisions: of('revision'),
    hash,
    readMedia,
  };
}

/** Read the first `n` bytes of a file. */
async function head(file: string, n: number): Promise<Buffer> {
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/**
 * Load a bundle directory and check everything, media included. Throws `BundleInvalidError` with every problem
 * found; otherwise the bundle is safe to plan with.
 */
export async function loadBundle(dir: string, limits: BundleLimits = DEFAULT_BUNDLE_LIMITS): Promise<LoadedBundle> {
  const root = await realpath(dir);
  const recordsPath = path.join(root, IMPORT_BUNDLE_RECORDS_FILE);
  const st = await lstat(recordsPath).catch(() => null);
  if (!st || !st.isFile()) throw new BundleInvalidError([{ code: 'RECORDS_MISSING', message: `${IMPORT_BUNDLE_RECORDS_FILE} is missing (or not a regular file).` }]);
  if (st.size > limits.recordsFileBytes) throw new BundleInvalidError([{ code: 'BUNDLE_TOO_LARGE', message: `${IMPORT_BUNDLE_RECORDS_FILE} is larger than ${limits.recordsFileBytes} bytes.` }]);
  const bytes = await readFile(recordsPath);
  const { records, problems } = parseBundleRecords(bytes.toString('utf8'), limits);
  problems.push(...checkReferences(records, limits));
  const mediaRoot = path.join(root, IMPORT_BUNDLE_MEDIA_DIR);
  const resolveMedia = async (rel: string): Promise<string | null> => {
    const full = path.join(mediaRoot, ...rel.split('/'));
    const real = await realpath(full).catch(() => null);
    if (!real || !real.startsWith(mediaRoot + path.sep)) return null;
    return real;
  };
  let total = 0;
  for (const { line, record } of records) {
    if (record.type !== 'media' || !isSafeRelativePath(record.path)) continue;
    const file = await resolveMedia(record.path);
    const fst = file ? await lstat(file).catch(() => null) : null;
    if (!file || !fst || !fst.isFile()) {
      problems.push({ line, at: record.path, code: 'MEDIA_MISSING', message: `Media "${record.path}" is not a file inside media/.` });
      continue;
    }
    total += fst.size;
    if (fst.size !== record.size) problems.push({ line, at: record.path, code: 'MEDIA_SIZE', message: `Media "${record.path}" is ${fst.size} bytes, not ${record.size}.` });
    if (fst.size > limits.mediaFileBytes) {
      problems.push({ line, at: record.path, code: 'MEDIA_TOO_LARGE', message: `Media "${record.path}" is larger than ${limits.mediaFileBytes} bytes.` });
      continue;
    }
    if (!sniffMatches(record.mimeType, await head(file, 16))) problems.push({ line, at: record.path, code: 'MEDIA_TYPE', message: `Media "${record.path}" is not ${record.mimeType}.` });
    const sha = createHash('sha256').update(await readFile(file)).digest('hex');
    if (sha !== record.sha256) problems.push({ line, at: record.path, code: 'MEDIA_HASH', message: `Media "${record.path}" does not match its SHA-256.` });
  }
  if (total > limits.mediaTotalBytes) problems.push({ code: 'MEDIA_TOTAL_TOO_LARGE', message: `Media files add up to more than ${limits.mediaTotalBytes} bytes.` });
  if (problems.length > 0) throw new BundleInvalidError(problems);
  return assembleBundle(records, createHash('sha256').update(bytes).digest('hex'), async (m) => {
    const file = await resolveMedia(m.path);
    if (!file) throw new BundleInvalidError([{ at: m.path, code: 'MEDIA_MISSING', message: `Media "${m.path}" is not a file inside media/.` }]);
    return readFile(file);
  });
}
