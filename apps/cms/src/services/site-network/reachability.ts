import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, isNotNull, isNull, lt, notInArray, or, sql } from 'drizzle-orm';
import { crawlDaily, publicItems, reachabilityReports, reachabilitySites, siteContentSettings, siteDomains, siteSeoSettings, sites, type Database } from '@heopress/database';
import { effectiveSeoSettings, type SiteSeoSettings } from '@heopress/contracts/schemas';
import { markdownUrlOf, publicUrlsOf, type SitePathSpace } from '@heopress/public-site';
import { outboundBlockOf } from '@heopress/runtime/node';
import {
  absoluteUrl,
  crawlerAllowed,
  crawlersOf,
  crawlerTrafficHints,
  decideIndexing,
  evaluateCrawler,
  evaluateProbe,
  expectedProbes,
  pageTypeOfCollection,
  REACHABILITY_PLATFORM_INFO,
  REACHABILITY_PLATFORMS,
  reachabilityAdvice,
  SIMULATED_CRAWLERS,
  SIMULATION_NOTE,
  simulatedUserAgent,
  type ProbeKind,
  type ProbeObservation,
  type ReachabilityCode,
  type ReachabilityPlatform,
  type ReachabilitySeverity,
  type SampledPage,
} from '@heopress/seo-geo';
import { guardedProbe } from '../ssrf-guard';
import { runSiteTransaction } from '../rls-transaction';
import { resolvePublicPath } from './public-path';
import { loadSpace } from './site-rules';

/**
 * The online reachability check (HeoPress P07 task 3.9; spec seo/crawl-discovery "线上可达性体检"): what the site's verified
 * domains actually answer, against what they should — the rules are `@heopress/seo-geo`'s (`reachability.ts`).
 *
 *   - **Only verified domains.** A check is asked for by an administrator for the site's active domains that serve its
 *     pages (the primary domain and language entries); any other host — unbound, pending, disabled, another site's, an
 *     alias that only redirects — is refused (`DOMAIN_NOT_VERIFIED`). The worker checks again when it runs (a domain
 *     disabled since is skipped) and every request it makes is to one of those hosts.
 *   - **Every request through the SSRF boundary** (`guardedProbe`): the address checked at connect time (a verified domain
 *     that resolves to a private or metadata address is refused), no credentials or cookies, a timeout, no redirect
 *     followed (a redirect is reported). Requests are made one at a time with a pause, at most `MAX_HOSTS` hosts, within a
 *     time budget; a check may be asked for once a minute.
 *   - **Expected results** from the final indexing decision (the public projection), the site's switches and the
 *     deployment target; a sample of pages per host (listable ones and one that is not indexable).
 *   - **Simulated AI crawlers**: the home page with each crawler's User-Agent, marked simulated; and **traffic hints** from
 *     the AI traffic totals (`lumibase_crawl_daily`): a crawler the site lets in that stopped reading it.
 *   - Runs in the worker under a lease, as the site audit does; the report replaces the last one, in the site's scope.
 */

/**
 * Hosts a check covers at most; pages sampled per host (listable, not indexable); rows looked at per language to sample
 * them, and languages looked at (those served on a checked host, the ones with their own entry domain first).
 */
const MAX_HOSTS = 5;
const LISTABLE_SAMPLES = 2;
const HIDDEN_SAMPLES = 1;
const SAMPLE_SCAN_PER_LOCALE = 100;
const MAX_SAMPLE_LOCALES = 20;
/** One request's time, the pause between requests, the bytes of an answer read (an HTML head, a robots.txt). */
const REQUEST_TIMEOUT_MS = 10_000;
const PROBE_GAP_MS = 250;
const READ_BYTES = 256 * 1024;
/** The body cap of the boundary: never reached (an answer is read `READ_BYTES` at most, then dropped). */
const BODY_CAP = 256 * 1024 * 1024;
/** A run's time budget and lease; how soon after a run another may be asked for. */
const RUN_BUDGET_MS = 4 * 60_000;
const LEASE_MS = 10 * 60_000;
const COOLDOWN_MS = 60_000;
/** The User-Agent of the ordinary requests: a browser's, naming the check. */
const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 HeoPress-ReachabilityCheck/1.0';

type Tx = Parameters<Parameters<typeof runSiteTransaction>[2]>[0];

