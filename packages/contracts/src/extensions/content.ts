/**
 * Content extensions of a plugin (HeoPress P12 tasks 2.1–2.5; spec extensions/content-extensions; ADR-0015): the
 * declarations a manifest carries for its own collections, public routes, default templates and theme components,
 * and the public shape the rendering engines read. Data, never code: the CMS installs the collections, checks the
 * routes for conflicts and materialises routes and templates into the public projection; the rendering engines never
 * load a plugin.
 *
 *   - `collections` (needs `ext:collections`): installed per site under the plugin's namespace — the machine name is
 *     `<namespace>__<collection>` (collection machine names are `[a-z][a-z0-9_]`, so the namespace separator is a
 *     double underscore; shown as `<namespace>.<collection>`). Two plugins declaring the same collection never share it.
 *   - `routes` (needs `ext:routes`): an `item` route (`/glossary/:slug`) is the permalink of one of the plugin's own
 *     collections; a `list` route (`/glossary`) lists its items, a page at a time, per language. Each names a default
 *     template the plugin ships for both engines (`templates.classic` Liquid, `templates.astro` an Astro component); a
 *     theme overrides one with its own `ext/<namespace>/<template>`.
 *   - `components` (needs `ext:routes`: they render on public pages): a Classic template fragment and an Astro component
 *     each, which a theme may place (`{% include 'ext/<namespace>/components/<name>' %}`,
 *     `import X from 'heopress:ext/<namespace>/<name>'`); they read the page data contract only and appear nowhere a
 *     theme does not place them.
 *
 * No template or component may carry a script, JSON-LD, a canonical or robots tag: the page's head and its one
 * structured-data graph are the system's (a plugin contributes nodes through `structuredData`, P07 task 2.9).
 *
 * Pure functions and Zod schemas: shared by the CMS (install, enable, projection), the rendering engines and Studio.
 */
import { z } from 'zod';
import { declaresExtensionPoint } from './capabilities';

/** A namespace or local name: lowercase words joined by single underscores (`acme_glossary`, `terms`). */
const WORDS = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
const MAX_PART = 30;
/** A template or component name. */
const NAME = /^[a-z][a-z0-9_-]{0,39}$/;
/** A literal path segment of a route. */
const LITERAL = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * The plugin's namespace on a site, from its name: `acme/glossary`, `acme-glossary` → `acme_glossary`. Null when the
 * name cannot be one (it must start with a letter and fit in 30 characters once normalised).
 */
export function extensionNamespace(name: string): string | null {
  const ns = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return ns.length <= MAX_PART && WORDS.test(ns) ? ns : null;
}

/** The machine name of a plugin collection: `<namespace>__<collection>`. */
export function pluginCollectionName(namespace: string, collection: string): string {
  return `${namespace}__${collection}`;
}

/** The namespace and local name of a plugin collection's machine name, or null when it is not one. */
export function parsePluginCollectionName(name: string): { namespace: string; collection: string } | null {
  const i = name.indexOf('__');
  if (i <= 0) return null;
  const namespace = name.slice(0, i);
  const collection = name.slice(i + 2);
  return WORDS.test(namespace) && WORDS.test(collection) ? { namespace, collection } : null;
}

/** Whether a collection machine name is in the plugin namespace form (`<namespace>__<collection>`). */
export function isPluginCollectionName(name: string): boolean {
  return parsePluginCollectionName(name) !== null;
}

// ---------- the manifest declarations ----------

export const PLUGIN_FIELD_TYPES = ['string', 'text', 'integer', 'boolean', 'datetime', 'json'] as const;
export const PLUGIN_FIELD_INTERFACES = ['input', 'textarea', 'wysiwyg', 'markdown', 'slug', 'toggle', 'datetime', 'number'] as const;

export const ExtensionCollectionFieldSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/),
  type: z.enum(PLUGIN_FIELD_TYPES),
  interface: z.enum(PLUGIN_FIELD_INTERFACES),
  label: z.string().min(1).max(80).optional(),
  required: z.boolean().optional(),
  /** Hidden fields are never public (the projection's default-deny rules apply to the others). */
  hidden: z.boolean().optional(),
});

export const ExtensionCollectionSchema = z.object({
  /** Local name; the machine name is `<namespace>__<name>`. */
  name: z.string().regex(WORDS).max(MAX_PART),
  label: z.string().min(1).max(80).optional(),
  fields: z.array(ExtensionCollectionFieldSchema).min(1).max(48),
});

