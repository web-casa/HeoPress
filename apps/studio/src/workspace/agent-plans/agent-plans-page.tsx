import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams, useRouterState } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getAdminBase } from '@/lib/admin-base';
import { getApiClient } from '@/lib/api';
import { withAdminBase } from '@/lib/keybindings/commands';
import { inputClass } from '../seo/seo-kit';
import { PageHeader } from '../ui/page-header';
import { RelativeTime } from '../ui/relative-time';
import { Skeleton } from '../ui/skeleton';
import { countByStatus, showValue, statusTone, type ItemStatus, type PlanDetail, type PlanStatus, type PlanSummary, type PreviewRow } from './agent-plans-api';

/**
 * Settings › Batch plans (HeoPress P10 tasks 3.2–3.4; spec agents/batch-operations; ADR-0012): the plans agents
 * submitted, and one plan's review — scope, per-site diff, approvals by mode, canary run and confirmation, results.
 * Every decision here is a person's; agents have no path to any of these buttons.
 */

const toneClass = { ok: 'bg-ok-soft text-ok', warn: 'bg-warn-soft text-warn', bad: 'bg-bad-soft text-bad', neutral: 'bg-panel-2 text-dim' } as const;

function Chip({ status }: { status: PlanStatus | ItemStatus }) {
  const { t } = useTranslation('agentPlans');
  return <span className={`inline-block rounded-ctl px-1.5 py-0.5 text-[12px] ${toneClass[statusTone(status)]}`}>{t(`status.${status}`)}</span>;
}

function useAdminLink() {
  const { location } = useRouterState();
  const base = getAdminBase(location.pathname);
  return (path: string) => withAdminBase(base, path) as never;
}

