// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle, Clock, ShieldAlert, XCircle } from 'lucide-react';
import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { cn } from '@/lib/cn';
import { missionControlApi } from './api';
import { useInboxData, type InboxEntry } from './use-inbox';

/**
 * Exception Inbox (content-os task 17.1; Req 16.1, 16.2, 13.6 ·
 * content-os-ui task 1.2; Req 3.6). Compact list with inline actions —
 * embedded on the dashboard (with `limit`) and reused as the list pane of
 * the full inbox page (with `onOpenEntry`).
 */

interface ExceptionInboxProps {
  /** Show only the N most urgent entries (dashboard preview). */
  limit?: number;
  /** When set, each entry gets an "Open" affordance for the detail pane. */
  onOpenEntry?: (entry: InboxEntry) => void;
}

export function invalidateInboxQueries(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ queryKey: ['mc-approvals'] });
  void queryClient.invalidateQueries({ queryKey: ['mc-staged'] });
  void queryClient.invalidateQueries({ queryKey: ['mc-autonomy'] });
  void queryClient.invalidateQueries({ queryKey: ['mc-intents'] });
}

function Countdown({ deadline }: { deadline: string }) {
  const { t } = useTranslation('agents');
  const remaining = new Date(deadline).getTime() - Date.now();
  if (remaining <= 0) return <span className="text-destructive">{t('inbox.committing')}</span>;
  const minutes = Math.floor(remaining / 60_000);
  const hours = Math.floor(minutes / 60);
  return (
    <span className={cn('font-mono', remaining < 30 * 60_000 ? 'text-destructive' : 'text-amber-600')}>
      {t('inbox.left', { time: hours > 0 ? t('inbox.hoursMinutes', { h: hours, m: minutes % 60 }) : t('inbox.minutes', { m: minutes }) })}
    </span>
  );
}

