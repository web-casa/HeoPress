import { createHash } from 'node:crypto';

/**
 * Structured-data contributions (HeoPress P07 tasks 2.9, 2.10; spec seo/page-metadata "关联结构化数据图"): JSON-LD
 * nodes an item or an extension adds to a page's one graph. Data, never code: a contribution is checked here (its
 * syntax, its size, the names it may use), materialised by the CMS into the public projection (the rendering service
 * never loads an extension) and merged by `structuredData` — where the core decides each node's identifier and
 * owner, whatever the contributor says, and removes what the page may not carry.
 */

/**
 * What an extension declares in its manifest (`structuredData`), honoured while it is enabled on a site and granted
 * the `seo:structured-data` capability.
 */
export interface StructuredDataContribution {
  /** Stable within the extension (`[a-z][a-z0-9-]*`, at most 40): part of the node's identifier. */
  key: string;
  /**
   * `site`: one node on every indexable page of the site, the same everywhere — it may not take an item's values.
   * `item`: a node on the indexable pages of the items of `collections` (all collections when absent); a value
   * `{ "$field": "<name>" }` takes that public field of the item (text, a number or a boolean; left out when empty).
   */
  scope: 'site' | 'item';
  collections?: string[];
  /** A schema.org node: an `@type`, and properties. No `@id` or `@context`: the core assigns them. */
  node: Record<string, unknown>;
}

/** The capability an extension must be granted for its contributions to be honoured. */
export const STRUCTURED_DATA_CAPABILITY = 'seo:structured-data';

/**
 * A contributed node as the projection stores it: its owner and identifier (a fragment of the page's address for a
 * page node, of the site's origin for a site node) decided by the core; references inside the node to `#fragment`
 * are references to nodes of the same page.
 */
export interface MaterializedNode {
  /** `item` (the item's own structured data) or `extension:<key>`. */
  source: string;
  owner: 'site' | 'page';
  fragment: string;
  /** The node without its `@id`. */
  node: Record<string, unknown>;
  /** Top-level properties whose values came from the item's fields (a site node may carry none). */
  itemFields?: string[];
  /** The contribution's fingerprint (an extension's): a change refreshes the items it applies to. */
  fingerprint?: string;
}

export interface StructuredDataDiagnostic {
  code:
    | 'invalid-json'
    | 'invalid-node'
    | 'too-large'
    | 'removed-property'
    | 'reserved-type'
    | 'id-conflict'
    | 'foreign-id'
    | 'site-node-item-field'
    | 'ineligible-node'
    | 'dangling-reference'
    | 'invalid-contribution';
  /** `item`, `extension:<key>` or `core`. */
  source: string;
  message: string;
  /** The fragment of the contributed node it is about (the final check's diagnostics). */
  node?: string;
}

/** Limits of an item's own structured data (its text) and of each extension contribution. */
export const LIMITS = {
  itemBytes: 16_384,
  itemNodes: 10,
  contributionBytes: 4096,
  /** A materialised node (an item contribution with its fields' values in place). */
  materializedBytes: 8192,
  /** All contributed nodes of one page together (the item's own and its extensions'). */
  pageBytes: 65_536,
  contributionsPerExtension: 8,
  depth: 8,
  arrayItems: 100,
  stringLength: 10_000,
  properties: 100,
} as const;

/** Fragments of a page's address the core's own nodes use (and fragments the core keeps for extensions). */
export const CORE_PAGE_FRAGMENTS = ['webpage', 'breadcrumb', 'primaryimage', 'article', 'faq'] as const;
const CORE_FRAGMENT_SET = new Set<string>(CORE_PAGE_FRAGMENTS);

/**
 * The article kind (schema.org Article and its subtypes): a page has one article node at most — its own — and a site
 * node is never one (it would be a second article on each article page).
 */
