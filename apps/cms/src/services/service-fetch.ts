import { outboundFetch } from '@heopress/runtime/node';

/**
 * Fetch for configured service connections — model, decision and embedding
 * providers, identity-provider discovery (HeoPress P03 task 4.4). Goes through
 * the platform outbound boundary as `purpose: 'service'`, so an internal
 * address is reachable only when its exact origin is listed in
 * `HEOPRESS_TRUSTED_INTERNAL_ENDPOINTS` (e.g. a self-hosted model server).
 * The ceiling is generous because model calls can be slow; callers keep their
 * own, shorter signals.
 */
export function serviceFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  return outboundFetch(input, { ...init, purpose: 'service', timeoutMs: 300_000 });
}
