import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  INGEST_SOURCE_TYPES,
  LICENCE_STATUSES,
  TRUST_LEVELS,
  USAGE_MODES,
  isKnownTimeZone,
  type IngestLicenceResource,
  type IngestSourceResource,
  type IngestSourceType,
  type LicenceStatus,
  type TrustLevel,
  type UsageMode,
} from '@heopress/contracts/schemas';
import { getApiClient } from '@/lib/api';
import { cn } from '@/lib/cn';
import { usePermissions } from '@/lib/use-permissions';
import { siteKey } from '../api';
import { inputClass } from '../seo/seo-kit';
import { EmptyState } from '../ui/empty-state';
import { FieldError } from '../ui/field-error';
import { PageHeader } from '../ui/page-header';
import { RelativeTime } from '../ui/relative-time';
import { Skeleton } from '../ui/skeleton';

/**
 * Content › Sources (HeoPress P08 tasks 1.1, 1.2, 1.4, 1.5; spec ingest/sources): the site's sources with their state,
 * terms and health; adding and editing one; pausing (editors) and resuming (administrators); the licence terms, set by
 * administrators as revisions with evidence, and their history. The server decides every permission; the page only
 * hides what would be refused.
 */

const BASE = '/api/v1/ingest/sources';

const errorText = (err: unknown) => {
  const body = (err as { body?: { errors?: Array<{ message?: string }> } }).body;
  return body?.errors?.[0]?.message ?? (err instanceof Error ? err.message : String(err));
};

/** `08:00, 20:00` → `['08:00', '20:00']`; null when any part is not HH:MM. */
export function parseTimes(text: string): string[] | null {
  const parts = text.split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean);
  if (!parts.length) return null;
  const out: string[] = [];
  for (const p of parts) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(p);
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
    out.push(`${m[1]!.padStart(2, '0')}:${m[2]}`);
  }
  return [...new Set(out)].sort();
}

type Tone = 'ok' | 'warn' | 'bad' | 'dim' | 'brand';
function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  const cls: Record<Tone, string> = {
    ok: 'bg-ok-soft text-ok',
    warn: 'bg-warn-soft text-warn',
    bad: 'bg-bad-soft text-bad',
    dim: 'border border-line text-dim',
    brand: 'bg-brand-soft text-brand',
  };
  return <span className={cn('inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium', cls[tone])}>{children}</span>;
}

interface SourceDraft {
  name: string;
  type: IngestSourceType;
  url: string;
  item: string;
  link: string;
  title: string;
  times: string;
  timezone: string;
  maxItems: string;
}

const browserZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

const draftOf = (s?: IngestSourceResource): SourceDraft => ({
  name: s?.name ?? '',
  type: s?.type ?? 'rss',
  url: s?.url ?? '',
  item: s?.listSelectors?.item ?? '',
  link: s?.listSelectors?.link ?? '',
  title: s?.listSelectors?.title ?? '',
  times: s ? s.scheduleTimes.join(', ') : '08:00',
  timezone: s?.timezone ?? browserZone(),
  maxItems: String(s?.maxItemsPerRun ?? 20),
});

