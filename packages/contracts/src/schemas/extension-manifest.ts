// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { z } from 'zod';
import { validateCapabilities, normalizeCapabilities, declaresExtensionPoint } from '../extensions/capabilities';
import { isValidVersionRange, satisfiesVersionRange } from '../extensions/version-range';
import { ContentDeclarationsSchema, contentDeclarationIssues } from '../extensions/content';

/**
 * Extension manifest schema (`heopress-extension.json`).
 *
 * This is the source-of-truth validation for the manifest file that every
 * extension ships in its source directory. It is shared by:
 *  - the discovery util (`@heopress/extensions`) that scans folders at dev time,
 *  - the CMS install/marketplace routes that ingest a manifest, and
 *  - the Studio loader that decides which slot a UI extension fills.
 *
 * The shape mirrors `ExtensionManifest` in `@heopress/extension-sdk` but adds
 * the optional descriptive/marketplace metadata that authors put in the JSON
 * file (icon, description, author, compatibility). Keeping the Zod schema here
 * — not in the SDK — preserves the SDK's "types only, no runtime deps" rule.
 */

export const ExtensionTypeSchema = z.enum([
  'hook',
  'endpoint',
  'operation',
  'interface',
  'display',
  'layout',
  'panel',
  'module',
]);

export type ExtensionType = z.infer<typeof ExtensionTypeSchema>;

/** UI extension types render inside Studio; the rest run in the CMS worker. */
export const UI_EXTENSION_TYPES = [
  'interface',
  'display',
  'layout',
  'panel',
  'module',
] as const satisfies readonly ExtensionType[];

export type UiExtensionType = (typeof UI_EXTENSION_TYPES)[number];

export function isUiExtensionType(type: ExtensionType): type is UiExtensionType {
  return (UI_EXTENSION_TYPES as readonly string[]).includes(type);
}

/** A single configurable option an extension exposes to the installing admin. */
export const ExtensionConfigOptionSchema = z.object({
  key: z.string().min(1),
  type: z.enum(['string', 'integer', 'boolean', 'json']),
  label: z.string().optional(),
  default: z.unknown().optional(),
});

export type ExtensionConfigOption = z.infer<typeof ExtensionConfigOptionSchema>;

export const ExtensionAuthorSchema = z.object({
  name: z.string().min(1),
  email: z.string().email().optional(),
  url: z.string().url().optional(),
});

export type ExtensionAuthor = z.infer<typeof ExtensionAuthorSchema>;

/**
 * The validated manifest. `name` is the stable extension key (also used to
 * match `field.interface` for interface extensions). `entry` is a path,
 * relative to the manifest's directory, to the module's entrypoint — in dev
 * this points at source (e.g. `./src/index.ts`); in a published bundle it
 * points at the built ESM file.
 */
const HOST_NAME = /^(\*\.)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const IDENT = /^[a-z][a-z0-9_-]{0,39}$/;

/** A private storage namespace of the plugin and the indexes it needs (P12 task 1.5; storage itself is task 3.7). */
export const ExtensionStorageSchema = z.object({
  /** Each index is a list of field names, e.g. `[["slug"], ["siteId", "createdAt"]]`. */
  indexes: z.array(z.array(z.string().regex(IDENT)).min(1).max(4)).max(8).default([]),
});

/** A declarative admin page the host renders (P12 task 1.5; rendering is task 3.6). */
const ExtensionAdminPageSchema = z.object({
  id: z.string().regex(IDENT),
  title: z.string().min(1).max(80),
});

export const ExtensionAdminSchema = z.object({
  pages: z.array(ExtensionAdminPageSchema).max(16).default([]),
  /** Settings the operator fills in per site; declared here, rendered by the host. */
  settings: z.array(ExtensionConfigOptionSchema).max(64).default([]),
});

export const ExtensionSecuritySchema = z.object({
  /** Where to report a vulnerability: an e-mail address or an https URL. */
  contact: z.union([z.string().email(), z.string().url().startsWith('https://')]),
});

const ExtensionManifestBaseSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(128)
    .regex(
      /^[a-z0-9][a-z0-9-_/]*$/,
      'name must be lowercase kebab/slash form (e.g. "seo-meta" or "heopress/seo-meta")',
    ),
  version: z.string().min(1),
  type: ExtensionTypeSchema,
  entry: z.string().min(1),
  /** Human-facing label shown in Studio/marketplace; falls back to `name`. */
  displayName: z.string().optional(),
  description: z.string().optional(),
  icon: z.string().optional(),
  author: ExtensionAuthorSchema.optional(),
  /** Declared capabilities, e.g. `items:read:posts`, `http:fetch:api.example.com`. */
  capabilities: z.array(z.string()).default([]),
  config: z.array(ExtensionConfigOptionSchema).default([]),
  /** semver range of HeoPress this extension supports, e.g. `^0.6.0`. */
  /** Older name of `heopress`. */
  compatibleWith: z.string().refine(isValidVersionRange, 'not a version range').optional(),
  /** Field types an `interface`/`display` extension binds to (e.g. `["string"]`). */
  fieldTypes: z.array(z.string()).optional(),
  /**
   * Install this extension automatically during setup bootstrap / site-create
   * reconcile. Only honoured for verified official `heopress-*` extensions.
   */
  autoInstall: z.boolean().default(false),
  /** Whether an auto-installed extension starts enabled (admin can toggle off). */
  enabledByDefault: z.boolean().default(false),
  /**
   * ADVISORY ONLY — ignored server-side. Official status is derived from the
   * name namespace + a signature by an official key (never self-asserted here).
   */
  isOfficial: z.boolean().optional(),
  /** Hosts the plugin calls; each becomes an `http:fetch:<host>` capability. */
  outboundHosts: z.array(z.string().regex(HOST_NAME, 'outbound hosts are lowercase host names (no scheme, port or path)')).max(32).default([]),
  /** semver range of HeoPress the plugin runs on, e.g. `^1.0.0`; install and upgrade refuse other versions. */
  heopress: z.string().refine(isValidVersionRange, 'not a version range').optional(),
  /** Private storage namespaces and their indexes. */
  storage: z.record(z.string().regex(IDENT), ExtensionStorageSchema).default({}),
  /** Declarative admin pages and settings. */
  admin: ExtensionAdminSchema.optional(),
  security: ExtensionSecuritySchema.optional(),
  // HeoPress P12 tasks 2.1–2.4 (spec extensions/content-extensions): the plugin's own collections, public routes,
  // their default templates for both engines, and the theme components it offers.
  ...ContentDeclarationsSchema.shape,
});

/**
 * The plugin-manifest declarations an install or upgrade request may carry next to its capabilities (all
 * optional): outbound hosts, version range, private storage, admin pages / settings, security contact.
 */
export const ManifestDeclarationsSchema = ExtensionManifestBaseSchema.pick({
  outboundHosts: true,
  heopress: true,
  compatibleWith: true,
  storage: true,
  admin: true,
  security: true,
  collections: true,
  routes: true,
  templates: true,
  components: true,
}).partial();

/** The capabilities a manifest requests: `capabilities` plus one `http:fetch:<host>` per outbound host. */
export function manifestCapabilities(manifest: { capabilities?: string[]; outboundHosts?: string[] }): string[] {
  return normalizeCapabilities([
    ...(manifest.capabilities ?? []),
    ...(manifest.outboundHosts ?? []).map((h) => `http:fetch:${h}`),
  ]);
}

/** The HeoPress version range of a manifest (`heopress`, or the older `compatibleWith`). */
export function manifestVersionRange(manifest: { heopress?: string; compatibleWith?: string }): string | undefined {
  return manifest.heopress ?? manifest.compatibleWith;
}

/** Whether the manifest's version range admits `version` (true when it declares none). */
export function manifestSupportsVersion(manifest: { heopress?: string; compatibleWith?: string }, version: string): boolean {
  const range = manifestVersionRange(manifest);
  return range === undefined || satisfiesVersionRange(version, range);
}

/**
 * The validated manifest: capabilities inside the grammar (`@heopress/contracts/extensions`), every outbound host
 * also reachable only through it, admin pages only with the `ext:admin-panels` extension point.
 */
export const ExtensionManifestSchema = ExtensionManifestBaseSchema.superRefine((m, ctx) => {
  for (const e of validateCapabilities(m.capabilities).errors) {
    ctx.addIssue({ code: 'custom', path: ['capabilities'], message: `${e.capability}: ${e.reason}` });
  }
  if ((m.admin?.pages.length ?? 0) > 0 && !declaresExtensionPoint(m.capabilities, 'admin-panels')) {
    ctx.addIssue({ code: 'custom', path: ['admin', 'pages'], message: 'admin pages need the ext:admin-panels capability' });
  }
  for (const issue of contentDeclarationIssues(m.name, m, m.capabilities)) {
    ctx.addIssue({ code: 'custom', path: issue.path.split('.'), message: issue.message });
  }
});

/**
 * What the marketplace accepts: a valid manifest that also states the HeoPress version range and a security
 * contact (spec extensions/permissions "插件清单").
 */
export const MarketplaceManifestSchema = ExtensionManifestSchema.superRefine((m, ctx) => {
  if (!manifestVersionRange(m)) ctx.addIssue({ code: 'custom', path: ['heopress'], message: 'the HeoPress version range is required' });
  if (!m.security) ctx.addIssue({ code: 'custom', path: ['security'], message: 'a security contact is required' });
});

export type ExtensionManifest = z.infer<typeof ExtensionManifestSchema>;

/**
 * Parse + validate a raw manifest object, throwing a ZodError on failure.
 * Use `ExtensionManifestSchema.safeParse` directly when you want to collect
 * errors without throwing (the discovery util does this per-folder).
 */
export function parseExtensionManifest(raw: unknown): ExtensionManifest {
  return ExtensionManifestSchema.parse(raw);
}
