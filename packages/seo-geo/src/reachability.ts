import type { SiteSeoSettings } from '@heopress/contracts/schemas';
import { CRAWLERS, crawlerAllowed, type Crawler } from './crawlers.ts';

/**
 * The online reachability check's rules (HeoPress P07 task 3.9; spec seo/crawl-discovery "线上可达性体检"): what a site's
 * verified domain should answer, and what an answer means. Pure — the CMS reads the site and makes the requests
 * (`apps/cms/src/services/site-network/reachability.ts`); P11's static deployments check their targets by the same rules.
 *
 *   - **Expected results** come from the site's final indexing decision (`decideIndexing`, a page canonical to itself),
 *     its switches (feeds, `llms.txt`, Markdown copies, the news sitemap) and what the deployment target can serve:
 *     what should be public must answer 2xx with the right type; what is turned off, not eligible or not supported must
 *     not be served (any answer but a 2xx). Reachable and discoverable are apart: a noindex page is expected to answer
 *     200 and say noindex (header or meta), never to be missing — a configuration that is as intended is never a fault.
 *   - **AI crawlers** are simulated: the home page requested with a crawler's User-Agent, compared with the same request
 *     as a browser. A crawler the site lets in (and the robots.txt served lets in) but the server refuses or challenges is
 *     "allowed by robots but blocked"; a crawler the site keeps out may be refused. Every simulated result is marked: a
 *     real crawler comes from its operator's addresses, which a CDN may treat otherwise.
 *   - **Traffic**: an AI crawler that read the site steadily and then stopped (or nearly) hints at a block the simulation
 *     cannot see (a rule on the crawler's addresses).
 *   - **Advice** is written for the platform the site is deployed on.
 */

/** Where a site is served from: the advice is written for it. */
export const REACHABILITY_PLATFORMS = ['vps', 'cloudflare', 'cloudflare-pages', 'vercel', 'netlify'] as const;
export type ReachabilityPlatform = (typeof REACHABILITY_PLATFORMS)[number];

/** What a deployment target can serve: a file it cannot is expected absent, not reported as a fault. */
export interface PlatformSupport {
  feeds: boolean;
  llms: boolean;
  markdownCopies: boolean;
  newsSitemap: boolean;
}

const EVERYTHING: PlatformSupport = { feeds: true, llms: true, markdownCopies: true, newsSitemap: true };

/**
 * The platforms: the Classic rendering service on the operator's own server (`vps`, behind Caddy or Nginx) or behind the
 * Cloudflare proxy (`cloudflare`), and the static targets (P11). Each serves every discovery file today — the static
 * build writes the same files and their headers — so `support` is everything; a target that cannot serve one names it.
 */
export const PLATFORMS: Readonly<Record<ReachabilityPlatform, { label: string; isStatic: boolean; support: PlatformSupport }>> = {
  vps: { label: 'Own server (Caddy / Nginx)', isStatic: false, support: EVERYTHING },
  cloudflare: { label: 'Behind Cloudflare', isStatic: false, support: EVERYTHING },
  'cloudflare-pages': { label: 'Cloudflare Pages', isStatic: true, support: EVERYTHING },
  vercel: { label: 'Vercel', isStatic: true, support: EVERYTHING },
  netlify: { label: 'Netlify', isStatic: true, support: EVERYTHING },
};

export type ProbeKind = 'robots' | 'sitemap' | 'sitemap-txt' | 'llms' | 'llms-full' | 'news-sitemap' | 'feed' | 'atom' | 'home' | 'page' | 'markdown-copy';

/** Media types an answer may have (parameters aside). */
const TEXT = ['text/plain'];
const XML = ['application/xml', 'text/xml'];
const HTML = ['text/html'];
const MARKDOWN = ['text/markdown'];
const RSS = ['application/rss+xml', ...XML];
const ATOM = ['application/atom+xml', ...XML];

