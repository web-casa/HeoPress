import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { parsePermalinkPattern, sameLocale } from '@heopress/contracts/schemas';
import { collections, contentRoutes, items, redirects, siteContentSettings, sites } from '@heopress/database';
import { ItemServiceError } from '../item-service-error';
import type { SiteTransaction } from '../rls-transaction';
import { buildPath, encodedPath, MAX_URL_PATH } from '@heopress/public-site';
import { isReservedSegment, readAdminSegment } from './reserved-paths';
import { loadSpace, rejectedRuleIds } from './site-rules';
import { appendResourceEvents } from '../../modules/cdc/change-feed/outbox-writer';

/**
 * Content routes (HeoPress P05 tasks 1.3, 1.6; spec content/site-network-model
 * "固定链接"; design A, B).
 *
 * The path of an item of a collection with a permalink pattern is computed
 * from the pattern and kept in `lumibase_content_routes`, in the item's own
 * write transaction — create, edit, publish (manual or scheduled) and delete
 * all call `syncContentRoute`. A path is unique per site and language
 * (drafts hold theirs too): a second item asking for a taken path gets a 409
 * naming the occupant. A published item must have a path; a slug that
 * cannot be a path segment is refused (422). When a PUBLISHED item's path
 * changes, a 301 from the old path to the new one is written in the same
 * transaction; rules that pointed at the old path are pointed at the new one
 * (a chain flattened to one hop), and a rule from the new path is dropped
 * (the live item wins, and no loop is left).
 *
 * Lock order (design §0): callers take the site's content settings row
 * `FOR SHARE` before their first write (`lockContentSettingsShared`); a
 * settings change (pattern, time zone, prefixes) and a category's new slug
 * hold it `FOR UPDATE`, so paths are computed against settings that cannot
 * move meanwhile and a rebuild never interleaves with an item write. An
 * item write that takes a new path then takes the site's route lock (a
 * transaction advisory lock): path claims of one site are serialised, so two
 * items swapping paths queue instead of deadlocking on each other's unique
 * key, and the occupant check before the claim is exact.
 *
 * Stored paths have no language prefix and no trailing slash; the trailing
 * slash policy and prefixes are applied when resolving (design B).
 */

type Tx = SiteTransaction;

/** Lock the site's content settings row for the duration of an item write (no row: nothing to lock). */
export async function lockContentSettingsShared(tx: Tx, siteId: string): Promise<void> {
  await tx.execute(sql`SELECT 1 FROM ${siteContentSettings} WHERE ${siteContentSettings.siteId} = ${siteId} FOR SHARE`);
}

