// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { AlertTriangle, CheckCircle, Inbox, ShieldAlert, XCircle } from 'lucide-react';
import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { missionControlApi } from './api';
import { ExceptionInbox, invalidateInboxQueries } from './inbox';
import { MissionControlLayout, useMissionControlBase } from './layout';
import { StagedDiff } from './staged-diff';
import { useInboxData, type InboxEntry } from './use-inbox';

/**
 * Full exception inbox (content-os-ui task 4.2; Req 3.1, 3.4, 1.4):
 * the urgency-sorted list on the left keeps its inline actions, the right
 * pane shows the selected entry in full — a real field diff for staged
 * changes, decision context for the rest. Selection lives in the `entry`
 * search param so notifications can deep-link a specific exception; a
 * vanished entry degrades to a notice, never a 404 (entries are ephemeral).
 */

function useSelectedEntryId(): [string | undefined, (id: string | undefined) => void] {
  const navigate = useNavigate();
  const { location } = useRouterState();
  const selected = (location.search as { entry?: string }).entry;
  const select = (id: string | undefined) => {
    void navigate({
      to: location.pathname as never,
      search: (id ? { entry: id } : {}) as never,
      replace: true,
    });
  };
  return [selected, select];
}

function EntryDetail({ entry }: { entry: InboxEntry }) {
  const { t } = useTranslation('agents');
  const base = useMissionControlBase();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const invalidate = () => invalidateInboxQueries(queryClient);

  const vetoMutation = useMutation({
    mutationFn: ({ approvalId, why }: { approvalId: string; why: string }) =>
      missionControlApi.veto(approvalId, why || 'Vetoed from Mission Control'),
    onSuccess: invalidate,
  });
  const decideMutation = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'approved' | 'rejected' }) =>
      missionControlApi.decideApproval(id, decision),
    onSuccess: invalidate,
  });
  const resumeMutation = useMutation({
    mutationFn: (id: string) => missionControlApi.resumeIntent(id),
    onSuccess: invalidate,
  });

  if (entry.kind === 'veto') {
    return (
      <div className="space-y-3">
        <h2 className="t-section">{t('inbox.stagedChange')}</h2>
        <StagedDiff veto={entry.veto} />
        <div className="flex flex-wrap items-end gap-2 border-t border-line pt-3">
          <label className="block grow text-xs font-medium text-dim">
            {t('inbox.vetoReason')}
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="mt-1 w-full rounded-ctl border border-line bg-bg px-2 py-2 text-sm"
            />
          </label>
          <button
            type="button"
            onClick={() =>
              vetoMutation.mutate({
                approvalId: String(entry.veto.approvalId ?? entry.veto.id),
                why: reason.trim(),
              })
            }
            disabled={vetoMutation.isPending}
            className="rounded-ctl border border-bad/40 px-3 py-2 text-sm font-medium text-bad hover:bg-bad-soft disabled:opacity-50"
          >
            {vetoMutation.isPending ? t('inbox.vetoing') : t('inbox.veto')}
          </button>
        </div>
      </div>
    );
  }

  if (entry.kind === 'approval') {
    return (
      <div className="space-y-3">
        <h2 className="inline-flex items-center gap-2 t-section">
          <ShieldAlert className="h-4 w-4 text-sky-600" /> {t('inbox.approvalPending')}
        </h2>
        <dl className="grid grid-cols-[8rem_1fr] gap-y-1 text-sm">
          <dt className="text-dim">{t('inbox.subject')}</dt>
          <dd>
            {entry.approval.subjectType}{' '}
            <code className="rounded bg-panel-2 px-1 text-xs">{entry.approval.subjectId}</code>
          </dd>
          <dt className="text-dim">{t('inbox.requestedBy')}</dt>
          <dd>{entry.approval.requestedByAgent}</dd>
          <dt className="text-dim">{t('inbox.run')}</dt>
          <dd>
            <code className="rounded bg-panel-2 px-1 text-xs">{entry.approval.runId}</code>
          </dd>
          <dt className="text-dim">{t('inbox.requestedAt')}</dt>
          <dd>{new Date(entry.approval.createdAt).toLocaleString()}</dd>
        </dl>
        <div className="flex gap-2 border-t border-line pt-3">
          <button
            type="button"
            onClick={() => decideMutation.mutate({ id: entry.approval.id, decision: 'approved' })}
            disabled={decideMutation.isPending}
            className="inline-flex items-center gap-1 rounded-ctl border border-ok/40 px-3 py-2 text-sm text-ok hover:bg-ok-soft disabled:opacity-50"
          >
            <CheckCircle className="h-4 w-4" /> {t('inbox.approve')}
          </button>
          <button
            type="button"
            onClick={() => decideMutation.mutate({ id: entry.approval.id, decision: 'rejected' })}
            disabled={decideMutation.isPending}
            className="inline-flex items-center gap-1 rounded-ctl border border-bad/40 px-3 py-2 text-sm text-bad hover:bg-bad-soft disabled:opacity-50"
          >
            <XCircle className="h-4 w-4" /> {t('inbox.reject')}
          </button>
        </div>
      </div>
    );
  }

  if (entry.kind === 'incident') {
    return (
      <div className="space-y-3">
        <h2 className="inline-flex items-center gap-2 t-section">
          <AlertTriangle className="h-4 w-4 text-warn" /> {t('inbox.incident', { severity: t(`severity.${entry.incident.severity}`, { defaultValue: entry.incident.severity }) })}
        </h2>
        <dl className="grid grid-cols-[8rem_1fr] gap-y-1 text-sm">
          <dt className="text-dim">{t('inbox.source')}</dt>
          <dd>{entry.incident.source}</dd>
          <dt className="text-dim">{t('inbox.agentRole')}</dt>
          <dd>{entry.incident.agentRole}</dd>
          {entry.incident.capability && (
            <>
              <dt className="text-dim">{t('inbox.capability')}</dt>
              <dd>
                <code className="rounded bg-panel-2 px-1 text-xs">{entry.incident.capability}</code>
              </dd>
            </>
          )}
          <dt className="text-dim">{t('inbox.openedAt')}</dt>
          <dd>{new Date(entry.incident.createdAt).toLocaleString()}</dd>
        </dl>
        {Object.keys(entry.incident.detail).length > 0 && (
          <pre className="max-h-48 overflow-auto rounded-ctl bg-panel-2 p-2 text-xs">
            {JSON.stringify(entry.incident.detail, null, 2)}
          </pre>
        )}
        <p className="text-xs text-dim">
          <Trans
            t={t}
            i18nKey="inbox.incidentNote"
            components={{
              ledger: <Link to={`${base}/trust` as never} className="text-brand hover:underline" />,
            }}
          />
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <h2 className="inline-flex items-center gap-2 t-section">
        <AlertTriangle className="h-4 w-4 text-bad" /> {t('inbox.intentError')}
      </h2>
      <dl className="grid grid-cols-[8rem_1fr] gap-y-1 text-sm">
        <dt className="text-dim">{t('inbox.intent')}</dt>
        <dd>
          <Link
            to={`${base}/intents/${entry.intent.id}` as never}
            className="text-brand hover:underline"
          >
            {entry.intent.name}
          </Link>
        </dd>
        <dt className="text-dim">{t('inbox.collection')}</dt>
        <dd>
          <code className="rounded bg-panel-2 px-1 text-xs">{entry.intent.collection}</code>
        </dd>
        {entry.intent.statusReason && (
          <>
            <dt className="text-dim">{t('inbox.reason')}</dt>
            <dd>{entry.intent.statusReason}</dd>
          </>
        )}
      </dl>
      <button
        type="button"
        onClick={() => resumeMutation.mutate(entry.intent.id)}
        disabled={resumeMutation.isPending}
        className="rounded-ctl border border-line px-3 py-2 text-sm hover:bg-panel-2 disabled:opacity-50"
      >
        {resumeMutation.isPending ? t('inbox.resuming') : t('inbox.resumeIntent')}
      </button>
    </div>
  );
}

function InboxBody() {
  const { t } = useTranslation('agents');
  const { entries, isLoading } = useInboxData();
  const [selectedId, select] = useSelectedEntryId();
  const selected = entries.find((e) => e.id === selectedId);

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[2fr_3fr]">
      <div>
        <ExceptionInbox onOpenEntry={(entry) => select(entry.id)} />
      </div>
      <aside className="rounded-card border border-line bg-panel p-4">
        {selected ? (
          <EntryDetail key={selected.id} entry={selected} />
        ) : selectedId && !isLoading ? (
          <p className="text-sm text-dim">
            {t('inbox.gone')}
          </p>
        ) : (
          <div className="flex flex-col items-center gap-2 py-10 text-center text-dim">
            <Inbox className="h-5 w-5" />
            <p className="text-sm">{t('inbox.selectEntry')}</p>
          </div>
        )}
      </aside>
    </div>
  );
}

export function InboxPage() {
  return (
    <MissionControlLayout>
      <InboxBody />
    </MissionControlLayout>
  );
}
