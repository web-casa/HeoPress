import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ClipboardCheck } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { siteKey } from '../api';
import { EmptyState } from '../ui/empty-state';
import { PageHeader } from '../ui/page-header';
import { Skeleton } from '../ui/skeleton';
import { aiApi, type BatchAction, type BatchResult, type GateCheck, type QueueEntry } from './api';

/**
 * The AI review queue (HeoPress P09 task 2.3; spec ai/quality-gate "人工审核结论与发布守卫", ai/auto-publish): what the
 * pipeline proposed and could not publish on its own, with the gate's score, each check's evidence and suggestions.
 * Several entries are decided at once — approve (the gate result, for the version it checked), reject, dismiss, veto —
 * and each entry's result is shown, failures included.
 */

const STATUS_TONE: Record<GateCheck['status'], string> = {
  passed: 'text-ok',
  warning: 'text-warn',
  needs_review: 'text-warn',
  blocked: 'text-bad',
  off: 't-aux',
};

/** Which actions fit an entry (the server checks again). */
export function actionsFor(entry: QueueEntry): BatchAction[] {
  if (entry.status === 'veto_window' || entry.status === 'queued') return ['veto'];
  return entry.gate.state === 'needs_review' ? ['approve', 'reject', 'dismiss'] : ['dismiss'];
}