export const ExtensionRouteSchema = z.object({
  id: z.string().regex(NAME),
  /** `item`: one page per item (its permalink); `list`: the collection's items, a page at a time, per language. */
  kind: z.enum(['item', 'list']),
  /** `/glossary/:slug` (item) or `/glossary` (list): literal lowercase segments, an item route ending in `:slug`. */
  path: z.string().min(2).max(200),
  /** One of the plugin's own collections (local name). */
  collection: z.string().regex(WORDS).max(MAX_PART),
  /** A template of `templates` (both engines). */
  template: z.string().regex(NAME),
  /** A list page's title (and its `<title>`); the plugin's display name when absent. */
  title: z.string().min(1).max(120).optional(),
  /** Items a list page shows (default 20). */
  pageSize: z.number().int().min(1).max(100).optional(),
  /** Whether its pages are sitemap entries (default true; the indexing decision still applies to each). */
  sitemap: z.boolean().optional(),
  /** Whether its item pages are `llms.txt` entries (default true; the indexing decision still applies). */
  llms: z.boolean().optional(),
});

const SOURCE = z.string().min(1).max(100_000);

export const ExtensionTemplatesSchema = z.object({
  classic: z.record(z.string().regex(NAME), SOURCE).default({}),
  astro: z.record(z.string().regex(NAME), SOURCE).default({}),
});

export const ExtensionComponentSchema = z.object({ classic: SOURCE, astro: SOURCE });

/** The content-extension declarations of a manifest (all optional). */
export const ContentDeclarationsSchema = z.object({
  collections: z.array(ExtensionCollectionSchema).max(16).optional(),
  routes: z.array(ExtensionRouteSchema).max(16).optional(),
  templates: ExtensionTemplatesSchema.optional(),
  components: z.record(z.string().regex(NAME), ExtensionComponentSchema).optional(),
});

export type ExtensionCollection = z.infer<typeof ExtensionCollectionSchema>;
export type ExtensionRoute = z.infer<typeof ExtensionRouteSchema>;
export type ContentDeclarations = z.infer<typeof ContentDeclarationsSchema>;

export const CONTENT_DECLARATION_KEYS = ['collections', 'routes', 'templates', 'components'] as const;

// ---------- route paths ----------

export interface ParsedRoutePath {
  /** Normalised: `/glossary/:slug`, `/glossary` (no trailing slash). */
  path: string;
  /** Literal segments, then `:slug` for an item route. */
  segments: Array<{ kind: 'literal'; value: string } | { kind: 'slug' }>;
}

/** Parse a route path for its kind; `{ error }` when it is outside the grammar. */
export function parseRoutePath(raw: string, kind: 'item' | 'list'): ParsedRoutePath | { error: string } {
  if (!raw.startsWith('/')) return { error: 'a route path starts with "/"' };
  const parts = raw.replace(/\/+$/, '').split('/').slice(1);
  if (parts.length === 0 || parts.some((p) => p === '')) return { error: 'a route path has no empty segments' };
  if (parts.length > 5) return { error: 'a route path has at most 5 segments' };
  const segments: ParsedRoutePath['segments'] = [];
  parts.forEach((p, i) => {
    if (p === ':slug' && kind === 'item' && i === parts.length - 1) segments.push({ kind: 'slug' });
    else if (LITERAL.test(p)) segments.push({ kind: 'literal', value: p });
    else segments.push({ kind: 'literal', value: '' });
  });
  if (segments.some((s) => s.kind === 'literal' && s.value === '')) return { error: 'route segments are lowercase letters, digits and hyphens (an item route ends in :slug)' };
  if (kind === 'item' && segments[segments.length - 1]!.kind !== 'slug') return { error: 'an item route ends in :slug' };
  if (segments[0]!.kind !== 'literal') return { error: 'a route starts with a literal segment' };
  return { path: `/${parts.join('/')}`, segments };
}

/** Whether a content path (no prefix, no trailing slash) is one of the route's pages. */
export function routeMatches(route: { path: string; kind: 'item' | 'list' }, contentPath: string): boolean {
  const parsed = parseRoutePath(route.path, route.kind);
  if ('error' in parsed) return false;
  const parts = contentPath.replace(/\/+$/, '').split('/').slice(1);
  if (parts.length !== parsed.segments.length) return false;
  return parsed.segments.every((s, i) => (s.kind === 'slug' ? parts[i] !== '' : s.value === parts[i]));
}

