// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
/**
 * Extension signature verification service — the single choke point every
 * install/load path uses so signing is enforced consistently (marketplace
 * install, generic CRUD, sandbox load, hook dispatch).
 *
 * Key resolution merges two sources:
 *   1. the `MARKETPLACE_PUBLIC_KEYS` env var (JSON `{ keyId: pem }`) — env keys
 *      are treated as third-party (`official: false`, `revoked: false`);
 *   2. the `lumibase_publisher_keys` DB table — a DB row OVERRIDES env for the
 *      `official` and `revoked` flags, so a tampered env var can neither mark a
 *      key official nor un-revoke it.
 *
 * `isOfficial` is derived here (name namespace + official-key signature) and is
 * never taken from a client or manifest claim.
 */

import { outboundFetch } from '@heopress/runtime/node';
import { eq } from 'drizzle-orm';
import type { Database } from '@heopress/database';
import { publisherKeys } from '@heopress/database';
import {
  verifyBundle,
  deriveIsOfficial,
  OFFICIAL_NAMESPACE_PREFIX,
  type BundleSignature,
  type ResolvedKey,
  type SignatureAlg,
  type VerifyResult,
  verifyProvenance,
  type ProvenanceReason,
} from '@heopress/contracts/extensions';
import type { Bindings } from '../env';
import { validateOutboundUrl } from './ssrf-guard';

/** Signature metadata as stored on an `extensions` row. */
export interface ExtensionSignatureMeta {
  bundleUrl: string;
  bundleSha256: string | null;
  signature: string | null;
  publisherKeyId: string | null;
  signatureAlg: string | null;
}

export interface VerifyByMetadataResult extends VerifyResult {
  /** Server-derived official flag for the given extension name. */
  isOfficial: boolean;
}

export class ExtensionVerifierService {
  constructor(
    private readonly db: Database,
    private readonly env: Bindings,
  ) {}

  /** Parse the env public-key map (JSON `{ keyId: pem }`). */
  private envKeys(): Record<string, string> {
    const raw = (this.env as unknown as Record<string, string | undefined>)
      .MARKETPLACE_PUBLIC_KEYS;
    if (!raw) return {};
    try {
      return JSON.parse(raw) as Record<string, string>;
    } catch {
      return {};
    }
  }

  /** Resolve a keyId to its key material + trust flags (DB overrides env). */
  async resolveKey(keyId: string): Promise<ResolvedKey | null> {
    const [row] = await this.db
      .select()
      .from(publisherKeys)
      .where(eq(publisherKeys.keyId, keyId))
      .limit(1);
    if (row) {
      return {
        publicKeyPem: row.publicKeyPem,
        publisher: row.publisher,
        official: row.official,
        revoked: row.revoked,
      };
    }
    const pem = this.envKeys()[keyId];
    if (!pem) return null;
    // Env-only keys are never official and never pre-revoked.
    return { publicKeyPem: pem, publisher: keyId, official: false, revoked: false };
  }

  /**
   * Fetch the bundle (SSRF-guarded) and verify its signature, returning the
   * verify result plus the server-derived official flag for `name`.
   */
  async verifyByMetadata(
    name: string,
    meta: ExtensionSignatureMeta,
  ): Promise<VerifyByMetadataResult> {
    const sig: BundleSignature = {
      sha256: meta.bundleSha256,
      signature: meta.signature,
      keyId: meta.publisherKeyId,
      alg: (meta.signatureAlg as SignatureAlg | null) ?? null,
    };

    // Short-circuit before any fetch when required fields are absent.
    if (!sig.sha256 || !sig.signature || !sig.keyId || !sig.alg) {
      const result: VerifyResult = { ok: false, reason: 'missing-fields' };
      return { ...result, isOfficial: false };
    }

    const guard = meta.bundleUrl.startsWith('data:') ? { allowed: true } : validateOutboundUrl(meta.bundleUrl);
    if (!guard.allowed) {
      const result: VerifyResult = { ok: false, reason: 'bad-signature' };
      return { ...result, isOfficial: false };
    }

    let bundleBytes: ArrayBuffer;
    const inline = decodeDataUrl(meta.bundleUrl);
    if (inline) {
      // An inline `data:text/javascript` bundle is verified without a network round trip.
      const result = await verifyBundle(inline, sig, (id) => this.resolveKey(id));
      return { ...result, isOfficial: deriveIsOfficial(name, result) };
    }
    try {
      // Connect-time address checks close the DNS-rebinding gap between
      // validateOutboundUrl above and the download (P03 task 4.4).
      const res = await outboundFetch(meta.bundleUrl, { purpose: 'user' });
      if (!res.ok) {
        return { ok: false, reason: 'bad-signature', isOfficial: false };
      }
      bundleBytes = await res.arrayBuffer();
    } catch {
      return { ok: false, reason: 'bad-signature', isOfficial: false };
    }

    const result = await verifyBundle(bundleBytes, sig, (id) => this.resolveKey(id));
    return { ...result, isOfficial: deriveIsOfficial(name, result) };
  }

