import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { batchPlanApprovals, batchPlanItems, batchPlans, policies, rolePolicies, roles, users, userSites, type Database } from '@heopress/database';
import { readApprovalMode, type ApprovalMode } from '../flow-drafts/flow-draft-service';
import { recordSystemEvent } from '../ops/system-events';
import type { AgentAccessService } from '../agent-access/agent-access-service';
import { toolByName, type ToolGroup } from '../agent-access/mcp-tool-catalog';
import type { Dispatch, DispatchRequest } from '../agent-access/mcp-tool-runner';
import { canarySites, itemProblems, MAX_PLAN_SITES, PLAN_OPERATIONS, planHash, requiredApprovals, tierFor, type RiskTier } from './plan-rules';

/**
 * Batch operation plans (HeoPress P10 tasks 3.1–3.4; spec agents/batch-operations; ADR-0012;
 * docs/zh-CN/agents/batch-plans.md).
 *
 * Lifecycle: an agent submits (`plans_submit`) → `pending_approval` → a **person in Studio** approves → `approved`
 * (solo mode's highest tier first sits in `cooling_off` for 10 minutes, cancellable) → a person runs it: canary sites
 * first when the tier needs them → `canary_review` → a person confirms the canary results → the rest → `completed`.
 * `cancelled`, `rejected` and `expired` are final.
 *
 * Invariants:
 * - nothing here approves for an agent channel: every decision takes a person signed in to Studio (the route makes
 *   sure) and there is no MCP tool for it;
 * - an approval counts only for the plan hash it was given; the hash is recomputed from the stored rows before every
 *   approval and run, so a revision (or any change at all) leaves the plan unapproved;
 * - team mode: the approver is not the drafter; the highest tier needs a second approver, not the first;
 *   solo mode: the drafter may approve with a current authenticator code;
 * - the executor re-checks, before each site, the authorization (live, covering the site and the tool group) and the
 *   drafter's membership, then runs the call as the drafter through the REST API (live RBAC, holds, version checks);
 *   one site's failure never affects another's result;
 * - each site runs at most once per attempt: it is claimed atomically, and only while the run that claims it is the
 *   plan's current run; a second run request while one is in progress is refused;
 * - cancelling stops the sites not yet started and keeps every result already recorded.
 */

export type PlanRow = typeof batchPlans.$inferSelect;
export type PlanItemRow = typeof batchPlanItems.$inferSelect;
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export const PLAN_TTL_MS = 72 * 3600_000;
export const COOLING_OFF_MS = 10 * 60_000;

export class PlanError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 410 | 422 = 400,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'PlanError';
  }
}

/** Who submits: the token's person and authorization (an API key cannot draft a plan). */
export interface PlanDrafter {
  userId: string;
  grantId: string | null;
  via: 'oauth' | 'pat';
}

export interface PlanInput {
  operation: string;
  arguments?: Record<string, unknown>;
  perSite?: Record<string, Record<string, unknown>>;
  siteIds: string[];
  scopeKind: 'siteIds' | 'instance';
}

export interface PlanServiceDeps {
  db: Database;
  access: Pick<AgentAccessService, 'liveSites' | 'liveGrantScope'>;
  /** The REST API as `userId` (through `grantId`), in a site's scope. */
  dispatchAs: (userId: string, grantId: string | null) => Dispatch;
  verifySecondFactor?: (userId: string, code: string) => Promise<boolean>;
  approvalMode?: () => Promise<ApprovalMode>;
  now?: () => Date;
}

export interface PlanView {
  plan: PlanRow;
  items: PlanItemRow[];
  approvals: Array<{ approverId: string; approverEmail: string | null; verification: string; createdAt: Date; current: boolean }>;
  approvalsCurrent: number;
  drafterEmail: string | null;
}

