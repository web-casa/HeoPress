import type { KeyProvider } from '@heopress/runtime';
import { arrayBufferToBase64, base64ToArrayBuffer } from '../crypto-service';
import { formatEnvelope, parseEnvelope } from './envelope-codec';

/**
 * Secrets at rest (deployment tokens, storage profile keys, model provider
 * keys): AES-GCM under the runtime KEK, stored as the versioned envelope
 * `{keyId}:{body}` so KEK rotation applies — a secret sealed under a retired
 * key still opens via `keys.getKey(keyId)`.
 *
 * The AAD names what the secret belongs to (`storage-profile|<id>`), so a
 * ciphertext copied onto another row does not open there.
 */

async function importAesKey(base64Key: string, usage: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', base64ToArrayBuffer(base64Key), { name: 'AES-GCM' }, false, usage);
}

export interface SealedSecret {
  /** Versioned envelope (`{keyId}:{body}`) to store. */
  ciphertext: string;
  /** Key version that sealed it. */
  keyId: string;
}

export async function sealSecret(keys: KeyProvider, plaintext: string, aad: string): Promise<SealedSecret> {
  if (!plaintext) throw new Error('Cannot seal an empty secret.');
  const { keyId, key } = await keys.getActiveKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(aad) },
    await importAesKey(key, ['encrypt']),
    new TextEncoder().encode(plaintext),
  );
  const combined = new Uint8Array(iv.length + cipher.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(cipher), iv.length);
  return { ciphertext: formatEnvelope(keyId, arrayBufferToBase64(combined.buffer)), keyId };
}

export async function openSecret(keys: KeyProvider, ciphertext: string, aad: string): Promise<string> {
  const { keyId, body, legacy } = parseEnvelope(ciphertext);
  if (legacy) throw new Error('Secret ciphertext must be a versioned envelope.');
  const combined = new Uint8Array(base64ToArrayBuffer(body));
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: combined.slice(0, 12), additionalData: new TextEncoder().encode(aad) },
    await importAesKey(await keys.getKey(keyId), ['decrypt']),
    combined.slice(12),
  );
  return new TextDecoder().decode(plain);
}
