/** Batch operation plans (HeoPress P10 tasks 3.2–3.4): shapes of `/api/v1/agent-plans/*`. */

export type PlanStatus = 'pending_approval' | 'cooling_off' | 'approved' | 'running' | 'canary_review' | 'completed' | 'cancelled' | 'rejected' | 'expired';
export type ItemStatus = 'pending' | 'running' | 'succeeded' | 'conflict' | 'forbidden' | 'failed' | 'cancelled';
type RiskTier = 'low' | 'preview' | 'canary' | 'highest';

export interface PlanSummary {
  id: string;
  operation: string;
  status: PlanStatus;
  riskTier: RiskTier;
  highRisk: boolean;
  siteCount: number;
  approvalMode: 'solo' | 'team';
  createdAt: string;
  expiresAt: string;
}

export interface PlanItem {
  siteId: string;
  position: number;
  canary: boolean;
  arguments: Record<string, unknown>;
  status: ItemStatus;
  result: { code?: string; message?: string } | null;
  attempts: number;
}

export interface PlanDetail extends PlanSummary {
  arguments: Record<string, unknown>;
  scopeSummary: string;
  requiresPreview: boolean;
  requiresCanary: boolean;
  requiredApprovals: number;
  planHash: string;
  revision: number;
  draftedBy: string;
  drafterEmail: string | null;
  coolingOffUntil: string | null;
  canaryConfirmedAt: string | null;
  decisionReason: string | null;
  items: PlanItem[];
  approvals: Array<{ approverId: string; approverEmail: string | null; verification: string; createdAt: string; current: boolean }>;
  approvalsCurrent: number;
  viewer: {
    isDrafter: boolean;
    eligible: boolean;
    canApprove: boolean;
    needsSecondFactor: boolean;
    canReject: boolean;
    canCancel: boolean;
    canExecute: boolean;
    canConfirmCanary: boolean;
    canRetry: boolean;
  };
}

export interface PreviewRow {
  siteId: string;
  canary: boolean;
  expectedVersion: unknown;
  currentVersion?: unknown;
  stale?: boolean;
  readError?: string;
  changes?: Array<{ field: string; current: unknown; proposed: unknown }>;
}

/** The Carbon tone of a status chip. */
export function statusTone(status: PlanStatus | ItemStatus): 'ok' | 'warn' | 'bad' | 'neutral' {
  if (status === 'completed' || status === 'succeeded' || status === 'approved') return 'ok';
  if (status === 'conflict' || status === 'failed' || status === 'forbidden' || status === 'rejected') return 'bad';
  if (status === 'pending_approval' || status === 'cooling_off' || status === 'canary_review' || status === 'running') return 'warn';
  return 'neutral';
}

/** A value for the diff table: short, single line. */
export function showValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}

/** Counts per item status, for the results summary. */
export function countByStatus(items: readonly PlanItem[]): Partial<Record<ItemStatus, number>> {
  const out: Partial<Record<ItemStatus, number>> = {};
  for (const i of items) out[i.status] = (out[i.status] ?? 0) + 1;
  return out;
}
