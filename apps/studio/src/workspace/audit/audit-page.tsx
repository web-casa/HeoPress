import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { CheckCircle2, ShieldAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getAdminBase } from '@/lib/admin-base';
import { getApiClient } from '@/lib/api';
import { cn } from '@/lib/cn';
import { withAdminBase } from '@/lib/keybindings/commands';
import { usePermissions } from '@/lib/use-permissions';
import { siteKey, studioApi } from '../api';
import { ModulePanel, PanelSection } from '../shell/module-panel';
import { Page } from '../shell/module-layout';
import { EmptyState } from '../ui/empty-state';
import { PageHeader } from '../ui/page-header';
import { RelativeTime } from '../ui/relative-time';
import { SkeletonRows } from '../ui/skeleton';
import { showUndo } from '../ui/undo-toast';

export interface PageRef {
  itemId: string;
  collection: string;
  title: string;
  url: string | null;
}

export interface AuditIssue {
  id: string;
  rule: string;
  severity: 'error' | 'warning' | 'notice';
  title: string;
  evidence: Record<string, unknown>;
  pages: PageRef[];
  firstSeenAt: string;
  lastSeenAt: string;
  state: { status: 'open' } | { status: 'ignored'; reason: string | null; until: string; by: string | null; at: string };
}

interface AuditView {
  run: { lastRunAt: string | null; status: string | null; requested: boolean; truncated: boolean; error: string | null };
  rules: Array<{ id: string; severity: string; title: string; description: string }>;
  issues: AuditIssue[];
  total: number;
}

interface ResolvedIssue {
  id: string;
  rule: string;
  severity: string;
  title: string;
  pages: Array<{ itemId: string; path: string | null; title: string }>;
  firstSeenAt: string;
  resolvedAt: string;
}

/** A rule's title in the interface language (the API answers in English). */
export function useRuleTitle() {
  const { t } = useTranslation('audit');
  return (rule: string, fallback: string) => t(`rules.${rule.replace('/', '~')}`, { defaultValue: fallback });
}

/** Rule categories (spec studio/audit-workspace "问题清单"). */
export const CATEGORIES: Record<string, (rule: string) => boolean> = {
  links: (r) => r.startsWith('links/'),
  meta: (r) => r.startsWith('meta/'),
  hreflang: (r) => r.startsWith('hreflang/'),
  jsonld: (r) => r.startsWith('jsonld/'),
  markdown: (r) => r.startsWith('markdown/'),
};

const SEVERITY_ORDER = { error: 0, warning: 1, notice: 2 } as const;

export type AuditViewKey = 'open' | 'ignored' | 'resolved' | `category:${keyof typeof CATEGORIES}`;

/** The issues a view shows, most severe first. */
export function issuesOf(view: AuditViewKey, issues: AuditIssue[]): AuditIssue[] {
  const open = issues.filter((i) => i.state.status === 'open');
  const picked =
    view === 'ignored' ? issues.filter((i) => i.state.status === 'ignored') : view.startsWith('category:') ? open.filter((i) => CATEGORIES[view.slice(9)]!(i.rule)) : open;
  return [...picked].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.rule.localeCompare(b.rule));
}

const TONE = { error: 'bg-bad-soft text-bad', warning: 'bg-warn-soft text-warn', notice: 'bg-panel-2 text-dim' } as const;