const TERMINAL = new Set(['completed', 'cancelled', 'rejected', 'expired']);
const IDENTITY_FREE = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export class PlanService {
  constructor(private readonly deps: PlanServiceDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.deps.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.agent_access', 'on', true)`);
      return fn(tx);
    });
  }

  private event(event: string, actor: string | null, data: Record<string, unknown>, level: 'info' | 'warn' = 'info'): Promise<void> {
    return recordSystemEvent(this.deps.db, { level, source: 'agents', event, message: event.replace(/_/g, ' '), actor, data }).then(() => undefined);
  }

  // ── building ────────────────────────────────────────────────────────

  private build(input: PlanInput): { tierInfo: ReturnType<typeof tierFor>; items: Array<{ siteId: string; arguments: Record<string, unknown>; canary: boolean }>; shared: Record<string, unknown> } {
    if (!PLAN_OPERATIONS[input.operation]) {
      throw new PlanError('INVALID_OPERATION', `"${input.operation}" cannot run in a plan. Plan operations: ${Object.keys(PLAN_OPERATIONS).join(', ')}.`, 422);
    }
    const siteIds = [...new Set(input.siteIds)].sort();
    if (!siteIds.length) throw new PlanError('SCOPE_REQUIRED', 'A plan needs at least one site.', 422);
    if (siteIds.length > MAX_PLAN_SITES) throw new PlanError('TOO_MANY_SITES', `A plan covers at most ${MAX_PLAN_SITES} sites.`, 422);
    const shared = IDENTITY_FREE(input.arguments) ? { ...input.arguments } : {};
    delete shared.siteId;
    const perSite = IDENTITY_FREE(input.perSite) ? input.perSite : {};
    const unknownSites = Object.keys(perSite).filter((s) => !siteIds.includes(s));
    if (unknownSites.length) throw new PlanError('PER_SITE_OUTSIDE_SCOPE', `perSite names sites outside the plan: ${unknownSites.join(', ')}.`, 422);
    const tierInfo = tierFor(input.operation, siteIds.length);
    const canaries = new Set(canarySites(siteIds, tierInfo.canaryCount));
    const problems: Record<string, string[]> = {};
    const items = siteIds.map((siteId) => {
      const own = IDENTITY_FREE(perSite[siteId]) ? { ...perSite[siteId] } : {};
      delete own.siteId;
      const merged = { ...shared, ...own };
      const p = itemProblems(input.operation, merged);
      if (p.length) problems[siteId] = p;
      return { siteId, arguments: own, canary: canaries.has(siteId) };
    });
    if (Object.keys(problems).length) {
      throw new PlanError('INVALID_ARGUMENTS', 'Some sites lack required arguments (each change to an existing resource needs its expected version).', 422, { problems });
    }
    return { tierInfo, items, shared };
  }

  /** Submit a plan for the token's person; the scope is the fixed, already authorized site list. */
  async submit(drafter: PlanDrafter, input: PlanInput, scopeSummary: string): Promise<PlanView> {
    const { tierInfo, items, shared } = this.build(input);
    const mode = await (this.deps.approvalMode?.() ?? readApprovalMode(this.deps.db));
    const now = this.now();
    const id = nanoid();
    const expiresAt = new Date(now.getTime() + PLAN_TTL_MS);
    const hash = planHash({
      id,
      operation: input.operation,
      arguments: shared,
      items,
      draftedBy: drafter.userId,
      grantId: drafter.grantId,
      revision: 1,
      riskTier: tierInfo.tier,
      approvalMode: mode,
      expiresAt,
    });
    await this.tx(async (tx) => {
      await tx.insert(batchPlans).values({
        id,
        operation: input.operation,
        arguments: shared,
        scopeKind: input.scopeKind,
        scopeSummary,
        siteCount: items.length,
        riskTier: tierInfo.tier,
        highRisk: tierInfo.highRisk,
        requiresPreview: tierInfo.requiresPreview,
        requiresCanary: tierInfo.requiresCanary,
        approvalMode: mode,
        requiredApprovals: requiredApprovals(mode, tierInfo.tier),
        planHash: hash,
        draftedBy: drafter.userId,
        draftedVia: drafter.via,
        grantId: drafter.grantId,
        expiresAt,
        createdAt: now,
        updatedAt: now,
      });
      await tx.insert(batchPlanItems).values(items.map((it, position) => ({ planId: id, siteId: it.siteId, position, canary: it.canary, arguments: it.arguments })));
    });
    await this.event('agent_plan_submitted', drafter.userId, { planId: id, operation: input.operation, sites: items.length, tier: tierInfo.tier, approvalMode: mode });
    return this.view(id);
  }

  /**
   * The drafter's agent changes a plan that has not started: new sites, arguments or per-site versions. The revision
   * and hash change; every earlier approval stops counting and the plan waits for approval again.
   */
  async revise(drafter: PlanDrafter, planId: string, change: { siteIds?: string[]; arguments?: Record<string, unknown>; perSite?: Record<string, Record<string, unknown>> }): Promise<PlanView> {
    const before = await this.view(planId);
    if (before.plan.draftedBy !== drafter.userId) throw new PlanError('PLAN_NOT_FOUND', 'No such plan for this caller.', 404);
    const p = before.plan;
    if (!['pending_approval', 'cooling_off', 'approved'].includes(p.status) || before.items.some((i) => i.status !== 'pending' || i.attempts > 0)) {
      throw new PlanError('PLAN_NOT_REVISABLE', `A ${p.status} plan, or one that has started, cannot be revised; submit a new plan.`, 409);
    }
    const oldPerSite = Object.fromEntries(before.items.map((i) => [i.siteId, i.arguments]));
    const siteIds = change.siteIds ?? before.items.map((i) => i.siteId);
    const input: PlanInput = {
      operation: p.operation,
      arguments: change.arguments ?? p.arguments,
      perSite: change.perSite ?? Object.fromEntries(Object.entries(oldPerSite).filter(([s]) => siteIds.includes(s))),
      siteIds,
      scopeKind: change.siteIds ? 'siteIds' : (p.scopeKind as 'siteIds' | 'instance'),
    };
    const { tierInfo, items, shared } = this.build(input);
    const now = this.now();
    const revision = p.revision + 1;
    const hash = planHash({
      id: p.id,
      operation: p.operation,
      arguments: shared,
      items,
      draftedBy: p.draftedBy,
      grantId: p.grantId,
      revision,
      riskTier: tierInfo.tier,
      approvalMode: p.approvalMode as ApprovalMode,
      expiresAt: p.expiresAt,
    });
    await this.tx(async (tx) => {
      const [locked] = await tx.select().from(batchPlans).where(eq(batchPlans.id, planId)).for('update');
      if (!locked || locked.revision !== p.revision || locked.status !== p.status) throw new PlanError('PLAN_CHANGED', 'The plan changed meanwhile; read it again.', 409);
      // A revision starts from the stored plan: one that no longer matches its hash is not laundered into a new hash.
      if (!(await this.storedHashMatches(tx, locked))) throw new PlanError('PLAN_TAMPERED', 'The stored plan does not match its hash; it cannot be revised.', 409);
      await tx.delete(batchPlanItems).where(eq(batchPlanItems.planId, planId));
      await tx.insert(batchPlanItems).values(items.map((it, position) => ({ planId, siteId: it.siteId, position, canary: it.canary, arguments: it.arguments })));
      await tx
        .update(batchPlans)
        .set({
          arguments: shared,
          scopeKind: input.scopeKind,
          scopeSummary: change.siteIds ? `Revised to exactly these ${items.length} site(s): ${items.map((i) => i.siteId).join(', ')}.` : locked.scopeSummary,
          siteCount: items.length,
          riskTier: tierInfo.tier,
          highRisk: tierInfo.highRisk,
          requiresPreview: tierInfo.requiresPreview,
          requiresCanary: tierInfo.requiresCanary,
          requiredApprovals: requiredApprovals(locked.approvalMode as ApprovalMode, tierInfo.tier),
          planHash: hash,
          revision,
          status: 'pending_approval',
          coolingOffUntil: null,
          approvedAt: null,
          updatedAt: now,
        })
        .where(eq(batchPlans.id, planId));
    });
    await this.event('agent_plan_revised', drafter.userId, { planId, revision, approvalsInvalidated: before.approvalsCurrent, sites: items.length, tier: tierInfo.tier });
    return this.view(planId);
  }

  // ── reading ─────────────────────────────────────────────────────────

  /** The plan with its items and approvals; an expired plan is marked expired on the way. */
  async view(planId: string): Promise<PlanView> {
    await this.expireIfDue(planId);
    return this.tx(async (tx) => {
      const [plan] = await tx.select().from(batchPlans).where(eq(batchPlans.id, planId)).limit(1);
      if (!plan) throw new PlanError('PLAN_NOT_FOUND', 'No such plan.', 404);
      const items = await tx.select().from(batchPlanItems).where(eq(batchPlanItems.planId, planId)).orderBy(asc(batchPlanItems.position));
      const approvals = await tx
        .select({ approverId: batchPlanApprovals.approverId, approverEmail: users.email, verification: batchPlanApprovals.verification, createdAt: batchPlanApprovals.createdAt, planHash: batchPlanApprovals.planHash })
        .from(batchPlanApprovals)
        .leftJoin(users, eq(users.id, batchPlanApprovals.approverId))
        .where(eq(batchPlanApprovals.planId, planId))
        .orderBy(asc(batchPlanApprovals.createdAt));
      const [drafter] = await tx.select({ email: users.email }).from(users).where(eq(users.id, plan.draftedBy)).limit(1);
      const shaped = approvals.map((a) => ({ approverId: a.approverId, approverEmail: a.approverEmail, verification: a.verification, createdAt: a.createdAt, current: a.planHash === plan.planHash }));
      return { plan, items, approvals: shaped, approvalsCurrent: shaped.filter((a) => a.current).length, drafterEmail: drafter?.email ?? null };
    });
  }

  /** Plans a person may see: their own, and those touching a site they belong to (the instance administrator: all). */
  async list(userId: string, status?: string): Promise<PlanRow[]> {
    const bootstrap = await this.isBootstrap(userId);
    return this.tx(async (tx) => {
      const statusCond = status ? eq(batchPlans.status, status) : undefined;
      if (bootstrap) return tx.select().from(batchPlans).where(statusCond).orderBy(desc(batchPlans.createdAt)).limit(200);
      const memberSites = (await tx.select({ siteId: userSites.siteId }).from(userSites).where(eq(userSites.userId, userId))).map((r) => r.siteId);
      const touching = memberSites.length
        ? tx.select({ planId: batchPlanItems.planId }).from(batchPlanItems).where(inArray(batchPlanItems.siteId, memberSites))
        : null;
      return tx
        .select()
        .from(batchPlans)
        .where(and(statusCond, touching ? or(eq(batchPlans.draftedBy, userId), inArray(batchPlans.id, touching)) : eq(batchPlans.draftedBy, userId)))
        .orderBy(desc(batchPlans.createdAt))
        .limit(200);
    });
  }

  /** A person may see a plan they drafted, or one touching a site they belong to. */
  async canView(userId: string, view: PlanView): Promise<boolean> {
    if (view.plan.draftedBy === userId || (await this.isBootstrap(userId))) return true;
    const live = await this.deps.access.liveSites(userId, view.items.map((i) => i.siteId));
    return live.length > 0;
  }

  private async isBootstrap(userId: string): Promise<boolean> {
    const [u] = await this.deps.db.select({ isBootstrap: users.isBootstrap, status: users.status }).from(users).where(eq(users.id, userId)).limit(1);
    return !!u?.isBootstrap && u.status === 'active';
  }

  /** May `userId` decide this plan: the instance administrator, or an administrator of every target site. */
  async isEligibleApprover(userId: string, siteIds: string[]): Promise<boolean> {
    const [u] = await this.deps.db.select({ isBootstrap: users.isBootstrap, status: users.status }).from(users).where(eq(users.id, userId)).limit(1);
    if (!u || u.status !== 'active') return false;
    if (u.isBootstrap) return true;
    const rows = await this.deps.db
      .select({ siteId: userSites.siteId, roleAdmin: roles.adminAccess, policyAdmin: sql<boolean>`EXISTS (SELECT 1 FROM ${rolePolicies} rp JOIN ${policies} p ON p.id = rp.policy_id WHERE rp.role_id = ${userSites.roleId} AND p.admin_access)` })
      .from(userSites)
      .innerJoin(roles, eq(roles.id, userSites.roleId))
      .where(and(eq(userSites.userId, userId), inArray(userSites.siteId, siteIds)));
    const adminOf = new Set(rows.filter((r) => r.roleAdmin || r.policyAdmin).map((r) => r.siteId));
    return siteIds.every((s) => adminOf.has(s));
  }

  // ── decisions ───────────────────────────────────────────────────────

  private async expireIfDue(planId: string): Promise<void> {
    const now = this.now();
    await this.tx((tx) =>
      tx
        .update(batchPlans)
        .set({ status: 'expired', updatedAt: now })
        .where(and(eq(batchPlans.id, planId), inArray(batchPlans.status, ['pending_approval', 'cooling_off', 'approved', 'canary_review']), sql`${batchPlans.expiresAt} <= ${now.toISOString()}::timestamptz`)),
    );
  }

  /** The hash recomputed from the stored rows: a plan changed behind the service's back no longer matches. */
  private async storedHashMatches(tx: Tx, plan: PlanRow): Promise<boolean> {
    const items = await tx.select().from(batchPlanItems).where(eq(batchPlanItems.planId, plan.id));
    const hash = planHash({
      id: plan.id,
      operation: plan.operation,
      arguments: plan.arguments,
      items: items.map((i) => ({ siteId: i.siteId, arguments: i.arguments, canary: i.canary })),
      draftedBy: plan.draftedBy,
      grantId: plan.grantId,
      revision: plan.revision,
      riskTier: plan.riskTier as RiskTier,
      approvalMode: plan.approvalMode as ApprovalMode,
      expiresAt: plan.expiresAt,
    });
    return hash === plan.planHash && items.length === plan.siteCount;
  }

  private async currentApprovers(tx: Tx, plan: PlanRow): Promise<string[]> {
    const rows = await tx
      .select({ approverId: batchPlanApprovals.approverId })
      .from(batchPlanApprovals)
      .where(and(eq(batchPlanApprovals.planId, plan.id), eq(batchPlanApprovals.planHash, plan.planHash)));
    return [...new Set(rows.map((r) => r.approverId))];
  }

  private async lockOpen(tx: Tx, planId: string): Promise<PlanRow> {
    const [plan] = await tx.select().from(batchPlans).where(eq(batchPlans.id, planId)).for('update');
    if (!plan) throw new PlanError('PLAN_NOT_FOUND', 'No such plan.', 404);
    if (plan.expiresAt <= this.now() && !TERMINAL.has(plan.status) && plan.status !== 'running') {
      throw new PlanError('PLAN_EXPIRED', 'The plan has expired; ask the agent to submit it again.', 410);
    }
    return plan;
  }

  /**
   * A person approves (the route admits only a Studio session). Team: not the drafter, and a second approval must
   * come from someone else. Solo: the drafter needs a current authenticator code. Highest tier in solo mode starts a
   * 10-minute cooling-off period.
   */
  async approve(planId: string, userId: string, input: { secondFactor?: string; planHash?: string } = {}): Promise<PlanView> {
    const before = await this.view(planId);
    const plan = before.plan;
    if (plan.status === 'expired') throw new PlanError('PLAN_EXPIRED', 'The plan has expired; ask the agent to submit it again.', 410);
    if (plan.status !== 'pending_approval') throw new PlanError('NOT_PENDING', `The plan is ${plan.status}.`, 409);
    if (input.planHash && input.planHash !== plan.planHash) throw new PlanError('PLAN_CHANGED', 'The plan changed after you opened it; review it again.', 409);
    if (!(await this.isEligibleApprover(userId, before.items.map((i) => i.siteId)))) {
      throw new PlanError('NOT_ELIGIBLE', 'Approving needs administrator access to every site of the plan.', 403);
    }
    let verification: 'totp' | 'none' = 'none';
    if (plan.draftedBy === userId) {
      if (plan.approvalMode === 'team') throw new PlanError('SELF_APPROVAL', 'In team mode the approver must be someone other than the person the plan was drafted for.', 403);
      const code = input.secondFactor?.trim();
      if (!code || !this.deps.verifySecondFactor || !(await this.deps.verifySecondFactor(userId, code))) {
        throw new PlanError('SECOND_FACTOR_REQUIRED', 'Approving your own plan needs a second factor: enter a current authenticator code.', 403);
      }
      verification = 'totp';
    }
    const now = this.now();
    await this.tx(async (tx) => {
      const locked = await this.lockOpen(tx, planId);
      if (locked.status !== 'pending_approval' || locked.planHash !== plan.planHash) throw new PlanError('PLAN_CHANGED', 'The plan changed meanwhile; review it again.', 409);
      if (!(await this.storedHashMatches(tx, locked))) throw new PlanError('PLAN_TAMPERED', 'The stored plan does not match its hash; it cannot be approved.', 409);
      const approvers = await this.currentApprovers(tx, locked);
      if (approvers.includes(userId)) throw new PlanError('SAME_APPROVER', 'The second approval must come from a different person.', 403);
      await tx.insert(batchPlanApprovals).values({ planId, planHash: locked.planHash, approverId: userId, verification, createdAt: now });
      if (approvers.length + 1 < locked.requiredApprovals) return;
      const cooling = locked.approvalMode === 'solo' && locked.riskTier === 'highest';
      await tx
        .update(batchPlans)
        .set({ status: cooling ? 'cooling_off' : 'approved', coolingOffUntil: cooling ? new Date(now.getTime() + COOLING_OFF_MS) : null, approvedAt: now, updatedAt: now })
        .where(eq(batchPlans.id, planId));
    });
    await this.event('agent_plan_approved', userId, { planId, planHash: plan.planHash, verification, approvalMode: plan.approvalMode, tier: plan.riskTier });
    return this.view(planId);
  }

  async reject(planId: string, userId: string, reason: string): Promise<PlanView> {
    const before = await this.view(planId);
    if (!(await this.isEligibleApprover(userId, before.items.map((i) => i.siteId))) && before.plan.draftedBy !== userId) {
      throw new PlanError('NOT_ELIGIBLE', 'Rejecting needs administrator access to every site of the plan.', 403);
    }
    await this.tx(async (tx) => {
      const locked = await this.lockOpen(tx, planId);
      if (!['pending_approval', 'cooling_off'].includes(locked.status)) throw new PlanError('NOT_PENDING', `The plan is ${locked.status}.`, 409);
      const now = this.now();
      await tx.update(batchPlans).set({ status: 'rejected', decidedBy: userId, decidedAt: now, decisionReason: reason.trim(), updatedAt: now }).where(eq(batchPlans.id, planId));
      await tx.update(batchPlanItems).set({ status: 'cancelled', finishedAt: now }).where(and(eq(batchPlanItems.planId, planId), eq(batchPlanItems.status, 'pending')));
    });
    await this.event('agent_plan_rejected', userId, { planId, reason: reason.trim() });
    return this.view(planId);
  }

  /** Cancel: the sites not started are cancelled, results already recorded are kept. Also ends a cooling-off. */
  async cancel(planId: string, userId: string, reason: string): Promise<PlanView> {
    const before = await this.view(planId);
    if (before.plan.draftedBy !== userId && !(await this.isEligibleApprover(userId, before.items.map((i) => i.siteId)))) {
      throw new PlanError('NOT_ELIGIBLE', 'Only the drafter or an administrator of every site of the plan can cancel it.', 403);
    }
    await this.tx(async (tx) => {
      const [locked] = await tx.select().from(batchPlans).where(eq(batchPlans.id, planId)).for('update');
      if (!locked) throw new PlanError('PLAN_NOT_FOUND', 'No such plan.', 404);
      if (TERMINAL.has(locked.status)) throw new PlanError('NOT_CANCELLABLE', `The plan is already ${locked.status}.`, 409);
      const now = this.now();
      await tx
        .update(batchPlans)
        .set({ status: 'cancelled', decidedBy: userId, decidedAt: now, decisionReason: reason.trim() || null, executionId: null, updatedAt: now })
        .where(eq(batchPlans.id, planId));
      await tx.update(batchPlanItems).set({ status: 'cancelled', finishedAt: now }).where(and(eq(batchPlanItems.planId, planId), eq(batchPlanItems.status, 'pending')));
    });
    await this.event('agent_plan_cancelled', userId, { planId, from: before.plan.status, reason: reason.trim() });
    return this.view(planId);
  }

  /** A person confirms the canary results (all canary sites succeeded); the rest of the plan may then run. */
  async confirmCanary(planId: string, userId: string): Promise<PlanView> {
    const before = await this.view(planId);
    if (!(await this.isEligibleApprover(userId, before.items.map((i) => i.siteId)))) {
      throw new PlanError('NOT_ELIGIBLE', 'Confirming canary results needs administrator access to every site of the plan.', 403);
    }
    await this.tx(async (tx) => {
      const locked = await this.lockOpen(tx, planId);
      if (locked.status !== 'canary_review') throw new PlanError('NOT_IN_CANARY_REVIEW', `The plan is ${locked.status}.`, 409);
      const canaries = await tx.select().from(batchPlanItems).where(and(eq(batchPlanItems.planId, planId), eq(batchPlanItems.canary, true)));
      if (!canaries.length || canaries.some((i) => i.status !== 'succeeded')) {
        throw new PlanError('CANARY_NOT_SUCCEEDED', 'Every canary site must have succeeded before the rest runs; retry them or cancel the plan.', 409);
      }
      const now = this.now();
      await tx.update(batchPlans).set({ status: 'approved', canaryConfirmedBy: userId, canaryConfirmedAt: now, updatedAt: now }).where(eq(batchPlans.id, planId));
    });
    await this.event('agent_plan_canary_confirmed', userId, { planId });
    return this.view(planId);
  }

  /** Retry the sites that failed for a transient reason (not conflicts: those need a revised plan). */
  async retry(planId: string, userId: string): Promise<PlanView> {
    const before = await this.view(planId);
    if (!(await this.isEligibleApprover(userId, before.items.map((i) => i.siteId))) && before.plan.draftedBy !== userId) {
      throw new PlanError('NOT_ELIGIBLE', 'Only the drafter or an administrator of every site of the plan can retry it.', 403);
    }
    let retried = 0;
    await this.tx(async (tx) => {
      const locked = await this.lockOpen(tx, planId);
      if (!['completed', 'canary_review'].includes(locked.status)) throw new PlanError('NOT_RETRYABLE', `The plan is ${locked.status}.`, 409);
      if (locked.expiresAt <= this.now()) throw new PlanError('PLAN_EXPIRED', 'The plan has expired.', 410);
      const reset = await tx
        .update(batchPlanItems)
        .set({ status: 'pending', result: null, startedAt: null, finishedAt: null })
        .where(and(eq(batchPlanItems.planId, planId), eq(batchPlanItems.status, 'failed')))
        .returning({ siteId: batchPlanItems.siteId });
      retried = reset.length;
      if (!retried) throw new PlanError('NOTHING_TO_RETRY', 'No site failed for a reason a retry could fix.', 409);
      await tx.update(batchPlans).set({ status: 'approved', completedAt: null, updatedAt: this.now() }).where(eq(batchPlans.id, planId));
    });
    await this.event('agent_plan_retry', userId, { planId, sites: retried });
    return this.view(planId);
  }

  // ── execution ───────────────────────────────────────────────────────

  /**
   * Run the next phase: the canary sites when the tier needs them and they have not been confirmed, otherwise the
   * remaining sites. Refused while cooling off, expired, without current approvals, or while another run is going.
   */
  async execute(planId: string, userId: string): Promise<PlanView> {
    const before = await this.view(planId);
    if (before.plan.draftedBy !== userId && !(await this.isEligibleApprover(userId, before.items.map((i) => i.siteId)))) {
      throw new PlanError('NOT_ELIGIBLE', 'Only the drafter or an administrator of every site of the plan can run it.', 403);
    }
    const executionId = nanoid();
    const now = this.now();
    const phase = await this.tx(async (tx) => {
      const locked = await this.lockOpen(tx, planId);
      if (locked.status === 'running') throw new PlanError('PLAN_ALREADY_RUNNING', 'The plan is already running; each site runs at most once.', 409);
      if (locked.status === 'cooling_off') {
        if (locked.coolingOffUntil && locked.coolingOffUntil > now) {
          throw new PlanError('COOLING_OFF', `The plan is in its cooling-off period until ${locked.coolingOffUntil.toISOString()}; it can still be cancelled.`, 409);
        }
      } else if (locked.status !== 'approved') {
        throw new PlanError('NOT_APPROVED', `The plan is ${locked.status}.`, 409);
      }
      if (!(await this.storedHashMatches(tx, locked))) throw new PlanError('PLAN_TAMPERED', 'The stored plan does not match its approved hash; it will not run.', 409);
      const approvers = await this.currentApprovers(tx, locked);
      if (approvers.length < locked.requiredApprovals) throw new PlanError('APPROVAL_INVALID', 'The plan changed since it was approved; it needs approval again.', 409);
      const canaryPhase = locked.requiresCanary && !locked.canaryConfirmedAt;
      await tx.update(batchPlans).set({ status: 'running', executionId, executionStartedAt: now, updatedAt: now }).where(eq(batchPlans.id, planId));
      return canaryPhase ? 'canary' : 'rest';
    });
    await this.event('agent_plan_run_started', userId, { planId, phase, executionId });

    const plan = before.plan;
    const items = (await this.view(planId)).items.filter((i) => i.status === 'pending' && (phase === 'canary' ? i.canary : !i.canary));
    const grant = plan.grantId ? await this.deps.access.liveGrantScope(plan.grantId) : null;
    const group = toolByName(plan.operation)?.group ?? 'read';
    for (const item of items) {
      const claimed = await this.tx((tx) =>
        tx
          .update(batchPlanItems)
          .set({ status: 'running', startedAt: this.now(), attempts: sql`${batchPlanItems.attempts} + 1` })
          .where(
            and(
              eq(batchPlanItems.planId, planId),
              eq(batchPlanItems.siteId, item.siteId),
              eq(batchPlanItems.status, 'pending'),
              sql`EXISTS (SELECT 1 FROM ${batchPlans} WHERE ${batchPlans.id} = ${planId} AND ${batchPlans.status} = 'running' AND ${batchPlans.executionId} = ${executionId})`,
            ),
          )
          .returning({ siteId: batchPlanItems.siteId }),
      );
      if (!claimed.length) continue;
      let outcome: { status: PlanItemRow['status']; result: Record<string, unknown> };
      try {
        outcome = await this.runItem(plan, item, grant, group);
      } catch (err) {
        outcome = { status: 'failed', result: { code: 'INTERNAL', message: err instanceof Error ? err.message.slice(0, 300) : 'Unexpected error.' } };
      }
      await this.tx((tx) =>
        tx
          .update(batchPlanItems)
          .set({ status: outcome.status, result: outcome.result, finishedAt: this.now() })
          .where(and(eq(batchPlanItems.planId, planId), eq(batchPlanItems.siteId, item.siteId), eq(batchPlanItems.status, 'running'))),
      );
    }

    await this.tx(async (tx) => {
      const [locked] = await tx.select().from(batchPlans).where(eq(batchPlans.id, planId)).for('update');
      if (!locked || locked.status !== 'running' || locked.executionId !== executionId) return;
      const done = this.now();
      if (phase === 'canary') {
        await tx.update(batchPlans).set({ status: 'canary_review', executionId: null, updatedAt: done }).where(eq(batchPlans.id, planId));
      } else {
        await tx.update(batchPlans).set({ status: 'completed', executionId: null, completedAt: done, updatedAt: done }).where(eq(batchPlans.id, planId));
      }
    });
    const after = await this.view(planId);
    await this.event('agent_plan_run_finished', userId, {
      planId,
      phase,
      status: after.plan.status,
      results: Object.fromEntries(['succeeded', 'conflict', 'forbidden', 'failed', 'cancelled'].map((s) => [s, after.items.filter((i) => i.status === s).length])),
    });
    return after;
  }

  /** One site: re-check the authorization and membership, then the call as the drafter; the answer becomes the result. */
  private async runItem(
    plan: PlanRow,
    item: PlanItemRow,
    grant: { siteIds: string[]; toolGroups: ToolGroup[] } | null,
    group: ToolGroup,
  ): Promise<{ status: PlanItemRow['status']; result: Record<string, unknown> }> {
    const forbidden = (code: string, message: string) => ({ status: 'forbidden' as const, result: { code, message } });
    if (!grant) return forbidden('AUTHORIZATION_REVOKED', 'The authorization the plan was submitted under is revoked or expired.');
    if (!grant.siteIds.includes(item.siteId)) return forbidden('SITE_NOT_AUTHORIZED', 'The authorization no longer covers this site.');
    if (!grant.toolGroups.includes(group)) return forbidden('TOOL_GROUP_NOT_GRANTED', `The authorization no longer includes the "${group}" tool group.`);
    if (!(await this.deps.access.liveSites(plan.draftedBy, [item.siteId])).length) return forbidden('NOT_A_MEMBER', 'The drafter can no longer reach this site.');
    const dispatch = this.deps.dispatchAs(plan.draftedBy, plan.grantId);
    const args = { ...plan.arguments, ...item.arguments };
    const enc = encodeURIComponent;
    const str = (v: unknown) => (typeof v === 'string' ? v : '');
    const call = async (req: DispatchRequest) => classify(await dispatch(item.siteId, req));
    switch (plan.operation) {
      case 'content_create':
        return call({
          method: 'POST',
          path: `/api/v1/items/${enc(str(args.collection))}`,
          json: { data: args.data, status: 'draft' },
          headers: { 'idempotency-key': `plan-${plan.id}-${item.siteId}` },
        });
      case 'content_update':
        return call({ method: 'PATCH', path: `/api/v1/items/${enc(str(args.collection))}/${enc(str(args.id))}`, json: { data: args.data, expectedVersion: args.expectedVersion } });
      case 'content_publish':
        return call({ method: 'PATCH', path: `/api/v1/items/${enc(str(args.collection))}/${enc(str(args.id))}`, json: { status: 'published', expectedVersion: args.expectedVersion } });
      case 'content_delete': {
        const path = `/api/v1/items/${enc(str(args.collection))}/${enc(str(args.id))}`;
        const current = await dispatch(item.siteId, { method: 'GET', path });
        if (current.status !== 200) return classify(current);
        const version = (current.body as { data?: { version?: unknown } } | null)?.data?.version;
        if (version !== args.expectedVersion) {
          return { status: 'conflict', result: { code: 'VERSION_CONFLICT', message: `The item is at version ${String(version)}, the plan expected ${String(args.expectedVersion)}.`, currentVersion: version } };
        }
        return call({ method: 'DELETE', path });
      }
      case 'site_update_seo_settings':
        return call({ method: 'PUT', path: '/api/v1/site/seo-settings', json: { ...(args.settings as Record<string, unknown>), version: args.expectedVersion } });
      case 'theme_activate': {
        const list = await dispatch(item.siteId, { method: 'GET', path: '/api/v1/themes' });
        if (list.status !== 200) return classify(list);
        const versions = ((list.body as { data?: unknown } | null)?.data ?? []) as Array<{ id?: string; active?: boolean }>;
        const active = (Array.isArray(versions) ? versions : []).find((v) => v.active)?.id ?? null;
        if (active !== args.expectedActiveVersionId) {
          return { status: 'conflict', result: { code: 'VERSION_CONFLICT', message: 'The active theme changed since the plan was made.', currentActiveVersionId: active } };
        }
        return call({ method: 'POST', path: `/api/v1/themes/versions/${enc(str(args.themeVersionId))}/activate` });
      }
      default:
        return { status: 'failed', result: { code: 'INVALID_OPERATION', message: `"${plan.operation}" cannot run in a plan.` } };
    }
  }
}

