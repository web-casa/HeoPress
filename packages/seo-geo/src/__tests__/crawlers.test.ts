import { describe, expect, it } from 'vitest';
import { SiteSeoSettingsSchema } from '@heopress/contracts/schemas';
import { CRAWLERS, crawlerAllowed, customCrawlerError, robotsTxt } from '../index';

/** The crawler policy and robots.txt (task 3.2; spec seo/crawl-discovery "按用途的 AI 爬虫策略"). */
const settings = (crawlers: Record<string, unknown> = {}, discovery: Record<string, unknown> = {}) => SiteSeoSettingsSchema.parse({ crawlers, discovery });
const ORIGIN = 'https://example.com';
const blocked = (txt: string) => {
  const group = txt.split('\n\n').find((g) => g.includes('Disallow: /'));
  return group ? [...group.matchAll(/^User-agent: (.+)$/gm)].map((m) => m[1]) : [];
};

describe('robots.txt (task 3.2)', () => {
  it('scenario 禁止训练抓取: training crawlers are kept out, AI search and ordinary search engines are not', () => {
    const txt = robotsTxt({ settings: settings({ purposes: { training: 'disallow', search: 'allow' } }), origin: ORIGIN });
    const out = blocked(txt);
    for (const ua of ['GPTBot', 'ClaudeBot', 'CCBot', 'Google-Extended']) expect(out).toContain(ua);
    for (const ua of ['OAI-SearchBot', 'PerplexityBot', 'Googlebot', 'Bingbot', 'ChatGPT-User']) expect(out).not.toContain(ua);
    expect(txt.startsWith('User-agent: *\nAllow: /\n')).toBe(true);
    expect(txt).toContain('Sitemap: https://example.com/sitemap.xml');
  });

  it('nothing set: nobody kept out; an ordinary search engine only by its own override, a crawler\'s override beats its purpose', () => {
    expect(blocked(robotsTxt({ settings: settings(), origin: ORIGIN }))).toEqual([]);
    const s = settings({ purposes: { training: 'disallow', 'user-fetch': 'disallow' }, overrides: { googlebot: 'disallow', gptbot: 'allow' } });
    const out = blocked(robotsTxt({ settings: s, origin: ORIGIN }));
    expect(out).toContain('Googlebot');
    expect(out).not.toContain('GPTBot');
    expect(out).toContain('ChatGPT-User');
    expect(out).not.toContain('Bingbot');
    // Every known search engine is allowed by default whatever the purposes say.
    for (const c of CRAWLERS.filter((x) => x.purpose === 'search-engine' && x.id !== 'googlebot')) expect(crawlerAllowed(s, c), c.id).toBe(true);
  });

  it("a site's own crawler; Content-Signal; the news sitemap and the feeds declared", () => {
    const s = settings({ purposes: { training: 'disallow' }, contentSignal: true, custom: [{ id: 'acme', userAgent: 'AcmeBot', purpose: 'training' }, { id: 'gptbot', userAgent: 'Other', purpose: 'search' }] });
    const txt = robotsTxt({ settings: s, origin: `${ORIGIN}/`, newsSitemap: true, feeds: [`${ORIGIN}/feed.xml`] });
    expect(blocked(txt)).toContain('AcmeBot');
    // An id the known list has is the list's.
    expect(txt).not.toContain('Other');
    expect(txt).toContain('Content-Signal: search=yes, ai-input=yes, ai-train=no');
    expect(txt).toContain('Sitemap: https://example.com/news-sitemap.xml');
    expect(txt).toContain('# Feed: https://example.com/feed.xml');
  });

  it("a custom crawler cannot take a known crawler's token or another's (Codex review of batch 7)", () => {
    const s = settings({ purposes: { training: 'disallow' }, custom: [{ id: 'acme-search', userAgent: 'bingbot', purpose: 'training' }, { id: 'one', userAgent: 'AcmeBot', purpose: 'training' }, { id: 'two', userAgent: 'ACMEBOT', purpose: 'search' }] });
    const out = blocked(robotsTxt({ settings: s, origin: ORIGIN }));
    expect(out).not.toContain('bingbot');
    expect(out).toContain('AcmeBot');
    expect(customCrawlerError(s.crawlers.custom)).toMatch(/bingbot/);
    expect(customCrawlerError([{ id: 'one', userAgent: 'AcmeBot', purpose: 'training' }, { id: 'two', userAgent: 'acmebot', purpose: 'search' }])).toMatch(/acmebot/);
    expect(customCrawlerError([{ id: 'one', userAgent: 'AcmeBot', purpose: 'training' }])).toBeNull();
    // A known crawler's id, with a token of its own: refused too.
    expect(customCrawlerError([{ id: 'bingbot', userAgent: 'AcmeBot', purpose: 'training' }])).toMatch(/bingbot/);
  });

  it('a crawler token cannot break a line (the settings refuse it; robots.txt strips controls anyway)', () => {
    expect(SiteSeoSettingsSchema.safeParse({ crawlers: { custom: [{ id: 'evil', userAgent: 'Evil\r\nDisallow: /', purpose: 'training' }] } }).success).toBe(false);
    expect(SiteSeoSettingsSchema.safeParse({ crawlers: { custom: [{ id: 'a', userAgent: 'A', purpose: 'training' }, { id: 'a', userAgent: 'B', purpose: 'search' }] } }).success).toBe(false);
    expect(robotsTxt({ settings: settings(), origin: 'https://example.com\nDisallow: /' })).not.toMatch(/\nDisallow: \//);
  });
});
