import { describe, expect, it } from 'vitest';
import { SiteSeoSettingsSchema } from '@heopress/contracts/schemas';
import {
  crawlerTrafficHints,
  evaluateCrawler,
  evaluateProbe,
  expectedProbes,
  REACHABILITY_PLATFORMS,
  reachabilityAdvice,
  robotsAllowsRoot,
  robotsTxt,
  SIMULATED_CRAWLERS,
  simulatedUserAgent,
  type ProbeObservation,
  type ReachabilityProbe,
} from '../index';

/**
 * The reachability check's rules (HeoPress P07 task 3.9; spec seo/crawl-discovery "线上可达性体检"): expected results from
 * the switches and the indexing decision, answers judged against them (a configuration as intended is never a fault),
 * simulated crawler requests, traffic hints, and advice per platform.
 */

const settings = (discovery: Record<string, unknown> = {}, crawlers: Record<string, unknown> = {}) => SiteSeoSettingsSchema.parse({ discovery, crawlers });
const ORIGIN = 'https://example.com';
const EVERYTHING = { feeds: true, llms: true, markdownCopies: true, newsSitemap: true };
const PAGE = { url: 'https://example.com/hello/', indexable: true, canonicalHost: true, copy: 'https://example.com/hello.md' };
const HIDDEN = { url: 'https://example.com/private-ish/', indexable: false, canonicalHost: true, copy: 'https://example.com/private-ish.md' };

const seen = (o: Partial<ProbeObservation>): ProbeObservation => ({ status: 200, contentType: null, xRobotsTag: null, location: null, metaRobots: null, challenge: false, ...o });
const probeOf = (probes: ReachabilityProbe[], kind: string, url?: string) => probes.find((p) => p.kind === kind && (!url || p.url === url))!;

describe('expected results', () => {
  it('everything on: the discovery files, the home page, a listable page and its copy are public; a noindex page answers and says noindex', () => {
    const probes = expectedProbes({ origin: ORIGIN, settings: settings({ newsSitemap: true }), support: EVERYTHING, home: 'https://example.com/', homeIndexable: true, pages: [PAGE, HIDDEN] });
    expect(probes[0]!.kind).toBe('robots');
    for (const kind of ['robots', 'sitemap', 'sitemap-txt', 'llms', 'llms-full', 'news-sitemap', 'feed', 'atom']) expect(probeOf(probes, kind).expect.public, kind).toBe(true);
    expect(probeOf(probes, 'home').expect).toEqual({ public: true, types: ['text/html'], noindex: false });
    expect(probeOf(probes, 'page', PAGE.url).expect).toMatchObject({ public: true, noindex: false });
    expect(probeOf(probes, 'markdown-copy', PAGE.copy).expect).toEqual({ public: true, types: ['text/markdown'], noindex: true });
    // Reachable and discoverable apart: the noindex page is expected to answer (with noindex); its copy not to exist.
    expect(probeOf(probes, 'page', HIDDEN.url).expect).toMatchObject({ public: true, noindex: true });
    expect(probeOf(probes, 'markdown-copy', HIDDEN.copy).expect).toEqual({ public: false });
  });

  it('switches off: the files and copies are expected absent, with the reason', () => {
    const probes = expectedProbes({ origin: ORIGIN, settings: settings({ feeds: false, llms: false, markdownCopies: false }), support: EVERYTHING, home: 'https://example.com/', homeIndexable: false, pages: [PAGE] });
    for (const kind of ['llms', 'llms-full', 'news-sitemap', 'feed', 'atom', 'markdown-copy']) expect(probeOf(probes, kind).expect.public, kind).toBe(false);
    expect(probeOf(probes, 'markdown-copy').because).toBe('Markdown copies are off');
    expect(probeOf(probes, 'home').expect).toMatchObject({ noindex: true });
  });

  it('a target that cannot serve a file: expected absent, not a fault', () => {
    const probes = expectedProbes({ origin: ORIGIN, settings: settings(), support: { ...EVERYTHING, markdownCopies: false, llms: false }, home: 'https://example.com/', homeIndexable: true, pages: [PAGE] });
    expect(probeOf(probes, 'markdown-copy').expect.public).toBe(false);
    expect(probeOf(probes, 'markdown-copy').because).toMatch(/not supported/);
    expect(probeOf(probes, 'llms').expect.public).toBe(false);
    expect(evaluateProbe(probeOf(probes, 'llms'), seen({ status: 404, contentType: 'text/html' })).ok).toBe(true);
  });

  it('a page on a host that is not its canonical one (a language entry domain under the subdirectory strategy): it answers there, its copy does not', () => {
    const entry = { url: 'https://fr.example.com/bonjour/', indexable: true, canonicalHost: false, copy: 'https://fr.example.com/bonjour.md' };
    const probes = expectedProbes({ origin: 'https://fr.example.com', settings: settings(), support: EVERYTHING, home: 'https://fr.example.com/', homeIndexable: true, pages: [entry] });
    expect(probeOf(probes, 'page').expect).toMatchObject({ public: true, noindex: false });
    expect(probeOf(probes, 'markdown-copy').expect).toEqual({ public: false });
    expect(probeOf(probes, 'markdown-copy').because).toMatch(/canonical address only/);
  });

  it('a page whose copy address the site answers otherwise is not asked for its copy', () => {
    const probes = expectedProbes({ origin: ORIGIN, settings: settings(), support: EVERYTHING, home: 'https://example.com/', homeIndexable: true, pages: [{ ...PAGE, copy: null }] });
    expect(probes.filter((p) => p.kind === 'markdown-copy')).toEqual([]);
  });
});