export class ReachabilityError extends Error {
  constructor(
    readonly code: 'DOMAIN_NOT_VERIFIED' | 'NO_VERIFIED_DOMAIN' | 'TOO_SOON' | 'INVALID',
    message: string,
    readonly status: 400 | 409 | 422 | 429,
  ) {
    super(message);
    this.name = 'ReachabilityError';
  }
}

/** A domain a check may request: verified (active) and serving the site's pages. */
interface CheckableHost {
  hostname: string;
  primary: boolean;
  locale: string | null;
}

/** The site's checkable domains, the primary first. In the site's scope. */
async function checkableHostsIn(tx: Tx, siteId: string): Promise<CheckableHost[]> {
  const rows = await tx
    .select({ hostname: siteDomains.hostname, primary: siteDomains.isPrimary, locale: siteDomains.entryLocale })
    .from(siteDomains)
    .where(and(eq(siteDomains.siteId, siteId), eq(siteDomains.status, 'active'), or(eq(siteDomains.isPrimary, true), isNotNull(siteDomains.entryLocale))))
    .orderBy(desc(siteDomains.isPrimary), asc(siteDomains.hostname));
  return rows.map((r) => ({ hostname: r.hostname.toLowerCase(), primary: r.primary, locale: r.locale ?? null }));
}

const isPlatform = (v: unknown): v is ReachabilityPlatform => typeof v === 'string' && (REACHABILITY_PLATFORMS as readonly string[]).includes(v);

/** A request's hosts (null: the site's own) and platform (null: as before). */
function parseRequest(input: { hosts?: unknown; platform?: unknown }): { hosts: string[] | null; platform: ReachabilityPlatform | null } {
  if (input.platform !== undefined && input.platform !== null && !isPlatform(input.platform)) {
    throw new ReachabilityError('INVALID', `platform is one of ${REACHABILITY_PLATFORMS.join(', ')}.`, 400);
  }
  let hosts: string[] | null = null;
  if (input.hosts !== undefined && input.hosts !== null) {
    if (!Array.isArray(input.hosts) || input.hosts.some((h) => typeof h !== 'string') || input.hosts.length > MAX_HOSTS) {
      throw new ReachabilityError('INVALID', `hosts is a list of at most ${MAX_HOSTS} domain names.`, 400);
    }
    hosts = [...new Set((input.hosts as string[]).map((h) => h.trim().toLowerCase().replace(/\.$/, '')))];
    if (hosts.length === 0) hosts = null;
  }
  return { hosts, platform: (input.platform as ReachabilityPlatform | null | undefined) ?? null };
}

/**
 * Ask for a check of the site's verified domains (an administrator): `hosts` (at most five; none: the primary domain and
 * the language entries), `platform` (the advice's; none: as last time, else `vps`). A host that is not one of the site's
 * verified serving domains is refused; so is a check within a minute of the last one.
 */
export async function requestReachabilityCheck(db: Database, siteId: string, input: { hosts?: unknown; platform?: unknown }, now = new Date()): Promise<void> {
  const parsed = parseRequest(input);
  const checkable = await runSiteTransaction(db, siteId, (tx) => checkableHostsIn(tx, siteId));
  if (checkable.length === 0) throw new ReachabilityError('NO_VERIFIED_DOMAIN', 'The site has no verified domain to check.', 409);
  for (const h of parsed.hosts ?? []) {
    if (!checkable.some((c) => c.hostname === h)) {
      throw new ReachabilityError('DOMAIN_NOT_VERIFIED', `${h.slice(0, 253)} is not a verified domain serving this site; only those can be checked.`, 422);
    }
  }
  const [state] = await db.select().from(reachabilitySites).where(eq(reachabilitySites.siteId, siteId));
  if (state?.lastRunAt && !state.requestedAt && now.getTime() - state.lastRunAt.getTime() < COOLDOWN_MS) {
    throw new ReachabilityError('TOO_SOON', 'A check ran less than a minute ago.', 429);
  }
  const platform = parsed.platform ?? (isPlatform(state?.platform) ? state.platform : 'vps');
  await db
    .insert(reachabilitySites)
    .values({ siteId, requestedAt: now, platform, hosts: parsed.hosts })
    .onConflictDoUpdate({ target: reachabilitySites.siteId, set: { requestedAt: now, platform, hosts: parsed.hosts } });
}

/** A request of the check: an address and the headers to send. */
export type ProbeFetch = (url: string, init: { headers: Record<string, string>; timeoutMs: number; maxResponseBytes: number }) => Promise<Response>;

