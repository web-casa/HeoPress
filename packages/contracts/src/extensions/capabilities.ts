/**
 * Plugin capability model (HeoPress P12 task 1.1, spec extensions/permissions "细粒度能力").
 *
 * A plugin asks for exactly what it needs; the admin approves that list; the sandbox grants nothing else.
 * Every capability is one string of a fixed grammar:
 *
 * | capability                          | grants                                                          |
 * |-------------------------------------|-----------------------------------------------------------------|
 * | `http:fetch:<host>`                 | outbound requests to that host (`*.example.com`: its subdomains) |
 * | `items:read:<collection>`           | reading items of the collection (`*`: every collection)         |
 * | `items:write:<collection>`          | creating / editing / deleting drafts — never publishing         |
 * | `items:publish:<collection>`        | moving an item to `published` / `scheduled` (Hold, gates apply) |
 * | `media:read` / `media:write`        | the site's media library                                        |
 * | `secrets:<name>`                    | one named secret the operator configured for the plugin         |
 * | `kv:read` / `kv:write`              | the plugin's key-value store                                    |
 * | `cdc:subscribe:<collection>`        | change-feed events of the collection (`*`: every collection)    |
 * | `seo:structured-data`               | structured-data contributions (merged by the core, P07)         |
 * | `ai:generate`                       | model calls through the site's model gateway (ledger, budget)   |
 * | `ext:<extension point>`             | registering on one of the nine extension points (ADR-0015)      |
 *
 * There is no raw database, environment or host-file access: `db:read`, `db:write`, `service-account`,
 * `env:read`, `queue:enqueue` and a host-less `http:fetch` are refused (`REMOVED_CAPABILITIES`), for official
 * plugins as much as for third-party ones. Installed plugins holding them are migrated with
 * `migrateLegacyCapabilities` and asked to be confirmed again.
 *
 * Pure functions, no runtime dependencies: shared by the CMS (install, upgrade, sandbox), Studio (the approval
 * dialog) and the extension CLI.
 */

/** The nine extension points of ADR-0015, in the order the approval dialog lists them. */
export const EXTENSION_POINTS = [
  'collections',
  'routes',
  'source-adapters',
  'gate-checks',
  'jobs',
  'endpoints',
  'events',
  'admin-panels',
  'build-steps',
] as const;

export type ExtensionPoint = (typeof EXTENSION_POINTS)[number];

/** How the approval dialog groups capabilities. */
export const CAPABILITY_CATEGORIES = [
  'network',
  'content',
  'publish',
  'media',
  'secrets',
  'storage',
  'events',
  'seo',
  'ai',
  'extension-point',
] as const;

export type CapabilityCategory = (typeof CAPABILITY_CATEGORIES)[number];

/** Capabilities of the pre-P12 model that no plugin may hold any more (no raw DB / env escape hatch). */
export const REMOVED_CAPABILITIES = ['db:read', 'db:write', 'service-account', 'env:read', 'queue:enqueue', 'http:fetch'] as const;

/** Item statuses whose setting is a publish action (needs `items:publish:<collection>`). */
export const PUBLISH_STATUSES = ['published', 'scheduled'] as const;

export interface ParsedCapability {
  /** The capability as declared. */
  raw: string;
  category: CapabilityCategory;
  /** The capability without its target, e.g. `http:fetch`, `items:write`, `ext`. */
  kind: string;
  /** Host, collection, secret name or extension point; absent for target-less capabilities. */
  target?: string;
}

export interface CapabilityError {
  capability: string;
  reason: string;
}

