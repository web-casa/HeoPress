import { Hono, type Context } from 'hono';
import type { AppEnv } from '../env';
import { requireSiteAdmin } from '../middleware/site-admin';
import { IngestProviderService } from '../services/ingest/providers/settings';
import { IngestSourceError } from '../services/ingest/source-service';

/**
 * /ingest/providers — the site's external crawl services (HeoPress P08 tasks 3.3, 3.4, 3.6; spec ingest/crawling
 * "外部采集服务插件", "采集服务预算与熔断").
 *
 *   GET   /                     every service: enabled, order, consent, whether a credential is set (never the
 *                               credential), budget, breaker and this month's usage (any member of the site)
 *   PATCH /:provider            change them (administrators); `credential` is write-only
 *   GET   /chains/:sourceId     a source's fallback chain (its own or the site default)
 *   PUT   /chains/:sourceId     set it (`{ chain: [...] }`, `{ chain: null }` for the default; administrators)
 */
export const ingestProvidersRouter = new Hono<AppEnv>();

function serviceFor(c: Context<AppEnv>): IngestProviderService {
  return new IngestProviderService({ db: c.get('db'), siteId: c.get('siteId'), keys: c.get('runtime').keys, userId: c.get('auth')?.userId ?? null });
}

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

ingestProvidersRouter.get('/', (c) => answer(c, () => serviceFor(c).list()));

ingestProvidersRouter.patch('/:provider', requireSiteAdmin(), async (c) => {
  const body = await readBody(c);
  return answer(c, () => serviceFor(c).update(c.req.param('provider'), body));
});

ingestProvidersRouter.get('/chains/:sourceId', (c) => answer(c, () => serviceFor(c).getChain(c.req.param('sourceId'))));

ingestProvidersRouter.put('/chains/:sourceId', requireSiteAdmin(), async (c) => {
  const body = await readBody(c);
  return answer(c, () => serviceFor(c).setChain(c.req.param('sourceId'), body));
});