function CheckList({ checks }: { checks: GateCheck[] }) {
  const { t } = useTranslation('ai');
  return (
    <ul className="flex flex-col gap-2">
      {checks
        .filter((c) => c.status !== 'off')
        .map((c) => (
          <li key={c.rule} className="rounded-ctl border border-line p-3" data-testid={`gate-check-${c.rule}`}>
            <div className="flex flex-wrap items-center gap-2 text-[13px]">
              <code>{c.rule}</code>
              <span className={STATUS_TONE[c.status]}>{t(`checkStatus.${c.status}`)}</span>
              <span className="t-aux">{t('review.score', { score: c.score })}</span>
              {c.mandatory ? <span className="t-aux">{t('review.mandatory')}</span> : null}
            </div>
            {c.suggestions.length ? (
              <ul className="mt-1 list-disc pl-5 t-body">
                {c.suggestions.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            ) : null}
            {c.status !== 'passed' && Object.keys(c.evidence).length ? (
              <details className="mt-1">
                <summary className="cursor-pointer t-aux">{t('review.evidence')}</summary>
                <pre className="mt-1 max-h-60 overflow-auto rounded-ctl bg-panel-2 p-2 text-[12px]">{JSON.stringify(c.evidence, null, 2)}</pre>
              </details>
            ) : null}
          </li>
        ))}
    </ul>
  );
}

export function ReviewQueuePage() {
  const { t } = useTranslation('ai');
  const qc = useQueryClient();
  const queue = useQuery({ queryKey: siteKey('ai-review-queue'), queryFn: aiApi.reviewQueue });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [results, setResults] = useState<{ list: BatchResult[]; titles: Record<string, string> } | null>(null);
  const [missingReason, setMissingReason] = useState(false);

  const decide = useMutation({
    mutationFn: async (action: BatchAction) => {
      // Titles as they are now: an approved entry is proposed again under a new id.
      const titles = Object.fromEntries(entries.filter((e) => selected.has(e.id)).map((e) => [e.id, e.title || e.itemId]));
      return { list: await aiApi.decide(action, [...selected], reason.trim()), titles };
    },
    onSuccess: async (r) => {
      setResults(r);
      setSelected(new Set());
      await qc.invalidateQueries({ queryKey: siteKey('ai-review-queue') });
    },
  });

  const entries = queue.data ?? [];
  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const act = (action: BatchAction) => {
    if (!reason.trim()) {
      setMissingReason(true);
      return;
    }
    setMissingReason(false);
    decide.mutate(action);
  };

  return (
    <>
      <PageHeader title={t('review.title')} description={t('review.description')} />
      {queue.isLoading ? (
        <Skeleton className="h-48" />
      ) : queue.error ? (
        <p role="alert" className="text-bad">
          {t('loadFailed')}
        </p>
      ) : !entries.length ? (
        <EmptyState icon={ClipboardCheck} title={t('review.emptyTitle')} body={t('review.emptyBody')} />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2 rounded-card border border-line bg-panel p-4" role="group" aria-label={t('review.batch')}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="t-section">{t('review.selected', { n: selected.size })}</span>
              <button type="button" className="rounded-ctl border border-line px-2 py-1 text-[13px]" onClick={() => setSelected(new Set(entries.map((e) => e.id)))}>
                {t('review.selectAll')}
              </button>
            </div>
            <label htmlFor="ai-review-reason" className="text-[13px] font-medium">
              {t('review.reason')}
            </label>
            <input id="ai-review-reason" className="rounded-ctl border border-line bg-panel px-2 py-1.5 text-[13px]" value={reason} onChange={(e) => setReason(e.target.value)} aria-invalid={missingReason} />
            {missingReason ? (
              <p role="alert" className="text-[13px] text-bad">
                {t('review.reasonRequired')}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {(['approve', 'reject', 'dismiss', 'veto'] as const).map((a) => (
                <button
                  key={a}
                  type="button"
                  disabled={!selected.size || decide.isPending}
                  onClick={() => act(a)}
                  className={a === 'approve' ? 'rounded-ctl bg-brand px-3 py-1.5 text-[13px] text-brand-fg disabled:opacity-50' : 'rounded-ctl border border-line px-3 py-1.5 text-[13px] disabled:opacity-50'}
                >
                  {t(`review.actions.${a}`)}
                </button>
              ))}
            </div>
            {decide.error ? (
              <p role="alert" className="text-[13px] text-bad">
                {t('review.failed', { reason: decide.error instanceof Error ? decide.error.message : String(decide.error) })}
              </p>
            ) : null}
          </div>
          {results ? (
            <section aria-label={t('review.results')} className="rounded-card border border-line bg-panel p-4">
              <h2 className="t-section">{t('review.results')}</h2>
              <ul className="mt-2 flex flex-col gap-1 t-body">
                {results.list.map((r) => (
                  <li key={r.id} data-testid="ai-review-result">
                    <span className={r.ok ? 'text-ok' : 'text-bad'}>{r.ok ? t('review.resultOk') : t('review.resultFailed')}</span> {results.titles[r.id] ?? r.id} —{' '}
                    {r.ok ? t('review.resultStatus', { status: r.status, reason: r.reason ?? '' }) : `${r.error?.code}: ${r.error?.message}`}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <ul className="flex flex-col gap-2">
            {entries.map((e) => (
              <li key={e.id} className="rounded-card border border-line bg-panel p-4" data-testid="ai-review-entry">
                <div className="flex flex-wrap items-center gap-3">
                  <input type="checkbox" aria-label={t('review.select', { title: e.title || e.itemId })} checked={selected.has(e.id)} onChange={() => toggle(e.id)} />
                  <span className="min-w-0 flex-1 truncate t-section">{e.title || e.itemId}</span>
                  <span className="t-aux">{t(`queueStatus.${e.status}`)}</span>
                  <span className="t-aux">{t('review.reasonCode', { reason: e.reason })}</span>
                  <span data-testid="ai-review-score" className="text-[13px]">
                    {e.gate.result ? t('review.score', { score: e.gate.result.score }) : t('review.noGate')}
                  </span>
                  <span className="t-aux">{t('review.gateState', { state: t(`gateState.${e.gate.state}`) })}</span>
                  <button type="button" className="rounded-ctl border border-line px-2 py-1 text-[13px]" aria-expanded={open === e.id} onClick={() => setOpen(open === e.id ? null : e.id)}>
                    {open === e.id ? t('review.hide') : t('review.details')}
                  </button>
                </div>
                <p className="mt-1 t-aux">{t('review.fits', { actions: actionsFor(e).map((a) => t(`review.actions.${a}`)).join(' · ') })}</p>
                {open === e.id ? (
                  <div className="mt-3">
                    {e.detail.failures?.length ? <p className="mb-2 t-body">{t('review.conditions', { list: e.detail.failures.map((f) => f.reason).join(', ') })}</p> : null}
                    {e.gate.staleReasons.length ? <p className="mb-2 t-body">{t('review.stale', { list: e.gate.staleReasons.join(', ') })}</p> : null}
                    {e.gate.result ? <CheckList checks={e.gate.result.checks} /> : <p className="t-aux">{t('review.noGate')}</p>}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
