import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { outboundBlockOf, parseTrustedEndpoints, type outboundFetch } from '@heopress/runtime/node';
import { classifyFetchFailure, IngestFetchError } from '../failure';
import { createProviderHttp } from '../providers/http';
import { CRAWL_PROVIDERS } from '../providers/registry';
import { extractCrawlResult, markdownToHtml } from '../providers/result';
import { assertPublicTarget } from '../providers/target';
import { ProviderError, type CrawlRequest, type ProviderConfig, type ProviderId } from '../providers/types';

/**
 * Contract tests of the four crawl services against recorded responses (HeoPress P08 tasks 3.1, 3.2, 3.6). No
 * network: the transport under the manifest check is replaced by a recorder that answers with the fixture.
 */

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', 'providers', name), 'utf-8');
const TARGET = 'https://news.example.com/harbour';
const req: CrawlRequest = { url: TARGET, userAgent: 'HeoPressBot/1.0 (+https://example.com/bot)', timeoutMs: 30_000 };

interface Sent {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  purpose?: string;
}

function recorder(body: string, status = 200, headers: Record<string, string> = {}) {
  const sent: Sent[] = [];
  const transport = vi.fn(async (url: string | URL, init: Parameters<typeof outboundFetch>[1] = {}) => {
    sent.push({
      url: String(url),
      method: init.method,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>,
      purpose: init.purpose,
    });
    return new Response(body, { status, headers: { 'content-type': 'application/json', ...headers } });
  });
  return { sent, transport: transport as unknown as typeof outboundFetch, spy: transport };
}

async function crawl(id: ProviderId, config: ProviderConfig, body: string, status = 200, headers: Record<string, string> = {}, env: Record<string, string> = {}) {
  const rec = recorder(body, status, headers);
  const p = CRAWL_PROVIDERS[id];
  const http = createProviderHttp(p.manifest, config, { env, trusted: parseTrustedEndpoints(''), transport: rec.transport });
  const run = p.crawl(req, { http, config });
  return { run, rec };
}

describe('Firecrawl contract', () => {
  const config = { credential: 'fc-test-key', options: {} };
  it('sends the documented scrape request and maps the response', async () => {
    const { run, rec } = await crawl('firecrawl', config, fixture('firecrawl-success.json'));
    const r = await run;
    expect(rec.sent[0]).toMatchObject({ url: 'https://api.firecrawl.dev/v1/scrape', method: 'POST', purpose: 'service' });
    expect(rec.sent[0]!.headers.authorization).toBe('Bearer fc-test-key');
    expect(rec.sent[0]!.body).toMatchObject({ url: TARGET, formats: ['rawHtml', 'markdown'] });
    expect(r).toMatchObject({ provider: 'firecrawl', finalUrl: 'https://news.example.com/harbour?ref=1', title: 'Harbour season', language: 'en', targetStatus: 200 });
    expect(r.html).toContain('<article>');
  });
  it('a 403 the target answered is access_denied (terminal)', async () => {
    const { run } = await crawl('firecrawl', config, fixture('firecrawl-target-403.json'));
    const err = await run.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IngestFetchError);
    expect(classifyFetchFailure(err)).toEqual({ category: 'access_denied', terminal: true });
  });
  it('402 from the service is the service out of quota (not terminal)', async () => {
    const { run } = await crawl('firecrawl', config, fixture('firecrawl-402.json'), 402);
    const err = await run.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).category).toBe('quota');
  });
});