/** Audit (spec studio/audit-workspace): views with counts, the run, the list and the selected issue. */
export function AuditPage() {
  const { t } = useTranslation('audit');
  const { location } = useRouterState();
  const navigate = useNavigate();
  const adminBase = getAdminBase(location.pathname);
  const search = location.search as Record<string, unknown>;
  const view = (typeof search.view === 'string' ? search.view : 'open') as AuditViewKey;
  const selectedId = typeof search.issue === 'string' ? search.issue : null;
  const setSearch = (patch: Record<string, unknown>) => void navigate({ to: '.', search: { ...search, ...patch } as never, replace: true });
  const { isAdmin } = usePermissions();
  const qc = useQueryClient();
  const ruleTitle = useRuleTitle();

  const audit = useQuery({
    queryKey: siteKey('audit'),
    queryFn: async () => (await getApiClient().rawRequest<AuditView>('/api/v1/site/audit')).data,
    // While a run is queued or going, look again until it is done: the list and the audit time then update by themselves.
    refetchInterval: (q) => (q.state.data?.run.requested ? 3_000 : false),
  });
  const resolved = useQuery({
    queryKey: siteKey('audit-resolved'),
    queryFn: async () => (await getApiClient().rawRequest<{ issues: ResolvedIssue[]; total: number }>('/api/v1/site/audit/resolved')).data,
  });
  const rerun = useMutation({
    mutationFn: async () => (await getApiClient().rawRequest('/api/v1/site/audit/run', { method: 'POST' })).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: siteKey('audit') }),
  });

  const issues = useMemo(() => audit.data?.issues ?? [], [audit.data]);
  const counts = {
    open: issuesOf('open', issues).length,
    ignored: issuesOf('ignored', issues).length,
    resolved: resolved.data?.total ?? 0,
    ...Object.fromEntries(Object.keys(CATEGORIES).map((c) => [c, issuesOf(`category:${c}` as AuditViewKey, issues).length])),
  } as Record<string, number>;
  const shown = view === 'resolved' ? [] : issuesOf(view, issues);
  const selected = issues.find((i) => i.id === selectedId) ?? null;
  const run = audit.data?.run;

  const viewLink = (key: AuditViewKey, label: string) => (
    <button
      key={key}
      type="button"
      onClick={() => setSearch({ view: key, issue: undefined })}
      aria-current={view === key ? 'page' : undefined}
      className={cn('flex h-8 w-full items-center justify-between rounded-ctl px-2 text-[13px]', view === key ? 'bg-sel font-medium' : 'text-dim hover:bg-panel-2 hover:text-fg')}
    >
      <span>{label}</span>
      <span className="t-num text-[12px]">{key.startsWith('category:') ? counts[key.slice(9)] : counts[key]}</span>
    </button>
  );

  return (
    <>
      <ModulePanel>
        <PanelSection title={t('views.title')}>
          {viewLink('open', t('views.open'))}
          {viewLink('ignored', t('views.ignored'))}
          {viewLink('resolved', t('views.resolved'))}
        </PanelSection>
        <PanelSection title={t('views.categories')}>{Object.keys(CATEGORIES).map((c) => viewLink(`category:${c}` as AuditViewKey, t(`views.${c}`)))}</PanelSection>
        <PanelSection title={t('run.title')}>
          <AuditRunPanel run={run} canRun={isAdmin} pending={rerun.isPending} onRun={() => rerun.mutate()} />
        </PanelSection>
      </ModulePanel>

      <Page wide>
        <PageHeader title={t('title')} description={t('description')} />
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <section aria-label={t(`views.${view.startsWith('category:') ? view.slice(9) : view}`)} className="rounded-card border border-line bg-panel">
            {audit.isLoading ? (
              <div className="p-4">
                <SkeletonRows rows={6} />
              </div>
            ) : view === 'resolved' ? (
              <ResolvedList items={resolved.data?.issues ?? []} />
            ) : shown.length === 0 ? (
              <div className="p-4">
                <EmptyState icon={CheckCircle2} title={view === 'ignored' ? t('list.emptyIgnored') : t('list.emptyOpen')} body={view === 'ignored' ? undefined : t('list.nextAudit')} />
              </div>
            ) : (
              <ul className="divide-y divide-line">
                {shown.map((i) => (
                  <li key={i.id}>
                    <button
                      type="button"
                      onClick={() => setSearch({ issue: i.id })}
                      aria-current={i.id === selectedId ? 'true' : undefined}
                      className={cn('flex w-full items-start gap-3 px-4 py-3 text-left', i.id === selectedId ? 'bg-sel' : 'hover:bg-panel-2')}
                    >
                      <span className={cn('mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium', TONE[i.severity])}>{t(`severity.${i.severity}`)}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-[13.5px] font-medium">{ruleTitle(i.rule, i.title)}</span>
                        <span className="block t-aux">
                          <span className="font-mono">{i.rule}</span> · {t('list.pages', { count: i.pages.length })}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <IssueDetail issue={selected} rules={audit.data?.rules ?? []} canTriage={isAdmin} sameTarget={(target) => issues.filter((x) => x.evidence.target === target).flatMap((x) => x.pages).length} />
        </div>
      </Page>
    </>
  );
}

function ResolvedList({ items }: { items: ResolvedIssue[] }) {
  const { t } = useTranslation('audit');
  const ruleTitle = useRuleTitle();
  if (!items.length) {
    return (
      <div className="p-4">
        <EmptyState icon={CheckCircle2} title={t('list.emptyResolved')} />
      </div>
    );
  }
  return (
    <ul className="divide-y divide-line">
      {items.map((i) => (
        <li key={i.id} className="px-4 py-3">
          <span className="block text-[13.5px] font-medium">{ruleTitle(i.rule, i.title)}</span>
          <span className="block t-aux">
            <span className="font-mono">{i.rule}</span> · {t('detail.resolvedAt')} <RelativeTime value={i.resolvedAt} />
          </span>
          <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[12.5px] text-dim">
            {i.pages.slice(0, 5).map((p) => (
              <li key={p.itemId}>{p.title || p.path}</li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

export function IssueDetail({ issue, rules, canTriage, sameTarget }: { issue: AuditIssue | null; rules: AuditView['rules']; canTriage: boolean; sameTarget: (target: unknown) => number }) {
  const { t, i18n } = useTranslation('audit');
  const { location } = useRouterState();
  const adminBase = getAdminBase(location.pathname);
  const qc = useQueryClient();
  const ruleTitle = useRuleTitle();
  const [reason, setReason] = useState('');
  const [days, setDays] = useState(90);
  const refresh = () => qc.invalidateQueries({ queryKey: siteKey('audit') });
  const ignore = useMutation({
    mutationFn: (id: string) => studioApi.ignoreIssue(id, { reason: reason || null, days }),
    onSuccess: (_data, id) => {
      void refresh();
      setReason('');
      // Undo within the toast's time: restore it to where it was (ADR-0019 §5.3).
      showUndo(t('detail.ignoredToast'), () => void studioApi.restoreIssue(id).then(refresh));
    },
  });
  const restore = useMutation({ mutationFn: (id: string) => studioApi.restoreIssue(id), onSuccess: () => void refresh() });

  if (!issue) {
    return (
      <aside className="rounded-card border border-line bg-panel p-4">
        <EmptyState icon={ShieldAlert} title={t('detail.empty')} />
      </aside>
    );
  }
  const rule = rules.find((r) => r.id === issue.rule);
  const until = issue.state.status === 'ignored' ? new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium' }).format(new Date(issue.state.until)) : '';
  const evidence = Object.entries(issue.evidence).filter(([k]) => k !== 'pages');
  return (
    <aside aria-label={issue.title} className="flex flex-col gap-4 rounded-card border border-line bg-panel p-4">
      <div>
        <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', TONE[issue.severity])}>{t(`severity.${issue.severity}`)}</span>
        <h2 className="mt-2 t-section">{ruleTitle(issue.rule, issue.title)}</h2>
        {rule ? <p className="mt-1 t-aux">{rule.description}</p> : null}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
        <dt className="text-dim">{t('detail.rule')}</dt>
        <dd className="font-mono text-[12.5px]">{issue.rule}</dd>
        <dt className="text-dim">{t('detail.firstSeen')}</dt>
        <dd>
          <RelativeTime value={issue.firstSeenAt} />
        </dd>
        <dt className="text-dim">{t('detail.lastSeen')}</dt>
        <dd>
          <RelativeTime value={issue.lastSeenAt} />
        </dd>
      </dl>
      {evidence.length ? (
        <div>
          <h3 className="mb-1 text-[12.5px] font-medium text-dim">{t('detail.evidence')}</h3>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 rounded-ctl bg-panel-2 p-2 text-[12.5px]">
            {evidence.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-dim">{k}</dt>
                <dd className="break-all font-mono">{typeof v === 'string' ? v : JSON.stringify(v)}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
      {issue.pages.length ? (
        <div>
          <h3 className="mb-1 text-[12.5px] font-medium text-dim">{t('detail.pages')}</h3>
          <ul className="flex flex-col gap-1 text-[13px]">
            {issue.pages.map((p) => (
              <li key={p.itemId} className="flex items-center justify-between gap-2">
                <span className="truncate">{p.title}</span>
                <Link to={withAdminBase(adminBase, `/content/${p.collection}/${p.itemId}`) as never} className="shrink-0 text-brand hover:underline">
                  {t('detail.open')}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {issue.rule === 'links/broken' && typeof issue.evidence.target === 'string' && canTriage ? <RedirectFix from={issue.evidence.target} pages={sameTarget(issue.evidence.target)} /> : null}

      {issue.state.status === 'ignored' ? (
        <div className="rounded-ctl bg-panel-2 p-3 text-[13px]">
          <p>{t('detail.ignoredBy', { who: issue.state.by ?? '—', until })}</p>
          {issue.state.reason ? <p className="t-aux">{t('detail.reason', { reason: issue.state.reason })}</p> : null}
          {canTriage ? (
            <button type="button" onClick={() => restore.mutate(issue.id)} className="mt-2 rounded-ctl border border-line bg-panel px-2.5 py-1 text-[12.5px] hover:bg-panel-2">
              {t('detail.restore')}
            </button>
          ) : null}
        </div>
      ) : canTriage ? (
        <form
          className="flex flex-col gap-2 border-t border-line pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            ignore.mutate(issue.id);
          }}
        >
          <label className="text-[12.5px] text-dim" htmlFor="ignore-reason">
            {t('detail.ignoreReason')}
          </label>
          <input id="ignore-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} className="h-8 rounded-ctl border border-line bg-panel px-2 text-[13px]" />
          <label className="flex items-center gap-2 text-[12.5px] text-dim">
            {t('detail.ignoreDays')}
            <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="h-8 rounded-ctl border border-line bg-panel px-2 text-[13px] text-fg">
              {[30, 90, 180, 365].map((d) => (
                <option key={d} value={d}>
                  {t('detail.days', { count: d })}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" disabled={ignore.isPending} className="self-start rounded-ctl border border-line bg-panel px-3 py-1.5 text-[13px] hover:bg-panel-2">
            {t('detail.confirmIgnore')}
          </button>
        </form>
      ) : (
        <p className="t-aux">{t('detail.adminOnly')}</p>
      )}
    </aside>
  );
}

interface ImportReport {
  summary: Record<string, number>;
  import: Array<{ from: string; to: string }>;
  conflicts: unknown[];
  loops: unknown[];
  reportHash: string;
}

/** Fix a broken link by redirecting its old address (task 10.5): check first, show before and after, then apply. */
function RedirectFix({ from, pages }: { from: string; pages: number }) {
  const { t } = useTranslation('audit');
  const qc = useQueryClient();
  const [to, setTo] = useState('');
  const path = (() => {
    try {
      return new URL(from).pathname;
    } catch {
      return from;
    }
  })();
  const content = `${path},${to}`;
  const check = useMutation({
    mutationFn: async () => (await getApiClient().rawRequest<ImportReport>('/api/v1/redirects/import?dryRun=1', { method: 'POST', body: JSON.stringify({ content, format: 'csv' }) })).data,
  });
  const apply = useMutation({
    mutationFn: async () => (await getApiClient().rawRequest('/api/v1/redirects/import', { method: 'POST', body: JSON.stringify({ content, format: 'csv', reportHash: check.data!.reportHash }) })).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: siteKey('audit') }),
  });
  const blocked = check.data && (check.data.conflicts.length > 0 || check.data.loops.length > 0);
  return (
    <section aria-label={t('fix.title')} className="rounded-ctl border border-line p-3">
      <h3 className="t-section">{t('fix.title')}</h3>
      <p className="mt-1 t-aux">{t('fix.explain', { from: path })}</p>
      <div className="mt-2 flex gap-2">
        <label className="sr-only" htmlFor="redirect-to">
          {t('fix.to')}
        </label>
        <input id="redirect-to" value={to} onChange={(e) => setTo(e.target.value)} placeholder={t('fix.to')} className="h-8 min-w-0 flex-1 rounded-ctl border border-line bg-panel px-2 font-mono text-[12.5px]" />
        <button type="button" disabled={!to || check.isPending} onClick={() => check.mutate()} className="rounded-ctl border border-line bg-panel px-2.5 text-[12.5px] hover:bg-panel-2 disabled:opacity-50">
          {t('fix.check')}
        </button>
      </div>
      {check.data ? (
        <div className="mt-3 text-[12.5px]">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-dim">{t('fix.before')}</dt>
            <dd className="font-mono">{path} → 404</dd>
            <dt className="text-dim">{t('fix.after')}</dt>
            <dd className="font-mono">
              {path} → 301 {to}
            </dd>
          </dl>
          <p className="mt-1 t-aux">{t('fix.pagesAffected', { count: pages })}</p>
          {check.data.conflicts.length ? <p className="mt-1 text-bad">{t('fix.conflicts')}</p> : null}
          {check.data.loops.length ? <p className="mt-1 text-bad">{t('fix.loops')}</p> : null}
          {apply.isSuccess ? (
            <p role="status" className="mt-2 text-ok">
              {t('fix.done')}
            </p>
          ) : (
            <button type="button" disabled={!!blocked || apply.isPending} onClick={() => apply.mutate()} className="mt-2 rounded-ctl bg-brand px-3 py-1.5 text-[12.5px] text-brand-fg disabled:opacity-50">
              {t('fix.apply')}
            </button>
          )}
        </div>
      ) : null}
    </section>
  );
}

/**
 * The last audit in the panel (spec studio/audit-workspace "重新审计", "结果被截断"): when it ran and how it ended — a run
 * cut short says the list is incomplete — and, for administrators, running it again; queued or going, it says so.
 */
export function AuditRunPanel({ run, canRun, pending, onRun }: { run: AuditView['run'] | undefined; canRun: boolean; pending: boolean; onRun: () => void }) {
  const { t } = useTranslation('audit');
  const label = !run?.lastRunAt ? t('run.never') : run.status === 'failed' ? t('run.failed') : run.truncated ? t('run.truncated') : t('run.done');
  return (
    <div className="px-2 text-[12.5px]">
      <p className={cn(run?.status === 'failed' || run?.truncated ? 'text-warn' : 'text-dim')}>{label}</p>
      {run?.lastRunAt ? (
        <p className="t-aux">
          <RelativeTime value={run.lastRunAt} />
        </p>
      ) : null}
      {run?.requested || pending ? (
        <p role="status" className="mt-1 text-brand">
          {t('run.running')}
        </p>
      ) : null}
      {canRun ? (
        <button type="button" disabled={pending || run?.requested} onClick={onRun} className="mt-2 rounded-ctl border border-line bg-panel px-2.5 py-1 text-[12.5px] hover:bg-panel-2 disabled:opacity-50">
          {t('run.rerun')}
        </button>
      ) : null}
    </div>
  );
}
