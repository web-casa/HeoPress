import { createHash } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { collections, contentRoutes, items, redirects, siteContentSettings, siteDomains, type Database } from '@heopress/database';
import { AuditLogger } from '../../modules/audit/logger';
import { appendItemEvent } from '../../modules/cdc/change-feed/outbox-writer';
import { runSiteTransaction, type SiteTransaction } from '../rls-transaction';
import type { SitePathSpace } from '@heopress/public-site';
import { ancestorsOf, applyRule, pickRule, RuleSetTooComplexError, segmentsOf, stepLimit, validateRules, type EngineRule, type Loc } from '@heopress/public-site';
import { parseRedirectImport, type ConvertedRule, type ImportFormat, type ManualRecord } from './redirect-import-parse';
import { assertSiteRulesTerminate, loadSpace, lockAddressSpace, siteEngineRules } from './site-rules';

/**
 * Importing redirects (HeoPress P05 tasks 1.7, 1.8; spec
 * content/site-network-model "批量导入重定向"; design B, R34–R36).
 *
 * A dry run reads the file (redirect-import-parse.ts) and reports, rule by
 * rule, what an import would do:
 * - `import`: new URL-layer rules (paths as requested, language prefix
 *   included); `replaced`: a stored rule from the same source gets the new
 *   target; `unchanged`: already stored as is;
 * - `flattened`: rules whose target is redirected further — the resolver
 *   still answers one 301, to the final address listed;
 * - `loops` and `manual`: rules the termination check does not accept
 *   (a loop shown on a concrete path, or no proof it ends) — not imported,
 *   and stored rules are never given up for them;
 * - `conflicts`: sources where a published item answers — not imported
 *   unless asked (`importConflicting`; the live item still wins);
 * - `manual` also lists records that are no plain path rule (regular
 *   expressions, queries, other hosts, temporary redirects, …), each with its
 *   original text.
 *
 * The report carries a hash of the file's rules, the decisions, the stored
 * rules and the site's address space. The import sends it back and runs the
 * same plan under the settings lock: a different hash (something changed
 * since the dry run) is a 409 asking for a new dry run; otherwise the rules
 * are written in that transaction, the whole rule set is checked again, and
 * the import is audited.
 */

/**
 * The largest file an import reads. The request carrying it is a JSON body too, so it must also fit the
 * app's JSON body limit (HEOPRESS_MAX_JSON_BODY, 1 MiB by default): split larger files, or raise that limit.
 */
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const MAX_IMPORT_RULES = 20_000;

type Entry = Pick<ConvertedRule, 'line' | 'from' | 'to' | 'match' | 'notes'>;

export interface RedirectImportReport {
  format: ImportFormat;
  summary: Record<'import' | 'replaced' | 'unchanged' | 'flattened' | 'loops' | 'conflicts' | 'manual', number>;
  import: Entry[];
  replaced: Array<Entry & { previousTo: string }>;
  unchanged: Entry[];
  /** `final`: where the target ends on the primary domain; `elsewhere`: other domains where it ends differently. */
  flattened: Array<Entry & { final: string; elsewhere?: Array<{ host: string; final: string }> }>;
  /** Stored rules that end somewhere else once the import is in (still one 301, to `final`). */
  flattenedStored: Array<{ from: string; to: string; match: string; before: string; final: string; elsewhere?: Array<{ host: string; before: string; final: string }> }>;
  loops: Entry[];
  /** Sources at or above a published item's address (on any of the site's hosts): the item answers there. */
  conflicts: Array<Entry & { itemId: string; collection: string; address: string; items: number }>;
  manual: Array<ManualRecord | (Entry & { reason: string })>;
  reportHash: string;
}

export class RedirectImportError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 409 | 413,
    readonly report?: RedirectImportReport,
  ) {
    super(message);
  }
}

export interface ImportOptions {
  format?: ImportFormat;
  /** Import rules whose source a published item answers at (the item still wins while it is published). */
  importConflicting?: boolean;
}

