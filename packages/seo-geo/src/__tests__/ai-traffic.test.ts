import { describe, expect, it } from 'vitest';
import { aiReferrerOf, classifyVisit, crawlerOfUserAgent } from '../ai-traffic';
import { CRAWLERS } from '../crawlers';

/** AI traffic classification (HeoPress P07 task 6.1; spec analytics/ai-traffic) with User-Agents and referrers as sent. */

const UA = {
  perplexityUser: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)',
  chatgptUser: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot',
  gptbot: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot',
  oaiSearch: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot',
  claudebot: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
  googlebot: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  applebotExtended: 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15 (Applebot-Extended/0.1)',
  chrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
};

describe('crawlerOfUserAgent', () => {
  it('known AI crawlers, those without "bot" in their name too, with operator and purpose', () => {
    expect(crawlerOfUserAgent(UA.perplexityUser, CRAWLERS)).toMatchObject({ id: 'perplexity-user', operator: 'Perplexity', purpose: 'user-fetch' });
    expect(crawlerOfUserAgent(UA.chatgptUser, CRAWLERS)).toMatchObject({ id: 'chatgpt-user', operator: 'OpenAI', purpose: 'user-fetch' });
    expect(crawlerOfUserAgent(UA.gptbot, CRAWLERS)).toMatchObject({ id: 'gptbot', purpose: 'training' });
    expect(crawlerOfUserAgent(UA.oaiSearch, CRAWLERS)).toMatchObject({ id: 'oai-searchbot', purpose: 'search' });
    expect(crawlerOfUserAgent(UA.claudebot, CRAWLERS)).toMatchObject({ id: 'claudebot', operator: 'Anthropic' });
    expect(crawlerOfUserAgent(UA.googlebot, CRAWLERS)).toMatchObject({ id: 'googlebot', purpose: 'search-engine' });
  });

  it('the longer token wins; a token inside another word is not it; a browser is none', () => {
    expect(crawlerOfUserAgent(UA.applebotExtended, CRAWLERS)?.id).toBe('applebot-extended');
    expect(crawlerOfUserAgent('Mozilla/5.0 NotGPTBotty/1.0', CRAWLERS)).toBeNull();
    expect(crawlerOfUserAgent(UA.chrome, CRAWLERS)).toBeNull();
    expect(crawlerOfUserAgent('', CRAWLERS)).toBeNull();
    expect(crawlerOfUserAgent(null, CRAWLERS)).toBeNull();
  });
});

describe('aiReferrerOf / classifyVisit', () => {
  it('a referrer host (subdomains too); only without a referrer, the utm_source — the assistant\'s host, not a bare name', () => {
    expect(aiReferrerOf('https://chatgpt.com/', null)?.id).toBe('chatgpt');
    expect(aiReferrerOf('https://www.perplexity.ai/search?q=x', null)?.id).toBe('perplexity');
    expect(aiReferrerOf('https://gemini.google.com/app', null)).toMatchObject({ id: 'gemini', operator: 'Google' });
    // No referrer, but the parameter.
    expect(aiReferrerOf(null, 'chatgpt.com')).toMatchObject({ id: 'chatgpt', operator: 'OpenAI' });
    expect(aiReferrerOf('', 'ChatGPT.com')?.id).toBe('chatgpt');
    // Codex review of batch 11: another site's referrer with an assistant's parameter is that site's visit; a bare
    // campaign name is not an assistant.
    expect(aiReferrerOf('https://www.google.com/', 'chatgpt.com')).toBeNull();
    expect(aiReferrerOf(null, 'openai')).toBeNull();
    expect(aiReferrerOf(null, 'claude')).toBeNull();
    expect(aiReferrerOf('not a url', 'perplexity.ai')).toBeNull();
    // Not an assistant: a search engine, a look-alike host, another campaign.
    expect(aiReferrerOf('https://www.google.com/', null)).toBeNull();
    expect(aiReferrerOf('https://notchatgpt.com/', null)).toBeNull();
    expect(aiReferrerOf(null, 'newsletter')).toBeNull();
  });

  it('a crawler is never also a referral; an ordinary visit is nothing', () => {
    expect(classifyVisit({ userAgent: UA.perplexityUser, referrer: 'https://chatgpt.com/', utmSource: null }, CRAWLERS)).toMatchObject({ kind: 'crawler', crawler: { id: 'perplexity-user' } });
    expect(classifyVisit({ userAgent: UA.chrome, referrer: null, utmSource: 'chatgpt.com' }, CRAWLERS)).toMatchObject({ kind: 'referral', source: { id: 'chatgpt' } });
    expect(classifyVisit({ userAgent: UA.chrome, referrer: 'https://www.google.com/', utmSource: null }, CRAWLERS)).toBeNull();
  });
});