export interface ReachabilityDeps {
  /** The HTTP client (default: the SSRF-guarded probe). Tests inject one: no request leaves the process. */
  fetch?: ProbeFetch;
  now?: () => Date;
  /** The pause between requests (tests: none). */
  sleep?: (ms: number) => Promise<void>;
  /** A run's time budget (ms). */
  budgetMs?: number;
  /** Rows looked at per language for the samples (default `SAMPLE_SCAN_PER_LOCALE`; tests: a few). */
  sampleScan?: number;
}

interface CheckResult {
  host: string;
  kind: ProbeKind;
  url: string;
  expected: 'public' | 'absent';
  because: string;
  status: number | null;
  contentType: string | null;
  location: string | null;
  error: string | null;
  ok: boolean;
  skipped: boolean;
  code: ReachabilityCode | null;
  severity: ReachabilitySeverity | null;
  detail: string;
  advice: string | null;
}

interface CrawlerResult {
  host: string;
  crawler: string;
  userAgent: string;
  operator: string;
  purpose: string;
  /** Always true: requested with the crawler's User-Agent, not by the crawler. */
  simulated: true;
  allowedByRobots: boolean;
  status: number | null;
  outcome: 'served' | 'blocked' | 'kept-out' | 'inconclusive' | 'skipped';
  ok: boolean;
  code: ReachabilityCode | null;
  severity: ReachabilitySeverity | null;
  detail: string;
  advice: string | null;
}

interface TrafficResult {
  agent: string;
  operator: string;
  purpose: string;
  kind: 'stopped' | 'dropped';
  activeDays: number;
  before: number;
  after: number;
  severity: 'warning';
  detail: string;
  advice: string | null;
}

export interface ReachabilityReport {
  version: 1;
  platform: ReachabilityPlatform;
  startedAt: string;
  finishedAt: string;
  hosts: Array<CheckableHost & { reachable: boolean | null; skipped: string | null }>;
  checks: CheckResult[];
  crawlers: CrawlerResult[];
  traffic: TrafficResult[];
  /** Every crawler result is simulated: what that means. */
  simulationNote: string;
  summary: { errors: number; warnings: number; passed: number; skipped: number };
  /** The time budget ran out: the requests left were skipped. */
  truncated: boolean;
}

/**
 * The robots directives of an HTML head's meta tags, if any: every `robots` tag (a page may carry several; crawlers
 * combine them, the most restrictive winning) and every `googlebot` one (its directives prefixed `googlebot:`, as an
 * `X-Robots-Tag` names a crawler), joined — a noindex in any of them is a noindex (Codex review of task 3.9, round 1).
 */
function metaRobotsOf(html: string): string | null {
  const found: string[] = [];
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const name = /\bname\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const which = (name?.[1] ?? name?.[2] ?? name?.[3] ?? '').trim().toLowerCase();
    if (which !== 'robots' && which !== 'googlebot') continue;
    const content = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const value = (content?.[1] ?? content?.[2] ?? content?.[3] ?? '').trim();
    found.push(which === 'googlebot' ? value.split(',').map((d) => `googlebot: ${d.trim()}`).join(', ') : value);
  }
  return found.length ? found.join(', ') : null;
}

/** At most `max` bytes of a body, as text; the rest is dropped. */
async function readHead(res: Response, max: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  try {
    while (n < max) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      n += value.byteLength;
    }
  } catch {
    // A body cut short: what was read.
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, max));
}

/** Why a request had no answer, in words safe to keep (no address, no credential). */
function failureOf(err: unknown): string {
  const block = outboundBlockOf(err);
  if (block) return `refused by the outbound policy: ${block.message.replace(/^outbound request blocked: /, '').slice(0, 200)}`;
  const name = err instanceof Error ? err.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') return 'timeout';
  return 'connection failed';
}

const NO_ANSWER = { contentType: null, xRobotsTag: null, location: null, metaRobots: null, challenge: false } as const;