const entry = (r: ConvertedRule): Entry => ({ line: r.line, from: r.from, to: r.to, match: r.match, ...(r.notes ? { notes: r.notes } : {}) });
const keyOf = (loc: Loc) => `${loc.host}\u0000${loc.path}`;
const locOf = (key: string): Loc => {
  const [host, path] = key.split('\u0000') as [string, string];
  return { host, path };
};

interface LiveRoute {
  locale: string;
  path: string;
  itemId: string;
  collection: string;
}

/**
 * Every published item's addresses on every host of the site, for conflicts and for resolving as the
 * public resolver does (a live item ends resolution).
 */
async function liveAddresses(tx: SiteTransaction, siteId: string, space: SitePathSpace): Promise<{ routes: LiveRoute[]; at: Map<string, LiveRoute>; sorted: string[] }> {
  const routes = await tx
    .select({ locale: contentRoutes.locale, path: contentRoutes.path, itemId: contentRoutes.itemId, collection: collections.name })
    .from(contentRoutes)
    .innerJoin(items, eq(items.id, contentRoutes.itemId))
    .innerJoin(collections, eq(collections.id, contentRoutes.collectionId))
    .where(and(eq(contentRoutes.siteId, siteId), eq(items.status, 'published'), isNull(items.deletedAt)));
  const at = new Map<string, LiveRoute>();
  for (const r of routes) for (const loc of space.addressesOf(r.locale, r.path)) at.set(keyOf(loc), r);
  return { routes, at, sorted: [...at.keys()].sort() };
}

/** The live addresses at or below `from` on `host` (a prefix source covers them). */
function liveUnder(live: { at: Map<string, LiveRoute>; sorted: string[] }, host: string, from: string): LiveRoute[] {
  const out: LiveRoute[] = [];
  const self = live.at.get(keyOf({ host, path: from }));
  if (self) out.push(self);
  const start = keyOf({ host, path: from === '/' ? '/' : `${from}/` });
  let lo = 0;
  let hi = live.sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (live.sorted[mid]! < start) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo; i < live.sorted.length && live.sorted[i]!.startsWith(start); i++) {
    const r = live.at.get(live.sorted[i]!)!;
    if (r !== self) out.push(r);
  }
  return out;
}

/**
 * Where a location ends, as the public resolver answers it: rules applied by priority until none matches or
 * a live item answers. Rules are looked up by host and path, and every location on the way remembers its end,
 * so chains are walked once.
 */
function resolverOver(rules: EngineRule[], isLive: (loc: Loc) => boolean): (start: Loc) => Loc | null {
  const byKey = new Map<string, EngineRule[]>();
  for (const r of rules) {
    const k = keyOf({ host: r.host, path: r.from });
    byKey.set(k, [...(byKey.get(k) ?? []), r]);
  }
  const lookup = (loc: Loc) => ancestorsOf(loc.path).flatMap((a) => byKey.get(keyOf({ host: loc.host, path: a })) ?? []);
  const memo = new Map<string, string | null>();
  const limit = stepLimit(rules.length, '/', Math.max(0, ...rules.map((r) => segmentsOf(r.to).length)) + 64);
  return (start) => {
    const trail: string[] = [];
    const seen = new Set<string>();
    let loc = start;
    let end: string | null;
    for (;;) {
      const k = keyOf(loc);
      if (memo.has(k)) {
        end = memo.get(k)!;
        break;
      }
      if (seen.has(k) || trail.length > limit) {
        end = null; // a loop: an accepted rule set never gets here
        break;
      }
      seen.add(k);
      trail.push(k);
      const rule = isLive(loc) ? null : pickRule(lookup(loc), loc);
      if (!rule) {
        end = k;
        break;
      }
      loc = applyRule(rule, loc);
    }
    for (const t of trail) memo.set(t, end);
    return end === null ? null : locOf(end);
  };
}