/** A REST answer as a site result: 2xx succeeded, 409/412 conflict, 401/403 forbidden, anything else failed. */
function classify(res: { status: number; body: unknown }): { status: PlanItemRow['status']; result: Record<string, unknown> } {
  const body = res.body && typeof res.body === 'object' ? (res.body as Record<string, unknown>) : {};
  const first = Array.isArray(body.errors) && body.errors[0] && typeof body.errors[0] === 'object' ? (body.errors[0] as Record<string, unknown>) : null;
  const code = typeof first?.code === 'string' ? first.code : `HTTP_${res.status}`;
  const message = typeof first?.message === 'string' ? first.message : `Request answered ${res.status}.`;
  if (res.status >= 200 && res.status < 300) {
    const data = body.data && typeof body.data === 'object' ? (body.data as Record<string, unknown>) : null;
    return { status: 'succeeded', result: { httpStatus: res.status, ...(data?.id !== undefined ? { id: data.id } : {}), ...(data?.version !== undefined ? { version: data.version } : {}) } };
  }
  if (res.status === 409 || res.status === 412) return { status: 'conflict', result: { code, message, httpStatus: res.status } };
  if (res.status === 401 || res.status === 403) return { status: 'forbidden', result: { code, message, httpStatus: res.status } };
  return { status: 'failed', result: { code, message, httpStatus: res.status } };
}
