/**
 * One boundary for every outbound HTTP request (HeoPress P03 tasks 4.4–4.5,
 * spec platform/outbound-security; ADR-0014 for trusted internal services).
 *
 * `outboundFetch(url, { purpose, ... })`:
 *   - only http/https, no credentials in the URL;
 *   - every address the host resolves to is checked **at connect time**, in
 *     the dispatcher's DNS lookup, so the address that is checked is the
 *     address that is used — a name that re-resolves to an internal address
 *     between a check and the connection (DNS rebinding) has no gap to use;
 *   - redirects are followed by hand, at most `maxRedirects`, each hop checked
 *     again; credential headers (Authorization, Cookie, API keys, …) are
 *     dropped when a hop changes origin, and a service connection — which
 *     carries its credentials in provider-specific headers — refuses a
 *     cross-origin redirect outright;
 *   - the response body, the total time and the number of hops are capped.
 *
 * Internal addresses (private, loopback, link-local, CGNAT, unique-local, …)
 * are refused unless the request is a **service connection**
 * (`purpose: 'service'`: models, storage, crawler, search, mail) to an origin
 * listed in `HEOPRESS_TRUSTED_INTERNAL_ENDPOINTS`, matching exactly (scheme,
 * host, port). URLs from content or users (`purpose: 'user'`) are never
 * trusted, even when they name a listed origin. A redirect from a trusted
 * origin to any other origin is checked under the normal rules. Cloud
 * metadata addresses are refused in every case, and listing one logs a
 * warning and is ignored.
 */
import dns from 'node:dns';
import { Agent } from 'undici';
import { METADATA_HOSTNAMES, classifyAddress, isIpLiteral, type AddressClass } from './address';

export type OutboundPurpose = 'user' | 'service';

/**
 * Thrown when the boundary refuses a request. `afterResponse`: the refusal
 * came after a response arrived (a redirect it would not follow), so the
 * request itself was sent; otherwise nothing was sent.
 */
export class OutboundBlockedError extends Error {
  readonly afterResponse: boolean;
  constructor(message: string, opts: { afterResponse?: boolean } = {}) {
    super(`outbound request blocked: ${message}`);
    this.name = 'OutboundBlockedError';
    this.afterResponse = opts.afterResponse ?? false;
  }
}

/**
 * The boundary's refusal behind an error, if any: a refusal at connect time
 * (the guarded DNS lookup) reaches the caller wrapped by fetch as the cause
 * of a `TypeError`.
 */
export function outboundBlockOf(err: unknown): OutboundBlockedError | null {
  for (let e: unknown = err, depth = 0; e && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    if (e instanceof OutboundBlockedError) return e;
  }
  return null;
}

export interface TrustedEndpoints {
  origins: ReadonlySet<string>;
  warnings: string[];
}

/**
 * How a rejected entry is named in a warning: scheme, host and port only, so
 * credentials, paths and query strings (API keys) never reach the logs.
 */
function describeEntry(index: number, url?: URL): string {
  if (!url) return `entry #${index + 1}`;
  return `entry #${index + 1} (${url.protocol}//${url.host})`;
}

/** Parse `HEOPRESS_TRUSTED_INTERNAL_ENDPOINTS` (comma-separated origins). */
export function parseTrustedEndpoints(raw: string | undefined): TrustedEndpoints {
  const origins = new Set<string>();
  const warnings: string[] = [];
  const entries = (raw ?? '').split(',').map((e) => e.trim()).filter(Boolean);
  for (const [i, entry] of entries.entries()) {
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      warnings.push(`HEOPRESS_TRUSTED_INTERNAL_ENDPOINTS: ${describeEntry(i)} is not a URL; ignored`);
      continue;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      warnings.push(`HEOPRESS_TRUSTED_INTERNAL_ENDPOINTS: ${describeEntry(i, url)} is not http(s); ignored`);
      continue;
    }
    if (url.username || url.password || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
      warnings.push(`HEOPRESS_TRUSTED_INTERNAL_ENDPOINTS: ${describeEntry(i, url)} must be an origin (scheme://host:port) only; ignored`);
      continue;
    }
    const host = url.hostname.toLowerCase();
    if (METADATA_HOSTNAMES.has(host) || (isIpLiteral(host) && classifyAddress(host) === 'metadata')) {
      warnings.push(`HEOPRESS_TRUSTED_INTERNAL_ENDPOINTS: ${describeEntry(i, url)} is a cloud metadata address and is never trusted; ignored`);
      continue;
    }
    origins.add(url.origin);
  }
  return { origins, warnings };
}

let envTrusted: TrustedEndpoints | null = null;