/** Public: a 2xx of one of `types`; `noindex`: whether it must say noindex (true), must not (false), either (null). */
type ProbeExpectation = { public: true; types: readonly string[]; noindex: boolean | null } | { public: false };

export interface ReachabilityProbe {
  kind: ProbeKind;
  url: string;
  expect: ProbeExpectation;
  /** Why this is expected (shown with the result). */
  because: string;
}

/**
 * A sampled page of the host, at its address on that host: listable (indexable, canonical to itself) or not indexable.
 * On a language entry domain under the subdirectory strategy a page also answers at its content path, but its canonical
 * address (and so its Markdown copy) is on the primary domain: `canonicalHost` false, and its copy there is expected
 * absent (HeoPress P07 task 3.9, Codex review round 1).
 */
export interface SampledPage {
  url: string;
  indexable: boolean;
  /** This host is the page's canonical address's (its copy is served here, when it has one). */
  canonicalHost: boolean;
  /** The address of its Markdown copy on this host; null where it has none to check (the site answers that address otherwise). */
  copy: string | null;
}

export interface ReachabilityPlanInput {
  /** `https://<host>`: one verified domain. */
  origin: string;
  settings: SiteSeoSettings;
  support: PlatformSupport;
  /** The host's home page (its default language's, as the site's language strategy addresses it); null: none on it. */
  home: string | null;
  /** The home page's indexing decision on this site. */
  homeIndexable: boolean;
  pages: SampledPage[];
}

/**
 * The requests a host is checked with and what each should answer: its discovery files (by the site's switches and the
 * target's support), its home page, the sampled pages and their Markdown copies. `robots.txt` comes first: a host that
 * does not answer it is not asked the rest.
 */
export function expectedProbes(input: ReachabilityPlanInput): ReachabilityProbe[] {
  const { settings, support } = input;
  const origin = input.origin.replace(/\/+$/, '');
  const d = settings.discovery;
  const out: ReachabilityProbe[] = [];
  const file = (kind: ProbeKind, path: string, on: boolean, supported: boolean, types: readonly string[], name: string) => {
    if (on && supported) out.push({ kind, url: `${origin}${path}`, expect: { public: true, types, noindex: null }, because: `${name} is on` });
    else out.push({ kind, url: `${origin}${path}`, expect: { public: false }, because: on ? `${name} is not supported by the deployment target` : `${name} is off` });
  };
  file('robots', '/robots.txt', true, true, TEXT, 'robots.txt');
  file('sitemap', '/sitemap.xml', true, true, XML, 'The sitemap');
  file('sitemap-txt', '/sitemap.txt', true, true, TEXT, 'The sitemap');
  file('llms', '/llms.txt', d.llms, support.llms, TEXT, 'llms.txt');
  file('llms-full', '/llms-full.txt', d.llms, support.llms, TEXT, 'llms.txt');
  file('news-sitemap', '/news-sitemap.xml', d.newsSitemap, support.newsSitemap, XML, 'The news sitemap');
  file('feed', '/feed.xml', d.feeds, support.feeds, RSS, 'Feeds');
  file('atom', '/atom.xml', d.feeds, support.feeds, ATOM, 'Feeds');
  if (input.home) {
    out.push({
      kind: 'home',
      url: input.home,
      expect: { public: true, types: HTML, noindex: !input.homeIndexable },
      because: input.homeIndexable ? 'The home page is indexable' : 'The home page is not indexable: it answers and says noindex',
    });
  }
  const copies = d.markdownCopies && support.markdownCopies;
  for (const page of input.pages) {
    out.push({
      kind: 'page',
      url: page.url,
      expect: { public: true, types: HTML, noindex: !page.indexable },
      because: page.indexable ? 'A listable page' : 'A page that is not indexable: it answers and says noindex',
    });
    if (!page.copy) continue;
    if (page.indexable && copies && page.canonicalHost) {
      out.push({ kind: 'markdown-copy', url: page.copy, expect: { public: true, types: MARKDOWN, noindex: true }, because: 'Markdown copies are on and the page is listable' });
    } else {
      out.push({
        kind: 'markdown-copy',
        url: page.copy,
        expect: { public: false },
        because: !page.indexable
          ? 'The page is not indexable: it has no Markdown copy'
          : !page.canonicalHost
            ? 'The Markdown copy is served at the page\'s canonical address only, not on this host'
            : d.markdownCopies
            ? 'Markdown copies are not supported by the deployment target'
            : 'Markdown copies are off',
      });
    }
  }
  return out;
}

