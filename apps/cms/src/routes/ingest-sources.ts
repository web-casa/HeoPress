import { Hono, type Context } from 'hono';
import type { AppEnv } from '../env';
import { requireSiteAdmin } from '../middleware/site-admin';
import { requireSiteEditor } from '../middleware/site-editor';
import { IngestSourceError, IngestSourceService, TERMS_KEYS } from '../services/ingest/source-service';

/**
 * /ingest/sources — the site's content sources (HeoPress P08 tasks 1.1, 1.2,
 * 1.4, 1.5; spec ingest/sources).
 *
 *   GET    /                    list (any member of the site)
 *   POST   /                    add (editors; the terms start at their defaults)
 *   GET    /adapters            the source types the site's plugins offer (P12 task 4.1)
 *   GET    /:id                 read
 *   PATCH  /:id                 change what, when and how much (editors)
 *   DELETE /:id                 delete (administrators)
 *   GET    /:id/licences        licence revisions, newest first
 *   POST   /:id/licences        new terms with evidence (administrators)
 *   GET    /:id/runs            latest runs
 *   POST   /:id/pause           pause (editors)
 *   POST   /:id/resume          resume (administrators)
 *
 * Another site's sources are out of reach: site membership is required for
 * every API request, and every query is scoped to the active site.
 */

export const ingestSourcesRouter = new Hono<AppEnv>();

/** Whether the caller administers the active site (the same decision `requireSiteAdmin` makes). */
async function isSiteAdmin(c: Context<AppEnv>): Promise<boolean> {
  let admitted = false;
  await requireSiteAdmin()(c, async () => {
    admitted = true;
  });
  return admitted;
}

async function serviceFor(c: Context<AppEnv>): Promise<IngestSourceService> {
  const auth = c.get('auth');
  return new IngestSourceService({
    db: c.get('db'),
    siteId: c.get('siteId'),
    actor: { userId: auth?.userId ?? null, apiKeyId: auth?.apiKeyId ?? null, isAdmin: await isSiteAdmin(c) },
  });
}

const answer = async (c: Context<AppEnv>, run: () => Promise<unknown>, status: 200 | 201 = 200) => {
  try {
    return c.json({ data: await run() }, status);
  } catch (err) {
    if (err instanceof IngestSourceError) {
      return c.json({ errors: [{ code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) }] }, err.status);
    }
    throw err;
  }
};

/**
 * A body that tries to set the terms outside a licence revision: refused —
 * 403 for a non-administrator (they may not set them at all), 400 otherwise
 * (they go through `POST /:id/licences`, with evidence).
 */
async function termsInBody(c: Context<AppEnv>, body: unknown): Promise<Response | null> {
  if (!body || typeof body !== 'object') return null;
  const keys = TERMS_KEYS.filter((k) => k in body);
  if (!keys.length) return null;
  if (!(await isSiteAdmin(c))) {
    return c.json({ errors: [{ code: 'FORBIDDEN', message: 'Only site administrators may set a source\'s licence, usage or trust.', details: keys }] }, 403);
  }
  return c.json({ errors: [{ code: 'VALIDATION', message: 'Set the licence, usage and trust with a licence revision (POST /ingest/sources/:id/licences).', details: keys }] }, 400);
}

const readBody = (c: Context<AppEnv>) => c.req.json().catch(() => null) as Promise<unknown>;

ingestSourcesRouter.get('/', (c) => answer(c, async () => (await serviceFor(c)).list()));

ingestSourcesRouter.post('/', requireSiteEditor(), async (c) => {
  const body = await readBody(c);
  const refused = await termsInBody(c, body);
  if (refused) return refused;
  return answer(c, async () => (await serviceFor(c)).create(body), 201);
});

ingestSourcesRouter.get('/adapters', (c) => answer(c, async () => (await serviceFor(c)).adapters()));

ingestSourcesRouter.get('/:id', (c) => answer(c, async () => (await serviceFor(c)).get(c.req.param('id'))));

ingestSourcesRouter.patch('/:id', requireSiteEditor(), async (c) => {
  const body = await readBody(c);
  const refused = await termsInBody(c, body);
  if (refused) return refused;
  return answer(c, async () => (await serviceFor(c)).update(c.req.param('id'), body));
});

ingestSourcesRouter.delete('/:id', requireSiteAdmin(), async (c) => {
  const res = await answer(c, async () => (await serviceFor(c)).remove(c.req.param('id')));
  return res.status === 200 ? c.body(null, 204) : res;
});

ingestSourcesRouter.get('/:id/licences', (c) => answer(c, async () => (await serviceFor(c)).licences(c.req.param('id'))));

ingestSourcesRouter.post('/:id/licences', requireSiteAdmin(), async (c) => {
  const body = await readBody(c);
  return answer(c, async () => (await serviceFor(c)).reviseLicence(c.req.param('id'), body), 201);
});

ingestSourcesRouter.get('/:id/runs', (c) => answer(c, async () => (await serviceFor(c)).runs(c.req.param('id'), Number(c.req.query('limit') ?? 50) || 50)));

ingestSourcesRouter.post('/:id/pause', requireSiteEditor(), (c) => answer(c, async () => (await serviceFor(c)).pause(c.req.param('id'))));

ingestSourcesRouter.post('/:id/resume', requireSiteAdmin(), (c) => answer(c, async () => (await serviceFor(c)).resume(c.req.param('id'))));
