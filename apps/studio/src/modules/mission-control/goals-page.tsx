// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Bot, GitBranch, Plus, User, Workflow, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useServerFeatures } from '@/lib/features';
import { FillIcon } from '@/components/fill-icon';
import { cn } from '@/lib/cn';
import { missionControlApi, type AgentGoalRow, type AgentRunRow, type SubGoalInput } from './api';
import { MissionControlLayout, useMissionControlBase } from './layout';

/**
 * Goal tree (content-os-ui task 13; Req 12.1-12.4): the agent newsroom made
 * visible. Goals nest by parentGoalId — a Planner goal fans out into
 * role-scoped sub-goals — with role/status/origin badges and the latest run
 * per goal. The endpoint returns the latest page only, so an orphan (parent
 * outside the page) renders as a root rather than disappearing.
 */

const ORIGIN_ICONS = { user: User, reconciler: Workflow, planner: GitBranch, flow: Workflow } as const;

const GOAL_TONES: Record<string, string> = {
  done: 'bg-emerald-100 text-emerald-800',
  succeeded: 'bg-emerald-100 text-emerald-800',
  in_progress: 'bg-sky-100 text-sky-800',
  // A reconciler repair that needs a human decision (#455): rejected approval,
  // no wired repair skill for the rule type, a publish that did not resolve the
  // drift. Amber rather than destructive — it is waiting, not broken.
  blocked: 'bg-amber-100 text-amber-800',
  open: 'bg-muted text-muted-foreground',
  failed: 'bg-destructive/10 text-destructive',
  cancelled: 'bg-muted text-muted-foreground',
};

interface GoalNode {
  goal: AgentGoalRow;
  children: GoalNode[];
}

