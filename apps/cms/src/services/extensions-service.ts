// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { extensions, type Database } from '@heopress/database';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { CacheProvider } from '@heopress/runtime';
import type { Bindings } from '../env';
import type { MagicContext } from './permission-dsl';
import { PermissionService, type PermissionAction } from './permission-service';
import { ExtensionVerifierService, signatureRequired, type VerifyByMetadataResult } from './extension-verifier';
import {
  approvalCovers,
  diffCapabilities,
  type CapabilityDiff,
} from '@heopress/contracts/extensions';
import {
  adminDeclarationIssues,
  ManifestDeclarationsSchema,
  manifestCapabilities,
  manifestSupportsVersion,
  manifestVersionRange,
} from '@heopress/contracts/schemas';
import { compareVersions, parseVersion, validateCapabilities } from '@heopress/contracts/extensions';
import cmsPackage from '../../package.json';
import { ExtensionSandbox } from '../extensions/sandbox';
import { patchSchema } from '../utils/patch-schema';
import { validContributions } from '@heopress/seo-geo';
import { runSiteTransaction } from './rls-transaction';
import { flushPublicProjection } from './site-network/public-projection';
import { rebuildRoutes } from './site-network/content-routes';
import { lockContentSettingsExclusive } from './site-network/translation-groups';
import {
  ContentExtensionError,
  contentManifestIssues,
  ensurePluginCollections,
  exportPluginCollections,
  hasContent,
  pluginCollections,
  purgePluginCollections,
  routeConflicts,
  routedCollections,
} from './extensions/content-extensions';
import type { SiteTransaction } from './rls-transaction';

export interface ExtensionsServiceDeps {
  db: Database;
  siteId: string;
  userId?: string | null;
  cache?: CacheProvider;
  env?: Bindings;
  permissionCtx?: MagicContext;
}
export class ExtensionMutationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 403 | 404 | 409,
    /** Machine-readable detail, e.g. the capabilities that need approval. */
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/**
 * Allowed extension slot types. Constrained to an enum so an arbitrary `type`
 * string can never reach the loader's dynamic-mount path.
 */
const EXTENSION_TYPES = [
  'interface', 'display', 'layout', 'panel', 'module',
  'hook', 'endpoint',
] as const;

/**
 * Shallow protocol gate for `bundleUrl` at the API boundary. The runtime
 * `validateExtensionBundleUrl` + `EXTENSION_BUNDLE_ORIGINS` allowlist remain the
 * authoritative SSRF/trust check at load time; this just rejects obviously
 * dangerous schemes (javascript:, vbscript:, file:, blob:) before they are ever
 * persisted. `data:text/javascript` stays permitted to match the loader.
 */
const bundleUrlSchema = z
  .string()
  .min(1)
  .refine(
    (raw) => {
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        return false;
      }
      if (url.protocol === 'https:' || url.protocol === 'http:') return true;
      if (url.protocol === 'data:') return url.pathname.startsWith('text/javascript');
      return false;
    },
    { message: 'bundleUrl must be an https:, http:, or data:text/javascript URL.' },
  );

/** Plugin-manifest declarations allowed in `manifest` next to string metadata (P12 task 1.5). */
const DECLARATION_KEYS = new Set(['outboundHosts', 'heopress', 'compatibleWith', 'storage', 'admin', 'security', 'collections', 'routes', 'templates', 'components']);

const signatureFields = {
  bundleSha256: z.string().regex(/^[0-9a-f]{64}$/).nullish(),
  signature: z.string().min(1).nullish(),
  publisherKeyId: z.string().min(1).nullish(),
  signatureAlg: z.enum(['ed25519', 'rsa-pss-sha256']).nullish(),
};

