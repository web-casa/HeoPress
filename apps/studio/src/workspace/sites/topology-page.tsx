import { useQuery } from '@tanstack/react-query';
import { Link, useRouterState } from '@tanstack/react-router';
import { Globe2, Search } from 'lucide-react';
import { useMemo, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { getAdminBase } from '@/lib/admin-base';
import { getApiClient } from '@/lib/api';
import { cn } from '@/lib/cn';
import { withAdminBase } from '@/lib/keybindings/commands';
import { activeSiteId } from '@/lib/session/current';
import { isAvailable, siteKey, useNetworkSummary, type SiteSummary } from '../api';
import { CHART } from '../charts/palette';
import { ShareBar } from '../charts/share-bar';
import { Page } from '../shell/module-layout';
import { openOnSite } from '../site-switch';
import { EmptyState } from '../ui/empty-state';
import { formatNumber } from '../ui/format';
import { PageHeader } from '../ui/page-header';
import { Skeleton, SkeletonRows } from '../ui/skeleton';
import { GROUPS, groupOf, layoutTopology, platformsOf, type Group } from './layout';

const TONE: Record<Group, string> = {
  ok: 'var(--ok)',
  warn: 'var(--warn)',
  bad: 'var(--bad)',
  unknown: 'var(--icon)',
  mfa_required: 'var(--muted)',
  unavailable: 'var(--muted)',
};

/** The primary domain as its state says (spec studio/network-summary). */
export function DomainLabel({ site }: { site: SiteSummary }) {
  const { t } = useTranslation('common');
  if (site.primaryDomainState === 'set' && site.primaryDomain) return <span className="font-mono text-[12px]">{site.primaryDomain}</span>;
  return <span className="text-dim">{t(site.primaryDomainState === 'unset' ? 'noPrimaryDomain' : 'noDomain')}</span>;
}

/** A site's state in words: its health, or its availability. */
export function useStateLabel() {
  const { t } = useTranslation('sites');
  return (site: SiteSummary) => t(`groups.${groupOf(site)}`);
}

const WIDTH = 640;
const HEIGHT = 520;

/** Sites (spec studio/site-topology): the topology of the sites you may enter and the selected site's details. */
export function SitesTopologyPage() {
  const { t } = useTranslation('sites');
  const summary = useNetworkSummary();
  const sites = useMemo(() => summary.data ?? [], [summary.data]);
  const [selected, setSelected] = useState<string | null>(null);
  const [layer, setLayer] = useState(true);
  const chosen = sites.find((s) => s.id === selected) ?? null;

  return (
    <Page wide>
      <PageHeader
        title={t('title')}
        description={t('topologyDescription')}
        actions={
          <label className="flex items-center gap-2 text-[13px]">
            <input type="checkbox" checked={layer} onChange={(e) => setLayer(e.target.checked)} className="accent-[var(--accent)]" />
            {t('layerOn')}
          </label>
        }
      />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <section aria-label={t('title')} className="rounded-card border border-line bg-panel p-3">
          {summary.isLoading ? <Skeleton className="h-[420px]" /> : <Topology sites={sites} selected={selected} onSelect={setSelected} layer={layer} />}
          <p className="mt-1 px-2 t-aux">{t('noEdgesHint')}</p>
        </section>
        <SiteDetail site={chosen} />
      </div>
    </Page>
  );
}

export function Topology({ sites, selected, onSelect, layer }: { sites: SiteSummary[]; selected: string | null; onSelect: (id: string) => void; layer: boolean }) {
  const { t } = useTranslation('sites');
  const stateLabel = useStateLabel();
  const layout = useMemo(() => layoutTopology(sites, { width: WIDTH, height: HEIGHT }), [sites]);
  const platforms = useMemo(() => platformsOf(sites).slice(0, 8), [sites]);
  const chosen = layout.nodes.find((n) => n.site.id === selected);
  // Platforms on an outer ring, offset from the sites' angles so a label never sits on a node.
  const platformAt = (i: number) => {
    const offset = Math.PI / Math.max(layout.nodes.length, 2);
    const angle = -Math.PI / 2 + offset + (i * 2 * Math.PI) / Math.max(platforms.length, 1);
    const r = layout.radius + 48;
    return { x: WIDTH / 2 + r * Math.cos(angle), y: HEIGHT / 2 + r * Math.sin(angle) };
  };
  const edges = layer && chosen && isAvailable(chosen.site) ? chosen.site.referralsByPlatform : [];
  const maxHits = Math.max(1, ...edges.map((e) => e.hits));
  const onKey = (e: KeyboardEvent, i: number) => {
    const n = layout.nodes.length;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      (document.querySelectorAll<SVGGElement>('[data-topology-node]')[(i + 1) % n])?.focus();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      (document.querySelectorAll<SVGGElement>('[data-topology-node]')[(i - 1 + n) % n])?.focus();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect(layout.nodes[i]!.site.id);
    }
  };
  return (
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="h-auto w-full" role="group" aria-label={t('title')}>
      {layout.grouped
        ? layout.sectors.map((s) => {
            const mid = (s.from + s.to) / 2;
            const r = layout.radius + 30;
            return (
              <text key={s.group} x={layout.center.x + r * Math.cos(mid)} y={layout.center.y + r * Math.sin(mid)} textAnchor="middle" className="fill-[var(--muted)] text-[11px]">
                {`${t(`groups.${s.group}`)} · ${s.count}`}
              </text>
            );
          })
        : null}
      {layout.nodes.map((n) => (
        <line key={`spoke-${n.site.id}`} x1={layout.center.x} y1={layout.center.y} x2={n.x} y2={n.y} stroke="var(--line)" strokeWidth={1} />
      ))}
      {layer && platforms.length
        ? platforms.map((p, i) => {
            const at = platformAt(i);
            const edge = edges.find((e) => e.operator === p.operator);
            return (
              <g key={p.operator}>
                {edge && chosen ? <line x1={chosen.x} y1={chosen.y} x2={at.x} y2={at.y} stroke="var(--accent)" strokeOpacity={0.7} strokeWidth={1 + (3 * edge.hits) / maxHits} data-platform-edge={p.operator} /> : null}
                <rect x={at.x - 42} y={at.y - 11} width={84} height={22} rx={11} fill="var(--soft)" />
                <text x={at.x} y={at.y + 4} textAnchor="middle" className="fill-[var(--accent)] text-[11px] font-medium">
                  {p.operator}
                </text>
              </g>
            );
          })
        : null}
      <circle cx={layout.center.x} cy={layout.center.y} r={26} fill="var(--fg)" />
      <text x={layout.center.x} y={layout.center.y + 4} textAnchor="middle" className="fill-[var(--bg)] text-[11px] font-semibold">
        {t('deployment')}
      </text>
      {layout.nodes.map((n, i) => {
        const isSelected = n.site.id === selected;
        const name = t('node', { name: n.site.name, state: stateLabel(n.site) });
        return (
          <g
            key={n.site.id}
            data-topology-node={n.site.id}
            role="button"
            tabIndex={i === 0 ? 0 : -1}
            aria-label={name}
            aria-pressed={isSelected}
            onClick={() => onSelect(n.site.id)}
            onKeyDown={(e) => onKey(e, i)}
            className="cursor-pointer outline-none [&:focus-visible>circle:first-child]:stroke-[var(--accent)]"
          >
            <circle cx={n.x} cy={n.y} r={isSelected ? 13 : 10} fill="var(--panel)" stroke={isSelected ? 'var(--accent)' : TONE[n.group]} strokeWidth={isSelected ? 3 : 2.5} strokeDasharray={n.group === 'mfa_required' || n.group === 'unavailable' ? '3 3' : undefined} />
            <circle cx={n.x} cy={n.y} r={4} fill={TONE[n.group]} />
            {!layout.grouped || isSelected ? (
              <text x={n.x} y={n.y + 26} textAnchor="middle" className="fill-[var(--fg)] text-[11.5px]">
                {n.site.name}
              </text>
            ) : null}
          </g>
        );
      })}
      {layer && chosen && !isAvailable(chosen.site) ? (
        <text x={chosen.x} y={chosen.y - 20} textAnchor="middle" className="fill-[var(--muted)] text-[11px]">
          {t('verifyToSee')}
        </text>
      ) : null}
    </svg>
  );
}

