import { createHash } from 'node:crypto';
import { and, asc, eq, gt, isNull, lt, or } from 'drizzle-orm';
import sharp from 'sharp';
import { IngestMediaLicenceSchema } from '@heopress/contracts/schemas';
import { ingestDocumentMedia, ingestMedia, ingestMediaLicences, type Database } from '@heopress/database';
import type { StorageProvider } from '@heopress/runtime';
import { runSiteTransaction, type SiteTransaction } from '../rls-transaction';
import { classifyFetchFailure } from './failure';
import { fetchPage, type FetchPageOptions } from './fetcher';
import type { HostLimiter } from './host-limiter';
import { IngestSourceError } from './source-service';
import { DEFAULT_TRACKING_PARAMS, normalizeUrl } from './url-normalize';

/**
 * Source media (HeoPress P08 task 2.9; spec ingest/crawling "来源媒体处理").
 *
 * The licence of a media item is its own (`ingest_media_licences`: evidence, attribution, allowed uses, validity),
 * never inferred from the article's. By default nothing is copied and nothing is hot-linked: the document records which
 * images it references (`ingest_document_media`, written in the document's registration transaction) and each stays
 * `pending` → `unlicensed` (the original URL kept for a person to handle; the processing pipeline renders a placeholder,
 * never the remote URL) unless a licence that allows `copy` exists for it. Then, step by step:
 *
 *   1. licence check (current, allows `copy`);
 *   2. download through the native fetcher — the SSRF boundary, robots.txt, per-host limits — with its own caps on
 *      bytes and time;
 *   3. format from the bytes (magic numbers: PNG, JPEG, GIF, WebP), never from the URL or the content type;
 *   4. pixel cap on the decoded size from the image header (width × height × frames) — an image whose markup says
 *      100×100 but whose header says 20000×20000 stops here;
 *   5. SHA-256 of the bytes; the object is content-addressed (`ingest/media/<site>/<sha256>.<ext>`, outside every public
 *      media prefix), written before its row; the row is unique per site and digest, so the same image from two
 *      documents, two workers at once or a retry is one media row;
 *   6. the reference row points at it (`stored`).
 *
 * Each image is processed on its own: a failure is recorded on its reference (`failed` with the reason; technical
 * failures are retried by a later pass, at most `MAX_ATTEMPTS` times) and never touches the document or the others.
 */

export interface MediaLimits {
  maxBytes: number;
  maxPixels: number;
  timeoutMs: number;
  maxPerDocument: number;
}

const DEFAULT_LIMITS: MediaLimits = { maxBytes: 10 * 1024 * 1024, maxPixels: 40_000_000, timeoutMs: 20_000, maxPerDocument: 30 };
const MAX_ATTEMPTS = 3;
/** Retried failures wait at least this long. */
const RETRY_AFTER_MS = 5 * 60_000;

export interface MediaDeps {
  db: Database;
  storage: StorageProvider;
  limiter?: HostLimiter | null;
  fetch?: Omit<FetchPageOptions, 'signal' | 'limiter'>;
  limits?: Partial<MediaLimits>;
  trackingParams?: readonly string[];
  now?: () => Date;
}

/** The absolute http(s) image URLs of sanitised article HTML, in order, without repeats. */
function imageUrlsOf(bodyHtml: string): string[] {
  const out = new Set<string>();
  for (const m of bodyHtml.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/gi)) {
    const src = m[1]!.replace(/&amp;/g, '&');
    if (/^https?:\/\//i.test(src)) out.add(src);
  }
  return [...out];
}

/** Record a document's media references (inside its registration transaction). */
export async function registerDocumentMedia(
  tx: SiteTransaction,
  input: { siteId: string; documentId: string; bodyHtml: string; trackingParams?: readonly string[]; now: Date; maxPerDocument?: number },
): Promise<number> {
  const urls = imageUrlsOf(input.bodyHtml).slice(0, input.maxPerDocument ?? DEFAULT_LIMITS.maxPerDocument);
  let n = 0;
  for (const [position, url] of urls.entries()) {
    const normalizedUrl = normalizeUrl(url, input.trackingParams ?? DEFAULT_TRACKING_PARAMS);
    if (!normalizedUrl) continue;
    const rows = await tx
      .insert(ingestDocumentMedia)
      .values({ siteId: input.siteId, documentId: input.documentId, position, url: url.slice(0, 2000), normalizedUrl, updatedAt: input.now })
      .onConflictDoNothing()
      .returning({ id: ingestDocumentMedia.id });
    n += rows.length;
  }
  return n;
}

