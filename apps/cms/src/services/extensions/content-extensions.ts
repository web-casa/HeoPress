import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, max, sql } from 'drizzle-orm';
import {
  collections,
  contentRoutes,
  extensions,
  fields,
  items,
  redirects,
  siteContentSettings,
  sites,
} from '@heopress/database';
import {
  ContentDeclarationsSchema,
  astroComponentKey,
  astroTemplateKey,
  classicComponentName,
  classicTemplateName,
  contentDeclarationIssues,
  declaresExtensionPoint,
  extensionNamespace,
  parseRoutePath,
  pluginCollectionName,
  routeMatches,
  routePathsOverlap,
  type ContentDeclarations,
  type PublicExtensionRoute,
  type PublicExtensions,
} from '@heopress/contracts/extensions';
import { checkExtensionTemplates } from '@heopress/public-site';
import type { SiteTransaction } from '../rls-transaction';
import { isReservedSegment, readAdminSegment } from '../site-network/reserved-paths';
import { lockContentSettingsExclusive, releaseMemberships } from '../site-network/translation-groups';

/**
 * Content extensions on a site (HeoPress P12 tasks 2.1–2.5; spec extensions/content-extensions):
 *
 *   - **collections** (`ext:collections`): installed when the plugin is enabled, as `<namespace>__<collection>`, owned by
 *     the plugin (`meta.extension`); a collection of that name owned by anything else refuses the enable. Disabling or
 *     uninstalling never deletes them; deleting them for good is `purgePluginCollections`, after an export.
 *   - **routes** (`ext:routes`): checked for conflicts before the enable — the site's paths and content redirects, the other
 *     collections' permalinks, the language prefixes, the system's paths and the other enabled plugins' routes; an item
 *     route is its collection's permalink (`content-routes.ts` reads `extensionRouting`), so the items' paths, the public
 *     projection, the sitemap and the caches follow the core's own rules; disabling withdraws them.
 *   - the routes, templates and components of the enabled plugins are materialised into the public projection
 *     (`publicExtensionsOfSite`): the rendering engines read data, never a plugin.
 *
 * The capabilities consulted here are the GRANTED ones (`lumibase_extensions.capabilities`): a declaration whose
 * extension point was not granted, or was revoked, does nothing.
 */

type Tx = SiteTransaction;
type ExtensionRow = typeof extensions.$inferSelect;

/** The content declarations of a manifest (malformed ones: none). */
function contentOf(manifest: unknown): ContentDeclarations {
  const parsed = ContentDeclarationsSchema.safeParse(manifest && typeof manifest === 'object' ? manifest : {});
  return parsed.success ? parsed.data : {};
}

export function hasContent(manifest: unknown): boolean {
  const c = contentOf(manifest);
  return !!(c.collections?.length || c.routes?.length || Object.keys(c.components ?? {}).length);
}

/**
 * Every problem of a plugin's content declarations for an install or upgrade: the declarations against themselves and
 * the requested capabilities, and the Classic templates through the theme engine's static checks.
 */
export function contentManifestIssues(name: string, manifest: Record<string, unknown>, capabilities: readonly string[]): string[] {
  const parsed = ContentDeclarationsSchema.safeParse(manifest);
  if (!parsed.success) return parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
  const decl = parsed.data;
  const issues = contentDeclarationIssues(name, decl, capabilities).map((i) => `${i.path}: ${i.message}`);
  const ns = extensionNamespace(name);
  if (issues.length || !ns) return issues;
  const classic: Record<string, string> = {};
  for (const [t, source] of Object.entries(decl.templates?.classic ?? {})) classic[classicTemplateName(ns, t)] = source;
  for (const [c, comp] of Object.entries(decl.components ?? {})) classic[classicComponentName(ns, c)] = comp.classic;
  if (Object.keys(classic).length === 0) return issues;
  const pages = (decl.routes ?? []).map((r) => classicTemplateName(ns, r.template));
  const itemPages = (decl.routes ?? []).filter((r) => r.kind === 'item').map((r) => classicTemplateName(ns, r.template));
  return checkExtensionTemplates(classic, pages, itemPages).map((i) => `templates.classic ${i.template}: ${i.message}`);
}