describe('Crawl4AI contract', () => {
  it('posts to the configured endpoint and maps the result', async () => {
    const { run, rec } = await crawl('crawl4ai', { credential: null, options: { endpoint: 'https://crawl4ai.example.com' } }, fixture('crawl4ai-success.json'));
    const r = await run;
    expect(rec.sent[0]!.url).toBe('https://crawl4ai.example.com/crawl');
    expect(rec.sent[0]!.headers.authorization).toBeUndefined();
    expect(rec.sent[0]!.body).toMatchObject({ urls: [TARGET], crawler_config: { params: { check_robots_txt: true } } });
    expect(r).toMatchObject({ provider: 'crawl4ai', title: 'Harbour season', author: 'Jane Doe', targetStatus: 200 });
    expect(r.markdown).toContain('# Harbour season');
  });
  it('451 from the target is access_denied', async () => {
    const { run } = await crawl('crawl4ai', { credential: 'jwt', options: { endpoint: 'https://crawl4ai.example.com' } }, fixture('crawl4ai-target-451.json'));
    expect(classifyFetchFailure(await run.catch((e: unknown) => e)).category).toBe('access_denied');
  });
  it('without a site endpoint uses the instance endpoint, trusted for Crawl4AI only (compose profile)', async () => {
    const rec = recorder(fixture('crawl4ai-success.json'));
    const p = CRAWL_PROVIDERS.crawl4ai;
    const config = { credential: null, options: {} };
    const http = createProviderHttp(p.manifest, config, { env: { HEOPRESS_CRAWL4AI_ENDPOINT: 'http://crawl4ai:11235' }, trusted: parseTrustedEndpoints(''), transport: rec.transport });
    await p.crawl(req, { http, config });
    expect(rec.sent[0]!.url).toBe('http://crawl4ai:11235/crawl');
    const trusted = (rec.spy.mock.calls[0]![1] as { trusted: { origins: ReadonlySet<string> } }).trusted;
    expect([...trusted.origins]).toEqual(['http://crawl4ai:11235']);
    // Firecrawl does not inherit that trust.
    const rec2 = recorder(fixture('firecrawl-success.json'));
    const f = createProviderHttp(CRAWL_PROVIDERS.firecrawl.manifest, { credential: 'k', options: {} }, { env: { HEOPRESS_CRAWL4AI_ENDPOINT: 'http://crawl4ai:11235' }, trusted: parseTrustedEndpoints(''), transport: rec2.transport });
    await f.request('https://api.firecrawl.dev/v1/scrape', { method: 'POST', timeoutMs: 1000 });
    expect([...(rec2.spy.mock.calls[0]![1] as { trusted: { origins: ReadonlySet<string> } }).trusted.origins]).toEqual([]);
  });
});

describe('Cloudflare Browser Run contract', () => {
  const config = { credential: 'cf-token', options: { accountId: '0123456789abcdef0123456789abcdef' } };
  it('posts to the account content endpoint and costs the browser time', async () => {
    const { run, rec } = await crawl('cloudflare', config, fixture('cloudflare-success.json'), 200, { 'x-browser-ms-used': '4000' });
    const r = await run;
    expect(rec.sent[0]!.url).toBe('https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/browser-rendering/content');
    expect(rec.sent[0]!.headers.authorization).toBe('Bearer cf-token');
    expect(rec.sent[0]!.body).toMatchObject({ url: TARGET, userAgent: req.userAgent });
    expect(r).toMatchObject({ provider: 'cloudflare', finalUrl: TARGET, cost: 100 });
    expect(r.html).toContain('Harbour season');
  });
  it('an API error is a service failure', async () => {
    const { run } = await crawl('cloudflare', config, fixture('cloudflare-error.json'), 403);
    const err = await run.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(classifyFetchFailure(err).terminal).toBe(false);
  });
  it('refuses an account id that is not one', async () => {
    const { run, rec } = await crawl('cloudflare', { credential: 'x', options: { accountId: '../../zones' } }, fixture('cloudflare-success.json'));
    await expect(run).rejects.toBeInstanceOf(ProviderError);
    expect(rec.sent).toHaveLength(0);
  });
});

describe('TinyFish contract', () => {
  const config = { credential: 'tf-key', options: {} };
  it('runs the agent with the documented request and maps the JSON result', async () => {
    const { run, rec } = await crawl('tinyfish', config, fixture('tinyfish-success.json'));
    const r = await run;
    expect(rec.sent[0]!.url).toBe('https://agent.tinyfish.ai/v1/automation/run');
    expect(rec.sent[0]!.headers['x-api-key']).toBe('tf-key');
    expect(String(rec.sent[0]!.body.goal)).toMatch(/Do not log in/);
    expect(r).toMatchObject({ provider: 'tinyfish', title: 'Harbour season', publishedAt: '2026-09-01T08:00:00Z' });
    expect(r.html).toBeUndefined();
  });
  it('a refusal the agent reports is access_denied', async () => {
    const { run } = await crawl('tinyfish', config, fixture('tinyfish-denied.json'));
    expect(classifyFetchFailure(await run.catch((e: unknown) => e))).toEqual({ category: 'access_denied', terminal: true });
  });
});

