import { Hono, type Context } from 'hono';
import type { AppEnv } from '../env';
import { PermissionService } from '../services/permission-service';
import { PreviewService, PreviewServiceError } from '../services/rendering/preview-service';

/**
 * Preview links (HeoPress P06 tasks 4.2, 4.3; spec rendering/preview; design R7, R17, R43).
 *
 *   POST   /api/v1/preview-links       { kind: "item", collection, target_id, ttl_seconds? }
 *                                       | { kind: "theme", target_id, ttl_seconds? }
 *                                       → 201 { data: { id, url, expires_at } } — the URL (with the token) only here
 *   DELETE /api/v1/preview-links/:id   revoke (its creator or a site administrator)
 *
 * The URL is on the preview origin (`HEOPRESS_PREVIEW_ORIGIN`): `<origin>/<site id>/<token>`. Without that
 * origin configured, previews are off (503).
 */
export const previewLinksRouter = new Hono<AppEnv>();

function previewOrigin(c: Context<AppEnv>): string | null {
  const env = (c.env ?? {}) as unknown as Record<string, string | undefined>;
  const raw = (env.HEOPRESS_PREVIEW_ORIGIN ?? process.env.HEOPRESS_PREVIEW_ORIGIN ?? '').trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || u.hostname === 'localhost' || u.hostname === '127.0.0.1' ? u.origin : null;
  } catch {
    return null;
  }
}

const serviceFor = (c: Context<AppEnv>) => new PreviewService({ db: c.get('db'), cache: c.get('runtime')?.cache });

const failure = (c: Context<AppEnv>, err: unknown) => {
  if (err instanceof PreviewServiceError) return c.json({ errors: [{ code: err.code, message: err.message }] }, err.status);
  throw err;
};

previewLinksRouter.post('/', async (c) => {
  const origin = previewOrigin(c);
  if (!origin) return c.json({ errors: [{ code: 'PREVIEW_DISABLED', message: 'HEOPRESS_PREVIEW_ORIGIN is not configured.' }] }, 503);
  const siteId = c.get('siteId');
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!siteId || !body) return c.json({ errors: [{ code: 'VALIDATION', message: 'Expected { kind, target_id, collection?, ttl_seconds? }.' }] }, 400);
  try {
    const link = await serviceFor(c).create({
      siteId,
      userId: c.get('auth')?.userId ?? null,
      kind: body.kind,
      collection: body.collection,
      targetId: body.target_id,
      ttlSeconds: body.ttl_seconds,
    });
    return c.json({ data: { id: link.id, url: `${origin}/${encodeURIComponent(siteId)}/${link.token}`, expires_at: link.expiresAt.toISOString() } }, 201);
  } catch (err) {
    return failure(c, err);
  }
});

previewLinksRouter.delete('/:id', async (c) => {
  const siteId = c.get('siteId');
  const userId = c.get('auth')?.userId ?? null;
  if (!siteId || !userId) return c.json({ errors: [{ code: 'FORBIDDEN', message: 'Preview links are revoked by a signed-in user.' }] }, 403);
  const bundle = await new PermissionService({
    db: c.get('db'),
    cache: c.get('runtime')?.cache,
    ctx: { userId, siteId, roleId: c.get('auth')?.roleId ?? null, ip: null, headers: {} },
  }).bundle();
  try {
    await serviceFor(c).revoke(siteId, c.req.param('id'), { userId, admin: bundle.admin });
    return c.body(null, 204);
  } catch (err) {
    return failure(c, err);
  }
});