// ---------- collections (task 2.1) ----------

export class ContentExtensionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 404 | 409,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

interface ExtensionMeta {
  name: string;
  namespace: string;
  collection: string;
  /** The last export (purge needs one newer than the last change). */
  export?: { at: string; digest: string; items: number };
}

const extensionMetaOf = (meta: unknown): ExtensionMeta | null => {
  const e = (meta as { extension?: unknown } | null)?.extension as Partial<ExtensionMeta> | undefined;
  return e && typeof e.name === 'string' && typeof e.namespace === 'string' ? (e as ExtensionMeta) : null;
};

/**
 * Install (or adopt) the plugin's collections on the site: each created with its fields, or — owned by the same
 * plugin already (a re-enable, a reinstall after an uninstall) — given the fields it lacks; nothing is dropped, no data
 * touched. A collection of that name owned by anything else: `NAMESPACE_TAKEN`. Returns the machine names.
 */
export async function ensurePluginCollections(tx: Tx, siteId: string, row: Pick<ExtensionRow, 'name' | 'manifest' | 'capabilities'>): Promise<string[]> {
  const decl = contentOf(row.manifest);
  if (!decl.collections?.length || !declaresExtensionPoint((row.capabilities as string[]) ?? [], 'collections')) return [];
  const ns = extensionNamespace(row.name);
  if (!ns) throw new ContentExtensionError('INVALID_MANIFEST', `"${row.name}" gives no namespace.`, 400);
  const out: string[] = [];
  for (const c of decl.collections) {
    const name = pluginCollectionName(ns, c.name);
    const [existing] = await tx.select().from(collections).where(and(eq(collections.siteId, siteId), eq(collections.name, name)));
    let collectionId: string;
    if (existing) {
      const owner = extensionMetaOf(existing.meta);
      if (!owner || owner.name !== row.name) {
        throw new ContentExtensionError('NAMESPACE_TAKEN', `The collection ${name} belongs to ${owner ? `the plugin ${owner.name}` : 'the site'}; this plugin cannot use it.`, 409, { collection: name, owner: owner?.name ?? null });
      }
      collectionId = existing.id;
    } else {
      const [created] = await tx
        .insert(collections)
        .values({
          siteId,
          name,
          label: c.label ?? `${ns}.${c.name}`,
          meta: { extension: { name: row.name, namespace: ns, collection: c.name } satisfies ExtensionMeta },
        })
        .returning({ id: collections.id });
      collectionId = created!.id;
    }
    const have = new Set((await tx.select({ name: fields.name }).from(fields).where(and(eq(fields.siteId, siteId), eq(fields.collectionId, collectionId)))).map((f) => f.name));
    const missing = c.fields.filter((f) => !have.has(f.name));
    if (missing.length) {
      await tx.insert(fields).values(
        missing.map((f, i) => ({
          siteId,
          collectionId,
          name: f.name,
          type: f.type,
          interface: f.interface,
          label: f.label ?? null,
          required: f.required ?? false,
          hidden: f.hidden ?? false,
          sortOrder: have.size + i,
        })),
      );
    }
    out.push(name);
  }
  return out;
}

/** The plugin collections of a site, by namespace (whatever their plugin's state). */
export async function pluginCollections(tx: Tx, siteId: string): Promise<Array<{ id: string; name: string; namespace: string; plugin: string; label: string | null; items: number; export: ExtensionMeta['export'] | null }>> {
  const rows = await tx.select({ id: collections.id, name: collections.name, label: collections.label, meta: collections.meta }).from(collections).where(eq(collections.siteId, siteId)).orderBy(asc(collections.name));
  const owned = rows.flatMap((r) => {
    const m = extensionMetaOf(r.meta);
    return m ? [{ ...r, m }] : [];
  });
  if (!owned.length) return [];
  const counts = new Map(
    (
      await tx
        .select({ id: items.collectionId, n: sql<number>`count(*)`.mapWith(Number) })
        .from(items)
        .where(and(eq(items.siteId, siteId), inArray(items.collectionId, owned.map((o) => o.id))))
        .groupBy(items.collectionId)
    ).map((r) => [r.id, r.n]),
  );
  return owned.map((o) => ({ id: o.id, name: o.name, namespace: o.m.namespace, plugin: o.m.name, label: o.label, items: counts.get(o.id) ?? 0, export: o.m.export ?? null }));
}