/** What an address answered. */
export interface ProbeObservation {
  /** Null: no answer (`error` says why). */
  status: number | null;
  error?: string | null;
  contentType: string | null;
  xRobotsTag: string | null;
  location: string | null;
  /** The robots meta tag of an HTML answer, if any. */
  metaRobots: string | null;
  /** A CDN or firewall challenge instead of the page (`cf-mitigated: challenge`, an interstitial). */
  challenge: boolean;
}

export type ReachabilityCode =
  | 'unreachable'
  | 'not-found'
  | 'error-status'
  | 'redirected'
  | 'challenged'
  | 'wrong-type'
  | 'unexpected-noindex'
  | 'missing-noindex'
  | 'exposed'
  | 'robots-differs'
  | 'crawler-blocked'
  | 'crawler-stopped'
  | 'crawler-dropped';

export type ReachabilitySeverity = 'error' | 'warning' | 'notice';

export interface ProbeVerdict {
  ok: boolean;
  code: ReachabilityCode | null;
  severity: ReachabilitySeverity | null;
  detail: string;
}

/** The media type of a `Content-Type` value, lower case, without parameters. */
function mediaTypeOf(contentType: string | null): string | null {
  const t = contentType?.split(';')[0]?.trim().toLowerCase();
  return t || null;
}

/** Whether robots directives (an `X-Robots-Tag` value or a meta tag's content) say noindex — for any crawler. */
export function saysNoindex(value: string | null): boolean {
  return !!value && /(^|[\s,:])(noindex|none)\s*(,|$)/i.test(value);
}

const pass = (detail: string): ProbeVerdict => ({ ok: true, code: null, severity: null, detail });
const fail = (code: ReachabilityCode, severity: ReachabilitySeverity, detail: string): ProbeVerdict => ({ ok: false, code, severity, detail });

/** An answer against what was expected. */
export function evaluateProbe(probe: ReachabilityProbe, seen: ProbeObservation): ProbeVerdict {
  const s = seen.status;
  if (!probe.expect.public) {
    // Not public: any answer but content. A challenge serves nothing either.
    if (s !== null && s >= 200 && s < 300 && !seen.challenge) return fail('exposed', 'error', `Answered ${s} although it should not be public (${probe.because.toLowerCase()})`);
    return pass(s === null ? 'No answer: not public' : `Answered ${s}: not public, as expected`);
  }
  if (s === null) return fail('unreachable', 'error', `No answer (${seen.error ?? 'connection failed'})`);
  if (seen.challenge) return fail('challenged', 'error', `Answered with a challenge page (${s}) instead of the content`);
  if (s >= 300 && s < 400) return fail('redirected', 'error', `Answered ${s}${seen.location ? ` to ${seen.location}` : ''} instead of the content`);
  if (s === 404 || s === 410) return fail('not-found', 'error', `Answered ${s}`);
  if (s < 200 || s >= 300) return fail('error-status', 'error', `Answered ${s}`);
  const type = mediaTypeOf(seen.contentType);
  if (!type || !probe.expect.types.includes(type)) {
    return fail('wrong-type', 'error', `Served as ${seen.contentType ?? '(no type)'}; expected ${probe.expect.types[0]}`);
  }
  const noindex = saysNoindex(seen.xRobotsTag) || saysNoindex(seen.metaRobots);
  if (probe.expect.noindex === true && !noindex) {
    return fail('missing-noindex', probe.kind === 'markdown-copy' ? 'warning' : 'error', 'Answered without noindex (neither X-Robots-Tag nor the robots meta tag)');
  }
  if (probe.expect.noindex === false && noindex) return fail('unexpected-noindex', 'error', 'Says noindex although the site lets it be indexed');
  return pass(probe.expect.noindex ? `Answered ${s} and says noindex, as expected` : `Answered ${s}`);
}