/** Whether two route paths can name the same address (same length, every literal pair equal). */
export function routePathsOverlap(a: { path: string; kind: 'item' | 'list' }, b: { path: string; kind: 'item' | 'list' }): boolean {
  const pa = parseRoutePath(a.path, a.kind);
  const pb = parseRoutePath(b.path, b.kind);
  if ('error' in pa || 'error' in pb || pa.segments.length !== pb.segments.length) return false;
  return pa.segments.every((s, i) => {
    const t = pb.segments[i]!;
    return s.kind === 'slug' || t.kind === 'slug' || s.value === t.value;
  });
}

// ---------- templates and components ----------

/** What no plugin template or component may contain: the head and the structured data are the system's. */
const MARKUP_RULES: Array<{ re: RegExp; why: string; fragmentOnly?: boolean }> = [
  {
    re: /application\/ld\+json/i,
    why: 'outputs JSON-LD: a plugin contributes structured-data nodes through its manifest (structuredData), the core outputs the graph',
  },
  { re: /<\s*script\b/i, why: 'injects a script: plugins add no scripts to public pages' },
  { re: /\son[a-z]+\s*=/i, why: 'carries an inline event handler' },
  { re: /javascript\s*:/i, why: 'carries a javascript: URL' },
  { re: /rel\s*=\s*["']?canonical/i, why: 'writes a canonical (the system head does)' },
  { re: /name\s*=\s*["']?robots/i, why: 'writes a robots directive (the system head does)' },
  { re: /<\s*base\b/i, why: 'writes a <base> element' },
  { re: /<\s*(iframe|object|embed|frame)\b/i, why: 'embeds another document' },
  { re: /<\s*(html|head|body|meta|link|style|title)\b/i, why: 'writes page-level markup (a component is a fragment the theme places)', fragmentOnly: true },
  { re: /\{%-?\s*(seo_head|item_body)\b/, why: 'places the page head or body (a component is a fragment)', fragmentOnly: true },
  { re: /\bset:html\b/, why: 'writes raw markup (the kit places the system content)' },
];

/** What an Astro source of a plugin may not do (it is built with the site's static build). */
const ASTRO_RULES: Array<{ re: RegExp; why: string }> = [
  { re: /\bprocess\b|\bimport\.meta\b|astro:env|\bglobalThis\b|\bDeno\b|\bBun\b/, why: 'reads the environment or globals' },
  { re: /\bfetch\s*\(|XMLHttpRequest|\bWebSocket\b|\bEventSource\b|\bnavigator\b/, why: 'makes network requests' },
  { re: /\bimport\s*\(|\brequire\s*\(|\beval\s*\(|\bFunction\s*\(|Astro\.glob/, why: 'loads code dynamically' },
  { re: /<\s*[A-Z][A-Za-z0-9]*\b[^>]*\bclient:/, why: 'hydrates on the client (plugins add no scripts)' },
];

/** Static imports an Astro plugin source may use: the kit, its types and plugin components (`heopress:ext/...`). */
const ASTRO_IMPORT = /^\s*import\s+(?:type\s+)?[^'";]*?\s*from\s*['"]([^'"]+)['"]\s*;?\s*$|^\s*import\s+['"]([^'"]+)['"]\s*;?\s*$/;

/**
 * Problems of a plugin's Classic template or Astro source (`fragment`: a component, which may not write page-level
 * markup or place the head). Empty: it may be installed (the Classic Liquid checks of the theme engine run as well).
 */
export function templateSourceProblems(source: string, engine: 'classic' | 'astro', fragment: boolean): string[] {
  const out = new Set<string>();
  for (const r of MARKUP_RULES) if ((!r.fragmentOnly || fragment) && r.re.test(source)) out.add(r.why);
  if (engine === 'astro') {
    const front = /^\s*---\r?\n([\s\S]*?)\r?\n---/.exec(source)?.[1] ?? '';
    for (const r of ASTRO_RULES) if (r.re.test(source)) out.add(r.why);
    for (const line of front.split(/\r?\n/)) {
      if (!/^\s*import\b/.test(line)) continue;
      const m = ASTRO_IMPORT.exec(line);
      const spec = m?.[1] ?? m?.[2];
      const allowed = spec === '@heopress/astro-kit' || spec?.startsWith('@heopress/astro-kit/') || /^heopress:ext\/[a-z][a-z0-9_]*\/[a-z][a-z0-9_-]*$/.test(spec ?? '');
      if (!spec || !allowed) out.add(`imports something other than @heopress/astro-kit or a plugin component: ${line.trim()}`);
    }
    if (!fragment && !/@heopress\/astro-kit\/SeoHead\.astro/.test(source)) out.add('a route template places the system head (@heopress/astro-kit/SeoHead.astro)');
  }
  return [...out];
}

export interface ContentDeclarationIssue {
  path: string;
  message: string;
}

/**
 * Check the content declarations against themselves and the capabilities (requested or granted): collections need
 * `ext:collections`, routes and components `ext:routes`; every route names one of the plugin's collections (an item
 * route's collection has a `slug` field) and a template both engines have; the sources pass `templateSourceProblems`.
 */
export function contentDeclarationIssues(name: string, decl: ContentDeclarations, capabilities: readonly string[]): ContentDeclarationIssue[] {
  const issues: ContentDeclarationIssue[] = [];
  const has = (k: keyof ContentDeclarations) => decl[k] !== undefined && (Array.isArray(decl[k]) ? (decl[k] as unknown[]).length > 0 : Object.keys(decl[k] as object).length > 0);
  if (!has('collections') && !has('routes') && !has('components') && !has('templates')) return issues;
  const ns = extensionNamespace(name);
  if (!ns) issues.push({ path: 'name', message: `"${name}" gives no namespace: a plugin with collections, routes or components needs a name starting with a letter (at most 30 characters once normalised)` });
  if (has('collections') && !declaresExtensionPoint(capabilities, 'collections')) issues.push({ path: 'collections', message: 'collections need the ext:collections capability' });
  if ((has('routes') || has('components') || has('templates')) && !declaresExtensionPoint(capabilities, 'routes')) {
    issues.push({ path: has('routes') ? 'routes' : has('components') ? 'components' : 'templates', message: 'routes, templates and components need the ext:routes capability' });
  }
  const collections = new Map((decl.collections ?? []).map((c) => [c.name, c]));
  if (collections.size !== (decl.collections ?? []).length) issues.push({ path: 'collections', message: 'collection names repeat' });
  for (const c of decl.collections ?? []) {
    const names = c.fields.map((f) => f.name);
    if (new Set(names).size !== names.length) issues.push({ path: `collections.${c.name}`, message: 'field names repeat' });
    if (names.includes('id')) issues.push({ path: `collections.${c.name}`, message: '"id" is the system\'s field' });
  }
  const routeIds = new Set<string>();
  const parsed: Array<{ path: string; kind: 'item' | 'list'; id: string }> = [];
  for (const r of decl.routes ?? []) {
    const where = `routes.${r.id}`;
    if (routeIds.has(r.id)) issues.push({ path: where, message: 'route ids repeat' });
    routeIds.add(r.id);
    const p = parseRoutePath(r.path, r.kind);
    if ('error' in p) issues.push({ path: where, message: p.error });
    else parsed.push({ path: p.path, kind: r.kind, id: r.id });
    const coll = collections.get(r.collection);
    if (!coll) issues.push({ path: where, message: `"${r.collection}" is not one of the plugin's collections` });
    else if (r.kind === 'item' && !coll.fields.some((f) => f.name === 'slug')) issues.push({ path: where, message: `an item route's collection needs a "slug" field (${r.collection})` });
    if (!decl.templates?.classic?.[r.template]) issues.push({ path: where, message: `no Classic template "${r.template}"` });
    if (!decl.templates?.astro?.[r.template]) issues.push({ path: where, message: `no Astro template "${r.template}"` });
  }
  if ((decl.routes ?? []).filter((r) => r.kind === 'item').map((r) => r.collection).some((c, i, all) => all.indexOf(c) !== i)) {
    issues.push({ path: 'routes', message: 'a collection has one item route at most' });
  }
  for (let i = 0; i < parsed.length; i++) {
    for (let j = i + 1; j < parsed.length; j++) {
      if (routePathsOverlap(parsed[i]!, parsed[j]!)) issues.push({ path: `routes.${parsed[j]!.id}`, message: `overlaps route ${parsed[i]!.id} (${parsed[i]!.path})` });
    }
  }
  for (const [engine, map] of Object.entries(decl.templates ?? {}) as Array<['classic' | 'astro', Record<string, string>]>) {
    for (const [tname, source] of Object.entries(map)) {
      for (const message of templateSourceProblems(source, engine, false)) issues.push({ path: `templates.${engine}.${tname}`, message });
    }
  }
  for (const [cname, c] of Object.entries(decl.components ?? {})) {
    for (const message of templateSourceProblems(c.classic, 'classic', true)) issues.push({ path: `components.${cname}.classic`, message });
    for (const message of templateSourceProblems(c.astro, 'astro', true)) issues.push({ path: `components.${cname}.astro`, message });
  }
  return issues;
}

// ---------- the public shape (projection → rendering engines) ----------

/** A plugin route as the rendering engines see it. */
export interface PublicExtensionRoute {
  namespace: string;
  id: string;
  kind: 'item' | 'list';
  /** Content path (no language prefix, no trailing slash): `/glossary/:slug`, `/glossary`. */
  path: string;
  /** The collection's machine name. */
  collection: string;
  /** The template's local name (`ext/<namespace>/<template>` in Classic, `<namespace>/<template>` in Astro). */
  template: string;
  title: string;
  pageSize: number;
  sitemap: boolean;
  llms: boolean;
}

/**
 * The site's enabled content extensions, as the public projection holds them (`lumibase_public_sites.extensions`):
 * routes, the Classic templates by their engine name (`ext/<ns>/<t>`, `ext/<ns>/components/<c>`) and the Astro sources
 * by theirs (`<ns>/<t>`, `<ns>/components/<c>`), and a digest of all of it (the render engine's template cache key).
 */
export interface PublicExtensions {
  hash: string;
  routes: PublicExtensionRoute[];
  classic: Record<string, string>;
  astro: Record<string, string>;
}

export const EMPTY_PUBLIC_EXTENSIONS: PublicExtensions = { hash: '', routes: [], classic: {}, astro: {} };

/** The Classic template name of a plugin route template. */
export const classicTemplateName = (namespace: string, template: string): string => `ext/${namespace}/${template}`;
/** The Classic template name of a plugin component. */
export const classicComponentName = (namespace: string, component: string): string => `ext/${namespace}/components/${component}`;
/** The Astro key of a plugin route template. */
export const astroTemplateKey = (namespace: string, template: string): string => `${namespace}/${template}`;
/** The Astro key of a plugin component (imported as `heopress:ext/<key without "components/">`). */
export const astroComponentKey = (namespace: string, component: string): string => `${namespace}/components/${component}`;

/** Read a projection value as `PublicExtensions` (anything malformed: none). */
export function publicExtensionsOf(value: unknown): PublicExtensions {
  if (!value || typeof value !== 'object') return EMPTY_PUBLIC_EXTENSIONS;
  const v = value as Partial<PublicExtensions>;
  const strMap = (m: unknown) =>
    m && typeof m === 'object' && !Array.isArray(m) ? Object.fromEntries(Object.entries(m as Record<string, unknown>).filter(([, s]) => typeof s === 'string')) as Record<string, string> : {};
  const routes = Array.isArray(v.routes)
    ? v.routes.filter(
        (r): r is PublicExtensionRoute =>
          !!r && typeof r === 'object' && typeof r.namespace === 'string' && typeof r.id === 'string' && (r.kind === 'item' || r.kind === 'list') &&
          typeof r.path === 'string' && typeof r.collection === 'string' && typeof r.template === 'string',
      )
    : [];
  return { hash: typeof v.hash === 'string' ? v.hash : '', routes, classic: strMap(v.classic), astro: strMap(v.astro) };
}

/** The plugin route of a public item's collection, if its pages are one. */
export function itemRouteOf(ext: PublicExtensions, collection: string): PublicExtensionRoute | null {
  return ext.routes.find((r) => r.kind === 'item' && r.collection === collection) ?? null;
}

/** The plugin list route at a content path, if any. */
export function listRouteAt(ext: PublicExtensions, contentPath: string): PublicExtensionRoute | null {
  const path = contentPath.replace(/\/+$/, '') || '/';
  return ext.routes.find((r) => r.kind === 'list' && r.path === path) ?? null;
}
