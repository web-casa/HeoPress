import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { FileText, Plus, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getAdminBase } from '@/lib/admin-base';
import { getApiClient } from '@/lib/api';
import { cn } from '@/lib/cn';
import { withAdminBase } from '@/lib/keybindings/commands';
import { sanitizeHtml } from '@/lib/sanitize-html';
import { usePermissions } from '@/lib/use-permissions';
import { siteKey, studioApi, useItemChecks, type Check } from '../api';
import { useCreatableArticleCollections } from './new-article-page';
import { ModulePanel, PanelSection } from '../shell/module-panel';
import { Page } from '../shell/module-layout';
import { listStep } from '../shell/sequences';
import { EmptyState } from '../ui/empty-state';
import { FieldError } from '../ui/field-error';
import { RelativeTime } from '../ui/relative-time';
import { SkeletonRows } from '../ui/skeleton';

export const VIEWS = ['inbox', 'mine', 'pending', 'scheduled', 'published', 'drafts'] as const;
type View = (typeof VIEWS)[number];

export interface ContentRow {
  id: string;
  collection: string;
  title: string;
  status: string;
  editorialState: string | null;
  author: { id: string; email: string } | null;
  locale: string | null;
  publishAt: string | null;
  updatedAt: string;
  version: number;
}

interface ListResponse {
  data: ContentRow[];
  meta: { counts: Record<View, number>; nextCursor: string | null; collections: Array<{ name: string; review: boolean }> };
}

interface ItemRow {
  id: string;
  status: string;
  version: number;
  editorialState: string | null;
  publishAt: string | null;
  data: Record<string, unknown>;
}

/** The state shown for a row: scheduled when it waits for its time. */
export function stateOf(row: Pick<ContentRow, 'status' | 'editorialState' | 'publishAt'>): string {
  if (row.status === 'published') return 'published';
  if (row.publishAt && Date.parse(row.publishAt) > Date.now() && (!row.editorialState || row.editorialState === 'approved' || row.editorialState === 'scheduled')) return 'scheduled';
  return row.editorialState ?? 'draft';
}

/** Checks that did not pass (fail, or warn worth a second look). */
export const failing = (checks: Check[] | undefined) => (checks ?? []).filter((c) => c.status === 'fail' || c.status === 'warn');

const STATE_TONE: Record<string, string> = {
  published: 'bg-ok-soft text-ok',
  approved: 'bg-ok-soft text-ok',
  in_review: 'bg-warn-soft text-warn',
  rejected: 'bg-bad-soft text-bad',
  scheduled: 'bg-soft text-brand',
  draft: 'bg-panel-2 text-dim',
};

