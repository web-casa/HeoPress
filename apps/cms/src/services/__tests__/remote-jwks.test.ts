import { SignJWT, generateKeyPair, jwtVerify } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { guardedRemoteJwks } from '../remote-jwks';
import { jwksSourceFor } from '../../modules/external-auth/adapter';

/**
 * JWKS fetches go through the outbound boundary (P03 task 4.4; Codex review
 * 3, #4): an issuer's discovery document cannot make the server fetch keys
 * from a metadata or internal address.
 */

afterEach(() => vi.restoreAllMocks());

async function token() {
  const { privateKey } = await generateKeyPair('RS256');
  return new SignJWT({ sub: 'u' }).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).sign(privateKey);
}

describe('guarded remote JWKS', () => {
  it('refuses a metadata or internal jwks_uri before anything is sent', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const jwt = await token();
    for (const [url, purpose] of [
      ['http://169.254.169.254/latest/meta-data/jwks', 'service'],
      ['http://10.0.0.5/jwks', 'user'],
      ['http://127.0.0.1:8080/.well-known/jwks.json', 'service'],
    ] as const) {
      await expect(jwtVerify(jwt, guardedRemoteJwks(url, purpose)), url).rejects.toThrow(/outbound request blocked/);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('treats a discovered jwks_uri on another origin as untrusted', () => {
    expect(jwksSourceFor({ jwksUri: 'https://idp.example.test/keys', discoveryUrl: null })).toEqual({
      uri: 'https://idp.example.test/keys',
      purpose: 'service',
    });
    const discovery = { jwksUri: null, discoveryUrl: 'https://idp.example.test/.well-known/openid-configuration' };
    expect(jwksSourceFor(discovery, 'https://idp.example.test/keys').purpose).toBe('service');
    expect(jwksSourceFor(discovery, 'http://internal-admin.test:9000/keys').purpose).toBe('user');
    expect(jwksSourceFor(discovery, 'not a url').purpose).toBe('user');
  });
});
