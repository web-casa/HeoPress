import { and, eq, sql } from 'drizzle-orm';
import { ingestProviderSettings, ingestProviderUsage, type Database } from '@heopress/database';
import { runSiteTransaction } from '../../rls-transaction';
import { notifySiteAdmins } from '../source-service';
import type { ProviderId } from './types';

/**
 * Budget and circuit breaker per crawl service and site (HeoPress P08 task 3.4; design decision 5; spec
 * ingest/crawling "采集服务预算与熔断").
 *
 * Before a call, `reserveUsage` adds the request and its estimated cost to the month's row under a row lock — only
 * if the total stays within the site's ceiling. A reservation that would pass the ceiling marks the month exhausted:
 * the service is off for that site until the month ends or an administrator raises the ceiling, and the site's
 * administrators are notified once. After the call `settleUsage` replaces the estimate with the reported cost and
 * feeds the breaker: `breakerFailures()` failures in a row pause the service for the site for `breakerPauseMs()`.
 */

export function monthOf(now: Date): string {
  return now.toISOString().slice(0, 7);
}

function breakerFailures(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.HEOPRESS_INGEST_PROVIDER_BREAKER_FAILURES);
  return Number.isInteger(n) && n > 0 ? n : 5;
}

function breakerPauseMs(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.HEOPRESS_INGEST_PROVIDER_BREAKER_MINUTES);
  return (Number.isFinite(n) && n > 0 ? n : 15) * 60_000;
}

export type Reservation = { ok: true; estimate: number } | { ok: false; reason: 'budget_exhausted' };

export async function reserveUsage(
  deps: { db: Database; now?: () => Date },
  input: { siteId: string; provider: ProviderId; estimate: number; ceiling: number | null },
): Promise<Reservation> {
  const now = deps.now?.() ?? new Date();
  const month = monthOf(now);
  const { siteId, provider, estimate, ceiling } = input;
  return runSiteTransaction(deps.db, siteId, async (tx) => {
    await tx.insert(ingestProviderUsage).values({ siteId, provider, month, updatedAt: now }).onConflictDoNothing();
    const key = and(eq(ingestProviderUsage.siteId, siteId), eq(ingestProviderUsage.provider, provider), eq(ingestProviderUsage.month, month));
    const [row] = await tx.select().from(ingestProviderUsage).where(key).for('update');
    if (!row) throw new Error('usage row missing');
    if (row.exhaustedAt) return { ok: false, reason: 'budget_exhausted' } as const;
    if (ceiling !== null && row.costMicros + estimate > ceiling) {
      await tx.update(ingestProviderUsage).set({ exhaustedAt: now, updatedAt: now }).where(key);
      await notifySiteAdmins(tx, siteId, {
        subject: `Crawl service budget reached: ${provider}`,
        message: `${provider} reached this site's monthly budget (${(row.costMicros / 1e6).toFixed(2)} of ${(ceiling / 1e6).toFixed(2)} USD, estimated) and is off for this site until next month. Raise the ceiling under Content › Crawl services to turn it back on.`,
        item: provider,
        collection: 'ingest_provider_settings',
      });
      return { ok: false, reason: 'budget_exhausted' } as const;
    }
    await tx
      .update(ingestProviderUsage)
      .set({ requests: sql`${ingestProviderUsage.requests} + 1`, costMicros: sql`${ingestProviderUsage.costMicros} + ${estimate}`, updatedAt: now })
      .where(key);
    return { ok: true, estimate } as const;
  });
}

export async function settleUsage(
  deps: { db: Database; now?: () => Date; env?: Record<string, string | undefined> },
  input: { siteId: string; provider: ProviderId; estimate: number; cost: number | null; failed: boolean },
): Promise<{ breakerOpened: boolean }> {
  const now = deps.now?.() ?? new Date();
  const month = monthOf(now);
  const { siteId, provider } = input;
  const delta = input.cost === null ? 0 : Math.max(0, Math.round(input.cost)) - input.estimate;
  return runSiteTransaction(deps.db, siteId, async (tx) => {
    await tx
      .update(ingestProviderUsage)
      .set({
        costMicros: sql`greatest(0, ${ingestProviderUsage.costMicros} + ${delta})`,
        ...(input.failed ? { failures: sql`${ingestProviderUsage.failures} + 1` } : {}),
        updatedAt: now,
      })
      .where(and(eq(ingestProviderUsage.siteId, siteId), eq(ingestProviderUsage.provider, provider), eq(ingestProviderUsage.month, month)));
    const where = and(eq(ingestProviderSettings.siteId, siteId), eq(ingestProviderSettings.provider, provider));
    if (!input.failed) {
      await tx.update(ingestProviderSettings).set({ consecutiveFailures: 0 }).where(where);
      return { breakerOpened: false };
    }
    const [row] = await tx
      .update(ingestProviderSettings)
      .set({ consecutiveFailures: sql`${ingestProviderSettings.consecutiveFailures} + 1` })
      .where(where)
      .returning({ failures: ingestProviderSettings.consecutiveFailures });
    if (!row || row.failures < breakerFailures(deps.env)) return { breakerOpened: false };
    await tx
      .update(ingestProviderSettings)
      .set({ consecutiveFailures: 0, pausedUntil: new Date(now.getTime() + breakerPauseMs(deps.env)) })
      .where(where);
    return { breakerOpened: true };
  });
}