/** Content › Review workspace (spec studio/review-workspace). */
export function ReviewPage() {
  const { t } = useTranslation('content');
  const { location } = useRouterState();
  const navigate = useNavigate();
  const search = location.search as Record<string, string | undefined>;
  const view = (VIEWS as readonly string[]).includes(search.view ?? '') ? (search.view as View) : 'inbox';
  const setSearch = (patch: Record<string, string | undefined>) => void navigate({ to: '.', search: { ...search, ...patch } as never, replace: true });
  const setSearchRef = useRef(setSearch);
  setSearchRef.current = setSearch;
  const searchQ = search.q ?? '';
  const [q, setQ] = useState(searchQ);
  useEffect(() => {
    const id = window.setTimeout(() => {
      if (searchQ !== q) setSearchRef.current({ q: q || undefined });
    }, 300);
    return () => window.clearTimeout(id);
  }, [q, searchQ]);

  const params = new URLSearchParams({ view });
  for (const k of ['collection', 'author', 'locale', 'q'] as const) if (search[k]) params.set(k, search[k]!);
  const list = useQuery({
    queryKey: siteKey('content-items', params.toString()),
    queryFn: async () => (await getApiClient().rawRequest<ContentRow[]>(`/api/v1/studio/content/items?${params}`)) as unknown as ListResponse,
  });
  const rows = useMemo(() => list.data?.data ?? [], [list.data]);
  const selectedKey = search.item;
  const selected = rows.find((r) => `${r.collection}:${r.id}` === selectedKey) ?? null;
  const select = (row: ContentRow | undefined) => row && setSearchRef.current({ item: `${row.collection}:${row.id}` });
  const index = rows.findIndex((r) => `${r.collection}:${r.id}` === selectedKey);

  // J / K move through the list (ADR-0019 §5.7).
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const indexRef = useRef(index);
  indexRef.current = index;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const step = listStep(e);
      if (!step) return;
      e.preventDefault();
      const next = rowsRef.current[Math.max(0, Math.min(rowsRef.current.length - 1, indexRef.current + step))];
      if (next) setSearchRef.current({ item: `${next.collection}:${next.id}` });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const authors = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of rows) if (r.author) seen.set(r.author.id, r.author.email);
    return [...seen];
  }, [rows]);
  const locales = useMemo(() => [...new Set(rows.map((r) => r.locale).filter((l): l is string => !!l))], [rows]);
  const counts = list.data?.meta.counts;
  const creatable = useCreatableArticleCollections();
  const adminBase = getAdminBase(location.pathname);
  const newArticle = creatable.list.length ? (
    <Link to={withAdminBase(adminBase, '/content/new') as never} className="inline-flex h-8 items-center gap-1.5 rounded-ctl bg-brand px-3 text-[13px] text-brand-fg hover:opacity-90">
      <Plus className="h-4 w-4" aria-hidden="true" />
      {t('new.title')}
    </Link>
  ) : null;
  // Nothing at all yet: say so and offer the first article (spec workspace-shell: an empty list explains and offers the next step).
  const nothingYet = !!counts && Object.values(counts).every((n) => n === 0) && !search.q && !search.collection && !search.author && !search.locale;

  return (
    <>
      <ModulePanel>
        <PanelSection title={t('views.title')}>
          {VIEWS.map((v) => (
            <button
              key={v}
              type="button"
              aria-current={view === v ? 'page' : undefined}
              onClick={() => setSearch({ view: v, item: undefined })}
              className={cn('flex h-8 w-full items-center justify-between rounded-ctl px-2 text-[13px]', view === v ? 'bg-sel font-medium' : 'text-dim hover:bg-panel-2 hover:text-fg')}
            >
              <span>{t(`views.${v}`)}</span>
              <span className="t-num text-[12px]">{counts?.[v] ?? ''}</span>
            </button>
          ))}
        </PanelSection>
        <PanelSection title={t('filters.collection')}>
          <select aria-label={t('filters.collection')} value={search.collection ?? ''} onChange={(e) => setSearch({ collection: e.target.value || undefined, item: undefined })} className="mx-2 h-8 rounded-ctl border border-line bg-panel px-2 text-[13px]">
            <option value="">{t('filters.allCollections')}</option>
            {(list.data?.meta.collections ?? []).map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
        </PanelSection>
      </ModulePanel>

      <Page wide>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <h1 className="t-page mr-auto">{t('title')}</h1>
          <label className="relative">
            <span className="sr-only">{t('filters.search')}</span>
            <Search className="pointer-events-none absolute left-2 top-2 h-4 w-4 text-icon" aria-hidden="true" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('filters.search')} className="h-8 w-56 rounded-ctl border border-line bg-panel pl-8 pr-2 text-[13px]" />
          </label>
          <select aria-label={t('filters.author')} value={search.author ?? ''} onChange={(e) => setSearch({ author: e.target.value || undefined, item: undefined })} className="h-8 rounded-ctl border border-line bg-panel px-2 text-[13px]">
            <option value="">{t('filters.anyAuthor')}</option>
            {authors.map(([id, email]) => (
              <option key={id} value={id}>
                {email}
              </option>
            ))}
            {search.author && !authors.some(([id]) => id === search.author) ? <option value={search.author}>{search.author}</option> : null}
          </select>
          <select aria-label={t('filters.locale')} value={search.locale ?? ''} onChange={(e) => setSearch({ locale: e.target.value || undefined, item: undefined })} className="h-8 rounded-ctl border border-line bg-panel px-2 text-[13px]">
            <option value="">{t('filters.anyLocale')}</option>
            {[...new Set([...locales, ...(search.locale ? [search.locale] : [])])].map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
          {newArticle}
        </div>
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
          <section aria-label={t(`views.${view}`)} className="rounded-card border border-line bg-panel">
            {list.isLoading ? (
              <div className="p-4">
                <SkeletonRows rows={8} />
              </div>
            ) : rows.length === 0 ? (
              <div className="p-4">
                {nothingYet ? <EmptyState icon={FileText} title={t('list.nothingYet')} body={t('list.nothingYetHint')} action={newArticle} /> : <EmptyState icon={FileText} title={t('list.empty')} />}
              </div>
            ) : (
              <ul className="divide-y divide-line">
                {rows.map((r) => {
                  const key = `${r.collection}:${r.id}`;
                  const state = stateOf(r);
                  return (
                    <li key={key}>
                      <button type="button" onClick={() => select(r)} aria-current={key === selectedKey ? 'true' : undefined} className={cn('flex w-full items-start gap-3 px-4 py-3 text-left', key === selectedKey ? 'bg-sel' : 'hover:bg-panel-2')}>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13.5px] font-medium">{r.title}</span>
                          <span className="block t-aux">
                            {r.collection} · {r.author?.email ?? '—'} · <RelativeTime value={r.updatedAt} />
                          </span>
                        </span>
                        <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[11px]', STATE_TONE[state] ?? STATE_TONE.draft)}>{t(`state.${state}`)}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
          <ReviewDetail row={selected} onDone={() => select(rows[index + 1] ?? rows[index - 1])} />
        </div>
      </Page>
    </>
  );
}

interface HistoryEntry {
  kind: 'submitted' | 'approved' | 'rejected';
  at: string;
  by: string | null;
  reason: string | null;
}

export function ReviewDetail({ row, onDone }: { row: ContentRow | null; onDone: () => void }) {
  const { t } = useTranslation('content');
  const { location } = useRouterState();
  const adminBase = getAdminBase(location.pathname);
  const perms = usePermissions();
  const qc = useQueryClient();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [scheduleAt, setScheduleAt] = useState('');
  const item = useQuery({
    queryKey: siteKey('review-item', row?.collection, row?.id),
    queryFn: async () => (await getApiClient().rawRequest<ItemRow>(`/api/v1/items/${row!.collection}/${row!.id}`)).data,
    enabled: !!row,
  });
  const checks = useItemChecks(row?.collection ?? null, row?.id ?? null);
  const history = useQuery({
    queryKey: siteKey('review-history', row?.collection, row?.id),
    queryFn: async () => (await getApiClient().rawRequest<HistoryEntry[]>(`/api/v1/studio/content/items/${row!.collection}/${row!.id}/history`)).data,
    enabled: !!row,
  });
  useEffect(() => {
    setRejecting(false);
    setReason('');
    setReasonError(false);
    setConfirming(false);
    setPublishError(null);
  }, [row?.id]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: siteKey('content-items') });
    void qc.invalidateQueries({ queryKey: siteKey('review-item') });
    void qc.invalidateQueries({ queryKey: siteKey('review-history') });
  };
  const version = item.data?.version;
  const approve = useMutation({ mutationFn: () => studioApi.approve(row!.collection, row!.id, { expectedVersion: version }), onSuccess: () => { refresh(); onDone(); } });
  const reject = useMutation({ mutationFn: () => studioApi.reject(row!.collection, row!.id, { reason: reason.trim(), expectedVersion: version }), onSuccess: () => { refresh(); onDone(); } });
  const publish = async (body: Record<string, unknown>) => {
    const fresh = (await getApiClient().rawRequest<ItemRow>(`/api/v1/items/${row!.collection}/${row!.id}`)).data;
    await getApiClient().rawRequest(`/api/v1/items/${row!.collection}/${row!.id}`, { method: 'PATCH', body: JSON.stringify({ ...body, expectedVersion: fresh.version }) });
  };
  const publishNow = useMutation({
    mutationFn: () => publish({ status: 'published' }),
    onSuccess: () => { setPublishError(null); refresh(); onDone(); },
    onError: (err) => { setPublishError(err instanceof Error ? err.message : String(err)); refresh(); },
  });
  const schedule = useMutation({ mutationFn: () => publish({ publishAt: new Date(scheduleAt).toISOString() }), onSuccess: () => { refresh(); onDone(); } });
  // Approve, then publish: a failed publish leaves the item approved, says why and offers a retry (spec "批准并发布").
  const approveAndPublish = useMutation({
    mutationFn: async () => {
      await studioApi.approve(row!.collection, row!.id, { expectedVersion: version });
      try {
        await publish({ status: 'published' });
      } catch (err) {
        throw new Error(err instanceof Error ? err.message : String(err), { cause: 'publish' });
      }
    },
    onSuccess: () => { refresh(); onDone(); },
    onError: (err) => {
      if ((err as Error & { cause?: unknown }).cause === 'publish') setPublishError((err as Error).message);
      refresh();
    },
  });

  // ⌘↵ / Ctrl+Enter approves the current item; failing checks are shown first and need a second confirmation.
  const canReview = !!row && perms.can(row.collection, 'review');
  const pending = row?.editorialState === 'in_review';
  const failed = failing(checks.data?.checks);
  const approveRef = useRef<() => void>(() => undefined);
  approveRef.current = () => {
    if (!canReview || !pending || approve.isPending) return;
    if (failed.length && !confirming) setConfirming(true);
    else approve.mutate();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        approveRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!row) {
    return (
      <aside className="rounded-card border border-line bg-panel p-4">
        <EmptyState icon={FileText} title={t('detail.empty')} />
      </aside>
    );
  }
  const data = item.data?.data ?? {};
  const body = Object.values(data).find((v): v is string => typeof v === 'string' && /<\w+/.test(v)) ?? '';
  const words = body.replace(/<[^>]+>/g, ' ').trim().split(/\s+/).filter(Boolean).length;
  const canPublish = perms.can(row.collection, 'update');
  const state = stateOf(row);
  return (
    <aside aria-label={row.title} className="flex flex-col gap-4 rounded-card border border-line bg-panel p-4">
      <div className="flex items-start justify-between gap-2">
        <h2 className="t-section">{row.title}</h2>
        <Link to={withAdminBase(adminBase, `/content/${row.collection}/${row.id}`) as never} className="shrink-0 text-[12.5px] text-brand hover:underline">
          {t('detail.openEditor')}
        </Link>
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
        <dt className="text-dim">{t('detail.status')}</dt>
        <dd>{t(`state.${state}`)}</dd>
        <dt className="text-dim">{t('detail.author')}</dt>
        <dd>{row.author?.email ?? '—'}</dd>
        <dt className="text-dim">{t('detail.length')}</dt>
        <dd className="t-num">{t('detail.words', { count: words })}</dd>
        {row.publishAt ? (
          <>
            <dt className="text-dim">{t('detail.publishAt')}</dt>
            <dd>
              <RelativeTime value={row.publishAt} />
            </dd>
          </>
        ) : null}
      </dl>

      <div className="flex flex-col gap-2 border-y border-line py-3">
        {publishError ? (
          <p role="alert" className="rounded-ctl bg-bad-soft px-3 py-2 text-[13px] text-bad">
            {t('detail.publishFailed', { reason: publishError })}
          </p>
        ) : null}
        {confirming ? (
          <div role="alertdialog" aria-label={t('detail.approveAnyway')} className="rounded-ctl border border-warn/40 bg-warn-soft p-3 text-[13px]">
            <p className="font-medium text-warn">{t('detail.failingChecks', { count: failed.length })}</p>
            <ul className="mb-2 mt-1 list-disc pl-5">
              {failed.map((c) => (
                <li key={c.id}>{t(`checks.${c.id}`)}</li>
              ))}
            </ul>
            <div className="flex gap-2">
              <button type="button" autoFocus onClick={() => approve.mutate()} className="rounded-ctl bg-brand px-3 py-1.5 text-brand-fg">
                {t('detail.approveAnyway')}
              </button>
              <button type="button" onClick={() => setConfirming(false)} className="rounded-ctl border border-line bg-panel px-3 py-1.5">
                {t('detail.cancel')}
              </button>
            </div>
          </div>
        ) : null}
        {pending ? (
          canReview ? (
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => approveRef.current()} disabled={approve.isPending} className="rounded-ctl bg-brand px-3 py-1.5 text-[13px] text-brand-fg disabled:opacity-50">
                {failed.length ? t('detail.approveAnyway') : t('detail.approve')} <kbd className="ml-1 text-[10.5px] opacity-80">⌘↵</kbd>
              </button>
              {canPublish ? (
                <button type="button" onClick={() => approveAndPublish.mutate()} disabled={approveAndPublish.isPending} className="rounded-ctl border border-line bg-panel px-3 py-1.5 text-[13px] hover:bg-panel-2">
                  {t('detail.approvePublish')}
                </button>
              ) : null}
              <button type="button" onClick={() => setRejecting((v) => !v)} className="rounded-ctl border border-line bg-panel px-3 py-1.5 text-[13px] hover:bg-panel-2">
                {t('detail.reject')}
              </button>
            </div>
          ) : (
            <p className="t-aux">{t('detail.noReview')}</p>
          )
        ) : null}
        {rejecting ? (
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!reason.trim()) {
                setReasonError(true);
                return;
              }
              reject.mutate();
            }}
          >
            <label htmlFor="reject-reason" className="text-[12.5px] text-dim">
              {t('detail.rejectReason')}
            </label>
            <textarea id="reject-reason" value={reason} onChange={(e) => { setReason(e.target.value); setReasonError(false); }} aria-invalid={reasonError} aria-describedby={reasonError ? 'reject-reason-error' : undefined} rows={3} className="rounded-ctl border border-line bg-panel p-2 text-[13px]" />
            <FieldError id="reject-reason-error">{reasonError ? t('detail.rejectRequired') : null}</FieldError>
            <button type="submit" className="self-start rounded-ctl bg-bad px-3 py-1.5 text-[13px] text-white">
              {t('detail.confirmReject')}
            </button>
          </form>
        ) : null}
        {row.editorialState === 'approved' && row.status !== 'published' ? (
          canPublish ? (
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => publishNow.mutate()} className="rounded-ctl bg-brand px-3 py-1.5 text-[13px] text-brand-fg">
                {publishError ? t('detail.retryPublish') : t('detail.publish')}
              </button>
              <label className="flex items-center gap-1.5 text-[12.5px] text-dim">
                {t('detail.scheduleAt')}
                <input type="datetime-local" value={scheduleAt} onChange={(e) => setScheduleAt(e.target.value)} className="h-8 rounded-ctl border border-line bg-panel px-2 text-[13px] text-fg" />
              </label>
              <button type="button" disabled={!scheduleAt} onClick={() => schedule.mutate()} className="rounded-ctl border border-line bg-panel px-3 py-1.5 text-[13px] hover:bg-panel-2 disabled:opacity-50">
                {t('detail.schedule')}
              </button>
            </div>
          ) : (
            <p className="t-aux">{t('detail.noPublish')}</p>
          )
        ) : null}
      </div>

      <section aria-label={t('detail.checks')}>
        <h3 className="mb-2 text-[12.5px] font-medium text-dim">{t('detail.checks')}</h3>
        <ChecksList checks={checks.data?.checks} loading={checks.isLoading} />
      </section>

      {body ? (
        <section aria-label={t('detail.preview')}>
          <h3 className="mb-2 text-[12.5px] font-medium text-dim">{t('detail.preview')}</h3>
          <div className="prose-sm max-h-80 overflow-auto rounded-ctl bg-panel-2 p-3 text-[13.5px] leading-6" dangerouslySetInnerHTML={{ __html: sanitizeHtml(body) }} />
        </section>
      ) : null}

      <section aria-label={t('detail.history')}>
        <h3 className="mb-2 text-[12.5px] font-medium text-dim">{t('detail.history')}</h3>
        {history.data?.length ? (
          <ol className="flex flex-col gap-2 text-[13px]">
            {history.data.map((h) => (
              <li key={`${h.kind}:${h.at}`}>
                <span className="font-medium">{t(`history.${h.kind}`)}</span> · {h.by ?? '—'} · <RelativeTime value={h.at} />
                {h.reason ? <p className="t-aux">{h.reason}</p> : null}
              </li>
            ))}
          </ol>
        ) : (
          <p className="t-aux">{t('detail.noHistory')}</p>
        )}
      </section>
    </aside>
  );
}