describe('answers against expectations', () => {
  const probes = expectedProbes({ origin: ORIGIN, settings: settings(), support: EVERYTHING, home: 'https://example.com/', homeIndexable: true, pages: [PAGE, HIDDEN] });
  const copy = probeOf(probes, 'markdown-copy', PAGE.copy);

  it('scenario Markdown 副本类型错误: a copy served as application/octet-stream is a type error', () => {
    const v = evaluateProbe(copy, seen({ contentType: 'application/octet-stream', xRobotsTag: 'noindex' }));
    expect(v).toMatchObject({ ok: false, code: 'wrong-type', severity: 'error' });
    expect(v.detail).toMatch(/application\/octet-stream/);
    // The right type (with parameters, any case) and the copy's noindex: passes.
    expect(evaluateProbe(copy, seen({ contentType: 'Text/Markdown; charset=utf-8', xRobotsTag: 'noindex' })).ok).toBe(true);
    // A copy without noindex competes with its page.
    expect(evaluateProbe(copy, seen({ contentType: 'text/markdown', xRobotsTag: null }))).toMatchObject({ code: 'missing-noindex', severity: 'warning' });
  });

  it('scenario 站点关闭了 Markdown 副本 / noindex 页: not public and answering 404, or answering with noindex, is no fault', () => {
    const off = expectedProbes({ origin: ORIGIN, settings: settings({ markdownCopies: false }), support: EVERYTHING, home: 'https://example.com/', homeIndexable: true, pages: [PAGE] });
    for (const status of [404, 410, 403, 301]) expect(evaluateProbe(probeOf(off, 'markdown-copy'), seen({ status, contentType: 'text/html' })).ok, String(status)).toBe(true);
    // Served although off (a stale cache, a left-over file): exposed.
    expect(evaluateProbe(probeOf(off, 'markdown-copy'), seen({ status: 200, contentType: 'text/markdown' }))).toMatchObject({ ok: false, code: 'exposed' });
    const hidden = probeOf(probes, 'page', HIDDEN.url);
    expect(evaluateProbe(hidden, seen({ contentType: 'text/html; charset=utf-8', xRobotsTag: 'noindex' })).ok).toBe(true);
    expect(evaluateProbe(hidden, seen({ contentType: 'text/html', metaRobots: 'noindex, nofollow' })).ok).toBe(true);
    // A noindex page that lost its noindex on the way (a proxy stripping the header, no meta): a fault.
    expect(evaluateProbe(hidden, seen({ contentType: 'text/html' }))).toMatchObject({ ok: false, code: 'missing-noindex', severity: 'error' });
    expect(evaluateProbe(probeOf(probes, 'markdown-copy', HIDDEN.copy), seen({ status: 404 })).ok).toBe(true);
  });

  it('a listable page: not answering, redirected, challenged or saying noindex are faults', () => {
    const page = probeOf(probes, 'page', PAGE.url);
    expect(evaluateProbe(page, seen({ contentType: 'text/html', metaRobots: 'max-image-preview:large' })).ok).toBe(true);
    expect(evaluateProbe(page, seen({ contentType: 'text/html', xRobotsTag: 'googlebot: noindex' })).code).toBe('unexpected-noindex');
    expect(evaluateProbe(page, seen({ status: null, error: 'timeout' })).code).toBe('unreachable');
    expect(evaluateProbe(page, seen({ status: 301, location: 'https://www.example.com/hello/' })).detail).toMatch(/www\.example\.com/);
    expect(evaluateProbe(page, seen({ status: 403, challenge: true })).code).toBe('challenged');
    expect(evaluateProbe(page, seen({ status: 404 })).code).toBe('not-found');
    expect(evaluateProbe(page, seen({ status: 502 })).code).toBe('error-status');
    // The feeds accept a generic XML type too.
    expect(evaluateProbe(probeOf(probes, 'feed'), seen({ contentType: 'application/xml' })).ok).toBe(true);
  });
});