function SourceForm({ source, onDone }: { source?: IngestSourceResource; onDone: () => void }) {
  const { t } = useTranslation('sources');
  const qc = useQueryClient();
  const client = getApiClient();
  const [d, setD] = useState<SourceDraft>(() => draftOf(source));
  const [failure, setFailure] = useState<string | null>(null);
  const times = parseTimes(d.times);
  const zoneOk = isKnownTimeZone(d.timezone.trim());
  const set = (k: keyof SourceDraft) => (e: { target: { value: string } }) => setD({ ...d, [k]: e.target.value });

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        name: d.name.trim(),
        type: d.type,
        url: d.url.trim(),
        listSelectors: d.type === 'list_page' ? { item: d.item.trim(), link: d.link.trim(), ...(d.title.trim() ? { title: d.title.trim() } : {}) } : null,
        scheduleTimes: times ?? [],
        timezone: d.timezone.trim(),
        maxItemsPerRun: Number(d.maxItems) || 20,
      };
      return source
        ? client.rawRequest(`${BASE}/${encodeURIComponent(source.id)}`, { method: 'PATCH', body: JSON.stringify(body) })
        : client.rawRequest(BASE, { method: 'POST', body: JSON.stringify(body) });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: siteKey('ingest-sources') });
      onDone();
    },
    onError: (err) => setFailure(errorText(err)),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (times && zoneOk) save.mutate();
  };
  const label = source ? t('form.editTitle') : t('form.newTitle');
  const field = 'flex flex-col gap-1 text-[13px]';
  const uid = useId();

  return (
    <form aria-label={label} onSubmit={submit} className="mb-5 flex flex-col gap-3 rounded-card border border-line bg-panel p-4">
      <h2 className="t-section">{label}</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className={field}>
          <label htmlFor={`${uid}-form-name`} className="font-medium">
            {t('form.name')}
          </label>
          <input id={`${uid}-form-name`} className={inputClass} required value={d.name} onChange={set('name')} />
        </div>
        <div className={field}>
          <label htmlFor={`${uid}-form-type`} className="font-medium">
            {t('form.type')}
          </label>
          <select id={`${uid}-form-type`} className={inputClass} value={d.type} onChange={set('type')}>
            {INGEST_SOURCE_TYPES.map((v) => (
              <option key={v} value={v}>
                {t(`type.${v}`)}
              </option>
            ))}
          </select>
        </div>
        <div className={cn(field, 'sm:col-span-2')}>
          <label htmlFor={`${uid}-form-url`} className="font-medium">
            {t('form.url')}
          </label>
          <input id={`${uid}-form-url`} className={inputClass} type="url" required value={d.url} onChange={set('url')} />
        </div>
        {d.type === 'list_page' ? (
          <>
            <div className={field}>
              <label htmlFor={`${uid}-form-itemSelector`} className="font-medium">
                {t('form.itemSelector')}
              </label>
              <input id={`${uid}-form-itemSelector`} className={cn(inputClass, 'font-mono')} required value={d.item} onChange={set('item')} />
            </div>
            <div className={field}>
              <label htmlFor={`${uid}-form-linkSelector`} className="font-medium">
                {t('form.linkSelector')}
              </label>
              <input id={`${uid}-form-linkSelector`} className={cn(inputClass, 'font-mono')} required value={d.link} onChange={set('link')} />
            </div>
            <div className={field}>
              <label htmlFor={`${uid}-form-titleSelector`} className="font-medium">
                {t('form.titleSelector')}
              </label>
              <input id={`${uid}-form-titleSelector`} className={cn(inputClass, 'font-mono')} value={d.title} onChange={set('title')} />
            </div>
          </>
        ) : null}
        <div className={field}>
          <label htmlFor={`${uid}-form-times`} className="font-medium">
            {t('form.times')}
          </label>
          <input id={`${uid}-form-times`} className={inputClass} value={d.times} onChange={set('times')} aria-describedby="source-times-hint source-times-error" aria-invalid={!times} />
          <span id="source-times-hint" className="t-aux">
            {t('form.timesHint')}
          </span>
          {!times ? <FieldError id="source-times-error">{t('form.badTimes')}</FieldError> : null}
        </div>
        <div className={field}>
          <label htmlFor={`${uid}-form-timezone`} className="font-medium">
            {t('form.timezone')}
          </label>
          <input id={`${uid}-form-timezone`} className={inputClass} value={d.timezone} onChange={set('timezone')} aria-describedby="source-tz-error" aria-invalid={!zoneOk} />
          {!zoneOk ? <FieldError id="source-tz-error">{t('form.badTimezone')}</FieldError> : null}
        </div>
        <div className={field}>
          <label htmlFor={`${uid}-form-maxItems`} className="font-medium">
            {t('form.maxItems')}
          </label>
          <input id={`${uid}-form-maxItems`} className={inputClass} type="number" min={1} max={200} value={d.maxItems} onChange={set('maxItems')} />
        </div>
      </div>
      {!source ? <p className="t-aux">{t('form.termsNote')}</p> : null}
      {failure ? (
        <p role="alert" className="rounded-ctl border border-bad/40 bg-bad-soft px-3 py-2 text-[13px] text-bad">
          {failure}
        </p>
      ) : null}
      <div className="flex gap-2">
        <button type="submit" disabled={!times || !zoneOk || save.isPending} className="rounded-ctl bg-brand px-3 py-1.5 text-[13px] text-brand-fg disabled:opacity-50">
          {source ? t('form.save') : t('form.create')}
        </button>
        <button type="button" onClick={onDone} className="rounded-ctl border border-line px-3 py-1.5 text-[13px] hover:bg-panel-2">
          {t('form.cancel')}
        </button>
      </div>
    </form>
  );
}