const CHECK_TONE = { pass: 'text-ok', warn: 'text-warn', fail: 'text-bad', not_checked: 'text-dim', no_permission: 'text-dim' } as const;

export function ChecksList({ checks, loading }: { checks: Check[] | undefined; loading: boolean }) {
  const { t } = useTranslation('content');
  if (loading) return <SkeletonRows rows={3} />;
  return (
    <ul className="flex flex-col gap-1.5 text-[13px]">
      {(checks ?? []).map((c) => (
        <li key={c.id}>
          <div className="flex items-center justify-between gap-2">
            <span>{t(`checks.${c.id}`)}</span>
            <span className={cn('text-[12.5px]', CHECK_TONE[c.status])}>{c.reason ? t(`checks.reason.${c.reason}`, { value: c.value ?? '' }) : t(`checks.status.${c.status}`)}</span>
          </div>
          {c.items?.length && c.id === 'links' ? (
            <ul className="mt-1 flex flex-col gap-0.5 pl-3 text-[12px]">
              {c.items.map((i) => (
                <li key={i.url} className="flex justify-between gap-2">
                  <span className="truncate font-mono">{i.url}</span>
                  <span className={i.status === 'broken' ? 'text-bad' : 'text-dim'}>{t(`checks.link.${i.status}`)}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