const HOST = /^(\*\.)?(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const COLLECTION = /^(\*|[a-z0-9][a-z0-9_.-]{0,127})$/;
const SECRET = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Parse one capability; `{ error }` when it is outside the grammar (or removed). */
export function parseCapability(raw: string): ParsedCapability | { error: string } {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 300) return { error: 'empty or too long' };
  if ((REMOVED_CAPABILITIES as readonly string[]).includes(raw)) {
    return {
      error:
        raw === 'http:fetch'
          ? 'a host-less http:fetch is not allowed; declare each host as http:fetch:<host>'
          : `"${raw}" was removed: plugins have no raw database, environment or queue access`,
    };
  }
  if (raw === 'items:read' || raw === 'items:write') {
    return { error: `"${raw}" needs a collection: ${raw}:<collection> (or ${raw}:*)` };
  }
  const simple: Record<string, CapabilityCategory> = {
    'media:read': 'media',
    'media:write': 'media',
    'kv:read': 'storage',
    'kv:write': 'storage',
    'seo:structured-data': 'seo',
    // HeoPress P12 task 4.4: the plugin asks the site's models through the gateway (per-call ledger, site budget);
    // it never holds a provider key.
    'ai:generate': 'ai',
  };
  if (simple[raw]) return { raw, category: simple[raw], kind: raw };

  const withTarget = (prefix: string): string | null => (raw.startsWith(prefix) ? raw.slice(prefix.length) : null);

  const host = withTarget('http:fetch:');
  if (host !== null) {
    if (!HOST.test(host)) return { error: `"${host}" is not a host name (lowercase, no port, scheme or path)` };
    return { raw, category: 'network', kind: 'http:fetch', target: host };
  }
  for (const access of ['read', 'write', 'publish'] as const) {
    const collection = withTarget(`items:${access}:`);
    if (collection !== null) {
      if (!COLLECTION.test(collection)) return { error: `"${collection}" is not a collection name` };
      return { raw, category: access === 'publish' ? 'publish' : 'content', kind: `items:${access}`, target: collection };
    }
  }
  const cdc = withTarget('cdc:subscribe:');
  if (cdc !== null) {
    if (!COLLECTION.test(cdc)) return { error: `"${cdc}" is not a collection name` };
    return { raw, category: 'events', kind: 'cdc:subscribe', target: cdc };
  }
  const secret = withTarget('secrets:');
  if (secret !== null) {
    if (!SECRET.test(secret)) return { error: `"${secret}" is not a secret name` };
    return { raw, category: 'secrets', kind: 'secrets', target: secret };
  }
  const point = withTarget('ext:');
  if (point !== null) {
    if (!(EXTENSION_POINTS as readonly string[]).includes(point)) {
      return { error: `"${point}" is not an extension point (${EXTENSION_POINTS.join(', ')})` };
    }
    return { raw, category: 'extension-point', kind: 'ext', target: point };
  }
  return { error: 'unknown capability' };
}

export function isParsedCapability(v: ParsedCapability | { error: string }): v is ParsedCapability {
  return !('error' in v);
}

/** Validate a capability list: the parsed, de-duplicated, sorted capabilities and every error. */
export function validateCapabilities(list: readonly string[]): {
  capabilities: ParsedCapability[];
  errors: CapabilityError[];
} {
  const seen = new Set<string>();
  const capabilities: ParsedCapability[] = [];
  const errors: CapabilityError[] = [];
  for (const raw of list) {
    if (seen.has(raw)) continue;
    seen.add(raw);
    const parsed = parseCapability(raw);
    if (isParsedCapability(parsed)) capabilities.push(parsed);
    else errors.push({ capability: String(raw), reason: parsed.error });
  }
  capabilities.sort(compareCapabilities);
  return { capabilities, errors };
}

function compareCapabilities(a: ParsedCapability, b: ParsedCapability): number {
  const ca = CAPABILITY_CATEGORIES.indexOf(a.category);
  const cb = CAPABILITY_CATEGORIES.indexOf(b.category);
  return ca !== cb ? ca - cb : a.raw.localeCompare(b.raw);
}

/** Normalise a valid list: de-duplicated and sorted (category, then name). Invalid entries are dropped. */
export function normalizeCapabilities(list: readonly string[]): string[] {
  return validateCapabilities(list).capabilities.map((c) => c.raw);
}

