import { and, desc, eq, gte, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import type { LlmReconcileBatchInput, LlmReconcileInput } from '@heopress/contracts/schemas';
import { llmAttempts, type Database } from '@heopress/database';
import { AuditLogger } from '../../modules/audit/logger';
import { runSiteTransaction } from '../rls-transaction';
import { alertOverspend, committedSum, lockLedger, periodOf, safeMicros, siteBudget, type AttemptRow, type Tx } from './ledger';
import { LlmConfigError } from './provider-service';

/**
 * A site's model usage and the manual reconciliation of its ledger
 * (HeoPress P04 task 7.4; design "模型提供方实施方案", T9 and "接口").
 *
 * - Usage of a budget month, by provider and model: settled cost, open
 *   reservations, attempts whose billing is unknown (count and amount), and
 *   the liabilities of earlier months still open — they count against this
 *   month's budget until settled.
 * - Reconciliation (T9) is open only for an attempt that has ended execution
 *   and whose billing is unknown, or that a person already concluded (a
 *   revision). Every conclusion records operator, time and evidence, and
 *   keeps the earlier ones. In-flight attempts wait for recovery (T7).
 * - A batch "not billed" (e.g. a run of rate-limit errors from one provider)
 *   is one conditional update per attempt, each with its own result.
 */

/** The most attempts one batch concludes; the response says when more matched. */
const BATCH_LIMIT = 500;
const PAGE_LIMIT = 100;

type ReconcileResult = 'reconciled' | 'version_conflict' | 'not_pending';

interface Reconciliation {
  conclusion: 'settled' | 'cancelled';
  actualMicros: number;
  evidence: string;
  operator: string | null;
  at: string;
  batch?: boolean;
  revisions?: Array<Omit<Reconciliation, 'revisions'>>;
}

export interface LlmUsageServiceDeps {
  db: Database;
  siteId: string;
  instanceCurrency: string;
}

const snapshotOf = (a: Pick<AttemptRow, 'snapshot'>) => a.snapshot as { name?: string; model?: string; pricing?: unknown; currency?: string };

/** An attempt as the API shows it: the snapshot's name and model, never its configuration internals. */
function present(a: AttemptRow) {
  const snap = snapshotOf(a);
  return {
    id: a.id,
    callId: a.callId,
    seq: a.seq,
    source: a.source,
    providerId: a.providerId,
    instanceRef: a.instanceRef,
    name: snap.name ?? null,
    model: snap.model ?? null,
    currency: snap.currency ?? null,
    period: a.period,
    outcome: a.outcome,
    billing: a.billing,
    version: a.version,
    reservedMicros: a.reservedMicros,
    actualMicros: a.actualMicros,
    inputTokens: a.inputTokens,
    outputTokens: a.outputTokens,
    errorCode: a.errorCode,
    settledBy: a.settledBy,
    reconciliation: a.reconciliation,
    lateResult: a.lateResult,
    overspend: a.overspend,
    createdAt: a.createdAt.toISOString(),
    endedAt: a.endedAt?.toISOString() ?? null,
    settledAt: a.settledAt?.toISOString() ?? null,
  };
}

/** Ended execution, and unknown billing or a person's earlier conclusion. */
const reconcilable = (a: AttemptRow) => a.outcome !== 'in_flight' && (a.billing === 'unknown' || a.settledBy === 'manual');

export class LlmUsageService {
  constructor(private readonly deps: LlmUsageServiceDeps) {}

  private get siteId(): string {
    return this.deps.siteId;
  }

  private tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return runSiteTransaction(this.deps.db, this.siteId, fn);
  }

  /**
   * Usage of a budget month (`YYYY-MM`; default: the current one in the site's
   * budget time zone). One statement, so the breakdown, the carried-over debt
   * and the committed total come from the same snapshot.
   */
  async usage(period?: string) {
    return this.tx(async (tx) => {
      const budget = await siteBudget(tx, this.siteId, this.deps.instanceCurrency);
      const p = period ?? periodOf(new Date(), budget.budgetTimezone);
      const a = llmAttempts;
      const [row] = (await tx.execute(sql`
        WITH by_model AS (
          SELECT ${a.source} AS source, ${a.providerId} AS "providerId", ${a.instanceRef} AS "instanceRef",
                 ${a.snapshot}->>'name' AS name, ${a.snapshot}->>'model' AS model,
                 COUNT(*)::int AS attempts,
                 COUNT(*) FILTER (WHERE ${a.billing} = 'settled')::int AS "settledCount",
                 (COALESCE(SUM(${a.actualMicros}) FILTER (WHERE ${a.billing} = 'settled'), 0))::text AS "settledMicros",
                 COUNT(*) FILTER (WHERE ${a.billing} = 'reserved')::int AS "reservedCount",
                 (COALESCE(SUM(${a.reservedMicros}) FILTER (WHERE ${a.billing} = 'reserved'), 0))::text AS "reservedMicros",
                 COUNT(*) FILTER (WHERE ${a.billing} = 'unknown')::int AS "unknownCount",
                 (COALESCE(SUM(${a.reservedMicros}) FILTER (WHERE ${a.billing} = 'unknown'), 0))::text AS "unknownMicros",
                 COUNT(*) FILTER (WHERE ${a.billing} = 'cancelled')::int AS "cancelledCount",
                 (COALESCE(SUM(${a.inputTokens}), 0))::text AS "inputTokens",
                 (COALESCE(SUM(${a.outputTokens}), 0))::text AS "outputTokens",
                 COUNT(*) FILTER (WHERE ${a.billing} <> 'cancelled' AND (${a.inputTokens} IS NULL OR ${a.outputTokens} IS NULL))::int AS "withoutUsageCount"
            FROM ${a}
           WHERE ${a.siteId} = ${this.siteId} AND ${a.period} = ${p}
           GROUP BY 1, 2, 3, 4, 5
        ), carried AS (
          SELECT ${a.period} AS period,
                 COUNT(*) FILTER (WHERE ${a.billing} = 'unknown')::int AS "unknownCount",
                 COUNT(*) FILTER (WHERE ${a.billing} = 'reserved')::int AS "reservedCount",
                 (COALESCE(SUM(${a.reservedMicros}), 0))::text AS micros
            FROM ${a}
           WHERE ${a.siteId} = ${this.siteId} AND ${a.period} < ${p} AND ${a.billing} IN ('reserved', 'unknown')
           GROUP BY 1
        )
        SELECT (SELECT COALESCE(json_agg(m ORDER BY m.name, m.model, m."providerId", m."instanceRef"), '[]'::json) FROM by_model m) AS "byModel",
               (SELECT COALESCE(json_agg(c ORDER BY c.period), '[]'::json) FROM carried c) AS "carriedOver",
               (SELECT ${committedSum(p)}::text FROM ${a} WHERE ${a.siteId} = ${this.siteId}) AS committed`)) as unknown as Array<{
        byModel: Array<Record<string, string | number | null>>;
        carriedOver: Array<Record<string, string | number>>;
        committed: string;
      }>;
      const committed = safeMicros(row!.committed);
      return {
        period: p,
        currency: budget.currency,
        monthlyBudgetMicros: budget.monthlyBudgetMicros,
        committedMicros: committed,
        remainingMicros: budget.monthlyBudgetMicros === null ? null : budget.monthlyBudgetMicros - committed,
        byModel: row!.byModel.map((r) => ({
          source: r.source,
          providerId: r.providerId,
          instanceRef: r.instanceRef,
          name: r.name,
          model: r.model,
          attempts: Number(r.attempts),
          settledCount: Number(r.settledCount),
          settledMicros: safeMicros(r.settledMicros),
          reservedCount: Number(r.reservedCount),
          reservedMicros: safeMicros(r.reservedMicros),
          unknownCount: Number(r.unknownCount),
          unknownMicros: safeMicros(r.unknownMicros),
          cancelledCount: Number(r.cancelledCount),
          inputTokens: safeMicros(r.inputTokens),
          outputTokens: safeMicros(r.outputTokens),
          /** Attempts whose token counts are not (fully) known: the token sums leave them out. */
          withoutUsageCount: Number(r.withoutUsageCount),
        })),
        carriedOver: row!.carriedOver.map((r) => ({ period: r.period, unknownCount: Number(r.unknownCount), reservedCount: Number(r.reservedCount), micros: safeMicros(r.micros) })),
      };
    });
  }

  /** The ledger, newest first; `pending` lists what awaits reconciliation. */
  async attempts(filter: { billing?: string; pending?: boolean; period?: string; providerId?: string; before?: string; limit?: number }) {
    const conds: SQL[] = [eq(llmAttempts.siteId, this.siteId)];
    if (filter.pending) conds.push(eq(llmAttempts.billing, 'unknown'), ne(llmAttempts.outcome, 'in_flight'));
    else if (filter.billing) conds.push(eq(llmAttempts.billing, filter.billing));
    if (filter.period) conds.push(eq(llmAttempts.period, filter.period));
    if (filter.providerId) conds.push(eq(llmAttempts.providerId, filter.providerId));
    if (filter.before) {
      // The anchor's time compared in SQL, at full precision; ties broken by id.
      const anchor = sql`(SELECT ${llmAttempts.createdAt} FROM ${llmAttempts} WHERE ${llmAttempts.siteId} = ${this.siteId} AND ${llmAttempts.id} = ${filter.before})`;
      conds.push(sql`(${llmAttempts.createdAt}, ${llmAttempts.id}) < (${anchor}, ${filter.before})`);
    }
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), PAGE_LIMIT);
    const rows = await this.tx((tx) =>
      tx.select().from(llmAttempts).where(and(...conds)).orderBy(desc(llmAttempts.createdAt), desc(llmAttempts.id)).limit(limit + 1),
    );
    const page = rows.slice(0, limit);
    return { items: page.map(present), next: rows.length > limit ? page.at(-1)!.id : null };
  }

  /** T9 on one attempt. */
  async reconcile(attemptId: string, input: LlmReconcileInput, operator: string | null) {
    return this.tx(async (tx) => {
      await lockLedger(tx, this.siteId);
      const [row] = await tx.select().from(llmAttempts).where(and(eq(llmAttempts.siteId, this.siteId), eq(llmAttempts.id, attemptId)));
      if (!row) throw new LlmConfigError('NOT_FOUND', 'Attempt not found.', 404);
      if (!reconcilable(row)) {
        throw new LlmConfigError(
          'NOT_PENDING',
          row.outcome === 'in_flight' ? 'The attempt is still in flight; it can be reconciled once it has ended or been recovered.' : 'The attempt’s billing is already settled by evidence.',
          409,
        );
      }
      if (row.version !== input.version) throw new LlmConfigError('VERSION_CONFLICT', 'The attempt changed since it was read; reload it.', 409);
      const result = await this.conclude(tx, row, {
        conclusion: input.conclusion,
        actualMicros: input.conclusion === 'settled' ? input.actualMicros : 0,
        evidence: input.evidence,
        operator,
      });
      if (result === 'version_conflict') throw new LlmConfigError('VERSION_CONFLICT', 'The attempt changed since it was read; reload it.', 409);
      const [after] = await tx.select().from(llmAttempts).where(and(eq(llmAttempts.siteId, this.siteId), eq(llmAttempts.id, attemptId)));
      return present(after!);
    });
  }

  /** T9 in a batch: confirm as not billed every pending attempt of one provider in a time range. */
  async reconcileBatch(input: LlmReconcileBatchInput, operator: string | null) {
    return this.tx(async (tx) => {
      await lockLedger(tx, this.siteId);
      const source = input.providerId !== undefined ? eq(llmAttempts.providerId, input.providerId) : eq(llmAttempts.instanceRef, input.instanceRef!);
      const rows = await tx
        .select()
        .from(llmAttempts)
        .where(
          and(
            eq(llmAttempts.siteId, this.siteId),
            source,
            eq(llmAttempts.billing, 'unknown'),
            ne(llmAttempts.outcome, 'in_flight'),
            gte(llmAttempts.createdAt, new Date(input.from)),
            lt(llmAttempts.createdAt, new Date(input.to)),
            ...(input.errorCode ? [eq(llmAttempts.errorCode, input.errorCode)] : []),
          ),
        )
        .orderBy(llmAttempts.createdAt, llmAttempts.id)
        .limit(BATCH_LIMIT + 1);
      const batch = rows.slice(0, BATCH_LIMIT);
      const results: Array<{ id: string; result: ReconcileResult }> = [];
      for (const row of batch) {
        results.push({ id: row.id, result: await this.conclude(tx, row, { conclusion: 'cancelled', actualMicros: 0, evidence: input.evidence, operator, batch: true }) });
      }
      return { results, more: rows.length > BATCH_LIMIT };
    });
  }

  /** One conditional update (version), keeping every earlier conclusion as a revision. */
  private async conclude(tx: Tx, row: AttemptRow, c: Omit<Reconciliation, 'at' | 'revisions'>): Promise<ReconcileResult> {
    if (!reconcilable(row)) return 'not_pending';
    const previous = row.reconciliation as Reconciliation | null;
    const { revisions = [], ...last } = previous ?? ({} as Partial<Reconciliation>);
    const record: Reconciliation = {
      ...c,
      at: new Date().toISOString(),
      revisions: previous ? [...revisions, last as Omit<Reconciliation, 'revisions'>] : [],
    };
    const overspend = c.conclusion === 'settled' && c.actualMicros > row.reservedMicros;
    const done = await tx
      .update(llmAttempts)
      .set({
        billing: c.conclusion,
        actualMicros: c.actualMicros,
        settledBy: 'manual',
        settledAt: new Date(),
        reconciliation: record,
        overspend,
        version: sql`${llmAttempts.version} + 1`,
      })
      .where(
        and(
          eq(llmAttempts.siteId, row.siteId),
          eq(llmAttempts.id, row.id),
          eq(llmAttempts.version, row.version),
          ne(llmAttempts.outcome, 'in_flight'),
          or(eq(llmAttempts.billing, 'unknown'), eq(llmAttempts.settledBy, 'manual')),
        ),
      )
      .returning({ id: llmAttempts.id });
    if (done.length === 0) return 'version_conflict';
    await new AuditLogger({ db: tx as unknown as Database, siteId: row.siteId }).writeInTransaction(tx, {
      siteId: row.siteId,
      event: 'llm_attempt_reconciled',
      metadata: { attemptId: row.id, callId: row.callId, conclusion: c.conclusion, actualMicros: c.actualMicros, operator: c.operator, batch: c.batch ?? false, revision: record.revisions!.length },
    });
    if (overspend) await alertOverspend(tx, row, c.actualMicros);
    return 'reconciled';
  }
}

