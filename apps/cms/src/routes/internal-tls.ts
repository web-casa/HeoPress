/**
 * Certificate gate for the reverse proxy (HeoPress P04, spec
 * sites/domain-routing "证书签发前的域名校验").
 *
 *   GET /internal/tls/ask?domain=<hostname>
 *
 * Caddy's on-demand TLS asks here before it obtains a certificate for a name
 * it has never seen. Only an **active** domain — or the preview origin's host
 * (`HEOPRESS_PREVIEW_ORIGIN`, P06) — gets 200; anything else 404,
 * so no certificate is issued for unverified, disabled or unknown names.
 *
 * Reachable only from internal addresses: the TCP peer (never a forwarded
 * header) must be in HEOPRESS_TLS_ASK_ALLOW (CIDRs; default loopback and the
 * private ranges), otherwise 403. A request that came through a proxy
 * (`X-Forwarded-For`, `Forwarded`, `X-Real-IP`) is refused too: the reverse
 * proxy that sits in front of the public site has an internal address, and a
 * visitor's request it forwards must not pass as the proxy's own question
 * (the example Caddyfile also blocks `/internal/*` at the edge). Rate-limited per peer
 * (HEOPRESS_TLS_ASK_RATE per minute, default 120): 429 beyond it — a flood of
 * random names cannot turn into a flood of database lookups.
 */
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { siteDomains } from '@heopress/database';
import type { AppEnv } from '../env';
import { canonicalLoopback, isTrustedProxy } from '../modules/login-guard/ip-extract';

const DEFAULT_ALLOW = '127.0.0.0/8,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,fc00::/7';
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export const internalTlsRouter = new Hono<AppEnv>();

function peerAddress(c: { env: unknown }): string | null {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  const raw = env?.incoming?.socket?.remoteAddress;
  // `::ffff:10.0.0.5` → `10.0.0.5`, loopback forms unified.
  return raw ? canonicalLoopback(raw.replace(/^::ffff:/, '')) : null;
}

internalTlsRouter.get('/ask', async (c) => {
  const env = c.env as unknown as Record<string, string | undefined>;
  const peer = peerAddress(c);
  const allow = env.HEOPRESS_TLS_ASK_ALLOW?.trim() || process.env.HEOPRESS_TLS_ASK_ALLOW?.trim() || DEFAULT_ALLOW;
  const forwarded = ['x-forwarded-for', 'forwarded', 'x-real-ip'].some((h) => c.req.header(h) !== undefined);
  if (!peer || !isTrustedProxy(peer, allow) || forwarded) {
    return c.json({ errors: [{ code: 'FORBIDDEN', message: 'Internal endpoint.' }] }, 403);
  }

  const limiter = c.get('runtime')?.rateLimiter;
  const perMinute = Number(env.HEOPRESS_TLS_ASK_RATE ?? process.env.HEOPRESS_TLS_ASK_RATE ?? 120);
  if (limiter && perMinute > 0) {
    const verdict = await limiter.consume(`tls-ask:${peer}`, perMinute, 60);
    if (!verdict.allowed) {
      c.header('Retry-After', String(Math.max(1, verdict.resetAt - Math.floor(Date.now() / 1000))));
      return c.json({ errors: [{ code: 'RATE_LIMITED', message: 'Too many requests.' }] }, 429);
    }
  }

  const domain = (c.req.query('domain') ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (!HOSTNAME.test(domain) || domain.length > 253) {
    return c.json({ errors: [{ code: 'VALIDATION', message: 'domain must be a hostname.' }] }, 400);
  }
  // The preview origin (HeoPress P06, design R17): served by the rendering service like a site's domain.
  const previewOrigin = env.HEOPRESS_PREVIEW_ORIGIN?.trim() || process.env.HEOPRESS_PREVIEW_ORIGIN?.trim();
  if (previewOrigin) {
    try {
      if (new URL(previewOrigin).hostname === domain) return c.text('ok', 200);
    } catch {
      // Not a URL: no preview origin.
    }
  }
  const [row] = await c
    .get('db')
    .select({ id: siteDomains.id })
    .from(siteDomains)
    .where(and(eq(siteDomains.hostname, domain), eq(siteDomains.status, 'active')))
    .limit(1);
  return row ? c.text('ok', 200) : c.text('unknown domain', 404);
});