export interface CapabilityDiff {
  /** Requested now, not granted before: these need the admin's approval. */
  added: string[];
  /** Granted before, no longer requested: dropped without approval. */
  removed: string[];
  unchanged: string[];
}

/** What changes between the granted list and a newly requested one. */
export function diffCapabilities(granted: readonly string[], requested: readonly string[]): CapabilityDiff {
  const before = new Set(granted);
  const after = new Set(requested);
  return {
    added: normalizeCapabilities([...after].filter((c) => !before.has(c))),
    removed: [...before].filter((c) => !after.has(c)).sort(),
    unchanged: normalizeCapabilities([...after].filter((c) => before.has(c))),
  };
}

/** Whether `approved` covers every capability of `requested` (an approval of more is fine, of less is not). */
export function approvalCovers(approved: readonly string[] | undefined, requested: readonly string[]): boolean {
  if (!approved) return requested.length === 0;
  const set = new Set(approved);
  return requested.every((c) => set.has(c));
}

/**
 * Map a pre-P12 capability list onto the new model. Nothing is widened: `items:read` / `items:write` keep their
 * meaning as `items:<access>:*`; the raw DB / env / service-account / queue capabilities and a host-less
 * `http:fetch` are dropped; anything else outside the grammar is dropped. The extension point the old slot type
 * implied is added (a `hook` plugin keeps its hooks, an `endpoint` plugin its handler, a panel/module its UI).
 */
export function migrateLegacyCapabilities(
  list: readonly string[],
  type?: string,
): { capabilities: string[]; dropped: string[] } {
  const out: string[] = [];
  const dropped: string[] = [];
  for (const raw of list) {
    const mapped = raw === 'items:read' ? 'items:read:*' : raw === 'items:write' ? 'items:write:*' : raw;
    if (isParsedCapability(parseCapability(mapped))) out.push(mapped);
    else dropped.push(raw);
  }
  const point = type ? LEGACY_TYPE_POINT[type] : undefined;
  if (point) out.push(`ext:${point}`);
  return { capabilities: normalizeCapabilities(out), dropped: [...new Set(dropped)].sort() };
}

/** The extension point a pre-P12 slot type stood for. */
export const LEGACY_TYPE_POINT: Readonly<Record<string, ExtensionPoint>> = {
  hook: 'events',
  endpoint: 'endpoints',
  panel: 'admin-panels',
  module: 'admin-panels',
};

/** Whether `host` (lowercase, no port) is covered by an `http:fetch:<host>` capability. */
export function allowsHost(capabilities: Iterable<string>, host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  for (const cap of capabilities) {
    if (!cap.startsWith('http:fetch:')) continue;
    const declared = cap.slice('http:fetch:'.length);
    if (declared === h) return true;
    if (declared.startsWith('*.') && h.endsWith(declared.slice(1)) && h.length > declared.length - 1) return true;
  }
  return false;
}

/** Whether the capabilities allow `access` on `collection` (`items:<access>:<collection>` or `:*`). */
export function allowsCollection(
  capabilities: Iterable<string>,
  access: 'read' | 'write' | 'publish',
  collection: string,
): boolean {
  const exact = `items:${access}:${collection}`;
  const any = `items:${access}:*`;
  for (const cap of capabilities) if (cap === exact || cap === any) return true;
  return false;
}

/** Whether the capabilities declare the extension point. */
export function declaresExtensionPoint(capabilities: Iterable<string>, point: ExtensionPoint): boolean {
  for (const cap of capabilities) if (cap === `ext:${point}`) return true;
  return false;
}

/** Group parsed capabilities by category, in display order (empty categories left out). */
export function groupCapabilities(list: readonly string[]): Array<{ category: CapabilityCategory; capabilities: ParsedCapability[] }> {
  const { capabilities } = validateCapabilities(list);
  return CAPABILITY_CATEGORIES.map((category) => ({
    category,
    capabilities: capabilities.filter((c) => c.category === category),
  })).filter((g) => g.capabilities.length > 0);
}