export const ARTICLE_TYPES = new Set([
  'Article',
  'NewsArticle',
  'AnalysisNewsArticle',
  'AskPublicNewsArticle',
  'BackgroundNewsArticle',
  'OpinionNewsArticle',
  'ReportageNewsArticle',
  'ReviewNewsArticle',
  'BlogPosting',
  'LiveBlogPosting',
  'SocialMediaPosting',
  'DiscussionForumPosting',
  'Report',
  'ScholarlyArticle',
  'MedicalScholarlyArticle',
  'TechArticle',
  'APIReference',
  'SatiricalArticle',
  'AdvertiserContentArticle',
]);

/**
 * Types only the core writes as a node of the graph: the site, its pages, their breadcrumb. A contribution of one
 * would be a second page or site node (spec: "类型冲突").
 */
export const RESERVED_TYPES = new Set([
  'WebSite',
  'WebPage',
  'CollectionPage',
  'ItemPage',
  'AboutPage',
  'ContactPage',
  'ProfilePage',
  'SearchResultsPage',
  'FAQPage',
  'QAPage',
  'BreadcrumbList',
]);

const TYPE_NAME = /^[A-Z][A-Za-z0-9]{0,63}$/;
const PROPERTY_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const FRAGMENT = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;
const ITEM_FRAGMENT = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const CONTRIBUTION_KEY = /^[a-z][a-z0-9-]{0,39}$/;
const SCHEMA_CONTEXT = new Set(['https://schema.org', 'https://schema.org/', 'http://schema.org', 'http://schema.org/']);

const bytes = (v: unknown): number => new TextEncoder().encode(JSON.stringify(v)).length;

/** The node's types (one or more names); null when they are not schema.org type names. */
export function typesOf(node: Record<string, unknown>): string[] | null {
  const t = node['@type'];
  const list = Array.isArray(t) ? t : [t];
  if (list.length === 0 || list.length > 4 || !list.every((x) => typeof x === 'string' && TYPE_NAME.test(x))) return null;
  return list as string[];
}

/** An `@id` written in a contribution: a fragment of the page (`#event`) or an absolute http(s) address. */
function idForm(id: unknown): { fragment: string } | { absolute: string } | null {
  if (typeof id !== 'string') return null;
  if (id.startsWith('#')) return ITEM_FRAGMENT.test(id.slice(1)) ? { fragment: id.slice(1) } : null;
  try {
    const u = new URL(id);
    return u.protocol === 'https:' || u.protocol === 'http:' ? { absolute: u.toString() } : null;
  } catch {
    return null;
  }
}

/**
 * A value as the graph may hold it (syntax limits): text, finite numbers, booleans, lists and objects of schema.org
 * properties, within the depth and size limits. Keywords other than `@type`, `@value`, `@language` and a reference's
 * `@id` are removed, as are properties that are not names; each removal leaves a note in `removed`.
 */
