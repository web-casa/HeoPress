/**
 * `/_ext/<plugin>/<endpoint>` — plugin public endpoints (HeoPress P12 task 3.3). Public and unauthenticated on purpose:
 * a form is checked against the site's approved origins, a callback by its signature (extensions/runtime/endpoints.ts).
 * No session, cookie or API key is read or passed on. The body is read with a hard ceiling before anything else.
 */
import { Hono, type Context } from 'hono';
import { CALLBACK_HEADERS, ENDPOINT_LIMITS } from '@heopress/contracts/extensions';
import type { AppEnv } from '../env';
import { canonicalLoopback, extractClientIp, isTrustedProxy } from '../modules/login-guard/ip-extract';
import { handlePluginEndpoint } from '../extensions/runtime/endpoints';
import { PluginHost } from '../extensions/runtime/plugin-host';
import { queueJobEnqueuer } from '../extensions/runtime/jobs';

export const pluginEndpointsRouter = new Hono<AppEnv>();

/** `Host`, or a trusted proxy's `X-Forwarded-Host` (the edge forwards a site domain's `/_ext/` here). */
function requestHost(c: Context<AppEnv>): string | null {
  const env = c.env as unknown as { incoming?: { socket?: { remoteAddress?: string } } } & Record<string, unknown>;
  const peer = env?.incoming?.socket?.remoteAddress;
  const trusted = (env?.HEOPRESS_TRUSTED_PROXIES as string | undefined) ?? process.env.HEOPRESS_TRUSTED_PROXIES;
  const fromProxy =
    peer && isTrustedProxy(canonicalLoopback(peer.replace(/^::ffff:/, '')), trusted) ? c.req.header('x-forwarded-host')?.split(',').pop() : undefined;
  const host = (fromProxy ?? c.req.header('host') ?? '').trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  return host || null;
}

/** Read the body up to `max` bytes; null when it is longer. */
async function boundedBody(req: Request, max: number): Promise<string | null> {
  const declared = Number(req.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > max) return null;
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

pluginEndpointsRouter.on(['POST', 'PUT', 'GET', 'DELETE', 'PATCH'], '/:plugin/:endpoint', async (c) => {
  const body = await boundedBody(c.req.raw, ENDPOINT_LIMITS.bodyBytes.max);
  if (body === null) return c.json({ errors: [{ code: 'BODY_TOO_LARGE', message: 'The body is too large.' }] }, 413);
  const runtime = c.get('runtime');
  const db = c.get('db');
  const host = new PluginHost({ db, env: c.env as unknown as Record<string, unknown>, enqueueJob: queueJobEnqueuer(runtime?.queue) });
  const res = await handlePluginEndpoint(
    { db, host, keys: runtime?.keys, rateLimiter: runtime?.rateLimiter },
    {
      host: requestHost(c),
      siteParam: c.req.query('site') ?? null,
      plugin: c.req.param('plugin'),
      endpoint: c.req.param('endpoint'),
      method: c.req.method,
      headers: {
        origin: c.req.header('origin') ?? null,
        referer: c.req.header('referer') ?? null,
        contentType: c.req.header('content-type') ?? null,
        timestamp: c.req.header(CALLBACK_HEADERS.timestamp) ?? null,
        nonce: c.req.header(CALLBACK_HEADERS.nonce) ?? null,
        signature: c.req.header(CALLBACK_HEADERS.signature) ?? null,
      },
      body,
      clientIp: extractClientIp(c),
    },
  );
  for (const [k, v] of Object.entries(res.headers ?? {})) c.header(k, v);
  c.header('Cache-Control', 'no-store');
  return c.json(res.body as Record<string, unknown>, res.status as 200);
});
