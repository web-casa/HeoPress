import { Link, useRouterState } from '@tanstack/react-router';
import { AlertTriangle, CheckCircle2, Clock, FileText, Globe2, ShieldAlert } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { getAdminBase } from '@/lib/admin-base';
import { cn } from '@/lib/cn';
import { withAdminBase } from '@/lib/keybindings/commands';
import { isAvailable, type SiteSummary } from '../api';
import { Card } from '../ui/card';
import { EmptyState } from '../ui/empty-state';
import { formatDuration } from '../ui/format';
import { RelativeTime } from '../ui/relative-time';
import { Skeleton } from '../ui/skeleton';
import type { Briefing as BriefingModel, HealthSignal, Scope, SiteHealth, Todo } from './model';

/**
 * The overview's briefing (v1.1; spec studio/briefing): three sections answering "what should I do today?" —
 * needs attention, changes in the last seven days, and the site's health. Presentational: the page owns the reads
 * (`studio/overview/feed`, `studio/network-summary`, `studio/service-status`) and `model.ts` owns the rules.
 */

export interface BriefingProps {
  model: BriefingModel;
  scope: Scope;
  sites: SiteSummary[];
  loading: boolean;
  /** When the scope's next audit is due (the empty state's "next check"). */
  nextAudit?: Date | null;
  onGo: (path: string, siteId?: string) => void;
}

export function Briefing({ model, scope, sites, loading, nextAudit, onGo }: BriefingProps) {
  const { t } = useTranslation('overview');
  return (
    <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-3">
      <Card title={t('briefing.needs.title')} className="h-full">
        {loading ? (
          <Skeleton className="h-24" />
        ) : model.attention.length === 0 ? (
          <EmptyState
            icon={CheckCircle2}
            title={t('briefing.needs.empty')}
            body={
              nextAudit ? (
                <>
                  {t('briefing.needs.nextAudit', { when: '' })}
                  <RelativeTime value={nextAudit} />
                </>
              ) : undefined
            }
          />
        ) : (
          <>
            <ul className="flex flex-col divide-y divide-line">
              {model.attention.map((todo) => (
                <TodoRow key={todo.kind} todo={todo} scope={scope} sites={sites} onGo={onGo} />
              ))}
            </ul>
            {model.reviewsUnreadable > 0 ? <p className="mt-2 t-aux">{t('common:sitesExcluded.noPermission', { count: model.reviewsUnreadable })}</p> : null}
            {model.currentSiteOnly ? <p className="mt-2 t-aux">{t('briefing.currentSiteOnly')}</p> : null}
          </>
        )}
      </Card>

      <Card title={t('briefing.recent.title')} className="h-full">
        {loading ? (
          <Skeleton className="h-24" />
        ) : model.recent ? (
          <RecentChanges recent={model.recent} />
        ) : (
          <p className="t-aux">{t('briefing.currentSiteOnly')}</p>
        )}
      </Card>

      <Card title={t('briefing.health.title')} className="h-full">
        {loading ? <Skeleton className="h-24" /> : <HealthView health={model.health} />}
      </Card>
    </div>
  );
}

