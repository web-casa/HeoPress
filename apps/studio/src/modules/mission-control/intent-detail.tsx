// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { AlertTriangle, Pause, Pencil, Play, Radar, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/cn';
import { missionControlApi, type ContentIntent } from './api';
import { MissionControlLayout, useAdminBase, useMissionControlBase } from './layout';
import { IntentStatusBadge } from './slo-table';

/**
 * Intent detail (content-os-ui task 6.2; Req 5.2-5.5): what the intent
 * governs (rules as cards, schedule, budget, autonomy ceiling) and where
 * reality deviates from it (drift list linking to the items). Pause goes
 * through the kill switch's `intent` scope — that IS the pause mechanism
 * (content-os Req 14.1); resume uses the dedicated resume endpoint.
 */

const LEVELS = [0, 1, 2, 3, 4] as const;

function RuleCard({ rule }: { rule: unknown }) {
  const { t } = useTranslation('agents');
  if (typeof rule !== 'object' || rule === null) {
    return (
      <li className="rounded-lg border p-3 text-xs">
        <code>{JSON.stringify(rule)}</code>
      </li>
    );
  }
  const { type, ...params } = rule as Record<string, unknown>;
  return (
    <li className="rounded-lg border p-3">
      <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs font-medium">
        {typeof type === 'string' ? type : t('detail.rule')}
      </span>
      {Object.keys(params).length > 0 && (
        <dl className="mt-2 space-y-0.5 text-xs">
          {Object.entries(params).map(([key, value]) => (
            <div key={key} className="flex gap-2">
              <dt className="text-muted-foreground">{key}</dt>
              <dd className="font-mono">{JSON.stringify(value)}</dd>
            </div>
          ))}
        </dl>
      )}
    </li>
  );
}

/**
 * Inline edit form (content-os-ui task 17.1; Req 17.2). Name/schedule/
 * autonomyCap/budget as fields; rules stay raw JSON — the composer is the
 * rich editor for rules, this form is for surgical fixes.
 */