/** Serialise path claims of one site until the transaction ends (taken after the settings lock and the item's row). */
async function lockSiteRoutes(tx: Tx, siteId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`heopress:routes:${siteId}`}, 0))`);
}

type Settings = typeof siteContentSettings.$inferSelect;

/** What computing a path needs from the site, read once per write or rebuild. */
interface RouteContext {
  settings: Settings | undefined;
  defaultLanguage: string;
  adminSegment: string | null;
}

async function loadRouteContext(tx: Tx, siteId: string): Promise<RouteContext> {
  const [settings] = await tx.select().from(siteContentSettings).where(eq(siteContentSettings.siteId, siteId));
  const [site] = await tx.select({ defaultLanguage: sites.defaultLanguage }).from(sites).where(eq(sites.id, siteId));
  return { settings, defaultLanguage: site!.defaultLanguage, adminSegment: await readAdminSegment(tx) };
}

interface RouteRow {
  id: string;
  collectionId: string;
  collection: string;
  data: unknown;
  status: string;
  number: number | null;
  publishedAt: Date | null;
  createdAt: Date;
}

const routeRowColumns = {
  id: items.id,
  collectionId: items.collectionId,
  collection: collections.name,
  data: items.data,
  status: items.status,
  number: items.number,
  publishedAt: items.publishedAt,
  createdAt: items.createdAt,
};

const usesCategory = (ctx: RouteContext, collection: string): boolean =>
  (ctx.settings?.permalinks?.[collection] ?? '').includes(':category');

/**
 * The item's route under the site's settings, or null (no pattern for its collection, or a draft
 * still missing a value the pattern needs). Throws 422 `INVALID_SLUG`, `PATH_REQUIRED` (published
 * without a path) or 409 `PATH_RESERVED`.
 */
function computeRoute(ctx: RouteContext, row: RouteRow, categorySlug: string | null): { locale: string; path: string } | null {
  const settings = ctx.settings;
  const pattern = settings?.permalinks?.[row.collection];
  if (!settings || !pattern) return null;
  const parsed = parsePermalinkPattern(pattern);
  if (!parsed.ok) return null; // validated when saved; never reached
  const data = (row.data ?? {}) as Record<string, unknown>;
  const rawLocale = typeof data.locale === 'string' && data.locale.trim() ? data.locale : ctx.defaultLanguage;
  const locale = settings.availableLocales.find((l) => sameLocale(l, rawLocale)) ?? rawLocale;

  const built = buildPath(parsed.segments, {
    slug: typeof data.slug === 'string' ? data.slug : null,
    number: row.number,
    date: row.publishedAt ?? row.createdAt,
    timezone: settings.timezone,
    category: categorySlug,
    collection: row.collection,
  });
  if (!built.ok) {
    if (built.reason === 'invalid') {
      throw new ItemServiceError('INVALID_SLUG', `"${built.value}" cannot be part of a path: no "/", "\\", "?", "#", "%", spaces or control characters, and not "." or "..".`, 422);
    }
    if (row.status === 'published') {
      throw new ItemServiceError('PATH_REQUIRED', `A published item of ${row.collection} needs a ${built.variable} for its path (${pattern}).`, 422);
    }
    return null;
  }

  // Every address of the path must be requestable: encoded, with a trailing slash and the longest language prefix (17).
  if (encodedPath(built.path, true).length + 17 > MAX_URL_PATH) {
    throw new ItemServiceError('PATH_TOO_LONG', `The path of this item would be longer than ${MAX_URL_PATH - 17} characters once encoded; shorten its slug.`, 422);
  }

  // A path may not start with a language prefix or a reserved top-level path (the resolver could never reach it).
  const first = built.path.split('/')[1]!;
  const prefixes = Object.values(settings.localePrefixes ?? {});
  if (isReservedSegment(first, ctx.adminSegment) || (settings.localeStrategy === 'subdirectory' && prefixes.includes(first))) {
    throw new ItemServiceError('PATH_RESERVED', `The path ${built.path} starts with "${first}", which is reserved or a language prefix.`, 409);
  }
  return { locale, path: built.path };
}

async function categorySlugOf(tx: Tx, siteId: string, ctx: RouteContext, row: RouteRow): Promise<string | null> {
  const id = (row.data as Record<string, unknown> | null)?.primary_category;
  if (!usesCategory(ctx, row.collection) || typeof id !== 'string') return null;
  const [cat] = await tx.select({ data: items.data }).from(items).where(and(eq(items.siteId, siteId), eq(items.id, id)));
  const slug = (cat?.data as Record<string, unknown> | undefined)?.slug;
  return typeof slug === 'string' && slug.trim() ? slug : null;
}

export interface RouteSync {
  /** The item's status before this write ('published' when it was live). */
  wasPublished: boolean;
}

/**
 * Bring the item's route in line with its current row (call after the
 * item's write, inside the same transaction). Throws a 409 `PATH_TAKEN` or
 * `PATH_RESERVED`, or a 422 `INVALID_SLUG` / `PATH_REQUIRED`; the caller's
 * transaction then rolls back.
 */
export async function syncContentRoute(tx: Tx, siteId: string, itemId: string, opts: RouteSync): Promise<void> {
  const [row] = await tx
    .select({ ...routeRowColumns, deletedAt: items.deletedAt })
    .from(items)
    .innerJoin(collections, eq(collections.id, items.collectionId))
    .where(and(eq(items.siteId, siteId), eq(items.id, itemId)));
  const [existing] = await tx.select().from(contentRoutes).where(and(eq(contentRoutes.siteId, siteId), eq(contentRoutes.itemId, itemId)));

  let target: { locale: string; path: string } | null = null;
  if (row && !row.deletedAt) {
    const ctx = await loadRouteContext(tx, siteId);
    target = computeRoute(ctx, row, await categorySlugOf(tx, siteId, ctx, row));
  }
  if (!target) {
    if (existing) await tx.delete(contentRoutes).where(and(eq(contentRoutes.siteId, siteId), eq(contentRoutes.itemId, itemId)));
    return;
  }
  if (existing && existing.locale === target.locale && existing.path === target.path) return;

  await lockSiteRoutes(tx, siteId);
  const [occupant] = await tx
    .select({ itemId: contentRoutes.itemId, collection: collections.name })
    .from(contentRoutes)
    .innerJoin(collections, eq(collections.id, contentRoutes.collectionId))
    .where(and(eq(contentRoutes.siteId, siteId), eq(contentRoutes.locale, target.locale), eq(contentRoutes.path, target.path)));
  if (occupant && occupant.itemId !== itemId) {
    throw new ItemServiceError('PATH_TAKEN', `The path ${target.path} (${target.locale}) is already used by ${occupant.collection} ${occupant.itemId}.`, 409);
  }
  if (existing) await tx.delete(contentRoutes).where(and(eq(contentRoutes.siteId, siteId), eq(contentRoutes.itemId, itemId)));
  await tx.insert(contentRoutes).values({ siteId, itemId, collectionId: row!.collectionId, locale: target.locale, path: target.path });

  // A live item answers at its new path; the old one redirects there (spec "修改 slug").
  await dropRedirectsFrom(tx, siteId, target.locale, target.path);
  if (existing && opts.wasPublished && row!.status === 'published') {
    await writeSlugRedirect(tx, siteId, existing, target);
    await assertRedirectsTerminate(tx, siteId);
  }
}

/**
 * A new slug redirect joins the site's whole rule set (URL layer, language rules, imports): the set
 * must still provably terminate (design R34), or the write is refused (409) and rolls back. Runs under
 * the settings row lock (shared) and the site's route lock, so rule writes of the site are serialised.
 */
async function assertRedirectsTerminate(tx: Tx, siteId: string): Promise<void> {
  const rejected = await rejectedRuleIds(tx, siteId, await loadSpace(tx, siteId));
  if (rejected.size > 0) {
    throw new ItemServiceError('REDIRECT_CONFLICT', `With this change some redirects could loop (rules ${[...rejected.keys()].join(', ')}); nothing was changed.`, 409);
  }
}

/** The live item wins: a redirect from its path would hide it (and could close a loop). */
async function dropRedirectsFrom(tx: Tx, siteId: string, locale: string, path: string): Promise<void> {
  await tx
    .delete(redirects)
    .where(and(eq(redirects.siteId, siteId), eq(redirects.scope, 'content'), eq(redirects.locale, locale), eq(redirects.fromPath, path), eq(redirects.match, 'exact')));
}

async function writeSlugRedirect(tx: Tx, siteId: string, from: { locale: string; path: string }, to: { locale: string; path: string }): Promise<void> {
  // Flatten: rules that led to the old path lead to the new one (one hop). None leads to itself:
  // the rule from the new path was dropped first.
  await tx
    .update(redirects)
    .set({ toPath: to.path, toLocale: to.locale })
    .where(and(eq(redirects.siteId, siteId), eq(redirects.scope, 'content'), eq(redirects.toLocale, from.locale), eq(redirects.toPath, from.path)));
  await tx
    .insert(redirects)
    .values({ siteId, scope: 'content', locale: from.locale, fromPath: from.path, match: 'exact', toPath: to.path, toLocale: to.locale, source: 'slug_change' })
    .onConflictDoUpdate({
      target: [redirects.siteId, redirects.scope, redirects.locale, redirects.fromPath, redirects.match],
      set: { toPath: to.path, toLocale: to.locale, source: 'slug_change' },
    });
}

/** First segments of the site's paths and content redirect sources (used by settings checks). */
export async function routeFirstSegments(tx: Tx, siteId: string): Promise<Set<string>> {
  const rows = (await tx.execute(sql`
    SELECT DISTINCT split_part(${contentRoutes.path}, '/', 2) AS first FROM ${contentRoutes} WHERE ${contentRoutes.siteId} = ${siteId}
    UNION
    SELECT DISTINCT split_part(${redirects.fromPath}, '/', 2) FROM ${redirects} WHERE ${redirects.siteId} = ${siteId} AND ${redirects.scope} = 'content'`)) as unknown as Array<{ first: string }>;
  return new Set(rows.map((r) => r.first));
}

export interface RouteConflict {
  itemId: string;
  locale: string;
  path: string;
  /** The other item that would have the same path. */
  withItemId: string;
}

const CHUNK = 1000;
function* chunks<T>(list: T[]): Generator<T[]> {
  for (let i = 0; i < list.length; i += CHUNK) yield list.slice(i, i + CHUNK);
}
const keyOf = (locale: string, path: string) => `${locale}\u0000${path}`;

/**
 * Recompute the routes of whole collections (a pattern or the time zone
 * changed), or of the articles filed under a category whose slug changed
 * (design R2, B). The caller holds the content settings row `FOR UPDATE`,
 * so no item write runs meanwhile.
 *
 * All new paths are computed first and checked against each other and the
 * routes left as they are; with any conflict nothing changes and the
 * conflicts are returned. Otherwise the changed rows are replaced at once
 * (two items swapping paths is not a conflict), and the content redirects
 * are recomputed from the state BEFORE the rebuild, as one set: every
 * published item whose path moved gets a rule from its old path, rules that
 * led to a moved path lead to its new one, and no rule starts at a path an
 * item now holds (no self-loop, no rule hiding a live item). Settings,
 * category slugs, routes and redirects are each read once; writes go in
 * chunks.
 */
export async function rebuildRoutes(
  tx: Tx,
  siteId: string,
  scope: { collections?: string[]; primaryCategoryId?: string },
  /** `checkRules: false` when the caller checks the final rule set itself (a settings change, once at its end). */
  opts: { checkRules?: boolean } = {},
): Promise<{ conflicts: RouteConflict[]; moved: number }> {
  if (!scope.collections?.length && !scope.primaryCategoryId) return { conflicts: [], moved: 0 };
  const conds: SQL[] = [eq(items.siteId, siteId), sql`${items.deletedAt} IS NULL`];
  if (scope.collections?.length) conds.push(inArray(collections.name, scope.collections));
  if (scope.primaryCategoryId) conds.push(sql`${items.data}->>'primary_category' = ${scope.primaryCategoryId}`);
  const rows = await tx
    .select(routeRowColumns)
    .from(items)
    .innerJoin(collections, eq(collections.id, items.collectionId))
    .where(and(...conds));
  if (rows.length === 0) return { conflicts: [], moved: 0 };

  const ctx = await loadRouteContext(tx, siteId);
  const categoryIdOf = (r: RouteRow) => {
    const id = (r.data as Record<string, unknown> | null)?.primary_category;
    return usesCategory(ctx, r.collection) && typeof id === 'string' ? id : null;
  };
  const categorySlugs = new Map<string, string>();
  const categoryIds = [...new Set(rows.map(categoryIdOf).filter((id): id is string => id !== null))];
  for (const part of chunks(categoryIds)) {
    const cats = await tx.select({ id: items.id, data: items.data }).from(items).where(and(eq(items.siteId, siteId), inArray(items.id, part)));
    for (const c of cats) {
      const slug = (c.data as Record<string, unknown> | null)?.slug;
      if (typeof slug === 'string' && slug.trim()) categorySlugs.set(c.id, slug);
    }
  }

  const next = new Map<string, { locale: string; path: string; collectionId: string; live: boolean }>();
  for (const r of rows) {
    const categoryId = categoryIdOf(r);
    const target = computeRoute(ctx, r, categoryId === null ? null : (categorySlugs.get(categoryId) ?? null));
    if (target) next.set(r.id, { ...target, collectionId: r.collectionId, live: r.status === 'published' });
  }

  // Conflicts among the new paths, and with the routes this rebuild does not touch.
  const rebuilt = new Set(rows.map((r) => r.id));
  const all = await tx.select().from(contentRoutes).where(eq(contentRoutes.siteId, siteId));
  const old = new Map(all.filter((r) => rebuilt.has(r.itemId)).map((r) => [r.itemId, r]));
  const untouched = all.filter((r) => !rebuilt.has(r.itemId));
  const conflicts: RouteConflict[] = [];
  const claimed = new Map<string, string>();
  for (const [itemId, t] of next) {
    const other = claimed.get(keyOf(t.locale, t.path));
    if (other) conflicts.push({ itemId, locale: t.locale, path: t.path, withItemId: other });
    else claimed.set(keyOf(t.locale, t.path), itemId);
  }
  for (const u of untouched) {
    const mine = claimed.get(keyOf(u.locale, u.path));
    if (mine) conflicts.push({ itemId: mine, locale: u.locale, path: u.path, withItemId: u.itemId });
  }
  if (conflicts.length > 0) return { conflicts, moved: 0 };

  const changed = [...rebuilt].filter((id) => {
    const before = old.get(id);
    const after = next.get(id);
    if (!before && !after) return false;
    return !before || !after || before.locale !== after.locale || before.path !== after.path;
  });
  if (changed.length === 0) return { conflicts: [], moved: 0 };
  for (const part of chunks(changed)) {
    await tx.delete(contentRoutes).where(and(eq(contentRoutes.siteId, siteId), inArray(contentRoutes.itemId, part)));
  }
  const inserts = changed.flatMap((id) => {
    const t = next.get(id);
    return t ? [{ siteId, itemId: id, collectionId: t.collectionId, locale: t.locale, path: t.path }] : [];
  });
  for (const part of chunks(inserts)) await tx.insert(contentRoutes).values(part);
  // Renderers learn which addresses moved (design H): one route event per item, no item change behind it.
  const collectionOf = new Map(rows.map((r) => [r.id, r.collection]));
  await appendResourceEvents(
    tx,
    changed.map((id) => ({ siteId, resource: 'content_route', collection: collectionOf.get(id)!, itemId: id, changedFields: ['path'], operation: next.has(id) ? 'update' : 'delete' })),
  );

  // The redirects, computed from the snapshot before the rebuild.
  const moves = new Map<string, { locale: string; path: string }>();
  for (const id of changed) {
    const before = old.get(id);
    const after = next.get(id);
    if (before && after?.live) moves.set(keyOf(before.locale, before.path), { locale: after.locale, path: after.path });
  }
  const occupied = new Set([...untouched.map((u) => keyOf(u.locale, u.path)), ...[...next.values()].map((t) => keyOf(t.locale, t.path))]);
  const rules = await tx
    .select()
    .from(redirects)
    .where(and(eq(redirects.siteId, siteId), eq(redirects.scope, 'content'), eq(redirects.match, 'exact')));
  const ruleFrom = new Map(rules.map((r) => [keyOf(r.locale, r.fromPath), r]));
  const drop: string[] = [];
  const retarget = new Map<string, { locale: string; path: string }>();
  for (const r of rules) {
    if (occupied.has(keyOf(r.locale, r.fromPath))) drop.push(r.id);
    else {
      const to = moves.get(keyOf(r.toLocale ?? r.locale, r.toPath));
      if (to) retarget.set(r.id, to);
    }
  }
  const created: Array<typeof redirects.$inferInsert> = [];
  for (const [fromKey, to] of moves) {
    if (occupied.has(fromKey)) continue; // another item holds the old path now: it answers there
    const existing = ruleFrom.get(fromKey);
    if (existing) {
      retarget.set(existing.id, to);
      continue;
    }
    const [locale, fromPath] = fromKey.split('\u0000') as [string, string];
    created.push({ siteId, scope: 'content', locale, fromPath, match: 'exact', toPath: to.path, toLocale: to.locale, source: 'slug_change' });
  }
  for (const part of chunks(drop)) await tx.delete(redirects).where(and(eq(redirects.siteId, siteId), inArray(redirects.id, part)));
  for (const part of chunks([...retarget])) {
    const values = sql.join(part.map(([id, to]) => sql`(${id}, ${to.path}, ${to.locale})`), sql`, `);
    await tx.execute(sql`
      UPDATE ${redirects} SET to_path = v.to_path, to_locale = v.to_locale
      FROM (VALUES ${values}) AS v(id, to_path, to_locale)
      WHERE ${redirects.siteId} = ${siteId} AND ${redirects.id} = v.id`);
  }
  for (const part of chunks(created)) await tx.insert(redirects).values(part);
  if (opts.checkRules !== false && (moves.size > 0 || drop.length > 0 || retarget.size > 0)) await assertRedirectsTerminate(tx, siteId);
  return { conflicts: [], moved: moves.size };
}

/**
 * Language prefixes changed (subdirectory strategy, design B): each old prefix redirects to its new one
 * with the rest of the path kept (URL-layer prefix rule `/old → /new`). Computed from the rules as they
 * were, in one pass — renaming several prefixes at once (`cn → fr`, `fr → de`) leaves each old address
 * pointing at its own language: rules that led to an old prefix lead to its new one; no prefix rule
 * starts at a prefix that is live now (it answers there), so swapping two languages' prefixes leaves no
 * rule. Called under the settings row `FOR UPDATE`, on every settings change (a prefix can become live
 * without any language moving, e.g. the default language's under `all_prefixed`).
 */
export async function writePrefixMoves(tx: Tx, siteId: string, moves: Array<{ from: string; to: string }>, livePrefixes: string[]): Promise<void> {
  const live = new Set(livePrefixes.map((p) => `/${p}`));
  const moveTo = new Map(moves.map((m) => [`/${m.from}`, `/${m.to}`]));
  const rules = await tx.select().from(redirects).where(and(eq(redirects.siteId, siteId), eq(redirects.scope, 'url')));
  const drop = rules.filter((r) => r.match === 'prefix' && live.has(r.fromPath)).map((r) => r.id);
  if (drop.length > 0) await tx.delete(redirects).where(and(eq(redirects.siteId, siteId), inArray(redirects.id, drop)));
  for (const r of rules) {
    const to = moveTo.get(r.toPath);
    if (to && !drop.includes(r.id)) await tx.update(redirects).set({ toPath: to }).where(and(eq(redirects.siteId, siteId), eq(redirects.id, r.id)));
  }
  for (const [fromPath, toPath] of moveTo) {
    if (live.has(fromPath)) continue;
    await tx
      .insert(redirects)
      .values({ siteId, scope: 'url', locale: '', fromPath, match: 'prefix', toPath, toLocale: '', source: 'prefix_change' })
      .onConflictDoUpdate({ target: [redirects.siteId, redirects.scope, redirects.locale, redirects.fromPath, redirects.match], set: { toPath, source: 'prefix_change' } });
  }
}
