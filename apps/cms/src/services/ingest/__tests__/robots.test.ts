import { describe, expect, it } from 'vitest';
import { parseRobots, RobotsCache, ROBOTS_ERROR_TTL_MS, ROBOTS_TTL_MS } from '../robots';
import { agentTokenOf, ingestUserAgent } from '../fetcher';

/** robots.txt (HeoPress P08 task 2.2), after RFC 9309. */
describe('robots.txt parsing', () => {
  const txt = `
# comment
User-agent: *
Disallow: /private/
Allow: /private/public-note
Disallow: /*.pdf$
Disallow: /search?

User-agent: OtherBot
Disallow: /

User-agent: HeoPressBot
User-agent: SomethingElse
Disallow: /drafts/
Allow: /drafts/published*
Disallow: /tmp$
`;
  const ours = parseRobots(txt, 'HeoPressBot');
  const generic = parseRobots(txt, 'UnknownBot');

  it('uses the group naming our token, not the * group', () => {
    expect(ours.isAllowed('/private/x')).toBe(true);
    expect(ours.isAllowed('/drafts/a')).toBe(false);
    expect(ours.isAllowed('/drafts/published-1')).toBe(true);
  });
  it('`$` anchors the end; without it a pattern is a prefix', () => {
    expect(ours.isAllowed('/tmp')).toBe(false);
    expect(ours.isAllowed('/tmp/x')).toBe(true);
    expect(generic.isAllowed('/a/file.pdf')).toBe(false);
    expect(generic.isAllowed('/a/file.pdf?x=1')).toBe(true);
  });
  it('longest match wins; allow wins a tie', () => {
    expect(generic.isAllowed('/private/public-note')).toBe(true);
    expect(generic.isAllowed('/private/other')).toBe(false);
    expect(parseRobots('User-agent: *\nDisallow: /a\nAllow: /a', 'X').isAllowed('/a')).toBe(true);
  });
  it('query strings and percent-encoding', () => {
    expect(generic.isAllowed('/search?q=1')).toBe(false);
    expect(generic.isAllowed('/search')).toBe(true);
    expect(parseRobots('User-agent: *\nDisallow: /caf%C3%A9', 'X').isAllowed('/caf%c3%a9')).toBe(false);
  });
  it('empty disallow and no groups allow everything; robots.txt itself always allowed', () => {
    expect(parseRobots('User-agent: *\nDisallow:', 'X').isAllowed('/x')).toBe(true);
    expect(parseRobots('', 'X').isAllowed('/x')).toBe(true);
    expect(parseRobots('User-agent: *\nDisallow: /', 'X').isAllowed('/robots.txt')).toBe(true);
    expect(parseRobots('User-agent: *\nDisallow: /', 'X').isAllowed('/')).toBe(false);
  });
});

describe('robots cache', () => {
  it('caches per origin: 24 h for a file or a 4xx, 10 minutes when unreachable', async () => {
    const cache = new RobotsCache();
    let loads = 0;
    const load = async () => (loads++, { kind: 'ok' as const, body: 'User-agent: *\nDisallow: /x' });
    await cache.policyFor('https://a.example.com', 'Bot', load, 0);
    await cache.policyFor('https://a.example.com', 'Bot', load, ROBOTS_TTL_MS - 1);
    expect(loads).toBe(1);
    await cache.policyFor('https://a.example.com', 'Bot', load, ROBOTS_TTL_MS + 1);
    expect(loads).toBe(2);
    const down = await cache.policyFor('https://b.example.com', 'Bot', async () => ({ kind: 'unavailable', reason: 'HTTP 503' }), 0);
    expect(down.unavailable).toBe('HTTP 503');
    expect(down.policy.isAllowed('/')).toBe(false);
    const again = await cache.policyFor('https://b.example.com', 'Bot', async () => ({ kind: 'client_error' }), ROBOTS_ERROR_TTL_MS + 1);
    expect(again.policy.isAllowed('/')).toBe(true);
  });
});

describe('User-Agent', () => {
  it('identifies the bot with a contact URL; configurable', () => {
    expect(ingestUserAgent({})).toBe('HeoPressBot/1.0 (+https://example.com/heopress-bot)');
    expect(ingestUserAgent({ HEOPRESS_INGEST_CONTACT_URL: 'https://ops.example.com/bot' })).toContain('+https://ops.example.com/bot');
    expect(ingestUserAgent({ HEOPRESS_INGEST_USER_AGENT: 'MyCrawler/2 (+https://example.com)' })).toBe('MyCrawler/2 (+https://example.com)');
    expect(agentTokenOf('HeoPressBot/1.0 (+https://example.com)')).toBe('HeoPressBot');
  });
});
