import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  FETCH_CHAIN_STEPS,
  LICENCE_LAPSE_POLICIES,
  type FetchChainStep,
  type IngestSiteSettingsResource,
  type IngestSourceResource,
  type LicenceLapsePolicy,
  type LicenceReviewResource,
} from '@heopress/contracts/schemas';
import { getApiClient } from '@/lib/api';
import { siteKey } from '../api';
import { inputClass } from '../seo/seo-kit';
import { RelativeTime } from '../ui/relative-time';
import { Skeleton } from '../ui/skeleton';

/**
 * Content › Sources panels for what comes after registration (HeoPress P08 tasks 1.6, 1.7, 3.3): a source's own
 * fallback order, the site's ingestion settings (licence-lapse policy, primary-source allow-list) and the licence
 * review queue. The server decides every permission; these only hide what would be refused.
 */

const errorText = (err: unknown) => {
  const body = (err as { body?: { errors?: Array<{ message?: string }> } }).body;
  return body?.errors?.[0]?.message ?? (err instanceof Error ? err.message : String(err));
};

const panel = 'mb-5 flex flex-col gap-3 rounded-card border border-line bg-panel p-4';
const btn = 'rounded-ctl border border-line px-2.5 py-1 text-[13px] hover:bg-panel-2 disabled:opacity-50';
const primary = 'rounded-ctl bg-brand px-3 py-1.5 text-[13px] text-brand-fg disabled:opacity-50';

function Failure({ text }: { text: string | null }) {
  return text ? (
    <p role="alert" className="rounded-ctl border border-bad/40 bg-bad-soft px-3 py-2 text-[13px] text-bad">
      {text}
    </p>
  ) : null;
}

