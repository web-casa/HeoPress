import { outboundBlockOf, outboundFetch, type AddressClass, type OutboundFetchOptions } from '@heopress/runtime/node';
import { classifyHttpStatus, IngestFetchError } from './failure';
import type { HostLimiter } from './host-limiter';
import { RobotsCache, type RobotsFetchResult } from './robots';

/**
 * The native fetcher for ingestion (HeoPress P08 tasks 2.1, 2.2, 2.5; spec ingest/crawling "SSRF 防护", "礼貌抓取").
 *
 * Built on the platform outbound boundary (`outboundFetch`, P03 task 4.4), which already checks every address a host
 * resolves to **inside the connection's DNS lookup** — the address checked is the address connected to, so DNS
 * rebinding has no gap — and caps the body and the time. On top of it this fetcher:
 *
 * - follows redirects itself (at most 5), so every hop is checked by the boundary again **and** against its host's
 *   robots.txt; caller headers other than the User-Agent are dropped when a hop changes origin (cookies and
 *   credentials are never sent in the first place);
 * - applies one deadline (30 s) and one body cap (5 MB) to the whole fetch;
 * - identifies itself (`HEOPRESS_INGEST_USER_AGENT`, or `HeoPressBot/1.0 (+<HEOPRESS_INGEST_CONTACT_URL>)`);
 * - obeys robots.txt for that agent token and an explicit no-AI / TDM reservation in the response headers;
 * - classifies every failure (`failure.ts`).
 *
 * Every URL the pipeline touches — the source URL, discovered links, robots.txt, media, the final URL — goes through
 * `outboundFetch` with `purpose: 'user'`: URLs from content are never trusted internal endpoints (ADR-0014).
 */

const INGEST_MAX_BYTES = 5 * 1024 * 1024;
const INGEST_TIMEOUT_MS = 30_000;
const INGEST_MAX_REDIRECTS = 5;
const ROBOTS_MAX_BYTES = 512 * 1024;
const DEFAULT_AGENT_TOKEN = 'HeoPressBot';

/** The User-Agent ingestion sends. */
export function ingestUserAgent(env: Record<string, string | undefined> = process.env): string {
  if (env.HEOPRESS_INGEST_USER_AGENT?.trim()) return env.HEOPRESS_INGEST_USER_AGENT.trim();
  const contact = env.HEOPRESS_INGEST_CONTACT_URL?.trim() || 'https://example.com/heopress-bot';
  return `${DEFAULT_AGENT_TOKEN}/1.0 (+${contact})`;
}

/** The product token robots.txt groups are matched against: the User-Agent's first word, without a version. */
export function agentTokenOf(userAgent: string): string {
  return (userAgent.split(/[\s/]/)[0] || DEFAULT_AGENT_TOKEN).trim();
}

export interface FetchPageOptions {
  userAgent?: string;
  /** Extra request headers for the first origin only (dropped when a redirect changes origin). */
  headers?: Record<string, string>;
  robots?: RobotsCache;
  /** null: no per-host limit (tests, robots.txt itself). */
  limiter?: HostLimiter | null;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  /** Accepted content types (default HTML / XHTML). */
  accept?: RegExp;
  signal?: AbortSignal;
  /** Test hooks forwarded to the boundary. */
  resolve?: OutboundFetchOptions['resolve'];
  classify?: (ip: string) => AddressClass;
}

export interface FetchedPage {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  headers: Headers;
  body: Buffer;
  durationMs: number;
}

const sharedRobots = new RobotsCache();

const HTML = /^(text\/html|application\/xhtml\+xml)\b/i;

/** True when an `X-Robots-Tag` header or a robots meta value reserves the page against AI / text-and-data mining. */
export function reservesAgainstAi(value: string | null | undefined): boolean {
  if (!value) return false;
  return value
    .toLowerCase()
    .split(/[,\s]+/)
    .some((d) => d === 'noai');
}

/** `tdm-reservation: 1` (W3C TDMRep) */
export function tdmReserved(value: string | null | undefined): boolean {
  return value?.trim() === '1';
}

async function readCapped(res: Response): Promise<Buffer> {
  return Buffer.from(await res.arrayBuffer());
}

