// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { Hono } from 'hono';
import { z } from 'zod';
import type { Context } from 'hono';
import type { AppEnv } from '../env';
import { type PermissionAction } from '../services/permission-service';
import { permissionServiceForRequest } from '../services/item-service-factory';
import { formatSafeError } from '@heopress/contracts/utils';
import { scopeSite, settings, transformPresets } from '@heopress/database';
import { and, eq } from 'drizzle-orm';
import { type TransformDsl, transformDslSchema, transformKey, verifyTransform } from '@heopress/contracts';
import { etagMatches, weakEtag } from '../services/delivery-cache';
import type { MediaLocation } from '../services/storage/storage-profile-service';
import { storageProfileServiceFor } from './storage-profiles';

type ResolvedTransform = { dsl: TransformDsl; fromPreset: boolean };

/**
 * Resolve the transform for a delivery request from `?preset=<key>` (looked up
 * in `transform_presets`) or inline `?width=&height=&format=&quality=&fit=`
 * params. Returns null when no transform was requested (serve the original),
 * or throws a ZodError when inline params fail validation. `fromPreset`
 * distinguishes preset vs custom for the `presetOnly` guard.
 */
async function resolveTransform(c: Context<AppEnv>): Promise<ResolvedTransform | null> {
  const url = new URL(c.req.url);
  const presetKey = url.searchParams.get('preset');
  if (presetKey) {
    const [row] = await c
      .get('db')
      .select()
      .from(transformPresets)
      .where(and(eq(transformPresets.key, presetKey), scopeSite(transformPresets.siteId, c.get('siteId'))))
      .limit(1);
    if (!row) return null;
    return { dsl: transformDslSchema.parse(row.dsl), fromPreset: true };
  }
  const raw: Record<string, unknown> = {};
  const num = (v: string | null) => (v == null ? undefined : Number(v));
  if (url.searchParams.get('width')) raw.width = num(url.searchParams.get('width'));
  if (url.searchParams.get('height')) raw.height = num(url.searchParams.get('height'));
  if (url.searchParams.get('format')) raw.format = url.searchParams.get('format');
  if (url.searchParams.get('quality')) raw.quality = num(url.searchParams.get('quality'));
  if (url.searchParams.get('fit')) raw.fit = url.searchParams.get('fit');
  if (Object.keys(raw).length === 0) return null;
  return { dsl: transformDslSchema.parse(raw), fromPreset: false };
}

interface SignedTransformPolicy {
  enabled: boolean;
  presetOnly: boolean;
  secret: string | null;
}

/**
 * Load the site's signed-transform policy from settings key `media.signedTransform`.
 * Absent → disabled (all transforms allowed; backward compatible).
 */
async function loadSignedTransformPolicy(c: Context<AppEnv>): Promise<SignedTransformPolicy> {
  const [row] = await c
    .get('db')
    .select()
    .from(settings)
    .where(and(eq(settings.key, 'media.signedTransform'), scopeSite(settings.siteId, c.get('siteId'))))
    .limit(1);
  const value = (row?.value ?? {}) as { enabled?: boolean; presetOnly?: boolean; secret?: string };
  return {
    enabled: value.enabled === true,
    presetOnly: value.presetOnly === true,
    secret: typeof value.secret === 'string' && value.secret.length > 0 ? value.secret : null,
  };
}

/**
 * /media — asset storage endpoints powered by the StorageProvider.
 *
 * Provides upload, download, delete, and list operations for media assets.
 * Uses `c.get('runtime').storage` (StorageProvider interface) which is backed
 * by R2 on Cloudflare or S3/MinIO in Docker mode.
 */

const listQuerySchema = z.object({
  prefix: z.string().optional(),
});

export const mediaRouter = new Hono<AppEnv>();

/** Storage key of a cached derivative: `derived/<source key>/<hash of version + transform>`. */
function derivedStorageKey(sourceKey: string, digest: string): string {
  return `derived/${sourceKey}/${digest}`;
}

