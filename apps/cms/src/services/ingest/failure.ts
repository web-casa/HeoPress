import type { FailureCategory } from '@heopress/contracts/schemas';
import { outboundBlockOf } from '@heopress/runtime/node';

/**
 * Why a fetch failed, and whether anything may try again (HeoPress P08 tasks 2.2, 3.3; spec ingest/crawling
 * "访问拒绝不得绕过", design decision 4).
 *
 *   access_denied — 401, 403, 451, robots.txt, an explicit no-AI / TDM reservation: the site said no. Terminal: no
 *                   retry, and the fallback chain (task 3.3) MUST NOT hand the URL to another crawl service.
 *   blocked       — the outbound security boundary refused the address (internal, metadata, credentials in the URL,
 *                   too many redirects, body over the cap). Terminal as well: another service must not fetch it either.
 *   timeout, network, extraction — technical: retry later or try the next service.
 *   other         — anything unrecognised; retryable, never escalated past the chain.
 */
export interface FetchFailureVerdict {
  category: FailureCategory;
  /** True: stop this URL — no retry, no other crawl service. */
  terminal: boolean;
}

/** A failure the fetch pipeline recognised, with its category. */
export class IngestFetchError extends Error {
  readonly category: FailureCategory;
  readonly terminal: boolean;
  readonly httpStatus?: number;
  readonly finalUrl?: string;
  constructor(category: FailureCategory, message: string, opts: { httpStatus?: number; finalUrl?: string } = {}) {
    super(message);
    this.name = 'IngestFetchError';
    this.category = category;
    this.terminal = isTerminal(category);
    this.httpStatus = opts.httpStatus;
    this.finalUrl = opts.finalUrl;
  }
}

function isTerminal(category: FailureCategory): boolean {
  return category === 'access_denied' || category === 'blocked';
}

/** HTTP statuses that mean "you may not have this": terminal. */
const DENIED_STATUSES = new Set([401, 403, 451]);

/** The category of an HTTP status that is not a success; null for 2xx. */
export function classifyHttpStatus(status: number): FetchFailureVerdict | null {
  if (status >= 200 && status < 300) return null;
  if (DENIED_STATUSES.has(status)) return { category: 'access_denied', terminal: true };
  if (status === 408 || status === 429 || status === 504) return { category: 'timeout', terminal: false };
  if (status >= 500) return { category: 'network', terminal: false };
  // 404, 410 and other client errors: the page is not there; retrying later may find it.
  return { category: 'other', terminal: false };
}

/** Classify anything thrown while fetching or extracting. */
export function classifyFetchFailure(err: unknown): FetchFailureVerdict {
  if (err instanceof IngestFetchError) return { category: err.category, terminal: err.terminal };
  if (outboundBlockOf(err)) return { category: 'blocked', terminal: true };
  const name = err instanceof Error ? err.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') return { category: 'timeout', terminal: false };
  const code = codeOf(err);
  if (code && /^(UND_ERR_(CONNECT|HEADERS|BODY)_TIMEOUT|ETIMEDOUT)$/.test(code)) return { category: 'timeout', terminal: false };
  if (code && /^(ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EPIPE|UND_ERR_SOCKET|UND_ERR_CLOSED)$/.test(code)) {
    return { category: 'network', terminal: false };
  }
  if (err instanceof TypeError && /fetch failed/i.test(err.message)) return { category: 'network', terminal: false };
  return { category: 'other', terminal: false };
}

function codeOf(err: unknown): string | null {
  for (let e: unknown = err, depth = 0; e && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return null;
}
