/**
 * Rendering-layer middleware (HeoPress P04, spec sites/domain-routing): the
 * site comes from the public host (services/domains/public-host.ts). An
 * unknown, pending or disabled host is 404 — no default site; a plain alias
 * is 301'd straight to the final address on the primary domain (HeoPress
 * P05: language prefix, slug redirects and the trailing slash resolved in
 * the same step, so one 301 — services/site-network/public-path.ts).
 */
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../env';
import { canonicalLoopback, isTrustedProxy } from '../modules/login-guard/ip-extract';
import { resolvePublicHost } from '../services/domains/public-host';
import { resolvePublicPath } from '../services/site-network/public-path';

/** `Host` (or a trusted proxy's `X-Forwarded-Host`), port and trailing dot removed, lowercase. */
function requestHost(c: Parameters<MiddlewareHandler<AppEnv>>[0]): string | null {
  const env = c.env as unknown as { incoming?: { socket?: { remoteAddress?: string } } } & Record<string, unknown>;
  const peer = env?.incoming?.socket?.remoteAddress;
  const trusted = (env?.HEOPRESS_TRUSTED_PROXIES as string | undefined) ?? process.env.HEOPRESS_TRUSTED_PROXIES;
  const fromProxy =
    peer && isTrustedProxy(canonicalLoopback(peer.replace(/^::ffff:/, '')), trusted)
      ? c.req.header('x-forwarded-host')?.split(',')[0]
      : undefined;
  const raw = (fromProxy ?? c.req.header('host') ?? '').trim().toLowerCase();
  const host = raw.replace(/:\d+$/, '').replace(/\.$/, '');
  return host || null;
}

/** Rendering-layer middleware: resolve the site from the host, or 404 / 301. */
export const withPublicSite = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  const host = requestHost(c);
  const resolved = host ? await resolvePublicHost(c.get('db'), host) : null;
  if (!resolved) return c.text('Not found', 404);
  if (!resolved.isPrimary && !resolved.entryLocale && resolved.primaryHostname) {
    const url = new URL(c.req.url);
    const final = await resolvePublicPath(c.get('db'), { host: host!, path: url.pathname, query: url.search.slice(1) });
    if (final.kind === 'redirect') return c.redirect(final.location, 301);
    return c.text('Not found', 404);
  }
  c.set('siteId', resolved.siteId);
  c.set('publicHost', resolved);
  await next();
};
