import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { nanoid } from 'nanoid';
import { users } from './core';

/**
 * Batch operation plans of external agents (HeoPress P10 tasks 3.1–3.4; spec agents/batch-operations).
 *
 * A plan is the only way an agent changes two or more sites, or runs a high-risk operation. It fixes the operation,
 * its arguments, the resolved list of site ids (each with its own arguments and expected version), the risk tier and
 * a hash of all of that. A person approves it in Studio — never an agent channel — and the approval is bound to the
 * hash: any substantive change (a revision) produces a new hash and the old approvals no longer count.
 *
 * Instance-level like the grants (a plan spans sites): under row-level security the application role reads and
 * writes these tables only in a transaction that set `app.agent_access = 'on'`.
 */

export const PLAN_STATUSES = [
  'pending_approval',
  'cooling_off',
  'approved',
  'running',
  'canary_review',
  'completed',
  'cancelled',
  'rejected',
  'expired',
] as const;

export const PLAN_ITEM_STATUSES = ['pending', 'running', 'succeeded', 'conflict', 'forbidden', 'failed', 'cancelled'] as const;

export const batchPlans = pgTable(
  'lumibase_batch_plans',
  {
    id: text('id').$defaultFn(() => nanoid()).primaryKey(),
    /** The tool run on each site, e.g. `content_update`. */
    operation: text('operation').notNull(),
    /** Arguments shared by every site (per-site arguments live on the items). */
    arguments: jsonb('arguments').$type<Record<string, unknown>>().default({}).notNull(),
    /** How the scope was given: an explicit `siteIds` list or `instance` (every authorized site, resolved now). */
    scopeKind: text('scope_kind').notNull(),
    /** The scope confirmation shown to the approver: what was asked and the fixed list it resolved to. */
    scopeSummary: text('scope_summary').notNull(),
    siteCount: integer('site_count').notNull(),
    riskTier: text('risk_tier').notNull(),
    highRisk: boolean('high_risk').default(false).notNull(),
    requiresPreview: boolean('requires_preview').default(false).notNull(),
    requiresCanary: boolean('requires_canary').default(false).notNull(),
    /** The instance approval mode when the plan was submitted (ADR-0012: a switch applies to later plans). */
    approvalMode: text('approval_mode').notNull(),
    requiredApprovals: integer('required_approvals').default(1).notNull(),
    /** SHA-256 over the operation, arguments, items, drafter, grant, revision, tier, mode and expiry. */
    planHash: text('plan_hash').notNull(),
    revision: integer('revision').default(1).notNull(),
    status: text('status').default('pending_approval').notNull(),
    /** The person the agent acts for (the token's owner). */
    draftedBy: text('drafted_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    draftedVia: text('drafted_via').notNull(),
    /** The authorization the plan was submitted under; execution re-checks it (revoked → every site refused). */
    grantId: text('grant_id'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    coolingOffUntil: timestamp('cooling_off_until', { withTimezone: true }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    canaryConfirmedBy: text('canary_confirmed_by'),
    canaryConfirmedAt: timestamp('canary_confirmed_at', { withTimezone: true }),
    /** The run in progress: a second execute request finds it set and is refused (deduplicated). */
    executionId: text('execution_id'),
    executionStartedAt: timestamp('execution_started_at', { withTimezone: true }),
    decidedBy: text('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decisionReason: text('decision_reason'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    draftedByIdx: index('batch_plans_drafted_by_idx').on(t.draftedBy, t.createdAt),
    statusIdx: index('batch_plans_status_idx').on(t.status),
    status: check(
      'batch_plans_status',
      sql`${t.status} IN ('pending_approval', 'cooling_off', 'approved', 'running', 'canary_review', 'completed', 'cancelled', 'rejected', 'expired')`,
    ),
    tier: check('batch_plans_tier', sql`${t.riskTier} IN ('low', 'preview', 'canary', 'highest')`),
    mode: check('batch_plans_mode', sql`${t.approvalMode} IN ('solo', 'team')`),
    scopeKind: check('batch_plans_scope_kind', sql`${t.scopeKind} IN ('siteIds', 'instance')`),
    via: check('batch_plans_via', sql`${t.draftedVia} IN ('oauth', 'pat')`),
  }),
);

/** One target site of a plan: its own arguments (resource id, expected version), canary flag and result. */
export const batchPlanItems = pgTable(
  'lumibase_batch_plan_items',
  {
    planId: text('plan_id')
      .notNull()
      .references(() => batchPlans.id, { onDelete: 'cascade' }),
    /** No foreign key: a site deleted after approval is reported for that site, never dropped from the record. */
    siteId: text('site_id').notNull(),
    position: integer('position').notNull(),
    canary: boolean('canary').default(false).notNull(),
    arguments: jsonb('arguments').$type<Record<string, unknown>>().default({}).notNull(),
    status: text('status').default('pending').notNull(),
    result: jsonb('result').$type<Record<string, unknown>>(),
    attempts: integer('attempts').default(0).notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.planId, t.siteId] }),
    status: check('batch_plan_items_status', sql`${t.status} IN ('pending', 'running', 'succeeded', 'conflict', 'forbidden', 'failed', 'cancelled')`),
  }),
);

/** A person's approval of one exact plan hash. A revision changes the hash; older approvals stop counting. */
export const batchPlanApprovals = pgTable(
  'lumibase_batch_plan_approvals',
  {
    id: text('id').$defaultFn(() => nanoid()).primaryKey(),
    planId: text('plan_id')
      .notNull()
      .references(() => batchPlans.id, { onDelete: 'cascade' }),
    planHash: text('plan_hash').notNull(),
    approverId: text('approver_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** `totp` when the drafter approved their own plan with a second factor (solo mode); else `none`. */
    verification: text('verification').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    once: uniqueIndex('batch_plan_approvals_once').on(t.planId, t.planHash, t.approverId),
    verification: check('batch_plan_approvals_verification', sql`${t.verification} IN ('totp', 'none')`),
  }),
);
