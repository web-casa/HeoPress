import { sql } from 'drizzle-orm';
import { siteContentSettings } from '@heopress/database';
import { MembershipChangedError, withSiteScope, type SiteTransaction } from '../rls-transaction';

/**
 * One global order for the sites' content settings rows (HeoPress P14 task 4.2; spec i18n/translation-groups
 * "跨站成员同时写入不死锁", design D4).
 *
 * Every write takes `lumibase_site_content_settings` rows before anything else (design §0 of P05). Writes of
 * different sites of one cross-site translation group used to take their own row first and the other members' rows
 * later (the projection's refresh of the group): A holding A and waiting for B while B held B and waited for A was a
 * deadlock, resolved by PostgreSQL killing one side and the retry boundary running it again — or, three times
 * unlucky, a 409.
 *
 * Now a transaction takes the rows **once, at its start, in `site_id` order**, by a plan: its own site in the mode
 * its write needs (`share` for item writes, `update` for settings writes), plus every site it shares a cross-site
 * translation group with (its "translation neighbours", read without a lock), shared. Locking a neighbour it may not
 * need costs only a wait for a rare settings change of that site; it never deadlocks.
 *
 * Every later request goes through {@link requireSettingsLock}: a row already held in that mode (or a stronger one)
 * returns at once; a site above every site held is locked then (order kept); anything else — a site below one held,
 * or a share lock to upgrade — would break the order, so the transaction starts over (`MembershipChangedError`, which
 * the retry boundary runs again) and the site is remembered for the next plan of the same site (an extra site in a
 * plan is harmless, so the memory is a short-lived per-process hint rather than state that must be exact).
 *
 * The first request of a transaction that has no plan yet makes the plan (with that site as its own), so every writer
 * — including those that only call `lockContentSettingsShared` / `lockContentSettingsExclusive` — follows the order.
 */

export type SettingsLockMode = 'share' | 'update';

type Tx = SiteTransaction;

/** The rows a transaction holds and their modes (keyed by the Drizzle transaction handle). */
const held = new WeakMap<object, Map<string, SettingsLockMode>>();

/** Sites a transaction of a site had to start over for, with the mode it needed: added to that site's next plans. */
const discovered = new Map<string, { sites: Map<string, SettingsLockMode>; until: number }>();
const DISCOVERED_TTL_MS = 60_000;
const DISCOVERED_MAX = 10_000;

/** The site whose plan a transaction took (its own site). */
const planSites = new WeakMap<Map<string, SettingsLockMode>, string>();
function planSiteOf(mine: Map<string, SettingsLockMode>): string {
  return planSites.get(mine) ?? [...mine.keys()][0]!;
}

const stronger = (a: SettingsLockMode, b: SettingsLockMode): SettingsLockMode => (a === 'update' || b === 'update' ? 'update' : 'share');

function remember(planSite: string, siteId: string, mode: SettingsLockMode, now = Date.now()): void {
  if (discovered.size >= DISCOVERED_MAX) {
    for (const [k, v] of discovered) if (v.until <= now) discovered.delete(k);
    if (discovered.size >= DISCOVERED_MAX) discovered.clear();
  }
  const entry = discovered.get(planSite);
  const sites = entry && entry.until > now ? entry.sites : new Map<string, SettingsLockMode>();
  sites.set(siteId, stronger(sites.get(siteId) ?? 'share', mode));
  discovered.set(planSite, { sites, until: now + DISCOVERED_TTL_MS });
}

function remembered(planSite: string, now = Date.now()): Map<string, SettingsLockMode> {
  const entry = discovered.get(planSite);
  if (!entry) return new Map();
  if (entry.until <= now) {
    discovered.delete(planSite);
    return new Map();
  }
  return entry.sites;
}