/** One request: what it answered (and, for `read`, its body's first bytes). */
async function observe(send: ProbeFetch, url: string, userAgent: string, read: boolean): Promise<ProbeObservation & { body: string | null }> {
  try {
    const res = await send(url, { headers: { 'user-agent': userAgent, accept: '*/*' }, timeoutMs: REQUEST_TIMEOUT_MS, maxResponseBytes: BODY_CAP });
    const contentType = res.headers.get('content-type');
    const html = /^\s*text\/html/i.test(contentType ?? '');
    const refused = res.status === 403 || res.status === 429 || res.status === 503;
    const body = read || html || refused ? await readHead(res, READ_BYTES) : (void res.body?.cancel().catch(() => undefined), null);
    const challenge =
      (res.headers.get('cf-mitigated') ?? '').toLowerCase() === 'challenge' || (refused && /<title>\s*(just a moment|attention required|access denied)/i.test(body ?? ''));
    return {
      status: res.status,
      error: null,
      contentType,
      xRobotsTag: res.headers.get('x-robots-tag'),
      location: res.headers.get('location'),
      metaRobots: html && body ? metaRobotsOf(body) : null,
      challenge,
      body: read && res.status >= 200 && res.status < 300 ? body : null,
    };
  } catch (err) {
    return { status: null, error: failureOf(err), ...NO_ANSWER, body: null };
  }
}

const hostOf = (url: string | null): string | null => {
  try {
    return url ? new URL(url).host.toLowerCase() : null;
  } catch {
    return null;
  }
};

/** What a run needs from the site, read in its scope. */
async function planOf(db: Database, siteId: string, today: string) {
  return runSiteTransaction(db, siteId, async (tx) => {
    const [row] = await tx.select({ settings: siteSeoSettings.settings }).from(siteSeoSettings).where(eq(siteSeoSettings.siteId, siteId));
    const settings: SiteSeoSettings = effectiveSeoSettings(row?.settings);
    const checkable = await checkableHostsIn(tx, siteId);
    // Each host's home page: the first of the site's languages (its default first) answering on that host, at its address
    // there — the canonical one (a host whose root redirects to a language prefix is checked at the prefix), or a language
    // entry domain's own under the subdirectory strategy (Codex review of task 3.9, round 1: every checked host gets its
    // home, its samples and the simulated crawlers).
    const [site] = await tx.select({ defaultLanguage: sites.defaultLanguage }).from(sites).where(eq(sites.id, siteId));
    const [content] = await tx.select({ locales: siteContentSettings.availableLocales }).from(siteContentSettings).where(eq(siteContentSettings.siteId, siteId));
    const space = await loadSpace(tx, siteId);
    const languages = [...new Set([site?.defaultLanguage ?? 'en', ...((content?.locales as string[] | null | undefined) ?? [])])];
    const homes = new Map<string, string>();
    for (const locale of languages) {
      for (const home of publicUrlsOf(space, locale, '/')) {
        const host = hostOf(home);
        if (host && !homes.has(host)) homes.set(host, home);
      }
    }
    const since = new Date(Date.parse(`${today}T00:00:00Z`) - 17 * 86_400_000).toISOString().slice(0, 10);
    const traffic = (await tx.execute(sql`
      SELECT day::text AS day, agent, sum(hits)::int AS hits FROM ${crawlDaily}
      WHERE ${crawlDaily.siteId} = ${siteId} AND kind = 'crawler' AND purpose IN ('training', 'search', 'user-fetch')
        AND day >= ${since}::date AND day < ${today}::date
      GROUP BY day, agent`)) as unknown as Array<{ day: string; agent: string; hits: number }>;
    return { settings, checkable, homes, space, languages, traffic: traffic.map((t) => ({ day: String(t.day), agent: t.agent, hits: Number(t.hits) })) };
  });
}

/**
 * The samples' candidates: the newest public item pages (taxonomy lists aside) of each language served on a checked host
 * — `perLocale` rows a language, at most `MAX_SAMPLE_LOCALES` languages, those with their own checked entry domain first —
 * so a language entry domain is sampled however much more the other languages publish (Codex review of task 3.9, round
 * 2: one site-wide scan of the newest rows could hold none of its language). Each with its addresses, canonical first.
 * In the site's scope.
 */
