import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { HeoPressError } from '@heopress/sdk';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '@/workspace/ui/page-header';
import { consumersApi, type ConsumerOverview, type ReconciliationReport } from '../api';

/**
 * Logs & monitoring › Event consumers (HeoPress P11 tasks 1.1, 1.2; spec publishing/event-consumers): each framework
 * consumer's backlog and failures, its dead letters, replay from a chosen time or event, and the last state
 * reconciliation report with a button to run one. The instance administrator's view (others get 403).
 */

const STATUS_CLASS: Record<string, string> = {
  ok: 'bg-panel-2 text-dim',
  repaired: 'bg-ok-soft text-ok',
  drift: 'bg-warn-soft text-warn',
  failed: 'bg-bad-soft text-bad',
  not_configured: 'bg-panel-2 text-dim',
};

const BUTTON = 'inline-flex h-8 items-center gap-1 rounded-ctl border border-line px-2 text-[13px] hover:bg-panel-2 disabled:opacity-50';

function Backlog({ c }: { c: ConsumerOverview }) {
  const { t } = useTranslation('monitoring');
  if (!c.pending) return <span className="text-dim">{t('consumers.caughtUp')}</span>;
  const text = c.backlogSeconds >= 60 ? t('consumers.minutes', { count: Math.floor(c.backlogSeconds / 60) }) : t('consumers.seconds', { count: c.backlogSeconds });
  return (
    <span className={c.overThreshold ? 'font-medium text-bad' : ''}>
      {text}
      {c.overThreshold ? <span className="sr-only"> — {t('consumers.overThreshold', { minutes: 10 })}</span> : null}
    </span>
  );
}

function errorText(err: unknown): string {
  return err instanceof HeoPressError ? err.message : String(err);
}