function clean(value: unknown, depth: number, path: string, removed: string[]): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return value.length > LIMITS.stringLength ? (removed.push(`${path} (text too long)`), undefined) : value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'boolean') return value;
  if (depth > LIMITS.depth) return (removed.push(`${path} (nested too deep)`), undefined);
  if (Array.isArray(value)) {
    if (value.length > LIMITS.arrayItems) removed.push(`${path} (only the first ${LIMITS.arrayItems} entries kept)`);
    const out = value.slice(0, LIMITS.arrayItems).map((v, i) => clean(v, depth + 1, `${path}[${i}]`, removed)).filter((v) => v !== undefined);
    return out.length ? out : undefined;
  }
  if (typeof value !== 'object') return undefined;
  const src = value as Record<string, unknown>;
  const keys = Object.keys(src);
  // A reference to another node: `{ "@id": ... }` alone.
  if (keys.length === 1 && keys[0] === '@id') {
    const id = idForm(src['@id']);
    if (!id) return (removed.push(`${path} (not a reference this graph can hold)`), undefined);
    return { '@id': 'fragment' in id ? `#${id.fragment}` : id.absolute };
  }
  const out: Record<string, unknown> = {};
  let count = 0;
  for (const key of keys) {
    const at = `${path}.${key}`;
    if (key === '@type') {
      const types = typesOf(src);
      if (!types) removed.push(`${at} (not a schema.org type name)`);
      else out['@type'] = Array.isArray(src['@type']) ? types : types[0];
      continue;
    }
    if (key === '@value' || key === '@language') {
      if (typeof src[key] === 'string' || (key === '@value' && (typeof src[key] === 'number' || typeof src[key] === 'boolean'))) out[key] = src[key];
      continue;
    }
    // An embedded node names no identifier of its own: only the core assigns them (one node per identifier).
    if (key.startsWith('@') || !PROPERTY_NAME.test(key)) {
      removed.push(at);
      continue;
    }
    if (++count > LIMITS.properties) {
      removed.push(`${at} (too many properties)`);
      continue;
    }
    const v = clean(src[key], depth + 1, at, removed);
    if (v !== undefined) out[key] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * The item's own structured data (its `structured_data` field: JSON-LD text): one node, a list of nodes, or a
 * document with the schema.org `@context` and a node or an `@graph`. Each node needs a schema.org `@type` and may name
 * itself `#fragment` (or by the page's own address and a fragment, `pageUrl` — absent: a fragment only); it gets
 * `#custom-<n>` otherwise. A node of a reserved type, a node naming another address and a node with a fragment the
 * core uses are left out with a diagnostic, as is everything past the limits.
 */
export function itemStructuredData(text: string, pageUrl?: string | null): { nodes: MaterializedNode[]; diagnostics: StructuredDataDiagnostic[] } {
  const diagnostics: StructuredDataDiagnostic[] = [];
  const note = (code: StructuredDataDiagnostic['code'], message: string) => diagnostics.push({ code, source: 'item', message });
  const trimmed = text.trim();
  if (!trimmed) return { nodes: [], diagnostics };
  if (new TextEncoder().encode(trimmed).length > LIMITS.itemBytes) {
    note('too-large', `the item's structured data is larger than ${LIMITS.itemBytes} bytes: none of it is used`);
    return { nodes: [], diagnostics };
  }
  let doc: unknown;
  try {
    doc = JSON.parse(trimmed);
  } catch {
    note('invalid-json', "the item's structured data is not JSON");
    return { nodes: [], diagnostics };
  }
  let list: unknown[];
  if (Array.isArray(doc)) list = doc;
  else if (doc && typeof doc === 'object') {
    const d = doc as Record<string, unknown>;
    if ('@context' in d && !(typeof d['@context'] === 'string' && SCHEMA_CONTEXT.has(d['@context']))) {
      note('invalid-json', 'only the schema.org vocabulary is accepted (@context https://schema.org)');
      return { nodes: [], diagnostics };
    }
    list = Array.isArray(d['@graph']) ? (d['@graph'] as unknown[]) : [d];
  } else {
    note('invalid-json', "the item's structured data is not a JSON-LD node");
    return { nodes: [], diagnostics };
  }
  if (list.length > LIMITS.itemNodes) note('too-large', `only the first ${LIMITS.itemNodes} nodes are used`);
  const page = pageUrl ? pageUrl.split('#')[0] : null;
  const nodes: MaterializedNode[] = [];
  const used = new Set<string>();
  list.slice(0, LIMITS.itemNodes).forEach((raw, i) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return note('invalid-node', `node ${i + 1} is not an object`);
    const src = { ...(raw as Record<string, unknown>) };
    delete src['@context'];
    const types = typesOf(src);
    if (!types) return note('invalid-node', `node ${i + 1} has no schema.org @type`);
    const reserved = types.find((t) => RESERVED_TYPES.has(t));
    if (reserved) return note('reserved-type', `node ${i + 1}: a ${reserved} is written by the system (one per page)`);
    let fragment = `custom-${i + 1}`;
    if (src['@id'] !== undefined) {
      const id = idForm(src['@id']);
      const own = id && 'absolute' in id && page && id.absolute.startsWith(`${page}#`) ? id.absolute.slice(page.length + 1) : null;
      const f = id && 'fragment' in id ? id.fragment : own !== null && ITEM_FRAGMENT.test(own) ? own : null;
      // The core decides whose a node is: the item's nodes belong to its page; another address is not the item's to describe.
      if (!f) return note('foreign-id', `node ${i + 1}: @id ${JSON.stringify(src['@id'])} is not a part of this page (use "#name")`);
      fragment = f;
    }
    delete src['@id'];
    if (CORE_FRAGMENT_SET.has(fragment) || fragment.startsWith('ext-')) return note('id-conflict', `node ${i + 1}: #${fragment} is the system's`);
    if (used.has(fragment)) return note('id-conflict', `node ${i + 1}: #${fragment} names an earlier node`);
    const removed: string[] = [];
    const node = clean(src, 0, `node ${i + 1}`, removed) as Record<string, unknown> | undefined;
    for (const r of removed) note('removed-property', `${r} removed`);
    if (!node || !node['@type']) return note('invalid-node', `node ${i + 1} has nothing left to say`);
    used.add(fragment);
    nodes.push({ source: 'item', owner: 'page', fragment, node });
  });
  return { nodes, diagnostics };
}

/**
 * An extension's declared contributions, checked (the contract `StructuredDataContribution`): the valid ones, and a
 * diagnostic for each one left out. `extKey` is the extension's key.
 */
export function validContributions(extKey: string, declared: unknown): { contributions: StructuredDataContribution[]; diagnostics: StructuredDataDiagnostic[] } {
  const source = `extension:${extKey}`;
  const diagnostics: StructuredDataDiagnostic[] = [];
  const note = (message: string) => diagnostics.push({ code: 'invalid-contribution', source, message });
  if (!Array.isArray(declared)) {
    if (declared !== undefined) note('structuredData is not a list');
    return { contributions: [], diagnostics };
  }
  if (declared.length > LIMITS.contributionsPerExtension) note(`only the first ${LIMITS.contributionsPerExtension} contributions are used`);
  const out: StructuredDataContribution[] = [];
  const keys = new Set<string>();
  for (const [i, raw] of declared.slice(0, LIMITS.contributionsPerExtension).entries()) {
    const c = raw as Partial<StructuredDataContribution> | null;
    const label = `contribution ${i + 1}`;
    if (!c || typeof c !== 'object') {
      note(`${label} is not an object`);
      continue;
    }
    if (typeof c.key !== 'string' || !CONTRIBUTION_KEY.test(c.key) || keys.has(c.key)) {
      note(`${label}: key must be unique, [a-z][a-z0-9-]* (at most 40)`);
      continue;
    }
    if (c.scope !== 'site' && c.scope !== 'item') {
      note(`${label}: scope must be "site" or "item"`);
      continue;
    }
    if (c.collections !== undefined && !(Array.isArray(c.collections) && c.collections.every((x) => typeof x === 'string'))) {
      note(`${label}: collections must be a list of collection names`);
      continue;
    }
    if (!c.node || typeof c.node !== 'object' || Array.isArray(c.node)) {
      note(`${label}: node must be an object`);
      continue;
    }
    if (bytes(c.node) > LIMITS.contributionBytes) {
      diagnostics.push({ code: 'too-large', source, message: `${label} is larger than ${LIMITS.contributionBytes} bytes` });
      continue;
    }
    const types = typesOf(c.node);
    if (!types) {
      note(`${label}: node needs a schema.org @type`);
      continue;
    }
    const reserved = types.find((t) => RESERVED_TYPES.has(t));
    if (reserved) {
      diagnostics.push({ code: 'reserved-type', source, message: `${label}: a ${reserved} is written by the system` });
      continue;
    }
    keys.add(c.key);
    out.push({ key: c.key, scope: c.scope, ...(c.collections ? { collections: [...c.collections] } : {}), node: c.node });
  }
  return { contributions: out, diagnostics };
}

/** A 128-bit tag of a text (SHA-256, hex): two extension keys never share one in practice. */
function tag(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 32);
}

