import { and, desc, eq } from 'drizzle-orm';
import { validateGraph, type FlowGraph } from '@heopress/contracts';
import { apiKeys, flowDrafts, systemState, type Database } from '@heopress/database';
import { AuditLogger } from '../../modules/audit/logger';
import { listOperations } from '../flow-service';
import { createFlowRecord, cronCheckForSave, flowSchema } from '../flow-management';
import { runSiteTransaction } from '../rls-transaction';

/**
 * Agent-drafted flow definitions (HeoPress P09 task 5.1; spec ai/flow-authoring; ADR-0012).
 *
 * An agent submits a draft through its `draftFlow` tool (or the REST route with its API key). The draft is checked at
 * once — shape, registered operation types only, a graph and trigger that could run — and an invalid one is refused
 * with every problem (an unknown operation is named). A valid one waits as `pending` until a **person** approves it in
 * Studio; only then is the flow created and enabled. Approval follows the instance approval mode:
 *
 *   - every mode: an agent channel (API key, MCP, Agent API) can never approve or reject;
 *   - `team`: the approver must not be the person the draft was drafted for (403);
 *   - `solo`: that person may approve, but only with a second factor (a TOTP code checked now; 403 without it).
 *
 * The mode in force when the draft was submitted applies to it (ADR-0012: a switch applies to later drafts).
 */

export type ApprovalMode = 'solo' | 'team';
export type FlowDraftRow = typeof flowDrafts.$inferSelect;

export class FlowDraftError extends Error {
  constructor(
    readonly code: 'VALIDATION' | 'NOT_FOUND' | 'FORBIDDEN' | 'SELF_APPROVAL' | 'SECOND_FACTOR_REQUIRED' | 'NOT_PENDING',
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 422 = 400,
    readonly errors: Array<{ code: string; message: string; nodeId?: string }> = [],
  ) {
    super(message);
    this.name = 'FlowDraftError';
  }
}

/** Who acts, and through which channel. An API key is always the agent channel. */
export interface DraftActor {
  userId: string | null;
  apiKeyId: string | null;
}

export interface FlowDraftDeps {
  db: Database;
  siteId: string;
  /** Checks a TOTP code of a user now (the existing MFA, ADR-0012); false when not enrolled or wrong. */
  verifySecondFactor?: (userId: string, code: string) => Promise<boolean>;
  /** Test seam: the instance approval mode (default: read from the system state). */
  approvalMode?: () => Promise<ApprovalMode>;
  now?: () => Date;
}

export async function readApprovalMode(db: Pick<Database, 'select'>): Promise<ApprovalMode> {
  const [row] = await db.select({ mode: systemState.approvalMode }).from(systemState).where(eq(systemState.id, 'singleton'));
  return row?.mode === 'team' ? 'team' : 'solo';
}

/** Problems of a draft, or none: shape, operation types, graph, trigger — as an enabled flow would need. */
function validateFlowDraft(raw: unknown): { ok: true; value: ReturnType<typeof flowSchema.parse> } | { ok: false; errors: Array<{ code: string; message: string; nodeId?: string }> } {
  const parsed = flowSchema.safeParse({ ...(raw && typeof raw === 'object' ? raw : {}), status: 'active' });
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: `${i.path.join('.') || 'draft'}: ${i.message}` })) };
  const known = listOperations().map((o) => o.key);
  const errors: Array<{ code: string; message: string; nodeId?: string }> = [];
  if (!parsed.data.graph.nodes.length) errors.push({ code: 'EMPTY_GRAPH', message: 'A flow needs at least one operation.' });
  for (const e of validateGraph(parsed.data.graph as FlowGraph, known).errors) errors.push({ ...e, code: e.code === 'UNKNOWN_OPERATION' ? 'UNKNOWN_OPERATION' : `GRAPH_${e.code}` });
  const cron = cronCheckForSave(parsed.data.triggerType, 'active', parsed.data.triggerOptions);
  if (cron.error) errors.push(cron.error);
  return errors.length ? { ok: false, errors } : { ok: true, value: parsed.data };
}

export class FlowDraftService {
  constructor(private readonly deps: FlowDraftDeps) {}

