import { Hono, type Context } from 'hono';
import type { AppEnv } from '../env';
import { requireSiteAdmin } from '../middleware/site-admin';
import { requireSiteEditor } from '../middleware/site-editor';
import { EditorialProfileError, EditorialProfileService } from '../services/site-network/editorial-profile-service';

/**
 * /editorial-profile — the site's editorial profile (HeoPress P05 tasks
 * 2.1–2.3; spec content/editorial-profiles; design C).
 *
 * - `GET /` the version in effect (`null` when none): any member of the
 *   site, API keys and MCP tokens included; another site's is out of reach
 *   (site membership is required for every API request).
 * - `GET /versions`, `GET /versions/:version`: the history.
 * - `POST /versions` saves a new draft version: editors of the site.
 * - `POST /versions/:version/publish` makes it the one in effect: site
 *   administrators.
 */

export const editorialProfileRouter = new Hono<AppEnv>();

const serviceFor = (c: Context<AppEnv>) =>
  new EditorialProfileService({
    db: c.get('db'),
    siteId: c.get('siteId'),
    actor: { userId: c.get('auth')?.userId ?? null, apiKeyId: c.get('auth')?.apiKeyId ?? null, email: c.get('auth')?.email ?? null },
  });

const answer = async (c: Context<AppEnv>, run: () => Promise<unknown>, status: 200 | 201 = 200) => {
  try {
    return c.json({ data: await run() }, status);
  } catch (err) {
    if (err instanceof EditorialProfileError) {
      return c.json({ errors: [{ code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) }] }, err.status);
    }
    throw err;
  }
};

const versionOf = (c: Context<AppEnv>): number | null => {
  const v = Number(c.req.param('version'));
  return Number.isSafeInteger(v) && v > 0 ? v : null;
};

editorialProfileRouter.get('/', (c) => answer(c, () => serviceFor(c).current()));

editorialProfileRouter.get('/versions', (c) => answer(c, () => serviceFor(c).list()));

editorialProfileRouter.get('/versions/:version', (c) => {
  const v = versionOf(c);
  if (v === null) return c.json({ errors: [{ code: 'NOT_FOUND', message: 'No such version.' }] }, 404);
  return answer(c, () => serviceFor(c).get(v));
});

editorialProfileRouter.post('/versions', requireSiteEditor(), async (c) => {
  const body = (await c.req.json().catch(() => null)) as { content?: unknown } | null;
  return answer(c, () => serviceFor(c).create(body?.content ?? body), 201);
});

editorialProfileRouter.post('/versions/:version/publish', requireSiteAdmin(), (c) => {
  const v = versionOf(c);
  if (v === null) return c.json({ errors: [{ code: 'NOT_FOUND', message: 'No such version.' }] }, 404);
  return answer(c, () => serviceFor(c).publish(v));
});