describe('robots.txt as served', () => {
  it('the groups naming the crawler, else *; the longest rule matching / decides, Allow on a tie', () => {
    const own = robotsTxt({ settings: settings({}, { purposes: { training: 'disallow' } }), origin: ORIGIN });
    expect(robotsAllowsRoot(own, 'GPTBot')).toBe(false);
    expect(robotsAllowsRoot(own, 'gptbot')).toBe(false);
    expect(robotsAllowsRoot(own, 'OAI-SearchBot')).toBe(true);
    expect(robotsAllowsRoot('User-agent: *\nDisallow: /\n\nUser-agent: GPTBot\nAllow: /\n', 'GPTBot')).toBe(true);
    expect(robotsAllowsRoot('User-agent: *\nDisallow: /\n', 'ClaudeBot')).toBe(false);
    expect(robotsAllowsRoot('User-agent: *\nDisallow:\n', 'ClaudeBot')).toBe(true);
    expect(robotsAllowsRoot('User-agent: *\nDisallow: /admin\nDisallow: /*.php$\n', 'ClaudeBot')).toBe(true);
    expect(robotsAllowsRoot('User-agent: ClaudeBot\nDisallow: /*\n', 'ClaudeBot')).toBe(false);
    expect(robotsAllowsRoot('', 'ClaudeBot')).toBe(true);
  });
});

describe('simulated AI crawlers', () => {
  const gptbot = SIMULATED_CRAWLERS.find((c) => c.id === 'gptbot')!;
  const ok = seen({ contentType: 'text/html' });
  const allowAll = settings();
  const robotsOf = (s: ReturnType<typeof settings>) => robotsTxt({ settings: s, origin: ORIGIN });

  it('scenario CDN 拦截 AI 爬虫: robots allows GPTBot, the home page answers it 403 — "allowed by robots but blocked", marked simulated', () => {
    const v = evaluateCrawler({ settings: allowAll, crawler: gptbot, servedRobots: robotsOf(allowAll), baseline: ok, seen: seen({ status: 403 }) });
    expect(v).toMatchObject({ ok: false, code: 'crawler-blocked', severity: 'error', outcome: 'blocked', simulated: true });
    expect(v.detail).toMatch(/robots\.txt allows GPTBot/);
    expect(reachabilityAdvice('cloudflare', v.code!)).toMatch(/Block AI bots/);
    expect(simulatedUserAgent(gptbot)).toMatch(/GPTBot\/1\.0/);
  });

  it('a crawler the site keeps out may be refused: no fault; served, no fault either', () => {
    const keepOut = settings({}, { purposes: { training: 'disallow' } });
    expect(evaluateCrawler({ settings: keepOut, crawler: gptbot, servedRobots: robotsOf(keepOut), baseline: ok, seen: seen({ status: 403 }) })).toMatchObject({ ok: true, outcome: 'kept-out' });
    expect(evaluateCrawler({ settings: allowAll, crawler: gptbot, servedRobots: robotsOf(allowAll), baseline: ok, seen: ok })).toMatchObject({ ok: true, outcome: 'served' });
  });

  it('no answer to the crawler (a timeout) while a browser is answered: inconclusive, not a block', () => {
    const v = evaluateCrawler({ settings: allowAll, crawler: gptbot, servedRobots: robotsOf(allowAll), baseline: ok, seen: seen({ status: null, error: 'timeout' }) });
    expect(v).toMatchObject({ ok: true, code: null, outcome: 'inconclusive', simulated: true });
    expect(v.detail).toMatch(/timeout/);
  });

  it('a home page that refuses a browser too: inconclusive, not blamed on the crawler', () => {
    expect(evaluateCrawler({ settings: allowAll, crawler: gptbot, servedRobots: null, baseline: seen({ status: 503 }), seen: seen({ status: 503 }) })).toMatchObject({ ok: true, outcome: 'inconclusive' });
  });

  it('a robots.txt served that is not the site\'s (a CDN-managed one): reported, with the platform\'s advice', () => {
    const v = evaluateCrawler({ settings: allowAll, crawler: gptbot, servedRobots: 'User-agent: GPTBot\nDisallow: /\n', baseline: ok, seen: ok });
    expect(v).toMatchObject({ ok: false, code: 'robots-differs', severity: 'error' });
    expect(reachabilityAdvice('cloudflare', 'robots-differs')).toMatch(/managed robots\.txt/);
  });
});