export function buildGoalTree(goals: AgentGoalRow[]): GoalNode[] {
  const nodes = new Map(goals.map((g) => [g.id, { goal: g, children: [] as GoalNode[] }]));
  const roots: GoalNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.goal.parentGoalId ? nodes.get(node.goal.parentGoalId) : undefined;
    // Orphans (parent fell off the page) become roots — never dropped (Req 12.4).
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

function latestRunByGoal(runs: AgentRunRow[]): Map<string, AgentRunRow> {
  const latest = new Map<string, AgentRunRow>();
  for (const run of runs) {
    const seen = latest.get(run.goalId);
    if (!seen || run.createdAt > seen.createdAt) latest.set(run.goalId, run);
  }
  return latest;
}

/**
 * Decompose form (content-os-ui task 18.1; Req 18.1): the human plays
 * Planner — break a goal into role-scoped sub-goals. Roles come from the
 * role library so the assignment is always a persona that exists.
 */
function DecomposeForm({ goalId, onClose }: { goalId: string; onClose: () => void }) {
  const { t } = useTranslation('agents');
  const queryClient = useQueryClient();
  const rolesQuery = useQuery({ queryKey: ['mc-agent-roles'], queryFn: missionControlApi.roles });
  const [rows, setRows] = useState<SubGoalInput[]>([{ title: '', agentRole: '' }]);

  const mutation = useMutation({
    mutationFn: (subGoals: SubGoalInput[]) => missionControlApi.decomposeGoal(goalId, subGoals),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['mc-goals'] });
      onClose();
    },
  });

  const roles = rolesQuery.data ?? [];
  const valid = rows.length > 0 && rows.every((r) => r.title.trim() && r.agentRole);
  const setRow = (i: number, patch: Partial<SubGoalInput>) =>
    setRows((prev) => prev.map((row, j) => (j === i ? { ...row, ...patch } : row)));

  return (
    <div className="mt-1 space-y-2 rounded-md border bg-muted/30 p-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium">{t('goals.decomposeTitle')}</p>
        <button type="button" onClick={onClose} aria-label={t('goals.closeDecompose')} className="rounded-md border p-0.5 hover:bg-muted">
          <X className="h-3 w-3" />
        </button>
      </div>
      {rows.map((row, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          <input
            value={row.title}
            onChange={(e) => setRow(i, { title: e.target.value })}
            placeholder={t('goals.subGoalTitle')}
            aria-label={t('goals.subGoalTitleAria', { n: i + 1 })}
            className="min-w-48 flex-1 rounded-md border bg-background px-2 py-1 text-xs"
          />
          <select
            value={row.agentRole}
            onChange={(e) => setRow(i, { agentRole: e.target.value })}
            aria-label={t('goals.subGoalRoleAria', { n: i + 1 })}
            className="rounded-md border bg-background px-2 py-1 text-xs"
          >
            <option value="">{t('goals.rolePlaceholder')}</option>
            {roles.map((r) => (
              <option key={r.name} value={r.name}>
                {r.name}
              </option>
            ))}
          </select>
          {rows.length > 1 && (
            <button
              type="button"
              onClick={() => setRows((prev) => prev.filter((_, j) => j !== i))}
              aria-label={t('goals.removeSubGoal', { n: i + 1 })}
              className="rounded-md border p-1 hover:bg-muted"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      ))}
      {mutation.isError && (
        <p className="text-[10px] text-destructive">
          {mutation.error instanceof Error ? mutation.error.message : t('goals.decomposeFailed')}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setRows((prev) => [...prev, { title: '', agentRole: '' }])}
          className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[10px] hover:bg-muted"
        >
          <Plus className="h-3 w-3" /> {t('goals.addRow')}
        </button>
        <button
          type="button"
          onClick={() => mutation.mutate(rows.map((r) => ({ ...r, title: r.title.trim() })))}
          disabled={!valid || mutation.isPending}
          className="rounded-md bg-primary px-2 py-1 text-[10px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {mutation.isPending ? t('goals.creating') : t('goals.createSubGoals')}
        </button>
      </div>
    </div>
  );
}

function GoalNodeRow({
  node,
  runs,
  depth,
}: {
  node: GoalNode;
  runs: Map<string, AgentRunRow>;
  depth: number;
}) {
  const { t } = useTranslation('agents');
  const base = useMissionControlBase();
  const queryClient = useQueryClient();
  const [decomposing, setDecomposing] = useState(false);
  const { agentNewsroom, contentGoals } = useServerFeatures();
  const { goal } = node;
  const OriginIcon = ORIGIN_ICONS[goal.origin as keyof typeof ORIGIN_ICONS] ?? User;
  const role = goal.agentRole ?? goal.assigneeAgent;
  const run = runs.get(goal.id);
  const metadata = (goal.metadata ?? {}) as Record<string, unknown>;
  const rawBlockedReason = metadata['blockedReason'];
  const blockedReason =
    goal.status === 'blocked' && typeof rawBlockedReason === 'string' ? rawBlockedReason : null;

  const settleMutation = useMutation({
    mutationFn: () => missionControlApi.settleGoal(goal.id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['mc-goals'] }),
  });

  return (
    <li>
      <div style={{ marginLeft: depth * 24 }}>
        <div className="flex flex-wrap items-center gap-2 rounded-md border bg-background px-3 py-2">
          <FillIcon
            icon={OriginIcon}
            className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
            aria-label={t('goals.originAria', { origin: t(`goals.origin.${goal.origin}`, { defaultValue: goal.origin }) })}
          />
          <span className="text-sm font-medium">{goal.title}</span>
          <span className="inline-flex items-center gap-1 rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] text-violet-800">
            <FillIcon icon={Bot} className="h-3 w-3" /> {role}
          </span>
          <span
            className={cn(
              'rounded-full px-1.5 py-0.5 text-[10px]',
              GOAL_TONES[goal.status] ?? 'bg-muted text-muted-foreground',
            )}
          >
            {t(`status.${goal.status}`, { defaultValue: goal.status })}
          </span>
          {blockedReason && (
            // Without this the operator sees `blocked` and has no way to learn
            // why from the UI — the reason would only exist in the goal metadata.
            <span className="text-[10px] text-amber-800" title={t('goals.blockedReason')}>
              {blockedReason}
            </span>
          )}
          {run && (
            <span className="text-[10px] text-muted-foreground">
              {t('goals.lastRun', { status: t(`status.${run.status}`, { defaultValue: run.status }), model: run.model })}
            </span>
          )}
          <span className="ml-auto inline-flex items-center gap-2">
            {/* Planner actions (Req 18) — multi-agent newsroom only (P02 5.1). */}
            {agentNewsroom && (
            <button
              type="button"
              onClick={() => setDecomposing((v) => !v)}
              className="text-xs text-primary hover:underline"
            >
              {t('goals.decompose')}
            </button>
            )}
            {agentNewsroom && node.children.length > 0 && (
              <button
                type="button"
                onClick={() => settleMutation.mutate()}
                disabled={settleMutation.isPending}
                className="text-xs text-primary hover:underline disabled:opacity-50"
              >
                {settleMutation.isPending ? t('goals.settling') : t('goals.settle')}
              </button>
            )}
            {contentGoals && goal.intentId && (
              <Link
                to={`${base}/intents/${goal.intentId}` as never}
                className="text-xs text-primary hover:underline"
              >
                {t('goals.intentLink')}
              </Link>
            )}
          </span>
        </div>
        {settleMutation.isError && (
          <p className="mt-0.5 text-[10px] text-destructive">
            {settleMutation.error instanceof Error
              ? settleMutation.error.message
              : t('goals.settleFailed')}
          </p>
        )}
        {decomposing && <DecomposeForm goalId={goal.id} onClose={() => setDecomposing(false)} />}
      </div>
      {node.children.length > 0 && (
        <ul className="mt-1 space-y-1">
          {node.children.map((child) => (
            <GoalNodeRow key={child.goal.id} node={child} runs={runs} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

function GoalsBody() {
  const { t } = useTranslation('agents');
  const goalsQuery = useQuery({
    queryKey: ['mc-goals'],
    queryFn: missionControlApi.goals,
    refetchInterval: 60_000,
    retry: false,
  });
  const runsQuery = useQuery({
    queryKey: ['mc-runs'],
    queryFn: missionControlApi.runs,
    refetchInterval: 60_000,
    retry: false,
  });

  if (goalsQuery.isLoading) {
    return <p className="text-sm text-muted-foreground">{t('goals.loading')}</p>;
  }

  const roots = buildGoalTree(goalsQuery.data ?? []);
  if (roots.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {t('goals.empty')}
      </p>
    );
  }

  const runs = latestRunByGoal(runsQuery.data ?? []);
  return (
    <ul className="space-y-1">
      {roots.map((node) => (
        <GoalNodeRow key={node.goal.id} node={node} runs={runs} depth={0} />
      ))}
    </ul>
  );
}

export function GoalsPage() {
  return (
    <MissionControlLayout>
      <GoalsBody />
    </MissionControlLayout>
  );
}
