import { and, desc, eq, isNull, lt } from 'drizzle-orm';
import { agentFreezes, aiPipelinePauses, llmSiteSettings, notifications, roles, siteContentSettings, userSites, type Database } from '@heopress/database';
import type { AiPipelinePauseReason } from '@heopress/contracts/schemas';
import { AuditLogger } from '../../modules/audit/logger';
import { runSiteTransaction, type SiteTransaction } from '../rls-transaction';
import { periodOf } from './ledger';
import { enqueueChannelNotifications } from '../../modules/notifications/channels/channel-service';

/**
 * Pausing a site's AI content pipeline (HeoPress P09 tasks 4.2, 4.4; spec ai/cost-control "站点月度预算",
 * "并发预算与暂停原因").
 *
 * A pause stops new production work from starting (`assertPipelineRunnable` at the start of each task); work that
 * already started finishes. Reasons are separate rows: when the month's model budget is used up the gateway adds a
 * `budget` pause and notifies the site's administrators once; the first look at the pipeline in a later budget
 * month lifts that pause — and only that one. A `manual` or `incident` pause, and the kill switch (a site freeze),
 * stay until a person lifts them.
 */

type Tx = SiteTransaction;

export type PipelineBlock = AiPipelinePauseReason | 'kill_switch';

export interface PipelineState {
  paused: boolean;
  reasons: PipelineBlock[];
  pauses: Array<typeof aiPipelinePauses.$inferSelect>;
}

export class PipelinePausedError extends Error {
  constructor(readonly reasons: PipelineBlock[]) {
    super(`PIPELINE_PAUSED: the AI content pipeline of this site is paused (${reasons.join(', ')}).`);
    this.name = 'PipelinePausedError';
  }
}

/** The site's budget time zone (the budget month), as the ledger reads it. */
async function budgetTimezone(tx: Tx, siteId: string): Promise<string> {
  const [row] = await tx.select({ tz: llmSiteSettings.budgetTimezone }).from(llmSiteSettings).where(eq(llmSiteSettings.siteId, siteId));
  return row?.tz ?? 'UTC';
}

/** The site's own time zone (daily budget, daily processing quota). */
export async function siteTimezone(tx: Tx, siteId: string): Promise<string> {
  const [row] = await tx.select({ tz: siteContentSettings.timezone }).from(siteContentSettings).where(eq(siteContentSettings.siteId, siteId));
  return row?.tz ?? 'UTC';
}

/** Notify every administrator of the site (a notification row each). */
async function notifyAdmins(tx: Tx, siteId: string, subject: string, message: string): Promise<void> {
  const admins = await tx
    .selectDistinct({ userId: userSites.userId })
    .from(userSites)
    .innerJoin(roles, eq(roles.id, userSites.roleId))
    .where(and(eq(userSites.siteId, siteId), eq(roles.adminAccess, true)));
  if (!admins.length) return;
  await tx.insert(notifications).values(admins.map((a) => ({ siteId, recipient: a.userId, subject, message, collection: 'ai_pipeline', item: 'budget' })));
}

/**
 * The month's budget is used up: pause the site's pipeline for `period` and notify the administrators — once per
 * active budget pause. Runs inside the ledger transaction that refused the reservation.
 */
export async function pauseForBudget(tx: Tx, siteId: string, period: string): Promise<boolean> {
  const created = await tx
    .insert(aiPipelinePauses)
    .values({ siteId, reason: 'budget', period, createdBy: 'system:budget' })
    .onConflictDoNothing()
    .returning({ id: aiPipelinePauses.id });
  if (!created.length) return false;
  await new AuditLogger({ db: tx as unknown as Database, siteId }).writeInTransaction(tx, {
    siteId,
    event: 'ai_pipeline_paused',
    metadata: { reason: 'budget', period },
  });
  await notifyAdmins(
    tx,
    siteId,
    'AI pipeline paused: monthly model budget used up',
    `This site's model budget for ${period} is used up. The content pipeline is paused: running steps finish, no new production starts. It resumes automatically next month, or when an administrator raises the budget and resumes it.`,
  );
  // IM / webhook channels subscribed to budget alerts (P10 task 5.2): queued with this transaction, sent by the sweep.
  await enqueueChannelNotifications(tx, siteId, { event: 'budget', title: 'AI pipeline paused: monthly model budget used up', severity: 'warning', path: '/settings/advanced/ai-pipeline' });
  return true;
}