describe('AI crawler traffic hints', () => {
  const today = '2026-10-22';
  const day = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
  const steady = (agent: string, hits: number, from = 4, to = 17) => Array.from({ length: to - from + 1 }, (_, i) => ({ day: day(from + i), agent, hits }));

  it('a crawler that read steadily and stopped; one that nearly stopped; one that never was steady, or goes on — no hint', () => {
    const rows = [
      ...steady('gptbot', 10),
      ...steady('claudebot', 50),
      { day: day(1), agent: 'claudebot', hits: 3 },
      ...steady('ccbot', 10, 4, 7),
      ...steady('perplexitybot', 10),
      ...steady('perplexitybot', 9, 1, 3),
      // Today does not count (not over): gptbot still "stopped".
      { day: today, agent: 'gptbot', hits: 4 },
    ];
    expect(crawlerTrafficHints(rows, today)).toEqual([
      { agent: 'claudebot', kind: 'dropped', activeDays: 14, before: 50, after: 1 },
      { agent: 'gptbot', kind: 'stopped', activeDays: 14, before: 10, after: 0 },
    ]);
  });
});

describe('AI crawler traffic hints: the thresholds', () => {
  const today = '2026-10-22';
  const day = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
  const days = (agent: string, hits: number, offsets: number[]) => offsets.map((n) => ({ day: day(n), agent, hits }));
  const baseline = Array.from({ length: 14 }, (_, i) => 4 + i);
  const recent = [1, 2, 3];

  it('exactly one fifth of the earlier rate is a drop ("五分之一以下"); just above it is not', () => {
    expect(crawlerTrafficHints([...days('gptbot', 50, baseline), ...days('gptbot', 10, recent)], today)).toEqual([{ agent: 'gptbot', kind: 'dropped', activeDays: 14, before: 50, after: 10 }]);
    expect(crawlerTrafficHints([...days('gptbot', 50, baseline), ...days('gptbot', 11, recent)], today)).toEqual([]);
  });

  it('a sparse but steady crawler: the earlier rate counts the days it came, not the 14', () => {
    // 7 of 14 days, 5 hits each: 5 a day when it came (not 2.5) — 1 a day now is a drop.
    const sparse = days('claudebot', 5, [4, 6, 8, 10, 12, 14, 16]);
    expect(crawlerTrafficHints([...sparse, ...days('claudebot', 1, recent)], today)).toEqual([{ agent: 'claudebot', kind: 'dropped', activeDays: 7, before: 5, after: 1 }]);
    expect(crawlerTrafficHints(sparse, today)).toEqual([{ agent: 'claudebot', kind: 'stopped', activeDays: 7, before: 5, after: 0 }]);
    // 6 days: not steady — no hint either way.
    expect(crawlerTrafficHints(days('claudebot', 5, [4, 6, 8, 10, 12, 14]), today)).toEqual([]);
    // Under 5 a day when it came: too few to call a drop (stopping is still a hint).
    expect(crawlerTrafficHints([...days('ccbot', 4, baseline), ...days('ccbot', 1, [1])], today)).toEqual([]);
  });
});

describe('advice per platform', () => {
  it('scenario Markdown 副本类型错误: how each platform sets the response header', () => {
    expect(reachabilityAdvice('cloudflare-pages', 'wrong-type', 'markdown-copy')).toContain('/*.md\n  Content-Type: text/markdown; charset=utf-8');
    expect(reachabilityAdvice('netlify', 'wrong-type', 'markdown-copy')).toContain('/*.md\n  Content-Type: text/markdown');
    expect(reachabilityAdvice('vercel', 'wrong-type', 'markdown-copy')).toContain('"source": "/(.*).md"');
    expect(reachabilityAdvice('vps', 'wrong-type', 'markdown-copy')).toMatch(/Caddy/);
  });

  it('every platform has advice for every fault code', () => {
    const codes = ['unreachable', 'not-found', 'error-status', 'redirected', 'challenged', 'wrong-type', 'unexpected-noindex', 'missing-noindex', 'exposed', 'robots-differs', 'crawler-blocked', 'crawler-stopped', 'crawler-dropped'] as const;
    for (const p of REACHABILITY_PLATFORMS) for (const c of codes) expect(reachabilityAdvice(p, c, 'page'), `${p} ${c}`).toBeTruthy();
  });
});
