import type { SiteSeoSettings } from '@heopress/contracts/schemas';

/**
 * Known crawlers by purpose (HeoPress P07 task 3.2; spec seo/crawl-discovery "按用途的 AI 爬虫策略"): the data a site's
 * crawler policy is decided against. Kept here as data and updated with releases; a site may add its own
 * (`settings.crawlers.custom`). Purposes:
 *
 *   - `training`: collects pages to train models;
 *   - `search`: builds an AI search index or answers from it;
 *   - `user-fetch`: fetches a page because a user asked an assistant to;
 *   - `search-engine`: an ordinary search engine — never affected by a purpose, only by a crawler's own override.
 *
 * `userAgent` is the product token robots.txt names (RFC 9309 §2.2.1); `source`, the operator's documentation.
 */

export type CrawlerPurpose = 'training' | 'search' | 'user-fetch' | 'search-engine';

export interface Crawler {
  /** Stable id (lower case): what a site's overrides name. */
  id: string;
  userAgent: string;
  operator: string;
  purpose: CrawlerPurpose;
  source: string | null;
}

const OPENAI = 'https://platform.openai.com/docs/bots';
const ANTHROPIC = 'https://support.anthropic.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler';
const GOOGLE = 'https://developers.google.com/search/docs/crawling-indexing/overview-google-crawlers';
const PERPLEXITY = 'https://docs.perplexity.ai/guides/bots';
const APPLE = 'https://support.apple.com/en-us/119829';
const META = 'https://developers.facebook.com/docs/sharing/webmasters/web-crawlers';

export const CRAWLERS: readonly Crawler[] = [
  { id: 'gptbot', userAgent: 'GPTBot', operator: 'OpenAI', purpose: 'training', source: OPENAI },
  { id: 'claudebot', userAgent: 'ClaudeBot', operator: 'Anthropic', purpose: 'training', source: ANTHROPIC },
  { id: 'ccbot', userAgent: 'CCBot', operator: 'Common Crawl', purpose: 'training', source: 'https://commoncrawl.org/ccbot' },
  { id: 'google-extended', userAgent: 'Google-Extended', operator: 'Google', purpose: 'training', source: GOOGLE },
  { id: 'applebot-extended', userAgent: 'Applebot-Extended', operator: 'Apple', purpose: 'training', source: APPLE },
  { id: 'meta-externalagent', userAgent: 'Meta-ExternalAgent', operator: 'Meta', purpose: 'training', source: META },
  { id: 'bytespider', userAgent: 'Bytespider', operator: 'ByteDance', purpose: 'training', source: null },
  { id: 'amazonbot', userAgent: 'Amazonbot', operator: 'Amazon', purpose: 'training', source: 'https://developer.amazon.com/amazonbot' },
  { id: 'oai-searchbot', userAgent: 'OAI-SearchBot', operator: 'OpenAI', purpose: 'search', source: OPENAI },
  { id: 'claude-searchbot', userAgent: 'Claude-SearchBot', operator: 'Anthropic', purpose: 'search', source: ANTHROPIC },
  { id: 'perplexitybot', userAgent: 'PerplexityBot', operator: 'Perplexity', purpose: 'search', source: PERPLEXITY },
  { id: 'duckassistbot', userAgent: 'DuckAssistBot', operator: 'DuckDuckGo', purpose: 'search', source: 'https://duckduckgo.com/duckduckgo-help-pages/results/duckassistbot' },
  { id: 'chatgpt-user', userAgent: 'ChatGPT-User', operator: 'OpenAI', purpose: 'user-fetch', source: OPENAI },
  { id: 'claude-user', userAgent: 'Claude-User', operator: 'Anthropic', purpose: 'user-fetch', source: ANTHROPIC },
  { id: 'perplexity-user', userAgent: 'Perplexity-User', operator: 'Perplexity', purpose: 'user-fetch', source: PERPLEXITY },
  { id: 'mistralai-user', userAgent: 'MistralAI-User', operator: 'Mistral AI', purpose: 'user-fetch', source: 'https://docs.mistral.ai/robots' },
  { id: 'meta-externalfetcher', userAgent: 'Meta-ExternalFetcher', operator: 'Meta', purpose: 'user-fetch', source: META },
  { id: 'googlebot', userAgent: 'Googlebot', operator: 'Google', purpose: 'search-engine', source: GOOGLE },
  { id: 'bingbot', userAgent: 'Bingbot', operator: 'Microsoft', purpose: 'search-engine', source: 'https://www.bing.com/webmasters/help/which-crawlers-does-bing-use-8c184ec0' },
  { id: 'applebot', userAgent: 'Applebot', operator: 'Apple', purpose: 'search-engine', source: APPLE },
  { id: 'duckduckbot', userAgent: 'DuckDuckBot', operator: 'DuckDuckGo', purpose: 'search-engine', source: 'https://duckduckgo.com/duckduckgo-help-pages/results/duckduckbot' },
  { id: 'baiduspider', userAgent: 'Baiduspider', operator: 'Baidu', purpose: 'search-engine', source: null },
  { id: 'yandexbot', userAgent: 'YandexBot', operator: 'Yandex', purpose: 'search-engine', source: 'https://yandex.com/support/webmaster/robot-workings/check-yandex-robots.html' },
];

