import { OutboundBlockedError, outboundFetch, parseTrustedEndpoints, trustedEndpointsFromEnv, type AddressClass, type OutboundFetchOptions, type TrustedEndpoints } from '@heopress/runtime/node';
import type { ProviderConfig, ProviderHttp, ProviderManifest } from './types';

/**
 * A provider's network access (HeoPress P08 tasks 3.1, 3.6, 3.7): the manifest is the allow-list.
 *
 * Every request is checked against the manifest's hosts — or, for a provider with a configurable endpoint, that
 * endpoint's exact origin — **before** it is sent; anything else is an `OutboundBlockedError`. Allowed requests go
 * through `outboundFetch` as service connections, so the endpoint itself is still checked at connect time (every
 * resolved address; internal addresses only for an origin in `HEOPRESS_TRUSTED_INTERNAL_ENDPOINTS`, ADR-0014) and a
 * redirect to another origin is refused.
 *
 * The instance's own Crawl4AI (`HEOPRESS_CRAWL4AI_ENDPOINT`, set by the `crawl4ai` compose profile) is trusted as an
 * internal endpoint for the Crawl4AI provider only — the compose profile's automatic registration. A site cannot make
 * an address trusted: an endpoint a site types in is trusted only when the instance owner listed it.
 */

const MAX_PROVIDER_RESPONSE_BYTES = 8 * 1024 * 1024;

/** The instance's self-hosted Crawl4AI origin, from the environment (null: none). */
export function instanceCrawl4aiEndpoint(env: Record<string, string | undefined> = process.env): string | null {
  const raw = env.HEOPRESS_CRAWL4AI_ENDPOINT?.trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}

export interface ProviderHttpOptions {
  env?: Record<string, string | undefined>;
  trusted?: TrustedEndpoints;
  /** Test hooks forwarded to the boundary. */
  resolve?: OutboundFetchOptions['resolve'];
  classify?: (ip: string) => AddressClass;
  /** Test hook: the transport under the boundary checks (default `outboundFetch`). */
  transport?: typeof outboundFetch;
}

/** The endpoint a provider with a configurable endpoint uses: the site's, else the instance's. */
function endpointFor(manifest: ProviderManifest, config: ProviderConfig, env: Record<string, string | undefined> = process.env): string | null {
  if (!manifest.configurableEndpoint) return null;
  const configured = config.options.endpoint?.trim();
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      return null;
    }
  }
  return instanceCrawl4aiEndpoint(env);
}

export function createProviderHttp(manifest: ProviderManifest, config: ProviderConfig, opts: ProviderHttpOptions = {}): ProviderHttp {
  const env = opts.env ?? process.env;
  const endpoint = endpointFor(manifest, config, env);
  const base = opts.trusted ?? trustedEndpointsFromEnv(env);
  const instance = manifest.configurableEndpoint ? instanceCrawl4aiEndpoint(env) : null;
  const trusted: TrustedEndpoints = instance
    ? { origins: new Set([...base.origins, ...parseTrustedEndpoints(instance).origins]), warnings: base.warnings }
    : base;
  const hosts = new Set(manifest.hosts.map((h) => h.toLowerCase()));
  const transport = opts.transport ?? outboundFetch;

  return {
    endpoint,
    async request(raw, init) {
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        throw new OutboundBlockedError(`${manifest.id}: request URL is invalid`);
      }
      const declared = hosts.has(url.hostname.toLowerCase()) && url.protocol === 'https:';
      const configured = endpoint !== null && url.origin === endpoint;
      if (!declared && !configured) {
        throw new OutboundBlockedError(`${manifest.id} may not reach ${url.protocol}//${url.host}: not declared in its manifest`);
      }
      return transport(url, {
        purpose: 'service',
        trusted,
        method: init.method,
        headers: init.headers,
        body: init.body,
        maxRedirects: 2,
        maxResponseBytes: MAX_PROVIDER_RESPONSE_BYTES,
        timeoutMs: init.timeoutMs,
        signal: init.signal,
        credentials: 'omit',
        resolve: opts.resolve,
        classify: opts.classify,
      });
    },
  };
}
