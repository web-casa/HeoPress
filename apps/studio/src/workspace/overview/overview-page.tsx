import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { AlertTriangle, Check, CheckCircle2, Circle, Clock, FileText, Globe2, ShieldAlert } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { getAdminBase } from '@/lib/admin-base';
import { getApiClient } from '@/lib/api';
import { cn } from '@/lib/cn';
import { withAdminBase } from '@/lib/keybindings/commands';
import { activeSiteId } from '@/lib/session/current';
import { usePermissions } from '@/lib/use-permissions';
import { isAvailable, siteKey, studioApi, useNetworkAiTraffic, useNetworkSummary, useOverviewFeed, type SiteSummary } from '../api';
import { Sparkline } from '../charts/sparkline';
import { saveStudioPreferences } from '../shell/preferences';
import { Page } from '../shell/module-layout';
import { openOnSite } from '../site-switch';
import { EmptyState } from '../ui/empty-state';
import { changeOf, formatDuration, formatNumber } from '../ui/format';
import { PageHeader } from '../ui/page-header';
import { RelativeTime } from '../ui/relative-time';
import { Skeleton } from '../ui/skeleton';
import { incomplete, keyFigures, nextAuditAt, reviewsUnreadable, todoItems, weekOf, type Exclusions, type Scope, type Todo } from './model';

interface SiteAiReport {
  totals: { crawler: number; referral: number };
  byDay: Array<{ day: string; training: number; search: number; userFetch: number; referral: number }>;
  previousTotals?: { crawler: number; referral: number } | null;
}

function useSiteAi(days: number) {
  return useQuery({
    queryKey: siteKey('ai-traffic', days, 'previous'),
    queryFn: async () => (await getApiClient().rawRequest<SiteAiReport>(`/api/v1/site/ai-traffic?days=${days}&previous=1`)).data,
  });
}

