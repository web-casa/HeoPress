/**
 * Extension-point contract versions (HeoPress P14 task 7.1, spec extensions/extension-point-versions; ADR-0025).
 *
 * Each of the nine extension points and the plugin host API (`context`) carries its own semantic version. A breaking
 * change bumps that point's major version and leaves the other points alone, so a plugin states for every point it uses
 * the range it was written for:
 *
 * ```json
 * "extensionPoints": { "events": "^1.0.0", "jobs": "^1.0.0", "context": "^1.0.0" }
 * ```
 *
 * The table here is the runtime source of truth: install, upgrade, approval, auto-install and every load path check a
 * manifest against it. `@heopress/extension-sdk` publishes its own copy (the SDK takes no dependency on a core package),
 * and `plugin-package` CI checks the two agree.
 *
 * Pure data and functions, no runtime dependencies beyond the capability model and the version-range subset.
 */
import { EXTENSION_POINTS, type ExtensionPoint } from './capabilities';
import { isValidVersionRange, satisfiesVersionRange } from './version-range';

/** The contract version of every extension point, and of the plugin host API (`context`). */
export const EXTENSION_POINT_VERSIONS = {
  collections: '1.0.0',
  routes: '1.0.0',
  'source-adapters': '1.0.0',
  'gate-checks': '1.0.0',
  jobs: '1.0.0',
  endpoints: '1.0.0',
  events: '1.0.0',
  'admin-panels': '1.0.0',
  'build-steps': '1.0.0',
  context: '1.0.0',
} as const;

/** A key of the version table: an extension point, or `context` for the plugin host API. */
export type ExtensionPointVersionKey = keyof typeof EXTENSION_POINT_VERSIONS;

/** Every key of the version table, extension points first and `context` last. */
export const EXTENSION_POINT_VERSION_KEYS: readonly ExtensionPointVersionKey[] = [...EXTENSION_POINTS, 'context'];

/** The key of the plugin host API in the version table and in a manifest's `extensionPoints`. */
export const CONTEXT_VERSION_KEY = 'context' as const;

