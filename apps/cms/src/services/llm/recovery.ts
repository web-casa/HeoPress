import { and, eq, sql } from 'drizzle-orm';
import { llmCalls, sites, type Database } from '@heopress/database';
import { formatSafeError } from '@heopress/contracts/utils';
import { runSiteTransaction } from '../rls-transaction';
import { RECOVERY_GRACE_MS } from './gateway';
import { failCall, lastAttempt, lockLedger, recoverAttempt, staleWork, type Candidate } from './ledger';

/**
 * Recovery of the model ledger (HeoPress P04 task 7.4; design state machine
 * T7 and T7b), run periodically:
 *
 * - T7: an attempt still in flight whose lease ended more than the grace
 *   period ago is lost; its reservation becomes an unknown liability
 *   (never released without evidence).
 * - T7b: an open call whose lease ended more than the grace period ago,
 *   with nothing in flight, ends: cancelled, past its deadline, chain
 *   exhausted — or abandoned. No backup is called for a caller that left.
 *
 * Each site is handled in its own scoped transaction (row-level security
 * applies per site), under the site's ledger lock.
 */
export async function recoverLlmLedger(db: Database, opts: { graceMs?: number } = {}): Promise<{ attempts: number; calls: number }> {
  const graceMs = opts.graceMs ?? RECOVERY_GRACE_MS;
  const all = await db.select({ id: sites.id }).from(sites);
  let attempts = 0;
  let calls = 0;
  for (const { id: siteId } of all) {
    const done = await runSiteTransaction(db, siteId, async (tx) => {
      await lockLedger(tx, siteId);
      const work = await staleWork(tx, siteId, graceMs);
      let a = 0;
      let c = 0;
      for (const attemptId of work.attempts) if (await recoverAttempt(tx, siteId, attemptId, graceMs)) a++;
      for (const callId of work.calls) {
        const last = await lastAttempt(tx, siteId, callId);
        if (last?.outcome === 'in_flight') continue; // its own lease is still running
        const [call] = await tx.select().from(llmCalls).where(and(eq(llmCalls.siteId, siteId), eq(llmCalls.id, callId)));
        if (!call || call.status !== 'open') continue;
        const [deadline] = (await tx.execute(sql`SELECT deadline_at <= now() AS expired FROM lumibase_llm_calls WHERE site_id = ${siteId} AND id = ${callId}`)) as unknown as Array<{ expired: boolean }>;
        const exhausted = last !== null && last.position >= (call.candidates as Candidate[]).length - 1;
        const reason = call.cancelRequestedAt ? 'CANCELLED' : deadline?.expired ? 'DEADLINE_EXCEEDED' : exhausted ? 'CHAIN_EXHAUSTED' : 'ABANDONED';
        if (await failCall(tx, siteId, callId, reason)) c++;
      }
      return { a, c };
    });
    attempts += done.a;
    calls += done.c;
  }
  return { attempts, calls };
}

/** Cron wrapper: never throws. */
export async function runScheduledLlmRecovery(db: Database): Promise<void> {
  try {
    const out = await recoverLlmLedger(db);
    if (out.attempts || out.calls) console.warn('[llm-recovery]', JSON.stringify(out));
  } catch (err) {
    console.error('[llm-recovery] failed', formatSafeError(err));
  }
}