/**
 * The fragment of an extension contribution's node: the core's, from the extension's and the contribution's keys
 * (`ext-<extension>_<key>`, at most 110 characters; keys hold no `_`, so the parts never run together). An extension key that is not already a plain slug of at most 40
 * characters gets a tag of the whole key, so two extensions never share a fragment.
 */
export function contributionFragment(extKey: string, key: string): string {
  const slug = extKey.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const plain = slug === extKey && slug.length <= 40 && !slug.includes('--');
  return `ext-${plain ? slug : `${slug.slice(0, 31) || 'x'}-${tag(extKey)}`}_${key}`;
}

const isFieldRef = (v: unknown): v is { $field: string } =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1 && typeof (v as { $field?: unknown }).$field === 'string';

/**
 * An extension contribution as one node (its materialisation, by the CMS): `{ "$field": … }` values take the item's
 * public field (`data`: the item's public data; none for a site node — a site node is the same on every page, so a
 * field there is removed with a diagnostic). The `@id` and `@context` the contribution may still carry are dropped:
 * the core assigns the identifier.
 */
export function materializeContribution(
  extKey: string,
  c: StructuredDataContribution,
  fingerprint: string,
  data: Record<string, unknown> | null,
): { node: MaterializedNode | null; diagnostics: StructuredDataDiagnostic[] } {
  const source = `extension:${extKey}`;
  const diagnostics: StructuredDataDiagnostic[] = [];
  const itemFields = new Set<string>();
  const resolve = (v: unknown, top: string | null): unknown => {
    if (isFieldRef(v)) {
      if (c.scope === 'site' || !data) {
        diagnostics.push({ code: 'site-node-item-field', source, message: `${c.key}: a site node cannot take an item's field (${v.$field}); removed` });
        return undefined;
      }
      const value = data[v.$field];
      if (typeof value === 'string' ? !value.trim() : !(typeof value === 'number' || typeof value === 'boolean')) return undefined;
      if (top) itemFields.add(top);
      return value;
    }
    if (Array.isArray(v)) return v.map((x) => resolve(x, top)).filter((x) => x !== undefined);
    if (v && typeof v === 'object') {
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        const r = resolve(x, top ?? k);
        if (r !== undefined) o[k] = r;
      }
      return o;
    }
    return v;
  };
  const src = resolve(c.node, null) as Record<string, unknown>;
  delete src['@id'];
  delete src['@context'];
  const removed: string[] = [];
  const node = clean(src, 0, c.key, removed) as Record<string, unknown> | undefined;
  for (const r of removed) diagnostics.push({ code: 'removed-property', source, message: `${r} removed` });
  if (!node || !node['@type']) return { node: null, diagnostics };
  // The limit holds after the fields' values are in place: a small template cannot become a large node.
  if (bytes(node) > LIMITS.materializedBytes) {
    diagnostics.push({ code: 'too-large', source, message: `${c.key}: with the item's values it is larger than ${LIMITS.materializedBytes} bytes; left out` });
    return { node: null, diagnostics };
  }
  return {
    node: {
      source,
      owner: c.scope === 'site' ? 'site' : 'page',
      fragment: contributionFragment(extKey, c.key),
      node,
      ...(itemFields.size ? { itemFields: [...itemFields].filter((f) => f in node).sort() } : {}),
      fingerprint,
    },
    diagnostics,
  };
}

/** Whether a contribution applies to an item of `collection`. */
export function appliesTo(c: StructuredDataContribution, collection: string): boolean {
  return c.scope === 'item' && (!c.collections || c.collections.includes(collection));
}

/** Read a stored list of materialised nodes back (the projection's JSON): what is not one is ignored. */
export function materializedNodes(value: unknown): MaterializedNode[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (n): n is MaterializedNode =>
      !!n &&
      typeof n === 'object' &&
      typeof (n as MaterializedNode).source === 'string' &&
      ((n as MaterializedNode).owner === 'site' || (n as MaterializedNode).owner === 'page') &&
      typeof (n as MaterializedNode).fragment === 'string' &&
      FRAGMENT.test((n as MaterializedNode).fragment) &&
      !!(n as MaterializedNode).node &&
      typeof (n as MaterializedNode).node === 'object',
  );
}
