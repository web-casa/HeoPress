import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { redirects, siteContentSettings, siteDomains, sites } from '@heopress/database';
import type { SiteTransaction } from '../rls-transaction';
import { spaceOf, validateRules, type EngineRule, type RejectedRule, type SitePathSpace } from '@heopress/public-site';

/**
 * A site's path space and its whole redirect rule set in that space
 * (HeoPress P05; design B, R33–R36): shared by public resolution and by
 * every write that changes the rule set (settings now; imports and manual
 * rules use the same check), which keeps only rule sets that provably
 * terminate.
 */

type Settings = typeof siteContentSettings.$inferSelect;

/** The site's path space from its settings (or the row given) and active domains. */
export async function loadSpace(tx: SiteTransaction, siteId: string, opts: { primaryHost?: string; settings?: Settings } = {}): Promise<SitePathSpace> {
  const [site] = await tx.select({ defaultLanguage: sites.defaultLanguage }).from(sites).where(eq(sites.id, siteId));
  const settings = opts.settings ?? (await tx.select().from(siteContentSettings).where(eq(siteContentSettings.siteId, siteId)))[0];
  const domains = await tx
    .select({ hostname: siteDomains.hostname, locale: siteDomains.entryLocale, isPrimary: siteDomains.isPrimary })
    .from(siteDomains)
    .where(and(eq(siteDomains.siteId, siteId), eq(siteDomains.status, 'active')));
  return spaceOf(siteId, site!.defaultLanguage, settings, domains, opts.primaryHost);
}

/** Every rule of the site in its path space: the strategy's, URL-layer rules on each host, content rules at each address. */
export async function siteEngineRules(tx: SiteTransaction, siteId: string, space: SitePathSpace): Promise<EngineRule[]> {
  const rows = await tx.select().from(redirects).where(and(eq(redirects.siteId, siteId), isNotNull(redirects.fromPath)));
  const out: EngineRule[] = [...space.systemRules()];
  for (const r of rows) {
    if (r.scope === 'url') {
      for (const host of space.hosts()) out.push({ id: r.id, layer: 'url', host, toHost: host, from: r.fromPath, match: r.match as 'exact', to: r.toPath });
    } else {
      out.push(...space.contentRule(r));
    }
  }
  return out;
}

/** Rule ids `validateRules` does not accept in this space (a rule counts once, whichever address failed). */
export async function rejectedRuleIds(tx: SiteTransaction, siteId: string, space: SitePathSpace): Promise<Map<string, RejectedRule['reason']>> {
  const { rejected } = await validateRules(await siteEngineRules(tx, siteId, space));
  const out = new Map<string, RejectedRule['reason']>();
  for (const r of rejected) if (out.get(r.rule.id) !== 'loop') out.set(r.rule.id, r.reason);
  return out;
}

/** A change after which some stored redirect would not provably terminate (design R34, R36). */
export class RedirectConflictError extends Error {
  readonly code = 'REDIRECT_CONFLICT';
  readonly status = 409;
  constructor(readonly rules: Array<{ id: string; reason: RejectedRule['reason'] }>) {
    super('With this change some redirects could loop; nothing was changed. Remove or fix the listed rules first.');
  }
}

/**
 * For a change to the site's address space outside the content settings (a language entry domain
 * activated or given a language): take the settings row exclusively — the lock every rule write
 * holds, shared or exclusive — then, after the change, check the whole rule set (throws
 * RedirectConflictError; the caller's transaction rolls back).
 */
export async function lockAddressSpace(tx: SiteTransaction, siteId: string): Promise<void> {
  await tx.execute(sql`SELECT 1 FROM ${siteContentSettings} WHERE ${siteContentSettings.siteId} = ${siteId} FOR UPDATE`);
}

export async function assertSiteRulesTerminate(tx: SiteTransaction, siteId: string): Promise<void> {
  const rejected = await rejectedRuleIds(tx, siteId, await loadSpace(tx, siteId));
  if (rejected.size > 0) throw new RedirectConflictError([...rejected].map(([id, reason]) => ({ id, reason })));
}
