import { Hono } from 'hono';
import { isVideoMime, normalizeMimeType, resolveVideoMaxBytes } from '@heopress/contracts/schemas';
import { formatSafeError } from '@heopress/contracts/utils';
import type { AppEnv } from '../env';
import { permissionServiceForRequest } from '../services/item-service-factory';
import { resolveUploadPolicy } from '../services/upload-policy-service';
import { editorUploadRefusal, EDITOR_MEDIA_PREFIX } from './media';
import { storageProfileServiceFor } from './storage-profiles';

/**
 * GET /api/v1/editor-media/target — may the rich-text editor upload here, and what (ADR-0020)?
 *
 * Uploads themselves go through `POST /api/v1/media/editor/…` (guarded by the upload policy like every upload);
 * this tells the editor before it tries: whether the site's storage is object storage with a public base URL,
 * which image and video types the site accepts, and the caps.
 */
export const editorMediaRouter = new Hono<AppEnv>();

editorMediaRouter.get('/target', async (c) => {
  const canCreate = await permissionServiceForRequest(c).canAccess('media', 'create');
  if (!canCreate) return c.json({ errors: [{ code: 'FORBIDDEN', message: 'Action "media:create" is not allowed.' }] }, 403);

  const policy = await resolveUploadPolicy({ db: c.get('db'), cache: c.get('runtime')?.cache, siteId: c.get('siteId'), env: c.env });
  const types = policy.allowedMimeTypes.map((m) => normalizeMimeType(m) ?? m).filter((m) => (m.startsWith('image/') && m !== 'image/svg+xml') || isVideoMime(m));
  let refusal: ReturnType<typeof editorUploadRefusal>;
  try {
    refusal = editorUploadRefusal(await storageProfileServiceFor(c).writeLocation(`${EDITOR_MEDIA_PREFIX}probe`));
  } catch (err) {
    console.error('[editor-media] storage profile unavailable', formatSafeError(err));
    return c.json({ errors: [{ code: 'SERVICE_UNAVAILABLE', message: 'Storage service is not available.' }] }, 503);
  }
  return c.json({
    data: {
      available: refusal === null,
      reason: refusal,
      prefix: EDITOR_MEDIA_PREFIX,
      types,
      maxBytes: policy.maxBytes,
      videoMaxBytes: resolveVideoMaxBytes(c.env?.FILE_UPLOAD_VIDEO_MAX_BYTES ?? process.env.FILE_UPLOAD_VIDEO_MAX_BYTES),
    },
  });
});