async function candidatesOf(db: Database, siteId: string, space: SitePathSpace, languages: string[], hosts: Set<string>, perLocale: number): Promise<Candidate[]> {
  const onChecked = (l: string) => publicUrlsOf(space, l, '/').map((u) => hostOf(u)).filter((h): h is string => !!h && hosts.has(h));
  const served = languages.filter((l) => onChecked(l).length > 0);
  const ownEntry = (l: string) => onChecked(l).some((h) => h !== space.primaryHost);
  const locales = [...served.filter(ownEntry), ...served.filter((l) => !ownEntry(l))].slice(0, MAX_SAMPLE_LOCALES);
  return runSiteTransaction(db, siteId, async (tx) => {
    const out: Candidate[] = [];
    for (const locale of locales) {
      const rows = await tx
        .select({
          locale: publicItems.locale,
          path: publicItems.path,
          collection: publicItems.collection,
          seoRobots: publicItems.seoRobots,
          url: sql<string | null>`${publicItems.card} ->> 'url'`,
          canonical: sql<string | null>`${publicItems.data} ->> 'canonical_url'`,
        })
        .from(publicItems)
        .where(and(eq(publicItems.siteId, siteId), sql`lower(${publicItems.locale}) = lower(${locale})`, sql`${publicItems.collection} NOT IN ('categories', 'tags', 'authors')`))
        .orderBy(sql`${publicItems.publishedAt} DESC NULLS LAST`, asc(publicItems.itemId))
        .limit(perLocale);
      for (const r of rows) out.push({ ...r, addresses: publicUrlsOf(space, r.locale, r.path) });
    }
    return out;
  });
}

/** A sample candidate: a public item page as the projection holds it, with its addresses (canonical first). */
interface Candidate {
  collection: string;
  seoRobots: string | null;
  url: string | null;
  canonical: string | null;
  addresses: string[];
}

/**
 * The host's sampled pages, each at its address on this host (Codex review of task 3.9, round 1: a language entry domain
 * under the subdirectory strategy answers its language's content paths too, though their canonical address is the
 * primary domain's): listable ones and one that is not indexable, each copy's address on this host unless the site
 * answers it otherwise.
 */
async function samplesOf(db: Database, host: string, settings: SiteSeoSettings, candidates: Candidate[]): Promise<SampledPage[]> {
  const listed: Array<{ url: string; canonicalHost: boolean }> = [];
  const hidden: Array<{ url: string; canonicalHost: boolean }> = [];
  for (const c of candidates) {
    const own = absoluteUrl(c.url);
    const here = c.addresses.find((a) => hostOf(a) === host);
    if (!own || !here) continue;
    const { indexable } = decideIndexing({ settings, pageType: pageTypeOfCollection(c.collection), collection: c.collection, itemRobots: c.seoRobots });
    const override = absoluteUrl(c.canonical);
    const sample = { url: here, canonicalHost: hostOf(own) === host };
    // Indexable but canonical to another address: listed nowhere, yet not noindex either — not a sample.
    if (indexable && (!override || override === own) && listed.length < LISTABLE_SAMPLES) listed.push(sample);
    else if (!indexable && hidden.length < HIDDEN_SAMPLES) hidden.push(sample);
    if (listed.length >= LISTABLE_SAMPLES && hidden.length >= HIDDEN_SAMPLES) break;
  }
  const out: SampledPage[] = [];
  for (const [sample, indexable] of [...listed.map((u) => [u, true] as const), ...hidden.map((u) => [u, false] as const)]) {
    let copy = markdownUrlOf(sample.url);
    if (copy) {
      // An address the site answers as something else (a real `.md` route, a redirect): no copy to judge there (the
      // audit reports it: `markdown/address-taken`).
      const at = new URL(copy);
      if ((await resolvePublicPath(db, { host: at.host, path: at.pathname })).kind !== 'not_found') copy = null;
    }
    out.push({ url: sample.url, indexable, canonicalHost: sample.canonicalHost, copy });
  }
  return out;
}

/**
 * Run a site's check now and keep its report. With `token` (the worker's run), the lease is renewed as it goes and the
 * report is kept only while the run still holds it (returns null otherwise).
 */
