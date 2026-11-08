import { describe, expect, it, vi } from 'vitest';
import { addressHasher, crawlHitOf, resourceOf, TrafficRecorder, type CrawlHit } from '../ai-traffic';
import { clientAddress, trustedProxies } from '../host';

/** The renderer's AI traffic records (HeoPress P07 tasks 6.1, 6.4): what is kept of a request, and how. */

const GPTBOT = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot';
const BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const hash = addressHasher(Buffer.alloc(32, 1));
const req = (over: Partial<Parameters<typeof crawlHitOf>[0]> = {}) => ({ host: 'Example.com', path: '/a/', query: '', status: 200, userAgent: GPTBOT, referrer: null, address: '198.51.100.7', ...over });

describe('resourceOf', () => {
  it('discovery files by kind, Markdown copies, other files, pages', () => {
    expect(resourceOf('/robots.txt')).toBe('robots');
    expect(resourceOf('/llms.txt')).toBe('llms');
    expect(resourceOf('/llms-full.txt')).toBe('llms');
    expect(resourceOf('/sitemap.xml')).toBe('sitemap');
    expect(resourceOf('/sitemap-2.xml')).toBe('sitemap');
    expect(resourceOf('/news-sitemap.xml')).toBe('sitemap');
    expect(resourceOf('/feed.xml')).toBe('feed');
    expect(resourceOf('/a/b.md')).toBe('markdown');
    expect(resourceOf('/ads.txt')).toBe('file');
    expect(resourceOf('/logo.png')).toBe('file');
    expect(resourceOf('/a/b/')).toBe('page');
    expect(resourceOf('/')).toBe('page');
  });
});

describe('crawlHitOf', () => {
  it('a crawler: its id, operator, purpose; the host lower-cased; the address only as a hash', () => {
    const hit = crawlHitOf(req(), hash, undefined, Date.UTC(2026, 9, 22, 12))!;
    expect(hit).toMatchObject({ host: 'example.com', kind: 'crawler', agent: 'gptbot', operator: 'OpenAI', purpose: 'training', resource: 'page', path: '/a/', status: 200 });
    expect(hit.ipHash).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(hit)).not.toContain('198.51.100.7');
    expect(JSON.stringify(hit)).not.toContain('Mozilla');
  });

  it('an AI-referred visit by utm_source; the query never kept; a secret in the query, an over-long path, an ordinary visit: nothing', () => {
    const hit = crawlHitOf(req({ userAgent: BROWSER, query: 'utm_source=chatgpt.com&q=private' }), hash)!;
    expect(hit).toMatchObject({ kind: 'referral', agent: 'chatgpt', operator: 'OpenAI', purpose: null, path: '/a/' });
    expect(JSON.stringify(hit)).not.toMatch(/utm_|private/);
    expect(crawlHitOf(req({ query: 'token=abc' }), hash)).toBeNull();
    expect(crawlHitOf(req({ query: 'x=1&Preview=abc' }), hash)).toBeNull();
    // The decoded name counts (Codex review of batch 11, round 2).
    expect(crawlHitOf(req({ query: '%74oken=abc' }), hash)).toBeNull();
    expect(crawlHitOf(req({ query: 'tokenish=1' }), hash)).not.toBeNull();
    expect(crawlHitOf(req({ path: `/${'a'.repeat(600)}` }), hash)).toBeNull();
    expect(crawlHitOf(req({ userAgent: BROWSER }), hash)).toBeNull();
    expect(crawlHitOf(req({ address: null }), hash)!.ipHash).toBeNull();
  });

  it('an ordinary search engine is not AI traffic (Codex review of batch 11)', () => {
    expect(crawlHitOf(req({ userAgent: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' }), hash)).toBeNull();
    expect(crawlHitOf(req({ userAgent: 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)' }), hash)).toBeNull();
  });
});

describe('addressHasher', () => {
  it('the same visitor is the same within a day and a host, another the next day or on another host; another key, another hash', () => {
    expect(hash('2026-10-22', 'a.example.com', '198.51.100.7')).toBe(hash('2026-10-22', 'a.example.com', '198.51.100.7'));
    expect(hash('2026-10-23', 'a.example.com', '198.51.100.7')).not.toBe(hash('2026-10-22', 'a.example.com', '198.51.100.7'));
    expect(hash('2026-10-22', 'b.example.com', '198.51.100.7')).not.toBe(hash('2026-10-22', 'a.example.com', '198.51.100.7'));
    expect(addressHasher()('2026-10-22', 'a.example.com', '198.51.100.7')).not.toBe(hash('2026-10-22', 'a.example.com', '198.51.100.7'));
  });
});

describe('TrafficRecorder', () => {
  const hit = crawlHitOf(req(), hash) as CrawlHit;

  it('at most maxInFlight writes at once, the rest dropped; a failed write neither throws nor logs the hit', async () => {
    const release: Array<() => void> = [];
    const write = vi.fn(() => new Promise<void>((resolve) => release.push(resolve)));
    const recorder = new TrafficRecorder(write, 2);
    recorder.record(hit);
    recorder.record(hit);
    recorder.record(hit);
    recorder.record(null);
    expect(write).toHaveBeenCalledTimes(2);
    expect(recorder.dropped).toBe(1);
    release.forEach((r) => r());
    await vi.waitFor(() => expect(recorder.pending).toBe(0));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let clock = 0;
    const failing = new TrafficRecorder(() => Promise.reject(new Error('db down')), 2, () => clock);
    for (let i = 0; i < 5; i++) {
      failing.record(hit);
      await vi.waitFor(() => expect(failing.pending).toBe(0));
    }
    // Five failures, one warning (a minute apart at most); then a minute later, another, with the count.
    expect(failing.failed).toBe(5);
    expect(warn).toHaveBeenCalledTimes(1);
    clock = 60_000;
    failing.record(hit);
    await vi.waitFor(() => expect(failing.pending).toBe(0));
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenLastCalledWith('[site-classic] AI traffic hits were not recorded', { failed: 6, dropped: 0 });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('/a/');
    warn.mockRestore();
  });
});

describe('clientAddress', () => {
  it('the trusted proxy\'s right-most X-Forwarded-For; otherwise the peer (a client cannot set it)', () => {
    const trusted = trustedProxies('10.0.0.0/8');
    expect(clientAddress('203.0.113.1, 198.51.100.7', '10.0.0.2', trusted)).toBe('198.51.100.7');
    expect(clientAddress('203.0.113.1', '192.0.2.50', trusted)).toBe('192.0.2.50');
    expect(clientAddress(null, undefined, trusted)).toBeNull();
  });
});