type MediaFormat = 'png' | 'jpeg' | 'gif' | 'webp';

/** The format of an image from its first bytes, or null. */
function sniffImageFormat(b: Buffer): MediaFormat | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 6 && (b.subarray(0, 6).toString('latin1') === 'GIF87a' || b.subarray(0, 6).toString('latin1') === 'GIF89a')) return 'gif';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

class MediaRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** Retrying cannot change the outcome. */
    readonly final: boolean,
  ) {
    super(message);
  }
}

/** Download and check one image: its bytes, format and size. Throws `MediaRefusal` or a fetch error. */
async function downloadImage(deps: MediaDeps, url: string, limits: MediaLimits): Promise<{ body: Buffer; format: MediaFormat; width: number; height: number }> {
  const page = await fetchPage(url, { ...deps.fetch, limiter: deps.limiter ?? null, accept: /(?:)/, maxBytes: limits.maxBytes, timeoutMs: limits.timeoutMs });
  const format = sniffImageFormat(page.body);
  if (!format) throw new MediaRefusal('unsupported_format', 'the bytes are not a PNG, JPEG, GIF or WebP image (whatever the URL or content type say)', true);
  let meta: Awaited<ReturnType<ReturnType<typeof sharp>['metadata']>>;
  try {
    meta = await sharp(page.body, { limitInputPixels: false, pages: 1 }).metadata();
  } catch {
    throw new MediaRefusal('undecodable', 'the image header could not be read', true);
  }
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  const frames = Math.max(1, meta.pages ?? 1);
  if (!width || !height) throw new MediaRefusal('undecodable', 'the image has no dimensions', true);
  if (width * height * frames > limits.maxPixels) {
    throw new MediaRefusal('too_many_pixels', `${width}×${height}${frames > 1 ? `×${frames} frames` : ''} decodes to more than ${limits.maxPixels} pixels`, true);
  }
  return { body: page.body, format, width, height };
}

export type MediaOutcome = 'stored' | 'unlicensed' | 'failed';

