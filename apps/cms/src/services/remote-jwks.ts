import { createRemoteJWKSet, customFetch } from 'jose';
import { outboundFetch, type OutboundPurpose } from '@heopress/runtime/node';

/**
 * Remote JWKS whose key fetches go through the platform outbound boundary
 * (HeoPress P03 task 4.4; Codex review 3, #4). `purpose` follows where the
 * URL came from: `service` for a URL an operator configured, `user` for one
 * read from a remote document (an OIDC discovery `jwks_uri` on another
 * origin), so a discovery document cannot point key fetches at a trusted
 * internal service. Metadata addresses are refused either way.
 */
export function guardedRemoteJwks(url: string, purpose: OutboundPurpose): ReturnType<typeof createRemoteJWKSet> {
  return createRemoteJWKSet(new URL(url), {
    [customFetch]: (resource, options) =>
      outboundFetch(resource, { ...options, purpose, timeoutMs: 10_000, maxResponseBytes: 1024 * 1024 }),
  });
}