/** Overview (spec studio/overview): what needs you, key figures, the week, recent activity, the setup checklist. */
export function OverviewPage() {
  const { t, i18n } = useTranslation(['overview', 'common']);
  const lang = i18n.language;
  const { location } = useRouterState();
  const adminBase = getAdminBase(location.pathname);
  const navigate = useNavigate();
  const { isAdmin } = usePermissions();
  const currentId = activeSiteId();
  const [scope, setScope] = useState<Scope>({ kind: 'current' });

  const summary = useNetworkSummary();
  const sites = useMemo(() => summary.data ?? [], [summary.data]);
  const scoped: SiteSummary[] = useMemo(() => {
    if (scope.kind === 'all') return sites;
    const id = scope.kind === 'site' ? scope.siteId : currentId;
    return sites.filter((s) => s.id === id);
  }, [scope, sites, currentId]);

  const week = useMemo(() => weekOf(new Date()), []);
  const feed = useOverviewFeed({ from: week.from, to: week.to });
  const ai7 = useSiteAi(7);
  const ai30 = useSiteAi(30);
  const network7 = useNetworkAiTraffic(7, scope.kind === 'all');
  const network30 = useNetworkAiTraffic(30, scope.kind === 'all');
  const status = useQuery({ queryKey: siteKey('service-status'), queryFn: studioApi.serviceStatus, enabled: isAdmin, retry: false });
  const prefs = useQuery({ queryKey: ['me', 'preferences'], queryFn: () => getApiClient().me.getPreferences() });
  const qc = useQueryClient();

  const alerts = status.data
    ? Object.values(status.data.site).filter((c) => c.status === 'failed').length +
      (status.data.instance ? Object.values(status.data.instance.services).filter((s) => s === 'unhealthy').length + (status.data.instance.failedJobs24h ? 1 : 0) : 0)
    : 0;
  const todos = todoItems({ scope, alerts, sites: scoped, feed: scope.kind === 'current' ? feed.data : undefined });
  const figures = keyFigures(scoped);

  const crawlerTrend = scope.kind === 'all' ? network7.data?.byDay.map((d) => d.training + d.search + d.userFetch) : ai7.data?.byDay.map((d) => d.training + d.search + d.userFetch);
  const referralTrend = scope.kind === 'all' ? network30.data?.byDay.map((d) => d.referral) : ai30.data?.byDay.map((d) => d.referral);
  const crawlerChange = scope.kind === 'all' ? changeOf(network7.data?.totals.crawler ?? 0, network7.data?.previousTotals?.crawler) : changeOf(ai7.data?.totals.crawler ?? 0, ai7.data?.previousTotals?.crawler);
  const referralChange = scope.kind === 'all' ? changeOf(network30.data?.totals.referral ?? 0, network30.data?.previousTotals?.referral) : changeOf(ai30.data?.totals.referral ?? 0, ai30.data?.previousTotals?.referral);

  const nextAudit = nextAuditAt(scoped);
  const unreadableReviews = scope.kind === 'current' ? 0 : reviewsUnreadable(scoped);
  const go = (path: string, siteId?: string) => {
    if (siteId && siteId !== currentId) void openOnSite(siteId, path);
    else void navigate({ to: withAdminBase(adminBase, path) as never });
  };

  const setupHidden = (prefs.data?.data as { studio?: { setupChecklistHidden?: boolean } } | undefined)?.studio?.setupChecklistHidden === true;
  const setup = feed.data?.setup;
  const setupDone = setup ? Object.values(setup).every(Boolean) : false;

  return (
    <Page wide>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={<ScopeSwitch scope={scope} onChange={setScope} sites={sites} currentId={currentId} />}
      />

      <section aria-label={t('kpi.published')} className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi label={t('kpi.published')} value={summary.isLoading ? null : formatNumber(figures.published, lang)} note={<ExclusionNote e={figures.publishedExclusions} />} />
        <Kpi
          label={t('kpi.crawler')}
          value={summary.isLoading ? null : formatNumber(figures.crawler7d, lang)}
          change={crawlerChange}
          trend={crawlerTrend}
          note={<ExclusionNote e={{ ...figures.exclusions, noPermission: 0, partial: 0 }} />}
        />
        <Kpi
          label={t('kpi.referral')}
          value={summary.isLoading ? null : formatNumber(figures.referral30d, lang)}
          change={referralChange}
          trend={referralTrend}
          note={<ExclusionNote e={{ ...figures.exclusions, noPermission: 0, partial: 0 }} />}
        />
        <Kpi label={t('kpi.attention')} value={summary.isLoading ? null : formatNumber(figures.attention, lang)} note={<ExclusionNote e={{ ...figures.exclusions, noPermission: 0, partial: 0 }} />} />
      </section>

      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card title={t('todo.title')}>
          {summary.isLoading ? (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-12" />
              <Skeleton className="h-12" />
            </div>
          ) : todos.length === 0 ? (
            <EmptyState
              icon={CheckCircle2}
              title={t('todo.empty')}
              body={
                nextAudit ? (
                  <>
                    {t('todo.nextAudit', { when: '' })}
                    <RelativeTime value={nextAudit} />
                  </>
                ) : undefined
              }
            />
          ) : (
            <ul className="flex flex-col divide-y divide-line">
              {todos.map((todo) => (
                <TodoRow key={todo.kind} todo={todo} scope={scope} sites={scoped} onGo={go} />
              ))}
            </ul>
          )}
          {!summary.isLoading && unreadableReviews > 0 ? <p className="mt-2 t-aux">{t('common:sitesExcluded.noPermission', { count: unreadableReviews })}</p> : null}
        </Card>

        <div className="flex flex-col gap-4">
          {scope.kind === 'current' && setup && !setupDone && !setupHidden ? (
            <Card
              title={t('setup.title')}
              action={
                <button
                  type="button"
                  className="rounded-ctl px-2 py-1 text-[12.5px] text-dim hover:bg-panel-2"
                  onClick={() => {
                    void saveStudioPreferences({ setupChecklistHidden: true }).then(() => qc.invalidateQueries({ queryKey: ['me', 'preferences'] }));
                  }}
                >
                  {t('setup.hide')}
                </button>
              }
            >
              <ul className="flex flex-col gap-2">
                {(
                  [
                    ['domain', setup.domainVerified, '/sites/domains'],
                    ['article', setup.firstArticlePublished, '/content'],
                    ['crawlers', setup.crawlerPolicySet, '/seo/crawlers'],
                    ['members', setup.membersInvited, '/settings/members'],
                  ] as const
                ).map(([key, done, to]) => (
                  <li key={key}>
                    <Link to={withAdminBase(adminBase, to) as never} className="flex items-center gap-2 rounded-ctl px-1 py-1 text-[13.5px] hover:bg-panel-2">
                      {done ? <CheckCircle2 className="h-4 w-4 text-ok" aria-hidden="true" /> : <Circle className="h-4 w-4 text-icon" aria-hidden="true" />}
                      <span className={cn(done && 'text-dim line-through')}>{t(`setup.${key}`)}</span>
                      {done ? <span className="sr-only">{t('setup.done')}</span> : null}
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          {scope.kind === 'current' ? (
            <Card title={t('activity.title')}>
              {feed.isLoading ? (
                <Skeleton className="h-24" />
              ) : !feed.data?.activity.length ? (
                <p className="t-aux">{t('activity.empty')}</p>
              ) : (
                <ul className="flex flex-col gap-2.5">
                  {feed.data.activity.slice(0, 8).map((a) => (
                    <li key={`${a.kind}:${a.itemId}:${a.at}`} className="flex items-start gap-2 text-[13px]">
                      <span className={cn('mt-1 h-2 w-2 shrink-0 rounded-full', a.kind === 'published' ? 'bg-ok' : a.kind === 'rejected' ? 'bg-bad' : 'bg-warn')} aria-hidden="true" />
                      <span className="min-w-0 flex-1">
                        <Link to={withAdminBase(adminBase, `/content/${a.collection}/${a.itemId}`) as never} className="block truncate font-medium hover:underline">
                          {a.title}
                        </Link>
                        <span className="t-aux">
                          {t(`activity.${a.kind}`)} · <RelativeTime value={a.at} />
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          ) : null}
        </div>
      </div>

      {scope.kind === 'current' ? (
        <Card title={t('week.title')} className="mt-4">
          <WeekCalendar days={week.days} items={feed.data?.week ?? []} loading={feed.isLoading} />
        </Card>
      ) : null}

      <p className="mt-4 text-[12.5px]">
        <Link to={withAdminBase(adminBase, '/overview/dashboards') as never} className="text-brand hover:underline">
          {t('dashboards')}
        </Link>
      </p>
    </Page>
  );
}

function TodoRow({ todo, scope: s, sites: scopeSites, onGo }: { todo: Todo; scope: Scope; sites: SiteSummary[]; onGo: (path: string, siteId?: string) => void }) {
  const { t, i18n } = useTranslation(['overview', 'common']);
  const lang = i18n.language;
  const singleSite = s.kind === 'site' ? s.siteId : undefined;
  const icon = { alerts: ShieldAlert, domains: Globe2, auditErrors: AlertTriangle, reviews: FileText, auditWarnings: AlertTriangle }[todo.kind];
  const Icon = icon;
  const tone = todo.kind === 'alerts' || todo.kind === 'domains' || todo.kind === 'auditErrors' ? 'text-bad' : 'text-warn';
  const [picking, setPicking] = useState(false);
  if (todo.unavailable) {
    return (
      <li className="flex items-center gap-3 py-3">
        <Clock className="h-4 w-4 text-icon" aria-hidden="true" />
        <span className="text-[13.5px]">{t(todo.unavailable === 'mfa_required' ? 'todo.mfa' : 'todo.unavailable')}</span>
        {todo.unavailable === 'mfa_required' && singleSite ? (
          <button type="button" className="ml-auto text-[13px] text-brand hover:underline" onClick={() => onGo('/overview', singleSite)}>
            {t('common:switchAndVerify')}
          </button>
        ) : null}
      </li>
    );
  }
  const title =
    todo.kind === 'reviews'
      ? t('todo.reviews', { count: todo.count })
      : todo.kind === 'alerts'
        ? t('todo.alerts', { count: todo.count })
        : todo.kind === 'domains'
          ? t('todo.domains', { count: todo.count })
          : todo.kind === 'auditErrors'
            ? t('todo.auditErrors', { count: todo.count })
            : t('todo.auditWarnings', { count: todo.count });
  let detail: ReactNode = null;
  if (todo.oldest) detail = t('todo.oldest', { title: todo.oldest.title, wait: formatDuration(todo.oldest.waitSeconds, lang) });
  else if (todo.kind === 'reviews' && todo.longestWaitSeconds != null) {
    detail = [t('todo.longestWait', { wait: formatDuration(todo.longestWaitSeconds, lang) }), s.kind === 'all' && todo.sites ? t('todo.acrossSites', { count: todo.sites }) : null].filter(Boolean).join(' · ');
  } else if (todo.detail?.host) {
    detail = todo.detail.code === 'domain_pending' ? t('todo.domainPending', { host: todo.detail.host }) : t('todo.domainFailed', { host: todo.detail.host, detail: todo.detail.detail ?? '' });
  } else if (todo.kind === 'alerts') detail = t('todo.alertsHint');
  const path = { alerts: '/monitoring', domains: '/sites/domains', auditErrors: '/audit', reviews: '/content?view=pending', auditWarnings: '/audit' }[todo.kind];
  const reviewSites = scopeSites.filter((x) => isAvailable(x) && typeof x.pendingReviews === 'object' && x.pendingReviews.count > 0);
  const onClick = () => {
    if (s.kind === 'all' && todo.kind === 'reviews') setPicking((p) => !p);
    else onGo(path, singleSite);
  };
  return (
    <li className="py-1">
      <button type="button" onClick={onClick} className="flex w-full items-start gap-3 rounded-ctl px-2 py-2.5 text-left hover:bg-panel-2" aria-expanded={s.kind === 'all' && todo.kind === 'reviews' ? picking : undefined}>
        <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', tone)} aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block text-[13.5px] font-medium">{title}</span>
          {detail ? <span className="block truncate t-aux">{detail}</span> : null}
        </span>
      </button>
      {picking ? (
        <ul aria-label={t('todo.pickSite')} className="mb-2 ml-9 flex flex-col gap-1">
          {reviewSites.map((x) => (
            <li key={x.id}>
              <button type="button" className="flex w-full items-center justify-between rounded-ctl px-2 py-1.5 text-[13px] hover:bg-panel-2" onClick={() => onGo('/content?view=pending', x.id)}>
                <span>{x.name}</span>
                <span className="t-num text-dim">{isAvailable(x) && typeof x.pendingReviews === 'object' ? x.pendingReviews.count : ''}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function ScopeSwitch({ scope, onChange, sites, currentId }: { scope: Scope; onChange: (s: Scope) => void; sites: SiteSummary[]; currentId: string }) {
  const { t } = useTranslation('overview');
  const others = sites.filter((s) => s.id !== currentId);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div role="radiogroup" aria-label={t('scope.label')} className="inline-flex rounded-ctl bg-panel-2 p-0.5">
        {(['current', 'all'] as const).map((k) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={scope.kind === k}
            onClick={() => onChange({ kind: k })}
            className={cn('rounded-[6px] px-3 py-1.5 text-[13px]', scope.kind === k ? 'bg-panel font-medium shadow-sm' : 'text-dim')}
          >
            {t(`scope.${k}`)}
          </button>
        ))}
      </div>
      {others.length ? (
        <select
          aria-label={t('scope.label')}
          value={scope.kind === 'site' ? scope.siteId : ''}
          onChange={(e) => onChange(e.target.value ? { kind: 'site', siteId: e.target.value } : { kind: 'current' })}
          className="h-8 rounded-ctl border border-line bg-panel px-2 text-[13px]"
        >
          <option value="">{t('scope.pick')}</option>
          {others.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      ) : null}
    </div>
  );
}

function Card({ title, action, children, className }: { title: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('rounded-card border border-line bg-panel p-4', className)} aria-label={title}>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="t-section">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function Kpi({ label, value, change, trend, note }: { label: string; value: string | null; change?: number | null; trend?: number[]; note?: ReactNode }) {
  const { t } = useTranslation('common');
  return (
    <div className="flex flex-col justify-between rounded-card border border-line bg-panel p-4">
      <span className="t-aux">{label}</span>
      <div className="mt-2 flex items-end justify-between gap-2">
        {value === null ? <Skeleton className="h-8 w-20" /> : <span className="text-[26px] font-semibold leading-none t-num">{value}</span>}
        {trend && trend.length > 1 ? <Sparkline values={trend} /> : null}
      </div>
      {change !== undefined ? (
        <span className={cn('mt-1.5 text-[12px] t-num', change === null ? 'text-dim' : change >= 0 ? 'text-ok' : 'text-bad')}>
          {change === null ? t('noPrevious') : t('changeVsPrevious', { value: change > 0 ? `+${change}` : change })}
        </span>
      ) : null}
      {note}
    </div>
  );
}

function ExclusionNote({ e }: { e: Exclusions }) {
  const { t } = useTranslation(['overview', 'common']);
  if (!incomplete(e)) return null;
  const parts = [
    e.mfa ? t('common:sitesExcluded.mfa', { count: e.mfa }) : null,
    e.unavailable ? t('common:sitesExcluded.unavailable', { count: e.unavailable }) : null,
    e.noPermission ? t('common:sitesExcluded.noPermission', { count: e.noPermission }) : null,
    e.partial ? t('common:sitesExcluded.partial', { count: e.partial }) : null,
  ].filter(Boolean);
  return (
    <span className="mt-1.5 text-[11.5px] text-warn">
      {t('kpi.incomplete')}: {parts.join(', ')}
    </span>
  );
}

export function WeekCalendar({ days, items, loading }: { days: Date[]; items: Array<{ itemId: string; collection: string; title: string; kind: 'published' | 'scheduled' | 'pending'; at: string }>; loading: boolean }) {
  const { t, i18n } = useTranslation('overview');
  const { location } = useRouterState();
  const adminBase = getAdminBase(location.pathname);
  const today = new Date();
  const same = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (loading) return <Skeleton className="h-32" />;
  if (!items.length) return <p className="t-aux">{t('week.empty')}</p>;
  const dayName = new Intl.DateTimeFormat(i18n.language, { weekday: 'short', day: 'numeric' });
  const timeOf = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' });
  const tone = { published: 'border-ok/40 bg-ok-soft text-ok', scheduled: 'border-brand/30 bg-soft text-brand', pending: 'border-warn/40 bg-warn-soft text-warn' } as const;
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-7">
      {days.map((d) => {
        const mine = items.filter((it) => same(new Date(it.at), d));
        const isToday = same(d, today);
        return (
          <div key={d.toISOString()} className={cn('min-h-24 rounded-ctl border p-2', isToday ? 'border-brand bg-sel' : 'border-line')}>
            <div className={cn('mb-1.5 text-[12px] font-medium', isToday ? 'text-brand' : 'text-dim')}>
              {dayName.format(d)}
              {isToday ? <span className="sr-only"> ({t('week.today')})</span> : null}
            </div>
            <ul className="flex flex-col gap-1">
              {mine.map((it) => (
                <li key={`${it.kind}:${it.itemId}`}>
                  <Link
                    to={withAdminBase(adminBase, `/content/${it.collection}/${it.itemId}`) as never}
                    title={`${it.title} · ${timeOf.format(new Date(it.at))}`}
                    className={cn('block truncate rounded-[5px] border px-1.5 py-0.5 text-[11.5px]', tone[it.kind])}
                  >
                    <span className="sr-only">{t(`week.${it.kind}`)}: </span>
                    {it.kind === 'published' ? <Check className="mr-1 inline h-3 w-3" aria-hidden="true" /> : null}
                    {it.title}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