/** Fetch one page for ingestion. Throws `IngestFetchError` (or a boundary error, classified by `classifyFetchFailure`). */
export async function fetchPage(input: string, opts: FetchPageOptions = {}): Promise<FetchedPage> {
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? INGEST_TIMEOUT_MS;
  const deadline = started + timeoutMs;
  const userAgent = opts.userAgent ?? ingestUserAgent();
  const token = agentTokenOf(userAgent);
  const robots = opts.robots ?? sharedRobots;
  const maxRedirects = opts.maxRedirects ?? INGEST_MAX_REDIRECTS;
  const maxBytes = opts.maxBytes ?? INGEST_MAX_BYTES;
  const accept = opts.accept ?? HTML;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeoutSignal]) : timeoutSignal;
  const remaining = () => {
    const left = deadline - Date.now();
    if (left <= 0) throw new IngestFetchError('timeout', `fetch took longer than ${timeoutMs} ms`);
    return left;
  };
  const boundary = { purpose: 'user' as const, resolve: opts.resolve, classify: opts.classify };

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new IngestFetchError('blocked', 'URL is invalid');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new IngestFetchError('blocked', 'only http and https URLs are allowed');
  const firstOrigin = url.origin;
  const release = opts.limiter ? await opts.limiter.acquire(url.host, signal) : null;
  try {
    for (let hop = 0; ; hop++) {
      // robots.txt of this hop's origin, fetched through the same boundary.
      const robotsUrl = url;
      const { policy, unavailable } = await robots.policyFor(url.origin, token, () =>
        loadRobots(robotsUrl, userAgent, Math.min(remaining(), 10_000), boundary, signal),
      Date.now(),
      (err) => outboundBlockOf(err) !== null,
      );
      if (unavailable) throw new IngestFetchError('network', `robots.txt of ${url.host} could not be read: ${unavailable}`, { finalUrl: url.href });
      if (!policy.isAllowed(`${url.pathname}${url.search}`)) {
        throw new IngestFetchError('access_denied', `robots.txt of ${url.host} disallows ${url.pathname}`, { finalUrl: url.href });
      }

      const headers: Record<string, string> = {
        'user-agent': userAgent,
        accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
        ...(url.origin === firstOrigin ? stripCredentialHeaders(opts.headers ?? {}) : {}),
      };
      const res = await outboundFetch(url, {
        ...boundary,
        headers,
        method: 'GET',
        maxRedirects: 0,
        returnRedirect: true,
        maxResponseBytes: maxBytes,
        timeoutMs: remaining(),
        signal,
        credentials: 'omit',
      });
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        if (hop >= maxRedirects) throw new IngestFetchError('blocked', `more than ${maxRedirects} redirects`, { httpStatus: res.status, finalUrl: url.href });
        let next: URL;
        try {
          next = new URL(location, url);
        } catch {
          throw new IngestFetchError('other', 'redirect to an invalid URL', { httpStatus: res.status, finalUrl: url.href });
        }
        url = next;
        continue;
      }
      const verdict = classifyHttpStatus(res.status);
      if (verdict) {
        void res.body?.cancel();
        throw new IngestFetchError(verdict.category, `HTTP ${res.status} from ${url.host}`, { httpStatus: res.status, finalUrl: url.href });
      }
      if (reservesAgainstAi(res.headers.get('x-robots-tag')) || tdmReserved(res.headers.get('tdm-reservation'))) {
        void res.body?.cancel();
        throw new IngestFetchError('access_denied', `${url.host} reserves this page against AI use (response headers)`, { httpStatus: res.status, finalUrl: url.href });
      }
      const contentType = res.headers.get('content-type') ?? '';
      if (!accept.test(contentType)) {
        void res.body?.cancel();
        throw new IngestFetchError('extraction', `unsupported content type "${contentType.split(';')[0] || 'none'}"`, { httpStatus: res.status, finalUrl: url.href });
      }
      const body = await readCapped(res);
      return { url: input, finalUrl: url.href, status: res.status, contentType, headers: res.headers, body, durationMs: Date.now() - started };
    }
  } finally {
    await release?.().catch(() => undefined);
  }
}

/**
 * robots.txt and the target's address, checked before a URL is handed to an external crawl service (HeoPress P08
 * tasks 3.3, 3.6): a service must not fetch what the native fetcher may not. Throws `IngestFetchError`
 * (`access_denied`) when robots.txt disallows the URL, an `OutboundBlockedError` (classified `blocked`) when robots.txt
 * cannot even be requested because the host is internal.
 */
export async function assertRobotsAllows(
  input: string,
  opts: Pick<FetchPageOptions, 'userAgent' | 'robots' | 'resolve' | 'classify' | 'signal'> & { timeoutMs?: number } = {},
): Promise<void> {
  const url = new URL(input);
  const userAgent = opts.userAgent ?? ingestUserAgent();
  const robots = opts.robots ?? sharedRobots;
  const boundary = { purpose: 'user' as const, resolve: opts.resolve, classify: opts.classify };
  const signal = opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? 10_000);
  const { policy, unavailable } = await robots.policyFor(
    url.origin,
    agentTokenOf(userAgent),
    () => loadRobots(url, userAgent, opts.timeoutMs ?? 10_000, boundary, signal),
    Date.now(),
    (err) => outboundBlockOf(err) !== null,
  );
  if (unavailable) throw new IngestFetchError('network', `robots.txt of ${url.host} could not be read: ${unavailable}`, { finalUrl: url.href });
  if (!policy.isAllowed(`${url.pathname}${url.search}`)) {
    throw new IngestFetchError('access_denied', `robots.txt of ${url.host} disallows ${url.pathname}`, { finalUrl: url.href });
  }
}

const CREDENTIAL_HEADER = /^(authorization|proxy-authorization|cookie|x-api-key|x-auth-token|api-key)$/i;

function stripCredentialHeaders(h: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(h).filter(([k]) => !CREDENTIAL_HEADER.test(k)));
}

async function loadRobots(
  url: URL,
  userAgent: string,
  timeoutMs: number,
  boundary: { purpose: 'user'; resolve?: OutboundFetchOptions['resolve']; classify?: (ip: string) => AddressClass },
  signal: AbortSignal,
): Promise<RobotsFetchResult> {
  const res = await outboundFetch(new URL('/robots.txt', url.origin), {
    ...boundary,
    headers: { 'user-agent': userAgent, accept: 'text/plain' },
    maxRedirects: 5,
    maxResponseBytes: ROBOTS_MAX_BYTES,
    timeoutMs,
    signal,
    credentials: 'omit',
  });
  if (res.status >= 200 && res.status < 300) {
    try {
      return { kind: 'ok', body: await res.text() };
    } catch (err) {
      // Over the cap or cut off: not readable, so not "no rules" either.
      return { kind: 'unavailable', reason: err instanceof Error ? err.message : String(err) };
    }
  }
  void res.body?.cancel();
  if (res.status >= 400 && res.status < 500) return { kind: 'client_error' };
  return { kind: 'unavailable', reason: `HTTP ${res.status}` };
}