  private get siteId() {
    return this.deps.siteId;
  }
  private now() {
    return this.deps.now?.() ?? new Date();
  }
  private tx<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
    return runSiteTransaction(this.deps.db, this.siteId, (tx) => fn(tx as unknown as Database));
  }
  private audit(tx: Database, event: string, metadata: Record<string, unknown>) {
    return new AuditLogger({ db: tx, siteId: this.siteId }).writeInTransaction(tx, { siteId: this.siteId, event, metadata });
  }

  /** Submit a draft. Invalid → `VALIDATION` (422) listing every problem; nothing is stored. */
  async submit(raw: unknown, actor: DraftActor, channel: 'agent' | 'studio' = actor.apiKeyId ? 'agent' : 'studio'): Promise<FlowDraftRow> {
    const checked = validateFlowDraft(raw);
    if (!checked.ok) {
      const unknown = checked.errors.filter((e) => e.code === 'UNKNOWN_OPERATION');
      throw new FlowDraftError(
        'VALIDATION',
        unknown.length ? `The draft uses operation types that are not registered: ${unknown.map((e) => e.message).join(' ')}` : 'The flow draft is not valid.',
        422,
        checked.errors,
      );
    }
    const mode = await (this.deps.approvalMode?.() ?? readApprovalMode(this.deps.db));
    return this.tx(async (tx) => {
      // An agent drafts for the person who created its key.
      let draftedBy = actor.apiKeyId ? null : actor.userId;
      if (actor.apiKeyId) {
        const [key] = await tx.select({ createdBy: apiKeys.createdBy }).from(apiKeys).where(eq(apiKeys.id, actor.apiKeyId));
        draftedBy = key?.createdBy ?? actor.userId ?? null;
      }
      const v = checked.value;
      const [row] = await tx
        .insert(flowDrafts)
        .values({
          siteId: this.siteId,
          name: v.name,
          description: v.description ?? null,
          triggerType: v.triggerType,
          triggerOptions: v.triggerOptions,
          graph: v.graph as unknown as Record<string, unknown>,
          draftedBy,
          draftedVia: channel,
          apiKeyId: actor.apiKeyId,
          approvalMode: mode,
        })
        .returning();
      await this.audit(tx, 'flow_draft_submitted', { draftId: row!.id, via: row!.draftedVia, draftedBy, approvalMode: mode, operations: v.graph.nodes.map((n) => n.key) });
      return row!;
    });
  }

  async list(status?: string): Promise<FlowDraftRow[]> {
    return this.tx((tx) =>
      tx
        .select()
        .from(flowDrafts)
        .where(and(eq(flowDrafts.siteId, this.siteId), status ? eq(flowDrafts.status, status) : undefined))
        .orderBy(desc(flowDrafts.createdAt))
        .limit(200),
    );
  }

  async get(id: string): Promise<FlowDraftRow> {
    const [row] = await this.tx((tx) => tx.select().from(flowDrafts).where(and(eq(flowDrafts.siteId, this.siteId), eq(flowDrafts.id, id))));
    if (!row) throw new FlowDraftError('NOT_FOUND', 'No such flow draft.', 404);
    return row;
  }

  /** Who may decide: a person, not an agent; in team mode not the drafter; in solo mode the drafter with a second factor. */
  private async authorize(draft: FlowDraftRow, actor: DraftActor, secondFactor: string | undefined): Promise<'totp' | 'none'> {
    if (actor.apiKeyId || !actor.userId) throw new FlowDraftError('FORBIDDEN', 'Flow drafts are approved by a person in Studio, never through an agent channel.', 403);
    if (draft.draftedBy !== actor.userId) return 'none';
    if (draft.approvalMode === 'team') throw new FlowDraftError('SELF_APPROVAL', 'In team mode the approver must be someone other than the person the flow was drafted for.', 403);
    const code = secondFactor?.trim();
    if (!code || !this.deps.verifySecondFactor || !(await this.deps.verifySecondFactor(actor.userId, code))) {
      throw new FlowDraftError('SECOND_FACTOR_REQUIRED', 'Approving your own flow draft needs a second factor: enter a current authenticator code.', 403);
    }
    return 'totp';
  }

  /** Approve: the flow is created, enabled, from exactly the reviewed draft. */
  async approve(id: string, actor: DraftActor, input: { secondFactor?: string; reason?: string } = {}): Promise<FlowDraftRow> {
    const draft = await this.get(id);
    if (draft.status !== 'pending') throw new FlowDraftError('NOT_PENDING', `The draft is already ${draft.status}.`, 409);
    const verification = await this.authorize(draft, actor, input.secondFactor);
    return this.tx(async (tx) => {
      const [locked] = await tx.select().from(flowDrafts).where(and(eq(flowDrafts.siteId, this.siteId), eq(flowDrafts.id, id))).for('update');
      if (!locked || locked.status !== 'pending') throw new FlowDraftError('NOT_PENDING', 'The draft was decided meanwhile.', 409);
      const flow = await createFlowRecord(tx, this.siteId, {
        name: locked.name,
        description: locked.description ?? undefined,
        status: 'active',
        triggerType: locked.triggerType,
        triggerOptions: locked.triggerOptions,
        graph: locked.graph,
      });
      const [row] = await tx
        .update(flowDrafts)
        .set({ status: 'approved', decidedBy: actor.userId, decidedAt: this.now(), decisionReason: input.reason?.trim() || null, verification, flowId: flow!.id, updatedAt: this.now() })
        .where(eq(flowDrafts.id, id))
        .returning();
      await this.audit(tx, 'flow_draft_approved', { draftId: id, flowId: flow!.id, by: actor.userId, draftedBy: locked.draftedBy, approvalMode: locked.approvalMode, verification });
      return row!;
    });
  }

  async reject(id: string, actor: DraftActor, reason: string): Promise<FlowDraftRow> {
    if (actor.apiKeyId || !actor.userId) throw new FlowDraftError('FORBIDDEN', 'Flow drafts are decided by a person in Studio, never through an agent channel.', 403);
    return this.tx(async (tx) => {
      const [locked] = await tx.select().from(flowDrafts).where(and(eq(flowDrafts.siteId, this.siteId), eq(flowDrafts.id, id))).for('update');
      if (!locked) throw new FlowDraftError('NOT_FOUND', 'No such flow draft.', 404);
      if (locked.status !== 'pending') throw new FlowDraftError('NOT_PENDING', `The draft is already ${locked.status}.`, 409);
      const [row] = await tx
        .update(flowDrafts)
        .set({ status: 'rejected', decidedBy: actor.userId, decidedAt: this.now(), decisionReason: reason.trim(), verification: 'none', updatedAt: this.now() })
        .where(eq(flowDrafts.id, id))
        .returning();
      await this.audit(tx, 'flow_draft_rejected', { draftId: id, by: actor.userId, reason: reason.trim() });
      return row!;
    });
  }
}

/**
 * Change the instance approval mode (audited; applies to drafts and batch plans submitted afterwards).
 *
 * The audit row is written in the same transaction as the change, not through the async audit queue: a queued
 * job of the last request before a shutdown was replayed after its site had been deleted and logged an
 * audit-log insert failure (and a security-relevant setting must never change without its record).
 */
export async function setApprovalMode(db: Database, siteId: string, mode: ApprovalMode, userId: string | null): Promise<ApprovalMode> {
  return runSiteTransaction(db, siteId, async (raw) => {
    const tx = raw as unknown as Database;
    const [locked] = await tx.select({ mode: systemState.approvalMode }).from(systemState).where(eq(systemState.id, 'singleton')).for('update');
    if (!locked) throw new FlowDraftError('NOT_FOUND', 'The instance is not set up yet.', 409);
    const before = locked.mode === 'team' ? 'team' : 'solo';
    if (before === mode) return mode;
    await tx.update(systemState).set({ approvalMode: mode, updatedAt: new Date() }).where(eq(systemState.id, 'singleton'));
    await new AuditLogger({ db: tx, siteId }).writeInTransaction(tx, { siteId, event: 'approval_mode_changed', metadata: { from: before, to: mode, by: userId } });
    return mode;
  });
}
