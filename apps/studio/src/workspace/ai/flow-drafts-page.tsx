import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Workflow } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { activeSession } from '@/lib/session/current';
import { siteKey } from '../api';
import { EmptyState } from '../ui/empty-state';
import { PageHeader } from '../ui/page-header';
import { Skeleton } from '../ui/skeleton';
import { aiApi, type FlowDraft } from './api';

/**
 * Agent-drafted flows (HeoPress P09 task 5.1; spec ai/flow-authoring; ADR-0012). A person reviews the operations and
 * approves (the flow is created and enabled) or rejects. In team mode the drafter cannot approve their own draft; in
 * solo mode they can with an authenticator code. Agents never approve.
 */

function DraftCard({ draft, mode, me }: { draft: FlowDraft; mode: 'solo' | 'team'; me: string | null }) {
  const { t } = useTranslation('ai');
  const qc = useQueryClient();
  const [code, setCode] = useState('');
  const [reason, setReason] = useState('');
  const own = !!me && draft.draftedBy === me;
  const done = () => qc.invalidateQueries({ queryKey: siteKey('ai-flow-drafts') });
  const approve = useMutation({ mutationFn: () => aiApi.approveDraft(draft.id, { ...(code.trim() ? { secondFactor: code.trim() } : {}), ...(reason.trim() ? { reason: reason.trim() } : {}) }), onSuccess: done });
  const reject = useMutation({ mutationFn: () => aiApi.rejectDraft(draft.id, reason.trim()), onSuccess: done });
  const failure = approve.error ?? reject.error;
  const field = 'rounded-ctl border border-line bg-panel px-2 py-1.5 text-[13px]';
  return (
    <li className="rounded-card border border-line bg-panel p-4" data-testid="flow-draft">
      <div className="flex flex-wrap items-center gap-3">
        <span className="t-section">{draft.name}</span>
        <span className="t-aux">{t(`flows.status.${draft.status}`)}</span>
        <span className="t-aux">{t(`flows.via.${draft.draftedVia}`)}</span>
        <span className="t-aux">{t('flows.trigger', { trigger: draft.triggerType })}</span>
      </div>
      {draft.description ? <p className="mt-1 t-body">{draft.description}</p> : null}
      <ol className="mt-2 flex flex-wrap gap-1 text-[13px]" aria-label={t('flows.operations')}>
        {draft.graph.nodes.map((n) => (
          <li key={n.id} className="rounded-ctl bg-panel-2 px-2 py-0.5">
            <code>{n.key}</code>
          </li>
        ))}
      </ol>
      {draft.status === 'pending' ? (
        <div className="mt-3 flex flex-col gap-2">
          {own && mode === 'team' ? <p className="t-aux">{t('flows.ownTeam')}</p> : null}
          {own && mode === 'solo' ? (
            <label className="flex flex-col gap-1 text-[13px] font-medium">
              {t('flows.secondFactor')}
              <input className={field} inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} />
            </label>
          ) : null}
          <label className="flex flex-col gap-1 text-[13px] font-medium">
            {t('flows.reason')}
            <input className={field} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <div className="flex gap-2">
            <button type="button" disabled={approve.isPending || (own && mode === 'team')} onClick={() => approve.mutate()} className="rounded-ctl bg-brand px-3 py-1.5 text-[13px] text-brand-fg disabled:opacity-50">
              {t('flows.approve')}
            </button>
            <button type="button" disabled={reject.isPending || !reason.trim()} onClick={() => reject.mutate()} className="rounded-ctl border border-line px-3 py-1.5 text-[13px] disabled:opacity-50">
              {t('flows.reject')}
            </button>
          </div>
          {failure ? (
            <p role="alert" className="text-[13px] text-bad">
              {t('flows.failed', { reason: failure instanceof Error ? failure.message : String(failure) })}
            </p>
          ) : null}
        </div>
      ) : draft.decisionReason ? (
        <p className="mt-2 t-aux">{t('flows.decided', { reason: draft.decisionReason })}</p>
      ) : null}
    </li>
  );
}

export function FlowDraftsPage() {
  const { t } = useTranslation('ai');
  const drafts = useQuery({ queryKey: siteKey('ai-flow-drafts'), queryFn: aiApi.flowDrafts });
  const mode = useQuery({ queryKey: ['approval-mode'], queryFn: aiApi.approvalMode });
  const me = activeSession()?.userId ?? null;
  return (
    <>
      <PageHeader title={t('flows.title')} description={t('flows.description', { mode: mode.data ? t(`flows.modes.${mode.data.mode}`) : '' })} />
      {drafts.isLoading ? (
        <Skeleton className="h-48" />
      ) : !drafts.data?.length ? (
        <EmptyState icon={Workflow} title={t('flows.emptyTitle')} body={t('flows.emptyBody')} />
      ) : (
        <ul className="flex flex-col gap-2">
          {drafts.data.map((d) => (
            <DraftCard key={d.id} draft={d} mode={d.approvalMode} me={me} />
          ))}
        </ul>
      )}
    </>
  );
}
