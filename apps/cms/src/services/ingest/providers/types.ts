import type { FailureCategory } from '@heopress/contracts/schemas';

/**
 * The crawl-service plugin contract (HeoPress P08 task 3.1; design decision 3; spec ingest/crawling
 * "外部采集服务插件").
 *
 * A provider is a first-party module with a **manifest** that declares the hosts it may reach. It never calls
 * `fetch` itself: it gets a `ProviderHttp` bound to its manifest, which refuses any other host before a byte is
 * sent and sends the rest through the platform outbound boundary as a service connection (ADR-0014). The URL it is
 * asked to crawl has already passed the normal outbound check and robots.txt (`chain.ts`); what it returns is
 * extracted, sanitised and quality-checked by the same code as a native fetch.
 */

export const PROVIDER_IDS = ['tinyfish', 'firecrawl', 'crawl4ai', 'cloudflare'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const isProviderId = (v: string): v is ProviderId => (PROVIDER_IDS as readonly string[]).includes(v);

export interface ProviderManifest {
  id: ProviderId;
  /** Exact host names the provider may reach (lower case). */
  hosts: readonly string[];
  /** The provider talks to an endpoint configured per site or per instance (Crawl4AI); its exact origin is allowed too. */
  configurableEndpoint?: boolean;
  /** What the credential is: shown in Studio and the docs. */
  credential: 'api_key' | 'api_token' | 'optional_token';
  /** Options that are not secret and must be set (Cloudflare: the account id). */
  requiredOptions?: ReadonlyArray<'accountId' | 'endpoint'>;
  /** Estimated cost of one request in micro-USD when the response does not say (`budget.ts`). */
  defaultUnitCostMicros: number;
}

export interface CrawlRequest {
  url: string;
  /** The User-Agent the service should identify with, where it lets us choose. */
  userAgent: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface CrawlResult {
  finalUrl: string;
  title: string;
  markdown: string;
  html?: string;
  language?: string | null;
  publishedAt?: string | null;
  author?: string | null;
  /** The target's HTTP status as the service reports it (absent: the service does not say). */
  targetStatus?: number;
  metadata: Record<string, unknown>;
  provider: ProviderId;
  durationMs: number;
  /** Cost in micro-USD when the service reports it (or it follows from what it reports). */
  cost?: number;
}

/** A provider's HTTP access: only to the manifest's hosts (and the configured endpoint). */
export interface ProviderHttp {
  /** The configured endpoint's origin (providers with `configurableEndpoint`), else null. */
  readonly endpoint: string | null;
  request(url: string, init: { method: 'GET' | 'POST'; headers?: Record<string, string>; body?: string; timeoutMs: number; signal?: AbortSignal }): Promise<Response>;
}

export interface ProviderConfig {
  credential: string | null;
  options: { endpoint?: string; accountId?: string };
}

export interface CrawlProvider {
  manifest: ProviderManifest;
  crawl(req: CrawlRequest, ctx: { http: ProviderHttp; config: ProviderConfig }): Promise<CrawlResult>;
}

/**
 * A failure of the service itself (its HTTP status, a malformed answer, a refused key): a technical failure of this
 * step — the chain goes on to the next service. A failure the service reports **about the target** (403 from the
 * site) is an `IngestFetchError` with the target's category instead.
 */
export class ProviderError extends Error {
  constructor(
    readonly provider: ProviderId,
    readonly category: FailureCategory,
    message: string,
    readonly serviceStatus?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** A provider's own HTTP failure as a `ProviderError` (402 / 429: out of quota with the service). */
function providerHttpError(provider: ProviderId, status: number, detail: string): ProviderError {
  const category: FailureCategory = status === 402 || status === 429 ? 'quota' : status === 408 || status === 504 ? 'timeout' : 'network';
  return new ProviderError(provider, category, `${provider} answered HTTP ${status}${detail ? `: ${detail.slice(0, 200)}` : ''}`, status);
}

/** Read a JSON answer, or fail as a provider error. */
export async function readJson(provider: ProviderId, res: Response): Promise<unknown> {
  const text = await res.text();
  if (!res.ok) {
    let detail = '';
    try {
      const v = JSON.parse(text) as { error?: unknown; message?: unknown; errors?: Array<{ message?: unknown }> };
      detail = String(v.error ?? v.message ?? v.errors?.[0]?.message ?? '');
    } catch {
      detail = '';
    }
    throw providerHttpError(provider, res.status, detail);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ProviderError(provider, 'other', `${provider} returned a response that is not JSON`);
  }
}

export const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);
export const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
