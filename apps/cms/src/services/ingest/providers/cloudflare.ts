import { obj, ProviderError, readJson, str, type CrawlProvider } from './types';

/**
 * Cloudflare Browser Run (Browser Rendering REST API) — `POST https://api.cloudflare.com/client/v4/accounts/<account
 * id>/browser-rendering/content`, `Authorization: Bearer <API token with "Browser Rendering - Edit">`.
 *
 * API shape (from developers.cloudflare.com/browser-rendering/rest-api/content-endpoint/; recorded in
 * `__tests__/fixtures/providers/cloudflare-*.json`):
 *   request  `{ url, userAgent, gotoOptions: { waitUntil: 'networkidle2', timeout } }`
 *   response `{ success: true, result: "<html>…</html>", errors: [], messages: [] }`
 *   header   `X-Browser-Ms-Used`: browser time billed for the request.
 * Assumptions: the endpoint does not report the target's HTTP status or final URL — the final URL is the requested
 * one and a denial page is caught by the quality check, not as `access_denied`; cost = browser time at
 * $0.09 per browser-hour (`X-Browser-Ms-Used` × 0.025 micro-USD), else the configured unit cost.
 */
const MICROS_PER_BROWSER_MS = 0.025;

export const cloudflareProvider: CrawlProvider = {
  manifest: { id: 'cloudflare', hosts: ['api.cloudflare.com'], credential: 'api_token', requiredOptions: ['accountId'], defaultUnitCostMicros: 500 },
  async crawl(req, { http, config }) {
    const account = config.options.accountId?.trim();
    if (!config.credential || !account) throw new ProviderError('cloudflare', 'other', 'cloudflare: API token or account id not configured for this site');
    if (!/^[0-9a-f]{32}$/i.test(account)) throw new ProviderError('cloudflare', 'other', 'cloudflare: the account id must be 32 hexadecimal characters');
    const started = Date.now();
    const res = await http.request(`https://api.cloudflare.com/client/v4/accounts/${account}/browser-rendering/content`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.credential}`, 'content-type': 'application/json' },
      body: JSON.stringify({ url: req.url, userAgent: req.userAgent, gotoOptions: { waitUntil: 'networkidle2', timeout: req.timeoutMs } }),
      timeoutMs: req.timeoutMs + 5000,
      signal: req.signal,
    });
    const browserMs = Number(res.headers.get('x-browser-ms-used'));
    const body = obj(await readJson('cloudflare', res));
    const html = str(body.result);
    if (body.success !== true || !html) {
      const first = Array.isArray(body.errors) ? obj(body.errors[0]) : {};
      throw new ProviderError('cloudflare', 'network', `cloudflare: ${str(first.message) ?? 'rendering failed'}`);
    }
    return {
      finalUrl: req.url,
      title: '',
      markdown: '',
      html,
      metadata: Number.isFinite(browserMs) && browserMs > 0 ? { browserMsUsed: browserMs } : {},
      provider: 'cloudflare',
      durationMs: Date.now() - started,
      ...(Number.isFinite(browserMs) && browserMs > 0 ? { cost: Math.ceil(browserMs * MICROS_PER_BROWSER_MS) } : {}),
    };
  },
};