/** What importing `content` would do now (no writes). */
async function planRedirectImport(
  tx: SiteTransaction,
  siteId: string,
  content: string,
  opts: ImportOptions,
): Promise<{ report: RedirectImportReport; write: ConvertedRule[] }> {
  if (Buffer.byteLength(content, 'utf8') > MAX_IMPORT_BYTES) {
    throw new RedirectImportError('TOO_LARGE', `The file is larger than ${MAX_IMPORT_BYTES / 1024 / 1024} MB.`, 413);
  }
  const space = await loadSpace(tx, siteId);
  const domains = await tx
    .select({ hostname: siteDomains.hostname, status: siteDomains.status, isPrimary: siteDomains.isPrimary, entryLocale: siteDomains.entryLocale })
    .from(siteDomains)
    .where(eq(siteDomains.siteId, siteId));
  const active = domains.filter((d) => d.status === 'active');
  const parsed = parseRedirectImport(
    content,
    {
      site: new Set(active.filter((d) => !d.entryLocale).map((d) => d.hostname.toLowerCase())),
      languageEntries: new Set(active.filter((d) => d.entryLocale).map((d) => d.hostname.toLowerCase())),
    },
    opts.format,
  );
  if ('error' in parsed) throw new RedirectImportError('UNREADABLE', `The file could not be read: ${parsed.error}.`, 400);
  if (parsed.rules.length > MAX_IMPORT_RULES) {
    throw new RedirectImportError('TOO_MANY', `At most ${MAX_IMPORT_RULES} rules per import; split the file.`, 413);
  }

  const stored = await tx.select().from(redirects).where(eq(redirects.siteId, siteId));
  const storedUrl = new Map(stored.filter((r) => r.scope === 'url').map((r) => [`${r.match}\u0000${r.fromPath}`, r]));
  const live = await liveAddresses(tx, siteId, space);
  const isLive = (loc: Loc) => live.at.has(keyOf(loc));

  const report: Omit<RedirectImportReport, 'summary' | 'reportHash'> = {
    format: parsed.format,
    import: [],
    replaced: [],
    unchanged: [],
    flattened: [],
    flattenedStored: [],
    loops: [],
    conflicts: [],
    manual: [...parsed.manual],
  };

  // Published items first, on every host (URL-layer rules apply on each): by default their sources stay out.
  let candidates: ConvertedRule[] = [];
  for (const r of parsed.rules) {
    const hits = space.hosts().flatMap((host) => (r.match === 'exact' ? [live.at.get(keyOf({ host, path: r.from }))].filter((x): x is LiveRoute => !!x) : liveUnder(live, host, r.from)));
    if (hits.length > 0) {
      const first = hits[0]!;
      report.conflicts.push({ ...entry(r), itemId: first.itemId, collection: first.collection, address: `${first.locale}:${first.path}`, items: new Set(hits.map((h) => h.itemId)).size });
      if (!opts.importConflicting) continue;
    }
    const existing = storedUrl.get(`${r.match}\u0000${r.from}`);
    if (existing && existing.toPath === r.to) {
      report.unchanged.push(entry(r));
      continue;
    }
    candidates.push(r);
  }

  // The termination check on the rule set as it would be. A candidate replacing a stored rule takes its place;
  // when the candidate is refused, the stored rule is back — and the set is checked again, until nothing more
  // is refused: the plan is exactly the set the import writes.
  const storedRules = await siteEngineRules(tx, siteId, space);
  const engineOf = (r: ConvertedRule): EngineRule[] =>
    space.hosts().map((host) => ({ id: `import:${r.line}`, layer: 'url', host, toHost: host, from: r.from, match: r.match, to: r.to }));
  const verdict = new Map<number, 'loop' | 'manual'>();
  let accepted: EngineRule[];
  for (;;) {
    const replacedIds = new Set(candidates.map((r) => storedUrl.get(`${r.match}\u0000${r.from}`)?.id).filter((id): id is string => !!id));
    const result = await validateRules([...storedRules.filter((r) => !replacedIds.has(r.id)), ...candidates.flatMap(engineOf)]).catch((err: unknown) => {
      if (err instanceof RuleSetTooComplexError) throw new RedirectImportError('TOO_COMPLEX', err.message, 413);
      throw err;
    });
    const refused = new Map<number, 'loop' | 'manual'>();
    for (const x of result.rejected) {
      if (!x.rule.id.startsWith('import:')) continue;
      const line = Number(x.rule.id.slice('import:'.length));
      if (refused.get(line) !== 'loop') refused.set(line, x.reason);
    }
    if (refused.size === 0) {
      if (result.rejected.length > 0) {
        throw new RedirectImportError('STORED_RULES_INVALID', 'Some stored redirects cannot take effect; repair them first (GET /redirects?check=1, POST /redirects/delete).', 409);
      }
      accepted = result.accepted;
      break;
    }
    for (const [line, reason] of refused) verdict.set(line, reason);
    candidates = candidates.filter((r) => !refused.has(r.line));
  }
  for (const r of parsed.rules) {
    const v = verdict.get(r.line);
    if (v === 'loop') report.loops.push(entry(r));
    if (v === 'manual') report.manual.push({ ...entry(r), reason: 'cannot be shown to end (it would keep redirecting)' });
  }

  // Where things end, as the public resolver answers: before (stored rules only) and after the import.
  const before = resolverOver(storedRules, isLive);
  const after = resolverOver(accepted, isLive);
  const show = (loc: Loc | null) => (loc === null ? '(loop)' : loc.host === space.primaryHost ? loc.path : `//${loc.host}${loc.path}`);
  const write = candidates;
  for (const r of write) {
    const existing = storedUrl.get(`${r.match}\u0000${r.from}`);
    if (existing) report.replaced.push({ ...entry(r), previousTo: existing.toPath });
    else report.import.push(entry(r));
    // A URL-layer rule applies on every domain: where its target ends may differ per domain (a live item on one).
    const ends = space.hosts().map((host) => ({ host, target: { host, path: r.to }, end: after({ host, path: r.to }) }));
    const [primary, ...others] = ends;
    const moved = ends.some((e) => e.end && keyOf(e.end) !== keyOf(e.target));
    if (moved) {
      const elsewhere = others.filter((o) => show(o.end) !== show(primary!.end)).map((o) => ({ host: o.host, final: show(o.end) }));
      report.flattened.push({ ...entry(r), final: show(primary!.end), ...(elsewhere.length ? { elsewhere } : {}) });
    }
  }
  const written = new Set(write.map((w) => `${w.match}\u0000${w.from}`));
  for (const r of stored) {
    if (r.scope !== 'url' || written.has(`${r.match}\u0000${r.fromPath}`)) continue;
    const perHost = space.hosts().map((host) => ({ host, was: show(before({ host, path: r.toPath })), now: show(after({ host, path: r.toPath })) }));
    const [primary, ...others] = perHost;
    if (perHost.some((p) => p.was !== p.now)) {
      const elsewhere = others.filter((o) => o.was !== primary!.was || o.now !== primary!.now).map((o) => ({ host: o.host, before: o.was, final: o.now }));
      report.flattenedStored.push({ from: r.fromPath, to: r.toPath, match: r.match, before: primary!.was, final: primary!.now, ...(elsewhere.length ? { elsewhere } : {}) });
    }
  }
  report.manual.sort((a, b) => a.line - b.line);

  // The hash binds the import to everything the plan read: the file, the options, the stored rules, the live
  // addresses, the domains and the settings.
  const [settings] = await tx.select({ version: siteContentSettings.version }).from(siteContentSettings).where(eq(siteContentSettings.siteId, siteId));
  const reportHash = createHash('sha256')
    .update(
      JSON.stringify({
        file: createHash('sha256').update(content).digest('hex'),
        options: { format: parsed.format, importConflicting: opts.importConflicting === true },
        report,
        stored: stored.map((r) => [r.id, r.scope, r.locale, r.fromPath, r.match, r.toLocale, r.toPath]).sort(),
        live: live.routes.map((r) => [r.locale, r.path, r.itemId]).sort(),
        domains: domains.map((d) => [d.hostname, d.status, d.isPrimary, d.entryLocale]).sort(),
        settingsVersion: settings?.version ?? 0,
        // The default language is on the site row (PATCH /site), not in the settings version.
        defaultLanguage: space.defaultLocale,
      }),
    )
    .digest('hex');
  const summary = {
    import: report.import.length,
    replaced: report.replaced.length,
    unchanged: report.unchanged.length,
    flattened: report.flattened.length,
    loops: report.loops.length,
    conflicts: report.conflicts.length,
    manual: report.manual.length,
  };
  return { report: { ...report, summary, reportHash }, write };
}

