// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
/**
 * Auto-install reconciler for official `heopress-*` extensions.
 *
 * For each entry in {@link OFFICIAL_EXTENSIONS} marked `autoInstall`, find the
 * published marketplace source row (siteId null, published, matching slug),
 * verify it signs against an official key, and install a site-scoped row with
 * `enabled = enabledByDefault`.
 *
 * INVARIANT: once a site row exists it is left untouched — the reconciler never
 * flips `enabled` back on. This distinguishes "never installed" from "installed
 * then disabled by an admin", so a defaulted-on extension an operator turned off
 * stays off across reconciles. Missing/invalid source rows are skipped
 * (fail-soft), never fatal — auto-install must never block setup or site create.
 */

import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import type { Database } from '@heopress/database';
import { extensions } from '@heopress/database';
import type { Bindings } from '../env';
import { ExtensionVerifierService } from './extension-verifier';
import { ExtensionMutationError, resolveRequest } from './extensions-service';
import { OFFICIAL_EXTENSIONS } from '../modules/setup/official-extensions';

const LOG_PREFIX = '[heopress-cms] official-ext-reconcile';

function extensionKey(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

export interface ReconcileResult {
  installed: number;
  skipped: number;
}

/**
 * Reconcile official extensions for one site. Safe to call repeatedly and from
 * multiple call sites (setup bootstrap, site-create). Never throws.
 */
export async function reconcileOfficialExtensions(
  db: Database,
  env: Bindings,
  siteId: string,
  log: Pick<Console, 'log' | 'error'> = console,
): Promise<ReconcileResult> {
  const verifier = new ExtensionVerifierService(db, env);
  let installed = 0;
  let skipped = 0;

  for (const entry of OFFICIAL_EXTENSIONS) {
    if (!entry.autoInstall) {
      skipped += 1;
      continue;
    }
    try {
      // Already installed for this site? Leave it — never re-enable.
      const [existing] = await db
        .select({ id: extensions.id })
        .from(extensions)
        .where(and(eq(extensions.siteId, siteId), eq(extensions.name, entry.name)))
        .limit(1);
      if (existing) {
        skipped += 1;
        continue;
      }

      // Find the published marketplace source (global, published, by slug).
      const [source] = await db
        .select()
        .from(extensions)
        .where(
          and(
            eq(extensions.marketplaceSlug, entry.marketplaceSlug),
            isNull(extensions.siteId),
            isNotNull(extensions.publishedAt),
          ),
        )
        .limit(1);
      if (!source) {
        skipped += 1;
        continue;
      }

      // Verify + require official — never auto-install an unofficial bundle.
      const verdict = await verifier.verifyByMetadata(source.name, {
        bundleUrl: source.bundleUrl,
        bundleSha256: source.bundleSha256,
        signature: source.signature,
        publisherKeyId: source.publisherKeyId,
        signatureAlg: source.signatureAlg,
      });
      if (!verdict.ok || !verdict.isOfficial) {
        log.error(`${LOG_PREFIX}: ${entry.name} failed verification (${verdict.reason}) — skipped`);
        skipped += 1;
        continue;
      }

      // Official plugins get no more than any other plugin (P12 task 1.4): exactly the capabilities their
      // listing requests. Without an admin in the loop only extension points, structured data and the plugin's
      // own key-value store are granted outright; anything reaching content, the network, media or secrets
      // waits, disabled, for an admin to confirm it.
      // The same request checks as any install (HeoPress P12 task 9.1): the capability grammar, the extension-point
      // declarations and the HeoPress version range — a listing made for another version is not installed.
      let requested: string[];
      try {
        requested = resolveRequest(
          { name: source.name, capabilities: (source.requestedCapabilities as string[]) ?? [], manifest: (source.manifest as Record<string, unknown>) ?? {} },
          env,
        );
      } catch (err) {
        const code = err instanceof ExtensionMutationError ? err.code : 'INVALID';
        log.error(`${LOG_PREFIX}: ${entry.name} cannot be installed on this instance (${code}) — skipped`);
        skipped += 1;
        continue;
      }
      const autoGrantable = requested.every((c) => c.startsWith('ext:') || c.startsWith('kv:') || c === 'seo:structured-data');
      await db.insert(extensions).values({
        requestedCapabilities: requested,
        permissionsStatus: autoGrantable ? 'approved' : 'reconfirm',
        siteId,
        key: extensionKey(source.name),
        name: source.name,
        version: source.version,
        type: source.type,
        enabled: entry.enabledByDefault && autoGrantable,
        enabledByDefault: entry.enabledByDefault,
        autoInstall: true,
        isOfficial: true,
        verifiedAt: new Date(),
        bundleUrl: source.bundleUrl,
        manifest: source.manifest,
        capabilities: requested,
        bundleSha256: source.bundleSha256,
        signature: source.signature,
        signatureAlg: source.signatureAlg,
        publisherKeyId: source.publisherKeyId,
        publisher: source.publisher,
        marketplaceSlug: source.marketplaceSlug,
      });
      installed += 1;
    } catch (err) {
      log.error(`${LOG_PREFIX}: ${entry.name} errored — skipped`, err);
      skipped += 1;
    }
  }

  return { installed, skipped };
}