const dateInput = (iso: string | null) => (iso ? iso.slice(0, 10) : '');
const isoOfDate = (v: string) => (v ? new Date(`${v}T00:00:00Z`).toISOString() : null);

function TermsForm({ source, onDone }: { source: IngestSourceResource; onDone: () => void }) {
  const { t } = useTranslation('sources');
  const qc = useQueryClient();
  const client = getApiClient();
  const [licenceStatus, setLicence] = useState<LicenceStatus>(source.licenceStatus);
  const [usageMode, setUsage] = useState<UsageMode>(source.usageMode);
  const [trustLevel, setTrust] = useState<TrustLevel>(source.trustLevel);
  const [commercialUse, setCommercial] = useState(source.commercialUse);
  const [evidence, setEvidence] = useState('');
  const [scope, setScope] = useState('');
  const [validUntil, setValidUntil] = useState(dateInput(source.licenceValidUntil));
  const [reviewDueAt, setReview] = useState(dateInput(source.reviewDueAt));
  const [attribution, setAttribution] = useState(source.attribution ?? '');
  const [failure, setFailure] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () =>
      client.rawRequest(`${BASE}/${encodeURIComponent(source.id)}/licences`, {
        method: 'POST',
        body: JSON.stringify({
          licenceStatus,
          usageMode,
          commercialUse,
          trustLevel,
          evidence: evidence.trim() || null,
          scope: scope.trim() || null,
          validUntil: isoOfDate(validUntil),
          reviewDueAt: isoOfDate(reviewDueAt),
          attribution: attribution.trim() || null,
        }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: siteKey('ingest-sources') });
      onDone();
    },
    onError: (err) => setFailure(errorText(err)),
  });
  const field = 'flex flex-col gap-1 text-[13px]';
  const uid = useId();
  return (
    <form
      aria-label={t('terms.title')}
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
      className="mb-5 flex flex-col gap-3 rounded-card border border-line bg-panel p-4"
    >
      <h2 className="t-section">
        {t('terms.title')} · {source.name}
      </h2>
      <p className="t-aux">{t('terms.description')}</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className={field}>
          <label htmlFor={`${uid}-terms-licenceStatus`} className="font-medium">
            {t('terms.licenceStatus')}
          </label>
          <select id={`${uid}-terms-licenceStatus`} className={inputClass} value={licenceStatus} onChange={(e) => setLicence(e.target.value as LicenceStatus)}>
            {LICENCE_STATUSES.map((v) => (
              <option key={v} value={v}>
                {t(`licence.${v}`)}
              </option>
            ))}
          </select>
        </div>
        <div className={field}>
          <label htmlFor={`${uid}-terms-usageMode`} className="font-medium">
            {t('terms.usageMode')}
          </label>
          <select id={`${uid}-terms-usageMode`} className={inputClass} value={usageMode} onChange={(e) => setUsage(e.target.value as UsageMode)}>
            {USAGE_MODES.map((v) => (
              <option key={v} value={v}>
                {t(`usage.${v}`)}
              </option>
            ))}
          </select>
        </div>
        <div className={field}>
          <label htmlFor={`${uid}-terms-trustLevel`} className="font-medium">
            {t('terms.trustLevel')}
          </label>
          <select id={`${uid}-terms-trustLevel`} className={inputClass} value={trustLevel} onChange={(e) => setTrust(e.target.value as TrustLevel)}>
            {TRUST_LEVELS.map((v) => (
              <option key={v} value={v}>
                {t(`trust.${v}`)}
              </option>
            ))}
          </select>
        </div>
        <div className={cn(field, 'sm:col-span-3')}>
          <label htmlFor={`${uid}-terms-evidence`} className="font-medium">
            {t('terms.evidence')}
          </label>
          <textarea id={`${uid}-terms-evidence`} rows={2} className={inputClass} value={evidence} placeholder={t('terms.evidencePlaceholder')} onChange={(e) => setEvidence(e.target.value)} />
        </div>
        <div className={cn(field, 'sm:col-span-3')}>
          <label htmlFor={`${uid}-terms-scope`} className="font-medium">
            {t('terms.scope')}
          </label>
          <input id={`${uid}-terms-scope`} className={inputClass} value={scope} onChange={(e) => setScope(e.target.value)} />
        </div>
        <div className={field}>
          <label htmlFor={`${uid}-terms-validUntil`} className="font-medium">
            {t('terms.validUntil')}
          </label>
          <input id={`${uid}-terms-validUntil`} type="date" className={inputClass} value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
        </div>
        <div className={field}>
          <label htmlFor={`${uid}-terms-reviewDueAt`} className="font-medium">
            {t('terms.reviewDueAt')}
          </label>
          <input id={`${uid}-terms-reviewDueAt`} type="date" className={inputClass} value={reviewDueAt} onChange={(e) => setReview(e.target.value)} />
        </div>
        <label className="flex items-center gap-2 self-end text-[13px]">
          <input type="checkbox" checked={commercialUse} onChange={(e) => setCommercial(e.target.checked)} />
          {t('terms.commercialUse')}
        </label>
        <div className={cn(field, 'sm:col-span-3')}>
          <label htmlFor={`${uid}-terms-attribution`} className="font-medium">
            {t('terms.attribution')}
          </label>
          <input id={`${uid}-terms-attribution`} className={inputClass} value={attribution} onChange={(e) => setAttribution(e.target.value)} />
        </div>
      </div>
      {failure ? (
        <p role="alert" className="rounded-ctl border border-bad/40 bg-bad-soft px-3 py-2 text-[13px] text-bad">
          {failure}
        </p>
      ) : null}
      <div className="flex gap-2">
        <button type="submit" disabled={save.isPending} className="rounded-ctl bg-brand px-3 py-1.5 text-[13px] text-brand-fg disabled:opacity-50">
          {t('terms.save')}
        </button>
        <button type="button" onClick={onDone} className="rounded-ctl border border-line px-3 py-1.5 text-[13px] hover:bg-panel-2">
          {t('form.cancel')}
        </button>
      </div>
    </form>
  );
}

