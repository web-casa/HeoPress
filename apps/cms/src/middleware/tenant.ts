// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../env';
import { getHostMapping } from '../services/domains/host-cache';
import { isValidSiteId } from '../services/identifier-guard';

/**
 * Resolve the active `site_id` for the request and pin it on the context.
 *
 * Resolution order (highest priority first):
 *   1. Explicit `X-HeoPress-Site` header (used by Studio + SDK).
 *   2. Exact host mapping: full `Host` header → `site-host:<fqdn>` KV lookup.
 *      Serves custom domains (`cms.acme.com`) and free `*.heopress.example`
 *      subdomains registered via `site_domains`.
 *   3. Legacy subdomain mapping: `<slug>.api.heopress.example` → `site-domain:<slug>`.
 *   4. Query string `?site=` (only when `HEOPRESS_DEV_AUTH=true`).
 *
 * Once resolved, every downstream service MUST scope queries by this id
 * (Strict Rule #2: multi-tenancy at the ORM/query layer).
 */
export const withTenant = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  const path = c.req.path;
  if (path.startsWith('/api/v1/files/upload/')) {
    return next();
  }

  const headerSite = c.req.header('x-heopress-site');
  if (headerSite) {
    // Req 19.2: shape-check the explicit header before it becomes context.
    // 400 (not 404) — this is a client-supplied header, not a resource probe.
    if (!isValidSiteId(headerSite)) {
      return c.json(
        {
          errors: [
            {
              code: 'TENANT_INVALID',
              message: 'X-HeoPress-Site header has an invalid format.',
            },
          ],
        },
        400,
      );
    }
    c.set('siteId', headerSite);
    return next();
  }

  // Strip the port (`acme.com:8787` → `acme.com`) and lowercase for the lookup.
  const host = (c.req.header('host') ?? '').split(':')[0]?.toLowerCase() ?? '';

  // (2) Exact host → site mapping (custom domains + free subdomains).
  const cache = c.get('runtime')?.cache;
  if (host && cache) {
    const byHost = await getHostMapping(cache, host);
    if (byHost) {
      c.set('siteId', byHost);
      return next();
    }
  }

  // (3) Legacy first-label subdomain mapping.
  const sub = host.split('.')[0];
  if (sub && sub !== 'api' && sub !== 'localhost' && sub !== '127') {
    // Resolve via CacheProvider: `site-domain:<subdomain>` -> siteId.
    if (cache) {
      const mapped = await cache.get<string>(`site-domain:${sub}`);
      if (mapped) {
        c.set('siteId', mapped);
        return next();
      }
    }
  }

  if (c.env.HEOPRESS_DEV_AUTH === 'true') {
    const fromQuery = c.req.query('site');
    if (fromQuery) {
      if (!isValidSiteId(fromQuery)) {
        return c.json(
          {
            errors: [
              {
                code: 'TENANT_INVALID',
                message: 'site query parameter has an invalid format.',
              },
            ],
          },
          400,
        );
      }
      c.set('siteId', fromQuery);
      return next();
    }
  }

  return c.json(
    { errors: [{ code: 'TENANT_REQUIRED', message: 'X-HeoPress-Site header is required.' }] },
    400,
  );
};
