import { Hono, type Context } from 'hono';
import type { AppEnv } from '../env';
import { requireSiteAdmin } from '../middleware/site-admin';
import { LicenceReviewService } from '../services/ingest/licence-lapse';
import { listResearchLeads } from '../services/ingest/research-leads';
import { IngestSiteSettingsService } from '../services/ingest/site-settings';
import { IngestSourceError } from '../services/ingest/source-service';
import { setMediaLicence } from '../services/ingest/source-media';
import { trackingParamsFromEnv } from '../services/ingest/url-normalize';

/**
 * Ingestion after registration (HeoPress P08 tasks 1.6, 1.7, 2.9), mounted under /ingest:
 *
 *   GET  /settings                     the site's licence-lapse policy and primary-source allow-list (members)
 *   PUT  /settings                     set them (administrators)
 *   GET  /licence-reviews?state=all    the licence review queue (open by default; members)
 *   POST /licence-reviews/resolve      `{ ids, decision: 'restore' | 'dismiss' }`, one or many (administrators, in person)
 *   GET  /leads                        the latest research leads (members)
 *   PUT  /media-licences               a media item's own licence (administrators)
 */
export const ingestLifecycleRouter = new Hono<AppEnv>();

const answer = async (c: Context<AppEnv>, run: () => Promise<unknown>) => {
  try {
    return c.json({ data: await run() });
  } catch (err) {
    if (err instanceof IngestSourceError) {
      return c.json({ errors: [{ code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) }] }, err.status);
    }
    throw err;
  }
};

const readBody = (c: Context<AppEnv>) => c.req.json().catch(() => null) as Promise<unknown>;

/** A signed-in person acting directly: not an API key, not an anonymous or front-end principal. */
function isPerson(c: Context<AppEnv>): boolean {
  const auth = c.get('auth');
  return Boolean(auth?.userId) && !auth?.apiKeyId && auth?.type !== 'api_key' && auth?.type !== 'anonymous' && !auth?.isFrontendUser && auth?.method !== 'api_key';
}

const settings = (c: Context<AppEnv>) => new IngestSiteSettingsService({ db: c.get('db'), siteId: c.get('siteId'), userId: c.get('auth')?.userId ?? null });
const reviews = (c: Context<AppEnv>) =>
  new LicenceReviewService({ db: c.get('db'), siteId: c.get('siteId'), actor: { userId: c.get('auth')?.userId ?? null, person: isPerson(c) } });

ingestLifecycleRouter.get('/settings', (c) => answer(c, () => settings(c).get()));
ingestLifecycleRouter.put('/settings', requireSiteAdmin(), async (c) => {
  const body = await readBody(c);
  return answer(c, () => settings(c).update(body));
});

ingestLifecycleRouter.get('/licence-reviews', (c) => answer(c, () => reviews(c).list(c.req.query('state') === 'all' ? 'all' : 'open')));
ingestLifecycleRouter.post('/licence-reviews/resolve', requireSiteAdmin(), async (c) => {
  const body = await readBody(c);
  return answer(c, () => reviews(c).resolve(body));
});

ingestLifecycleRouter.get('/leads', (c) => answer(c, () => listResearchLeads(c.get('db'), c.get('siteId'), Number(c.req.query('limit')) || 100)));

ingestLifecycleRouter.put('/media-licences', requireSiteAdmin(), async (c) => {
  const body = await readBody(c);
  return answer(c, () => setMediaLicence(c.get('db'), c.get('siteId'), c.get('auth')?.userId ?? null, body, trackingParamsFromEnv()));
});
