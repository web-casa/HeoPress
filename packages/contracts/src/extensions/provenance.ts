/**
 * Build provenance for marketplace listings (P12 task 1.5, spec extensions/permissions "只接受签名插件").
 *
 * A marketplace version carries a provenance statement: the source repository, the commit and the build workflow
 * that produced the bundle, plus the bundle's SHA-256. The publisher signs the canonical statement with the same
 * Ed25519 key that signed the bundle. The marketplace accepts the version only when
 *  - the statement is present and well formed,
 *  - its digest is the signed bundle's digest and its signature verifies under the bundle's signing key, and
 *  - its repository is the repository registered for that publisher key.
 */
import { verifyEd25519 } from './signature';

export interface BuildProvenance {
  /** Source repository, `https://<host>/<owner>/<repo>` (no `.git`, no trailing slash). */
  repository: string;
  /** Full 40-hex commit id the bundle was built from. */
  commit: string;
  /** The build pipeline, e.g. `.github/workflows/release.yml`. */
  workflow: string;
  /** SHA-256 (hex) of the built bundle. */
  bundleSha256: string;
  /** Detached Ed25519 signature (base64) over `canonicalProvenance(...)`, by the bundle's signing key. */
  signature: string;
}

export type ProvenanceReason =
  | 'ok'
  | 'missing'
  | 'malformed'
  | 'digest-mismatch'
  | 'bad-signature'
  | 'repository-not-registered'
  | 'repository-mismatch';

/** The bytes the publisher signs: the statement without its signature, keys in fixed order. */
export function canonicalProvenance(p: Omit<BuildProvenance, 'signature'>): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      repository: normalizeRepository(p.repository),
      commit: p.commit.toLowerCase(),
      workflow: p.workflow,
      bundleSha256: p.bundleSha256.toLowerCase(),
    }),
  );
}

/** `https://host/owner/repo` in lowercase, without `.git` or a trailing slash. */
export function normalizeRepository(url: string): string {
  return url.trim().toLowerCase().replace(/\.git$/, '').replace(/\/+$/, '');
}

function wellFormed(p: unknown): p is BuildProvenance {
  if (!p || typeof p !== 'object') return false;
  const o = p as Record<string, unknown>;
  return (
    typeof o.repository === 'string' &&
    /^https:\/\/[a-z0-9.-]+\/[^\s]+$/i.test(o.repository) &&
    typeof o.commit === 'string' &&
    /^[0-9a-f]{40}$/i.test(o.commit) &&
    typeof o.workflow === 'string' &&
    o.workflow.length > 0 &&
    o.workflow.length <= 300 &&
    typeof o.bundleSha256 === 'string' &&
    /^[0-9a-f]{64}$/i.test(o.bundleSha256) &&
    typeof o.signature === 'string' &&
    o.signature.length > 0
  );
}

/**
 * Check a provenance statement against the signed bundle. Never throws.
 * `signedBundleSha256`: the digest the bundle signature covers; `publicKeyPem`: the key that signed the bundle;
 * `registeredRepository`: the repository registered for that key (null when none is).
 */
export async function verifyProvenance(
  provenance: unknown,
  signedBundleSha256: string,
  publicKeyPem: string,
  registeredRepository: string | null,
): Promise<{ ok: boolean; reason: ProvenanceReason }> {
  if (provenance === null || provenance === undefined) return { ok: false, reason: 'missing' };
  if (!wellFormed(provenance)) return { ok: false, reason: 'malformed' };
  if (provenance.bundleSha256.toLowerCase() !== signedBundleSha256.toLowerCase()) {
    return { ok: false, reason: 'digest-mismatch' };
  }
  const { signature, ...statement } = provenance;
  if (!(await verifyEd25519(publicKeyPem, signature, canonicalProvenance(statement)))) {
    return { ok: false, reason: 'bad-signature' };
  }
  if (!registeredRepository) return { ok: false, reason: 'repository-not-registered' };
  if (normalizeRepository(registeredRepository) !== normalizeRepository(provenance.repository)) {
    return { ok: false, reason: 'repository-mismatch' };
  }
  return { ok: true, reason: 'ok' };
}
