import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppEnv } from '../env';
import { requireSiteAdmin } from '../middleware/site-admin';
import { ThemeService, ThemeServiceError } from '../services/themes/theme-service';

/**
 * Site themes (HeoPress P06 tasks 2.3, 2.4, 2.7): upload an immutable version (checked on upload), list
 * versions with their checks, and activate one — publish, switch or roll back. Site administrators only.
 *
 *   GET  /api/v1/themes                          versions, newest first, the active one marked
 *   POST /api/v1/themes/versions                 { name, templates: { home: "…", … }, assets?: [{ path, contentType, base64 }] }
 *   POST /api/v1/themes/versions/:id/activate    make it the site's active version
 *   POST /api/v1/themes/starters/:name           install a starter theme (news, tech, minimal) as a new version
 */
export const themesRouter = new Hono<AppEnv>();

themesRouter.use('*', requireSiteAdmin());

const serviceFor = (c: Context<AppEnv>) =>
  new ThemeService({
    db: c.get('db'),
    siteId: c.get('siteId'),
    actor: { userId: c.get('auth')?.userId ?? null, apiKeyId: c.get('auth')?.apiKeyId ?? null, email: c.get('auth')?.email ?? null },
  });

const failure = (c: Context<AppEnv>, err: unknown) => {
  if (err instanceof ThemeServiceError) {
    return c.json({ errors: [{ code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) }] }, err.status);
  }
  throw err;
};

themesRouter.get('/', async (c) => c.json({ data: await serviceFor(c).list() }));

/** A version's upload: 20 MB of assets as base64 (≈ 27 MB) plus templates; refused while being read, past this. */
const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

themesRouter.post(
  '/versions',
  bodyLimit({ maxSize: MAX_UPLOAD_BYTES, onError: (c) => c.json({ errors: [{ code: 'TOO_LARGE', message: 'The upload is larger than 32 MB.' }] }, 413) }),
  async (c) => {
  const body = (await c.req.json().catch(() => null)) as { name?: unknown; templates?: unknown; assets?: unknown } | null;
  if (!body || typeof body.name !== 'string' || !body.templates || typeof body.templates !== 'object' || Array.isArray(body.templates)) {
    return c.json({ errors: [{ code: 'VALIDATION', message: 'Expected { name, templates, assets? }.' }] }, 400);
  }
  if (body.assets !== undefined && !Array.isArray(body.assets)) return c.json({ errors: [{ code: 'VALIDATION', message: 'assets must be a list.' }] }, 400);
  try {
    const version = await serviceFor(c).createVersion({
      name: body.name,
      templates: body.templates as Record<string, string>,
      assets: (body.assets as Array<{ path: string; contentType: string; base64: string }> | undefined) ?? [],
    });
    return c.json({ data: version }, 201);
  } catch (err) {
    return failure(c, err);
  }
  },
);

themesRouter.post('/starters/:name', async (c) => {
  try {
    return c.json({ data: await serviceFor(c).installStarter(c.req.param('name')) }, 201);
  } catch (err) {
    return failure(c, err);
  }
});

themesRouter.post('/versions/:id/activate', async (c) => {
  try {
    return c.json({ data: await serviceFor(c).activate(c.req.param('id')) });
  } catch (err) {
    return failure(c, err);
  }
});