/** Lift `budget` pauses of earlier budget months (only those). */
async function liftEndedBudgetPauses(tx: Tx, siteId: string, now: Date): Promise<number> {
  const current = periodOf(now, await budgetTimezone(tx, siteId));
  const lifted = await tx
    .update(aiPipelinePauses)
    .set({ liftedAt: now, liftedBy: 'system:new_month' })
    .where(and(eq(aiPipelinePauses.siteId, siteId), eq(aiPipelinePauses.reason, 'budget'), isNull(aiPipelinePauses.liftedAt), lt(aiPipelinePauses.period, current)))
    .returning({ id: aiPipelinePauses.id });
  if (lifted.length) {
    await new AuditLogger({ db: tx as unknown as Database, siteId }).writeInTransaction(tx, {
      siteId,
      event: 'ai_pipeline_resumed',
      metadata: { reason: 'budget', by: 'new_month', period: current },
    });
  }
  return lifted.length;
}

/** The pipeline's state now; a new budget month lifts budget pauses first. */
async function pipelineStateIn(tx: Tx, siteId: string, now: Date = new Date()): Promise<PipelineState> {
  await liftEndedBudgetPauses(tx, siteId, now);
  const pauses = await tx
    .select()
    .from(aiPipelinePauses)
    .where(and(eq(aiPipelinePauses.siteId, siteId), isNull(aiPipelinePauses.liftedAt)))
    .orderBy(desc(aiPipelinePauses.createdAt));
  const [freeze] = await tx
    .select({ id: agentFreezes.id })
    .from(agentFreezes)
    .where(and(eq(agentFreezes.siteId, siteId), eq(agentFreezes.scope, 'site'), isNull(agentFreezes.liftedAt)))
    .limit(1);
  const reasons: PipelineBlock[] = [...new Set(pauses.map((p) => p.reason as AiPipelinePauseReason))];
  if (freeze) reasons.push('kill_switch');
  return { paused: reasons.length > 0, reasons, pauses };
}

/** Throws `PipelinePausedError` when no new production may start on the site. */
export async function assertPipelineRunnable(tx: Tx, siteId: string, now: Date = new Date()): Promise<void> {
  const state = await pipelineStateIn(tx, siteId, now);
  if (state.paused) throw new PipelinePausedError(state.reasons);
}

/** Site administrators pause and resume the pipeline. */
export class PipelineControlService {
  constructor(private readonly deps: { db: Database; siteId: string; userId: string | null; now?: () => Date }) {}

  private tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return runSiteTransaction(this.deps.db, this.deps.siteId, fn);
  }

  state(): Promise<PipelineState> {
    return this.tx((tx) => pipelineStateIn(tx, this.deps.siteId, this.deps.now?.() ?? new Date()));
  }

  /** A person's pause (`manual` / `incident`); pausing again for the same reason changes nothing. */
  async pause(reason: 'manual' | 'incident', note?: string): Promise<PipelineState> {
    const { siteId, userId } = this.deps;
    return this.tx(async (tx) => {
      const created = await tx
        .insert(aiPipelinePauses)
        .values({ siteId, reason, note: note ?? null, createdBy: userId })
        .onConflictDoNothing()
        .returning({ id: aiPipelinePauses.id });
      if (created.length) {
        await new AuditLogger({ db: tx as unknown as Database, siteId }).writeInTransaction(tx, {
          siteId,
          event: 'ai_pipeline_paused',
          metadata: { reason, by: userId },
        });
      }
      return pipelineStateIn(tx, siteId, this.deps.now?.() ?? new Date());
    });
  }

  /** Lift one reason (a person may lift a budget pause too, e.g. after raising the budget). The kill switch is lifted where it was set. */
  async resume(reason: AiPipelinePauseReason): Promise<PipelineState> {
    const { siteId, userId } = this.deps;
    const now = this.deps.now?.() ?? new Date();
    return this.tx(async (tx) => {
      const lifted = await tx
        .update(aiPipelinePauses)
        .set({ liftedAt: now, liftedBy: userId ?? 'unknown' })
        .where(and(eq(aiPipelinePauses.siteId, siteId), eq(aiPipelinePauses.reason, reason), isNull(aiPipelinePauses.liftedAt)))
        .returning({ id: aiPipelinePauses.id });
      if (lifted.length) {
        await new AuditLogger({ db: tx as unknown as Database, siteId }).writeInTransaction(tx, {
          siteId,
          event: 'ai_pipeline_resumed',
          metadata: { reason, by: userId },
        });
      }
      return pipelineStateIn(tx, siteId, now);
    });
  }
}

/** For callers outside a transaction. */
export function pipelineState(db: Database, siteId: string, now: Date = new Date()): Promise<PipelineState> {
  return runSiteTransaction(db, siteId, (tx) => pipelineStateIn(tx, siteId, now));
}
