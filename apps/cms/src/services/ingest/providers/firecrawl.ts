import { classifyHttpStatus, IngestFetchError } from '../failure';
import { obj, ProviderError, readJson, str, type CrawlProvider } from './types';

/**
 * Firecrawl (https://firecrawl.dev) — `POST https://api.firecrawl.dev/v1/scrape`, `Authorization: Bearer <key>`.
 *
 * API shape (from the public API reference, docs.firecrawl.dev/api-reference/endpoint/scrape; recorded in
 * `__tests__/fixtures/providers/firecrawl-*.json`):
 *   request  `{ url, formats: ['rawHtml', 'markdown'], onlyMainContent: false, timeout }`
 *   response `{ success: true, data: { markdown, rawHtml, metadata: { title, language, sourceURL, url, statusCode, error? } } }`
 *   errors   HTTP 402 (out of credits), 429 (rate limit), 408 (timeout), 5xx; body `{ success: false, error }`.
 * Assumptions: `metadata.statusCode` is the target's status and `metadata.url` its final URL (falls back to
 * `sourceURL`); one scrape costs one credit — the estimate is the configured unit cost.
 */
export const firecrawlProvider: CrawlProvider = {
  manifest: { id: 'firecrawl', hosts: ['api.firecrawl.dev'], credential: 'api_key', defaultUnitCostMicros: 1000 },
  async crawl(req, { http, config }) {
    if (!config.credential) throw new ProviderError('firecrawl', 'other', 'firecrawl: no API key configured for this site');
    const started = Date.now();
    const res = await http.request('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: { authorization: `Bearer ${config.credential}`, 'content-type': 'application/json' },
      body: JSON.stringify({ url: req.url, formats: ['rawHtml', 'markdown'], onlyMainContent: false, timeout: req.timeoutMs }),
      timeoutMs: req.timeoutMs + 5000,
      signal: req.signal,
    });
    const body = obj(await readJson('firecrawl', res));
    if (body.success !== true) throw new ProviderError('firecrawl', 'network', `firecrawl: ${str(body.error) ?? 'scrape failed'}`);
    const data = obj(body.data);
    const meta = obj(data.metadata);
    const finalUrl = str(meta.url) ?? str(meta.sourceURL) ?? req.url;
    const status = typeof meta.statusCode === 'number' ? meta.statusCode : undefined;
    const verdict = status === undefined ? null : classifyHttpStatus(status);
    if (verdict) throw new IngestFetchError(verdict.category, `HTTP ${status} from the target (via firecrawl)`, { httpStatus: status, finalUrl });
    return {
      finalUrl,
      title: str(meta.title) ?? '',
      markdown: str(data.markdown) ?? '',
      html: str(data.rawHtml) ?? str(data.html),
      language: str(meta.language) ?? null,
      targetStatus: status,
      metadata: meta,
      provider: 'firecrawl',
      durationMs: Date.now() - started,
    };
  },
};
