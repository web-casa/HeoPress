import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useRouterState } from '@tanstack/react-router';
import { Activity, Pause, Play, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { StudioSavedFilter } from '@heopress/contracts';
import { getAdminBase } from '@/lib/admin-base';
import { getApiClient } from '@/lib/api';
import { cn } from '@/lib/cn';
import { withAdminBase } from '@/lib/keybindings/commands';
import { siteKey, studioApi, type ServiceStatus, type StreamEvent } from '../api';
import { ModulePanel, PanelSection } from '../shell/module-panel';
import { Page } from '../shell/module-layout';
import { saveStudioPreferences } from '../shell/preferences';
import { EmptyState } from '../ui/empty-state';
import { PageHeader } from '../ui/page-header';
import { RelativeTime } from '../ui/relative-time';
import { Skeleton, SkeletonRows } from '../ui/skeleton';
import { queryOf, useEventStream, type StreamFilter } from './stream';

type LevelChoice = 'all' | 'warnPlus' | 'error' | 'success';
const LEVELS: Record<LevelChoice, string[]> = { all: [], warnPlus: ['warn', 'error'], error: ['error'], success: ['info'] };

/** A status card's filter on the stream (spec studio/monitoring "按来源过滤"). */
export const CARD_FILTERS: Record<string, { sources: string[]; q: string }> = {
  reachability: { sources: ['run'], q: 'reachability' },
  audit: { sources: ['run'], q: 'site-audit|link-scan' },
  linkScan: { sources: ['run'], q: 'link-scan' },
  jobs: { sources: ['system'], q: 'scheduled_job' },
};

/** A card's state from what the server recorded; nothing readable is "unknown", never OK. */
export function cardState(status: string | null | undefined): 'ok' | 'warn' | 'bad' | 'unknown' {
  if (status === 'done' || status === 'healthy') return 'ok';
  if (status === 'failed' || status === 'unhealthy' || status === 'lost') return 'bad';
  if (status === 'truncated' || status === 'degraded' || status === 'partial' || status === 'running') return 'warn';
  return 'unknown';
}

const TONE = { ok: 'text-ok', warn: 'text-warn', bad: 'text-bad', unknown: 'text-dim' } as const;

/** Logs & monitoring (spec studio/monitoring). */
export function MonitoringPage() {
  const { t } = useTranslation('monitoring');
  const { location } = useRouterState();
  const adminBase = getAdminBase(location.pathname);
  const qc = useQueryClient();
  const [level, setLevel] = useState<LevelChoice>('all');
  const [card, setCard] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [saveName, setSaveName] = useState('');
  const cardFilter = card ? CARD_FILTERS[card] : undefined;
  const filter: StreamFilter = { levels: LEVELS[level], sources: cardFilter?.sources ?? [], q: q || cardFilter?.q || '' };
  const stream = useEventStream(filter);
  const status = useQuery({ queryKey: siteKey('service-status'), queryFn: studioApi.serviceStatus, refetchInterval: 30_000 });
  const statsFilter = { ...filter, levels: [] };
  const stats = useQuery({ queryKey: siteKey('event-stats', queryOf(statsFilter)), queryFn: () => studioApi.eventStats(queryOf(statsFilter)), refetchInterval: 15_000 });
  const prefs = useQuery({ queryKey: ['me', 'preferences'], queryFn: () => getApiClient().me.getPreferences() });
  const saved = ((prefs.data?.data as { studio?: { savedFilters?: StudioSavedFilter[] } } | undefined)?.studio?.savedFilters ?? []) as StudioSavedFilter[];
  const chosen = stream.events.find((e) => e.id === selected) ?? null;

  const toggleCard = (key: string) => {
    setCard((c) => (c === key ? null : key));
    setQ('');
  };
  const persist = async (list: StudioSavedFilter[]) => {
    await saveStudioPreferences({ savedFilters: list });
    await qc.invalidateQueries({ queryKey: ['me', 'preferences'] });
  };
  const levelCounts = stats.data?.levels;
  const countOf = (choice: LevelChoice) =>
    !levelCounts ? null : choice === 'all' ? levelCounts.info + levelCounts.warn + levelCounts.error : choice === 'warnPlus' ? levelCounts.warn + levelCounts.error : choice === 'error' ? levelCounts.error : levelCounts.info;

  return (
    <>
      <ModulePanel>
        <PanelSection title={t('panel.saved')}>
          {saved.length === 0 ? <p className="px-2 t-aux">{t('panel.noSaved')}</p> : null}
          {saved.map((f) => (
            <div key={f.id} className="flex items-center gap-1">
              <button
                type="button"
                className="h-8 flex-1 truncate rounded-ctl px-2 text-left text-[13px] text-dim hover:bg-panel-2 hover:text-fg"
                onClick={() => {
                  setCard(null);
                  setQ(f.query ?? '');
                  const lv = (f.levels ?? []).join(',');
                  setLevel(lv === 'warn,error' || lv === 'error,warn' ? 'warnPlus' : lv === 'error' ? 'error' : lv === 'info' ? 'success' : 'all');
                  if (f.sources?.length) setCard(Object.keys(CARD_FILTERS).find((k) => CARD_FILTERS[k]!.sources.join() === f.sources!.join() && CARD_FILTERS[k]!.q === f.query) ?? null);
                }}
              >
                {f.name}
              </button>
              <button type="button" aria-label={t('panel.remove', { name: f.name })} className="rounded-ctl p-1 text-icon hover:bg-panel-2" onClick={() => void persist(saved.filter((x) => x.id !== f.id))}>
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
          ))}
          <form
            className="mt-1 flex gap-1 px-1"
            onSubmit={(e) => {
              e.preventDefault();
              if (!saveName.trim() || saved.length >= 20) return;
              const next: StudioSavedFilter = { id: `f${Date.now().toString(36)}`, name: saveName.trim().slice(0, 80), levels: LEVELS[level] as StudioSavedFilter['levels'], sources: filter.sources, query: filter.q || undefined };
              void persist([...saved, next]).then(() => setSaveName(''));
            }}
          >
            <label className="sr-only" htmlFor="saved-filter-name">
              {t('panel.name')}
            </label>
            <input id="saved-filter-name" value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder={t('panel.name')} className="h-8 min-w-0 flex-1 rounded-ctl border border-line bg-panel px-2 text-[12.5px]" />
            <button type="submit" disabled={!saveName.trim() || saved.length >= 20} title={saved.length >= 20 ? t('panel.tooMany') : undefined} className="rounded-ctl border border-line bg-panel px-2 text-[12px] hover:bg-panel-2 disabled:opacity-50">
              {t('panel.save')}
            </button>
          </form>
        </PanelSection>
        {stream.earliest ? <EarliestBySource bySource={stream.earliestBySource} /> : null}
      </ModulePanel>

      <Page wide>
        <PageHeader title={t('title')} description={t('description')} />
        <StatusCards status={status.data} loading={status.isLoading} active={card} onToggle={toggleCard} />

        <div className="mb-3 mt-5 flex flex-wrap items-center gap-2">
          <div role="radiogroup" aria-label={t('levels.label')} className="inline-flex rounded-ctl bg-panel-2 p-0.5">
            {(Object.keys(LEVELS) as LevelChoice[]).map((l) => (
              <button key={l} type="button" role="radio" aria-checked={level === l} onClick={() => setLevel(l)} className={cn('rounded-[6px] px-3 py-1.5 text-[13px]', level === l ? 'bg-panel font-medium shadow-sm' : 'text-dim')}>
                {t(`levels.${l}`)} {countOf(l) !== null ? <span className="ml-1 t-num text-[12px] text-dim">{countOf(l)}</span> : null}
              </button>
            ))}
          </div>
          <label className="min-w-0 flex-1">
            <span className="sr-only">{t('query')}</span>
            <input value={q || cardFilter?.q || ''} onChange={(e) => setQ(e.target.value)} placeholder={t('query')} title={t('queryHint')} className="h-8 w-full rounded-ctl border border-line bg-panel px-2 font-mono text-[12.5px]" />
          </label>
          <button type="button" onClick={stream.paused ? stream.resume : stream.pause} className="inline-flex h-8 items-center gap-1.5 rounded-ctl border border-line bg-panel px-3 text-[13px] hover:bg-panel-2">
            {stream.paused ? <Play className="h-3.5 w-3.5" aria-hidden="true" /> : <Pause className="h-3.5 w-3.5" aria-hidden="true" />}
            {stream.paused ? t('resume') : t('pause')}
          </button>
          <span role="status" className={cn('text-[12.5px]', stream.paused ? 'text-warn' : 'text-ok')}>
            {stream.paused ? (stream.waiting ? t('newWhilePaused', { count: stream.waiting }) : t('paused')) : t('live')}
          </span>
        </div>

        <Histogram minutes={stats.data?.minutes} />

        <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
          <section aria-label={t('title')} className="rounded-card border border-line bg-panel">
            {stream.loading ? (
              <div className="p-4">
                <SkeletonRows rows={8} />
              </div>
            ) : stream.failed && stream.events.length === 0 ? (
              <div className="p-4">
                <EmptyState
                  icon={Activity}
                  title={t('loadFailed')}
                  action={
                    <button type="button" onClick={stream.retry} className="rounded-ctl border border-line px-2.5 py-1.5 text-[13px] hover:bg-panel-2">
                      {t('common:retry')}
                    </button>
                  }
                />
              </div>
            ) : stream.events.length === 0 ? (
              <div className="p-4">
                <EmptyState icon={Activity} title={t('empty')} />
              </div>
            ) : (
              <ol className="divide-y divide-line">
                {stream.events.map((e) => (
                  <li key={e.id}>
                    <button type="button" data-event-id={e.id} onClick={() => setSelected(e.id)} aria-current={selected === e.id ? 'true' : undefined} className={cn('grid w-full grid-cols-[auto_auto_1fr] items-baseline gap-3 px-4 py-2 text-left text-[13px]', selected === e.id ? 'bg-sel' : 'hover:bg-panel-2')}>
                      <span className={cn('w-12 text-[11.5px] font-medium uppercase', e.level === 'error' ? 'text-bad' : e.level === 'warn' ? 'text-warn' : 'text-dim')}>{e.level}</span>
                      <span className="w-20 text-[12px] text-dim">
                        <RelativeTime value={e.at} />
                      </span>
                      <span className="truncate">
                        <span className="mr-2 rounded bg-panel-2 px-1.5 py-0.5 text-[11px] text-dim">{t(`sources.${e.source}`)}</span>
                        {e.message}
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
            )}
            {stream.hasMore ? (
              <button type="button" onClick={() => void stream.loadMore()} className="w-full border-t border-line py-2 text-[13px] text-brand hover:bg-panel-2">
                {t('more')}
              </button>
            ) : null}
          </section>
          <EventDetail event={chosen} adminBase={adminBase} />
        </div>
      </Page>
    </>
  );
}

export function StatusCards({ status, loading, active, onToggle }: { status: ServiceStatus | undefined; loading: boolean; active: string | null; onToggle: (key: string) => void }) {
  const { t } = useTranslation('monitoring');
  if (loading) return <Skeleton className="h-24" />;
  const site = status?.site;
  const cards: Array<{ key: string; label: string; state: ReturnType<typeof cardState>; at: string | null; note?: string; filter?: boolean }> = [
    { key: 'reachability', label: t('cards.reachability'), state: cardState(site?.reachability.status), at: site?.reachability.checkedAt ?? null, filter: true },
    { key: 'audit', label: t('cards.audit'), state: cardState(worst(site?.audit.status, site?.linkScan.status)), at: site?.audit.checkedAt ?? site?.linkScan.checkedAt ?? null, filter: true },
  ];
  const instance = status?.instance;
  const instanceCards = instance
    ? [
        ...Object.entries(instance.services).map(([name, s]) => ({ key: name, label: t(`cards.${name}`), state: cardState(s), at: instance.checkedAt })),
        {
          key: 'jobs',
          label: t('cards.jobs'),
          state: instance.failedJobs24h === null ? ('unknown' as const) : instance.failedJobs24h > 0 ? ('bad' as const) : ('ok' as const),
          at: instance.checkedAt,
          note: instance.failedJobs24h ? t('cards.failedJobs', { count: instance.failedJobs24h }) : undefined,
          filter: true,
        },
      ]
    : [];
  const render = (c: (typeof cards)[number]) => (
    <button
      key={c.key}
      type="button"
      disabled={!c.filter}
      aria-pressed={c.filter ? active === c.key : undefined}
      title={active === c.key ? t('cards.filtering') : undefined}
      onClick={() => c.filter && onToggle(c.key)}
      className={cn('flex flex-col items-start gap-1 rounded-card border bg-panel p-3 text-left', active === c.key ? 'border-brand bg-sel' : 'border-line', c.filter ? 'hover:bg-panel-2' : 'cursor-default')}
    >
      <span className="text-[12.5px] text-dim">{c.label}</span>
      <span className={cn('text-[15px] font-semibold', TONE[c.state])}>{t(`state.${c.state}`)}</span>
      <span className="text-[11.5px] text-dim">
        {c.at ? (
          <>
            {t('cards.checked')} <RelativeTime value={c.at} />
          </>
        ) : (
          t('cards.never')
        )}
      </span>
      {c.note ? <span className="text-[11.5px] text-bad">{c.note}</span> : null}
    </button>
  );
  return (
    <div className="flex flex-col gap-3">
      <section aria-label={t('cards.site')}>
        <h2 className="mb-2 text-[12.5px] font-medium text-dim">{t('cards.site')}</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">{cards.map(render)}</div>
      </section>
      {instanceCards.length ? (
        <section aria-label={t('cards.instance')}>
          <h2 className="mb-2 text-[12.5px] font-medium text-dim">{t('cards.instance')}</h2>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">{instanceCards.map(render)}</div>
        </section>
      ) : null}
    </div>
  );
}

function worst(...statuses: Array<string | null | undefined>): string | null {
  const order = ['failed', 'truncated', 'running', 'partial', 'done'];
  const present = statuses.filter((s): s is string => !!s && s !== 'unknown');
  return present.sort((a, b) => order.indexOf(a) - order.indexOf(b))[0] ?? null;
}

function Histogram({ minutes }: { minutes: Array<{ at: string; total: number; errors: number }> | undefined }) {
  const { t } = useTranslation('monitoring');
  if (!minutes) return <Skeleton className="h-16" />;
  const max = Math.max(1, ...minutes.map((m) => m.total));
  return (
    <figure className="m-0 rounded-card border border-line bg-panel px-3 py-2" aria-label={t('histogram')}>
      <div className="flex h-12 items-end gap-[2px]" aria-hidden="true">
        {minutes.map((m) => (
          <span key={m.at} className="relative flex-1" style={{ height: `${(m.total / max) * 100}%`, minHeight: m.total ? 2 : 0, background: 'var(--chart-2)' }}>
            {m.errors ? <span className="absolute inset-x-0 bottom-0" style={{ height: `${(m.errors / m.total) * 100}%`, background: 'var(--bad)' }} /> : null}
          </span>
        ))}
      </div>
      <figcaption className="mt-1 text-[11.5px] text-dim">
        {t('histogram')} · {minutes.reduce((n, m) => n + m.total, 0)} · {t('histogramErrors')} {minutes.reduce((n, m) => n + m.errors, 0)}
      </figcaption>
    </figure>
  );
}

export function EventDetail({ event, adminBase }: { event: StreamEvent | null; adminBase: string }) {
  const { t } = useTranslation('monitoring');
  const [copied, setCopied] = useState(false);
  if (!event) {
    return (
      <aside className="rounded-card border border-line bg-panel p-4">
        <EmptyState icon={Activity} title={t('detail.empty')} />
      </aside>
    );
  }
  const json = JSON.stringify(event, null, 2);
  const actions: Array<[string, string]> = [];
  if (event.subject?.type === 'item' && event.subject.collection) actions.push([t('detail.openItem'), `/content/${event.subject.collection}/${event.subject.id}`]);
  if (/audit/.test(event.event) || /site-audit|link-scan/.test(event.message)) actions.push([t('detail.openAudit'), '/audit']);
  if (/reachability/.test(event.event) || /reachability/.test(event.message)) actions.push([t('detail.openReachability'), '/monitoring/reachability']);
  return (
    <aside aria-label={event.event} className="flex flex-col gap-3 rounded-card border border-line bg-panel p-4">
      <div>
        <h2 className="t-section">{event.message}</h2>
        <p className="t-aux">
          {t(`sources.${event.source}`)} · <RelativeTime value={event.at} />
        </p>
      </div>
      <div>
        <div className="mb-1 flex items-center justify-between">
          <h3 className="text-[12.5px] font-medium text-dim">{t('detail.fields')}</h3>
          <button
            type="button"
            className="rounded-ctl px-2 py-0.5 text-[12px] text-brand hover:bg-panel-2"
            onClick={() => void navigator.clipboard?.writeText(json).then(() => setCopied(true))}
          >
            {copied ? t('detail.copied') : t('detail.copy')}
          </button>
        </div>
        <pre className="max-h-72 overflow-auto rounded-ctl bg-panel-2 p-2 font-mono text-[11.5px]">{json}</pre>
      </div>
      {actions.length ? (
        <div className="flex flex-wrap gap-2">
          {actions.map(([label, to]) => (
            <Link key={to} to={withAdminBase(adminBase, to) as never} className="rounded-ctl border border-line px-2.5 py-1 text-[12.5px] hover:bg-panel-2">
              {label}
            </Link>
          ))}
        </div>
      ) : null}
    </aside>
  );
}

/** Where each source's record begins (spec ops/event-log "超出保留期"): sources keep their events for different times. */
export function EarliestBySource({ bySource }: { bySource: Record<string, string> }) {
  const { t } = useTranslation('monitoring');
  return (
    <div className="px-2 t-aux">
      <p>{t('panel.earliestBySource')}</p>
      <ul aria-label={t('panel.earliestBySource')} className="mt-1 flex flex-col gap-0.5">
        {Object.entries(bySource)
          .sort(([, a], [, b]) => a.localeCompare(b))
          .map(([source, at]) => (
            <li key={source}>
              {t(`sources.${source}`)}: <RelativeTime value={at} />
            </li>
          ))}
      </ul>
    </div>
  );
}