const manifestSchema = z
  .record(z.string(), z.unknown())
  .default({})
  .superRefine((manifest, ctx) => {
    const declarations: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(manifest)) {
      if (key === 'structuredData') {
        for (const d of validContributions('extension', value).diagnostics) ctx.addIssue({ code: 'custom', path: [key], message: d.message });
      } else if (DECLARATION_KEYS.has(key)) {
        declarations[key] = value;
      } else if (typeof value !== 'string') {
        ctx.addIssue({ code: 'custom', path: [key], message: 'manifest values are strings' });
      }
    }
    const parsed = ManifestDeclarationsSchema.safeParse(declarations);
    if (!parsed.success) for (const issue of parsed.error.issues) ctx.addIssue({ ...issue, code: 'custom', message: issue.message });
    // Admin pages and widgets name declared storage; custom pages name their frontend (P12 task 3.6).
    else for (const issue of adminDeclarationIssues(parsed.data.admin, parsed.data.storage)) ctx.addIssue({ code: 'custom', ...issue });
  });

export const extensionSchema = z.object({
  key: z.string().regex(/^[a-z0-9_:-]+$/).optional(),
  name: z.string(),
  version: z.string(),
  type: z.enum(EXTENSION_TYPES),
  enabled: z.boolean().default(false),
  bundleUrl: bundleUrlSchema,
  /**
   * Manifest values are strings, except `structuredData` (HeoPress P07 task 2.9) and the plugin-manifest
   * declarations (`outboundHosts`, `heopress`, `storage`, `admin`, `security`; P12 task 1.5).
   */
  manifest: manifestSchema,
  /** The capabilities the plugin requests (P12 grammar, `@heopress/contracts/extensions`). */
  capabilities: z.array(z.string()).default([]),
  /** The capabilities the admin approved; must cover every requested one (P12 task 1.2). */
  approvedCapabilities: z.array(z.string()).optional(),
  ...signatureFields,
});

/** An upgrade of an installed plugin to a new version (P12 task 1.2). */
const upgradeSchema = z.object({
  version: z.string().min(1),
  bundleUrl: bundleUrlSchema,
  manifest: manifestSchema,
  capabilities: z.array(z.string()).default([]),
  approvedCapabilities: z.array(z.string()).optional(),
  ...signatureFields,
});

/** PATCH: enable/disable, key/name/manifest metadata and revoking capabilities; never a new version. */
const patchInputSchema = patchSchema(
  extensionSchema.omit({ approvedCapabilities: true, bundleSha256: true, signature: true, publisherKeyId: true, signatureAlg: true }),
);

const approvalSchema = z.object({ approvedCapabilities: z.array(z.string()) });

function extensionKey(input: { key?: string | null; name: string }): string {
  return (
    input.key?.trim() ||
    input.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  );
}

function createActions(input: z.infer<typeof extensionSchema>): PermissionAction[] {
  const actions = new Set<PermissionAction>(['install']);
  if (input.enabled) actions.add('enable');
  if (input.capabilities.length > 0) actions.add('grant_capability');
  return [...actions];
}

function patchActions(input: Partial<z.infer<typeof extensionSchema>>): PermissionAction[] {
  const actions = new Set<PermissionAction>();
  if (Object.prototype.hasOwnProperty.call(input, 'enabled')) actions.add('enable');
  if (Object.prototype.hasOwnProperty.call(input, 'capabilities')) actions.add('grant_capability');
  if (
    ['key', 'name', 'version', 'type', 'bundleUrl', 'manifest'].some((field) =>
      Object.prototype.hasOwnProperty.call(input, field),
    )
  ) {
    actions.add('configure');
  }
  if (!actions.size) actions.add('configure');
  return [...actions];
}

export type ExtensionInput = z.input<typeof extensionSchema>;
export type ExtensionUpgradeInput = z.input<typeof upgradeSchema>;
type ExtensionRow = typeof extensions.$inferSelect;

/** A staged upgrade waiting for the admin's approval (`lumibase_extensions.pending_upgrade`). */
export interface PendingUpgrade {
  version: string;
  bundleUrl: string;
  manifest: Record<string, unknown>;
  requestedCapabilities: string[];
  diff: CapabilityDiff;
  bundleSha256: string | null;
  signature: string | null;
  publisherKeyId: string | null;
  signatureAlg: string | null;
  requestedAt: string;
}

export interface UpgradeResult {
  status: 'upgraded' | 'pending-approval';
  extension: ExtensionRow;
  diff: CapabilityDiff;
}