function DeadLetters({ name }: { name: string }) {
  const { t } = useTranslation('monitoring');
  const qc = useQueryClient();
  const letters = useQuery({ queryKey: ['consumers', 'dead-letters', name], queryFn: () => consumersApi.deadLetters(name) });
  const replay = useMutation({
    mutationFn: (eventId: string) => consumersApi.replay(name, { eventId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['consumers'] }),
  });
  return (
    <section aria-label={t('consumers.show', { name })} className="space-y-2">
      <h2 className="t-section">{t('consumers.show', { name })}</h2>
      {letters.data && letters.data.length === 0 ? <p className="text-sm text-dim">{t('consumers.noDeadLetters')}</p> : null}
      {letters.data?.length ? (
        <ul className="divide-y divide-line rounded-ctl border border-line text-sm">
          {letters.data.map((d) => (
            <li key={d.eventId} className="space-y-1 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${d.state === 'dead' ? 'bg-bad-soft text-bad' : 'bg-warn-soft text-warn'}`}>{d.state}</span>
                <code className="text-xs">{d.eventId}</code>
                <span className="text-xs text-dim">
                  {d.event ? `${d.event.operation} ${d.event.collection}/${d.event.itemId} · ${new Date(d.event.occurredAt).toLocaleString()}` : t('consumers.pruned')}
                </span>
                <span className="text-xs text-dim">
                  {t('consumers.attempts')}: {d.attempts}
                </span>
              </div>
              {d.lastError ? (
                <p className="text-xs">
                  {t('consumers.error')}: <code>{d.lastError}</code>
                </p>
              ) : null}
              {d.event ? (
                <button type="button" className={BUTTON} disabled={replay.isPending} onClick={() => replay.mutate(d.eventId)}>
                  {t('consumers.replayFromEvent')}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {replay.isSuccess ? <p role="status">{t('consumers.replayed', { count: replay.data.events })}</p> : null}
      {replay.error ? <p role="alert" className="text-bad">{t('consumers.refused', { reason: errorText(replay.error) })}</p> : null}
    </section>
  );
}

function Report({ report }: { report: ReconciliationReport }) {
  const { t } = useTranslation('monitoring');
  return (
    <div className="space-y-2">
      <p className="text-sm text-dim">{t('consumers.reportAt', { date: new Date(report.startedAt).toLocaleString(), trigger: report.trigger })}</p>
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-dim">
          <tr>
            <th className="py-1 pr-3 font-medium">{t('consumers.reconciler')}</th>
            <th className="py-1 pr-3 font-medium">{t('consumers.status')}</th>
            <th className="py-1 pr-3 font-medium">{t('consumers.checked')}</th>
            <th className="py-1 pr-3 font-medium">{t('consumers.repaired')}</th>
            <th className="py-1 font-medium">{t('consumers.detail')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {report.results.map((r) => (
            <tr key={r.name}>
              <td className="py-1.5 pr-3">
                <code>{r.name}</code>
              </td>
              <td className="py-1.5 pr-3">
                <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${STATUS_CLASS[r.status] ?? ''}`}>{t(`consumers.resultStatus.${r.status}`)}</span>
              </td>
              <td className="py-1.5 pr-3 tabular-nums">{r.checked}</td>
              <td className="py-1.5 pr-3 tabular-nums">{r.repaired}</td>
              <td className="py-1.5 text-xs text-dim">{r.detail ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ConsumersPage() {
  const { t } = useTranslation('monitoring');
  const qc = useQueryClient();
  const fromId = useId();
  const consumers = useQuery({ queryKey: ['consumers', 'list'], queryFn: consumersApi.list, refetchInterval: 15_000, retry: false });
  const report = useQuery({ queryKey: ['consumers', 'report'], queryFn: consumersApi.report, retry: false });
  const [selected, setSelected] = useState<string | null>(null);
  const [from, setFrom] = useState('');
  const replay = useMutation({
    mutationFn: () => consumersApi.replay(selected!, { from: new Date(from).toISOString() }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['consumers'] }),
  });
  const reconcile = useMutation({
    mutationFn: consumersApi.reconcile,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['consumers'] }),
  });
  const forbidden = consumers.error instanceof HeoPressError && consumers.error.status === 403;

  return (
    <div className="space-y-6">
      <PageHeader title={t('consumers.title')} description={t('consumers.description')} />
      {forbidden ? (
        <p role="alert" className="text-sm text-bad">
          {t('consumers.adminOnly')}
        </p>
      ) : consumers.isError ? (
        <p role="alert" className="text-sm text-bad">
          {t('consumers.loadFailed')}
        </p>
      ) : null}

      {consumers.data ? (
        <section aria-label={t('consumers.list')}>
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-dim">
              <tr>
                <th className="py-1 pr-3 font-medium">{t('consumers.name')}</th>
                <th className="py-1 pr-3 font-medium">{t('consumers.status')}</th>
                <th className="py-1 pr-3 font-medium">{t('consumers.backlog')}</th>
                <th className="py-1 pr-3 font-medium">{t('consumers.pending')}</th>
                <th className="py-1 pr-3 font-medium">{t('consumers.failures')}</th>
                <th className="py-1 font-medium">{t('consumers.lastRun')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {consumers.data.map((c) => (
                <tr key={c.name} aria-current={selected === c.name ? 'true' : undefined} className={selected === c.name ? 'bg-panel-2' : ''}>
                  <td className="py-1.5 pr-3">
                    <button type="button" className="text-left text-brand hover:underline" onClick={() => setSelected(c.name)}>
                      {c.name}
                    </button>
                  </td>
                  <td className="py-1.5 pr-3" title={c.pausedReason ?? undefined}>
                    {c.status}
                  </td>
                  <td className="py-1.5 pr-3">
                    <Backlog c={c} />
                  </td>
                  <td className="py-1.5 pr-3 tabular-nums">
                    {c.pending}
                    {c.pendingCapped ? '+' : ''}
                  </td>
                  <td className={`py-1.5 pr-3 tabular-nums ${c.failures.dead ? 'text-bad' : ''}`}>
                    {c.failures.retrying} / {c.failures.dead} / {c.failures.unknown}
                  </td>
                  <td className="py-1.5 text-xs text-dim">{c.lastRunAt ? new Date(c.lastRunAt).toLocaleString() : t('consumers.never')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {selected ? (
        <>
          <form
            className="flex flex-wrap items-center gap-3 text-sm"
            onSubmit={(e) => {
              e.preventDefault();
              if (from) replay.mutate();
            }}
          >
            <label htmlFor={fromId}>{t('consumers.replayFrom')}</label>
            <input
              id={fromId}
              type="datetime-local"
              className="rounded-ctl border border-line bg-bg px-2.5 py-1.5 text-[13px] outline-none focus:border-brand"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
            <button type="submit" className={BUTTON} disabled={!from || replay.isPending}>
              {t('consumers.replay')}
            </button>
            {replay.isSuccess ? (
              <p role="status">{replay.data.events ? t('consumers.replayed', { count: replay.data.events }) : t('consumers.nothingToReplay')}</p>
            ) : null}
            {replay.error ? (
              <p role="alert" className="text-bad">
                {t('consumers.refused', { reason: errorText(replay.error) })}
              </p>
            ) : null}
          </form>
          <DeadLetters key={selected} name={selected} />
        </>
      ) : null}

      {!forbidden ? (
        <section aria-label={t('consumers.reconciliation')} className="space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="t-section">{t('consumers.reconciliation')}</h2>
            <button type="button" className={BUTTON} disabled={reconcile.isPending} onClick={() => reconcile.mutate()}>
              {reconcile.isPending ? t('consumers.running') : t('consumers.runNow')}
            </button>
          </div>
          {reconcile.error ? (
            <p role="alert" className="text-bad">
              {errorText(reconcile.error)}
            </p>
          ) : null}
          {report.data ? <Report report={report.data} /> : report.isSuccess ? <p className="text-sm text-dim">{t('consumers.noReport')}</p> : null}
        </section>
      ) : null}
    </div>
  );
}
