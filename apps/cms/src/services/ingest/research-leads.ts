import { and, asc, desc, eq } from 'drizzle-orm';
import type { ResearchLeadResource } from '@heopress/contracts/schemas';
import { ingestDiscoveredUrls, ingestResearchLeads, ingestSourceLicences, ingestSources, type Database } from '@heopress/database';
import { runSiteTransaction, type SiteTransaction } from '../rls-transaction';
import type { FetchJobPayload } from './discovery-runner';
import { siteSettingsOf } from './site-settings';
import { DEFAULT_TRACKING_PARAMS, normalizeUrl } from './url-normalize';

/**
 * Research leads (HeoPress P08 task 1.7; spec ingest/sources "研究线索"; design "信源使用方式与授权失效").
 *
 * A document of a source whose usage in effect is `discovery_only` is only a lead: its outbound links that match the
 * site's primary-source allow-list (`ingest_site_settings.primary_source_patterns`: official announcements, docs,
 * release notes) become research leads, recorded with their chain (origin source → origin document → link) in the
 * document's own registration transaction. The origin document's body is never processed: its outbox job is a `lead`
 * job (title and link only), not `process`.
 *
 * The target of a lead is fetched as an **independent** source document under its own source's rules: an existing
 * source of the site on the target's host (the operator's own terms for it), or a source managed for that host
 * (`managed_by = 'research_leads'`) created with the default terms — licence `unknown`, `discovery_only`, low trust —
 * which only an administrator's licence revision can change. The origin's licence, usage, trust or attribution are
 * never copied. `dispatchResearchLeads` turns pending leads into ordinary fetch jobs (the discovered-URL pipeline:
 * SSRF boundary, robots.txt, per-host limits, deduplication by the site's normalised URL).
 */

/**
 * The allow-list pattern `url` matches, or null. A pattern is `host` or `*.host` with an optional path prefix and an
 * optional trailing `*`; `host` matches that host only, `*.host` the host and its subdomains.
 */
function matchPrimarySource(url: string, patterns: readonly string[]): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  for (const raw of patterns) {
    const pattern = raw.trim().toLowerCase();
    if (!pattern) continue;
    const slash = pattern.indexOf('/');
    const hostPart = slash === -1 ? pattern : pattern.slice(0, slash);
    const pathPart = (slash === -1 ? '' : pattern.slice(slash)).replace(/\*$/, '');
    const hostOk = hostPart.startsWith('*.') ? host === hostPart.slice(2) || host.endsWith(hostPart.slice(1)) : host === hostPart.replace(/\*$/, '');
    if (!hostOk) continue;
    if (pathPart && !u.pathname.toLowerCase().startsWith(pathPart)) continue;
    return raw;
  }
  return null;
}

/** The absolute http(s) links of sanitised article HTML (hrefs are made absolute by extraction). */
function outboundLinks(bodyHtml: string): string[] {
  const out = new Set<string>();
  for (const m of bodyHtml.matchAll(/<a\b[^>]*\bhref="([^"]+)"/gi)) {
    const href = m[1]!.replace(/&amp;/g, '&');
    if (/^https?:\/\//i.test(href)) out.add(href);
  }
  return [...out];
}