/** Trusted origins from the process environment, parsed once; warnings logged once. */
export function trustedEndpointsFromEnv(env: Record<string, string | undefined> = process.env): TrustedEndpoints {
  if (!envTrusted) {
    envTrusted = parseTrustedEndpoints(env.HEOPRESS_TRUSTED_INTERNAL_ENDPOINTS);
    for (const w of envTrusted.warnings) console.warn(`[outbound] ${w}`);
  }
  return envTrusted;
}

/** Test hook: forget the parsed environment. */
export function __resetTrustedEndpointsForTests(): void {
  envTrusted = null;
}

export type HostResolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

export interface OutboundFetchOptions extends RequestInit {
  /** `service` for configured service connections; `user` (default) for anything from content or users. */
  purpose?: OutboundPurpose;
  /** Defaults to `HEOPRESS_TRUSTED_INTERNAL_ENDPOINTS`. */
  trusted?: TrustedEndpoints;
  /** Default 5. */
  maxRedirects?: number;
  /**
   * Past `maxRedirects`, answer with the redirect itself (its status and headers, the body dropped) instead of refusing
   * it — for a caller that reports redirects rather than follows them (HeoPress P07 task 3.9: the reachability check
   * says where an address sends a crawler, `maxRedirects: 0`). Default false.
   */
  returnRedirect?: boolean;
  /** Response body cap in bytes (default 10 MiB). */
  maxResponseBytes?: number;
  /** Whole request including redirects and body (default 30 s). */
  timeoutMs?: number;
  /** Extra header names to drop on a cross-origin redirect. */
  credentialHeaders?: string[];
  /** Test hooks. */
  resolve?: HostResolver;
  classify?: (ip: string) => AddressClass;
}

const CREDENTIAL_HEADERS = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'x-api-key',
  'x-auth-token',
  'api-key',
  'x-goog-api-key',
  'x-amz-security-token',
  'ocp-apim-subscription-key',
];

const defaultResolve: HostResolver = (hostname) =>
  dns.promises.lookup(hostname, { all: true, verbatim: true });

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | Array<{ address: string; family: number }>,
  family?: number,
) => void;

/**
 * A `lookup` for `net.connect` / http(s) Agents that resolves a host and
 * refuses it unless every address is allowed — the connect-time check behind
 * `outboundFetch`, reusable by clients with their own HTTP stack (the S3 SDK).
 */
export function guardedLookup(
  allowInternal: boolean,
  resolve: HostResolver = defaultResolve,
  classify: (ip: string) => AddressClass = classifyAddress,
) {
  return (hostname: string, options: { all?: boolean } | number | undefined, callback: LookupCallback): void => {
    const all = typeof options === 'object' && options !== null && options.all === true;
    resolve(hostname).then(
      (addresses) => {
        if (addresses.length === 0) {
          callback(Object.assign(new Error(`${hostname} resolved to no addresses`), { code: 'ENOTFOUND' }), []);
          return;
        }
        for (const a of addresses) {
          const cls = classify(a.address);
          if (cls === 'metadata' || (cls === 'internal' && !allowInternal)) {
            callback(
              new OutboundBlockedError(`${hostname} resolves to a ${cls === 'metadata' ? 'cloud metadata' : 'non-public'} address`),
              [],
            );
            return;
          }
        }
        if (all) callback(null, addresses);
        else callback(null, addresses[0]!.address, addresses[0]!.family);
      },
      (err: NodeJS.ErrnoException) => callback(err, []),
    );
  };
}

function makeAgent(allowInternal: boolean, resolve: HostResolver, classify: (ip: string) => AddressClass): Agent {
  return new Agent({ connect: { lookup: guardedLookup(allowInternal, resolve, classify) as never } });
}

let publicAgent: Agent | null = null;
let trustedAgent: Agent | null = null;

function agentFor(allowInternal: boolean, opts: OutboundFetchOptions): Agent {
  if (opts.resolve || opts.classify) {
    return makeAgent(allowInternal, opts.resolve ?? defaultResolve, opts.classify ?? classifyAddress);
  }
  if (allowInternal) return (trustedAgent ??= makeAgent(true, defaultResolve, classifyAddress));
  return (publicAgent ??= makeAgent(false, defaultResolve, classifyAddress));
}

/** Check a URL as written. Returns whether this hop may reach internal addresses. */
function checkUrl(url: URL, trustedHop: boolean, classify: (ip: string) => AddressClass): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new OutboundBlockedError('only http and https URLs are allowed');
  }
  if (url.username || url.password) throw new OutboundBlockedError('URLs with embedded credentials are not allowed');
  const host = url.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (!host) throw new OutboundBlockedError('URL host is required');
  if (METADATA_HOSTNAMES.has(host)) throw new OutboundBlockedError('cloud metadata hosts are never allowed');
  if (!trustedHop && (host === 'localhost' || host.endsWith('.localhost'))) {
    throw new OutboundBlockedError('localhost is not allowed');
  }
  if (isIpLiteral(host)) {
    const cls = classify(host);
    if (cls === 'metadata') throw new OutboundBlockedError('cloud metadata addresses are never allowed');
    if (cls === 'internal' && !trustedHop) throw new OutboundBlockedError('non-public addresses are not allowed');
  }
}