export function AgentPlansPage() {
  const { t } = useTranslation('agentPlans');
  const client = getApiClient();
  const link = useAdminLink();
  const list = useQuery({ queryKey: ['agent-plans'], queryFn: async () => (await client.rawRequest<PlanSummary[]>('/api/v1/agent-plans')).data });
  if (list.isLoading) return <Skeleton className="h-64" />;
  const rows = list.data ?? [];
  return (
    <>
      <PageHeader title={t('list.title')} description={t('list.description')} />
      {rows.length === 0 ? (
        <p className="text-[13px] text-dim">{t('list.empty')}</p>
      ) : (
        <div className="overflow-x-auto rounded-card border border-line bg-panel">
          <table className="w-full min-w-[720px] text-left text-[13px]">
            <caption className="sr-only">{t('list.title')}</caption>
            <thead className="t-aux">
              <tr className="border-b border-line">
                <th className="px-4 py-2">{t('list.operation')}</th>
                <th className="px-4 py-2">{t('list.sites')}</th>
                <th className="px-4 py-2">{t('list.tier')}</th>
                <th className="px-4 py-2">{t('list.status')}</th>
                <th className="px-4 py-2">{t('list.submitted')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} data-plan={p.id} className="border-b border-line last:border-0">
                  <td className="px-4 py-2 font-medium">
                    <Link to={link(`/settings/agent-plans/${encodeURIComponent(p.id)}`)} className="hover:underline">
                      {t(`operations.${p.operation}`, { defaultValue: p.operation })}
                    </Link>
                  </td>
                  <td className="px-4 py-2">{p.siteCount}</td>
                  <td className="px-4 py-2">{t(`tiers.${p.riskTier}`)}</td>
                  <td className="px-4 py-2">
                    <Chip status={p.status} />
                  </td>
                  <td className="px-4 py-2 t-aux">
                    <RelativeTime value={p.createdAt} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

const btn = 'rounded-ctl px-3 py-1.5 text-[13px] disabled:opacity-50';

export function AgentPlanDetailPage() {
  const { t } = useTranslation('agentPlans');
  const client = getApiClient();
  const qc = useQueryClient();
  const link = useAdminLink();
  const { planId } = useParams({ strict: false }) as { planId: string };
  const key = ['agent-plan', planId];
  const plan = useQuery({ queryKey: key, queryFn: async () => (await client.rawRequest<PlanDetail>(`/api/v1/agent-plans/${encodeURIComponent(planId)}`)).data });
  const preview = useQuery({
    queryKey: [...key, 'preview'],
    queryFn: async () => (await client.rawRequest<{ items: PreviewRow[]; truncated: boolean }>(`/api/v1/agent-plans/${encodeURIComponent(planId)}/preview`)).data,
  });
  const [code, setCode] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const act = useMutation({
    mutationFn: async ({ path, body }: { path: string; body?: Record<string, unknown> }) =>
      (await client.rawRequest<PlanDetail>(`/api/v1/agent-plans/${encodeURIComponent(planId)}/${path}`, { method: 'POST', body: JSON.stringify(body ?? {}) })).data,
    onMutate: () => setError(null),
    onSuccess: (data) => {
      qc.setQueryData(key, data);
      void qc.invalidateQueries({ queryKey: ['agent-plans'] });
      setCode('');
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  });

  if (plan.isLoading) return <Skeleton className="h-64" />;
  const p = plan.data;
  if (!p) return <p className="text-[13px] text-bad">{t('detail.notFound')}</p>;
  const v = p.viewer;
  const counts = countByStatus(p.items);
  const busy = act.isPending;

  return (
    <>
      <p className="mb-2 text-[13px]">
        <Link to={link('/settings/agent-plans')} className="text-dim hover:underline">
          ← {t('list.title')}
        </Link>
      </p>
      <PageHeader title={t(`operations.${p.operation}`, { defaultValue: p.operation })} description={t('detail.description')} />

      <section aria-label={t('detail.summary')} className="mb-4 grid gap-3 rounded-card border border-line bg-panel p-4 text-[13px] sm:grid-cols-2">
        <div>
          <span className="t-aux mr-2">{t('list.status')}</span>
          <Chip status={p.status} />
        </div>
        <div>
          <span className="t-aux mr-2">{t('list.tier')}</span>
          <span data-testid="plan-tier">{t(`tiers.${p.riskTier}`)}</span>
          {p.highRisk ? <span className="ml-2 rounded-ctl bg-bad-soft px-1.5 py-0.5 text-[12px] text-bad">{t('detail.highRisk')}</span> : null}
        </div>
        <div>
          <span className="t-aux mr-2">{t('detail.mode')}</span>
          {t(`modes.${p.approvalMode}`)}
        </div>
        <div>
          <span className="t-aux mr-2">{t('detail.drafter')}</span>
          {p.drafterEmail ?? p.draftedBy}
        </div>
        <div>
          <span className="t-aux mr-2">{t('detail.approvals')}</span>
          {t('detail.approvalsCount', { current: p.approvalsCurrent, required: p.requiredApprovals })}
        </div>
        <div>
          <span className="t-aux mr-2">{t('detail.expires')}</span>
          <RelativeTime value={p.expiresAt} />
        </div>
        <div className="sm:col-span-2">
          <span className="t-aux mr-2">{t('detail.scope')}</span>
          {p.scopeSummary}
        </div>
        <div className="sm:col-span-2">
          <span className="t-aux mr-2">{t('detail.hash')}</span>
          <code className="break-all text-[12px]">{p.planHash}</code>
          <span className="t-aux ml-2">{t('detail.revision', { n: p.revision })}</span>
        </div>
        {p.requiresCanary ? <p className="text-warn sm:col-span-2">{t('detail.canaryNote')}</p> : null}
        {p.status === 'cooling_off' && p.coolingOffUntil ? (
          <p role="status" className="text-warn sm:col-span-2">
            {t('detail.coolingOff')} <RelativeTime value={p.coolingOffUntil} />
          </p>
        ) : null}
        {p.decisionReason ? (
          <p className="sm:col-span-2">
            <span className="t-aux mr-2">{t('detail.reason')}</span>
            {p.decisionReason}
          </p>
        ) : null}
      </section>

      <section aria-label={t('detail.actions')} className="mb-5 space-y-3 rounded-card border border-line bg-panel p-4">
        <h2 className="t-section">{t('detail.actions')}</h2>
        {v.canApprove && v.needsSecondFactor ? (
          <div className="flex max-w-xs flex-col gap-1">
            <label htmlFor="plan-code" className="text-[13px] font-medium">
              {t('detail.secondFactor')}
            </label>
            <input id="plan-code" inputMode="numeric" autoComplete="one-time-code" className={inputClass} value={code} onChange={(e) => setCode(e.target.value)} />
            <p className="t-aux text-[12px]">{t('detail.secondFactorHint')}</p>
          </div>
        ) : null}
        {p.status === 'pending_approval' && v.isDrafter && p.approvalMode === 'team' ? <p className="text-[13px] text-dim">{t('detail.teamSelf')}</p> : null}
        {(v.canReject || v.canCancel) && (
          <div className="flex max-w-md flex-col gap-1">
            <label htmlFor="plan-reason" className="text-[13px] font-medium">
              {t('detail.reasonLabel')}
            </label>
            <input id="plan-reason" className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          {v.canApprove ? (
            <button type="button" disabled={busy || (v.needsSecondFactor && !code.trim())} className={`${btn} bg-brand text-brand-fg`} onClick={() => act.mutate({ path: 'approve', body: { planHash: p.planHash, ...(v.needsSecondFactor ? { secondFactor: code.trim() } : {}) } })}>
              {t('detail.approve')}
            </button>
          ) : null}
          {v.canExecute ? (
            <button type="button" disabled={busy} className={`${btn} bg-brand text-brand-fg`} onClick={() => act.mutate({ path: 'execute' })}>
              {p.requiresCanary && !p.canaryConfirmedAt ? t('detail.runCanary') : t('detail.run')}
            </button>
          ) : null}
          {v.canConfirmCanary ? (
            <button type="button" disabled={busy} className={`${btn} bg-brand text-brand-fg`} onClick={() => act.mutate({ path: 'canary/confirm' })}>
              {t('detail.confirmCanary')}
            </button>
          ) : null}
          {v.canRetry ? (
            <button type="button" disabled={busy} className={`${btn} border border-line`} onClick={() => act.mutate({ path: 'retry' })}>
              {t('detail.retry')}
            </button>
          ) : null}
          {v.canReject ? (
            <button type="button" disabled={busy || !reason.trim()} className={`${btn} border border-line text-bad`} onClick={() => act.mutate({ path: 'reject', body: { reason: reason.trim() } })}>
              {t('detail.reject')}
            </button>
          ) : null}
          {v.canCancel ? (
            <button type="button" disabled={busy} className={`${btn} border border-line text-bad`} onClick={() => act.mutate({ path: 'cancel', body: { reason: reason.trim() } })}>
              {t('detail.cancel')}
            </button>
          ) : null}
        </div>
        {error ? (
          <p role="alert" className="text-[12.5px] text-bad">
            {error}
          </p>
        ) : null}
      </section>

      <h2 className="t-section mb-2">{t('detail.preview')}</h2>
      {preview.isLoading ? (
        <Skeleton className="mb-5 h-24" />
      ) : (
        <div className="mb-5 overflow-x-auto rounded-card border border-line bg-panel">
          <table className="w-full min-w-[720px] text-left text-[13px]">
            <caption className="sr-only">{t('detail.preview')}</caption>
            <thead className="t-aux">
              <tr className="border-b border-line">
                <th className="px-4 py-2">{t('detail.site')}</th>
                <th className="px-4 py-2">{t('detail.field')}</th>
                <th className="px-4 py-2">{t('detail.current')}</th>
                <th className="px-4 py-2">{t('detail.proposed')}</th>
                <th className="px-4 py-2">{t('detail.version')}</th>
              </tr>
            </thead>
            <tbody>
              {(preview.data?.items ?? []).flatMap((row) => {
                const changes = row.changes?.length ? row.changes : [{ field: '—', current: null, proposed: null }];
                return changes.map((ch, i) => (
                  <tr key={`${row.siteId}:${ch.field}`} data-preview-site={row.siteId} className="border-b border-line last:border-0">
                    <td className="px-4 py-2 font-mono text-[12px]">
                      {i === 0 ? row.siteId : ''}
                      {i === 0 && row.canary ? <span className="ml-2 rounded-ctl bg-warn-soft px-1 text-[11px] text-warn">{t('detail.canary')}</span> : null}
                    </td>
                    <td className="px-4 py-2">{ch.field}</td>
                    <td className="px-4 py-2 text-dim line-through decoration-bad/50">{showValue(ch.current)}</td>
                    <td className="px-4 py-2 text-ok">{showValue(ch.proposed)}</td>
                    <td className="px-4 py-2">
                      {i === 0 ? (
                        row.readError ? (
                          <span className="text-bad">{t('detail.readError', { code: row.readError })}</span>
                        ) : row.stale ? (
                          <span className="text-bad">{t('detail.stale', { expected: showValue(row.expectedVersion), current: showValue(row.currentVersion) })}</span>
                        ) : (
                          showValue(row.expectedVersion)
                        )
                      ) : null}
                    </td>
                  </tr>
                ));
              })}
            </tbody>
          </table>
        </div>
      )}

      <h2 className="t-section mb-2">{t('detail.results')}</h2>
      <p className="t-aux mb-2 text-[12.5px]">
        {Object.entries(counts)
          .map(([s, n]) => `${t(`status.${s}`)} ${n}`)
          .join(' · ')}
      </p>
      <div className="overflow-x-auto rounded-card border border-line bg-panel">
        <table className="w-full min-w-[600px] text-left text-[13px]">
          <caption className="sr-only">{t('detail.results')}</caption>
          <thead className="t-aux">
            <tr className="border-b border-line">
              <th className="px-4 py-2">{t('detail.site')}</th>
              <th className="px-4 py-2">{t('list.status')}</th>
              <th className="px-4 py-2">{t('detail.detail')}</th>
            </tr>
          </thead>
          <tbody>
            {p.items.map((item) => (
              <tr key={item.siteId} data-result-site={item.siteId} className="border-b border-line last:border-0">
                <td className="px-4 py-2 font-mono text-[12px]">
                  {item.siteId}
                  {item.canary ? <span className="ml-2 rounded-ctl bg-warn-soft px-1 text-[11px] text-warn">{t('detail.canary')}</span> : null}
                </td>
                <td className="px-4 py-2">
                  <Chip status={item.status} />
                </td>
                <td className="px-4 py-2 text-dim">{item.result?.message ?? (item.result?.code ? item.result.code : '')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {p.approvals.length ? (
        <>
          <h2 className="t-section mb-2 mt-5">{t('detail.approvalLog')}</h2>
          <ul className="space-y-1 text-[13px]">
            {p.approvals.map((a) => (
              <li key={`${a.approverId}:${a.createdAt}`} className={a.current ? '' : 'text-dim line-through'}>
                {a.approverEmail ?? a.approverId} · {a.verification === 'totp' ? t('detail.verifiedTotp') : t('detail.verifiedNone')} · <RelativeTime value={a.createdAt} />
                {a.current ? null : <span className="ml-2 no-underline">{t('detail.outdated')}</span>}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </>
  );
}
