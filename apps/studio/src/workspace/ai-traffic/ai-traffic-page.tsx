import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { Ban, Bot } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getAdminBase } from '@/lib/admin-base';
import { getApiClient } from '@/lib/api';
import { cn } from '@/lib/cn';
import { withAdminBase } from '@/lib/keybindings/commands';
import { siteKey, useNetworkAiTraffic, type AiDay, type NetworkAiTraffic } from '../api';
import { CHART } from '../charts/palette';
import { StackedBars, type BarSeries } from '../charts/stacked-bars';
import { Page } from '../shell/module-layout';
import { EmptyState } from '../ui/empty-state';
import { changeOf, formatNumber } from '../ui/format';
import { PageHeader } from '../ui/page-header';
import { Skeleton } from '../ui/skeleton';
import { isBlocked, type CrawlerPolicy } from './blocked';

interface SiteReport {
  from: string;
  to: string;
  totals: { crawler: number; referral: number };
  previousTotals?: { crawler: number; referral: number } | null;
  byDay: AiDay[];
  byAgent: Array<{ kind: 'crawler' | 'referral'; agent: string; operator: string; purpose: string | null; hits: number }>;
  topCrawled: Array<{ path: string; resource: string; hits: number; itemId?: string; collection?: string }>;
  topLanding: Array<{ path: string; hits: number; sources: string[] }>;
}

type Metric = 'crawler' | 'referral';
const DAYS = [7, 30, 90] as const;

/** Every day of the period, zero where nothing was recorded. */
export function fillDays(from: string, to: string, rows: AiDay[]): AiDay[] {
  const by = new Map(rows.map((r) => [r.day, r]));
  const out: AiDay[] = [];
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d = new Date(d.getTime() + 86_400_000)) {
    const day = d.toISOString().slice(0, 10);
    out.push(by.get(day) ?? { day, training: 0, search: 0, userFetch: 0, referral: 0 });
  }
  return out;
}

/** AI traffic (spec studio/ai-traffic-view): metric tabs, the per-day chart, details; this site or all sites. */
export function AiTrafficPage() {
  const { t, i18n } = useTranslation(['aiTraffic', 'common']);
  const lang = i18n.language;
  const { location } = useRouterState();
  const navigate = useNavigate();
  const adminBase = getAdminBase(location.pathname);
  const search = location.search as Record<string, unknown>;
  const days = DAYS.includes(Number(search.days) as (typeof DAYS)[number]) ? (Number(search.days) as (typeof DAYS)[number]) : 30;
  const metric: Metric = search.metric === 'referral' ? 'referral' : 'crawler';
  const scope = search.scope === 'all' ? 'all' : 'current';
  const setSearch = (patch: Record<string, unknown>) => void navigate({ to: '.', search: { ...search, ...patch } as never, replace: true });

  const site = useQuery({
    queryKey: siteKey('ai-traffic-report', days),
    queryFn: async () => (await getApiClient().rawRequest<SiteReport>(`/api/v1/site/ai-traffic?days=${days}&previous=1`)).data,
    enabled: scope === 'current',
  });
  const network = useNetworkAiTraffic(days, scope === 'all');
  const policy = useQuery({
    queryKey: siteKey('seo-settings'),
    queryFn: async () => (await getApiClient().rawRequest<{ settings: { crawlers: CrawlerPolicy } }>('/api/v1/site/seo-settings')).data.settings.crawlers,
    enabled: scope === 'current',
  });

  const data = scope === 'all' ? network.data : site.data;
  const loading = scope === 'all' ? network.isLoading : site.isLoading;
  const totals = data?.totals;
  const previous = data?.previousTotals ?? null;
  const days_ = data ? fillDays(data.from, data.to, data.byDay) : [];
  const dateFmt = new Intl.DateTimeFormat(lang, { month: 'short', day: 'numeric' });
  const series: BarSeries[] =
    metric === 'crawler'
      ? [
          { key: 'training', label: t('purpose.training'), color: CHART[0] },
          { key: 'search', label: t('purpose.search'), color: CHART[1] },
          { key: 'userFetch', label: t('purpose.userFetch'), color: CHART[2] },
        ]
      : [{ key: 'referral', label: t('purpose.referral'), color: CHART[0] }];
  const every = days === 7 ? 1 : days === 30 ? 5 : 15;
  const bars = days_.map((d, i) => ({
    label: dateFmt.format(new Date(`${d.day}T00:00:00Z`)),
    tick: i % every === 0 ? dateFmt.format(new Date(`${d.day}T00:00:00Z`)) : '',
    values: { training: d.training, search: d.search, userFetch: d.userFetch, referral: d.referral },
  }));

  return (
    <Page wide>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Segmented label={t('aiTraffic:scope.current')} options={[['current', t('scope.current')], ['all', t('scope.all')]]} value={scope} onChange={(v) => setSearch({ scope: v })} />
            <Segmented label={t('range.label')} options={DAYS.map((d) => [String(d), t('range.days', { count: d })] as [string, string])} value={String(days)} onChange={(v) => setSearch({ days: Number(v) })} />
          </div>
        }
      />

      {scope === 'all' && network.data ? <Excluded excluded={network.data.excluded} /> : null}

      <section className="rounded-card border border-line bg-panel">
        <div role="tablist" aria-label={t('title')} className="grid grid-cols-2 border-b border-line">
          {(['crawler', 'referral'] as const).map((m) => {
            const value = totals?.[m] ?? 0;
            const change = changeOf(value, previous?.[m]);
            return (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={metric === m}
                onClick={() => setSearch({ metric: m })}
                className={cn('flex flex-col items-start gap-1 px-5 py-4 text-left transition-colors', metric === m ? 'border-b-2 border-brand' : 'text-dim hover:bg-panel-2')}
              >
                <span className="text-[12.5px]">{t(`metric.${m}`)}</span>
                {loading ? <Skeleton className="h-7 w-20" /> : <span className="text-[24px] font-semibold leading-none text-fg t-num">{formatNumber(value, lang)}</span>}
                <span className={cn('text-[12px] t-num', change === null ? 'text-dim' : change >= 0 ? 'text-ok' : 'text-bad')}>
                  {change === null ? t('common:noPrevious') : t('common:changeVsPrevious', { value: change > 0 ? `+${change}` : change })}
                </span>
              </button>
            );
          })}
        </div>
        <div role="tabpanel" className="p-5">
          {loading ? (
            <Skeleton className="h-48" />
          ) : !totals || totals.crawler + totals.referral === 0 ? (
            <EmptyState icon={Bot} title={t('noData')} />
          ) : (
            <StackedBars data={bars} series={series} caption={t('chart', { metric: t(`metric.${metric}`) })} formatNumber={(n) => formatNumber(n, lang)} />
          )}
        </div>
      </section>

      {scope === 'current' && site.data ? <SiteDetails report={site.data} policy={policy.data} adminBase={adminBase} /> : null}
      {scope === 'all' && network.data ? <PerSite data={network.data} /> : null}
    </Page>
  );
}