function isInvalidKey(key: string): boolean {
  return key.includes('..') || key.startsWith('/');
}

function tenantPrefix(siteId: string): string {
  return `sites/${siteId}/media/`;
}

function storageKey(siteId: string, key: string): string {
  return `${tenantPrefix(siteId)}${key}`;
}

function publicKey(siteId: string, key: string): string {
  const prefix = tenantPrefix(siteId);
  return key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

/**
 * Where `key` of the request's site is (`read`) or goes (`write`): its own
 * storage profile (HeoPress P04 tasks 6.1–6.2) or the instance default.
 * Null when the profile cannot be reached — answered as 503 by the caller.
 */
async function locate(c: Context<AppEnv>, key: string, mode: 'read' | 'write'): Promise<MediaLocation | null> {
  try {
    const svc = storageProfileServiceFor(c);
    return mode === 'read' ? await svc.readLocation(key) : await svc.writeLocation(key);
  } catch (err) {
    console.error('[media] storage profile unavailable', formatSafeError(err));
    return null;
  }
}

/**
 * Rich-text uploads (keys under `editor/`, ADR-0020) go to object storage only — an S3-compatible profile (S3, R2,
 * OSS) with a public base URL — so the address put into an article is one readers can load (maintainer decision
 * 2026-10-25). Local storage and the instance default have no public address for published content.
 */
export const EDITOR_MEDIA_PREFIX = 'editor/';
export function editorUploadRefusal(at: Pick<MediaLocation, 'driver' | 'publicBaseUrl'>): 'OBJECT_STORAGE_REQUIRED' | 'PUBLIC_URL_REQUIRED' | null {
  if (at.driver !== 's3') return 'OBJECT_STORAGE_REQUIRED';
  if (!at.publicBaseUrl) return 'PUBLIC_URL_REQUIRED';
  return null;
}
const EDITOR_REFUSAL_MESSAGE = {
  OBJECT_STORAGE_REQUIRED: 'Uploads into articles need object storage (S3, R2 or OSS) bound to this site.',
  PUBLIC_URL_REQUIRED: 'The bound object storage needs a public base URL for uploads into articles.',
} as const;

const storageUnavailable = (c: Context<AppEnv>) =>
  c.json({ errors: [{ code: 'SERVICE_UNAVAILABLE', message: 'Storage service is not available.' }] }, 503);

/**
 * Storage metadata field holding the content fingerprint written at upload
 * time. Objects uploaded before this field existed (and every object written
 * through the streaming `PUT /files/upload/:key` receiver, which never buffers
 * the body) simply have no version — they degrade to the revalidating policy
 * below, never to `immutable`.
 */
const CONTENT_HASH_METADATA = 'contentHash';

/** Revalidating default: safe on a key whose bytes can be replaced in place. */
const MEDIA_MUTABLE_CACHE_CONTROL = 'public, max-age=300, must-revalidate';

/** One year, unrevocable. Only ever correct on a version-pinned URL. */
const MEDIA_IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/** Short content fingerprint over the uploaded bytes. */
async function contentHashOf(bytes: BufferSource): Promise<string> {
  // Typed as BufferSource, not cast to ArrayBuffer: an upload `Buffer` can be a
  // view into a larger pooled allocation, and hashing the backing buffer rather
  // than the view would fingerprint bytes that are not part of this object.
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}

/**
 * Decide the `Cache-Control` for a media response (#388).
 *
 * `immutable` tells every cache between here and the user's browser that the
 * bytes will never change — and there is no channel to take that back. It is
 * only honest when the *URL* is a function of the *content*, so that changed
 * bytes are reached through a different URL.
 *
 * `POST /media/:key` overwrites in place (`storage.put` on a caller-chosen
 * key), so the key alone is not that function. The caller opts into the
 * immutable promise by pinning `?v=<contentHash>` — that param is what makes
 * the URL change when the content does.
 *
 * When the stored fingerprint is at hand we also *verify* the pin: a stale or
 * invented `?v=` downgrades to revalidation rather than freezing whatever
 * bytes happen to be there for a year. On the redirect path the source is
 * never fetched, so there is nothing to verify against and the pin is taken at
 * face value — the URL still changes with the content, which is what the
 * promise rests on.
 */
function mediaCacheControl(requestUrl: string, storedVersion: string | null): string {
  const pinned = new URL(requestUrl).searchParams.get('v');
  if (!pinned) return MEDIA_MUTABLE_CACHE_CONTROL;
  if (storedVersion !== null && pinned !== storedVersion) return MEDIA_MUTABLE_CACHE_CONTROL;
  return MEDIA_IMMUTABLE_CACHE_CONTROL;
}

/** Stored content fingerprint, or null for objects written before it existed. */
function storedVersionOf(obj: { metadata?: Record<string, string> }): string | null {
  const version = obj.metadata?.[CONTENT_HASH_METADATA];
  return typeof version === 'string' && version.length > 0 ? version : null;
}

/**
 * Derive a safe `filename` for the Content-Disposition header from a storage
 * key. Strips any directory prefix and removes characters that could break out
 * of the quoted header value (CR/LF, quotes, backslash, control chars).
 */
function sanitizeDownloadFilename(key: string): string {
  const base = key.split('/').pop() ?? 'download';
  // Replace control chars (incl. CR/LF), double-quotes, and backslash so the
  // value cannot break out of the quoted Content-Disposition filename. Filtered
  // by char code rather than a regex with control-char escapes.
  let cleaned = '';
  for (const ch of base) {
    const code = ch.charCodeAt(0);
    cleaned += code < 0x20 || ch === '"' || ch === '\\' ? '_' : ch;
  }
  cleaned = cleaned.trim();
  return cleaned.length > 0 ? cleaned : 'download';
}

async function requireMediaPermission(
  c: Context<AppEnv>,
  action: Extract<PermissionAction, 'create' | 'read' | 'delete'>,
): Promise<Response | null> {
  const perm = await permissionServiceForRequest(c).canAccess('media', action);

  if (perm) return null;
  return c.json(
    { errors: [{ code: 'FORBIDDEN', message: `Action "media:${action}" is not allowed.` }] },
    403,
  );
}

/**
 * GET /media
 * List media assets, optionally filtered by prefix.
 */
mediaRouter.get('/', async (c) => {
  const forbidden = await requireMediaPermission(c, 'read');
  if (forbidden) return forbidden;

  const parsed = listQuerySchema.safeParse(
    Object.fromEntries(new URL(c.req.url).searchParams),
  );
  if (!parsed.success) {
    return c.json(
      { errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) },
      400,
    );
  }

  if (parsed.data.prefix && isInvalidKey(parsed.data.prefix)) {
    return c.json(
      { errors: [{ code: 'VALIDATION', message: 'Invalid prefix format.' }] },
      400,
    );
  }

  const storage = c.get('runtime').storage;
  if (!storage) {
    return c.json(
      { errors: [{ code: 'SERVICE_UNAVAILABLE', message: 'Storage service is not available.' }] },
      503,
    );
  }

  try {
    const siteId = c.get('siteId');
    const prefix = storageKey(siteId, parsed.data.prefix ?? '');
    const result = await storage.list(prefix);
    // Objects in the default storage, and those recorded in a storage profile.
    const recorded = await storageProfileServiceFor(c).recordedKeys(parsed.data.prefix ?? '');
    const keys = new Set([...result.keys.map((key) => publicKey(siteId, key)), ...recorded]);
    return c.json({ data: [...keys].sort() });
  } catch (err) {
    console.error('[media] list error', formatSafeError(err));
    return c.json(
      { errors: [{ code: 'SERVICE_UNAVAILABLE', message: 'Storage service encountered an error.' }] },
      503,
    );
  }
});