function RecentChanges({ recent }: { recent: NonNullable<BriefingModel['recent']> }) {
  const { t } = useTranslation('overview');
  const { location } = useRouterState();
  const adminBase = getAdminBase(location.pathname);
  if (recent.published.count === 0 && recent.updated.count === 0) return <p className="t-aux">{t('briefing.recent.empty', { days: recent.days })}</p>;
  const groups = [
    { kind: 'published' as const, data: recent.published },
    { kind: 'updated' as const, data: recent.updated },
  ];
  return (
    <div className="flex flex-col gap-3">
      {groups.map(({ kind, data }) => (
        <div key={kind}>
          <p className="text-[13.5px] font-medium">{t(`briefing.recent.${kind}`, { count: data.count, days: recent.days })}</p>
          {data.examples.length ? (
            <ul className="mt-1 flex flex-col gap-1">
              {data.examples.map((e) => (
                <li key={`${kind}:${e.collection}:${e.itemId}`} className="flex items-baseline justify-between gap-2 text-[13px]">
                  <Link to={withAdminBase(adminBase, `/content/${e.collection}/${e.itemId}`) as never} className="min-w-0 truncate hover:underline">
                    {e.title}
                  </Link>
                  <RelativeTime value={e.at} />
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ))}
    </div>
  );
}

const HEALTH_PATH: Record<HealthSignal['key'], string> = {
  domain: '/sites/domains',
  reachability: '/monitoring',
  auditFailed: '/audit',
  noPrimaryDomain: '/sites/domains',
  audit: '/audit',
  reviewBacklog: '/content?view=pending',
  failedJobs: '/monitoring',
  services: '/monitoring',
};

function HealthView({ health }: { health: SiteHealth }) {
  const { t } = useTranslation('overview');
  const { location } = useRouterState();
  const adminBase = getAdminBase(location.pathname);
  const tone = { bad: 'bg-bad', warn: 'bg-warn', ok: 'bg-ok' } as const;
  const headline =
    health.sites === 0
      ? t('briefing.health.none')
      : health.status === 'bad'
        ? t('briefing.health.bad', { count: health.failing })
        : health.status === 'warn'
          ? t('briefing.health.warn', { count: health.attention })
          : health.status === 'ok'
            ? t('briefing.health.ok')
            : t('briefing.health.unknown');
  const label = (s: HealthSignal): string => {
    switch (s.key) {
      case 'domain':
        return t('briefing.health.domain', { host: s.host ?? '' });
      case 'reachability':
        return s.tone === 'bad' ? t('briefing.health.reachability', { count: s.count }) : t('briefing.health.reachabilityWarnings', { count: s.count });
      case 'auditFailed':
        return t('briefing.health.auditFailed');
      case 'noPrimaryDomain':
        return t('briefing.health.noPrimaryDomain');
      case 'audit':
        return t('briefing.health.audit', { errors: s.errors, warnings: s.warnings });
      case 'reviewBacklog':
        return t('briefing.health.reviewBacklog', { count: s.count });
      case 'failedJobs':
        return t('briefing.health.failedJobs', { count: s.count });
      case 'services':
        return s.names.length ? t(`briefing.health.services_${s.names.length === 1 ? 'one' : 'other'}`, { names: s.names.join(', ') }) : t('briefing.health.servicesOk');
    }
  };
  const healthTone = health.status === 'bad' ? 'bad' : health.status === 'warn' ? 'warn' : health.status === 'ok' ? 'ok' : null;
  return (
    <div className="flex flex-col gap-3">
      <p className="flex items-center gap-2 text-[13.5px] font-medium">
        {healthTone ? <span className={cn('h-2 w-2 shrink-0 rounded-full', tone[healthTone])} aria-hidden="true" /> : <Clock className="h-3.5 w-3.5 text-icon" aria-hidden="true" />}
        {headline}
      </p>
      {health.unreadable > 0 ? <p className="t-aux">{t('briefing.health.unreadable', { count: health.unreadable })}</p> : null}
      {health.signals.length ? (
        <ul className="flex flex-col gap-1.5">
          {health.signals.map((s, i) => (
            <li key={`${s.key}:${i}`} className="flex items-start gap-2 text-[13px]">
              <span className={cn('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', s.tone === 'bad' ? 'bg-bad' : s.tone === 'warn' ? 'bg-warn' : 'bg-ok')} aria-hidden="true" />
              <Link to={withAdminBase(adminBase, HEALTH_PATH[s.key]) as never} className="min-w-0 hover:underline">
                {label(s)}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** One "needs attention" row: count, the most urgent explanation, and where to go (the current site's feed names it). */
function TodoRow({ todo, scope: s, sites: scopeSites, onGo }: { todo: Todo; scope: Scope; sites: SiteSummary[]; onGo: (path: string, siteId?: string) => void }) {
  const { t, i18n } = useTranslation(['overview', 'common']);
  const lang = i18n.language;
  const singleSite = s.kind === 'site' ? s.siteId : undefined;
  const icon = { alerts: ShieldAlert, failedJobs: AlertTriangle, domains: Globe2, auditErrors: AlertTriangle, reviews: FileText, staleDrafts: FileText, auditWarnings: AlertTriangle }[todo.kind];
  const Icon = icon;
  const tone = todo.kind === 'alerts' || todo.kind === 'failedJobs' || todo.kind === 'domains' || todo.kind === 'auditErrors' ? 'text-bad' : 'text-warn';
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
        : todo.kind === 'failedJobs'
          ? t('todo.failedJobs', { count: todo.count })
          : todo.kind === 'domains'
            ? t('todo.domains', { count: todo.count })
            : todo.kind === 'auditErrors'
              ? t('todo.auditErrors', { count: todo.count })
              : todo.kind === 'staleDrafts'
                ? t('todo.staleDrafts', { count: todo.count })
                : t('todo.auditWarnings', { count: todo.count });
  let detail: ReactNode = null;
  if (todo.oldest) {
    const wait = formatDuration(todo.oldest.waitSeconds, lang);
    detail = todo.kind === 'staleDrafts' ? t('todo.staleOldest', { title: todo.oldest.title, wait }) : t('todo.oldest', { title: todo.oldest.title, wait });
  } else if (todo.kind === 'reviews' && todo.longestWaitSeconds != null) {
    detail = [t('todo.longestWait', { wait: formatDuration(todo.longestWaitSeconds, lang) }), s.kind === 'all' && todo.sites ? t('todo.acrossSites', { count: todo.sites }) : null].filter(Boolean).join(' · ');
  } else if (todo.detail?.host) {
    detail = todo.detail.code === 'domain_pending' ? t('todo.domainPending', { host: todo.detail.host }) : t('todo.domainFailed', { host: todo.detail.host, detail: todo.detail.detail ?? '' });
  } else if (todo.kind === 'alerts' || todo.kind === 'failedJobs') {
    detail = t('todo.alertsHint');
  }
  const path = {
    alerts: '/monitoring',
    failedJobs: '/monitoring',
    domains: '/sites/domains',
    auditErrors: '/audit',
    reviews: '/content?view=pending',
    staleDrafts: '/content?view=drafts',
    auditWarnings: '/audit',
  }[todo.kind];
  const reviewSites = scopeSites.filter((x) => isAvailable(x) && typeof x.pendingReviews === 'object' && x.pendingReviews.count > 0);
  const onClick = () => {
    if (s.kind === 'all' && todo.kind === 'reviews') setPicking((p) => !p);
    else onGo(path, singleSite);
  };
  return (
    <li className="py-1">
      <button
        type="button"
        onClick={onClick}
        className="flex w-full items-start gap-3 rounded-ctl px-2 py-2.5 text-left hover:bg-panel-2"
        aria-expanded={s.kind === 'all' && todo.kind === 'reviews' ? picking : undefined}
      >
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