/** The HeoPress version manifests' ranges are checked against: `HEOPRESS_VERSION`, else this build's package version. */
function currentHeoPressVersion(env?: Pick<Bindings, 'HEOPRESS_VERSION'>): string {
  const candidates = [env?.HEOPRESS_VERSION, typeof process !== 'undefined' ? process.env.HEOPRESS_VERSION : undefined];
  for (const v of candidates) if (v && /^\d+\.\d+\.\d+/.test(v.trim())) return v.trim();
  return cmsPackage.version;
}

/**
 * Capabilities requested by an install / upgrade (`capabilities` plus the manifest's outbound hosts), checked
 * against the grammar and the HeoPress version range. Throws INVALID_CAPABILITY / INCOMPATIBLE_VERSION.
 */
function resolveRequest(
  input: { name: string; capabilities: string[]; manifest: Record<string, unknown> },
  env?: Pick<Bindings, 'HEOPRESS_VERSION'>,
): string[] {
  const manifest = input.manifest as { outboundHosts?: string[]; heopress?: string; compatibleWith?: string };
  const errors = validateCapabilities(input.capabilities).errors;
  if (errors.length > 0) {
    throw new ExtensionMutationError(
      'INVALID_CAPABILITY',
      errors.map((e) => `${e.capability}: ${e.reason}`).join('; '),
      400,
      { errors },
    );
  }
  const version = currentHeoPressVersion(env);
  if (!manifestSupportsVersion(manifest, version)) {
    const required = manifestVersionRange(manifest);
    throw new ExtensionMutationError(
      'INCOMPATIBLE_VERSION',
      `This plugin requires HeoPress ${required}; this instance runs ${version}.`,
      400,
      { required, current: version },
    );
  }
  const requested = manifestCapabilities({ capabilities: input.capabilities, outboundHosts: manifest.outboundHosts });
  // Collections, routes, templates and components (P12 tasks 2.1–2.5): each needs its extension point, and the
  // templates pass the theme engine's checks (no JSON-LD, no script, View Model data only).
  const issues = contentManifestIssues(input.name, input.manifest, requested);
  if (issues.length) throw new ExtensionMutationError('INVALID_MANIFEST', issues.slice(0, 5).join('; '), 400, { issues });
  return requested;
}

/** Throws PERMISSION_APPROVAL_REQUIRED (409) unless `approved` covers `needed`. */
function requireApproval(needed: string[], approved: string[] | undefined, details: Record<string, unknown>): void {
  if (approvalCovers(approved, needed)) return;
  throw new ExtensionMutationError(
    'PERMISSION_APPROVAL_REQUIRED',
    'An admin must approve the capabilities this plugin requests.',
    409,
    { requested: needed, ...details },
  );
}

const SIGNATURE_CODES: Record<string, string> = {
  'missing-fields': 'SIGNATURE_REQUIRED',
  'unknown-key': 'UNKNOWN_PUBLISHER',
  'revoked-key': 'PUBLISHER_REVOKED',
};

/** The signature error for a failed verdict. */
function signatureError(verdict: VerifyByMetadataResult): ExtensionMutationError {
  return new ExtensionMutationError(
    SIGNATURE_CODES[verdict.reason] ?? 'SIGNATURE_INVALID',
    `Signature check failed: ${verdict.reason}`,
    400,
    { reason: verdict.reason },
  );
}

interface SignedBundle {
  name: string;
  bundleUrl: string;
  bundleSha256?: string | null;
  signature?: string | null;
  publisherKeyId?: string | null;
  signatureAlg?: string | null;
}

/** Shared REST/agent write boundary. Missing permission context fails closed. */
export class ExtensionsService {
  constructor(private readonly deps: ExtensionsServiceDeps) {}

  withPermissionContext(ctx: MagicContext | undefined): ExtensionsService {
    if (ctx && ctx.siteId !== this.deps.siteId) throw new Error('PRINCIPAL_SITE_MISMATCH');
    return new ExtensionsService({ ...this.deps, permissionCtx: ctx, userId: ctx?.userId });
  }