/** Record the leads of a discovery-only document, inside its registration transaction. Returns how many. */
export async function recordResearchLeads(
  tx: SiteTransaction,
  input: { siteId: string; sourceId: string; documentId: string; bodyHtml: string; trackingParams?: readonly string[]; now: Date },
): Promise<number> {
  const { primarySourcePatterns } = await siteSettingsOf(tx, input.siteId);
  if (!primarySourcePatterns.length) return 0;
  let n = 0;
  for (const link of outboundLinks(input.bodyHtml)) {
    const pattern = matchPrimarySource(link, primarySourcePatterns);
    if (!pattern) continue;
    const normalized = normalizeUrl(link, input.trackingParams ?? DEFAULT_TRACKING_PARAMS);
    if (!normalized) continue;
    const rows = await tx
      .insert(ingestResearchLeads)
      .values({
        siteId: input.siteId,
        originSourceId: input.sourceId,
        originDocumentId: input.documentId,
        url: link.slice(0, 2000),
        normalizedUrl: normalized,
        matchedPattern: pattern,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .onConflictDoNothing()
      .returning({ id: ingestResearchLeads.id });
    n += rows.length;
  }
  return n;
}

const MANAGED = 'research_leads';

/** The source a lead's target is fetched under: one of the site's own on that host, or the managed one for the host. */
async function leadSourceFor(tx: SiteTransaction, siteId: string, targetUrl: string, originSourceId: string, now: Date): Promise<string> {
  const host = new URL(targetUrl).hostname.toLowerCase();
  const all = await tx
    .select({ id: ingestSources.id, url: ingestSources.url, managedBy: ingestSources.managedBy })
    .from(ingestSources)
    .where(eq(ingestSources.siteId, siteId))
    .orderBy(asc(ingestSources.createdAt));
  const onHost = all.filter((s) => s.id !== originSourceId && safeHost(s.url) === host);
  const own = onHost.find((s) => s.managedBy === null) ?? onHost.find((s) => s.managedBy === MANAGED);
  if (own) return own.id;
  const [created] = await tx
    .insert(ingestSources)
    .values({
      siteId,
      name: `Primary source: ${host}`,
      type: 'url',
      url: `https://${host}/`,
      scheduleTimes: ['00:00'],
      timezone: 'UTC',
      // Never scheduled: its documents come from leads. The terms are the defaults (no licence, discovery only).
      status: 'paused',
      pausedReason: 'manual',
      managedBy: MANAGED,
      createdBy: 'system:research_leads',
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning();
  if (!created) {
    // Another dispatcher created it (unique name): use that one.
    const [row] = await tx.select({ id: ingestSources.id }).from(ingestSources).where(and(eq(ingestSources.siteId, siteId), eq(ingestSources.name, `Primary source: ${host}`)));
    return row!.id;
  }
  const [rev] = await tx
    .insert(ingestSourceLicences)
    .values({
      siteId,
      sourceId: created.id,
      licenceStatus: created.licenceStatus,
      usageMode: created.usageMode,
      commercialUse: created.commercialUse,
      trustLevel: created.trustLevel,
      evidence: 'Created for research leads with the default terms; set its own terms with a licence revision.',
      setBy: 'system:research_leads',
      createdAt: now,
    })
    .returning({ id: ingestSourceLicences.id });
  await tx.update(ingestSources).set({ licenceRevisionId: rev!.id }).where(and(eq(ingestSources.siteId, siteId), eq(ingestSources.id, created.id)));
  return created.id;
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Turn a site's pending leads into fetch jobs (each in its own transaction): the lead's source is resolved, the
 * target registered as a discovered URL of that source (a URL the site already knows is not fetched again) and the
 * job handed to `onJob`. Returns the jobs.
 */
export async function dispatchResearchLeads(
  deps: { db: Database; now?: () => Date },
  siteId: string,
  onJob: (job: FetchJobPayload) => Promise<void>,
  limit = 100,
): Promise<FetchJobPayload[]> {
  const pending = await runSiteTransaction(deps.db, siteId, (tx) =>
    tx
      .select()
      .from(ingestResearchLeads)
      .where(and(eq(ingestResearchLeads.siteId, siteId), eq(ingestResearchLeads.status, 'pending')))
      .orderBy(asc(ingestResearchLeads.createdAt))
      .limit(limit),
  );
  const jobs: FetchJobPayload[] = [];
  for (const lead of pending) {
    const now = deps.now?.() ?? new Date();
    const job = await runSiteTransaction(deps.db, siteId, async (tx) => {
      const where = and(eq(ingestResearchLeads.siteId, siteId), eq(ingestResearchLeads.id, lead.id), eq(ingestResearchLeads.status, 'pending'));
      const [still] = await tx.select({ id: ingestResearchLeads.id }).from(ingestResearchLeads).where(where).for('update');
      if (!still) return null;
      const sourceId = await leadSourceFor(tx, siteId, lead.normalizedUrl, lead.originSourceId, now);
      const [inserted] = await tx
        .insert(ingestDiscoveredUrls)
        .values({ siteId, sourceId, normalizedUrl: lead.normalizedUrl, url: lead.url, runId: `lead:${lead.id}`, discoveredAt: now, updatedAt: now })
        .onConflictDoNothing()
        .returning({ id: ingestDiscoveredUrls.id });
      const [known] = inserted
        ? [inserted]
        : await tx
            .select({ id: ingestDiscoveredUrls.id })
            .from(ingestDiscoveredUrls)
            .where(and(eq(ingestDiscoveredUrls.siteId, siteId), eq(ingestDiscoveredUrls.normalizedUrl, lead.normalizedUrl)));
      await tx
        .update(ingestResearchLeads)
        .set({ status: 'queued', leadSourceId: sourceId, discoveredUrlId: known?.id ?? null, reason: inserted ? null : 'the site already knew this URL', updatedAt: now })
        .where(where);
      if (!inserted) return null;
      return {
        siteId,
        sourceId,
        runId: `lead:${lead.id}`,
        scheduledFor: lead.createdAt.toISOString(),
        discoveredId: inserted.id,
        url: lead.url,
        normalizedUrl: lead.normalizedUrl,
      } satisfies FetchJobPayload;
    });
    if (job) {
      await onJob(job);
      jobs.push(job);
    }
  }
  return jobs;
}

/** The site's latest research leads. */
export async function listResearchLeads(db: Database, siteId: string, limit = 100): Promise<ResearchLeadResource[]> {
  const rows = await runSiteTransaction(db, siteId, (tx) =>
    tx
      .select()
      .from(ingestResearchLeads)
      .where(eq(ingestResearchLeads.siteId, siteId))
      .orderBy(desc(ingestResearchLeads.createdAt))
      .limit(Math.min(Math.max(limit, 1), 500)),
  );
  return rows.map((r) => ({
    id: r.id,
    url: r.url,
    matchedPattern: r.matchedPattern,
    status: r.status as ResearchLeadResource['status'],
    reason: r.reason,
    originSourceId: r.originSourceId,
    originDocumentId: r.originDocumentId,
    leadSourceId: r.leadSourceId,
    createdAt: r.createdAt.toISOString(),
  }));
}