export async function runReachabilityCheck(
  db: Database,
  siteId: string,
  opts: { platform: ReachabilityPlatform; hosts: string[] | null; token?: string; requestedAt?: Date | null },
  deps: ReachabilityDeps = {},
): Promise<ReachabilityReport | null> {
  const now = deps.now ?? (() => new Date());
  const send = deps.fetch ?? ((url, init) => guardedProbe(url, { method: 'GET', headers: init.headers, timeoutMs: init.timeoutMs, maxResponseBytes: init.maxResponseBytes }));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + (deps.budgetMs ?? RUN_BUDGET_MS);
  const holds = async () => {
    if (!opts.token) return true;
    const renewed = await db
      .update(reachabilitySites)
      .set({ leasedUntil: sql`now() + ${`${LEASE_MS} milliseconds`}::interval` })
      .where(and(eq(reachabilitySites.siteId, siteId), eq(reachabilitySites.leaseToken, opts.token)))
      .returning({ siteId: reachabilitySites.siteId });
    return renewed.length > 0;
  };
  const startedAt = now();
  const today = startedAt.toISOString().slice(0, 10);
  const { settings, checkable, homes, space, languages, traffic } = await planOf(db, siteId, today);
  const platform = opts.platform;
  const support = REACHABILITY_PLATFORM_INFO[platform].support;
  const homeIndexable = decideIndexing({ settings, pageType: 'home', collection: null }).indexable;

  // The hosts: those asked for that are still verified, else the site's own — at most `MAX_HOSTS`.
  const hosts: ReachabilityReport['hosts'] = [];
  for (const h of opts.hosts ?? checkable.map((c) => c.hostname)) {
    const known = checkable.find((c) => c.hostname === h);
    if (!known) hosts.push({ hostname: h, primary: false, locale: null, reachable: null, skipped: 'No longer a verified domain of the site: not requested.' });
    else if (hosts.filter((x) => !x.skipped).length < MAX_HOSTS) hosts.push({ ...known, reachable: null, skipped: null });
  }
  const allowed = new Set(hosts.filter((h) => !h.skipped).map((h) => h.hostname));
  const candidates = await candidatesOf(db, siteId, space, languages, allowed, Math.max(1, deps.sampleScan ?? SAMPLE_SCAN_PER_LOCALE));

  let truncated = false;
  let first = true;
  /** One request to a verified host, paced; null once the budget is spent. */
  const request = async (url: string, userAgent: string, read: boolean) => {
    // Never anything but the verified hosts (the plan's addresses are theirs; this keeps it so).
    if (!allowed.has(hostOf(url) ?? '')) throw new Error('reachability: an address off the verified domains');
    if (Date.now() > deadline) {
      truncated = true;
      return null;
    }
    if (!first) await sleep(PROBE_GAP_MS);
    first = false;
    return observe(send, url, userAgent, read);
  };

  const checks: CheckResult[] = [];
  const crawlers: CrawlerResult[] = [];
  for (const host of hosts) {
    if (host.skipped) continue;
    if (!(await holds())) return null;
    const origin = `https://${host.hostname}`;
    const pages = await samplesOf(db, host.hostname, settings, candidates);
    const probes = expectedProbes({ origin, settings, support, home: homes.get(host.hostname) ?? null, homeIndexable, pages });
    let servedRobots: string | null = null;
    let home: ProbeObservation | null = null;
    for (const probe of probes) {
      const base = { host: host.hostname, kind: probe.kind, url: probe.url, expected: probe.expect.public ? ('public' as const) : ('absent' as const), because: probe.because };
      // A host that does not answer robots.txt is not asked the rest.
      const seen = host.reachable === false ? null : await request(probe.url, BROWSER_UA, probe.kind === 'robots');
      if (!seen) {
        checks.push({ ...base, status: null, contentType: null, location: null, error: null, ok: true, skipped: true, code: null, severity: null, detail: host.reachable === false ? 'Not requested: the host did not answer.' : 'Not requested: the time budget ran out.', advice: null });
        continue;
      }
      if (probe.kind === 'robots') {
        host.reachable = seen.status !== null;
        servedRobots = seen.body;
      }
      if (probe.kind === 'home') home = seen;
      const v = evaluateProbe(probe, seen);
      checks.push({
        ...base,
        status: seen.status,
        contentType: seen.contentType,
        location: seen.location,
        error: seen.error ?? null,
        ok: v.ok,
        skipped: false,
        code: v.code,
        severity: v.severity,
        detail: v.detail,
        advice: v.code ? reachabilityAdvice(platform, v.code, probe.kind) : null,
      });
    }
    // The simulated AI crawlers: the home page with each one's User-Agent, against the browser's answer.
    for (const crawler of SIMULATED_CRAWLERS) {
      const base = { host: host.hostname, crawler: crawler.id, userAgent: crawler.userAgent, operator: crawler.operator, purpose: crawler.purpose, simulated: true as const, allowedByRobots: crawlerAllowed(settings, crawler) };
      let seen = host.reachable === false || !home || home.status === null ? null : await request(homes.get(host.hostname)!, simulatedUserAgent(crawler), false);
      // No answer (a timeout, a dropped connection) while a browser got one: asked once more before anything is said;
      // still none is inconclusive, never a block (Codex review of task 3.9, round 1).
      if (seen && seen.status === null) seen = (await request(homes.get(host.hostname)!, simulatedUserAgent(crawler), false)) ?? seen;
      if (!seen || !home) {
        const why =
          host.reachable === false
            ? 'the host did not answer'
            : home?.status === null
              ? 'the home page did not answer a browser'
              : !home && !truncated
                ? 'the host has no home page to compare with'
                : 'the time budget ran out';
        crawlers.push({ ...base, status: null, outcome: 'skipped', ok: true, code: null, severity: null, detail: `Not requested: ${why}.`, advice: null });
        continue;
      }
      const v = evaluateCrawler({ settings, crawler, servedRobots, baseline: home, seen });
      crawlers.push({ ...base, status: seen.status, outcome: v.outcome, ok: v.ok, code: v.code, severity: v.severity, detail: v.detail, advice: v.code ? reachabilityAdvice(platform, v.code) : null });
    }
  }

  // Traffic hints: crawlers the site lets in that stopped (or nearly) reading it; one it keeps out is expected to.
  const known = new Map(crawlersOf(settings).map((c) => [c.id, c]));
  const trafficHints: TrafficResult[] = crawlerTrafficHints(traffic, today).flatMap((hint) => {
    const crawler = known.get(hint.agent);
    if (!crawler || !crawlerAllowed(settings, crawler)) return [];
    const words =
      hint.kind === 'stopped'
        ? `${crawler.userAgent} read the site on ${hint.activeDays} of 14 days (${hint.before} a day) and not at all in the last 3 days: it may be blocked by a CDN or firewall.`
        : `${crawler.userAgent} read the site ${hint.before} times a day and ${hint.after} a day in the last 3 days: it may be blocked or limited by a CDN or firewall.`;
    return [{ agent: hint.agent, operator: crawler.operator, purpose: crawler.purpose, kind: hint.kind, activeDays: hint.activeDays, before: hint.before, after: hint.after, severity: 'warning' as const, detail: words, advice: reachabilityAdvice(platform, hint.kind === 'stopped' ? 'crawler-stopped' : 'crawler-dropped') }];
  });

  const all = [...checks, ...crawlers, ...trafficHints] as Array<{ severity: ReachabilitySeverity | null; ok?: boolean; skipped?: boolean; outcome?: string }>;
  const report: ReachabilityReport = {
    version: 1,
    platform,
    startedAt: startedAt.toISOString(),
    finishedAt: now().toISOString(),
    hosts,
    checks,
    crawlers,
    traffic: trafficHints,
    simulationNote: SIMULATION_NOTE,
    summary: {
      errors: all.filter((r) => r.severity === 'error').length,
      warnings: all.filter((r) => r.severity === 'warning').length,
      passed: [...checks, ...crawlers].filter((r) => r.ok && !('skipped' in r && r.skipped) && !('outcome' in r && r.outcome === 'skipped')).length,
      skipped: checks.filter((c) => c.skipped).length + crawlers.filter((c) => c.outcome === 'skipped').length,
    },
    truncated,
  };

  return runSiteTransaction(db, siteId, async (tx) => {
    if (opts.token) {
      const [held] = await tx.select({ siteId: reachabilitySites.siteId }).from(reachabilitySites).where(and(eq(reachabilitySites.siteId, siteId), eq(reachabilitySites.leaseToken, opts.token))).for('update');
      if (!held) return null;
    }
    const row = { report: report as unknown as Record<string, unknown>, errors: report.summary.errors, warnings: report.summary.warnings, finishedAt: new Date(report.finishedAt) };
    await tx.insert(reachabilityReports).values({ siteId, ...row }).onConflictDoUpdate({ target: reachabilityReports.siteId, set: row });
    const done = { lastRunAt: sql`now()`, status: 'done', lastError: null };
    if (opts.token) {
      // The lease given back; a request made while it ran stays (it runs again), the one it answered is cleared.
      await tx
        .update(reachabilitySites)
        .set({
          ...done,
          leaseToken: null,
          leasedUntil: null,
          requestedAt: opts.requestedAt
            ? sql`CASE WHEN ${reachabilitySites.requestedAt} > ${opts.requestedAt.toISOString()}::timestamptz THEN ${reachabilitySites.requestedAt} ELSE NULL END`
            : sql`${reachabilitySites.requestedAt}`,
        })
        .where(and(eq(reachabilitySites.siteId, siteId), eq(reachabilitySites.leaseToken, opts.token)));
    } else {
      await tx.insert(reachabilitySites).values({ siteId, platform, lastRunAt: new Date(), status: 'done' }).onConflictDoUpdate({ target: reachabilitySites.siteId, set: done });
    }
    return report;
  });
}