  private async require(actions: PermissionAction[]): Promise<void> {
    const ctx = this.deps.permissionCtx;
    if (!ctx || ctx.siteId !== this.deps.siteId) {
      throw new ExtensionMutationError('FORBIDDEN', 'Extension operations require a tenant-bound principal.', 403);
    }
    const permissions = new PermissionService({ db: this.deps.db, cache: this.deps.cache, ctx });
    for (const action of actions) {
      if (!await permissions.canAccess('extensions', action)) {
        throw new ExtensionMutationError('FORBIDDEN', `Action "extensions:${action}" is not allowed.`, 403);
      }
    }
  }

  private get env(): Bindings {
    return this.deps.env ?? ({ HEOPRESS_ENV: 'production' } as Bindings);
  }

  /**
   * Signature gate (P12 task 1.3): outside development mode every plugin must verify against a known, unrevoked
   * publisher key; a supplied signature is verified in development mode too; `heopress-*` needs an official key.
   */
  private async verify(bundle: SignedBundle): Promise<VerifyByMetadataResult> {
    const verifier = new ExtensionVerifierService(this.deps.db, this.env);
    const verdict = await verifier.verifyByMetadata(bundle.name, {
      bundleUrl: bundle.bundleUrl,
      bundleSha256: bundle.bundleSha256 ?? null,
      signature: bundle.signature ?? null,
      publisherKeyId: bundle.publisherKeyId ?? null,
      signatureAlg: bundle.signatureAlg ?? null,
    });
    const reserved = ExtensionVerifierService.isReservedName(bundle.name);
    if (reserved && !verdict.isOfficial) {
      throw new ExtensionMutationError('RESERVED_NAMESPACE', 'heopress-* requires an official signature.', 400);
    }
    const supplied = Boolean(bundle.signature || bundle.publisherKeyId || bundle.bundleSha256);
    if ((signatureRequired(this.env, bundle.name) || supplied) && !verdict.ok) throw signatureError(verdict);
    return verdict;
  }

  async listExtensions() {
    await this.require(['read']);
    return this.deps.db.select().from(extensions).where(eq(extensions.siteId, this.deps.siteId));
  }

  private approver() {
    return { permissionsApprovedAt: new Date(), permissionsApprovedBy: this.deps.userId ?? null };
  }

  async installExtension(raw: ExtensionInput) {
    const input = extensionSchema.parse(raw);
    await this.require(createActions(input));
    const verdict = await this.verify(input);
    const requested = resolveRequest(input, this.env);
    requireApproval(requested, input.approvedCapabilities, {});
    const { approvedCapabilities: _approved, capabilities: _caps, ...rest } = input;
    // One site transaction, the public projection flushed in it: an extension contributing structured data is
    // materialised with its installation (P07 task 2.9).
    const [row] = await this.writeContent(null, (db) => db.insert(extensions).values({
      ...rest, key: extensionKey(input), siteId: this.deps.siteId,
      bundleSha256: input.bundleSha256 ?? null, signature: input.signature ?? null,
      publisherKeyId: input.publisherKeyId ?? null, signatureAlg: input.signatureAlg ?? null,
      capabilities: requested, requestedCapabilities: requested, permissionsStatus: 'approved', ...this.approver(),
      installedBy: this.deps.userId ?? undefined,
      isOfficial: verdict.isOfficial, verifiedAt: verdict.ok ? new Date() : null,
    }).returning());
    if (row) await this.sync(row);
    return row;
  }

  /**
   * Install a published marketplace version (`source`: the global row). The requested capabilities are the
   * listing's; the admin must approve all of them (P12 task 1.2).
   */
  async installFromMarketplace(source: ExtensionRow, approvedCapabilities: string[] | undefined) {
    const listed = (source.requestedCapabilities as string[]) ?? [];
    await this.require(listed.length > 0 ? ['install', 'grant_capability'] : ['install']);
    const verdict = await this.verify(source);
    const requested = resolveRequest({ name: source.name, capabilities: listed, manifest: (source.manifest as Record<string, unknown>) ?? {} }, this.env);
    requireApproval(requested, approvedCapabilities, {});
    const [row] = await this.writeContent(null, (db) => db.insert(extensions).values({
      siteId: this.deps.siteId,
      key: extensionKey({ key: source.marketplaceSlug ?? source.key, name: source.name }),
      name: source.name, version: source.version, type: source.type,
      enabled: source.enabledByDefault, enabledByDefault: source.enabledByDefault, autoInstall: source.autoInstall,
      isOfficial: verdict.isOfficial, verifiedAt: verdict.ok ? new Date() : null,
      bundleUrl: source.bundleUrl, manifest: source.manifest,
      capabilities: requested, requestedCapabilities: requested, permissionsStatus: 'approved', ...this.approver(),
      installedBy: this.deps.userId ?? undefined,
      bundleSha256: source.bundleSha256, signature: source.signature, signatureAlg: source.signatureAlg,
      publisherKeyId: source.publisherKeyId, publisher: source.publisher, marketplaceSlug: source.marketplaceSlug,
    }).returning());
    if (row) await this.sync(row);
    return row;
  }

