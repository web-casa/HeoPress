// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import type { KeyProvider } from '@heopress/runtime';
import { openSecret, sealSecret } from '../crypto/secret-vault';

/**
 * Token vault for deployment integrations (spec: deployment-integrations,
 * design §5). Encrypts Provider API tokens with the runtime KeyProvider
 * (KEK, AES-GCM) so the plaintext never lands in a database column and is
 * never returned by the API.
 *
 * Reuses the same envelope format (`{keyId}:{body}`) as field/DEK encryption
 * so KEK rotation applies uniformly: tokens written under a retired key still
 * decrypt via `keys.getKey(keyId)`, new tokens use `keys.getActiveKey()`.
 *
 * AAD binds the ciphertext to its target so a token envelope cannot be
 * replayed onto a different target row.
 */

/** AAD binding the token ciphertext to its owning site. */
function tokenAad(siteId: string): string {
  return `deploy-token|${siteId}`;
}

export interface EncryptedToken {
  /** Versioned envelope (`{keyId}:{body}`) to store in `token_ciphertext`. */
  ciphertext: string;
  /** Key version that wrapped the token, stored in `token_key_id`. */
  keyId: string;
}

/** Encrypt a Provider token with the active KEK. */
export async function encryptToken(
  keys: KeyProvider,
  plaintext: string,
  siteId: string,
): Promise<EncryptedToken> {
  if (!plaintext) throw new Error('Cannot encrypt an empty token.');
  return sealSecret(keys, plaintext, tokenAad(siteId));
}

/** Decrypt a stored Provider token using the KEK version it was wrapped under. */
export async function decryptToken(
  keys: KeyProvider,
  ciphertext: string,
  siteId: string,
): Promise<string> {
  return openSecret(keys, ciphertext, tokenAad(siteId));
}
