import { createHash } from 'node:crypto';
import { and, asc, desc, eq, lt, sql } from 'drizzle-orm';
import { llmAttempts, llmCalls, llmSiteSettings, type Database } from '@heopress/database';
import { AuditLogger } from '../../modules/audit/logger';
import type { SiteTransaction } from '../rls-transaction';

/**
 * The per-attempt ledger (HeoPress P04 task 7.4; design "模型提供方实施方案",
 * the call/attempt state machine T1–T9).
 *
 * Every function here is one transition and runs inside a site transaction
 * that already holds the site's ledger lock (`lockLedger`), so reservations,
 * settlements and currency changes are serialised per site. Each transition
 * is a conditional update; a transition that finds the row in another state
 * changes nothing and says so.
 *
 * Money is integer micro-units. Nothing here ever releases a liability
 * without evidence: `unknown` keeps its reservation until a complete usage
 * report or a person settles it.
 */

export type Tx = SiteTransaction;

/** A candidate of a call's frozen chain. */
export interface Candidate {
  source: 'site' | 'instance';
  providerId?: string;
  instanceRef?: string;
  name: string;
  /** `openai_compatible`, or an instance protocol (`openai`, `anthropic`, `gemini`, `nvidia`, `decision`, `embedding`). */
  protocol: string;
  baseUrl: string | null;
  model: string;
  pricing: { kind: 'per_1m_tokens'; inputMicros: number; outputMicros: number } | { kind: 'per_request'; requestMicros: number };
  currency: string;
  timeoutMs: number;
  capabilities: { tools: boolean; json: boolean; maxContext: number | null };
  /** Configuration fingerprint (no secret). */
  fingerprint: string;
}

interface Usage {
  complete: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
}

export type CallRow = typeof llmCalls.$inferSelect;
export type AttemptRow = typeof llmAttempts.$inferSelect;