  private async current(id: string): Promise<ExtensionRow> {
    const [row] = await this.deps.db.select().from(extensions)
      .where(and(eq(extensions.siteId, this.deps.siteId), eq(extensions.id, id))).limit(1);
    if (!row) throw new ExtensionMutationError('NOT_FOUND', 'Extension not found.', 404);
    return row;
  }

  async updateExtension(id: string, raw: Partial<ExtensionInput>) {
    const input = patchInputSchema.parse(raw);
    await this.require(patchActions(input));
    const current = await this.current(id);
    if (Object.keys(input).length === 0) return current;
    // A new version, bundle or slot type goes through the upgrade flow and its permission diff (P12 task 1.2).
    for (const field of ['version', 'bundleUrl', 'type'] as const) {
      if (input[field] !== undefined && input[field] !== current[field]) {
        throw new ExtensionMutationError('USE_UPGRADE', `Change "${field}" with POST /extensions/:id/upgrade.`, 400);
      }
    }
    if (input.manifest) {
      const before = (current.manifest as Record<string, unknown>) ?? {};
      // The declarations an admin approved with the version (P12): the version range, hosts, and the content extensions.
      for (const key of ['outboundHosts', 'heopress', 'compatibleWith', 'collections', 'routes', 'templates', 'components']) {
        if (JSON.stringify(input.manifest[key]) !== JSON.stringify(before[key])) {
          throw new ExtensionMutationError('USE_UPGRADE', `Change "manifest.${key}" with POST /extensions/:id/upgrade.`, 400);
        }
      }
    }
    // PATCH may only revoke: never grant a capability the plugin did not request and the admin did not approve.
    if (input.capabilities) {
      const granted = new Set((current.capabilities as string[]) ?? []);
      const extra = input.capabilities.filter((c) => !granted.has(c));
      if (extra.length > 0) {
        throw new ExtensionMutationError('CAPABILITY_NOT_APPROVED', `Not requested and approved: ${extra.join(', ')}.`, 400, { capabilities: extra });
      }
    }
    if (input.enabled === true && current.isOfficial && !current.verifiedAt) {
      throw new ExtensionMutationError('SIGNATURE_REQUIRED', 'Cannot enable an unverified official extension.', 400);
    }
    if (input.enabled === true && !current.enabled && current.permissionsStatus !== 'approved') {
      throw new ExtensionMutationError(
        'PERMISSIONS_RECONFIRM_REQUIRED',
        'An admin must confirm this plugin\'s capabilities before it can be enabled.',
        409,
        { capabilities: current.capabilities },
      );
    }
    const where = and(eq(extensions.siteId, this.deps.siteId), eq(extensions.id, id));
    const [row] = await this.writeContent(current, (db) => db.update(extensions).set(input).where(where).returning());
    if (!row) throw new ExtensionMutationError('NOT_FOUND', 'Extension not found.', 404);
    await this.sync(row);
    return row;
  }

