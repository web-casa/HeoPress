import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { CrawlProviderId, IngestProviderResource, IngestProviderUpdateInput } from '@heopress/contracts/schemas';
import { getApiClient } from '@/lib/api';
import { cn } from '@/lib/cn';
import { usePermissions } from '@/lib/use-permissions';
import { siteKey } from '../api';
import { inputClass } from '../seo/seo-kit';
import { Skeleton } from '../ui/skeleton';

/**
 * Content › Sources › Crawl services (HeoPress P08 tasks 3.3, 3.4, 3.6; spec ingest/crawling "外部采集服务插件",
 * "采集服务预算与熔断"): per site, each external crawl service's switch, its place after native fetching, the
 * administrator's confirmation that target URLs may be sent to it, its credential (write-only: the page only learns
 * whether one is set and its last four characters), its options, the monthly budget and this month's usage. Only
 * administrators change anything; the server decides.
 */

const BASE = '/api/v1/ingest/providers';

const errorText = (err: unknown) => {
  const body = (err as { body?: { errors?: Array<{ message?: string }> } }).body;
  return body?.errors?.[0]?.message ?? (err instanceof Error ? err.message : String(err));
};

interface Draft {
  enabled: boolean;
  position: string;
  consent: boolean;
  credential: string;
  endpoint: string;
  accountId: string;
  budget: string;
}

const draftOf = (p: IngestProviderResource): Draft => ({
  enabled: p.enabled,
  position: String(p.position),
  consent: Boolean(p.consentAt),
  credential: '',
  endpoint: p.endpoint ?? '',
  accountId: p.accountId ?? '',
  budget: p.monthlyBudgetUsd === null ? '' : String(p.monthlyBudgetUsd),
});