/** Whether a robots.txt path pattern (`*` any characters, a final `$` the end) matches `/`. */
function patternMatchesRoot(pattern: string): boolean {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`).test('/');
}

/**
 * Whether a robots.txt lets a crawler (its product token) fetch `/` (RFC 9309): the groups naming the token, else the `*`
 * groups, their rules merged; the longest rule matching `/` decides, `Allow` on a tie; none: allowed.
 */
export function robotsAllowsRoot(robots: string, token: string): boolean {
  const groups: Array<{ agents: string[]; rules: Array<{ allow: boolean; path: string }> }> = [];
  let current: (typeof groups)[number] | null = null;
  let inRules = false;
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const field = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (field === 'user-agent') {
      if (!current || inRules) {
        current = { agents: [], rules: [] };
        groups.push(current);
        inRules = false;
      }
      current.agents.push(value.toLowerCase());
    } else if ((field === 'allow' || field === 'disallow') && current) {
      inRules = true;
      current.rules.push({ allow: field === 'allow', path: value });
    }
  }
  const name = token.toLowerCase();
  let matching = groups.filter((g) => g.agents.includes(name));
  if (matching.length === 0) matching = groups.filter((g) => g.agents.includes('*'));
  let best: { allow: boolean; length: number } | null = null;
  for (const rule of matching.flatMap((g) => g.rules)) {
    // An empty Disallow allows everything (it names no path); a rule matches `/` when its pattern does.
    if (!rule.path || !patternMatchesRoot(rule.path)) continue;
    const length = rule.path.length;
    if (!best || length > best.length || (length === best.length && rule.allow)) best = { allow: rule.allow, length };
  }
  return best ? best.allow : true;
}

/** The AI crawlers the check simulates: the known ones that fetch pages themselves (robots-only tokens have no requests). */
const SIMULATED = ['gptbot', 'oai-searchbot', 'chatgpt-user', 'claudebot', 'claude-searchbot', 'claude-user', 'perplexitybot', 'perplexity-user', 'ccbot'];

export const SIMULATED_CRAWLERS: readonly Crawler[] = SIMULATED.map((id) => CRAWLERS.find((c) => c.id === id)!);

/** The note every simulated result carries. */
export const SIMULATION_NOTE = 'Simulated request: the result may differ from the real crawler (real crawlers come from their operators\' addresses).';

/** A crawler's User-Agent as the simulation sends it: its product token in the form its operator documents. */
export function simulatedUserAgent(crawler: Crawler): string {
  return `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ${crawler.userAgent}/1.0${crawler.source ? `; +${crawler.source}` : ''})`;
}

export interface CrawlerVerdict extends ProbeVerdict {
  outcome: 'served' | 'blocked' | 'kept-out' | 'inconclusive';
  /** Always true: the request was made with the crawler's User-Agent, not by the crawler. */
  simulated: true;
}

/**
 * A simulated crawler request. `served`: the robots.txt the host served (null: not read). The site's policy and the
 * served file are compared first (a CDN may serve its own robots.txt); then the answer: refused or challenged while the
 * home page answers a browser is a block — a fault only when robots lets the crawler in.
 */
export function evaluateCrawler(input: { settings: SiteSeoSettings; crawler: Crawler; servedRobots: string | null; baseline: ProbeObservation; seen: ProbeObservation }): CrawlerVerdict {
  const { crawler, seen, baseline } = input;
  const allows = crawlerAllowed(input.settings, crawler);
  const servedAllows = input.servedRobots === null ? null : robotsAllowsRoot(input.servedRobots, crawler.userAgent);
  const verdict = (outcome: CrawlerVerdict['outcome'], v: ProbeVerdict): CrawlerVerdict => ({ ...v, outcome, simulated: true });
  const blocked = seen.status !== null && (seen.challenge || seen.status < 200 || seen.status >= 300);
  const outcome = seen.status === null ? 'inconclusive' : blocked ? (allows ? 'blocked' : 'kept-out') : 'served';
  if (allows && servedAllows === false) {
    return verdict(outcome, fail('robots-differs', 'error', `The site lets ${crawler.userAgent} in, but the robots.txt served keeps it out`));
  }
  if (!allows && servedAllows === true) {
    return verdict(outcome, fail('robots-differs', 'warning', `The site keeps ${crawler.userAgent} out, but the robots.txt served lets it in`));
  }
  const baseOk = baseline.status !== null && baseline.status >= 200 && baseline.status < 300 && !baseline.challenge;
  if (!baseOk) return verdict('inconclusive', pass('The home page does not answer a browser either: see the home page check'));
  // No answer at all (a timeout, a dropped connection — after the caller's retry) while a browser got one: it cannot tell a
  // block from a network hiccup, so it is not reported as one (Codex review of task 3.9, round 1).
  if (seen.status === null) {
    return verdict('inconclusive', pass(`No answer (${seen.error ?? 'connection failed'}) while a browser got ${baseline.status}: inconclusive — check again; a firewall dropping this User-Agent's connections looks the same`));
  }
  if (!blocked) return verdict('served', pass(`Answered ${seen.status}`));
  const answer = seen.challenge ? `a challenge (${seen.status})` : `${seen.status}`;
  if (!allows) return verdict('kept-out', pass(`Answered ${answer}; robots.txt keeps it out too, as the site chose`));
  return verdict('blocked', fail('crawler-blocked', 'error', `robots.txt allows ${crawler.userAgent}, but the request was blocked: ${answer} (a browser gets ${baseline.status})`));
}