/** A source's own fallback order (`GET/PUT /ingest/providers/chains/:sourceId`): steps in order, or the site default. */
export function FallbackChainEditor({ source, canEdit, onClose }: { source: IngestSourceResource; canEdit: boolean; onClose: () => void }) {
  const { t } = useTranslation('sources');
  const qc = useQueryClient();
  const client = getApiClient();
  const path = `/api/v1/ingest/providers/chains/${encodeURIComponent(source.id)}`;
  const key = siteKey('ingest-chain', source.id);
  const chain = useQuery({ queryKey: key, queryFn: async () => (await client.rawRequest<{ chain: FetchChainStep[]; custom: boolean }>(path)).data });
  const [draft, setDraft] = useState<FetchChainStep[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const steps = draft ?? chain.data?.chain ?? [];
  const save = useMutation({
    mutationFn: (next: FetchChainStep[] | null) => client.rawRequest(path, { method: 'PUT', body: JSON.stringify({ chain: next }) }),
    onSuccess: () => {
      setDraft(null);
      setFailure(null);
      void qc.invalidateQueries({ queryKey: key });
    },
    onError: (err) => setFailure(errorText(err)),
  });
  const move = (i: number, by: -1 | 1) => {
    const next = [...steps];
    const [s] = next.splice(i, 1);
    next.splice(i + by, 0, s!);
    setDraft(next);
  };
  const unused = FETCH_CHAIN_STEPS.filter((s) => !steps.includes(s));
  return (
    <section aria-label={t('chain.title')} className={panel}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="t-section">
          {t('chain.title')} · {source.name}
        </h2>
        <button type="button" onClick={onClose} className={btn}>
          {t('history.close')}
        </button>
      </div>
      <p className="t-aux">{t('chain.description')}</p>
      {chain.isLoading ? (
        <Skeleton className="h-16" />
      ) : (
        <>
          <p className="t-aux" data-chain-mode>
            {chain.data?.custom ? t('chain.custom') : t('chain.default')}
          </p>
          <ol aria-label={t('chain.order')} className="flex flex-col gap-1 text-[13px]">
            {steps.map((s, i) => (
              <li key={s} data-step={s} className="flex items-center gap-2">
                <span className="w-5 text-dim">{i + 1}.</span>
                <span className="min-w-[140px] font-medium">{t(`chain.step.${s}`)}</span>
                {canEdit ? (
                  <>
                    <button type="button" className={btn} disabled={i === 0} aria-label={t('chain.up', { step: t(`chain.step.${s}`) })} onClick={() => move(i, -1)}>
                      ↑
                    </button>
                    <button type="button" className={btn} disabled={i === steps.length - 1} aria-label={t('chain.down', { step: t(`chain.step.${s}`) })} onClick={() => move(i, 1)}>
                      ↓
                    </button>
                    <button type="button" className={btn} disabled={steps.length === 1} onClick={() => setDraft(steps.filter((x) => x !== s))}>
                      {t('chain.remove')}
                    </button>
                  </>
                ) : null}
              </li>
            ))}
          </ol>
          {canEdit ? (
            <div className="flex flex-wrap gap-2">
              {unused.map((s) => (
                <button key={s} type="button" className={btn} onClick={() => setDraft([...steps, s])}>
                  {t('chain.add', { step: t(`chain.step.${s}`) })}
                </button>
              ))}
            </div>
          ) : null}
          <Failure text={failure} />
          {canEdit ? (
            <div className="flex gap-2">
              <button type="button" className={primary} disabled={!draft || save.isPending} onClick={() => save.mutate(steps)}>
                {t('chain.save')}
              </button>
              <button type="button" className={btn} disabled={!chain.data?.custom || save.isPending} onClick={() => save.mutate(null)}>
                {t('chain.useDefault')}
              </button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

/** The site's ingestion settings: what a licence lapse does to derived content, and the primary-source allow-list. */
export function IngestSettingsPanel({ canEdit, onClose }: { canEdit: boolean; onClose: () => void }) {
  const { t } = useTranslation('sources');
  const qc = useQueryClient();
  const client = getApiClient();
  const uid = useId();
  const key = siteKey('ingest-settings');
  const settings = useQuery({ queryKey: key, queryFn: async () => (await client.rawRequest<IngestSiteSettingsResource>('/api/v1/ingest/settings')).data });
  const [policy, setPolicy] = useState<LicenceLapsePolicy | null>(null);
  const [patterns, setPatterns] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: () =>
      client.rawRequest('/api/v1/ingest/settings', {
        method: 'PUT',
        body: JSON.stringify({
          licenceLapsePolicy: policy ?? settings.data?.licenceLapsePolicy ?? 'hide',
          primarySourcePatterns: (patterns ?? settings.data?.primarySourcePatterns.join('\n') ?? '')
            .split(/\s*\n\s*/)
            .map((p) => p.trim())
            .filter(Boolean),
        }),
      }),
    onSuccess: () => {
      setFailure(null);
      setSaved(true);
      void qc.invalidateQueries({ queryKey: key });
    },
    onError: (err) => {
      setSaved(false);
      setFailure(errorText(err));
    },
  });
  return (
    <section aria-label={t('settings.title')} className={panel}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="t-section">{t('settings.title')}</h2>
        <button type="button" onClick={onClose} className={btn}>
          {t('history.close')}
        </button>
      </div>
      {settings.isLoading || !settings.data ? (
        <Skeleton className="h-24" />
      ) : (
        <form
          aria-label={t('settings.title')}
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <div className="flex flex-col gap-1 text-[13px]">
            <label htmlFor={`${uid}-policy`} className="font-medium">
              {t('settings.policy')}
            </label>
            <select
              id={`${uid}-policy`}
              className={inputClass}
              disabled={!canEdit}
              value={policy ?? settings.data.licenceLapsePolicy}
              onChange={(e) => setPolicy(e.target.value as LicenceLapsePolicy)}
            >
              {LICENCE_LAPSE_POLICIES.map((p) => (
                <option key={p} value={p}>
                  {t(`settings.policies.${p}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1 text-[13px]">
            <label htmlFor={`${uid}-patterns`} className="font-medium">
              {t('settings.patterns')}
            </label>
            <textarea
              id={`${uid}-patterns`}
              rows={4}
              className={`${inputClass} font-mono`}
              readOnly={!canEdit}
              value={patterns ?? settings.data.primarySourcePatterns.join('\n')}
              aria-describedby={`${uid}-patterns-hint`}
              onChange={(e) => setPatterns(e.target.value)}
            />
            <span id={`${uid}-patterns-hint`} className="t-aux">
              {t('settings.patternsHint')}
            </span>
          </div>
          <Failure text={failure} />
          {saved ? (
            <p role="status" className="t-aux">
              {t('settings.saved')}
            </p>
          ) : null}
          {canEdit ? (
            <div>
              <button type="submit" className={primary} disabled={save.isPending}>
                {t('settings.save')}
              </button>
            </div>
          ) : null}
        </form>
      )}
    </section>
  );
}

/** The licence review queue: content hidden (or flagged) because its source's licence lapsed; restore or dismiss. */
export function LicenceReviewPanel({ canEdit, onClose }: { canEdit: boolean; onClose: () => void }) {
  const { t } = useTranslation('sources');
  const qc = useQueryClient();
  const client = getApiClient();
  const key = siteKey('ingest-licence-reviews');
  const reviews = useQuery({ queryKey: key, queryFn: async () => (await client.rawRequest<LicenceReviewResource[]>('/api/v1/ingest/licence-reviews')).data });
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [failure, setFailure] = useState<string | null>(null);
  const resolve = useMutation({
    mutationFn: async ({ ids, decision }: { ids: string[]; decision: 'restore' | 'dismiss' }) =>
      (await client.rawRequest<{ resolved: string[]; refused: Array<{ id: string; message: string }> }>('/api/v1/ingest/licence-reviews/resolve', {
        method: 'POST',
        body: JSON.stringify({ ids, decision }),
      })).data,
    onSuccess: (out) => {
      setPicked(new Set());
      setFailure(out.refused.length ? out.refused.map((r) => r.message).join(' ') : null);
      void qc.invalidateQueries({ queryKey: key });
    },
    onError: (err) => setFailure(errorText(err)),
  });
  const toggle = (id: string) => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
  };
  return (
    <section aria-label={t('reviews.title')} className={panel}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="t-section">{t('reviews.title')}</h2>
        <button type="button" onClick={onClose} className={btn}>
          {t('history.close')}
        </button>
      </div>
      <p className="t-aux">{t('reviews.description')}</p>
      {reviews.isLoading ? (
        <Skeleton className="h-16" />
      ) : !reviews.data?.length ? (
        <p className="t-aux">{t('reviews.empty')}</p>
      ) : (
        <ul className="flex flex-col gap-1.5 text-[13px]">
          {reviews.data.map((r) => (
            <li key={r.id} data-review={r.id} className="flex flex-wrap items-center gap-2 border-b border-line pb-1.5 last:border-0">
              {canEdit ? <input type="checkbox" aria-label={t('reviews.pick', { title: r.title ?? r.itemId })} checked={picked.has(r.id)} onChange={() => toggle(r.id)} /> : null}
              <span className="font-medium">{r.title ?? r.itemId}</span>
              <span className="t-aux">
                {t(`reviews.action.${r.action}`)} · {t(`reviews.reason.${r.reason}`)} · {r.sourceName ?? r.sourceId} · <RelativeTime value={r.detectedAt} />
              </span>
              <span className={r.licenceEffective ? 'text-ok' : 'text-warn'}>{r.licenceEffective ? t('reviews.effective') : t('reviews.notEffective')}</span>
              {canEdit ? (
                <span className="ml-auto flex gap-1">
                  <button type="button" className={btn} disabled={!r.licenceEffective || resolve.isPending} onClick={() => resolve.mutate({ ids: [r.id], decision: 'restore' })}>
                    {t('reviews.restore')}
                  </button>
                  <button type="button" className={btn} disabled={resolve.isPending} onClick={() => resolve.mutate({ ids: [r.id], decision: 'dismiss' })}>
                    {t('reviews.dismiss')}
                  </button>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <Failure text={failure} />
      {canEdit && picked.size > 0 ? (
        <div className="flex gap-2">
          <button type="button" className={primary} disabled={resolve.isPending} onClick={() => resolve.mutate({ ids: [...picked], decision: 'restore' })}>
            {t('reviews.restoreSelected', { count: picked.size })}
          </button>
        </div>
      ) : null}
    </section>
  );
}