function ProviderCard({ provider: p, canEdit }: { provider: IngestProviderResource; canEdit: boolean }) {
  const { t } = useTranslation('crawlServices');
  const qc = useQueryClient();
  const client = getApiClient();
  const uid = useId();
  const [d, setD] = useState<Draft>(() => draftOf(p));
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const save = useMutation({
    mutationFn: async (extra: Partial<IngestProviderUpdateInput> = {}) => {
      const body: IngestProviderUpdateInput = {
        enabled: d.enabled,
        position: Number(d.position) || 0,
        consent: d.consent,
        monthlyBudgetUsd: d.budget.trim() === '' ? null : Number(d.budget),
        ...(d.credential.trim() ? { credential: d.credential.trim() } : {}),
        ...(p.provider === 'crawl4ai' ? { endpoint: d.endpoint.trim() || null } : {}),
        ...(p.provider === 'cloudflare' ? { accountId: d.accountId.trim() || null } : {}),
        ...extra,
      };
      return client.rawRequest(`${BASE}/${p.provider}`, { method: 'PATCH', body: JSON.stringify(body) });
    },
    onSuccess: () => {
      setFailure(null);
      setSaved(true);
      setD((cur) => ({ ...cur, credential: '' }));
      void qc.invalidateQueries({ queryKey: siteKey('ingest-providers') });
    },
    onError: (err) => {
      setSaved(false);
      setFailure(errorText(err));
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({});
  };
  const field = 'flex flex-col gap-1 text-[13px]';
  const reason = p.unavailableReason;

  return (
    <form aria-label={t(`provider.${p.provider}`)} onSubmit={submit} data-provider={p.provider} className="flex flex-col gap-3 rounded-card border border-line bg-panel p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="t-section">{t(`provider.${p.provider}`)}</h3>
        <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', reason ? 'border border-line text-dim' : 'bg-ok-soft text-ok')}>
          {reason ? t(`reason.${reason}`) : t('reason.ready')}
        </span>
      </div>
      <p className="t-aux">{p.hosts.length ? t('hosts', { hosts: p.hosts.join(', ') }) : t('hostsEndpoint')}</p>
      <dl className="t-aux grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
        <dt>{t('usage.month', { month: p.usage.month })}</dt>
        <dd>{t('usage.requests', { count: p.usage.requests })}</dd>
        <dt>{t('usage.cost')}</dt>
        <dd>{t('usage.costValue', { cost: p.usage.costUsd.toFixed(4), budget: p.monthlyBudgetUsd === null ? t('usage.noCeiling') : p.monthlyBudgetUsd.toFixed(2) })}</dd>
        <dt>{t('usage.failures')}</dt>
        <dd>{p.usage.failures}</dd>
        {p.pausedUntil ? (
          <>
            <dt>{t('usage.pausedUntil')}</dt>
            <dd>{new Date(p.pausedUntil).toLocaleString()}</dd>
          </>
        ) : null}
      </dl>
      <fieldset disabled={!canEdit} className="grid gap-3 sm:grid-cols-2">
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={d.enabled} onChange={(e) => setD({ ...d, enabled: e.target.checked })} />
          {t('form.enabled')}
        </label>
        <div className={field}>
          <label htmlFor={`${uid}-position`} className="font-medium">
            {t('form.position')}
          </label>
          <input id={`${uid}-position`} className={inputClass} type="number" min={0} max={100} value={d.position} onChange={(e) => setD({ ...d, position: e.target.value })} />
        </div>
        <label className="flex items-start gap-2 text-[13px] sm:col-span-2">
          <input type="checkbox" className="mt-0.5" checked={d.consent} onChange={(e) => setD({ ...d, consent: e.target.checked })} />
          <span>{t('form.consent', { service: t(`provider.${p.provider}`) })}</span>
        </label>
        <div className={field}>
          <label htmlFor={`${uid}-credential`} className="font-medium">
            {t(`form.credential.${p.credentialKind}`)}
          </label>
          <input
            id={`${uid}-credential`}
            className={cn(inputClass, 'font-mono')}
            type="password"
            autoComplete="off"
            value={d.credential}
            placeholder={p.credentialSet ? t('form.credentialSet', { hint: p.credentialHint ?? '' }) : ''}
            onChange={(e) => setD({ ...d, credential: e.target.value })}
          />
          {p.credentialSet && canEdit ? (
            <button type="button" className="self-start text-[12px] text-dim underline" onClick={() => save.mutate({ credential: null })}>
              {t('form.clearCredential')}
            </button>
          ) : null}
        </div>
        <div className={field}>
          <label htmlFor={`${uid}-budget`} className="font-medium">
            {t('form.budget')}
          </label>
          <input id={`${uid}-budget`} className={inputClass} type="number" min={0} step="0.01" value={d.budget} onChange={(e) => setD({ ...d, budget: e.target.value })} />
        </div>
        {p.provider === 'crawl4ai' ? (
          <div className={cn(field, 'sm:col-span-2')}>
            <label htmlFor={`${uid}-endpoint`} className="font-medium">
              {t('form.endpoint')}
            </label>
            <input id={`${uid}-endpoint`} className={cn(inputClass, 'font-mono')} type="url" value={d.endpoint} placeholder={t('form.endpointPlaceholder')} onChange={(e) => setD({ ...d, endpoint: e.target.value })} />
          </div>
        ) : null}
        {p.provider === 'cloudflare' ? (
          <div className={cn(field, 'sm:col-span-2')}>
            <label htmlFor={`${uid}-account`} className="font-medium">
              {t('form.accountId')}
            </label>
            <input id={`${uid}-account`} className={cn(inputClass, 'font-mono')} value={d.accountId} onChange={(e) => setD({ ...d, accountId: e.target.value })} />
          </div>
        ) : null}
      </fieldset>
      {failure ? (
        <p role="alert" className="text-[13px] text-bad">
          {failure}
        </p>
      ) : saved ? (
        <p role="status" className="text-[13px] text-ok">
          {t('saved')}
        </p>
      ) : null}
      {canEdit ? (
        <div>
          <button type="submit" disabled={save.isPending} className="rounded-ctl bg-brand px-3 py-1.5 text-[13px] text-brand-fg disabled:opacity-50">
            {t('form.save')}
          </button>
        </div>
      ) : null}
    </form>
  );
}

export function CrawlServicesPanel({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('crawlServices');
  const client = getApiClient();
  const { isAdmin } = usePermissions();
  const providers = useQuery({ queryKey: siteKey('ingest-providers'), queryFn: async () => (await client.rawRequest<IngestProviderResource[]>(BASE)).data });
  const order: CrawlProviderId[] = ['firecrawl', 'crawl4ai', 'cloudflare', 'tinyfish'];

  return (
    <section aria-label={t('title')} className="mb-5 flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="t-section">{t('title')}</h2>
          <p className="t-aux max-w-[70ch]">{t('description')}</p>
          {!isAdmin ? <p className="t-aux">{t('adminOnly')}</p> : null}
        </div>
        <button type="button" className="rounded-ctl border border-line px-2 py-1 text-[12px] hover:bg-panel-2" onClick={onClose}>
          {t('close')}
        </button>
      </div>
      {providers.isLoading ? (
        <Skeleton className="h-48" />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {order
            .map((id) => providers.data?.find((p) => p.provider === id))
            .filter((p): p is IngestProviderResource => Boolean(p))
            .map((p) => (
              <ProviderCard key={`${p.provider}:${p.consentAt ?? ''}:${p.credentialHint ?? ''}`} provider={p} canEdit={isAdmin} />
            ))}
        </div>
      )}
    </section>
  );
}