interface TopPage {
  path: string;
  hits: number;
  itemId?: string;
  collection?: string;
}

export function SiteDetail({ site }: { site: SiteSummary | null }) {
  const { t, i18n } = useTranslation(['sites', 'common']);
  const stateLabel = useStateLabel();
  const lang = i18n.language;
  const { location } = useRouterState();
  const adminBase = getAdminBase(location.pathname);
  const current = site?.id === activeSiteId();
  // Page-level content for the current site only (never another site's pages).
  const top = useQuery({
    queryKey: siteKey('ai-traffic-report', 30),
    queryFn: async () => (await getApiClient().rawRequest<{ topCrawled: TopPage[] }>('/api/v1/site/ai-traffic?days=30&previous=1')).data,
    enabled: !!site && current && site.availability === 'available',
  });
  if (!site) {
    return (
      <aside className="rounded-card border border-line bg-panel p-4">
        <EmptyState icon={Globe2} title={t('detail.empty')} />
      </aside>
    );
  }
  const identity = (
    <dl className="mb-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
      <dt className="text-dim">{t('detail.domain')}</dt>
      <dd>
        <DomainLabel site={site} />
      </dd>
      <dt className="text-dim">{t('detail.role')}</dt>
      <dd>{site.role ?? '—'}</dd>
    </dl>
  );
  const go = (path: string) => (current ? null : () => void openOnSite(site.id, path));
  if (!isAvailable(site)) {
    return (
      <aside aria-label={site.name} className="rounded-card border border-line bg-panel p-4">
        <h2 className="mb-2 t-section">{site.name}</h2>
        {identity}
        <p className="rounded-ctl bg-warn-soft px-3 py-2 text-[13px] text-warn">{stateLabel(site)}</p>
        {site.availability === 'mfa_required' ? (
          <button type="button" className="mt-3 text-[13px] text-brand hover:underline" onClick={() => void openOnSite(site.id, '/sites')}>
            {t('common:switchAndVerify')}
          </button>
        ) : null}
      </aside>
    );
  }
  const reasonPath = (code: string) => (code.startsWith('reachability') ? '/monitoring/reachability' : code.startsWith('domain') || code === 'no_primary_domain' ? '/sites/domains' : code.startsWith('audit') ? '/audit' : null);
  const total = site.referralsByPlatform.reduce((n, p) => n + p.hits, 0);
  return (
    <aside aria-label={site.name} className="flex flex-col gap-4 rounded-card border border-line bg-panel p-4">
      <div>
        <div className="flex items-start justify-between gap-2">
          <h2 className="t-section">{site.name}</h2>
          <span className={cn('rounded-full px-2 py-0.5 text-[11.5px]', site.health.status === 'ok' ? 'bg-ok-soft text-ok' : site.health.status === 'bad' ? 'bg-bad-soft text-bad' : site.health.status === 'warn' ? 'bg-warn-soft text-warn' : 'bg-panel-2 text-dim')}>
            {t(`common:health.${site.health.status}`)}
          </span>
        </div>
        {identity}
        {!current ? (
          <button type="button" className="text-[12.5px] text-brand hover:underline" onClick={() => void openOnSite(site.id, '/sites')}>
            {t('detail.openSite')}
          </button>
        ) : null}
      </div>
      <dl className="grid grid-cols-3 gap-2">
        <Figure label={t('detail.published')} value={site.publishedArticles === 'no_permission' ? t('common:noPermission') : formatNumber(site.publishedArticles.count, lang)} note={site.publishedArticles !== 'no_permission' && site.publishedArticles.partial ? t('detail.readableOnly') : undefined} />
        <Figure label={t('detail.crawler')} value={formatNumber(site.aiCrawler7d, lang)} />
        <Figure label={t('detail.referral')} value={formatNumber(site.aiReferral30d, lang)} />
      </dl>
      {total > 0 ? (
        <div>
          <h3 className="mb-2 text-[12.5px] font-medium text-dim">{t('detail.platforms')}</h3>
          <ShareBar label={t('detail.platforms')} parts={site.referralsByPlatform.slice(0, 3).map((p, i) => ({ key: p.operator, label: p.operator, value: p.hits, color: CHART[i] ?? CHART[2] }))} />
        </div>
      ) : null}
      <div>
        <h3 className="mb-2 text-[12.5px] font-medium text-dim">{t('detail.attention')}</h3>
        {site.health.reasons.length === 0 ? (
          <p className="t-aux">{t('detail.nothing')}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {site.health.reasons.map((r) => {
              const path = reasonPath(r.code);
              const text = t(`common:reasons.${r.code}`, { count: r.count ?? 0, host: r.host ?? '' });
              const onClick = path ? go(path) : null;
              return (
                <li key={`${r.code}:${r.host ?? ''}`} className="text-[13px]">
                  {path && current ? (
                    <Link to={withAdminBase(adminBase, path) as never} className="text-brand hover:underline">
                      {text}
                    </Link>
                  ) : onClick ? (
                    <button type="button" onClick={onClick} className="text-left text-brand hover:underline">
                      {text}
                    </button>
                  ) : (
                    text
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <div>
        <h3 className="mb-2 text-[12.5px] font-medium text-dim">{t('detail.topPages')}</h3>
        {current ? (
          <ol className="flex flex-col gap-1 text-[12.5px]">
            {(top.data?.topCrawled ?? []).slice(0, 5).map((p) => (
              <li key={p.path} className="flex justify-between gap-2">
                <span className="truncate font-mono">{p.path}</span>
                <span className="t-num text-dim">{formatNumber(p.hits, lang)}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="t-aux">{t('detail.pagesOnSite')}</p>
        )}
      </div>
    </aside>
  );
}

function Figure({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-ctl bg-panel-2 px-3 py-2">
      <dt className="text-[11.5px] text-dim">{label}</dt>
      <dd className="mt-1 text-[18px] font-semibold t-num">{value}</dd>
      {note ? <dd className="text-[11px] text-warn">{note}</dd> : null}
    </div>
  );
}

/** Sites › List (task 9.3): search by name, filter and sort by health. */
export function SitesListPage() {
  const { t } = useTranslation('sites');
  const stateLabel = useStateLabel();
  const summary = useNetworkSummary();
  const [query, setQuery] = useState('');
  const [health, setHealth] = useState<'all' | Group>('all');
  const [sort, setSort] = useState<'name' | 'health'>('name');
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (summary.data ?? [])
      .filter((s) => !q || s.name.toLowerCase().includes(q) || (s.primaryDomain ?? '').includes(q))
      .filter((s) => health === 'all' || groupOf(s) === health)
      .sort((a, b) => (sort === 'health' ? GROUPS.indexOf(groupOf(a)) - GROUPS.indexOf(groupOf(b)) : 0) || a.name.localeCompare(b.name));
  }, [summary.data, query, health, sort]);
  return (
    <>
      <PageHeader title={t('listTitle')} />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label className="relative">
          <span className="sr-only">{t('list.search')}</span>
          <Search className="pointer-events-none absolute left-2 top-2 h-4 w-4 text-icon" aria-hidden="true" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('list.search')} className="h-8 w-60 rounded-ctl border border-line bg-panel pl-8 pr-2 text-[13px]" />
        </label>
        <label className="flex items-center gap-1.5 text-[13px]">
          <span className="text-dim">{t('list.health')}</span>
          <select value={health} onChange={(e) => setHealth(e.target.value as 'all' | Group)} className="h-8 rounded-ctl border border-line bg-panel px-2">
            <option value="all">{t('list.all')}</option>
            {GROUPS.map((g) => (
              <option key={g} value={g}>
                {t(`groups.${g}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-[13px]">
          <span className="text-dim">{t('list.sort')}</span>
          <select value={sort} onChange={(e) => setSort(e.target.value as 'name' | 'health')} className="h-8 rounded-ctl border border-line bg-panel px-2">
            <option value="name">{t('list.byName')}</option>
            <option value="health">{t('list.byHealth')}</option>
          </select>
        </label>
      </div>
      {summary.isLoading ? (
        <SkeletonRows rows={5} />
      ) : rows.length === 0 ? (
        <EmptyState icon={Globe2} title={t('list.empty')} />
      ) : (
        <div className="overflow-x-auto rounded-card border border-line bg-panel">
          <table className="w-full min-w-[560px] text-[13px]">
            <thead>
              <tr className="border-b border-line text-left text-dim">
                <th className="px-4 py-2 font-medium">{t('list.name')}</th>
                <th className="px-4 py-2 font-medium">{t('list.domain')}</th>
                <th className="px-4 py-2 font-medium">{t('list.role')}</th>
                <th className="px-4 py-2 font-medium">{t('list.status')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((s) => (
                <tr key={s.id}>
                  <td className="px-4 py-2.5 font-medium">{s.name}</td>
                  <td className="px-4 py-2.5">
                    <DomainLabel site={s} />
                  </td>
                  <td className="px-4 py-2.5">{s.role ?? '—'}</td>
                  <td className="px-4 py-2.5">
                    <span className="inline-flex items-center gap-1.5">
                      <span className="inline-block h-2 w-2 rounded-full" style={{ background: TONE[groupOf(s)] }} aria-hidden="true" />
                      {stateLabel(s)}
                    </span>
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
