import type { Crawler } from './crawlers.ts';

/**
 * AI traffic (HeoPress P07 task 6.1; spec analytics/ai-traffic): what a request to a public site is, for the AI traffic
 * figures — a known crawler (by the product token in its User-Agent, whether or not the token says "bot":
 * `ChatGPT-User`, `Perplexity-User`), or a visit an AI assistant referred (by its referrer's host, or, without one, by the
 * `utm_source` the assistant adds to its links: `utm_source=chatgpt.com`). Pure: the renderer classifies, then records
 * only the result (never the User-Agent, the referrer or the query).
 */

export interface AiReferrer {
  /** Stable id (lower case). */
  id: string;
  name: string;
  operator: string;
  /** Referrer hosts (a subdomain of one counts too). */
  hosts: readonly string[];
  /**
   * `utm_source` values (lower case): the assistant's own host only — a bare name (`openai`, `claude`) is as often an
   * ordinary campaign's (Codex review of batch 11).
   */
  utm: readonly string[];
}

export const AI_REFERRERS: readonly AiReferrer[] = [
  { id: 'chatgpt', name: 'ChatGPT', operator: 'OpenAI', hosts: ['chatgpt.com', 'chat.openai.com'], utm: ['chatgpt.com', 'chat.openai.com'] },
  { id: 'perplexity', name: 'Perplexity', operator: 'Perplexity', hosts: ['perplexity.ai'], utm: ['perplexity.ai', 'www.perplexity.ai'] },
  { id: 'claude', name: 'Claude', operator: 'Anthropic', hosts: ['claude.ai'], utm: ['claude.ai'] },
  { id: 'gemini', name: 'Gemini', operator: 'Google', hosts: ['gemini.google.com', 'bard.google.com'], utm: ['gemini.google.com'] },
  { id: 'copilot', name: 'Copilot', operator: 'Microsoft', hosts: ['copilot.microsoft.com', 'copilot.cloud.microsoft'], utm: ['copilot.com', 'copilot.microsoft.com'] },
  { id: 'deepseek', name: 'DeepSeek', operator: 'DeepSeek', hosts: ['chat.deepseek.com'], utm: ['chat.deepseek.com'] },
  { id: 'mistral', name: 'Le Chat', operator: 'Mistral AI', hosts: ['chat.mistral.ai'], utm: ['chat.mistral.ai'] },
  { id: 'meta-ai', name: 'Meta AI', operator: 'Meta', hosts: ['meta.ai'], utm: ['meta.ai'] },
  { id: 'you', name: 'You.com', operator: 'You.com', hosts: ['you.com'], utm: ['you.com'] },
  { id: 'phind', name: 'Phind', operator: 'Phind', hosts: ['phind.com'], utm: ['phind.com'] },
  { id: 'poe', name: 'Poe', operator: 'Quora', hosts: ['poe.com'], utm: ['poe.com'] },
  { id: 'kimi', name: 'Kimi', operator: 'Moonshot AI', hosts: ['kimi.moonshot.cn', 'kimi.com'], utm: ['kimi.com', 'kimi.moonshot.cn'] },
  { id: 'doubao', name: 'Doubao', operator: 'ByteDance', hosts: ['doubao.com'], utm: ['doubao.com'] },
];

export type Visit = { kind: 'crawler'; crawler: Crawler } | { kind: 'referral'; source: AiReferrer };

/** `host` is `domain` or one of its subdomains. */
const under = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

/** The known crawler a User-Agent names: its product token as a word (the longest that matches first). */
export function crawlerOfUserAgent(userAgent: string | null | undefined, crawlers: readonly Crawler[]): Crawler | null {
  if (!userAgent) return null;
  const ua = userAgent.toLowerCase();
  let best: Crawler | null = null;
  for (const c of crawlers) {
    const token = c.userAgent.toLowerCase();
    // As a word: not inside a longer name (`Applebot` also matches in `Applebot-Extended`; the longer token wins).
    const word = new RegExp(`(^|[^a-z0-9])${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`);
    if (!word.test(ua)) continue;
    if (!best || token.length > best.userAgent.length) best = c;
  }
  return best;
}

/**
 * The AI assistant that referred a visit: by the referrer's host; only a visit without a referrer is judged by its
 * `utm_source` (Codex review of batch 11: another site's referrer with an assistant's parameter is that site's visit).
 */
export function aiReferrerOf(referrer: string | null | undefined, utmSource: string | null | undefined): AiReferrer | null {
  if (referrer) {
    try {
      const host = new URL(referrer).hostname.toLowerCase().replace(/\.$/, '');
      return AI_REFERRERS.find((r) => r.hosts.some((h) => under(host, h))) ?? null;
    } catch {
      return null;
    }
  }
  const utm = utmSource?.trim().toLowerCase();
  return utm ? (AI_REFERRERS.find((r) => r.utm.includes(utm)) ?? null) : null;
}

/** What a request is, for the AI traffic figures, or null (an ordinary visit). A crawler is never also a referral. */
export function classifyVisit(input: { userAgent: string | null | undefined; referrer: string | null | undefined; utmSource: string | null | undefined }, crawlers: readonly Crawler[]): Visit | null {
  const crawler = crawlerOfUserAgent(input.userAgent, crawlers);
  if (crawler) return { kind: 'crawler', crawler };
  const source = aiReferrerOf(input.referrer, input.utmSource);
  return source ? { kind: 'referral', source } : null;
}