/**
 * Why a site's own crawlers cannot stand (Codex review of batch 7), or null: an id or a product token the known list
 * already has (case-insensitively, as robots.txt matches tokens) — a custom "training" crawler named `Bingbot` would
 * otherwise keep an ordinary search engine out without its own override — or a token two of its own share.
 */
export function customCrawlerError(custom: SiteSeoSettings['crawlers']['custom']): string | null {
  const ids = new Set(CRAWLERS.map((c) => c.id));
  const tokens = new Set(CRAWLERS.map((c) => c.userAgent.toLowerCase()));
  for (const c of custom) {
    if (ids.has(c.id)) return `${c.id} is a known crawler's id`;
    const token = c.userAgent.toLowerCase();
    if (tokens.has(token)) return `${c.userAgent} is a known crawler or another custom crawler`;
    tokens.add(token);
  }
  return null;
}

/**
 * The site's crawlers: the known ones, then its own — those that clash with the list or with an earlier one of its
 * own (an id or a token, `customCrawlerError`; the settings refuse them, this keeps a stored one harmless) left out.
 */
export function crawlersOf(settings: SiteSeoSettings): Crawler[] {
  const ids = new Set(CRAWLERS.map((c) => c.id));
  const tokens = new Set(CRAWLERS.map((c) => c.userAgent.toLowerCase()));
  const own: Crawler[] = [];
  for (const c of settings.crawlers.custom) {
    const token = c.userAgent.toLowerCase();
    if (ids.has(c.id) || tokens.has(token)) continue;
    tokens.add(token);
    own.push({ id: c.id, userAgent: c.userAgent, operator: 'custom', purpose: c.purpose, source: null });
  }
  return [...CRAWLERS, ...own];
}

/**
 * Whether the site lets a crawler in: its own override, else its purpose's decision (an ordinary search engine
 * has none: allowed unless overridden), else allowed.
 */
export function crawlerAllowed(settings: SiteSeoSettings, crawler: Crawler): boolean {
  const own = settings.crawlers.overrides[crawler.id];
  if (own) return own === 'allow';
  if (crawler.purpose === 'search-engine') return true;
  return settings.crawlers.purposes[crawler.purpose] !== 'disallow';
}

export interface RobotsInput {
  settings: SiteSeoSettings;
  /** The host the file is served on (its sitemaps are named on it). */
  origin: string;
  /** The news sitemap is on (task 3.7). */
  newsSitemap?: boolean;
  /** The feeds declared (task 3.3): absolute addresses. */
  feeds?: string[];
}

/** A line a robots.txt can hold: no line breaks or other controls (a value can never start a new rule). */
const safe = (s: string) => s.replace(/[\x00-\x1f\x7f]/g, '');

/**
 * `robots.txt` (RFC 9309): everything allowed to every crawler, then one group naming every crawler the site keeps
 * out (`Disallow: /`); the site's sitemap index (and news sitemap); its feeds as comments. With Content-Signal on, the
 * `*` group carries the site's signals (contentsignals.org): `search=yes` (ordinary search is never limited by a
 * purpose), `ai-train` from training, `ai-input` from AI search.
 */
export function robotsTxt(input: RobotsInput): string {
  const { settings } = input;
  const origin = input.origin.replace(/\/+$/, '');
  const lines = ['User-agent: *', 'Allow: /'];
  if (settings.crawlers.contentSignal) {
    const yes = (purpose: 'training' | 'search') => (settings.crawlers.purposes[purpose] === 'disallow' ? 'no' : 'yes');
    lines.push(`Content-Signal: search=yes, ai-input=${yes('search')}, ai-train=${yes('training')}`);
  }
  const blocked = crawlersOf(settings).filter((c) => !crawlerAllowed(settings, c));
  if (blocked.length) {
    lines.push('');
    for (const c of blocked) lines.push(`User-agent: ${safe(c.userAgent)}`);
    lines.push('Disallow: /');
  }
  lines.push('', `Sitemap: ${safe(origin)}/sitemap.xml`);
  if (input.newsSitemap) lines.push(`Sitemap: ${safe(origin)}/news-sitemap.xml`);
  for (const f of input.feeds ?? []) lines.push(`# Feed: ${safe(f)}`);
  return `${lines.join('\n')}\n`;
}