type ReachabilityRunResult = { siteId: string; status: 'done' | 'lost' | 'failed'; error?: string };

/** The worker: requested checks, the longest waiting first, one site at a time within the budget, each under a lease. */
export async function processReachabilityChecks(db: Database, deps: ReachabilityDeps & { workBudgetMs?: number } = {}): Promise<ReachabilityRunResult[]> {
  const until = Date.now() + (deps.workBudgetMs ?? 50_000);
  const out: ReachabilityRunResult[] = [];
  while (Date.now() <= until) {
    const token = randomUUID();
    const taken = await db.transaction(async (tx) => {
      const [row] = await tx
        .select({ siteId: reachabilitySites.siteId, requestedAt: reachabilitySites.requestedAt, platform: reachabilitySites.platform, hosts: reachabilitySites.hosts })
        .from(reachabilitySites)
        .where(
          and(
            isNotNull(reachabilitySites.requestedAt),
            or(isNull(reachabilitySites.leasedUntil), lt(reachabilitySites.leasedUntil, sql`now()`)),
            out.length ? notInArray(reachabilitySites.siteId, out.map((o) => o.siteId)) : undefined,
          ),
        )
        .orderBy(asc(reachabilitySites.requestedAt))
        .limit(1)
        .for('update', { skipLocked: true });
      if (!row) return null;
      await tx
        .update(reachabilitySites)
        .set({ leaseToken: token, leasedUntil: sql`now() + ${`${LEASE_MS} milliseconds`}::interval`, status: 'running' })
        .where(eq(reachabilitySites.siteId, row.siteId));
      return row;
    });
    if (!taken) break;
    try {
      const platform = isPlatform(taken.platform) ? taken.platform : 'vps';
      const report = await runReachabilityCheck(db, taken.siteId, { platform, hosts: taken.hosts, token, requestedAt: taken.requestedAt }, deps);
      out.push({ siteId: taken.siteId, status: report ? 'done' : 'lost' });
    } catch (err) {
      const message = err instanceof Error ? err.message.slice(0, 500) : 'check failed';
      // Its own lease only; the request stays, tried again once the lease runs out; the last report as it was.
      await db.update(reachabilitySites).set({ status: 'failed', lastError: message }).where(and(eq(reachabilitySites.siteId, taken.siteId), eq(reachabilitySites.leaseToken, token)));
      out.push({ siteId: taken.siteId, status: 'failed', error: message });
    }
  }
  return out;
}