  /**
   * Upgrade an installed plugin (P12 task 1.2). Capabilities the new version adds need the admin's approval: without
   * it the version is staged in `pending_upgrade` and the installed one keeps running. Removed capabilities are
   * dropped without approval. `marketplace: true` upgrades to the newest published version of the listing.
   */
  async upgradeExtension(id: string, raw: ExtensionUpgradeInput | { marketplace: true; approvedCapabilities?: string[] }): Promise<UpgradeResult> {
    const current = await this.current(id);
    const input = 'marketplace' in raw && raw.marketplace ? await this.latestListing(current, raw.approvedCapabilities) : upgradeSchema.parse(raw);
    await this.require(['configure']);
    await this.verify({ ...input, name: current.name });
    const requested = resolveRequest({ ...input, name: current.name }, this.env);
    const diff = diffCapabilities((current.capabilities as string[]) ?? [], requested);
    const staged: PendingUpgrade = {
      version: input.version, bundleUrl: input.bundleUrl, manifest: input.manifest,
      requestedCapabilities: requested, diff,
      bundleSha256: input.bundleSha256 ?? null, signature: input.signature ?? null,
      publisherKeyId: input.publisherKeyId ?? null, signatureAlg: input.signatureAlg ?? null,
      requestedAt: new Date().toISOString(),
    };
    if (diff.added.length > 0 && !approvalCovers(input.approvedCapabilities, diff.added)) {
      const where = and(eq(extensions.siteId, this.deps.siteId), eq(extensions.id, id));
      const [row] = await this.deps.db.update(extensions).set({ pendingUpgrade: staged }).where(where).returning();
      return { status: 'pending-approval', extension: row!, diff };
    }
    if (diff.added.length > 0) await this.require(['grant_capability']);
    return { status: 'upgraded', extension: await this.applyUpgrade(current, staged), diff };
  }

  private async latestListing(current: ExtensionRow, approvedCapabilities?: string[]) {
    if (!current.marketplaceSlug) throw new ExtensionMutationError('NOT_FOUND', 'Not a marketplace extension.', 404);
    const rows = await this.deps.db.select().from(extensions)
      .where(and(eq(extensions.marketplaceSlug, current.marketplaceSlug), isNull(extensions.siteId), isNotNull(extensions.publishedAt)));
    const newer = rows.filter((r) => compareVersionStrings(r.version, current.version) > 0)
      .sort((a, b) => compareVersionStrings(b.version, a.version))[0];
    if (!newer) throw new ExtensionMutationError('NOT_FOUND', 'No newer published version.', 404);
    return {
      version: newer.version, bundleUrl: newer.bundleUrl, manifest: (newer.manifest as Record<string, unknown>) ?? {},
      capabilities: (newer.requestedCapabilities as string[]) ?? [], approvedCapabilities,
      bundleSha256: newer.bundleSha256, signature: newer.signature, publisherKeyId: newer.publisherKeyId,
      signatureAlg: newer.signatureAlg as 'ed25519' | 'rsa-pss-sha256' | null,
    };
  }

  private async applyUpgrade(current: ExtensionRow, staged: PendingUpgrade): Promise<ExtensionRow> {
    const where = and(eq(extensions.siteId, this.deps.siteId), eq(extensions.id, current.id));
    const [row] = await this.writeContent(current, (db) => db.update(extensions).set({
      version: staged.version, bundleUrl: staged.bundleUrl, manifest: staged.manifest,
      bundleSha256: staged.bundleSha256, signature: staged.signature,
      publisherKeyId: staged.publisherKeyId, signatureAlg: staged.signatureAlg, verifiedAt: staged.signature ? new Date() : current.verifiedAt,
      capabilities: staged.requestedCapabilities, requestedCapabilities: staged.requestedCapabilities,
      permissionsStatus: 'approved', ...this.approver(), pendingUpgrade: null,
      // Trust was given to the code that ran: a new bundle has to be trusted again (P12 task 3.6).
      ...(staged.bundleUrl !== current.bundleUrl || staged.bundleSha256 !== current.bundleSha256 ? { trusted: false, trustedAt: null, trustedBy: null } : {}),
    }).where(where).returning());
    if (!row) throw new ExtensionMutationError('NOT_FOUND', 'Extension not found.', 404);
    new ExtensionSandbox({ ...this.deps.env }).evict(row.name);
    await this.sync(row);
    return row;
  }