/** The new row's value in an upsert (`excluded.<column>`). */
const sqlExcluded = (column: string) => sql.raw(`excluded."${column}"`) as unknown as string;

/** A dry run: the report only. */
export async function dryRunRedirectImport(db: Database, siteId: string, content: string, opts: ImportOptions): Promise<RedirectImportReport> {
  return runSiteTransaction(db, siteId, async (tx) => (await planRedirectImport(tx, siteId, content, opts)).report);
}

/** The import of a dry run's report (same file, same options, its hash). */
export async function importRedirects(
  db: Database,
  siteId: string,
  content: string,
  opts: ImportOptions & { reportHash: string; actor: { userId: string | null; email?: string | null } },
): Promise<{ importId: string; report: RedirectImportReport }> {
  return runSiteTransaction(db, siteId, (tx) => importRedirectsInTransaction(tx, db, siteId, content, opts));
}

/**
 * The import inside the caller's transaction (HeoPress P12: a site import batch's redirects are written when it is
 * activated, with its items). With `reportHash`, a different plan is a 409 as above; without, the plan made now is
 * written — loops, manual records and (unless asked) conflicts stay out, as always.
 */
export async function importRedirectsInTransaction(
  tx: SiteTransaction,
  db: Database,
  siteId: string,
  content: string,
  opts: ImportOptions & { reportHash?: string; actor: { userId: string | null; email?: string | null } },
): Promise<{ importId: string; report: RedirectImportReport }> {
  {
    await lockAddressSpace(tx, siteId);
    const { report, write } = await planRedirectImport(tx, siteId, content, opts);
    if (opts.reportHash !== undefined && report.reportHash !== opts.reportHash) {
      throw new RedirectImportError('REPORT_STALE', 'The site changed since the dry run (or the file differs); run the dry run again.', 409, report);
    }
    const importId = nanoid();
    for (let i = 0; i < write.length; i += 1000) {
      await tx
        .insert(redirects)
        .values(
          write.slice(i, i + 1000).map((r) => ({
            siteId,
            scope: 'url',
            locale: '',
            fromPath: r.from,
            match: r.match,
            toPath: r.to,
            toLocale: '',
            source: 'import',
            importId,
            createdBy: opts.actor.userId,
          })),
        )
        .onConflictDoUpdate({
          target: [redirects.siteId, redirects.scope, redirects.locale, redirects.fromPath, redirects.match],
          set: { toPath: sqlExcluded('to_path'), source: 'import', importId, createdBy: opts.actor.userId },
        });
    }
    // The planned set was checked; the written one is checked again before commit.
    await assertSiteRulesTerminate(tx, siteId);
    if (write.length > 0) {
      await appendItemEvent(tx, {
        siteId,
        resource: 'redirect',
        collection: '$redirects',
        itemId: importId,
        itemVersion: null,
        changedFields: ['redirects'],
        operation: 'create',
        source: 'api',
        actor: opts.actor.userId ? { type: 'user', id: opts.actor.userId } : undefined,
        payload: { importId, rules: write.length },
      });
    }
    await new AuditLogger({ db, siteId }).writeInTransaction(tx, {
      siteId,
      event: 'redirects_imported',
      actorEmail: opts.actor.email ?? null,
      metadata: { operator: opts.actor.userId, importId, format: report.format, summary: report.summary, importConflicting: opts.importConflicting === true },
    });
    return { importId, report };
  }
}
