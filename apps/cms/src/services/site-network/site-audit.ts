import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNotNull, isNull, lt, notInArray, or, sql } from 'drizzle-orm';
import { auditIssueResolutions, auditIssueStates, auditIssues, auditSites, collections, users, items, linkEdges, publicAlternates, publicItems, publicSites, routeTombstones, siteSeoSettings, sites, type Database } from '@heopress/database';
import { effectiveSeoSettings, type SiteSeoSettings } from '@heopress/contracts/schemas';
import { anchorsOf, markdownCopyDifference, markdownUrlOf, plainFieldOf } from '@heopress/public-site';
import { absoluteUrl, decideIndexing, pageDescription, pageTitle, pageTypeOfCollection } from '@heopress/seo-geo';
import { runSiteTransaction } from '../rls-transaction';
import { linkReport } from './link-report';
import { resolvePublicPath } from './public-path';
import type { ReadableScope } from './readable-items';

/**
 * The site audit (HeoPress P07 tasks 5.1, 5.2; spec seo/site-audit): a list of problems to clear, not a score. Each rule
 * has a stable id and a severity; each issue names the pages concerned and its evidence. A run recomputes the whole list
 * (`lumibase_audit_issues`): a problem found again keeps its row (its fingerprint) and first sighting; one not found again
 * is removed — once everything is fixed the list is empty.
 *
 * The audit reads what the public sees (the public projection and the link graph), in the site's scope. Runs happen in
 * the worker (an administrator's request or the daily check), one site at a time, never in a request.
 */

const AUDIT_RULES = {
  'links/broken': { severity: 'error', title: 'Broken internal link', description: 'A link points to a page that was deleted, unpublished, or never existed.' },
  'links/broken-anchor': { severity: 'warning', title: 'Broken anchor', description: 'A link names a fragment (#…) the target page\'s content does not have (published rich text keeps no ids; only `#top` always answers).' },
  'meta/duplicate-title': { severity: 'warning', title: 'Duplicate title', description: 'Indexable pages of one language and host have the same title.' },
  'meta/duplicate-description': { severity: 'warning', title: 'Duplicate description', description: 'Indexable pages of one language and host have the same description.' },
  'meta/duplicate-canonical': { severity: 'warning', title: 'Duplicate canonical', description: 'Pages name the same canonical address, which is none of them.' },
  'hreflang/missing-return': { severity: 'error', title: 'Missing hreflang return link', description: 'A page lists a translation that does not list it back.' },
  'jsonld/invalid': { severity: 'warning', title: 'Invalid structured data', description: 'Structured data of a page was left out (invalid or not allowed).' },
  'jsonld/site-invalid': { severity: 'warning', title: 'Invalid site structured data', description: 'Structured data contributed for the whole site was left out.' },
  'markdown/inconsistent': { severity: 'notice', title: 'Markdown copy differs from the page', description: 'The Markdown copy cannot carry part of the page, or its text differs.' },
  'markdown/address-taken': { severity: 'warning', title: 'Markdown copy address taken', description: 'The address of the page\'s Markdown copy is another route, so the page has no copy.' },
} as const;

type AuditRuleId = keyof typeof AUDIT_RULES;
/** An issue as the rules report it (test hook of `runSiteAudit`). */
export type AuditFinding = Found;

/** Issues kept per run at most (a site past it is told its list is cut short). */
const MAX_ISSUES = 10_000;
/** Pages whose rich text is read at a time (bodies are large). */
const BODY_READ = 50;
/** Distinct pages whose anchors are read for fragment links at most. */
const MAX_ANCHOR_TARGETS = 2000;
/** How long a worker holds a site's run; an audit is due again after a day. */
const LEASE_MS = 10 * 60_000;
const AUDIT_PERIOD_MS = 24 * 60 * 60_000;

type Tx = Parameters<Parameters<typeof runSiteTransaction>[2]>[0];

interface PageRef {
  itemId: string;
  collection: string;
  title: string;
  url: string | null;
}

interface Found {
  rule: AuditRuleId;
  fingerprint: string;
  itemIds: string[];
  adminOnly?: boolean;
  evidence: Record<string, unknown>;
}

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 24);
const str = (v: unknown) => (typeof v === 'string' ? v : '');
/** Text as compared for duplicates (already as the head says it): whitespace collapsed, case folded. */
const norm = (v: string) => v.replace(/\s+/g, ' ').trim().toLowerCase();
const hostOf = (url: string | null) => {
  try {
    return url ? new URL(url).host.toLowerCase() : null;
  } catch {
    return null;
  }
};

interface Row {
  itemId: string;
  collection: string;
  locale: string;
  path: string;
  url: string | null;
  /** As the renderer reads them: strings only (`titleOf`: the title, else the name, else the slug). */
  title: string;
  seoTitle: string;
  /** The fields a description is made of, as stored (rich text where `richFields` says so). */
  described: Record<string, unknown>;
  canonical: string | null;
  seoRobots: string | null;
  richFields: string[];
  diagnostics: unknown;
}

async function settingsOf(tx: Tx, siteId: string): Promise<SiteSeoSettings> {
  const [row] = await tx.select({ settings: siteSeoSettings.settings }).from(siteSeoSettings).where(eq(siteSeoSettings.siteId, siteId));
  return effectiveSeoSettings(row?.settings);
}

/** The path of a page address (resolution records keep paths, not hosts). */
function pathOfUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

const refOf = (r: Row): PageRef => ({ itemId: r.itemId, collection: r.collection, title: r.title, url: r.url });