function EditIntentForm({ intent, onClose }: { intent: ContentIntent; onClose: () => void }) {
  const { t } = useTranslation('agents');
  const queryClient = useQueryClient();
  const budget = (intent as unknown as { budget?: Record<string, unknown> }).budget;
  const [name, setName] = useState(intent.name);
  const [schedule, setSchedule] = useState(intent.schedule);
  const [autonomyCap, setAutonomyCap] = useState(intent.autonomyCap);
  const [rulesJson, setRulesJson] = useState(() => JSON.stringify(intent.rules, null, 2));
  const [budgetJson, setBudgetJson] = useState(() => JSON.stringify(budget ?? {}, null, 2));
  const [localError, setLocalError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      missionControlApi.updateIntent(intent.id, patch),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['mc-intents'] });
      onClose();
    },
  });

  const submit = () => {
    let rules: unknown;
    let parsedBudget: unknown;
    try {
      rules = JSON.parse(rulesJson);
      parsedBudget = JSON.parse(budgetJson);
    } catch {
      setLocalError(t('detail.invalidJson'));
      return;
    }
    setLocalError(null);
    mutation.mutate({ name, schedule, autonomyCap, rules, budget: parsedBudget });
  };

  return (
    <section className="space-y-3 rounded-lg border bg-background p-4">
      <h3 className="text-sm font-semibold">{t('detail.editTitle')}</h3>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <label className="text-xs">
          <span className="mb-1 block text-muted-foreground">{t('composer.name')}</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-md border bg-background px-2 py-1.5"
          />
        </label>
        <label className="text-xs">
          <span className="mb-1 block text-muted-foreground">{t('composer.schedule')}</span>
          <input
            value={schedule}
            onChange={(e) => setSchedule(e.target.value)}
            className="w-full rounded-md border bg-background px-2 py-1.5 font-mono"
          />
        </label>
        <label className="text-xs">
          <span className="mb-1 block text-muted-foreground">{t('detail.autonomyCap')}</span>
          <select
            value={autonomyCap}
            onChange={(e) => setAutonomyCap(Number(e.target.value))}
            className="w-full rounded-md border bg-background px-2 py-1.5"
          >
            {LEVELS.map((level) => (
              <option key={level} value={level}>
                {t(`levels.${level}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs sm:col-span-2">
          <span className="mb-1 block text-muted-foreground">{t('detail.rulesJson')}</span>
          <textarea
            value={rulesJson}
            onChange={(e) => setRulesJson(e.target.value)}
            rows={6}
            className="w-full rounded-md border bg-background px-2 py-1.5 font-mono"
          />
        </label>
        <label className="text-xs">
          <span className="mb-1 block text-muted-foreground">{t('detail.budgetJson')}</span>
          <textarea
            value={budgetJson}
            onChange={(e) => setBudgetJson(e.target.value)}
            rows={6}
            className="w-full rounded-md border bg-background px-2 py-1.5 font-mono"
          />
        </label>
      </div>
      {(localError || mutation.isError) && (
        <p className="text-xs text-destructive">
          {localError ?? (mutation.error instanceof Error ? mutation.error.message : t('detail.saveFailed'))}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={mutation.isPending}
          className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {mutation.isPending ? t('detail.saving') : t('detail.saveChanges')}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border px-3 py-1.5 text-xs hover:bg-muted"
        >
          {t('actions.cancel')}
        </button>
      </div>
    </section>
  );
}

function IntentDetailBody({ intentId }: { intentId: string }) {
  const { t } = useTranslation('agents');
  const adminBase = useAdminBase();
  const base = useMissionControlBase();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const intentsQuery = useQuery({ queryKey: ['mc-intents'], queryFn: missionControlApi.intents });
  const driftsQuery = useQuery({
    queryKey: ['mc-drifts', intentId],
    queryFn: () => missionControlApi.drifts(intentId),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['mc-intents'] });
    void queryClient.invalidateQueries({ queryKey: ['mc-kill-switch'] });
  };
  const pauseMutation = useMutation({
    mutationFn: () =>
      missionControlApi.activateKillSwitch('intent', intentId, 'Paused from intent detail'),
    onSuccess: invalidate,
  });
  const resumeMutation = useMutation({
    mutationFn: () => missionControlApi.resumeIntent(intentId),
    onSuccess: invalidate,
  });
  // Manual reconciliation cycle (Req 17.1) — same cycle the scheduler runs.
  const scanMutation = useMutation({
    mutationFn: () => missionControlApi.scanIntent(intentId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['mc-drifts', intentId] });
      void queryClient.invalidateQueries({ queryKey: ['mc-goals'] });
    },
  });
  const deleteMutation = useMutation({
    mutationFn: () => missionControlApi.deleteIntent(intentId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['mc-intents'] });
      void navigate({ to: `${base}/intents` as never });
    },
    onSettled: () => setConfirmingDelete(false),
  });

  if (intentsQuery.isLoading) {
    return <p className="text-sm text-muted-foreground">{t('detail.loading')}</p>;
  }

  const intent = (intentsQuery.data ?? []).find((i) => i.id === intentId);
  if (!intent) {
    return (
      <div className="rounded-lg border bg-background p-6 text-center">
        <AlertTriangle className="mx-auto mb-2 h-5 w-5 text-muted-foreground" />
        <p className="text-sm font-medium">{t('detail.notFound')}</p>
        <Link to={`${base}/intents` as never} className="mt-2 inline-block text-xs text-primary hover:underline">
          {t('detail.back')}
        </Link>
      </div>
    );
  }

  const drifts = driftsQuery.data ?? [];
  const budget = intent as unknown as { budget?: Record<string, unknown> };

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-background p-4">
        <div className="space-y-1">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            {intent.name} <IntentStatusBadge status={intent.status} />
          </h2>
          <p className="text-xs text-muted-foreground">
            <code className="rounded bg-muted px-1">{intent.collection}</code>
            {' · '}
            {t('detail.scheduleLabel')} <code className="rounded bg-muted px-1">{intent.schedule}</code>
            {' · '}
            {t('detail.autonomyCapLabel')}{' '}
            <span className="font-medium">
              {t(`levels.${intent.autonomyCap}`, { defaultValue: `L${intent.autonomyCap}` })}
            </span>
          </p>
          {intent.statusReason && (
            <p className="text-xs text-destructive">{intent.statusReason}</p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Manual reconciliation cycle (Req 17.1). */}
          <button
            type="button"
            onClick={() => scanMutation.mutate()}
            disabled={scanMutation.isPending}
            className="inline-flex items-center gap-1 rounded-md border px-3 py-2 text-sm hover:bg-muted disabled:opacity-50"
          >
            <Radar className="h-4 w-4" /> {scanMutation.isPending ? t('detail.scanning') : t('detail.scanNow')}
          </button>
          <button
            type="button"
            onClick={() => setEditing((v) => !v)}
            className="inline-flex items-center gap-1 rounded-md border px-3 py-2 text-sm hover:bg-muted"
          >
            <Pencil className="h-4 w-4" /> {t('detail.edit')}
          </button>
          {intent.status === 'active' ? (
            <button
              type="button"
              onClick={() => pauseMutation.mutate()}
              disabled={pauseMutation.isPending}
              className="inline-flex items-center gap-1 rounded-md border px-3 py-2 text-sm hover:bg-muted disabled:opacity-50"
            >
              <Pause className="h-4 w-4" /> {pauseMutation.isPending ? t('detail.pausing') : t('detail.pause')}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => resumeMutation.mutate()}
              disabled={resumeMutation.isPending}
              className="inline-flex items-center gap-1 rounded-md border border-emerald-400 px-3 py-2 text-sm text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
            >
              <Play className="h-4 w-4" /> {resumeMutation.isPending ? t('inbox.resuming') : t('inbox.resume')}
            </button>
          )}
          {confirmingDelete ? (
            <span className="inline-flex gap-1">
              <button
                type="button"
                onClick={() => setConfirmingDelete(false)}
                className="rounded-md border px-2 py-2 text-xs hover:bg-muted"
              >
                {t('actions.cancel')}
              </button>
              <button
                type="button"
                onClick={() => deleteMutation.mutate()}
                disabled={deleteMutation.isPending}
                className="rounded-md bg-destructive px-2 py-2 text-xs font-medium text-destructive-foreground hover:opacity-90 disabled:opacity-50"
              >
                {deleteMutation.isPending ? t('detail.deleting') : t('roles.confirmDelete')}
              </button>
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              aria-label={t('detail.deleteIntent')}
              className="inline-flex items-center gap-1 rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive hover:bg-destructive/10"
            >
              <Trash2 className="h-4 w-4" /> {t('detail.delete')}
            </button>
          )}
        </div>
      </header>

      {scanMutation.isError && (
        <p className="text-xs text-destructive">
          {scanMutation.error instanceof Error ? scanMutation.error.message : t('detail.scanFailed')}
        </p>
      )}
      {scanMutation.isSuccess && (
        <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-xs text-emerald-900">
          <p className="font-medium">{t('detail.scanComplete')}</p>
          <p className="mt-1 font-mono">
            {t('detail.scanResult', {
              scan: JSON.stringify(scanMutation.data.scan),
              reconcile: JSON.stringify(scanMutation.data.reconcile),
            })}
          </p>
        </div>
      )}
      {deleteMutation.isError && (
        <p className="text-xs text-destructive">
          {deleteMutation.error instanceof Error ? deleteMutation.error.message : t('detail.deleteFailed')}
        </p>
      )}

      {editing && <EditIntentForm intent={intent} onClose={() => setEditing(false)} />}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section className="rounded-lg border bg-background p-4">
          <h3 className="mb-2 text-sm font-semibold">{t('composer.rules')}</h3>
          {intent.rules.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('detail.noRules')}</p>
          ) : (
            <ul className="space-y-2">
              {intent.rules.map((rule, i) => (
                <RuleCard key={i} rule={rule} />
              ))}
            </ul>
          )}
          {budget.budget && Object.keys(budget.budget).length > 0 && (
            <>
              <h3 className="mb-2 mt-4 text-sm font-semibold">{t('detail.budget')}</h3>
              <dl className="space-y-0.5 text-xs">
                {Object.entries(budget.budget).map(([key, value]) => (
                  <div key={key} className="flex gap-2">
                    <dt className="text-muted-foreground">{key}</dt>
                    <dd className="font-mono">{JSON.stringify(value)}</dd>
                  </div>
                ))}
              </dl>
            </>
          )}
        </section>

        <section className="rounded-lg border bg-background p-4">
          <h3 className="mb-2 text-sm font-semibold">{t('detail.drifts')}</h3>
          {driftsQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">{t('detail.loadingDrifts')}</p>
          ) : drifts.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('detail.noDrift')}</p>
          ) : (
            <ul className="space-y-1">
              {drifts.map((drift) => (
                <li
                  key={drift.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-xs"
                >
                  <span className="inline-flex items-center gap-2">
                    <span
                      className={cn(
                        'rounded-full px-1.5 py-0.5',
                        drift.status === 'resolved'
                          ? 'bg-emerald-100 text-emerald-800'
                          : drift.status === 'stale'
                            ? 'bg-muted text-muted-foreground'
                            : 'bg-amber-100 text-amber-800',
                      )}
                    >
                      {t(`driftStatus.${drift.status}`, { defaultValue: drift.status })}
                    </span>
                    <code className="rounded bg-muted px-1">{drift.ruleType}</code>
                    {drift.ruleKey && drift.ruleKey !== drift.ruleType && (
                      <span className="text-muted-foreground">{drift.ruleKey}</span>
                    )}
                  </span>
                  <Link
                    to={`${adminBase}/content/${intent.collection}/${drift.itemId}` as never}
                    className="text-primary hover:underline"
                  >
                    {t('detail.openItem')}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

export function IntentDetailPage() {
  const params = useParams({ strict: false }) as { intentId?: string };
  return (
    <MissionControlLayout>
      <IntentDetailBody intentId={params.intentId ?? ''} />
    </MissionControlLayout>
  );
}