/** The declared contract versions of a manifest, as a plain string record (invalid entries included). */
export function extensionPointRangesOf(manifest: unknown): Record<string, string> {
  const declared = (manifest as { extensionPoints?: unknown } | null)?.extensionPoints;
  if (!declared || typeof declared !== 'object' || Array.isArray(declared)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(declared as Record<string, unknown>)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

/**
 * A manifest with the ranges it omits filled from the instance's current versions (P14 task 7.1): `context` and every
 * point the capability list requests get `^<current>`. The admin's "install by URL" form has no manifest file, so the
 * service derives the declaration it would have written; a published manifest still states its ranges (the marketplace
 * schema requires them), and a declared range is never overwritten.
 */
export function withExtensionPointDefaults(manifest: unknown, capabilities: readonly string[]): Record<string, unknown> {
  const base = manifest && typeof manifest === 'object' && !Array.isArray(manifest) ? { ...(manifest as Record<string, unknown>) } : {};
  const points: Record<string, string> = { ...extensionPointRangesOf(base) };
  if (!points['context']) points['context'] = `^${EXTENSION_POINT_VERSIONS.context}`;
  for (const point of requestedExtensionPoints(capabilities)) {
    if (!points[point]) points[point] = `^${EXTENSION_POINT_VERSIONS[point]}`;
  }
  base['extensionPoints'] = points;
  return base;
}

/** Whether `point` is a key of the version table. */
export function isExtensionPointVersionKey(point: string): point is ExtensionPointVersionKey {
  return (EXTENSION_POINT_VERSION_KEYS as readonly string[]).includes(point);
}

/** The extension points a capability list requests (`ext:<point>`), in table order. */
export function requestedExtensionPoints(capabilities: readonly string[]): ExtensionPoint[] {
  return EXTENSION_POINTS.filter((point) => capabilities.includes(`ext:${point}`));
}

export interface ExtensionPointRangeIssue {
  /** Where the problem is, e.g. `['extensionPoints', 'events']`. */
  path: string[];
  /** A message naming the point. */
  message: string;
}

/**
 * Every problem of a manifest's `extensionPoints` declaration: every requested point needs a range, `context` is
 * required, a range for a point the plugin does not request is refused, an unknown key is refused and so is an
 * unparseable range. Empty when the declaration is complete and valid.
 */
export function validateExtensionPointRanges(manifest: {
  capabilities?: readonly string[];
  extensionPoints?: unknown;
}): ExtensionPointRangeIssue[] {
  const declared = extensionPointRangesOf(manifest);
  const capabilities = manifest.capabilities ?? [];
  const requested = requestedExtensionPoints(capabilities);
  const issues: ExtensionPointRangeIssue[] = [];

  for (const key of Object.keys(declared)) {
    if (!isExtensionPointVersionKey(key)) {
      issues.push({
        path: ['extensionPoints', key],
        message: `extension point "${key}" is not one of the nine extension points or the plugin host API ("context")`,
      });
    }
  }

  for (const point of requested) {
    if (declared[point] === undefined) {
      issues.push({
        path: ['extensionPoints', point],
        message: `the plugin requests ext:${point} but declares no version range for the extension point "${point}"`,
      });
    }
  }

  if (declared[CONTEXT_VERSION_KEY] === undefined) {
    issues.push({
      path: ['extensionPoints', CONTEXT_VERSION_KEY],
      message: 'the plugin host API ("context") needs a version range in "extensionPoints"',
    });
  }

  for (const [key, range] of Object.entries(declared)) {
    if (!isExtensionPointVersionKey(key)) continue;
    if (!isValidVersionRange(range)) {
      issues.push({
        path: ['extensionPoints', key],
        message: `the version range for extension point "${key}" is not a version range: "${range}"`,
      });
      continue;
    }
    if (key !== CONTEXT_VERSION_KEY && !requested.includes(key)) {
      issues.push({
        path: ['extensionPoints', key],
        message: `a version range for extension point "${key}" is declared but the plugin does not request ext:${key}`,
      });
    }
  }

  return issues;
}

/** One extension point a manifest declares a range for that this instance does not provide. */
export interface ExtensionPointIncompatibility {
  /** The extension point, or `context`. */
  point: ExtensionPointVersionKey;
  /** The range the plugin declares. */
  required: string;
  /** The version this instance provides. */
  current: string;
}

/**
 * The declared extension-point ranges that do not include the version this instance provides, in table order.
 * A point without a declared range is not reported here (the manifest rule covers that); load paths treat it as
 * compatible so plugins installed before the rule keep running until an admin upgrades them.
 */
export function incompatibleExtensionPoints(
  manifest: unknown,
  versions: Readonly<Record<ExtensionPointVersionKey, string>> = EXTENSION_POINT_VERSIONS,
): ExtensionPointIncompatibility[] {
  const declared = extensionPointRangesOf(manifest);
  const out: ExtensionPointIncompatibility[] = [];
  for (const point of EXTENSION_POINT_VERSION_KEYS) {
    const required = declared[point];
    if (required === undefined) continue;
    const current = versions[point];
    if (!satisfiesVersionRange(current, required)) out.push({ point, required, current });
  }
  return out;
}

/**
 * Whether an extension point (or `context`) of a manifest is compatible with this instance. An incompatible `context`
 * — the plugin host API — makes every point incompatible: a plugin written for another host API does not take part.
 */
export function extensionPointCompatible(
  manifest: unknown,
  point: ExtensionPointVersionKey,
  versions: Readonly<Record<ExtensionPointVersionKey, string>> = EXTENSION_POINT_VERSIONS,
): boolean {
  return !incompatibleExtensionPoints(manifest, versions).some(
    (i) => i.point === point || (i.point === CONTEXT_VERSION_KEY && point !== CONTEXT_VERSION_KEY),
  );
}

/**
 * The declaration keys that need an upgrade: the extension points (and `context`) a manifest declares at a range this
 * instance does not provide.
 */
export function incompatibleExtensionPointKeys(
  manifest: unknown,
  versions: Readonly<Record<ExtensionPointVersionKey, string>> = EXTENSION_POINT_VERSIONS,
): ExtensionPointVersionKey[] {
  return incompatibleExtensionPoints(manifest, versions).map((i) => i.point);
}

/** The message of an incompatibility: names the point, the range the plugin requires and the current version. */
export function extensionPointIncompatibilityMessage(i: ExtensionPointIncompatibility): string {
  return `extension point "${i.point}" requires ${i.required}; this instance provides ${i.current}`;
}
