import { IngestFetchError } from '../failure';
import { obj, ProviderError, readJson, str, type CrawlProvider } from './types';

/**
 * TinyFish (https://tinyfish.ai) web agent — `POST https://agent.tinyfish.ai/v1/automation/run`, `X-API-Key: <key>`.
 *
 * API shape (from the public quick-start, docs.tinyfish.ai; NOT verified against a live account — recorded in
 * `__tests__/fixtures/providers/tinyfish-*.json`):
 *   request  `{ url, goal }` — the goal asks for the page's article as JSON;
 *   response `{ run_id, status: 'COMPLETED' | 'FAILED', result: { title, author, published_at, language, markdown,
 *              final_url }, error }`
 * Assumptions: the synchronous `run` endpoint returns the agent's JSON in `result`; the agent returns Markdown only
 * (no HTML), and does not report the target's HTTP status — a refusal it reports in words
 * (`result.access_denied: true`, which the goal asks for) is treated as `access_denied`. Cost: the configured unit cost.
 */
const GOAL =
  'Open the page and return only JSON: {"title": string, "author": string|null, "published_at": string|null, ' +
  '"language": string|null, "final_url": string, "markdown": the full main article text as Markdown, ' +
  '"access_denied": true if the site refused access, required login, or showed a paywall or block page}. ' +
  'Do not log in, solve captchas or bypass any access control.';

export const tinyfishProvider: CrawlProvider = {
  manifest: { id: 'tinyfish', hosts: ['agent.tinyfish.ai'], credential: 'api_key', defaultUnitCostMicros: 1000 },
  async crawl(req, { http, config }) {
    if (!config.credential) throw new ProviderError('tinyfish', 'other', 'tinyfish: no API key configured for this site');
    const started = Date.now();
    const res = await http.request('https://agent.tinyfish.ai/v1/automation/run', {
      method: 'POST',
      headers: { 'x-api-key': config.credential, 'content-type': 'application/json' },
      body: JSON.stringify({ url: req.url, goal: GOAL }),
      timeoutMs: req.timeoutMs + 30_000,
      signal: req.signal,
    });
    const body = obj(await readJson('tinyfish', res));
    if (body.status !== 'COMPLETED') throw new ProviderError('tinyfish', 'network', `tinyfish: run ${String(body.status ?? 'failed').toLowerCase()}${str(body.error) ? ` — ${str(body.error)}` : ''}`);
    let result = body.result;
    if (typeof result === 'string') {
      try {
        result = JSON.parse(result) as unknown;
      } catch {
        throw new ProviderError('tinyfish', 'other', 'tinyfish: the result is not JSON');
      }
    }
    const r = obj(result);
    const finalUrl = str(r.final_url) ?? req.url;
    if (r.access_denied === true) {
      throw new IngestFetchError('access_denied', 'the target refused access (reported by tinyfish)', { finalUrl });
    }
    return {
      finalUrl,
      title: str(r.title) ?? '',
      markdown: str(r.markdown) ?? '',
      language: str(r.language) ?? null,
      publishedAt: str(r.published_at) ?? null,
      author: str(r.author) ?? null,
      metadata: { runId: body.run_id ?? null },
      provider: 'tinyfish',
      durationMs: Date.now() - started,
    };
  },
};
