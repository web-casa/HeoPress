import { classifyHttpStatus, IngestFetchError } from '../failure';
import { obj, ProviderError, readJson, str, type CrawlProvider } from './types';

/**
 * Crawl4AI (https://github.com/unclecode/crawl4ai, Apache-2.0) — self-hosted (the `crawl4ai` compose profile,
 * `HEOPRESS_CRAWL4AI_ENDPOINT`) or another deployment the site names. `POST <endpoint>/crawl`, optional
 * `Authorization: Bearer <token>` when the server has JWT security on.
 *
 * API shape (from the Docker server's API docs, docs.crawl4ai.com/core/self-hosting/; recorded in
 * `__tests__/fixtures/providers/crawl4ai-*.json`):
 *   request  `{ urls: [url], browser_config: { type: 'BrowserConfig', params: { headless: true, user_agent } },
 *              crawler_config: { type: 'CrawlerRunConfig', params: { cache_mode: 'bypass', check_robots_txt: true } } }`
 *   response `{ success: true, results: [{ url, html, success, status_code, error_message, redirected_url,
 *              markdown: string | { raw_markdown }, metadata: { title, author?, … } }] }`
 * Assumptions: `status_code` is the target's status; `redirected_url` its final URL. Cost: none (self-hosted), the
 * configured unit cost otherwise.
 */
export const crawl4aiProvider: CrawlProvider = {
  manifest: { id: 'crawl4ai', hosts: [], configurableEndpoint: true, credential: 'optional_token', defaultUnitCostMicros: 0 },
  async crawl(req, { http, config }) {
    const endpoint = http.endpoint;
    if (!endpoint) throw new ProviderError('crawl4ai', 'other', 'crawl4ai: no endpoint configured (set HEOPRESS_CRAWL4AI_ENDPOINT or the site endpoint)');
    const started = Date.now();
    const res = await http.request(`${endpoint}/crawl`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(config.credential ? { authorization: `Bearer ${config.credential}` } : {}) },
      body: JSON.stringify({
        urls: [req.url],
        browser_config: { type: 'BrowserConfig', params: { headless: true, user_agent: req.userAgent } },
        crawler_config: { type: 'CrawlerRunConfig', params: { cache_mode: 'bypass', check_robots_txt: true, page_timeout: req.timeoutMs } },
      }),
      timeoutMs: req.timeoutMs + 10_000,
      signal: req.signal,
    });
    const body = obj(await readJson('crawl4ai', res));
    const result = obj(Array.isArray(body.results) ? body.results[0] : undefined);
    const finalUrl = str(result.redirected_url) ?? str(result.url) ?? req.url;
    const status = typeof result.status_code === 'number' ? result.status_code : undefined;
    const verdict = status === undefined ? null : classifyHttpStatus(status);
    if (verdict) throw new IngestFetchError(verdict.category, `HTTP ${status} from the target (via crawl4ai)`, { httpStatus: status, finalUrl });
    const error = str(result.error_message);
    if (error && /robots\.txt/i.test(error)) throw new IngestFetchError('access_denied', `crawl4ai: ${error.slice(0, 200)}`, { finalUrl });
    if (body.success !== true || result.success !== true) throw new ProviderError('crawl4ai', 'network', `crawl4ai: ${error?.slice(0, 200) ?? 'crawl failed'}`);
    const md = result.markdown;
    const meta = obj(result.metadata);
    return {
      finalUrl,
      title: str(meta.title) ?? '',
      markdown: typeof md === 'string' ? md : (str(obj(md).raw_markdown) ?? ''),
      html: str(result.html),
      author: str(meta.author) ?? null,
      targetStatus: status,
      metadata: meta,
      provider: 'crawl4ai',
      durationMs: Date.now() - started,
    };
  },
};