/** One AI crawler's hits on one day (UTC, `YYYY-MM-DD`). */
export interface CrawlerDay {
  day: string;
  agent: string;
  hits: number;
}

export interface TrafficHint {
  agent: string;
  kind: 'stopped' | 'dropped';
  /** Days with hits in the 14 days before the last 3. */
  activeDays: number;
  /** Hits per active day before; hits per day in the last 3 complete days. */
  before: number;
  after: number;
}

/** Days compared: the last 3 complete days against the 14 before them; steady: hits on 7 of those 14 at least. */
const RECENT_DAYS = 3;
const BASELINE_DAYS = 14;
const STEADY_DAYS = 7;
/**
 * A drop: the recent rate (hits per day over the last 3 days) at most this share of the earlier one — "降到原来的五分之一
 * 以下" includes exactly one fifth — the earlier rate being hits per day *on the days it was active* (a crawler that came
 * on 7 of 14 days is compared with what it read on those days, not diluted by the days it did not come), from at least
 * this many hits per active day (Codex review of task 3.9, round 1).
 */
const DROP_SHARE = 0.2;
const DROP_FLOOR = 5;

const dayOffset = (today: string, n: number) => new Date(Date.parse(`${today}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

/**
 * AI crawlers that read the site steadily (hits on 7 of the 14 days before the last 3 at least) and then stopped (no hit
 * in the last 3 complete days) or nearly (a fifth of their earlier rate per active day or less): a hint of a block a
 * simulation cannot see. Today is left out (not over yet).
 */
export function crawlerTrafficHints(rows: CrawlerDay[], today: string): TrafficHint[] {
  const recentFrom = dayOffset(today, RECENT_DAYS);
  const baseFrom = dayOffset(today, RECENT_DAYS + BASELINE_DAYS);
  const byAgent = new Map<string, { days: Set<string>; before: number; after: number }>();
  for (const r of rows) {
    if (r.day >= today || r.day < baseFrom || r.hits <= 0) continue;
    const a = byAgent.get(r.agent) ?? { days: new Set<string>(), before: 0, after: 0 };
    if (r.day >= recentFrom) a.after += r.hits;
    else {
      a.before += r.hits;
      a.days.add(r.day);
    }
    byAgent.set(r.agent, a);
  }
  const out: TrafficHint[] = [];
  for (const [agent, a] of [...byAgent].sort(([x], [y]) => (x < y ? -1 : 1))) {
    if (a.days.size < STEADY_DAYS) continue;
    const before = a.before / a.days.size;
    const after = a.after / RECENT_DAYS;
    const round = (n: number) => Math.round(n * 10) / 10;
    if (a.after === 0) out.push({ agent, kind: 'stopped', activeDays: a.days.size, before: round(before), after: 0 });
    else if (before >= DROP_FLOOR && after <= before * DROP_SHARE) out.push({ agent, kind: 'dropped', activeDays: a.days.size, before: round(before), after: round(after) });
  }
  return out;
}

/** The path pattern a header rule names for a kind of answer. */
const PATTERN: Record<ProbeKind, string> = {
  robots: '/robots.txt',
  sitemap: '/sitemap*.xml',
  'sitemap-txt': '/sitemap.txt',
  llms: '/llms.txt',
  'llms-full': '/llms-full.txt',
  'news-sitemap': '/news-sitemap.xml',
  feed: '/feed*.xml',
  atom: '/atom*.xml',
  home: '/',
  page: '/*',
  'markdown-copy': '/*.md',
};

/** The Content-Type each kind should have (what HeoPress sends). */
const SENT_TYPE: Record<ProbeKind, string> = {
  robots: 'text/plain; charset=utf-8',
  sitemap: 'application/xml; charset=utf-8',
  'sitemap-txt': 'text/plain; charset=utf-8',
  llms: 'text/plain; charset=utf-8',
  'llms-full': 'text/plain; charset=utf-8',
  'news-sitemap': 'application/xml; charset=utf-8',
  feed: 'application/rss+xml; charset=utf-8',
  atom: 'application/atom+xml; charset=utf-8',
  home: 'text/html; charset=utf-8',
  page: 'text/html; charset=utf-8',
  'markdown-copy': 'text/markdown; charset=utf-8',
};

const ACCESS: Record<ReachabilityPlatform, string> = {
  vps: 'Check the reverse proxy (Caddy, Nginx) and any firewall or WAF in front of HeoPress (fail2ban, ModSecurity, a hosting firewall) for rules on this User-Agent or its operator\'s addresses; let it through, and keep crawlers out with robots.txt instead.',
  cloudflare:
    'In Cloudflare, check Security → Bots ("Block AI bots", AI Scrapers and Crawlers, Bot Fight Mode), Security → WAF custom and rate limiting rules, and Security → Events filtered by this User-Agent; let the crawler through or skip the rule for it.',
  'cloudflare-pages':
    'In Cloudflare (the zone of the Pages domain), check Security → Bots ("Block AI bots", Bot Fight Mode) and the WAF custom rules; Security → Events shows which rule blocked the request.',
  vercel: 'In Vercel, check Firewall → Bot Protection and AI bots rules, custom rules and Attack Challenge Mode; add a bypass for this User-Agent.',
  netlify: 'In Netlify, check the firewall traffic rules and any edge function or rule that filters by User-Agent or country.',
};

/**
 * What to do about a finding on this platform (spec: "给出对应部署平台的修复建议"; a wrong type: how the platform sets the
 * response header). Null for a code that needs none.
 */
export function reachabilityAdvice(platform: ReachabilityPlatform, code: ReachabilityCode, kind: ProbeKind | null = null): string | null {
  const pattern = kind ? PATTERN[kind] : '/*';
  const type = kind ? SENT_TYPE[kind] : 'text/html; charset=utf-8';
  const isStatic = PLATFORMS[platform].isStatic;
  switch (code) {
    case 'crawler-blocked':
    case 'challenged':
    case 'crawler-stopped':
    case 'crawler-dropped':
      return ACCESS[platform];
    case 'wrong-type':
      switch (platform) {
        case 'vps':
          return `HeoPress sends "${type}"; something in front changes it. In Caddy, do not override Content-Type for proxied answers (or set it: header ${pattern} Content-Type "${type}"); in Nginx, check proxy_hide_header / add_header and the types {} block.`;
        case 'cloudflare':
          return `HeoPress sends "${type}"; check Cloudflare Rules → Transform Rules (response header modification) and any Worker on the route, then purge the cache for ${pattern}.`;
        case 'cloudflare-pages':
          return `Add to the _headers file of the build output:\n${pattern}\n  Content-Type: ${type}`;
        case 'vercel':
          return `Add to vercel.json: { "headers": [{ "source": "${pattern.replace(/\*/g, '(.*)')}", "headers": [{ "key": "Content-Type", "value": "${type}" }] }] }`;
        case 'netlify':
          return `Add to the _headers file (or a [[headers]] block in netlify.toml):\n${pattern}\n  Content-Type: ${type}`;
      }
      break;
    case 'exposed':
      if (isStatic) return 'The file is left over from an earlier build or deployment: remove it from the output and deploy again.';
      return platform === 'cloudflare'
        ? 'HeoPress no longer serves it: purge the Cloudflare cache for this address (Caching → Configuration → Custom Purge) and check Cache Rules that keep answers past their origin.'
        : 'HeoPress no longer serves it: clear any cache in front of it (a proxy cache, a static copy left on the server) and check again.';
    case 'unreachable':
    case 'not-found':
    case 'error-status':
    case 'redirected':
      if (isStatic) return `Check that the build output has ${pattern} and that no redirect or rewrite rule of the platform catches it.`;
      return platform === 'cloudflare'
        ? 'Check the DNS record (proxied) and Cloudflare Redirect Rules, Page Rules and Workers on this route: the request must reach HeoPress with its own Host.'
        : 'Check that the domain points at the server and that the reverse proxy passes every path to the HeoPress rendering service with the original Host (Caddy reverse_proxy, Nginx proxy_pass with proxy_set_header Host $host).';
    case 'missing-noindex':
    case 'unexpected-noindex':
      switch (platform) {
        case 'vps':
          return 'HeoPress sends the robots directives; check that the reverse proxy neither adds nor removes X-Robots-Tag (Caddy header directives, Nginx add_header / proxy_hide_header).';
        case 'cloudflare':
          return 'HeoPress sends the robots directives; check Cloudflare Transform Rules (response header modification) for X-Robots-Tag.';
        case 'cloudflare-pages':
          return 'Preview deployments (*.pages.dev) add X-Robots-Tag: noindex; check the domain serves production, and set X-Robots-Tag in _headers.';
        case 'vercel':
          return 'Preview deployments add X-Robots-Tag: noindex; check the domain is assigned to production, and set X-Robots-Tag in the headers of vercel.json.';
        case 'netlify':
          return 'Deploy previews add X-Robots-Tag: noindex; check the domain serves the production deploy, and set X-Robots-Tag in _headers or netlify.toml.';
      }
      break;
    case 'robots-differs':
      switch (platform) {
        case 'cloudflare':
        case 'cloudflare-pages':
          return 'Cloudflare can serve a managed robots.txt (Security → Bots → "Manage your robots.txt", Content Signals Policy) that adds its own rules: turn it off to serve the site\'s robots.txt, or make the site\'s crawler policy the same.';
        case 'vps':
          return 'Something in front of HeoPress answers /robots.txt itself (a proxy rule or a static file on the server): let HeoPress answer it.';
        default:
          return 'The deployed robots.txt is not the site\'s: deploy again, and check no platform setting adds one.';
      }
  }
  return null;
}