/** An export of a namespace's collections: their definitions and every item (drafts and deleted ones included). */
export interface PluginCollectionsExport {
  format: 'heopress-plugin-collections@1';
  siteId: string;
  namespace: string;
  plugin: string;
  exportedAt: string;
  digest: string;
  collections: Array<{
    name: string;
    label: string | null;
    fields: Array<{ name: string; type: string; interface: string; label: string | null; required: boolean; hidden: boolean }>;
    items: Array<{ id: string; status: string; version: number; data: unknown; publishedAt: string | null; createdAt: string; updatedAt: string; deletedAt: string | null }>;
  }>;
}

/**
 * Export a namespace's collections (task 2.1: a hard delete needs one first). The export's digest and time are recorded
 * on each collection; `purgePluginCollections` accepts that digest while nothing changed since.
 */
export async function exportPluginCollections(tx: Tx, siteId: string, namespace: string, now = new Date()): Promise<PluginCollectionsExport> {
  const owned = (await pluginCollections(tx, siteId)).filter((c) => c.namespace === namespace);
  if (!owned.length) throw new ContentExtensionError('NOT_FOUND', `No plugin collections in the namespace ${namespace}.`, 404);
  const out: PluginCollectionsExport['collections'] = [];
  for (const c of owned) {
    const fieldRows = await tx.select().from(fields).where(and(eq(fields.siteId, siteId), eq(fields.collectionId, c.id))).orderBy(asc(fields.sortOrder), asc(fields.name));
    const itemRows = await tx.select().from(items).where(and(eq(items.siteId, siteId), eq(items.collectionId, c.id))).orderBy(asc(items.createdAt), asc(items.id));
    out.push({
      name: c.name,
      label: c.label,
      fields: fieldRows.map((f) => ({ name: f.name, type: f.type, interface: f.interface, label: f.label, required: f.required, hidden: f.hidden })),
      items: itemRows.map((i) => ({
        id: i.id,
        status: i.status,
        version: i.version,
        data: i.data,
        publishedAt: i.publishedAt?.toISOString() ?? null,
        createdAt: i.createdAt.toISOString(),
        updatedAt: i.updatedAt.toISOString(),
        deletedAt: i.deletedAt?.toISOString() ?? null,
      })),
    });
  }
  const digest = createHash('sha256').update(JSON.stringify(out)).digest('hex');
  const exportedAt = now.toISOString();
  for (const c of owned) {
    const record = { at: exportedAt, digest, items: out.find((o) => o.name === c.name)!.items.length };
    await tx
      .update(collections)
      .set({ meta: sql`jsonb_set(${collections.meta}, '{extension,export}', ${JSON.stringify(record)}::jsonb)` })
      .where(and(eq(collections.siteId, siteId), eq(collections.id, c.id)));
  }
  return { format: 'heopress-plugin-collections@1', siteId, namespace, plugin: owned[0]!.plugin, exportedAt, digest, collections: out };
}

/**
 * Delete a namespace's collections and their items for good (task 2.1). Refused unless no plugin of that namespace is
 * enabled on the site, `confirm` repeats the namespace, and `exportDigest` is the digest of an export made after the
 * last change of any of their items (a later edit needs a new export). Returns the collections deleted.
 */
