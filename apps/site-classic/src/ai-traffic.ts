import { createHmac, randomBytes } from 'node:crypto';
import { classifyVisit, CRAWLERS, type Crawler } from '@heopress/seo-geo';

/** The AI crawlers recorded: ordinary search engines are not AI traffic (Codex review of batch 11). */
export const AI_CRAWLERS: readonly Crawler[] = CRAWLERS.filter((c) => c.purpose !== 'search-engine');
import { discoveryFileOf } from './discovery-plan';

/**
 * AI traffic (HeoPress P07 tasks 6.1, 6.4; spec analytics/ai-traffic): every answer of the public site to a known crawler,
 * or to a visit an AI assistant referred, is recorded — cache hits included, previews and requests carrying a token never.
 * What is recorded is the classification, the kind of resource, the path without its query, the status, and a hash of the
 * visitor's address: an HMAC with a key this process draws at start and never stores, over the day, the host and the
 * address — a visitor is the same one within a day and a host, and nobody (not this process the next day, not the
 * database) can recover the address. No User-Agent, referrer or query is written or logged.
 *
 * Writes go through the database's checked entry (`lumibase_record_crawl_hit`) in their own short transaction, off the
 * answer's path, on a connection of their own (`trafficDb`, Codex review of batch 11: never one a page needs) and within
 * a timeout: at most `maxInFlight` (4) at once, the rest dropped (a statistic, never a reason to slow or fail an answer).
 */

export type TrafficResource = 'page' | 'markdown' | 'llms' | 'robots' | 'sitemap' | 'feed' | 'file' | 'other';

export interface CrawlHit {
  host: string;
  kind: 'crawler' | 'referral';
  agent: string;
  operator: string;
  purpose: string | null;
  resource: TrafficResource;
  path: string;
  ipHash: string | null;
  status: number;
}

/** What a path asks for: a discovery file by its kind, a Markdown copy, a page. */
export function resourceOf(path: string): TrafficResource {
  const file = discoveryFileOf(path);
  if (file) {
    if (file.kind === 'robots') return 'robots';
    if (file.kind === 'llms') return 'llms';
    if (file.kind === 'feed') return 'feed';
    if (file.kind === 'root-file') return 'file';
    return 'sitemap';
  }
  if (/\.md$/i.test(path)) return 'markdown';
  const last = path.split('/').pop() ?? '';
  return last.includes('.') ? 'file' : 'page';
}

/** Query parameters that carry a secret: a request with one is not recorded at all (design §访问分析). */
const SECRET_PARAMS = new Set(['token', 'access_token', 'preview', 'preview_token', 'key', 'sig', 'signature', 'auth', 'password', 'session']);

/** Whether a query names a secret parameter — by its decoded name (`%74oken`; Codex review of batch 11, round 2); a query that does not parse counts as one. */
function hasSecret(query: string): boolean {
  if (!query) return false;
  try {
    for (const name of new URLSearchParams(query).keys()) if (SECRET_PARAMS.has(name.trim().toLowerCase())) return true;
    return false;
  } catch {
    return true;
  }
}

/** `utm_source` of a query, or null. */
function utmSourceOf(query: string): string | null {
  try {
    return new URLSearchParams(query).get('utm_source');
  } catch {
    return null;
  }
}

export interface TrafficRequest {
  host: string;
  /** The request path as sent (percent-encoded), without the query. */
  path: string;
  query: string;
  status: number;
  userAgent: string | null | undefined;
  referrer: string | null | undefined;
  /** The visitor's address (the peer, or the trusted proxy's `X-Forwarded-For`). */
  address: string | null;
}

/** The hit a request makes, or null (an ordinary visit, a secret in the query, a path too long to keep). */
export function crawlHitOf(req: TrafficRequest, hash: (day: string, host: string, address: string) => string, crawlers: readonly Crawler[] = AI_CRAWLERS, now = Date.now()): CrawlHit | null {
  if (hasSecret(req.query)) return null;
  if (!req.path.startsWith('/') || req.path.length > 512) return null;
  const visit = classifyVisit({ userAgent: req.userAgent, referrer: req.referrer, utmSource: utmSourceOf(req.query) }, crawlers);
  if (!visit) return null;
  const host = req.host.toLowerCase();
  const day = new Date(now).toISOString().slice(0, 10);
  const common = { host, resource: resourceOf(req.path), path: req.path, ipHash: req.address ? hash(day, host, req.address) : null, status: req.status };
  return visit.kind === 'crawler'
    ? { ...common, kind: 'crawler', agent: visit.crawler.id, operator: visit.crawler.operator, purpose: visit.crawler.purpose }
    : { ...common, kind: 'referral', agent: visit.source.id, operator: visit.source.operator, purpose: null };
}

/** The address hash: keyed by a secret of this process only (drawn at start, never stored or logged). */
export function addressHasher(key: Buffer = randomBytes(32)): (day: string, host: string, address: string) => string {
  return (day, host, address) => createHmac('sha256', key).update(`${day}\u0000${host}\u0000${address}`).digest('hex').slice(0, 32);
}

/** Records hits off the answer's path, at most `maxInFlight` at once; the rest are dropped. */
export class TrafficRecorder {
  private inFlight = 0;
  dropped = 0;
  failed = 0;
  private lastWarning = Number.NEGATIVE_INFINITY;
  constructor(
    private readonly write: (hit: CrawlHit) => Promise<void>,
    private readonly maxInFlight = 4,
    private readonly now: () => number = Date.now,
  ) {}

  record(hit: CrawlHit | null): void {
    if (!hit) return;
    if (this.inFlight >= this.maxInFlight) {
      this.dropped++;
      return;
    }
    this.inFlight++;
    this.write(hit)
      .catch(() => {
        // At most one warning a minute, with the count (round 2: a broken database never floods the log); never the hit.
        this.failed++;
        if (this.now() - this.lastWarning >= 60_000) {
          this.lastWarning = this.now();
          console.warn('[site-classic] AI traffic hits were not recorded', { failed: this.failed, dropped: this.dropped });
        }
      })
      .finally(() => {
        this.inFlight--;
      });
  }

  /** In flight now (tests wait for zero). */
  get pending(): number {
    return this.inFlight;
  }
}
