/**
 * Plugin public endpoints (HeoPress P12 task 3.3, spec extensions/runtime-extensions "插件公开端点").
 *
 * Served under the reserved prefix `/_ext/<plugin>/<endpoint>` on the site's own domains (the edge forwards the prefix
 * to the CMS) and on the CMS's public address for statically deployed sites (`?site=<site id>`). Two kinds:
 *
 * - **form** — a browser form (subscribe, report an error). The request's `Origin` (or, without it, the origin of its
 *   `Referer`) must be one of the site's approved origins: its active domains, its configured site URL and the
 *   production URLs of its static deployment targets. A request with neither header is not trusted.
 * - **callback** — a server notification (an order system). Signed with the plugin's own secret on the site:
 *   `X-HeoPress-Signature: v1=<hex HMAC-SHA256(secret, "<timestamp>.<nonce>.<body>")>` with `X-HeoPress-Timestamp`
 *   (Unix seconds, within 5 minutes) and a single-use `X-HeoPress-Nonce`; a replay is refused. The browser origin plays
 *   no part.
 *
 * Both are rate-limited per client address (429) and bounded in body size (413). The handler runs with the site's
 * plugin context only — no admin interface, no request credentials, no other site's data.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, lt } from 'drizzle-orm';
import { deploymentTargets, pluginEndpointKeys, pluginEndpointNonces, siteDomains, sites, type Database } from '@heopress/database';
import { ENDPOINT_LIMITS, callbackSigningInput, isValidNonce, originOf } from '@heopress/contracts/extensions';
import type { KeyProvider, RateLimiterProvider } from '@heopress/runtime';
import { formatSafeError } from '@heopress/contracts/utils';
import { openSecret, sealSecret } from '../../services/crypto/secret-vault';
import { resolvePublicHost } from '../../services/domains/public-host';
import { runSiteTransaction } from '../../services/rls-transaction';
import { RunLimitError, withRunScope } from './run-scope';
import { grantsPoint, isRunnable, type PluginHost } from './plugin-host';

/** The origins a site's browser forms may post from. */
async function approvedOrigins(db: Database, siteId: string): Promise<Set<string>> {
  const out = new Set<string>();
  const domains = await db
    .select({ hostname: siteDomains.hostname })
    .from(siteDomains)
    .where(and(eq(siteDomains.siteId, siteId), eq(siteDomains.status, 'active')));
  for (const d of domains) out.add(`https://${d.hostname.toLowerCase()}`);
  const [site] = await db.select({ siteUrl: sites.siteUrl }).from(sites).where(eq(sites.id, siteId)).limit(1);
  const own = originOf(site?.siteUrl);
  if (own) out.add(own);
  // Static deployments (Cloudflare Pages, Vercel, Netlify): their production addresses.
  const targets = await db
    .select({ url: deploymentTargets.productionUrl })
    .from(deploymentTargets)
    .where(and(eq(deploymentTargets.siteId, siteId), eq(deploymentTargets.status, 'active')));
  for (const t of targets) {
    const o = originOf(t.url);
    if (o) out.add(o);
  }
  return out;
}

const aad = (siteId: string, plugin: string) => `plugin-callback|${siteId}|${plugin}`;

/** Create (or replace) the plugin's callback secret on the site; the plain secret is returned once, never stored. */
export async function rotateCallbackSecret(db: Database, keys: KeyProvider, siteId: string, plugin: string): Promise<string> {
  const secret = randomBytes(32).toString('hex');
  const sealed = await sealSecret(keys, secret, aad(siteId, plugin));
  await runSiteTransaction(db, siteId, (tx) =>
    tx
      .insert(pluginEndpointKeys)
      .values({ siteId, extensionName: plugin, secretCiphertext: sealed.ciphertext, keyId: sealed.keyId })
      .onConflictDoUpdate({
        target: [pluginEndpointKeys.siteId, pluginEndpointKeys.extensionName],
        set: { secretCiphertext: sealed.ciphertext, keyId: sealed.keyId, createdAt: new Date() },
      }),
  );
  return secret;
}