describe('provider output goes through the native extraction', () => {
  it('HTML output: hidden content and scripts removed, quality-checked', async () => {
    const { run } = await crawl('firecrawl', { credential: 'k', options: {} }, fixture('firecrawl-success.json'));
    const { extracted, page } = extractCrawlResult(await run);
    expect(extracted.bodyHtml).not.toMatch(/<script|Ignore previous instructions/);
    expect(extracted.hiddenContent.length).toBeGreaterThan(0);
    expect(extracted.ruleVersion).toBe('native-1+firecrawl');
    expect(page.body.toString()).toContain('Harbour season');
  });
  it('Markdown-only output: escaped, sanitised, quality-checked', async () => {
    const { run } = await crawl('tinyfish', { credential: 'k', options: {} }, fixture('tinyfish-success.json'));
    const { extracted } = extractCrawlResult(await run);
    expect(extracted.title).toBe('Harbour season');
    expect(extracted.bodyHtml).not.toMatch(/<script|href="javascript/);
    expect(extracted.bodyHtml).toContain('href="https://news.example.com/report"');
    expect(extracted.author).toBe('Jane Doe');
  });
  it('too little text fails the quality check as extraction (next service may try)', () => {
    expect(() => extractCrawlResult({ finalUrl: TARGET, title: 'Home', markdown: '[a](https://example.com/a)', metadata: {}, provider: 'tinyfish', durationMs: 1 })).toThrow(IngestFetchError);
  });
  it('markdownToHtml escapes raw HTML', () => {
    expect(markdownToHtml('<img src=x onerror=alert(1)>')).toBe('<p>&lt;img src=x onerror=alert(1)&gt;</p>');
  });
});

describe('the manifest is the network allow-list (task 3.1)', () => {
  it('a host the manifest does not declare is refused before anything is sent', async () => {
    const rec = recorder('{}');
    const http = createProviderHttp(CRAWL_PROVIDERS.firecrawl.manifest, { credential: 'k', options: {} }, { trusted: parseTrustedEndpoints(''), transport: rec.transport });
    for (const url of ['https://evil.example.net/steal', 'http://api.firecrawl.dev/v1/scrape', 'https://api.firecrawl.dev.evil.example/x', 'http://169.254.169.254/latest/meta-data']) {
      const err = await http.request(url, { method: 'GET', timeoutMs: 1000 }).catch((e: unknown) => e);
      expect(outboundBlockOf(err), url).not.toBeNull();
    }
    expect(rec.sent).toHaveLength(0);
  });
  it('a site-configured internal endpoint is not trusted (only the instance owner can list one)', async () => {
    const http = createProviderHttp(CRAWL_PROVIDERS.crawl4ai.manifest, { credential: null, options: { endpoint: 'http://10.0.0.5:11235' } }, { env: {}, trusted: parseTrustedEndpoints('') });
    const err = await http.request('http://10.0.0.5:11235/crawl', { method: 'POST', timeoutMs: 1000 }).catch((e: unknown) => e);
    expect(outboundBlockOf(err)).not.toBeNull();
  });
});

describe('the target is checked before a service gets it (task 3.6)', () => {
  const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];
  it.each([
    ['http://10.0.0.1/admin'],
    ['http://127.0.0.1:5432/'],
    ['http://169.254.169.254/latest/meta-data/'],
    ['http://localhost/'],
    ['http://[::1]/'],
    ['http://user:pw@news.example.com/'],
    ['file:///etc/passwd'],
  ])('%s is blocked', async (url) => {
    const err = await assertPublicTarget(url, { resolve: publicDns }).catch((e: unknown) => e);
    expect(classifyFetchFailure(err)).toEqual({ category: 'blocked', terminal: true });
  });
  it('a public name that resolves to an internal address is blocked', async () => {
    const err = await assertPublicTarget('https://rebind.example.com/', { resolve: async () => [{ address: '93.184.216.34', family: 4 }, { address: '192.168.1.10', family: 4 }] }).catch((e: unknown) => e);
    expect(classifyFetchFailure(err).category).toBe('blocked');
  });
  it('a public target passes', async () => {
    await expect(assertPublicTarget(TARGET, { resolve: publicDns })).resolves.toBeInstanceOf(URL);
  });
});