/** The sites `siteId` shares a cross-site translation group with (itself excluded), read without a lock. */
async function translationNeighbours(tx: Tx, siteId: string): Promise<string[]> {
  const rows = (await withSiteScope(tx, siteId, () =>
    tx.execute(sql`
      SELECT DISTINCT s AS site_id
      FROM lumibase_translation_groups g, unnest(g.site_ids) AS s
      WHERE ${siteId} = ANY(g.site_ids) AND cardinality(g.site_ids) > 1`),
  )) as unknown as Array<{ site_id: string }>;
  return rows.map((r) => r.site_id).filter((s) => s !== siteId);
}

async function lockRow(tx: Tx, siteId: string, mode: SettingsLockMode): Promise<void> {
  await withSiteScope(tx, siteId, () =>
    mode === 'update'
      ? tx.execute(sql`SELECT 1 FROM ${siteContentSettings} WHERE ${siteContentSettings.siteId} = ${siteId} FOR UPDATE`)
      : tx.execute(sql`SELECT 1 FROM ${siteContentSettings} WHERE ${siteContentSettings.siteId} = ${siteId} FOR SHARE`),
  );
}

/**
 * Take the plan of a transaction of `siteId`, in `site_id` order: the site in `mode`, its translation neighbours and
 * the sites `also` names (shared unless named `update`), and what earlier attempts of this site found they needed.
 * Called once, at the start; a second call only adds what it can in order (as {@link requireSettingsLock}).
 */
export async function lockSettingsPlan(
  tx: Tx,
  siteId: string,
  mode: SettingsLockMode,
  also: Iterable<[string, SettingsLockMode]> | Iterable<string> = [],
): Promise<void> {
  const existing = held.get(tx);
  const plan = new Map<string, SettingsLockMode>([[siteId, mode]]);
  for (const s of await translationNeighbours(tx, siteId)) plan.set(s, stronger(plan.get(s) ?? 'share', 'share'));
  for (const entry of also) {
    const [s, m] = typeof entry === 'string' ? [entry, 'share' as const] : entry;
    plan.set(s, stronger(plan.get(s) ?? 'share', m));
  }
  for (const [s, m] of remembered(siteId)) plan.set(s, stronger(plan.get(s) ?? 'share', m));
  if (existing && existing.size > 0) {
    for (const [s, m] of [...plan].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) await requireSettingsLock(tx, s, m, siteId);
    return;
  }
  const mine = new Map<string, SettingsLockMode>();
  held.set(tx, mine);
  planSites.set(mine, siteId);
  for (const [s, m] of [...plan].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    await lockRow(tx, s, m);
    mine.set(s, m);
  }
}

/**
 * `siteId`'s settings row, held in `mode` (or stronger) by this transaction from now on. Without a plan yet the
 * transaction makes one ({@link lockSettingsPlan}, `siteId` as its own site); with one, a row out of order makes it
 * start over (`MembershipChangedError`) with the row in its next plan.
 */
export async function requireSettingsLock(tx: Tx, siteId: string, mode: SettingsLockMode, planSite?: string): Promise<void> {
  const mine = held.get(tx);
  if (!mine || mine.size === 0) return lockSettingsPlan(tx, siteId, mode);
  const current = mine.get(siteId);
  if (current && (current === 'update' || mode === 'share')) return;
  const highest = [...mine.keys()].sort().at(-1)!;
  if (!current && siteId > highest) {
    await lockRow(tx, siteId, mode);
    mine.set(siteId, mode);
    return;
  }
  // Below a row held, or a share lock to upgrade: taking it now could wait for a transaction waiting for this one.
  remember(planSite ?? planSiteOf(mine), siteId, mode);
  throw new MembershipChangedError();
}


/** Several sites' rows in one call: the whole set is the plan when the transaction has none yet (first site its own). */
export async function requireSettingsLocks(tx: Tx, siteIds: string[], mode: SettingsLockMode): Promise<void> {
  const sorted = [...new Set(siteIds)].sort();
  if (sorted.length === 0) return;
  const mine = held.get(tx);
  if (!mine || mine.size === 0) {
    await lockSettingsPlan(tx, sorted[0]!, mode, sorted.slice(1).map((s) => [s, mode] as [string, SettingsLockMode]));
    return;
  }
  for (const s of sorted) await requireSettingsLock(tx, s, mode);
}