export function ExceptionInbox({ limit, onOpenEntry }: ExceptionInboxProps) {
  const { t } = useTranslation('agents');
  const queryClient = useQueryClient();
  const [diffOpen, setDiffOpen] = useState<string | null>(null);

  const { entries: allEntries, isLoading } = useInboxData();

  const invalidate = () => invalidateInboxQueries(queryClient);

  const decideMutation = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'approved' | 'rejected' }) =>
      missionControlApi.decideApproval(id, decision),
    onSuccess: invalidate,
  });
  const vetoMutation = useMutation({
    mutationFn: (approvalId: string) => missionControlApi.veto(approvalId, 'Vetoed from Mission Control'),
    onSuccess: invalidate,
  });
  const resumeMutation = useMutation({
    mutationFn: (id: string) => missionControlApi.resumeIntent(id),
    onSuccess: invalidate,
  });

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">{t('inbox.loading')}</p>;
  }

  const entries = limit ? allEntries.slice(0, limit) : allEntries;

  // In split-pane mode every entry gets an explicit open affordance.
  const openButton = (entry: InboxEntry) =>
    onOpenEntry ? (
      <button
        type="button"
        onClick={() => onOpenEntry(entry)}
        className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
      >
        {t('inbox.details')}
      </button>
    ) : null;

  if (entries.length === 0) {
    return (
      <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-800">
        <CheckCircle className="mr-2 inline h-4 w-4" />
        {t('inbox.zero')}
      </div>
    );
  }

  return (
    <ul className="space-y-2">
      {entries.map((entry) => (
        <li key={entry.id} className="rounded-lg border bg-background p-3">
          {entry.kind === 'veto' && (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="inline-flex items-center gap-2 text-sm font-medium">
                  <Clock className="h-4 w-4 text-amber-600" />
                  <Trans
                    t={t}
                    i18nKey="inbox.stagedOn"
                    values={{
                      target: `${String(entry.veto.collection ?? '?')}/${String(entry.veto.itemId ?? '?')}`,
                      role: entry.veto.agentRole != null ? String(entry.veto.agentRole) : t('inbox.agentFallback'),
                    }}
                    components={{ code: <code className="rounded bg-muted px-1 text-xs" /> }}
                  />{' '}
                  <Countdown deadline={entry.veto.autoCommitAt} />
                </span>
                <span className="flex gap-2">
                  {onOpenEntry ? (
                    <button
                      type="button"
                      onClick={() => onOpenEntry(entry)}
                      className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
                    >
                      {t('inbox.viewDiff')}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setDiffOpen(diffOpen === entry.id ? null : entry.id)}
                      className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
                    >
                      {diffOpen === entry.id ? t('inbox.hideDiff') : t('inbox.viewDiff')}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => vetoMutation.mutate(String(entry.veto.approvalId ?? entry.veto.id))}
                    disabled={vetoMutation.isPending}
                    className="rounded-md border border-destructive/40 px-2 py-1 text-xs text-destructive hover:bg-destructive/10"
                  >
                    {t('inbox.veto')}
                  </button>
                </span>
              </div>
              {!onOpenEntry && diffOpen === entry.id && (
                <pre className="max-h-48 overflow-auto rounded-md bg-muted/40 p-2 text-xs">
                  {JSON.stringify(entry.veto.patch ?? entry.veto, null, 2)}
                </pre>
              )}
            </div>
          )}

          {entry.kind === 'approval' && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm">
                <ShieldAlert className="mr-1 inline h-4 w-4 text-sky-600" />
                <Trans
                  t={t}
                  i18nKey="inbox.approvalFrom"
                  values={{ subject: entry.approval.subjectType, agent: entry.approval.requestedByAgent }}
                  components={{ strong: <strong /> }}
                />
                <span className="ml-2 text-xs text-muted-foreground">
                  {new Date(entry.approval.createdAt).toLocaleString()}
                </span>
              </span>
              <span className="flex gap-2">
                {openButton(entry)}
                <button
                  type="button"
                  onClick={() => decideMutation.mutate({ id: entry.approval.id, decision: 'approved' })}
                  disabled={decideMutation.isPending}
                  className="inline-flex items-center gap-1 rounded-md border border-emerald-400 px-2 py-1 text-xs text-emerald-700 hover:bg-emerald-50"
                >
                  <CheckCircle className="h-3 w-3" /> {t('inbox.approve')}
                </button>
                <button
                  type="button"
                  onClick={() => decideMutation.mutate({ id: entry.approval.id, decision: 'rejected' })}
                  disabled={decideMutation.isPending}
                  className="inline-flex items-center gap-1 rounded-md border border-destructive/40 px-2 py-1 text-xs text-destructive hover:bg-destructive/10"
                >
                  <XCircle className="h-3 w-3" /> {t('inbox.reject')}
                </button>
              </span>
            </div>
          )}

          {entry.kind === 'incident' && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm">
                <AlertTriangle
                  className={cn(
                    'mr-1 inline h-4 w-4',
                    entry.incident.severity === 'high' ? 'text-destructive' : 'text-amber-600',
                  )}
                />
                {t('inbox.incidentLine', {
                  severity: t(`severity.${entry.incident.severity}`, { defaultValue: entry.incident.severity }),
                  source: entry.incident.source,
                  role: entry.incident.agentRole,
                })}
                {entry.incident.capability ? ` / ${entry.incident.capability}` : ''}
                <span className="ml-2 text-xs text-muted-foreground">
                  {new Date(entry.incident.createdAt).toLocaleString()}
                </span>
              </span>
              {openButton(entry)}
            </div>
          )}

          {entry.kind === 'intent_error' && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm">
                <AlertTriangle className="mr-1 inline h-4 w-4 text-destructive" />
                <Trans t={t} i18nKey="inbox.intentErrorLine" values={{ name: entry.intent.name }} components={{ strong: <strong /> }} />
                {entry.intent.statusReason && (
                  <span className="ml-2 text-xs text-muted-foreground">{entry.intent.statusReason}</span>
                )}
              </span>
              <span className="flex gap-2">
                {openButton(entry)}
                <button
                  type="button"
                  onClick={() => resumeMutation.mutate(entry.intent.id)}
                  disabled={resumeMutation.isPending}
                  className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
                >
                  {t('inbox.resume')}
                </button>
              </span>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