/** Process one reference. Never throws for the image's own problems: they are recorded on the reference. */
async function processReference(deps: MediaDeps, siteId: string, ref: typeof ingestDocumentMedia.$inferSelect, limits: MediaLimits): Promise<MediaOutcome> {
  const now = deps.now?.() ?? new Date();
  const where = and(eq(ingestDocumentMedia.siteId, siteId), eq(ingestDocumentMedia.id, ref.id));
  const setRef = (values: Partial<typeof ingestDocumentMedia.$inferInsert>) =>
    runSiteTransaction(deps.db, siteId, (tx) => tx.update(ingestDocumentMedia).set({ ...values, updatedAt: deps.now?.() ?? new Date() }).where(where));

  // 1. The media item's own licence.
  const [licence] = await runSiteTransaction(deps.db, siteId, (tx) =>
    tx
      .select()
      .from(ingestMediaLicences)
      .where(and(eq(ingestMediaLicences.siteId, siteId), eq(ingestMediaLicences.url, ref.normalizedUrl), or(isNull(ingestMediaLicences.validUntil), gt(ingestMediaLicences.validUntil, now)))),
  );
  if (!licence || !licence.allowedUses.includes('copy')) {
    await setRef({ status: 'unlicensed', reason: 'no licence evidence that allows copying this media item' });
    return 'unlicensed';
  }

  // 2–4. Download and check.
  let image: Awaited<ReturnType<typeof downloadImage>>;
  try {
    image = await downloadImage(deps, ref.url, limits);
  } catch (err) {
    const attempts = ref.attempts + 1;
    if (err instanceof MediaRefusal) {
      await setRef({ status: 'failed', reason: `${err.code}: ${err.message}`, attempts: err.final ? MAX_ATTEMPTS : attempts });
    } else {
      const { category } = classifyFetchFailure(err);
      const final = category === 'blocked' || category === 'access_denied';
      await setRef({ status: 'failed', reason: `${category}: ${(err instanceof Error ? err.message : String(err)).slice(0, 400)}`, attempts: final ? MAX_ATTEMPTS : attempts });
    }
    return 'failed';
  }

  // 5. Content-addressed object first (idempotent), then the row (unique per site and digest) and the reference.
  const sha256 = createHash('sha256').update(image.body).digest('hex');
  const storageKey = `ingest/media/${siteId}/${sha256}.${image.format === 'jpeg' ? 'jpg' : image.format}`;
  try {
    await deps.storage.put(storageKey, image.body, { contentType: `image/${image.format}` });
  } catch (err) {
    await setRef({ status: 'failed', reason: `storage: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500), attempts: ref.attempts + 1 });
    return 'failed';
  }
  await runSiteTransaction(deps.db, siteId, async (tx) => {
    await tx
      .insert(ingestMedia)
      .values({ siteId, sha256, storageKey, format: image.format, byteSize: image.body.byteLength, width: image.width, height: image.height, licenceId: licence.id, createdAt: now })
      .onConflictDoNothing();
    const [media] = await tx.select({ id: ingestMedia.id }).from(ingestMedia).where(and(eq(ingestMedia.siteId, siteId), eq(ingestMedia.sha256, sha256)));
    await tx.update(ingestDocumentMedia).set({ status: 'stored', reason: null, mediaId: media!.id, attempts: ref.attempts + 1, updatedAt: now }).where(where);
  });
  return 'stored';
}

/**
 * Process the media references of one document (or, without `documentId`, the site's due ones: pending, and failed
 * ones under the attempt cap whose last try is older than the retry delay). Returns the outcome per reference id.
 */
export async function processDocumentMedia(deps: MediaDeps, siteId: string, documentId?: string, limit = 50): Promise<Map<string, MediaOutcome>> {
  const limits = { ...DEFAULT_LIMITS, ...deps.limits };
  const now = deps.now?.() ?? new Date();
  const due = await runSiteTransaction(deps.db, siteId, (tx) =>
    tx
      .select()
      .from(ingestDocumentMedia)
      .where(
        and(
          eq(ingestDocumentMedia.siteId, siteId),
          ...(documentId ? [eq(ingestDocumentMedia.documentId, documentId)] : []),
          or(
            eq(ingestDocumentMedia.status, 'pending'),
            and(eq(ingestDocumentMedia.status, 'failed'), lt(ingestDocumentMedia.attempts, MAX_ATTEMPTS), documentId ? undefined : lt(ingestDocumentMedia.updatedAt, new Date(now.getTime() - RETRY_AFTER_MS))),
          ),
        ),
      )
      .orderBy(asc(ingestDocumentMedia.documentId), asc(ingestDocumentMedia.position))
      .limit(limit),
  );
  const out = new Map<string, MediaOutcome>();
  for (const ref of due) {
    try {
      out.set(ref.id, await processReference(deps, siteId, ref, limits));
    } catch {
      // A database hiccup on one reference: it stays as it was for the next pass; the others go on.
      out.set(ref.id, 'failed');
    }
  }
  return out;
}

/** Record (or replace) a media item's licence. Administrators only (checked by the route). */
export async function setMediaLicence(db: Database, siteId: string, userId: string | null, body: unknown, trackingParams: readonly string[] = DEFAULT_TRACKING_PARAMS): Promise<{ id: string; url: string }> {
  const parsed = IngestMediaLicenceSchema.safeParse(body);
  if (!parsed.success) throw new IngestSourceError('VALIDATION', 'Invalid media licence.', 400, parsed.error.issues);
  const v = parsed.data;
  const url = normalizeUrl(v.url, trackingParams);
  if (!url) throw new IngestSourceError('VALIDATION', 'Use an http(s) URL.', 400);
  const values = { evidence: v.evidence, attribution: v.attribution ?? null, allowedUses: v.allowedUses, validUntil: v.validUntil ? new Date(v.validUntil) : null, setBy: userId };
  return runSiteTransaction(db, siteId, async (tx) => {
    const [row] = await tx
      .insert(ingestMediaLicences)
      .values({ siteId, url, ...values })
      .onConflictDoUpdate({ target: [ingestMediaLicences.siteId, ingestMediaLicences.url], set: values })
      .returning({ id: ingestMediaLicences.id, url: ingestMediaLicences.url });
    // A reference left `unlicensed` before the licence existed is looked at again.
    await tx
      .update(ingestDocumentMedia)
      .set({ status: 'pending', reason: null })
      .where(and(eq(ingestDocumentMedia.siteId, siteId), eq(ingestDocumentMedia.normalizedUrl, url), eq(ingestDocumentMedia.status, 'unlicensed')));
    return row!;
  });
}