  /** Approve a staged upgrade: `approvedCapabilities` must cover everything it requests. */
  async approveUpgrade(id: string, raw: unknown): Promise<UpgradeResult> {
    const { approvedCapabilities } = approvalSchema.parse(raw);
    await this.require(['configure', 'grant_capability']);
    const current = await this.current(id);
    const staged = current.pendingUpgrade as PendingUpgrade | null;
    if (!staged) throw new ExtensionMutationError('NO_PENDING_UPGRADE', 'No upgrade is waiting for approval.', 404);
    // The instance may have changed since staging: check the range and the signature again.
    resolveRequest({ name: current.name, capabilities: staged.requestedCapabilities, manifest: staged.manifest }, this.env);
    await this.verify({ ...staged, name: current.name });
    requireApproval(staged.requestedCapabilities, approvedCapabilities, { diff: staged.diff });
    return { status: 'upgraded', extension: await this.applyUpgrade(current, staged), diff: staged.diff };
  }

  /** Discard a staged upgrade; the installed version is unchanged. */
  async rejectUpgrade(id: string) {
    await this.require(['configure']);
    await this.current(id);
    const where = and(eq(extensions.siteId, this.deps.siteId), eq(extensions.id, id));
    const [row] = await this.deps.db.update(extensions).set({ pendingUpgrade: null }).where(where).returning();
    return row!;
  }

  /**
   * Confirm the capabilities of a plugin migrated from the pre-P12 model (`reconfirm`, P12 task 1.3); the
   * approval must cover every capability it holds. Afterwards it can be enabled again.
   */
  async confirmPermissions(id: string, raw: unknown) {
    const { approvedCapabilities } = approvalSchema.parse(raw);
    await this.require(['grant_capability']);
    const current = await this.current(id);
    requireApproval((current.capabilities as string[]) ?? [], approvedCapabilities, {});
    const where = and(eq(extensions.siteId, this.deps.siteId), eq(extensions.id, id));
    const [row] = await this.deps.db.update(extensions).set({ permissionsStatus: 'approved', ...this.approver() }).where(where).returning();
    return row!;
  }

  /**
   * Mark a plugin as trusted by the operator, or take the mark back (P12 task 3.6): only a trusted plugin's own admin
   * frontend is loaded; every plugin keeps the declarative pages. The mark is per installation and is dropped by an
   * upgrade that changes the bundle (see `applyUpgrade`).
   */
  async setTrusted(id: string, raw: unknown) {
    const { trusted } = z.object({ trusted: z.boolean() }).parse(raw);
    await this.require(['configure', 'grant_capability']);
    await this.current(id);
    const where = and(eq(extensions.siteId, this.deps.siteId), eq(extensions.id, id));
    const [row] = await this.deps.db
      .update(extensions)
      .set(trusted ? { trusted: true, trustedAt: new Date(), trustedBy: this.deps.userId ?? null } : { trusted: false, trustedAt: null, trustedBy: null })
      .where(where)
      .returning();
    return row!;
  }

  /** A write in the site's transaction, the public projection flushed before it commits (P07 task 2.9). */
  private write<T>(fn: (db: Database) => Promise<T>): Promise<T> {
    return runSiteTransaction(this.deps.db, this.deps.siteId, async (tx) => {
      const out = await fn(tx as unknown as Database);
      await flushPublicProjection(tx);
      return out;
    });
  }

  /**
   * A write of an extension row that may change the site's content extensions (P12 tasks 2.1–2.3), in one site
   * transaction: the content settings row held first (the lock order of every path write); then, if the plugin is enabled
   * afterwards, its collections installed (or adopted) and its routes checked for conflicts — any conflict refuses the
   * write with the paths listed; then its collections' item paths recomputed (enabled: from its item routes; disabled,
   * revoked or uninstalled: withdrawn). The public projection is flushed last.
   */
  private writeContent<T extends ExtensionRow[]>(before: ExtensionRow | null, fn: (db: Database) => Promise<T>): Promise<T> {
    return runSiteTransaction(this.deps.db, this.deps.siteId, async (tx) => {
      const db = tx as unknown as Database;
      const content = before && hasContent(before.manifest);
      if (content) await lockContentSettingsExclusive(tx as SiteTransaction, this.deps.siteId);
      const out = await fn(db);
      const after = out[0] ?? null;
      const involved = content || (after && hasContent(after.manifest));
      if (involved) {
        if (!content) await lockContentSettingsExclusive(tx as SiteTransaction, this.deps.siteId);
        await this.applyContent(tx as SiteTransaction, before, after);
      }
      await flushPublicProjection(tx);
      return out;
    });
  }