function Segmented({ label, options, value, onChange }: { label: string; options: Array<[string, string]>; value: string; onChange: (v: string) => void }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-ctl bg-panel-2 p-0.5">
      {options.map(([v, text]) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} onClick={() => onChange(v)} className={cn('rounded-[6px] px-3 py-1.5 text-[13px]', value === v ? 'bg-panel font-medium shadow-sm' : 'text-dim')}>
          {text}
        </button>
      ))}
    </div>
  );
}

export function Excluded({ excluded }: { excluded: { mfaRequired: number; unavailable: number } }) {
  const { t } = useTranslation('common');
  if (!excluded.mfaRequired && !excluded.unavailable) return null;
  return (
    <p role="status" className="mb-3 rounded-ctl border border-warn/30 bg-warn-soft px-3 py-2 text-[13px] text-warn">
      {[excluded.mfaRequired ? t('sitesExcluded.mfa', { count: excluded.mfaRequired }) : null, excluded.unavailable ? t('sitesExcluded.unavailable', { count: excluded.unavailable }) : null].filter(Boolean).join(' · ')}
    </p>
  );
}

export function PerSite({ data }: { data: NetworkAiTraffic }) {
  const { t, i18n } = useTranslation(['aiTraffic', 'common']);
  return (
    <section aria-label={t('perSite.title')} className="mt-4 rounded-card border border-line bg-panel p-4">
      <h2 className="mb-3 t-section">{t('perSite.title')}</h2>
      <table className="w-full text-[13px]">
        <thead>
          <tr className="text-left text-dim">
            <th className="pb-2 font-medium">{t('perSite.site')}</th>
            <th className="pb-2 text-right font-medium">{t('perSite.crawler')}</th>
            <th className="pb-2 text-right font-medium">{t('perSite.referral')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {data.sites.map((s) => (
            <tr key={s.id}>
              <td className="py-2">{s.name}</td>
              {s.availability === 'available' && s.totals ? (
                <>
                  <td className="py-2 text-right t-num">{formatNumber(s.totals.crawler, i18n.language)}</td>
                  <td className="py-2 text-right t-num">{formatNumber(s.totals.referral, i18n.language)}</td>
                </>
              ) : (
                <td colSpan={2} className="py-2 text-right text-warn">
                  {t(s.availability === 'mfa_required' ? 'common:mfaRequired' : 'common:unavailable')}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export function SiteDetails({ report, policy, adminBase }: { report: SiteReport; policy: CrawlerPolicy | undefined; adminBase: string }) {
  const { t, i18n } = useTranslation('aiTraffic');
  const lang = i18n.language;
  const [shares, setShares] = useState(false);
  const total = report.byAgent.reduce((n, a) => n + a.hits, 0) || 1;
  const purposeLabel = (p: string | null, kind: string) =>
    kind === 'referral' ? t('purpose.referral') : p === 'user-fetch' ? t('purpose.userFetch') : p === 'training' ? t('purpose.training') : p === 'search' ? t('purpose.search') : (p ?? '');
  return (
    <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <section aria-label={t('byAgent.title')} className="rounded-card border border-line bg-panel p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="t-section">{t('byAgent.title')}</h2>
          <div role="radiogroup" aria-label={t('byAgent.title')} className="inline-flex rounded-ctl bg-panel-2 p-0.5 text-[12px]">
            {([false, true] as const).map((v) => (
              <button key={String(v)} type="button" role="radio" aria-checked={shares === v} onClick={() => setShares(v)} className={cn('rounded-[6px] px-2.5 py-1', shares === v ? 'bg-panel font-medium shadow-sm' : 'text-dim')}>
                {v ? t('byAgent.shares') : t('byAgent.counts')}
              </button>
            ))}
          </div>
        </div>
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-left text-dim">
              <th className="pb-2 font-medium">{t('byAgent.who')}</th>
              <th className="pb-2 font-medium">{t('byAgent.operator')}</th>
              <th className="pb-2 font-medium">{t('byAgent.purpose')}</th>
              <th className="pb-2 text-right font-medium">{shares ? t('byAgent.share') : t('byAgent.count')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {report.byAgent.map((a) => {
              const blocked = a.kind === 'crawler' && policy ? isBlocked(policy, a.agent, a.purpose) : false;
              return (
                <tr key={`${a.kind}:${a.agent}:${a.purpose ?? ''}`}>
                  <td className="py-2 font-mono text-[12.5px]">
                    {a.agent}
                    {blocked ? (
                      <Link to={withAdminBase(adminBase, '/seo/crawlers') as never} title={t('byAgent.blockedHint')} className="ml-2 inline-flex items-center gap-1 rounded-full bg-bad-soft px-1.5 py-0.5 font-sans text-[11px] text-bad hover:underline">
                        <Ban className="h-3 w-3" aria-hidden="true" />
                        {t('byAgent.blocked')}
                      </Link>
                    ) : null}
                  </td>
                  <td className="py-2">{a.operator}</td>
                  <td className="py-2">{purposeLabel(a.purpose, a.kind)}</td>
                  <td className="py-2 text-right t-num">{shares ? `${Math.round((a.hits / total) * 100)}%` : formatNumber(a.hits, lang)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
      <div className="flex flex-col gap-4">
        <section aria-label={t('topCrawled.title')} className="rounded-card border border-line bg-panel p-4">
          <h2 className="mb-3 t-section">{t('topCrawled.title')}</h2>
          <ol className="flex flex-col gap-1.5 text-[13px]">
            {report.topCrawled.map((p) => (
              <li key={p.path} className="flex items-center gap-2">
                {p.itemId && p.collection ? (
                  <Link to={withAdminBase(adminBase, `/content/${p.collection}/${p.itemId}`) as never} className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-brand hover:underline">
                    {p.path}
                  </Link>
                ) : (
                  <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{p.path}</span>
                )}
                <span className="t-aux">{t(`topCrawled.resource.${p.resource in RESOURCES ? p.resource : 'other'}`)}</span>
                <span className="w-10 text-right t-num">{formatNumber(p.hits, lang)}</span>
              </li>
            ))}
          </ol>
        </section>
        <section aria-label={t('topLanding.title')} className="rounded-card border border-line bg-panel p-4">
          <h2 className="mb-3 t-section">{t('topLanding.title')}</h2>
          <ol className="flex flex-col gap-1.5 text-[13px]">
            {report.topLanding.map((p) => (
              <li key={p.path} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{p.path}</span>
                <span className="t-aux">{t('topLanding.via', { sources: p.sources.join(', ') })}</span>
                <span className="w-10 text-right t-num">{formatNumber(p.hits, lang)}</span>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </div>
  );
}

const RESOURCES = { page: 1, markdown: 1, llms: 1, robots: 1, sitemap: 1, feed: 1 } as const;