/** Groups of two or more by key: one issue each. */
function duplicates(rule: AuditRuleId, rows: Row[], keyOf: (r: Row) => string | null, value: (r: Row) => string): Found[] {
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const k = keyOf(r);
    if (k) groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const out: Found[] = [];
  for (const [k, group] of groups) {
    if (group.length < 2) continue;
    group.sort((a, b) => (a.itemId < b.itemId ? -1 : 1));
    out.push({ rule, fingerprint: `${rule}:${hash(k)}`, itemIds: group.map((g) => g.itemId), evidence: { value: value(group[0]!), pages: group.map(refOf) } });
  }
  return out;
}

/** Thrown when a run lost its lease to another worker: it stops and keeps nothing (Codex review of batch 10b, round 1). */
class AuditLeaseLost extends Error {}

/** Distinct addresses resolved per rule at most (redirects followed), and fragment links read at most. */
const MAX_RESOLVE = 500;
const MAX_ANCHOR_EDGES = 20_000;

/** Everything the rules find on a site now; `check` is called between steps (a lost lease stops the run). */
async function findIssues(db: Database, siteId: string, check: () => Promise<void>): Promise<{ found: Found[]; truncated: boolean }> {
  const { rows, settings, alternates, site } = await runSiteTransaction(db, siteId, async (tx) => {
    const settings = await settingsOf(tx, siteId);
    // The fields the rules compare only (never the bodies, read in batches below).
    const raw = (await tx.execute(sql`
      SELECT p.item_id AS "itemId", p.collection, p.locale, p.path, p.card ->> 'url' AS url,
             jsonb_build_object('title', p.data -> 'title', 'name', p.data -> 'name', 'slug', p.data -> 'slug', 'seo_title', p.data -> 'seo_title') AS titled,
             jsonb_build_object('seo_description', p.data -> 'seo_description', 'excerpt', p.data -> 'excerpt', 'description', p.data -> 'description') AS described,
             p.data ->> 'canonical_url' AS canonical, p.seo_robots AS "seoRobots",
             p.rich_fields AS "richFields", p.structured -> 'diagnostics' AS diagnostics
      FROM ${publicItems} p WHERE p.site_id = ${siteId}
      ORDER BY p.item_id`)) as unknown as Array<Omit<Row, 'title' | 'seoTitle'> & { titled: Record<string, unknown> }>;
    const alternates = await tx
      .select({ itemId: publicAlternates.itemId, locale: publicAlternates.locale, url: publicAlternates.url, target: publicAlternates.targetItemId })
      .from(publicAlternates)
      .where(eq(publicAlternates.siteId, siteId));
    const [site] = await tx.select({ name: publicSites.name, structured: publicSites.structured }).from(publicSites).where(eq(publicSites.siteId, siteId));
    // Strings only, as the renderer reads them: a number or a boolean projected there is no title (round 3).
    const rows: Row[] = raw.map(({ titled, ...r }) => ({ ...r, title: str(titled.title) || str(titled.name) || str(titled.slug), seoTitle: str(titled.seo_title) }));
    return { rows, settings, alternates, site };
  });
  const found: Found[] = [];
  let truncated = false;
  const byId = new Map(rows.map((r) => [r.itemId, r]));
  const siteName = site?.name ?? '';
  // Every public page (taxonomy pages included): its indexing decided as the renderer decides it.
  const indexable = rows.filter((r) => decideIndexing({ settings, pageType: pageTypeOfCollection(r.collection), collection: r.collection, itemRobots: r.seoRobots }).indexable);
  // Listable: indexable and canonical to itself (a declared duplicate is not a duplicate).
  const listable = indexable.filter((r) => {
    const own = absoluteUrl(r.url);
    const canonical = absoluteUrl(r.canonical);
    return own !== null && (!canonical || canonical === own);
  });

  // meta/duplicate-*: within one host and language, the title and description the head says (templates applied:
  // a template without `{title}` makes every page's title the same — Codex review of batch 10b, round 1).
  const scope = (r: Row) => `${hostOf(r.url) ?? ''}\u0000${r.locale}`;
  const titleOf = (r: Row) => pageTitle({ settings, siteName, pageType: pageTypeOfCollection(r.collection), title: r.title, seoTitle: r.seoTitle });
  // The renderer's own reading of the fields (`plainFieldOf`): the same text, the same fallbacks (round 2).
  const descriptionOf = (r: Row) => {
    const fields = { data: r.described, richFields: r.richFields };
    const text = plainFieldOf(fields, 'seo_description') || plainFieldOf(fields, 'excerpt') || plainFieldOf(fields, 'description');
    return pageDescription({ settings, siteName, title: r.title, description: text });
  };
  found.push(...duplicates('meta/duplicate-title', listable, (r) => {
    const t = norm(titleOf(r));
    return t ? `${scope(r)}\u0000${t}` : null;
  }, titleOf));
  found.push(...duplicates('meta/duplicate-description', listable, (r) => {
    const d = norm(descriptionOf(r));
    return d ? `${scope(r)}\u0000${d}` : null;
  }, descriptionOf));
  // meta/duplicate-canonical: two or more pages naming one canonical address that is none of them.
  const own = new Set(rows.map((r) => absoluteUrl(r.url)).filter((u): u is string => u !== null));
  found.push(...duplicates('meta/duplicate-canonical', indexable, (r) => {
    const c = absoluteUrl(r.canonical);
    return c && !own.has(c) ? c : null;
  }, (r) => absoluteUrl(r.canonical) ?? ''));

  // hreflang/missing-return: a page lists another page of this site that does not list it back.
  const listsOf = new Map<string, Set<string>>();
  for (const a of alternates) if (a.locale !== 'x-default') listsOf.set(a.itemId, (listsOf.get(a.itemId) ?? new Set()).add(a.target));
  for (const [itemId, targets] of listsOf) {
    for (const target of targets) {
      if (target === itemId || !byId.has(target) || !byId.has(itemId)) continue;
      if (listsOf.get(target)?.has(itemId)) continue;
      found.push({
        rule: 'hreflang/missing-return',
        fingerprint: `hreflang/missing-return:${itemId}:${target}`,
        itemIds: [itemId, target],
        evidence: { pages: [refOf(byId.get(itemId)!), refOf(byId.get(target)!)], locale: byId.get(target)!.locale },
      });
    }
  }

  // jsonld/*: what the projection left out of a page's or the site's structured data.
  for (const r of rows) {
    if (Array.isArray(r.diagnostics) && r.diagnostics.length) {
      found.push({ rule: 'jsonld/invalid', fingerprint: `jsonld/invalid:${r.itemId}:${hash(JSON.stringify(r.diagnostics))}`, itemIds: [r.itemId], evidence: { pages: [refOf(r)], diagnostics: r.diagnostics } });
    }
  }
  const siteDiagnostics = (site?.structured as { diagnostics?: unknown } | undefined)?.diagnostics;
  if (Array.isArray(siteDiagnostics) && siteDiagnostics.length) {
    found.push({ rule: 'jsonld/site-invalid', fingerprint: `jsonld/site-invalid:${hash(JSON.stringify(siteDiagnostics))}`, itemIds: [], adminOnly: true, evidence: { diagnostics: siteDiagnostics } });
  }
  await check();

  // links/broken: the link report's broken links (every source, registered links included).
  const report = await linkReport(db, siteId, { readable: () => sql`true`, navigation: true, limits: { rows: MAX_ISSUES } });
  if (report.truncated) truncated = true;
  for (const b of report.broken) {
    const src = b.source;
    if (src.kind === 'item') {
      found.push({
        rule: 'links/broken',
        fingerprint: `links/broken:${src.itemId}:${b.field ?? ''}:${b.position}:${hash(b.targetUrl)}`,
        itemIds: [src.itemId],
        evidence: { pages: [{ itemId: src.itemId, collection: src.collection, title: src.title, url: src.url }], field: b.field, position: b.position, href: b.href, anchorText: b.anchorText, target: b.targetUrl, reason: b.reason },
      });
    } else {
      found.push({
        rule: 'links/broken',
        fingerprint: `links/broken:navigation:${src.linkId}`,
        itemIds: [],
        adminOnly: true,
        evidence: { navigation: { linkId: src.linkId, label: src.label }, href: b.href, target: b.targetUrl, reason: b.reason },
      });
    }
  }
  await check();

  // links/broken-anchor: a fragment the target page does not have among its anchors — the target found at the address,
  // or where its redirects lead (Codex review of batch 10b, round 1). At most `MAX_ANCHOR_EDGES` links read.
  const anchored = (await runSiteTransaction(db, siteId, (tx) =>
    tx.execute(sql`
      SELECT e.source_item_id AS "sourceItemId", e.field, e.position, e.href, e.fragment, e.target_url AS "targetUrl", t.item_id AS "targetItemId"
      FROM ${linkEdges} e
      JOIN ${publicItems} s ON s.site_id = e.site_id AND s.item_id = e.source_item_id
      LEFT JOIN ${publicItems} t ON t.site_id = e.site_id AND t.locale = e.target_locale AND t.path = e.target_path
      WHERE e.site_id = ${siteId} AND e.origin = 'auto' AND e.fragment IS NOT NULL AND lower(e.fragment) <> 'top'
      ORDER BY e.target_url, e.source_item_id, e.field, e.position
      LIMIT ${MAX_ANCHOR_EDGES + 1}`),
  )) as unknown as Array<{ sourceItemId: string; field: string; position: number; href: string; fragment: string; targetUrl: string; targetItemId: string | null }>;
  if (anchored.length > MAX_ANCHOR_EDGES) truncated = true;
  const viaRedirect = new Map<string, string | null>();
  for (const a of anchored.slice(0, MAX_ANCHOR_EDGES)) {
    if (a.targetItemId || viaRedirect.has(a.targetUrl)) continue;
    if (viaRedirect.size >= MAX_RESOLVE) {
      truncated = true;
      break;
    }
    const u = new URL(a.targetUrl);
    let result = await resolvePublicPath(db, { host: u.host, path: u.pathname });
    if (result.kind === 'redirect') {
      const end = new URL(result.location);
      result = await resolvePublicPath(db, { host: end.host, path: end.pathname });
    }
    viaRedirect.set(a.targetUrl, result.kind === 'item' ? result.itemId : null);
  }
  const targetOf = (a: (typeof anchored)[number]) => a.targetItemId ?? viaRedirect.get(a.targetUrl) ?? null;
  const targetIds = [...new Set(anchored.slice(0, MAX_ANCHOR_EDGES).map(targetOf).filter((t): t is string => t !== null))];
  if (targetIds.length > MAX_ANCHOR_TARGETS) truncated = true;
  const anchors = new Map<string, Set<string>>();
  for (let i = 0; i < Math.min(targetIds.length, MAX_ANCHOR_TARGETS); i += BODY_READ) {
    const chunk = targetIds.slice(i, Math.min(i + BODY_READ, MAX_ANCHOR_TARGETS));
    const whole = await runSiteTransaction(db, siteId, (tx) =>
      tx.select({ itemId: publicItems.itemId, data: publicItems.data, richFields: publicItems.richFields }).from(publicItems).where(and(eq(publicItems.siteId, siteId), inArray(publicItems.itemId, chunk))),
    );
    for (const w of whole) {
      const set = new Set<string>();
      for (const f of w.richFields) for (const a of anchorsOf(str(w.data[f]))) set.add(a);
      anchors.set(w.itemId, set);
    }
    await check();
  }
  for (const a of anchored.slice(0, MAX_ANCHOR_EDGES)) {
    const target = targetOf(a);
    const set = target ? anchors.get(target) : undefined;
    // `#top` always answers (HTML: the top of the page), whatever the page holds (left out by the query).
    if (!target || !set || set.has(a.fragment)) continue;
    const source = byId.get(a.sourceItemId);
    if (!source) continue;
    found.push({
      rule: 'links/broken-anchor',
      fingerprint: `links/broken-anchor:${a.sourceItemId}:${a.field}:${a.position}:${hash(`${target}#${a.fragment}`)}`,
      itemIds: [a.sourceItemId, target],
      evidence: { pages: [refOf(source), refOf(byId.get(target) ?? source)], field: a.field, position: a.position, href: a.href, fragment: a.fragment },
    });
  }

  // markdown/*: the pages that have a copy (copies on, listable item pages).
  if (settings.discovery.markdownCopies) {
    const withCopy = listable.filter((r) => pageTypeOfCollection(r.collection) === 'item' && markdownUrlOf(r.url ?? '') !== null);
    for (let i = 0; i < withCopy.length; i += BODY_READ) {
      const chunk = withCopy.slice(i, i + BODY_READ).filter((r) => r.richFields.includes('body'));
      if (chunk.length === 0) continue;
      const bodies = await runSiteTransaction(db, siteId, (tx) =>
        tx.select({ itemId: publicItems.itemId, body: sql<string | null>`${publicItems.data} ->> 'body'` }).from(publicItems).where(and(eq(publicItems.siteId, siteId), inArray(publicItems.itemId, chunk.map((c) => c.itemId)))),
      );
      for (const b of bodies) {
        const r = byId.get(b.itemId)!;
        const diff = b.body ? markdownCopyDifference(b.body, r.url!) : null;
        if (diff) found.push({ rule: 'markdown/inconsistent', fingerprint: `markdown/inconsistent:${r.itemId}`, itemIds: [r.itemId], evidence: { pages: [refOf(r)], copy: markdownUrlOf(r.url!), ...diff } });
      }
      await check();
    }
    // A copy's address the site answers otherwise — a page, a redirect (exact or by prefix), a deleted page's 410 — as the
    // renderer decides it: every copy resolved (Codex review of batch 10b, round 1: no guess from the paths' text).
    if (withCopy.length > MAX_ANCHOR_TARGETS) truncated = true;
    const gone: Array<{ r: Row; copy: string; locale: string; path: string }> = [];
    for (const [n, r] of withCopy.slice(0, MAX_ANCHOR_TARGETS).entries()) {
      const copy = new URL(markdownUrlOf(r.url!)!);
      const at = await resolvePublicPath(db, { host: copy.host, path: copy.pathname });
      if (at.kind !== 'not_found') {
        found.push({ rule: 'markdown/address-taken', fingerprint: `markdown/address-taken:${r.itemId}`, itemIds: [r.itemId], evidence: { pages: [refOf(r)], copy: copy.toString(), answeredBy: at.kind } });
      } else if (at.at) {
        gone.push({ r, copy: copy.toString(), locale: at.at.locale, path: at.at.contentPath });
      }
      if (n % BODY_READ === BODY_READ - 1) await check();
    }
    // The CMS's resolver has no 410s: a deleted page's tombstone at the copy's address takes it too.
    if (gone.length) {
      const tombs = await runSiteTransaction(db, siteId, (tx) =>
        tx.select({ locale: routeTombstones.locale, path: routeTombstones.path }).from(routeTombstones).where(and(eq(routeTombstones.siteId, siteId), inArray(routeTombstones.path, [...new Set(gone.map((g) => g.path))]))),
      );
      const at = new Set(tombs.map((t) => `${t.locale}\u0000${t.path}`));
      for (const g of gone) {
        if (at.has(`${g.locale}\u0000${g.path}`)) {
          found.push({ rule: 'markdown/address-taken', fingerprint: `markdown/address-taken:${g.r.itemId}`, itemIds: [g.r.itemId], evidence: { pages: [refOf(g.r)], copy: g.copy, answeredBy: 'gone' } });
        }
      }
    }
  }

  if (found.length > MAX_ISSUES) truncated = true;
  return { found: found.slice(0, MAX_ISSUES), truncated };
}