/**
 * GET /media/:key
 * Download a media asset by key.
 */
mediaRouter.get('/:key{.+}', async (c) => {
  const forbidden = await requireMediaPermission(c, 'read');
  if (forbidden) return forbidden;

  const key = c.req.param('key');

  if (isInvalidKey(key)) {
    return c.json(
      { errors: [{ code: 'VALIDATION', message: 'Invalid key format.' }] },
      400,
    );
  }

  if (!c.get('runtime').storage) return storageUnavailable(c);
  // The object's own storage: the profile it was written to (P04).
  const at = await locate(c, key, 'read');
  if (!at) return storageUnavailable(c);
  const storage = at.storage;

  // On-the-fly transform: validate the requested DSL, then let the runtime
  // image processor (in-process sharp since HeoPress P03) do the pixel work.
  // No transform params → serve the original
  // bytes below (backward compatible). The `Vary` + transform-keyed cache tag
  // let derivatives be invalidated with the source file (ADR-004).
  let transform: ResolvedTransform | null;
  try {
    transform = await resolveTransform(c);
  } catch {
    return c.json({ errors: [{ code: 'VALIDATION', message: 'Invalid transform parameters.' }] }, 400);
  }
  if (transform) {
    const scoped = at.objectKey;
    const dsl = transform.dsl;

    // Only presets or signed parameters (HeoPress P03 task 4.3; spec "受控的图片转换"):
    // an arbitrary size from the query string is refused unless the site has a
    // signing secret and the request carries a valid `?sig=` over (key, dsl).
    // Without a secret, only presets are served. `presetOnly` refuses signed
    // custom transforms too. (The old `enabled: false` — unsigned custom
    // transforms — is no longer honoured.)
    const policy = await loadSignedTransformPolicy(c);
    if (!transform.fromPreset) {
      const sig = new URL(c.req.url).searchParams.get('sig') ?? '';
      const ok = !policy.presetOnly && policy.secret ? await verifyTransform(policy.secret, key, dsl, sig) : false;
      if (!ok) {
        return c.json(
          { errors: [{ code: 'FORBIDDEN', message: 'Only preset or signed transforms are allowed.' }] },
          403,
        );
      }
    }

    const media = c.get('runtime').media;
    const options = {
      width: dsl.width,
      height: dsl.height,
      format: dsl.format,
      quality: dsl.quality,
      fit: dsl.fit,
    };
    if (typeof media.transform !== 'function') {
      return c.json({ errors: [{ code: 'SERVICE_UNAVAILABLE', message: 'Image transforms are not available.' }] }, 503);
    }
    const limits = (media as { checkLimits?: (o: typeof options) => void }).checkLimits;
    try {
      limits?.call(media, options);
    } catch (err) {
      return c.json({ errors: [{ code: 'VALIDATION', message: err instanceof Error ? err.message : 'Transform out of range.' }] }, 400);
    }

    try {
      const obj = await storage.get(scoped);
      if (!obj) {
        return c.json({ errors: [{ code: 'NOT_FOUND', message: 'Media asset not found.' }] }, 404);
      }
      const srcBytes = await new Response(obj.body as BodyInit).arrayBuffer();
      // The source bytes are already in hand here, so the fingerprint is the
      // real one even for objects uploaded before the metadata field existed.
      const version = storedVersionOf(obj) ?? (await contentHashOf(srcBytes));
      const derivativeKey = transformKey(scoped, dsl);
      const etag = await weakEtag([version, derivativeKey]);
      const headers: Record<string, string> = {
        'Cache-Control': mediaCacheControl(c.req.url, version),
        ETag: etag,
        'X-Transform-Key': derivativeKey,
        'X-Content-Type-Options': 'nosniff',
      };
      if (etagMatches(c.req.header('if-none-match'), etag)) {
        return new Response(null, { status: 304, headers });
      }

      // Derivatives are stored under `derived/`, keyed by the source version
      // and the transform, and reused: the same image with the same parameters
      // is transformed once. A new upload changes the version, so a stale
      // derivative is never served.
      const cacheKey = derivedStorageKey(scoped, await contentHashOf(new TextEncoder().encode(`${version}|${derivativeKey}`).buffer as ArrayBuffer));
      const cached = await storage.get(cacheKey);
      if (cached) {
        return new Response(cached.body as BodyInit, {
          status: 200,
          headers: { ...headers, 'Content-Type': cached.contentType ?? 'application/octet-stream', 'X-Transform-Cache': 'hit' },
        });
      }
      const out = await media.transform(srcBytes, options);
      await storage
        .put(cacheKey, Buffer.from(out.body), { contentType: out.contentType })
        .catch((err: unknown) => console.warn('[media] could not store derivative', formatSafeError(err)));
      return new Response(out.body as unknown as BodyInit, {
        status: 200,
        headers: { ...headers, 'Content-Type': out.contentType, 'X-Transform-Cache': 'miss' },
      });
    } catch (err) {
      console.warn('[media] transform failed', formatSafeError(err));
      return c.json({ errors: [{ code: 'TRANSFORM_FAILED', message: 'The image could not be transformed.' }] }, 422);
    }
  }

  try {
    const obj = await storage.get(at.objectKey);
    if (!obj) {
      return c.json(
        { errors: [{ code: 'NOT_FOUND', message: 'Media asset not found.' }] },
        404,
      );
    }

    const headers: Record<string, string> = {};
    // `obj.contentType` is the native storage content-type; fall back to the
    // custom metadata copy for objects written before the adapters mapped it
    // onto the native field (older uploads store it only in metadata).
    const contentType = obj.contentType ?? obj.metadata?.contentType;
    if (contentType) headers['Content-Type'] = contentType;
    if (obj.size != null) headers['Content-Length'] = String(obj.size);

    // An explicit policy, rather than leaving the response with no
    // `Cache-Control` at all and letting each cache apply its own heuristic
    // (#388). Versioned only when the caller pinned a matching `?v=`.
    const version = storedVersionOf(obj);
    headers['Cache-Control'] = mediaCacheControl(c.req.url, version);
    if (version) {
      // Surfaced so a client can build the pinned `?v=` URL from a plain GET,
      // without having to have seen the upload response.
      headers['X-HeoPress-Media-Version'] = version;
      const etag = await weakEtag([version]);
      headers.ETag = etag;
      if (etagMatches(c.req.header('if-none-match'), etag)) {
        // 304 carries no body, so drop the body-describing header with it.
        delete headers['Content-Length'];
        return new Response(null, { status: 304, headers });
      }
    }
    // Serve user-uploaded bytes as a download, never as an inline document.
    // Combined with the global `X-Content-Type-Options: nosniff` + CSP, this
    // stops a stored HTML/SVG payload from being rendered (and its script
    // executed) under this origin when opened top-level. `<img>`/`<video>`
    // embedding of legitimate media is unaffected by Content-Disposition.
    headers['Content-Disposition'] = `attachment; filename="${sanitizeDownloadFilename(key)}"`;
    headers['X-Content-Type-Options'] = 'nosniff';

    return new Response(obj.body as BodyInit, { status: 200, headers });
  } catch (err) {
    console.error('[media] get error', formatSafeError(err));
    return c.json(
      { errors: [{ code: 'SERVICE_UNAVAILABLE', message: 'Storage service encountered an error.' }] },
      503,
    );
  }
});

