import { and, eq, sql } from 'drizzle-orm';
import { aiProcessingDays, llmAttempts, llmSiteSettings, type Database } from '@heopress/database';
import { runSiteTransaction, type SiteTransaction } from '../rls-transaction';
import { safeMicros } from './ledger';
import { siteTimezone } from './pipeline-control';

/**
 * Daily limits in the site's time zone (HeoPress P09 tasks 4.5, 4.6; spec ai/cost-control "模型调用治理",
 * "每日加工配额"): the optional daily model budget and the daily processing quota. Both count per local calendar
 * day (`lumibase_site_content_settings.timezone`), so a day starts at the site's midnight, across DST changes.
 */

type Tx = SiteTransaction;

/** `YYYY-MM-DD` of `at` in `timeZone`. */
export function dayOf(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
  const v = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${v('year')}-${v('month')}-${v('day')}`;
}

/** `day` plus `n` calendar days. */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** The instant the local day after `at` starts (the site's next midnight). */
export function nextDayStart(at: Date, timeZone: string): Date {
  const target = addDays(dayOf(at, timeZone), 1);
  // Search forward hour by hour from the UTC instant of that date, then minute by minute: DST-safe without tz data.
  let t = Date.parse(`${target}T00:00:00Z`) - 15 * 3_600_000;
  while (dayOf(new Date(t), timeZone) < target) t += 3_600_000;
  t -= 3_600_000;
  while (dayOf(new Date(t), timeZone) < target) t += 60_000;
  return new Date(t);
}

/** The instant the local day of `at` started. */
export function dayStart(at: Date, timeZone: string): Date {
  // 26 hours back lands on the day before or the one before that (a day lasts 23–25 hours).
  const s = nextDayStart(new Date(at.getTime() - 26 * 3_600_000), timeZone);
  return dayOf(s, timeZone) === dayOf(at, timeZone) ? s : nextDayStart(s, timeZone);
}

export interface DailyBudget {
  dailyBudgetMicros: number | null;
  timeZone: string;
}

export async function dailyBudgetOf(tx: Tx, siteId: string): Promise<DailyBudget> {
  const [row] = await tx.select({ daily: llmSiteSettings.dailyBudgetMicros }).from(llmSiteSettings).where(eq(llmSiteSettings.siteId, siteId));
  return { dailyBudgetMicros: row?.daily ?? null, timeZone: await siteTimezone(tx, siteId) };
}

/**
 * Committed money of the site's local day of `at`: attempts started that day — settled at their actual cost,
 * reserved or unknown at their reservation. Run under the ledger lock.
 */
export async function dailyCommittedMicros(tx: Tx, siteId: string, at: Date, timeZone: string): Promise<number> {
  const from = dayStart(at, timeZone);
  const to = nextDayStart(at, timeZone);
  const [row] = (await tx.execute(sql`
    SELECT COALESCE(SUM(CASE
             WHEN ${llmAttempts.billing} = 'settled' THEN ${llmAttempts.actualMicros}
             WHEN ${llmAttempts.billing} IN ('reserved', 'unknown') THEN ${llmAttempts.reservedMicros}
             ELSE 0 END), 0)::text AS total
      FROM ${llmAttempts}
     WHERE ${llmAttempts.siteId} = ${siteId}
       AND ${llmAttempts.createdAt} >= ${from.toISOString()}::timestamptz
       AND ${llmAttempts.createdAt} < ${to.toISOString()}::timestamptz`)) as unknown as Array<{ total: string | null }>;
  return safeMicros(row?.total);
}

// ── the daily processing quota ──────────────────────────────────────────

export interface QuotaCandidate {
  id: string;
  /** Higher first. */
  priority: number;
  /** Ties: earlier first. */
  eligibleAt: Date;
}

export interface QuotaPlan {
  /** Admitted today, in processing order. */
  admitted: string[];
  /** The rest, each with the local day it is planned for (by priority, `limit` per day). */
  deferred: Array<{ id: string; day: string }>;
}

/** Pure: order by priority, fill today's remaining slots, then the following days at `limit` each. */
export function planQuota(items: QuotaCandidate[], limit: number | null, usedToday: number, today: string): QuotaPlan {
  const ordered = [...items].sort((a, b) => b.priority - a.priority || a.eligibleAt.getTime() - b.eligibleAt.getTime() || a.id.localeCompare(b.id));
  if (limit === null) return { admitted: ordered.map((i) => i.id), deferred: [] };
  const remaining = Math.max(0, limit - usedToday);
  const admitted = ordered.slice(0, remaining).map((i) => i.id);
  const rest = ordered.slice(remaining);
  if (limit === 0) return { admitted, deferred: rest.map((i) => ({ id: i.id, day: addDays(today, 1) })) };
  const deferred = rest.map((i, n) => ({ id: i.id, day: addDays(today, 1 + Math.floor(n / limit)) }));
  return { admitted, deferred };
}

/**
 * Admit eligible source documents into today's processing, up to the site's daily limit: atomically (the day's
 * counter row is locked), so two schedulers never admit more than the limit together. The rest is planned onto
 * later days by priority; they are offered again then (a later day's plan is advisory: its own run decides).
 * Independent from the publishing cadence.
 */
export async function claimDailyProcessing(deps: { db: Database; now?: () => Date }, siteId: string, items: QuotaCandidate[]): Promise<QuotaPlan & { day: string; limit: number | null }> {
  const now = deps.now?.() ?? new Date();
  return runSiteTransaction(deps.db, siteId, async (tx) => {
    const [settings] = await tx.select({ limit: llmSiteSettings.dailyProcessingLimit }).from(llmSiteSettings).where(eq(llmSiteSettings.siteId, siteId));
    const limit = settings?.limit ?? null;
    const day = dayOf(now, await siteTimezone(tx, siteId));
    await tx.insert(aiProcessingDays).values({ siteId, day }).onConflictDoNothing();
    const key = and(eq(aiProcessingDays.siteId, siteId), eq(aiProcessingDays.day, day));
    const [row] = await tx.select().from(aiProcessingDays).where(key).for('update');
    const plan = planQuota(items, limit, row?.admitted ?? 0, day);
    if (plan.admitted.length) {
      await tx
        .update(aiProcessingDays)
        .set({ admitted: sql`${aiProcessingDays.admitted} + ${plan.admitted.length}`, updatedAt: now })
        .where(key);
    }
    return { ...plan, day, limit };
  });
}