export async function lockLedger(tx: Tx, siteId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`heopress-llm-ledger:${siteId}`}))`);
}

export function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** `YYYY-MM` of `at` in a time zone (the site's budget month). */
export function periodOf(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit' }).formatToParts(at);
  const y = parts.find((p) => p.type === 'year')!.value;
  const m = parts.find((p) => p.type === 'month')!.value;
  return `${y}-${m}`;
}

const ceilDiv = (a: number, b: number) => Math.ceil(a / b);

/** Estimated input tokens of what is actually sent: characters / 4, rounded up. */
export function estimateTokens(text: string): number {
  return ceilDiv(text.length, 4);
}

/** The reservation for an attempt: estimated input plus the output cap, each rounded up. */
export function reservationOf(c: Candidate, inputTokens: number, maxOutputTokens: number): number {
  if (c.pricing.kind === 'per_request') return c.pricing.requestMicros;
  return ceilDiv(inputTokens * c.pricing.inputMicros, 1_000_000) + ceilDiv(maxOutputTokens * c.pricing.outputMicros, 1_000_000);
}

/** What complete usage costs (null without complete usage). */
function costOf(pricing: Candidate['pricing'], usage: Usage): number | null {
  if (pricing.kind === 'per_request') return usage.complete ? pricing.requestMicros : null;
  if (!usage.complete || usage.inputTokens === null || usage.outputTokens === null) return null;
  return ceilDiv(usage.inputTokens * pricing.inputMicros, 1_000_000) + ceilDiv(usage.outputTokens * pricing.outputMicros, 1_000_000);
}

export interface SiteBudget {
  currency: string;
  monthlyBudgetMicros: number | null;
  budgetTimezone: string;
}

export async function siteBudget(tx: Tx, siteId: string, instanceCurrency: string): Promise<SiteBudget> {
  const [row] = await tx.select().from(llmSiteSettings).where(eq(llmSiteSettings.siteId, siteId));
  return row
    ? { currency: row.currency, monthlyBudgetMicros: row.monthlyBudgetMicros ?? null, budgetTimezone: row.budgetTimezone }
    : { currency: instanceCurrency, monthlyBudgetMicros: null, budgetTimezone: 'UTC' };
}

/**
 * Committed money against the budget of `period`: this period's settled
 * (actual), reserved and unknown (reservation), plus every earlier period's
 * reservations still reserved or unknown — a liability does not vanish
 * when the month turns.
 */
async function committedMicros(tx: Tx, siteId: string, period: string): Promise<number> {
  const [row] = await tx.execute<{ total: string | null }>(sql`
    SELECT ${committedSum(period)}::text AS total
      FROM ${llmAttempts}
     WHERE ${llmAttempts.siteId} = ${siteId}`).then((r) => r as unknown as Array<{ total: string | null }>);
  return safeMicros(row?.total);
}

/** The committed sum as SQL, over the site's attempts (one definition: the budget check and the usage report). */
export function committedSum(period: string) {
  return sql`COALESCE(SUM(CASE
             WHEN ${llmAttempts.period} = ${period} AND ${llmAttempts.billing} = 'settled' THEN ${llmAttempts.actualMicros}
             WHEN ${llmAttempts.billing} IN ('reserved', 'unknown') AND ${llmAttempts.period} <= ${period} THEN ${llmAttempts.reservedMicros}
             ELSE 0 END), 0)`;
}

/** A sum of micro-units from SQL (exact text) as a number — refused beyond the exact range, never rounded. */
export function safeMicros(text: string | number | null | undefined): number {
  const value = Number(text ?? 0);
  if (!Number.isSafeInteger(value)) throw new Error('A model cost sum is beyond the exact integer range.');
  return value;
}

export class LedgerRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'LedgerRefusal';
  }
}

/** Admission of an attempt: currency, budget. Throws a refusal (the caller ends the call with it). */
export async function admit(tx: Tx, siteId: string, c: Candidate, reserveMicros: number, budget: SiteBudget, at: Date): Promise<string> {
  if (c.currency !== budget.currency) {
    throw new LedgerRefusal('PRICE_CURRENCY_MISMATCH', `${c.name} is priced in ${c.currency}, the site in ${budget.currency}.`);
  }
  const period = periodOf(at, budget.budgetTimezone);
  if (budget.monthlyBudgetMicros !== null) {
    const committed = await committedMicros(tx, siteId, period);
    if (committed + reserveMicros > budget.monthlyBudgetMicros) {
      throw new LedgerRefusal('BUDGET_EXCEEDED', 'The model budget of this site is used up for this month.');
    }
  }
  return period;
}

export interface NewAttempt {
  siteId: string;
  callId: string;
  seq: number;
  position: number;
  previousAttemptId: string | null;
  candidate: Candidate;
  requestDigest: string;
  period: string;
  reservedMicros: number;
  ownerId: string;
  leaseMs: number;
}

/** Insert an attempt `in_flight / reserved` with its lease (T1, T6b). */
export async function insertAttempt(tx: Tx, a: NewAttempt): Promise<AttemptRow> {
  const c = a.candidate;
  const [row] = await tx
    .insert(llmAttempts)
    .values({
      siteId: a.siteId,
      callId: a.callId,
      seq: a.seq,
      position: a.position,
      previousAttemptId: a.previousAttemptId,
      source: c.source,
      providerId: c.source === 'site' ? c.providerId! : null,
      instanceRef: c.source === 'instance' ? c.instanceRef! : null,
      snapshot: {
        name: c.name,
        protocol: c.protocol,
        baseUrl: c.baseUrl,
        model: c.model,
        pricing: c.pricing,
        currency: c.currency,
        fingerprint: c.fingerprint,
      },
      requestDigest: a.requestDigest,
      period: a.period,
      outcome: 'in_flight',
      billing: 'reserved',
      ownerId: a.ownerId,
      leaseUntil: sql`now() + make_interval(secs => ${a.leaseMs / 1000})` as unknown as Date,
      reservedMicros: a.reservedMicros,
    })
    .returning();
  return row!;
}

export interface Evidence {
  /** The request may have reached the service (false only when proven not sent). */
  sent: boolean;
  usage: Usage;
  errorCode?: string;
}

/** The billing columns the evidence supports (shared by T2, T4, T5, T8). */
function billingFor(attempt: Pick<AttemptRow, 'reservedMicros' | 'snapshot'>, ev: Evidence) {
  const pricing = (attempt.snapshot as { pricing: Candidate['pricing'] }).pricing;
  const actual = costOf(pricing, ev.usage);
  if (actual !== null) {
    return {
      billing: 'settled' as const,
      actualMicros: actual,
      inputTokens: ev.usage.inputTokens,
      outputTokens: ev.usage.outputTokens,
      settledBy: 'auto',
      settledAt: new Date(),
      overspend: actual > attempt.reservedMicros,
    };
  }
  if (!ev.sent) {
    return { billing: 'cancelled' as const, actualMicros: 0, inputTokens: null, outputTokens: null, settledBy: 'auto', settledAt: new Date(), overspend: false };
  }
  return { billing: 'unknown' as const, inputTokens: ev.usage.inputTokens, outputTokens: ev.usage.outputTokens, overspend: false };
}

export async function alertOverspend(tx: Tx, attempt: AttemptRow, actual: number): Promise<void> {
  await new AuditLogger({ db: tx as unknown as Database, siteId: attempt.siteId }).writeInTransaction(tx, {
    siteId: attempt.siteId,
    event: 'llm_cost_over_reservation',
    metadata: { attemptId: attempt.id, callId: attempt.callId, reservedMicros: attempt.reservedMicros, actualMicros: actual },
  });
  console.warn('[llm-ledger] actual cost above the reservation', JSON.stringify({ siteId: attempt.siteId, attemptId: attempt.id }));
}

export type EndKind = 'succeeded' | 'failed_transferable' | 'failed_final';

/**
 * T2 / T4 / T5: the attempt ends while its executor still holds the lease.
 * T2 completes the call with the result (the winner is this attempt — the
 * condition is that it belongs to the call); T5 fails it. Returns false
 * when the attempt is no longer this executor's (lease lost): the caller
 * then applies T7 + T8 instead.
 */
export async function endAttempt(
  tx: Tx,
  attempt: AttemptRow,
  ownerId: string,
  kind: EndKind,
  ev: Evidence,
  call: { result?: unknown; reason?: string },
): Promise<boolean> {
  const bill = billingFor(attempt, ev);
  const ended = await tx
    .update(llmAttempts)
    .set({ outcome: kind, ...bill, errorCode: ev.errorCode ?? null, endedAt: new Date(), version: sql`${llmAttempts.version} + 1` })
    .where(
      and(
        eq(llmAttempts.siteId, attempt.siteId),
        eq(llmAttempts.id, attempt.id),
        eq(llmAttempts.outcome, 'in_flight'),
        eq(llmAttempts.ownerId, ownerId),
        sql`${llmAttempts.leaseUntil} > now()`,
      ),
    )
    .returning({ id: llmAttempts.id });
  if (ended.length === 0) return false;
  if (bill.overspend) await alertOverspend(tx, attempt, bill.actualMicros!);
  if (kind === 'succeeded') {
    await tx
      .update(llmCalls)
      .set({ status: 'completed', winnerAttemptId: attempt.id, result: call.result ?? {}, ownerId: null, leaseUntil: null, updatedAt: new Date(), version: sql`${llmCalls.version} + 1` })
      .where(and(eq(llmCalls.siteId, attempt.siteId), eq(llmCalls.id, attempt.callId), eq(llmCalls.status, 'open')));
  } else if (kind === 'failed_final') {
    await failCall(tx, attempt.siteId, attempt.callId, call.reason ?? 'FAILED');
  }
  return true;
}

/** End an open call as failed (T5, T6a, T6b refusal, T7b). */
export async function failCall(tx: Tx, siteId: string, callId: string, reason: string): Promise<boolean> {
  const done = await tx
    .update(llmCalls)
    .set({ status: 'failed', terminalReason: reason, ownerId: null, leaseUntil: null, updatedAt: new Date(), version: sql`${llmCalls.version} + 1` })
    .where(and(eq(llmCalls.siteId, siteId), eq(llmCalls.id, callId), eq(llmCalls.status, 'open')))
    .returning({ id: llmCalls.id });
  return done.length > 0;
}

/**
 * T7: an in-flight attempt whose lease expired is lost; its reservation
 * becomes an unknown liability. `graceMs`: how long past expiry before
 * someone other than its executor may do this (0 for the executor itself).
 */
export async function recoverAttempt(tx: Tx, siteId: string, attemptId: string, graceMs: number): Promise<boolean> {
  const done = await tx
    .update(llmAttempts)
    .set({
      outcome: 'lost',
      billing: sql`CASE WHEN ${llmAttempts.billing} = 'reserved' THEN 'unknown' ELSE ${llmAttempts.billing} END`,
      endedAt: new Date(),
      version: sql`${llmAttempts.version} + 1`,
    })
    .where(
      and(
        eq(llmAttempts.siteId, siteId),
        eq(llmAttempts.id, attemptId),
        eq(llmAttempts.outcome, 'in_flight'),
        sql`${llmAttempts.leaseUntil} < now() - make_interval(secs => ${graceMs / 1000})`,
      ),
    )
    .returning({ id: llmAttempts.id });
  return done.length > 0;
}

/**
 * T8: late usage for an attempt that has ended execution: only the cost,
 * by the evidence; never the call, its state or its result; a manual
 * conclusion is never overwritten (the late result is kept beside it).
 */
export async function lateUsage(tx: Tx, attempt: AttemptRow, ev: Evidence): Promise<void> {
  const [row] = await tx.select().from(llmAttempts).where(and(eq(llmAttempts.siteId, attempt.siteId), eq(llmAttempts.id, attempt.id)));
  if (!row || row.outcome === 'in_flight') return;
  if (row.settledBy === 'manual') {
    await tx
      .update(llmAttempts)
      .set({ lateResult: { at: new Date().toISOString(), usage: ev.usage }, version: sql`${llmAttempts.version} + 1` })
      .where(and(eq(llmAttempts.siteId, row.siteId), eq(llmAttempts.id, row.id), eq(llmAttempts.version, row.version)));
    return;
  }
  if (row.billing !== 'unknown') return;
  const bill = billingFor(row, ev);
  // Complete usage settles it; proof that nothing was sent cancels it; otherwise it stays unknown.
  if (bill.billing === 'unknown') return;
  const done = await tx
    .update(llmAttempts)
    .set({ ...bill, version: sql`${llmAttempts.version} + 1` })
    .where(and(eq(llmAttempts.siteId, row.siteId), eq(llmAttempts.id, row.id), eq(llmAttempts.version, row.version), eq(llmAttempts.billing, 'unknown')))
    .returning({ id: llmAttempts.id });
  if (done.length && bill.overspend) await alertOverspend(tx, row, bill.actualMicros!);
}

export async function lastAttempt(tx: Tx, siteId: string, callId: string): Promise<AttemptRow | null> {
  const [row] = await tx
    .select()
    .from(llmAttempts)
    .where(and(eq(llmAttempts.siteId, siteId), eq(llmAttempts.callId, callId)))
    .orderBy(desc(llmAttempts.seq))
    .limit(1);
  return row ?? null;
}

/** Calls whose lease expired with nothing in flight (for T7b), and attempts past grace (for T7). */
export async function staleWork(tx: Tx, siteId: string, graceMs: number) {
  const attempts = await tx
    .select({ id: llmAttempts.id })
    .from(llmAttempts)
    .where(and(eq(llmAttempts.siteId, siteId), eq(llmAttempts.outcome, 'in_flight'), lt(llmAttempts.leaseUntil, sql`now() - make_interval(secs => ${graceMs / 1000})`)));
  const calls = await tx
    .select({ id: llmCalls.id })
    .from(llmCalls)
    .where(and(eq(llmCalls.siteId, siteId), eq(llmCalls.status, 'open'), lt(llmCalls.leaseUntil, sql`now() - make_interval(secs => ${graceMs / 1000})`)));
  return { attempts: attempts.map((a) => a.id), calls: calls.map((c) => c.id) };
}
