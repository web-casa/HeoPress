import { createHash, timingSafeEqual } from 'node:crypto';
import { Hono, type MiddlewareHandler } from 'hono';
import type { AppEnv } from '../env';
import { PreviewDenied, PreviewService } from '../services/rendering/preview-service';
import { BranchPreviewService } from '../services/rendering/branch-preview-service';

/**
 * The controlled preview read (HeoPress P06 task 4.3; design R7, R43): what the rendering service asks
 * when it serves a preview. Drafts never reach the rendering role — they come from here.
 *
 *   POST /internal/preview/resolve  { site_id, token }                          → { data: PreviewTarget }
 *   POST /internal/preview/asset    { site_id, token, version_id, sha256, ext } → the asset's bytes
 *   POST /internal/preview/branch-exchange { site_id, token }  → { data: { cookie, expiresAt, path } } (P10: a one-time
 *                                                                  branch preview link, traded once for its cookie)
 *   POST /internal/preview/branch-resolve  { site_id, token }  → { data: BranchPreviewTarget } (`token`: the cookie)
 *
 * Service-to-service only: `X-HeoPress-Internal-Secret` must equal `HEOPRESS_INTERNAL_SECRET` (32+
 * characters; without it the endpoint does not exist: 404), and a request that came through a proxy is
 * refused (the edge also answers `/internal/*` with 404). Rate-limited per site. Every refusal of a link
 * is the same 403. The token travels in the body, never in a URL, and is not logged.
 */
export const internalPreviewRouter = new Hono<AppEnv>();

const digest = (s: string) => createHash('sha256').update(s).digest();

const internalSecret = (c: Parameters<MiddlewareHandler<AppEnv>>[0]): string => {
  const env = (c.env ?? {}) as unknown as Record<string, string | undefined>;
  return (env.HEOPRESS_INTERNAL_SECRET ?? process.env.HEOPRESS_INTERNAL_SECRET ?? '').trim();
};

const serviceAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const secret = internalSecret(c);
  if (secret.length < 32) return c.json({ errors: [{ code: 'NOT_FOUND', message: 'Not found.' }] }, 404);
  const given = c.req.header('x-heopress-internal-secret') ?? '';
  const forwarded = ['x-forwarded-for', 'forwarded', 'x-real-ip'].some((h) => c.req.header(h) !== undefined);
  if (forwarded || !timingSafeEqual(digest(given), digest(secret))) {
    return c.json({ errors: [{ code: 'FORBIDDEN', message: 'Internal endpoint.' }] }, 403);
  }
  await next();
};

internalPreviewRouter.use('*', serviceAuth);

const denied = (c: Parameters<MiddlewareHandler<AppEnv>>[0]) => c.json({ errors: [{ code: 'PREVIEW_DENIED', message: 'Preview not allowed.' }] }, 403);

/** The body's site and token, under a per-site rate limit; a Response when already answered. */
async function begin(c: Parameters<MiddlewareHandler<AppEnv>>[0]): Promise<{ body: Record<string, unknown>; siteId: string; token: string } | Response> {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.site_id !== 'string' || typeof body.token !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(body.site_id)) {
    return c.json({ errors: [{ code: 'VALIDATION', message: 'Expected { site_id, token }.' }] }, 400);
  }
  const limiter = c.get('runtime')?.rateLimiter;
  if (limiter) {
    const verdict = await limiter.consume(`preview:${body.site_id}`, 600, 60);
    if (!verdict.allowed) return c.json({ errors: [{ code: 'RATE_LIMITED', message: 'Too many requests.' }] }, 429);
  }
  return { body, siteId: body.site_id, token: body.token };
}

const serviceFor = (c: Parameters<MiddlewareHandler<AppEnv>>[0]) => new PreviewService({ db: c.get('db'), cache: c.get('runtime')?.cache });

internalPreviewRouter.post('/resolve', async (c) => {
  const started = await begin(c);
  if (started instanceof Response) return started;
  try {
    const target = await serviceFor(c).resolve(started.siteId, started.token);
    return c.json({ data: target });
  } catch (err) {
    if (err instanceof PreviewDenied) return denied(c);
    throw err;
  }
});

internalPreviewRouter.post('/asset', async (c) => {
  const started = await begin(c);
  if (started instanceof Response) return started;
  const { version_id: versionId, sha256, ext } = started.body;
  if (typeof versionId !== 'string' || typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256) || typeof ext !== 'string' || !/^[a-z0-9]{1,8}$/.test(ext)) {
    return c.json({ errors: [{ code: 'VALIDATION', message: 'Expected { version_id, sha256, ext }.' }] }, 400);
  }
  try {
    const asset = await serviceFor(c).asset(started.siteId, started.token, versionId, sha256, ext);
    if (!asset) return c.json({ errors: [{ code: 'NOT_FOUND', message: 'Not found.' }] }, 404);
    return c.body(new Uint8Array(asset.bytes), 200, { 'content-type': asset.contentType });
  } catch (err) {
    if (err instanceof PreviewDenied) return denied(c);
    throw err;
  }
});

const branchService = (c: Parameters<MiddlewareHandler<AppEnv>>[0]) =>
  new BranchPreviewService({ db: c.get('db'), secret: internalSecret(c), cache: c.get('runtime')?.cache });

internalPreviewRouter.post('/branch-exchange', async (c) => {
  const started = await begin(c);
  if (started instanceof Response) return started;
  try {
    const out = await branchService(c).exchange(started.siteId, started.token);
    return c.json({ data: { cookie: out.cookie, expiresAt: out.expiresAt.toISOString(), path: out.path } });
  } catch (err) {
    if (err instanceof PreviewDenied) return denied(c);
    throw err;
  }
});

internalPreviewRouter.post('/branch-resolve', async (c) => {
  const started = await begin(c);
  if (started instanceof Response) return started;
  try {
    return c.json({ data: await branchService(c).resolve(started.siteId, started.token) });
  } catch (err) {
    if (err instanceof PreviewDenied) return denied(c);
    throw err;
  }
});