/**
 * POST /media/:key
 * Upload a media asset. The request body is stored as-is.
 * Content-Type header is preserved as metadata.
 *
 * For image uploads, a thumbnail generation job is enqueued (fire-and-forget)
 * to produce predefined sizes (150x150, 300x300, 600x600).
 */
mediaRouter.post('/:key{.+}', async (c) => {
  const forbidden = await requireMediaPermission(c, 'create');
  if (forbidden) return forbidden;

  const key = c.req.param('key');

  if (isInvalidKey(key)) {
    return c.json(
      { errors: [{ code: 'VALIDATION', message: 'Invalid key format.' }] },
      400,
    );
  }

  if (!c.get('runtime').storage) return storageUnavailable(c);
  // New media goes to the site's bound storage profile, or the default (P04).
  const at = await locate(c, key, 'write');
  if (!at) return storageUnavailable(c);
  if (key.startsWith(EDITOR_MEDIA_PREFIX)) {
    const refusal = editorUploadRefusal(at);
    if (refusal) return c.json({ errors: [{ code: refusal, message: EDITOR_REFUSAL_MESSAGE[refusal] }] }, 409);
  }
  const storage = at.storage;

  try {
    const contentType = c.req.header('content-type') ?? 'application/octet-stream';
    const body = await c.req.arrayBuffer();
    const data = Buffer.from(body);
    const scopedKey = at.objectKey;

    // Fingerprint the bytes on the way in. This is what lets a reader pin
    // `?v=` and get an immutable URL: the upload overwrites in place, so the
    // key is stable across content changes but this value is not (#388).
    const version = await contentHashOf(data);
    const metadata: Record<string, string> = { contentType, [CONTENT_HASH_METADATA]: version };
    await storage.put(scopedKey, data, metadata);
    await storageProfileServiceFor(c).recordWrite(key, at, { contentType, size: data.byteLength });

    // Fire-and-forget: enqueue thumbnail generation for image uploads
    if (contentType.startsWith('image/')) {
      try {
        const queue = c.get('runtime').queue;
        if (queue) {
          queue.enqueue('media-processing', 'generate-thumbnails', {
            key: scopedKey,
            sizes: [
              { width: 150, height: 150 },
              { width: 300, height: 300 },
              { width: 600, height: 600 },
            ],
          }).catch((err) => {
            console.warn('[media] failed to enqueue thumbnail generation', formatSafeError(err));
          });
        }
      } catch (err) {
        console.warn('[media] queue unavailable for thumbnail generation', formatSafeError(err));
      }
    }

    // Public URL from the profile's public base URL (spec "媒体 URL 使用站点域名").
    const url = at.publicBaseUrl ? `${at.publicBaseUrl}/${at.objectKey}` : null;
    return c.json({ data: { key, size: data.byteLength, contentType, version, url } }, 201);
  } catch (err) {
    console.error('[media] upload error', formatSafeError(err));
    return c.json(
      { errors: [{ code: 'SERVICE_UNAVAILABLE', message: 'Storage service encountered an error.' }] },
      503,
    );
  }
});