async function callbackSecret(db: Database, keys: KeyProvider, siteId: string, plugin: string): Promise<string | null> {
  const [row] = await db
    .select()
    .from(pluginEndpointKeys)
    .where(and(eq(pluginEndpointKeys.siteId, siteId), eq(pluginEndpointKeys.extensionName, plugin)))
    .limit(1);
  if (!row) return null;
  return openSecret(keys, row.secretCiphertext, aad(siteId, plugin));
}

/** `v1=<hex>` for a callback (what the sending server computes). */
export function signCallback(secret: string, timestamp: string, nonce: string, body: string): string {
  return `v1=${createHmac('sha256', secret).update(callbackSigningInput(timestamp, nonce, body)).digest('hex')}`;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export interface EndpointRequestInput {
  /** The request's host (trusted: the Host header, or a trusted proxy's forwarded host). */
  host: string | null;
  /** `?site=<id>` on the CMS's public address (statically deployed sites). */
  siteParam: string | null;
  plugin: string;
  endpoint: string;
  method: string;
  headers: {
    origin: string | null;
    referer: string | null;
    contentType: string | null;
    timestamp: string | null;
    nonce: string | null;
    signature: string | null;
  };
  /** The raw body (already bounded by the route at the ceiling). */
  body: string;
  clientIp: string | null;
}

export interface EndpointResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface EndpointGatewayDeps {
  db: Database;
  host: PluginHost;
  keys?: KeyProvider;
  rateLimiter?: RateLimiterProvider;
  now?: () => Date;
}

const err = (status: number, code: string, message: string, headers?: Record<string, string>): EndpointResponse => ({
  status,
  body: { errors: [{ code, message }] },
  ...(headers ? { headers } : {}),
});

function parseBody(contentType: string | null, body: string): { ok: true; value: unknown } | { ok: false } {
  if (!body) return { ok: true, value: {} };
  const type = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  if (type === 'application/json') {
    try {
      return { ok: true, value: JSON.parse(body) };
    } catch {
      return { ok: false };
    }
  }
  if (type === 'application/x-www-form-urlencoded' || type === '') {
    const out: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(body)) out[k] = v;
    return { ok: true, value: out };
  }
  return { ok: false };
}