/**
 * Check a configured service endpoint (storage, search, …) once, at startup,
 * and say whether its connections may reach internal addresses: only when its
 * exact origin is a trusted internal endpoint. Throws OutboundBlockedError
 * for a scheme, credential or metadata problem, or for an internal IP literal
 * that is not trusted.
 */
export function serviceEndpointPolicy(
  endpoint: string,
  trusted: TrustedEndpoints = trustedEndpointsFromEnv(),
): { allowInternal: boolean } {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new OutboundBlockedError(`service endpoint "${endpoint}" is not a URL`);
  }
  const allowInternal = trusted.origins.has(url.origin);
  checkUrl(url, allowInternal, classifyAddress);
  return { allowInternal };
}

function stripCredentials(headers: Headers, extra: string[]): void {
  for (const name of [...CREDENTIAL_HEADERS, ...extra.map((h) => h.toLowerCase())]) headers.delete(name);
}

function limitBody(res: Response, maxBytes: number): Response {
  // Only real Responses carry a stream to cap (test doubles pass through).
  if (!(res instanceof Response)) return res;
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    void res.body?.cancel();
    throw new OutboundBlockedError(`response body of ${declared} bytes exceeds the ${maxBytes}-byte limit`, { afterResponse: true });
  }
  if (!res.body) return res;
  let seen = 0;
  const capped = res.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > maxBytes) {
          controller.error(new OutboundBlockedError(`response body exceeds the ${maxBytes}-byte limit`, { afterResponse: true }));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
  return new Response(capped, { status: res.status, statusText: res.statusText, headers: res.headers });
}

export async function outboundFetch(input: string | URL, options: OutboundFetchOptions = {}): Promise<Response> {
  const {
    purpose = 'user',
    trusted = trustedEndpointsFromEnv(),
    maxRedirects = 5,
    returnRedirect = false,
    maxResponseBytes = 10 * 1024 * 1024,
    timeoutMs = 30_000,
    credentialHeaders = [],
    resolve: _resolve,
    classify = classifyAddress,
    ...init
  } = options;
  void _resolve;

  let url: URL;
  try {
    url = new URL(String(input));
  } catch {
    throw new OutboundBlockedError('URL is invalid');
  }
  const firstOrigin = url.origin;
  const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  // The caller's headers go out untouched until a redirect changes them.
  let headers: RequestInit['headers'] = init.headers;
  let method = (init.method ?? 'GET').toUpperCase();
  let body = init.body;

  for (let hop = 0; ; hop++) {
    // Trust is for the exact listed origin, for service connections, and only
    // while the redirect chain stays on that origin.
    const trustedHop = purpose === 'service' && trusted.origins.has(url.origin) && url.origin === firstOrigin;
    // From the second hop on, the request was already sent once: any refusal
    // now — of the next URL or at its connect-time lookup — happened after a
    // response (Codex review P04-7.1 #2).
    const afterResponse = hop > 0;
    let res: Response;
    try {
      checkUrl(url, trustedHop, classify);
      // First hop: the URL in the form the caller gave it; later hops: strings.
      const target = hop === 0 && input instanceof URL ? url : url.href;
      res = await globalThis.fetch(target, {
        ...init,
        method,
        headers,
        body,
        redirect: 'manual',
        signal,
        dispatcher: agentFor(trustedHop, options),
      } as RequestInit);
    } catch (err) {
      const block = afterResponse ? outboundBlockOf(err) : null;
      if (block && !block.afterResponse) throw new OutboundBlockedError(block.message.replace(/^outbound request blocked: /, ''), { afterResponse: true });
      throw err;
    }

    const location = typeof res.headers?.get === 'function' ? res.headers.get('location') : null;
    if (res.status < 300 || res.status >= 400 || !location) return limitBody(res, maxResponseBytes);

    void res.body?.cancel();
    if (hop >= maxRedirects && returnRedirect) return new Response(null, { status: res.status, statusText: res.statusText, headers: res.headers });
    if (hop >= maxRedirects) throw new OutboundBlockedError(`more than ${maxRedirects} redirects`, { afterResponse: true });
    const next = new URL(location, url);
    if (purpose === 'service' && next.origin !== url.origin) {
      throw new OutboundBlockedError(`a service connection may not follow a redirect to another origin (${next.origin})`, {
        afterResponse: true,
      });
    }
    const nextHeaders = new Headers(headers);
    if (next.origin !== url.origin) stripCredentials(nextHeaders, credentialHeaders);
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
      method = 'GET';
      body = undefined;
      nextHeaders.delete('content-type');
      nextHeaders.delete('content-length');
    }
    headers = nextHeaders;
    url = next;
  }
}