  private async applyContent(tx: SiteTransaction, before: ExtensionRow | null, after: ExtensionRow | null): Promise<void> {
    const siteId = this.deps.siteId;
    try {
      if (after?.enabled) {
        await ensurePluginCollections(tx, siteId, after);
        const conflicts = await routeConflicts(tx, siteId, after);
        if (conflicts.length) {
          const paths = [...new Set(conflicts.map((c) => c.path))];
          throw new ExtensionMutationError('ROUTE_CONFLICT', `The plugin's routes conflict with ${paths.join(', ')}; it was not enabled.`, 409, { conflicts });
        }
      }
      const moved = [...new Set([...(before ? routedCollections(before) : []), ...(after ? routedCollections(after) : [])])];
      if (moved.length) {
        const { conflicts } = await rebuildRoutes(tx, siteId, { collections: moved });
        if (conflicts.length) {
          throw new ExtensionMutationError('ROUTE_CONFLICT', `Items would share a path: ${[...new Set(conflicts.map((c) => c.path))].join(', ')}.`, 409, { items: conflicts });
        }
      }
    } catch (err) {
      if (err instanceof ContentExtensionError) throw new ExtensionMutationError(err.code, err.message, err.status, err.details);
      throw err;
    }
  }

  /** The site's plugin collections, by namespace, with their item counts and last export (P12 task 2.1). */
  async listPluginCollections() {
    await this.require(['read']);
    return runSiteTransaction(this.deps.db, this.deps.siteId, (tx) => pluginCollections(tx as SiteTransaction, this.deps.siteId));
  }

  /** Export a namespace's collections and items; the export's digest unlocks `purgePluginCollections` (P12 task 2.1). */
  async exportPluginCollections(namespace: string) {
    await this.require(['read', 'configure']);
    return this.content(() => runSiteTransaction(this.deps.db, this.deps.siteId, (tx) => exportPluginCollections(tx as SiteTransaction, this.deps.siteId, namespace)));
  }

  /** Delete a namespace's collections and items for good: confirmed, after an export, its plugin disabled (P12 task 2.1). */
  async purgePluginCollections(namespace: string, raw: unknown) {
    await this.require(['delete']);
    const input = (raw && typeof raw === 'object' ? raw : {}) as { confirm?: unknown; exportDigest?: unknown };
    const deleted = await this.content(() => this.write((db) => purgePluginCollections(db as unknown as SiteTransaction, this.deps.siteId, namespace, input)));
    return { deleted };
  }

  private async content<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ContentExtensionError) throw new ExtensionMutationError(err.code, err.message, err.status, err.details);
      throw err;
    }
  }

  private async sync(row: typeof extensions.$inferSelect) {
    try {
      const { syncExtensionCdcSubscription } = await import('../modules/cdc/change-feed/extension-sender');
      await syncExtensionCdcSubscription(this.deps.db, this.deps.siteId, {
        name: row.name, type: row.type, enabled: row.enabled, capabilities: (row.capabilities as string[]) ?? [],
      }, this.deps.cache);
    } catch {
      console.error('[extensions] cdc subscription sync failed');
    }
  }

  async uninstallExtension(id: string) {
    await this.require(['delete']);
    const [before] = await this.deps.db.select().from(extensions).where(and(eq(extensions.siteId, this.deps.siteId), eq(extensions.id, id))).limit(1);
    // Its collections and their items stay (P12 task 2.1): deleting them is a separate, confirmed operation after an export.
    const [row] = await this.writeContent(before ?? null, (db) => db.delete(extensions)
      .where(and(eq(extensions.siteId, this.deps.siteId), eq(extensions.id, id))).returning());
    if (!row) throw new ExtensionMutationError('NOT_FOUND', 'Extension not found.', 404);
    return { deleted: true, id };
  }
}

function compareVersionStrings(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return a.localeCompare(b);
  return compareVersions(pa, pb);
}
