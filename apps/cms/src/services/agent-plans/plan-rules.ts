import { createHash } from 'node:crypto';

/**
 * The pure rules of batch operation plans (HeoPress P10 task 3.1; spec agents/batch-operations "计划与风险分级").
 *
 * Tiers, by the number of target sites and the operation:
 *   - `low`      ≤ 10 sites;
 *   - `preview`  > 10 sites: the approver sees the per-site preview (diff) before approving;
 *   - `canary`   > 25 sites: also runs on 1–2 canary sites first, and a person confirms their results before the rest;
 *   - `highest`  > 50 sites, or any high-risk operation (domain, DNS, delete, site-wide theme publish, permission
 *                changes) whatever the site count — high-risk always includes a canary, even on one site.
 * The thresholds are the specification's; no setting lowers them.
 */

export type RiskTier = 'low' | 'preview' | 'canary' | 'highest';

export interface TierDecision {
  tier: RiskTier;
  highRisk: boolean;
  requiresPreview: boolean;
  requiresCanary: boolean;
  /** How many of the (sorted) target sites run first as canaries. */
  canaryCount: number;
}

const PREVIEW_ABOVE = 10;
const CANARY_ABOVE = 25;
const HIGHEST_ABOVE = 50;
/** The most sites one plan may name. */
export const MAX_PLAN_SITES = 500;

/** High-risk operations named exactly; prefixes and the `_delete` suffix cover the families. */
const HIGH_RISK_EXACT = new Set(['theme_activate', 'content_delete']);
const HIGH_RISK_PREFIXES = ['domain', 'dns', 'permission', 'role', 'access'];

export function isHighRiskOperation(operation: string): boolean {
  if (HIGH_RISK_EXACT.has(operation)) return true;
  if (/(^|_)delete($|_)/.test(operation)) return true;
  return HIGH_RISK_PREFIXES.some((p) => operation === p || operation.startsWith(`${p}_`) || operation.startsWith(`${p}s_`));
}

export function tierFor(operation: string, siteCount: number): TierDecision {
  const highRisk = isHighRiskOperation(operation);
  if (highRisk || siteCount > HIGHEST_ABOVE) {
    return { tier: 'highest', highRisk, requiresPreview: true, requiresCanary: true, canaryCount: siteCount > CANARY_ABOVE ? 2 : 1 };
  }
  if (siteCount > CANARY_ABOVE) return { tier: 'canary', highRisk, requiresPreview: true, requiresCanary: true, canaryCount: 2 };
  if (siteCount > PREVIEW_ABOVE) return { tier: 'preview', highRisk, requiresPreview: true, requiresCanary: false, canaryCount: 0 };
  return { tier: 'low', highRisk, requiresPreview: false, requiresCanary: false, canaryCount: 0 };
}

/** Approvals a plan needs: team mode's highest tier needs a second, different approver. */
export function requiredApprovals(mode: 'solo' | 'team', tier: RiskTier): number {
  return mode === 'team' && tier === 'highest' ? 2 : 1;
}

/** Operations a plan may carry, with the per-site arguments each needs. */
export const PLAN_OPERATIONS: Record<string, { required: string[]; expected: 'version' | 'activeTheme' | 'none' }> = {
  content_create: { required: ['collection', 'data'], expected: 'none' },
  content_update: { required: ['collection', 'id', 'data', 'expectedVersion'], expected: 'version' },
  content_publish: { required: ['collection', 'id', 'expectedVersion'], expected: 'version' },
  content_delete: { required: ['collection', 'id', 'expectedVersion'], expected: 'version' },
  site_update_seo_settings: { required: ['settings', 'expectedVersion'], expected: 'version' },
  theme_activate: { required: ['themeVersionId', 'expectedActiveVersionId'], expected: 'activeTheme' },
};

/** Problems with one site's effective arguments (shared arguments merged with that site's own). */
export function itemProblems(operation: string, args: Record<string, unknown>): string[] {
  const spec = PLAN_OPERATIONS[operation];
  if (!spec) return [`"${operation}" cannot run in a plan.`];
  const problems: string[] = [];
  for (const key of spec.required) {
    if (!(key in args)) problems.push(`${key} is required`);
  }
  if ('expectedVersion' in args && (!Number.isInteger(args.expectedVersion) || (args.expectedVersion as number) < 1)) problems.push('expectedVersion must be a positive integer');
  if ('expectedActiveVersionId' in args && args.expectedActiveVersionId !== null && typeof args.expectedActiveVersionId !== 'string') {
    problems.push('expectedActiveVersionId must be the active theme version id, or null when none is active');
  }
  for (const key of ['data', 'settings']) {
    if (key in args && (!args[key] || typeof args[key] !== 'object' || Array.isArray(args[key]))) problems.push(`${key} must be an object`);
  }
  for (const key of ['collection', 'id', 'themeVersionId']) {
    if (key in args && (typeof args[key] !== 'string' || !(args[key] as string).trim())) problems.push(`${key} must be a non-empty string`);
  }
  return problems;
}

/** The canary sites: the first `count` of the sorted list (deterministic, part of the hash). */
export function canarySites(siteIds: readonly string[], count: number): string[] {
  return [...siteIds].sort().slice(0, count);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
    );
  }
  return value instanceof Date ? value.toISOString() : value;
}

export interface HashInput {
  id: string;
  operation: string;
  arguments: Record<string, unknown>;
  items: Array<{ siteId: string; arguments: Record<string, unknown>; canary: boolean }>;
  draftedBy: string;
  grantId: string | null;
  revision: number;
  riskTier: RiskTier;
  approvalMode: 'solo' | 'team';
  expiresAt: Date;
}

/** SHA-256 of the canonical JSON of everything an approval is about. */
export function planHash(input: HashInput): string {
  const body = canonical({ ...input, items: [...input.items].sort((a, b) => (a.siteId < b.siteId ? -1 : a.siteId > b.siteId ? 1 : 0)) });
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}