/** Handle one request to a plugin endpoint. */
export async function handlePluginEndpoint(deps: EndpointGatewayDeps, req: EndpointRequestInput): Promise<EndpointResponse> {
  const notFound = () => err(404, 'NOT_FOUND', 'No such endpoint.');
  // The site: its own domain first; the explicit site only on a host that is no site's (the CMS's public address).
  let siteId: string | null = null;
  if (req.host) siteId = (await resolvePublicHost(deps.db, req.host))?.siteId ?? null;
  if (!siteId && req.siteParam && /^[A-Za-z0-9_-]{1,64}$/.test(req.siteParam)) {
    const [site] = await deps.db.select({ id: sites.id }).from(sites).where(eq(sites.id, req.siteParam)).limit(1);
    siteId = site?.id ?? null;
  }
  if (!siteId) return notFound();

  const row = await deps.host.row(siteId, req.plugin);
  if (!row || !isRunnable(row) || !grantsPoint(row, 'endpoints')) return notFound();
  const plugin = await deps.host.load(row);
  const endpoint = plugin?.endpoints.find((e) => e.name === req.endpoint);
  if (!plugin || !endpoint) return notFound();
  if (!endpoint.methods.includes(req.method.toUpperCase())) {
    return err(405, 'METHOD_NOT_ALLOWED', `Use ${endpoint.methods.join(', ')}.`, { Allow: endpoint.methods.join(', ') });
  }
  if (Buffer.byteLength(req.body, 'utf8') > endpoint.maxBodyBytes) {
    return err(413, 'BODY_TOO_LARGE', `The body is limited to ${endpoint.maxBodyBytes} bytes.`);
  }

  // Rate limit per client address and endpoint (fail closed when the limiter is unavailable).
  if (deps.rateLimiter) {
    try {
      const verdict = await deps.rateLimiter.consume(`plugin-endpoint:${siteId}:${req.plugin}:${req.endpoint}:${req.clientIp ?? 'unknown'}`, endpoint.ratePerMinute, 60);
      if (!verdict.allowed) {
        const retry = Math.max(1, verdict.resetAt - Math.ceil(Date.now() / 1000));
        return err(429, 'RATE_LIMITED', 'Too many requests.', { 'Retry-After': String(retry) });
      }
    } catch {
      return err(503, 'RATE_LIMIT_UNAVAILABLE', 'Try again later.', { 'Retry-After': '60' });
    }
  }

  let origin: string | null = null;
  if (endpoint.kind === 'form') {
    origin = originOf(req.headers.origin && req.headers.origin !== 'null' ? req.headers.origin : null) ?? originOf(req.headers.referer);
    if (!origin) return err(403, 'ORIGIN_REQUIRED', 'A form request must come from one of the site\'s pages.');
    if (!(await approvedOrigins(deps.db, siteId)).has(origin)) return err(403, 'ORIGIN_NOT_ALLOWED', 'This origin may not post to the site.');
  } else {
    const { timestamp, nonce, signature } = req.headers;
    if (!timestamp || !/^\d{1,12}$/.test(timestamp) || !isValidNonce(nonce) || !signature) {
      return err(401, 'SIGNATURE_REQUIRED', 'A callback is signed: timestamp, nonce and signature headers.');
    }
    const now = Math.floor((deps.now?.() ?? new Date()).getTime() / 1000);
    if (Math.abs(now - Number(timestamp)) > ENDPOINT_LIMITS.callbackToleranceSeconds) {
      return err(401, 'STALE_TIMESTAMP', 'The callback timestamp is outside the allowed window.');
    }
    const secret = deps.keys ? await callbackSecret(deps.db, deps.keys, siteId, req.plugin).catch(() => null) : null;
    if (!secret || !safeEqual(signCallback(secret, timestamp, nonce, req.body), signature)) {
      return err(401, 'SIGNATURE_INVALID', 'The callback signature does not match.');
    }
    // Single use: the nonce is recorded until its window has passed; a second use is a replay.
    const expiresAt = new Date((Number(timestamp) + ENDPOINT_LIMITS.callbackToleranceSeconds * 2) * 1000);
    const inserted = await runSiteTransaction(deps.db, siteId, async (tx) => {
      await tx.delete(pluginEndpointNonces).where(and(eq(pluginEndpointNonces.siteId, siteId), lt(pluginEndpointNonces.expiresAt, new Date())));
      return tx
        .insert(pluginEndpointNonces)
        .values({ siteId, extensionName: req.plugin, nonce, expiresAt })
        .onConflictDoNothing()
        .returning({ nonce: pluginEndpointNonces.nonce });
    });
    if (inserted.length === 0) return err(409, 'REPLAYED', 'This callback was already received.');
  }

  const parsed = parseBody(req.headers.contentType, req.body);
  if (!parsed.ok) return err(415, 'UNSUPPORTED_BODY', 'Send application/x-www-form-urlencoded or application/json.');

  try {
    const { value } = await withRunScope(
      { durationMs: endpoint.durationMs, maxRequests: endpoint.maxRequests, label: `endpoint ${req.plugin}/${req.endpoint}` },
      (scope) => endpoint.handle({ method: req.method.toUpperCase(), body: parsed.value, origin }, { siteId: siteId!, signal: scope.signal }),
    );
    const out = (value ?? {}) as { status?: unknown; body?: unknown };
    const status = typeof out.status === 'number' && out.status >= 200 && out.status < 500 ? Math.floor(out.status) : 200;
    // A verified form origin may read the answer (a simple cross-origin request from a static page).
    return { status, body: { data: out.body ?? null }, ...(origin ? { headers: { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } } : {}) };
  } catch (e) {
    if (e instanceof RunLimitError) return err(503, 'PLUGIN_LIMIT', 'The plugin did not finish in time.');
    console.error(`[plugin-endpoints] ${req.plugin}/${req.endpoint} on ${siteId}`, formatSafeError(e));
    return err(500, 'PLUGIN_ERROR', 'The plugin could not handle this request.');
  }
}