export async function purgePluginCollections(tx: Tx, siteId: string, namespace: string, input: { confirm?: unknown; exportDigest?: unknown }): Promise<string[]> {
  if (input.confirm !== namespace) {
    throw new ContentExtensionError('CONFIRMATION_REQUIRED', `Type the namespace (${namespace}) to delete its collections and items for good.`, 400);
  }
  await lockContentSettingsExclusive(tx, siteId);
  const owned = (await pluginCollections(tx, siteId)).filter((c) => c.namespace === namespace);
  if (!owned.length) throw new ContentExtensionError('NOT_FOUND', `No plugin collections in the namespace ${namespace}.`, 404);
  const enabled = (await tx.select({ name: extensions.name }).from(extensions).where(and(eq(extensions.siteId, siteId), eq(extensions.enabled, true)))).filter(
    (e) => extensionNamespace(e.name) === namespace,
  );
  if (enabled.length) throw new ContentExtensionError('PLUGIN_ENABLED', `Disable ${enabled[0]!.name} before deleting its data.`, 409);
  for (const c of owned) {
    const exp = c.export;
    if (!exp || exp.digest !== input.exportDigest) {
      throw new ContentExtensionError('EXPORT_REQUIRED', 'Export the collections first, and delete with that export\'s digest.', 409, { namespace });
    }
    const [last] = await tx.select({ at: max(items.updatedAt), n: sql<number>`count(*)`.mapWith(Number) }).from(items).where(and(eq(items.siteId, siteId), eq(items.collectionId, c.id)));
    if ((last?.n ?? 0) !== exp.items || (last?.at && last.at.getTime() > Date.parse(exp.at))) {
      throw new ContentExtensionError('EXPORT_STALE', 'The items changed since the export: export them again first.', 409, { namespace });
    }
  }
  for (const c of owned) {
    await releaseMemberships(tx, siteId, { collectionId: c.id });
    await tx.delete(collections).where(and(eq(collections.siteId, siteId), eq(collections.id, c.id)));
  }
  return owned.map((c) => c.name);
}

// ---------- routes (task 2.2) ----------

export interface RouteConflict {
  /** The plugin route's path. */
  route: string;
  /** The address or pattern it conflicts with. */
  path: string;
  reason: 'system-path' | 'locale-prefix' | 'content' | 'redirect' | 'permalink' | 'plugin';
  /** The other plugin or collection, when there is one. */
  with?: string;
}

/** The enabled plugins' content extensions of a site: what content routes and the projection use. */
interface EnabledContent {
  row: Pick<ExtensionRow, 'id' | 'name' | 'version' | 'capabilities' | 'manifest'>;
  namespace: string;
  decl: ContentDeclarations;
  routes: boolean;
  collections: boolean;
}

async function enabledContent(tx: Tx, siteId: string): Promise<EnabledContent[]> {
  const rows = await tx
    .select({ id: extensions.id, name: extensions.name, version: extensions.version, capabilities: extensions.capabilities, manifest: extensions.manifest })
    .from(extensions)
    .where(and(eq(extensions.siteId, siteId), eq(extensions.enabled, true)))
    .orderBy(asc(extensions.name), asc(extensions.id));
  const out: EnabledContent[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const ns = extensionNamespace(row.name);
    if (!ns || seen.has(ns)) continue;
    const decl = contentOf(row.manifest);
    const caps = (row.capabilities as string[]) ?? [];
    if (!decl.collections?.length && !decl.routes?.length && !Object.keys(decl.components ?? {}).length) continue;
    seen.add(ns);
    out.push({ row, namespace: ns, decl, routes: declaresExtensionPoint(caps, 'routes'), collections: declaresExtensionPoint(caps, 'collections') });
  }
  return out;
}

/** A plugin route on the site: its path and kind, its collection's machine name. */
interface SiteRoute {
  namespace: string;
  plugin: string;
  id: string;
  kind: 'item' | 'list';
  path: string;
  collection: string;
}

function routesOf(e: Pick<EnabledContent, 'namespace' | 'decl' | 'row'>): SiteRoute[] {
  return (e.decl.routes ?? []).flatMap((r) => {
    const p = parseRoutePath(r.path, r.kind);
    return 'error' in p ? [] : [{ namespace: e.namespace, plugin: e.row.name, id: r.id, kind: r.kind, path: p.path, collection: pluginCollectionName(e.namespace, r.collection) }];
  });
}