export interface ReachabilityView {
  run: { requested: boolean; lastRunAt: string | null; status: string | null; error: string | null; platform: ReachabilityPlatform; hosts: string[] | null };
  report: ReachabilityReport | null;
  /** The domains a check may request. */
  hosts: CheckableHost[];
  platforms: Array<{ id: ReachabilityPlatform; label: string }>;
}

/** The site's last report, its run, and what a request may name. In the site's scope. */
export async function reachabilityViewOf(db: Database, siteId: string): Promise<ReachabilityView> {
  const [run] = await db.select().from(reachabilitySites).where(eq(reachabilitySites.siteId, siteId));
  return runSiteTransaction(db, siteId, async (tx) => {
    const [row] = await tx.select({ report: reachabilityReports.report }).from(reachabilityReports).where(eq(reachabilityReports.siteId, siteId));
    return {
      run: {
        requested: !!run?.requestedAt,
        lastRunAt: run?.lastRunAt?.toISOString() ?? null,
        status: run?.status ?? null,
        error: run?.lastError ?? null,
        platform: isPlatform(run?.platform) ? run.platform : 'vps',
        hosts: run?.hosts ?? null,
      },
      report: (row?.report as unknown as ReachabilityReport | undefined) ?? null,
      hosts: await checkableHostsIn(tx, siteId),
      platforms: REACHABILITY_PLATFORMS.map((id) => ({ id, label: REACHABILITY_PLATFORM_INFO[id].label })),
    };
  });
}