  /**
   * Check a marketplace version's build provenance (P12 task 1.5): signed by the bundle's key, naming the signed
   * digest and the repository registered for that key. Never throws.
   */
  async verifyProvenance(
    provenance: unknown,
    meta: { bundleSha256: string; publisherKeyId: string },
  ): Promise<{ ok: boolean; reason: ProvenanceReason }> {
    const [row] = await this.db.select().from(publisherKeys).where(eq(publisherKeys.keyId, meta.publisherKeyId)).limit(1);
    const pem = row?.publicKeyPem ?? this.envKeys()[meta.publisherKeyId];
    if (!pem) return { ok: false, reason: 'bad-signature' };
    return verifyProvenance(provenance, meta.bundleSha256, pem, row?.repository ?? null);
  }

  /** Whether `name` is in the reserved official namespace. */
  static isReservedName(name: string): boolean {
    return name.startsWith(OFFICIAL_NAMESPACE_PREFIX);
  }
}

/** The subset of an `extensions` row the load gate needs. */
export interface LoadableExtensionRow {
  name: string;
  bundleUrl: string;
  bundleSha256: string | null;
  signature: string | null;
  publisherKeyId: string | null;
  signatureAlg: string | null;
  isOfficial: boolean;
}

/**
 * Build the `{ isOfficial, requireSignature, verify }` options a sandbox load
 * needs so signature enforcement is consistent across every load path (dynamic
 * endpoint mount, item-service, hook dispatcher). Official rows verify
 * fail-closed; third-party rows verify when the site policy requires it.
 */
export function buildSandboxVerifyOptions(
  row: LoadableExtensionRow,
  db: Database,
  env: Bindings,
): { isOfficial: boolean; requireSignature: boolean; verify: () => Promise<boolean> } {
  const requireSignature =
    row.isOfficial ||
    signatureRequired(env, row.name) ||
    Boolean(row.signature);

  return {
    isOfficial: row.isOfficial,
    requireSignature,
    verify: async () => {
      const verifier = new ExtensionVerifierService(db, env);
      const verdict = await verifier.verifyByMetadata(row.name, {
        bundleUrl: row.bundleUrl,
        bundleSha256: row.bundleSha256,
        signature: row.signature,
        publisherKeyId: row.publisherKeyId,
        signatureAlg: row.signatureAlg,
      });
      // Official rows must be signed by an official key; third-party just valid.
      return row.isOfficial ? verdict.ok && verdict.isOfficial : verdict.ok;
    },
  };
}

/**
 * Development mode (`HEOPRESS_ENV=development`): the one place unsigned plugins are accepted (P12 task 1.3, spec
 * extensions/permissions "只接受签名插件"). `HEOPRESS_EXT_SIGNATURE_POLICY` no longer relaxes this.
 */
export function isExtensionDevMode(env: Pick<Bindings, 'HEOPRESS_ENV'> | undefined): boolean {
  return env?.HEOPRESS_ENV === 'development';
}

/** Whether installing / loading `name` requires a valid signature: always, except unsigned third-party plugins in development mode. */
export function signatureRequired(env: Pick<Bindings, 'HEOPRESS_ENV'> | undefined, name: string): boolean {
  return ExtensionVerifierService.isReservedName(name) || !isExtensionDevMode(env);
}

/** The bytes of a `data:text/javascript` bundle URL, or null for any other URL. */
function decodeDataUrl(url: string): Uint8Array | null {
  const m = /^data:text\/javascript(;charset=[^;,]+)?(;base64)?,(.*)$/is.exec(url);
  if (!m) return null;
  const body = m[3] ?? '';
  if (m[2]) return Uint8Array.from(atob(body), (ch) => ch.charCodeAt(0));
  return new TextEncoder().encode(decodeURIComponent(body));
}