/**
 * What the item paths of a site follow from its enabled plugins (`content-routes.ts`): each plugin collection's
 * permalink (its item route) and the paths every plugin route claims (no other item may take one).
 */
export async function extensionRouting(tx: Tx, siteId: string): Promise<{ permalinks: Record<string, string>; claims: Array<{ collection: string; kind: 'item' | 'list'; path: string }> }> {
  const permalinks: Record<string, string> = {};
  const claims: Array<{ collection: string; kind: 'item' | 'list'; path: string }> = [];
  for (const e of await enabledContent(tx, siteId)) {
    if (!e.routes) continue;
    for (const r of routesOf(e)) {
      claims.push({ collection: r.collection, kind: r.kind, path: r.path });
      if (r.kind === 'item' && e.collections) permalinks[r.collection] = r.path;
    }
  }
  return { permalinks, claims };
}

/**
 * The conflicts of a plugin's routes on a site (task 2.2), as if it were enabled now: a first segment the system keeps
 * (`isReservedSegment`: discovery and root files, `_…`, the admin path; and the renderer's `/search`), a language prefix,
 * a path an item or a content redirect already has (any language), another collection's permalink with the same literal
 * start that can name the same address, or another enabled plugin's route. Empty: it may be enabled.
 */
export async function routeConflicts(tx: Tx, siteId: string, row: Pick<ExtensionRow, 'id' | 'name' | 'manifest' | 'capabilities'>): Promise<RouteConflict[]> {
  const ns = extensionNamespace(row.name);
  const decl = contentOf(row.manifest);
  if (!ns || !decl.routes?.length || !declaresExtensionPoint((row.capabilities as string[]) ?? [], 'routes')) return [];
  const mine = routesOf({ namespace: ns, decl, row: row as EnabledContent['row'] });
  const conflicts: RouteConflict[] = [];
  const [settings] = await tx.select().from(siteContentSettings).where(eq(siteContentSettings.siteId, siteId));
  const [site] = await tx.select({ defaultLanguage: sites.defaultLanguage }).from(sites).where(eq(sites.id, siteId));
  const locales = settings?.availableLocales ?? [site?.defaultLanguage ?? 'en'];
  const prefixes = new Set(locales.map((l) => (Object.entries(settings?.localePrefixes ?? {}).find(([k]) => k.toLowerCase() === l.toLowerCase())?.[1] ?? l.toLowerCase())));
  const admin = await readAdminSegment(tx);
  const others = (await enabledContent(tx, siteId)).filter((e) => e.row.id !== row.id && e.routes);
  const contentPaths = (await tx.select({ path: contentRoutes.path, collection: collections.name }).from(contentRoutes).innerJoin(collections, eq(collections.id, contentRoutes.collectionId)).where(eq(contentRoutes.siteId, siteId)));
  const redirectPaths = (await tx.select({ path: redirects.fromPath }).from(redirects).where(and(eq(redirects.siteId, siteId), eq(redirects.scope, 'content'))));
  const ownCollections = new Set(mine.map((r) => r.collection));
  for (const r of mine) {
    const first = r.path.split('/')[1]!;
    if (isReservedSegment(first, admin) || first === 'search') conflicts.push({ route: r.path, path: `/${first}`, reason: 'system-path' });
    if (prefixes.has(first)) conflicts.push({ route: r.path, path: `/${first}`, reason: 'locale-prefix' });
    // An item route claims its section too: a page already at `/glossary/` conflicts with `/glossary/:slug`.
    const section = r.kind === 'item' ? r.path.replace(/\/:slug$/, '') : null;
    for (const c of contentPaths) {
      if (ownCollections.has(c.collection)) continue;
      if (routeMatches(r, c.path) || (section && c.path.replace(/\/+$/, '') === section)) {
        conflicts.push({ route: r.path, path: `${c.path}/`, reason: 'content', with: c.collection });
      }
    }
    for (const p of redirectPaths) if (routeMatches(r, p.path)) conflicts.push({ route: r.path, path: `${p.path}/`, reason: 'redirect' });
    for (const [collection, pattern] of Object.entries(settings?.permalinks ?? {})) {
      // Only a permalink starting with the same literal segment: one starting with a variable (`/:slug`) is checked by
      // the paths its items have (above) and kept off the route's paths from now on (content-routes.ts).
      if (ownCollections.has(collection) || !segmentsOverlap(pattern, r.path) || pattern.split('/')[1] !== first) continue;
      conflicts.push({ route: r.path, path: pattern, reason: 'permalink', with: collection });
    }
    for (const o of others) for (const theirs of routesOf(o)) if (routePathsOverlap(r, theirs)) conflicts.push({ route: r.path, path: theirs.path, reason: 'plugin', with: o.row.name });
  }
  const seen = new Set<string>();
  return conflicts.filter((c) => {
    const k = `${c.route}|${c.path}|${c.reason}|${c.with ?? ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Whether two path patterns (`:<variable>` any one segment) can name the same address. */
function segmentsOverlap(a: string, b: string): boolean {
  const sa = a.replace(/\/+$/, '').split('/');
  const sb = b.replace(/\/+$/, '').split('/');
  return sa.length === sb.length && sa.every((x, i) => x.startsWith(':') || sb[i]!.startsWith(':') || x === sb[i]);
}

/** The plugin collections whose items' paths an enable or disable of the plugin moves. */
export function routedCollections(row: Pick<ExtensionRow, 'name' | 'manifest'>): string[] {
  const ns = extensionNamespace(row.name);
  if (!ns) return [];
  return [...new Set((contentOf(row.manifest).routes ?? []).filter((r) => r.kind === 'item').map((r) => pluginCollectionName(ns, r.collection)))];
}

// ---------- the public projection (tasks 2.3–2.5) ----------

const stable = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));

/**
 * The content extensions the site's public output uses (`lumibase_public_sites.extensions`): the routes of the enabled
 * plugins granted `ext:routes` — an item route only while its collection is installed and owned by the plugin (and
 * `ext:collections` granted) — with their Classic and Astro default templates, and their components. A plugin disabled,
 * uninstalled or without the grant contributes nothing: its pages, sitemap entries and components go with the next
 * output (the render version moves with this row).
 */
export async function publicExtensionsOfSite(tx: Tx, siteId: string): Promise<PublicExtensions> {
  const enabled = (await enabledContent(tx, siteId)).filter((e) => e.routes);
  if (!enabled.length) return { hash: '', routes: [], classic: {}, astro: {} };
  const owned = new Map((await pluginCollections(tx, siteId)).map((c) => [c.name, c.plugin]));
  const routes: PublicExtensionRoute[] = [];
  const classic: Record<string, string> = {};
  const astro: Record<string, string> = {};
  for (const e of enabled) {
    const ns = e.namespace;
    for (const r of e.decl.routes ?? []) {
      const collection = pluginCollectionName(ns, r.collection);
      if (!e.collections || owned.get(collection) !== e.row.name) continue;
      const p = parseRoutePath(r.path, r.kind);
      if ('error' in p) continue;
      routes.push({
        namespace: ns,
        id: r.id,
        kind: r.kind,
        path: p.path,
        collection,
        template: r.template,
        title: r.title ?? ((e.row.manifest as { displayName?: unknown }).displayName as string | undefined) ?? e.row.name,
        pageSize: r.pageSize ?? 20,
        sitemap: r.sitemap ?? true,
        llms: r.llms ?? true,
      });
    }
    for (const [t, source] of Object.entries(e.decl.templates?.classic ?? {})) classic[classicTemplateName(ns, t)] = source;
    for (const [t, source] of Object.entries(e.decl.templates?.astro ?? {})) astro[astroTemplateKey(ns, t)] = source;
    for (const [c, comp] of Object.entries(e.decl.components ?? {})) {
      classic[classicComponentName(ns, c)] = comp.classic;
      astro[astroComponentKey(ns, c)] = comp.astro;
    }
  }
  const body = { routes, classic, astro };
  return { hash: createHash('sha256').update(stable(body)).digest('hex').slice(0, 16), ...body };
}