/**
 * Run a site's audit now and store what it found (replacing what it no longer finds). With `token` (the worker's run), the
 * lease is renewed between steps and the results are kept only while the run still holds it, in the transaction that
 * writes them; a run that lost it stops and keeps nothing (returns null). One write of a site at a time.
 */
export async function runSiteAudit(
  db: Database,
  siteId: string,
  opts: {
    token?: string;
    requestedAt?: Date | null;
    /** Test hook: after the rules, before the writing transaction. */
    beforeWrite?: () => Promise<void>;
    /** Test hook (HeoPress P07a): what the rules found, instead of running them. */
    findings?: { found: AuditFinding[]; truncated: boolean };
  } = {},
): Promise<{ issues: number; truncated: boolean } | null> {
  const holds = async (tx: Database | Tx) => {
    if (!opts.token) return true;
    const renewed = await tx
      .update(auditSites)
      .set({ leasedUntil: sql`now() + ${`${LEASE_MS} milliseconds`}::interval` })
      .where(and(eq(auditSites.siteId, siteId), eq(auditSites.leaseToken, opts.token)))
      .returning({ siteId: auditSites.siteId });
    return renewed.length > 0;
  };
  let found: Found[];
  let truncated: boolean;
  try {
    ({ found, truncated } =
      opts.findings ??
      (await findIssues(db, siteId, async () => {
        if (!(await holds(db))) throw new AuditLeaseLost();
      })));
  } catch (err) {
    if (err instanceof AuditLeaseLost) return null;
    throw err;
  }
  await opts.beforeWrite?.();
  return runSiteTransaction(db, siteId, async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`site-audit:${siteId}`}, 0))`);
    if (opts.token) {
      const [held] = await tx.select({ siteId: auditSites.siteId }).from(auditSites).where(and(eq(auditSites.siteId, siteId), eq(auditSites.leaseToken, opts.token))).for('update');
      if (!held) return null;
    }
    // A run cut short did not look at everything: it removes nothing, resolves nothing and keeps every decision
    // (HeoPress P07a task 10.2). A complete run records each issue it no longer finds as resolved — every page it named —
    // drops its ignore state, and removes it, in this transaction.
    if (!truncated) {
      const seen = new Set(found.map((f) => f.fingerprint));
      const existing = await tx.select().from(auditIssues).where(eq(auditIssues.siteId, siteId));
      const gone = existing.filter((e) => !seen.has(e.fingerprint));
      for (let i = 0; i < gone.length; i += 500) {
        const chunk = gone.slice(i, i + 500);
        await tx.insert(auditIssueResolutions).values(
          chunk.map((g) => ({
            siteId,
            fingerprint: g.fingerprint,
            rule: g.rule,
            severity: g.severity,
            title: AUDIT_RULES[g.rule as AuditRuleId]?.title ?? g.rule,
            itemIds: g.itemIds,
            pages: ((g.evidence.pages as PageRef[] | undefined) ?? []).map((p) => ({ itemId: p.itemId, path: pathOfUrl(p.url), title: p.title })),
            adminOnly: g.adminOnly,
            firstSeenAt: g.firstSeenAt,
          })),
        );
        const prints = chunk.map((g) => g.fingerprint);
        await tx.delete(auditIssueStates).where(and(eq(auditIssueStates.siteId, siteId), inArray(auditIssueStates.fingerprint, prints)));
        await tx.delete(auditIssues).where(and(eq(auditIssues.siteId, siteId), inArray(auditIssues.fingerprint, prints)));
      }
    }
    for (let i = 0; i < found.length; i += 500) {
      await tx
        .insert(auditIssues)
        .values(
          found.slice(i, i + 500).map((f) => ({
            siteId,
            rule: f.rule,
            severity: AUDIT_RULES[f.rule].severity,
            fingerprint: f.fingerprint,
            itemIds: f.itemIds,
            adminOnly: f.adminOnly ?? false,
            evidence: f.evidence,
          })),
        )
        .onConflictDoUpdate({
          target: [auditIssues.siteId, auditIssues.fingerprint],
          set: { evidence: sql`excluded.evidence`, itemIds: sql`excluded.item_ids`, severity: sql`excluded.severity`, adminOnly: sql`excluded.admin_only`, lastSeenAt: sql`now()` },
        });
    }
    const done = { lastRunAt: sql`now()`, status: 'done', issues: found.length, truncated, lastError: null };
    if (opts.token) {
      // The lease given back; a request made while it ran stays (it runs again), the one it answered is cleared.
      await tx
        .update(auditSites)
        .set({
          ...done,
          leaseToken: null,
          leasedUntil: null,
          requestedAt: opts.requestedAt
            ? sql`CASE WHEN ${auditSites.requestedAt} > ${opts.requestedAt.toISOString()}::timestamptz THEN ${auditSites.requestedAt} ELSE NULL END`
            : sql`${auditSites.requestedAt}`,
        })
        .where(and(eq(auditSites.siteId, siteId), eq(auditSites.leaseToken, opts.token)));
    } else {
      await tx.insert(auditSites).values({ siteId, lastRunAt: new Date(), status: 'done', issues: found.length, truncated }).onConflictDoUpdate({ target: auditSites.siteId, set: done });
    }
    return { issues: found.length, truncated };
  });
}

/** Ask for a site's audit (an administrator, or the daily check): the worker runs it soon. */
export async function requestSiteAudit(db: Database, siteId: string): Promise<void> {
  await db
    .insert(auditSites)
    .values({ siteId, requestedAt: new Date() })
    .onConflictDoUpdate({ target: auditSites.siteId, set: { requestedAt: sql`now()` } });
}

/** Ask for an audit of every site never audited or not for a day. */
export async function scheduleSiteAudits(db: Database): Promise<number> {
  const due = await db
    .select({ id: sites.id })
    .from(sites)
    .leftJoin(auditSites, eq(auditSites.siteId, sites.id))
    .where(and(or(isNull(auditSites.siteId), isNull(auditSites.lastRunAt), lt(auditSites.lastRunAt, new Date(Date.now() - AUDIT_PERIOD_MS))), or(isNull(auditSites.requestedAt), isNull(auditSites.siteId))))
    .orderBy(asc(sites.id));
  for (const { id } of due) await requestSiteAudit(db, id);
  return due.length;
}

type AuditRunResult = { siteId: string; status: 'done' | 'lost' | 'failed'; error?: string };

/** The worker: requested audits, the longest waiting first, one site at a time within the budget, each under a lease. */
export async function processSiteAudits(db: Database, opts: { budgetMs?: number } = {}): Promise<AuditRunResult[]> {
  const deadline = Date.now() + (opts.budgetMs ?? 50_000);
  const out: AuditRunResult[] = [];
  while (Date.now() <= deadline) {
    const token = randomUUID();
    const taken = await db.transaction(async (tx) => {
      const [row] = await tx
        .select({ siteId: auditSites.siteId, requestedAt: auditSites.requestedAt })
        .from(auditSites)
        .where(
          and(
            isNotNull(auditSites.requestedAt),
            or(isNull(auditSites.leasedUntil), lt(auditSites.leasedUntil, sql`now()`)),
            out.length ? notInArray(auditSites.siteId, out.map((o) => o.siteId)) : undefined,
          ),
        )
        .orderBy(asc(auditSites.requestedAt))
        .limit(1)
        .for('update', { skipLocked: true });
      if (!row) return null;
      await tx.update(auditSites).set({ leaseToken: token, leasedUntil: sql`now() + ${`${LEASE_MS} milliseconds`}::interval`, status: 'running' }).where(eq(auditSites.siteId, row.siteId));
      return row;
    });
    if (!taken) break;
    try {
      const result = await runSiteAudit(db, taken.siteId, { token, requestedAt: taken.requestedAt });
      out.push({ siteId: taken.siteId, status: result ? 'done' : 'lost' });
    } catch (err) {
      const message = err instanceof Error ? err.message.slice(0, 500) : 'audit failed';
      // Its own lease only: tried again once the lease runs out; the issues as they were.
      await db.update(auditSites).set({ status: 'failed', lastError: message }).where(and(eq(auditSites.siteId, taken.siteId), eq(auditSites.leaseToken, token)));
      out.push({ siteId: taken.siteId, status: 'failed', error: message });
    }
  }
  return out;
}

interface AuditIssueView {
  id: string;
  rule: AuditRuleId;
  severity: string;
  title: string;
  evidence: Record<string, unknown>;
  pages: PageRef[];
  firstSeenAt: string;
  lastSeenAt: string;
  /** Open, or ignored by an administrator until a time (HeoPress P07a task 10.2). */
  state: { status: 'open' } | { status: 'ignored'; reason: string | null; until: string; by: string | null; at: string };
}

/**
 * Open issues by severity as the caller may see them (HeoPress P07a, spec studio/network-summary "计数口径"): the same
 * visibility as {@link auditViewOf} — an issue counts when the caller may read one of its pages, or it is an
 * administrators-only issue and the caller is one. With the last run's time and status.
 */
export async function auditIssueCounts(
  db: Database,
  siteId: string,
  opts: { readable: ReadableScope; admin: boolean },
): Promise<{ bySeverity: Record<string, number>; lastRunAt: string | null; lastRunStatus: string | null }> {
  return runSiteTransaction(db, siteId, async (tx) => {
    const visible = sql`(
      (${auditIssues.adminOnly} AND ${opts.admin})
      OR (NOT ${auditIssues.adminOnly} AND EXISTS (
        SELECT 1 FROM unnest(${auditIssues.itemIds}) AS x(id)
        JOIN ${items} i ON i.id = x.id AND i.site_id = ${siteId}
        JOIN ${collections} c ON c.id = i.collection_id
        WHERE ${opts.readable(sql`i.id`, sql`c.name`)})))`;
    const rows = await tx
      .select({ severity: auditIssues.severity, n: sql<number>`count(*)`.mapWith(Number) })
      .from(auditIssues)
      .where(
        and(
          eq(auditIssues.siteId, siteId),
          visible,
          // Ignored issues are not open ones (HeoPress P07a task 10.2).
          sql`NOT EXISTS (SELECT 1 FROM ${auditIssueStates} st WHERE st.site_id = ${siteId} AND st.fingerprint = ${auditIssues.fingerprint} AND st.status = 'ignored' AND st.until > now())`,
        ),
      )
      .groupBy(auditIssues.severity);
    const [run] = await tx.select({ lastRunAt: auditSites.lastRunAt, status: auditSites.status }).from(auditSites).where(eq(auditSites.siteId, siteId));
    return {
      bySeverity: Object.fromEntries(rows.map((r) => [r.severity, r.n])),
      lastRunAt: run?.lastRunAt?.toISOString() ?? null,
      lastRunStatus: run?.lastRunAt ? (run.status ?? null) : null,
    };
  });
}

export interface AuditView {
  run: { lastRunAt: string | null; status: string | null; requested: boolean; truncated: boolean; error: string | null };
  rules: Array<{ id: AuditRuleId; severity: string; title: string; description: string }>;
  issues: AuditIssueView[];
  total: number;
}

/**
 * The site's issues as a caller may see them (task 5.2): an issue is shown when the caller may read one of its pages
 * (or, for an issue about what only administrators see, is one); the pages it lists are only those it may read. At most
 * `limit` issues (errors first); `total` counts all shown.
 */
export async function auditViewOf(
  db: Database,
  siteId: string,
  opts: { readable: ReadableScope; admin: boolean; rule?: string; limit?: number; status?: 'open' | 'ignored' },
): Promise<AuditView> {
  const limit = Math.min(opts.limit ?? 1000, MAX_ISSUES);
  return runSiteTransaction(db, siteId, async (tx) => {
    // An ignore holds until its time (HeoPress P07a task 10.2); past it the issue is open again.
    const ignored = sql`EXISTS (SELECT 1 FROM ${auditIssueStates} st WHERE st.site_id = ${siteId} AND st.fingerprint = ${auditIssues.fingerprint} AND st.status = 'ignored' AND st.until > now())`;
    const byStatus = opts.status === 'ignored' ? ignored : opts.status === 'open' ? sql`NOT ${ignored}` : undefined;
    const visible = sql`(
      (${auditIssues.adminOnly} AND ${opts.admin})
      OR (NOT ${auditIssues.adminOnly} AND EXISTS (
        SELECT 1 FROM unnest(${auditIssues.itemIds}) AS x(id)
        JOIN ${items} i ON i.id = x.id AND i.site_id = ${siteId}
        JOIN ${collections} c ON c.id = i.collection_id
        WHERE ${opts.readable(sql`i.id`, sql`c.name`)})))`;
    const where = and(eq(auditIssues.siteId, siteId), opts.rule ? eq(auditIssues.rule, opts.rule) : undefined, visible, byStatus);
    const rows = await tx
      .select()
      .from(auditIssues)
      .where(where)
      .orderBy(sql`CASE ${auditIssues.severity} WHEN 'error' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END`, asc(auditIssues.rule), asc(auditIssues.fingerprint))
      .limit(limit);
    const [count] = await tx.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(auditIssues).where(where);
    // The pages each may list: those the caller may read.
    const ids = [...new Set(rows.flatMap((r) => r.itemIds))];
    const readable = new Set<string>();
    for (let i = 0; i < ids.length; i += 1000) {
      const chunk = ids.slice(i, i + 1000);
      const found = (await tx.execute(sql`
        SELECT i.id FROM ${items} i JOIN ${collections} c ON c.id = i.collection_id
        WHERE i.site_id = ${siteId} AND i.id IN (${sql.join(chunk.map((c) => sql`${c}`), sql`, `)}) AND ${opts.readable(sql`i.id`, sql`c.name`)}`)) as unknown as Array<{ id: string }>;
      for (const f of found) readable.add(f.id);
    }
    const [run] = await tx.select().from(auditSites).where(eq(auditSites.siteId, siteId));
    const states = rows.length
      ? await tx
          .select({ fingerprint: auditIssueStates.fingerprint, reason: auditIssueStates.reason, until: auditIssueStates.until, decidedAt: auditIssueStates.decidedAt, decidedBy: sql<string | null>`coalesce((SELECT u.email FROM ${users} u WHERE u.id = ${auditIssueStates.decidedBy}), ${auditIssueStates.decidedBy})` })
          .from(auditIssueStates)
          .where(and(eq(auditIssueStates.siteId, siteId), inArray(auditIssueStates.fingerprint, rows.map((r) => r.fingerprint)), sql`${auditIssueStates.until} > now()`))
      : [];
    const stateOf = new Map(states.map((st) => [st.fingerprint, st]));
    return {
      run: {
        lastRunAt: run?.lastRunAt?.toISOString() ?? null,
        status: run?.status ?? null,
        requested: !!run?.requestedAt,
        truncated: run?.truncated ?? false,
        error: run?.lastError ?? null,
      },
      rules: Object.entries(AUDIT_RULES).map(([id, r]) => ({ id: id as AuditRuleId, ...r })),
      issues: rows.map((r) => {
        const pages = ((r.evidence.pages as PageRef[] | undefined) ?? []).filter((p) => readable.has(p.itemId));
        const { pages: _all, ...evidence } = r.evidence;
        void _all;
        return {
          id: r.id,
          rule: r.rule as AuditRuleId,
          severity: r.severity,
          title: AUDIT_RULES[r.rule as AuditRuleId]?.title ?? r.rule,
          evidence,
          pages,
          firstSeenAt: r.firstSeenAt.toISOString(),
          lastSeenAt: r.lastSeenAt.toISOString(),
          state: stateOf.has(r.fingerprint)
            ? {
                status: 'ignored' as const,
                reason: stateOf.get(r.fingerprint)!.reason,
                until: stateOf.get(r.fingerprint)!.until.toISOString(),
                by: stateOf.get(r.fingerprint)!.decidedBy,
                at: stateOf.get(r.fingerprint)!.decidedAt.toISOString(),
              }
            : { status: 'open' as const },
        };
      }),
      total: count?.n ?? 0,
    };
  });
}


export class AuditTriageError extends Error {
  constructor(public code: 'NOT_FOUND' | 'VALIDATION', message: string, public status: 404 | 400) {
    super(message);
  }
}

const IGNORE_DEFAULT_DAYS = 90;
export const IGNORE_MAX_DAYS = 365;

/**
 * Ignore an issue (by its row id) for `days` (default 90, at most 365), with an optional reason (HeoPress P07a task 10.2).
 * The decision is kept by fingerprint, so later runs that find the issue again keep it. Returns the issue's fingerprint.
 */
export async function ignoreAuditIssue(
  db: Database,
  siteId: string,
  issueId: string,
  input: { reason?: string | null; days?: number; actor: string | null },
): Promise<{ fingerprint: string; until: string }> {
  const days = input.days ?? IGNORE_DEFAULT_DAYS;
  if (!Number.isInteger(days) || days < 1 || days > IGNORE_MAX_DAYS) throw new AuditTriageError('VALIDATION', `days must be 1–${IGNORE_MAX_DAYS}.`, 400);
  return runSiteTransaction(db, siteId, async (tx) => {
    const [issue] = await tx.select({ fingerprint: auditIssues.fingerprint }).from(auditIssues).where(and(eq(auditIssues.siteId, siteId), eq(auditIssues.id, issueId)));
    if (!issue) throw new AuditTriageError('NOT_FOUND', 'Issue not found.', 404);
    const until = new Date(Date.now() + days * 86_400_000);
    const values = { siteId, fingerprint: issue.fingerprint, status: 'ignored', reason: input.reason?.trim() || null, decidedBy: input.actor, decidedAt: new Date(), until };
    await tx.insert(auditIssueStates).values(values).onConflictDoUpdate({ target: [auditIssueStates.siteId, auditIssueStates.fingerprint], set: values });
    return { fingerprint: issue.fingerprint, until: until.toISOString() };
  });
}

/** Put an ignored issue back among the open ones. Returns its fingerprint. */
export async function restoreAuditIssue(db: Database, siteId: string, issueId: string): Promise<{ fingerprint: string }> {
  return runSiteTransaction(db, siteId, async (tx) => {
    const [issue] = await tx.select({ fingerprint: auditIssues.fingerprint }).from(auditIssues).where(and(eq(auditIssues.siteId, siteId), eq(auditIssues.id, issueId)));
    if (!issue) throw new AuditTriageError('NOT_FOUND', 'Issue not found.', 404);
    await tx.delete(auditIssueStates).where(and(eq(auditIssueStates.siteId, siteId), eq(auditIssueStates.fingerprint, issue.fingerprint)));
    return { fingerprint: issue.fingerprint };
  });
}

export interface ResolvedIssueView {
  id: string;
  rule: string;
  severity: string;
  title: string;
  /** Only the pages the caller may read. */
  pages: Array<{ itemId: string; path: string | null; title: string }>;
  firstSeenAt: string;
  resolvedAt: string;
}

/**
 * Resolved issues as the caller may see them (HeoPress P07a task 10.2): one is shown when the caller may read one of its
 * pages (any of them — the 21st as well as the first), or it was an administrators-only issue and the caller is one;
 * it lists only the pages the caller may read. Newest first, at most `limit`; `total` counts all shown.
 */
export async function resolvedAuditView(
  db: Database,
  siteId: string,
  opts: { readable: ReadableScope; admin: boolean; limit?: number },
): Promise<{ issues: ResolvedIssueView[]; total: number }> {
  const limit = Math.min(opts.limit ?? 200, 1000);
  return runSiteTransaction(db, siteId, async (tx) => {
    const visible = sql`(
      (${auditIssueResolutions.adminOnly} AND ${opts.admin})
      OR (NOT ${auditIssueResolutions.adminOnly} AND EXISTS (
        SELECT 1 FROM unnest(${auditIssueResolutions.itemIds}) AS x(id)
        JOIN ${items} i ON i.id = x.id AND i.site_id = ${siteId}
        JOIN ${collections} c ON c.id = i.collection_id
        WHERE ${opts.readable(sql`i.id`, sql`c.name`)})))`;
    const where = and(eq(auditIssueResolutions.siteId, siteId), visible);
    const rows = await tx.select().from(auditIssueResolutions).where(where).orderBy(sql`${auditIssueResolutions.resolvedAt} DESC`).limit(limit);
    const [count] = await tx.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(auditIssueResolutions).where(where);
    const ids = [...new Set(rows.flatMap((r) => r.itemIds))];
    const readable = new Set<string>();
    for (let i = 0; i < ids.length; i += 1000) {
      const chunk = ids.slice(i, i + 1000);
      const found = (await tx.execute(sql`
        SELECT i.id FROM ${items} i JOIN ${collections} c ON c.id = i.collection_id
        WHERE i.site_id = ${siteId} AND i.id IN (${sql.join(chunk.map((c) => sql`${c}`), sql`, `)}) AND ${opts.readable(sql`i.id`, sql`c.name`)}`)) as unknown as Array<{ id: string }>;
      for (const f of found) readable.add(f.id);
    }
    return {
      issues: rows.map((r) => ({
        id: r.id,
        rule: r.rule,
        severity: r.severity,
        title: r.title,
        pages: r.pages.filter((p) => readable.has(p.itemId)),
        firstSeenAt: r.firstSeenAt.toISOString(),
        resolvedAt: r.resolvedAt.toISOString(),
      })),
      total: count?.n ?? 0,
    };
  });
}

/** Keep resolved issues 90 days (HeoPress P07a task 10.3; ADR-0013), and drop ignores past their time; every site in its scope. */
const RESOLUTION_RETENTION_DAYS = 90;

export async function purgeAuditTriage(db: Database, now = new Date()): Promise<{ resolutions: number; states: number }> {
  const siteIds = (await db.select({ id: sites.id }).from(sites)).map((r) => r.id);
  let resolutions = 0;
  let states = 0;
  const cutoff = new Date(now.getTime() - RESOLUTION_RETENTION_DAYS * 86_400_000);
  for (const siteId of siteIds) {
    await runSiteTransaction(db, siteId, async (tx) => {
      resolutions += (await tx.delete(auditIssueResolutions).where(and(eq(auditIssueResolutions.siteId, siteId), lt(auditIssueResolutions.resolvedAt, cutoff))).returning({ id: auditIssueResolutions.id })).length;
      states += (await tx.delete(auditIssueStates).where(and(eq(auditIssueStates.siteId, siteId), lt(auditIssueStates.until, now))).returning({ f: auditIssueStates.fingerprint })).length;
    });
  }
  return { resolutions, states };
}