/**
 * DELETE /media/:key
 * Delete a media asset by key.
 */
mediaRouter.delete('/:key{.+}', async (c) => {
  const forbidden = await requireMediaPermission(c, 'delete');
  if (forbidden) return forbidden;

  const key = c.req.param('key');

  if (isInvalidKey(key)) {
    return c.json(
      { errors: [{ code: 'VALIDATION', message: 'Invalid key format.' }] },
      400,
    );
  }

  if (!c.get('runtime').storage) return storageUnavailable(c);
  const at = await locate(c, key, 'read');
  if (!at) return storageUnavailable(c);
  const storage = at.storage;

  try {
    const scoped = at.objectKey;
    await storage.delete(scoped);
    await storageProfileServiceFor(c).recordDelete(key);
    // Drop cached derivatives of this file (best effort; they are keyed by the
    // source version, so a leftover one is never served).
    const derived = await storage.list(`derived/${scoped}/`).catch(() => ({ keys: [] as string[] }));
    await Promise.all(derived.keys.map((k) => storage.delete(k).catch(() => undefined)));
    return c.body(null, 204);
  } catch (err) {
    console.error('[media] delete error', formatSafeError(err));
    return c.json(
      { errors: [{ code: 'SERVICE_UNAVAILABLE', message: 'Storage service encountered an error.' }] },
      503,
    );
  }
});