function History({ source, onClose }: { source: IngestSourceResource; onClose: () => void }) {
  const { t, i18n } = useTranslation('sources');
  const client = getApiClient();
  const revisions = useQuery({
    queryKey: siteKey('ingest-sources', source.id, 'licences'),
    queryFn: async () => (await client.rawRequest<IngestLicenceResource[]>(`${BASE}/${encodeURIComponent(source.id)}/licences`)).data,
  });
  const date = (iso: string) => new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium' }).format(new Date(iso));
  return (
    <section aria-label={t('history.title')} className="mb-5 flex flex-col gap-3 rounded-card border border-line bg-panel p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="t-section">
          {t('history.title')} · {source.name}
        </h2>
        <button type="button" onClick={onClose} className="rounded-ctl border border-line px-2.5 py-1 text-[13px] hover:bg-panel-2">
          {t('history.close')}
        </button>
      </div>
      {revisions.isLoading ? (
        <Skeleton className="h-16" />
      ) : !revisions.data?.length ? (
        <p className="t-aux">{t('history.empty')}</p>
      ) : (
        <ol className="flex flex-col gap-2 text-[13px]">
          {revisions.data.map((r) => (
            <li key={r.id} data-revision={r.id} className="flex flex-col gap-1 border-b border-line pb-2 last:border-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone={r.licenceStatus === 'unknown' ? 'warn' : 'ok'}>{t(`licence.${r.licenceStatus}`)}</Badge>
                <Badge tone="brand">{t(`usage.${r.usageMode}`)}</Badge>
                <Badge tone="dim">{t(`trust.${r.trustLevel}`)}</Badge>
                {r.commercialUse ? <Badge tone="dim">{t('commercial')}</Badge> : null}
                <span className="t-aux">
                  <RelativeTime value={r.createdAt} /> · {t('history.setBy', { who: r.setBy ?? t('history.unknownActor') })}
                  {r.validUntil ? ` · ${t('history.validUntil', { date: date(r.validUntil) })}` : ''}
                  {r.reviewDueAt ? ` · ${t('history.reviewDue', { date: date(r.reviewDueAt) })}` : ''}
                </span>
              </div>
              {r.evidence ? <p className="whitespace-pre-wrap text-dim">{r.evidence}</p> : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

type Panel = { kind: 'new' } | { kind: 'edit' | 'terms' | 'history'; id: string } | null;

export function SourcesPage() {
  const { t } = useTranslation('sources');
  const qc = useQueryClient();
  const client = getApiClient();
  const { isAdmin } = usePermissions();
  const [panel, setPanel] = useState<Panel>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const sources = useQuery({ queryKey: siteKey('ingest-sources'), queryFn: async () => (await client.rawRequest<IngestSourceResource[]>(BASE)).data });
  const toggle = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'pause' | 'resume' }) => client.rawRequest(`${BASE}/${encodeURIComponent(id)}/${action}`, { method: 'POST' }),
    onSuccess: () => {
      setFailure(null);
      void qc.invalidateQueries({ queryKey: siteKey('ingest-sources') });
    },
    onError: (err) => setFailure(errorText(err)),
  });
  const selected = panel && panel.kind !== 'new' ? sources.data?.find((s) => s.id === panel.id) : undefined;
  const btn = 'rounded-ctl border border-line px-2 py-1 text-[12px] hover:bg-panel-2 disabled:opacity-50';

  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <button type="button" onClick={() => setPanel({ kind: 'new' })} className="rounded-ctl bg-brand px-3 py-1.5 text-[13px] text-brand-fg">
            {t('new')}
          </button>
        }
      />

      {panel?.kind === 'new' ? <SourceForm onDone={() => setPanel(null)} /> : null}
      {panel?.kind === 'edit' && selected ? <SourceForm key={selected.id} source={selected} onDone={() => setPanel(null)} /> : null}
      {panel?.kind === 'terms' && selected ? <TermsForm key={selected.id} source={selected} onDone={() => setPanel(null)} /> : null}
      {panel?.kind === 'history' && selected ? <History key={selected.id} source={selected} onClose={() => setPanel(null)} /> : null}

      {failure ? (
        <p role="alert" className="mb-3 rounded-ctl border border-bad/40 bg-bad-soft px-3 py-2 text-[13px] text-bad">
          {failure}
        </p>
      ) : null}

      {sources.isLoading ? (
        <Skeleton className="h-48" />
      ) : !sources.data?.length ? (
        <EmptyState title={t('empty.title')} body={t('empty.body')} />
      ) : (
        <div className="overflow-x-auto rounded-card border border-line bg-panel">
          <table className="w-full min-w-[860px] text-left text-[13px]">
            <caption className="sr-only">{t('title')}</caption>
            <thead className="t-aux">
              <tr className="border-b border-line">
                <th className="px-4 py-2">{t('columns.source')}</th>
                <th className="px-4 py-2">{t('columns.schedule')}</th>
                <th className="px-4 py-2">{t('columns.status')}</th>
                <th className="px-4 py-2">{t('columns.terms')}</th>
                <th className="px-4 py-2">{t('columns.health')}</th>
                <th className="px-4 py-2">
                  <span className="sr-only">{t('columns.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {sources.data.map((s) => (
                <tr key={s.id} data-source={s.name} className="border-b border-line align-top last:border-0">
                  <td className="px-4 py-2">
                    <div className="font-medium">{s.name}</div>
                    <div className="t-aux flex flex-wrap gap-1.5">
                      <span>{t(`type.${s.type}`)}</span>
                      <span className="max-w-[260px] truncate font-mono text-[12px]" title={s.url}>
                        {s.url}
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-2">
                    <div>{t('times', { times: s.scheduleTimes.join(', '), timezone: s.timezone })}</div>
                    <div className="t-aux">{s.nextRunAt ? <>{t('nextRun')} <RelativeTime value={s.nextRunAt} /></> : t('never')}</div>
                  </td>
                  <td className="px-4 py-2">
                    <Badge tone={s.status === 'active' ? 'ok' : s.pausedReason === 'failures' ? 'bad' : 'dim'}>
                      {s.status === 'active' ? t('status.active') : s.pausedReason === 'failures' ? t('status.pausedFailures') : t('status.paused')}
                    </Badge>
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex flex-wrap gap-1">
                      <Badge tone={s.licenceStatus === 'unknown' ? 'warn' : 'ok'}>{t(`licence.${s.licenceStatus}`)}</Badge>
                      <Badge tone="brand">{t(`usage.${s.usageMode}`)}</Badge>
                      <Badge tone="dim">{t(`trust.${s.trustLevel}`)}</Badge>
                      {s.commercialUse ? <Badge tone="dim">{t('commercial')}</Badge> : null}
                    </div>
                    {!s.licenceEffective || s.effectiveUsageMode !== s.usageMode ? <div className="mt-1 text-[12px] text-warn">{t('notEffective')}</div> : null}
                  </td>
                  <td className="px-4 py-2">
                    {s.consecutiveFailures > 0 ? (
                      <span className="text-bad">{t('failures', { count: s.consecutiveFailures, category: s.lastFailureCategory ? t(`failure.${s.lastFailureCategory}`) : '' })}</span>
                    ) : (
                      <span className="text-dim">{t('healthy')}</span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex flex-wrap justify-end gap-1">
                      <button type="button" className={btn} onClick={() => setPanel({ kind: 'edit', id: s.id })}>
                        {t('actions.edit')}
                      </button>
                      {s.status === 'active' ? (
                        <button type="button" className={btn} disabled={toggle.isPending} onClick={() => toggle.mutate({ id: s.id, action: 'pause' })}>
                          {t('actions.pause')}
                        </button>
                      ) : isAdmin ? (
                        <button type="button" className={btn} disabled={toggle.isPending} onClick={() => toggle.mutate({ id: s.id, action: 'resume' })}>
                          {t('actions.resume')}
                        </button>
                      ) : (
                        <span className="t-aux" title={t('resumeAdminOnly')}>
                          {t('status.paused')}
                        </span>
                      )}
                      {isAdmin ? (
                        <button type="button" className={btn} onClick={() => setPanel({ kind: 'terms', id: s.id })}>
                          {t('actions.terms')}
                        </button>
                      ) : null}
                      <button type="button" className={btn} onClick={() => setPanel({ kind: 'history', id: s.id })}>
                        {t('actions.history')}
                      </button>
                    </div>
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
