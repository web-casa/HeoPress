import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams, useRouterState } from '@tanstack/react-router';
import { ArrowLeft, Eye, Send } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { HeoPressError, versionConflictOf, type FieldResource } from '@heopress/sdk';
import { useCoEditors } from '@/hooks/use-presence';
import { getAdminBase } from '@/lib/admin-base';
import { getApiClient } from '@/lib/api';
import { cn } from '@/lib/cn';
import { jsonEqual } from '@/lib/json-equal';
import { withAdminBase } from '@/lib/keybindings/commands';
import { useSaveHandler } from '@/lib/keybindings/use-keybindings';
import { activeSession } from '@/lib/session/current';
import { usePermissions } from '@/lib/use-permissions';
import { FieldsTab, ItemDetailPage } from '@/modules/content/item-detail';
import { checkImpact } from '@/modules/content/link-impact-check';
import { LinkImpactDialog } from '@/modules/content/link-impact-dialog';
import { siteKey, useItemChecks } from '../api';
import { setUnsaved } from '../unsaved';
import { RelativeTime } from '../ui/relative-time';
import { Skeleton } from '../ui/skeleton';
import { ChecksList } from './review-page';
import { descriptionHint, isArticleCollection, outlineOf, type Heading } from './article-rules';
import { NewArticlePage } from './new-article-page';
import { RichTextVariant } from '../rich-text/variant';

/**
 * The article editor (HeoPress P07a tasks 6.1–6.4; spec studio/article-editor): top bar, outline from the body's H2 / H3,
 * the body, and an inspector with SEO, indexing and properties. Fields are edited with the same interfaces as the
 * generic form; saving follows the write-concurrency rule (the version the draft was loaded from).
 */

interface ItemRow {
  id: string;
  status: string;
  version: number;
  editorialState: string | null;
  publishAt: string | null;
  data: Record<string, unknown>;
  userCreated?: string | null;
}

const SEO_FIELDS = ['seo_title', 'seo_description', 'seo_robots', 'canonical_url'];
const isSeo = (f: FieldResource) => f.group === 'seo' || SEO_FIELDS.includes(f.name);
const RICH_TEXT = 'wysiwyg';




type SaveState = { kind: 'idle' } | { kind: 'dirty' } | { kind: 'saving' } | { kind: 'saved'; at: Date } | { kind: 'failed'; reason: string };

export function ArticleEditor({ collection, id, workflow }: { collection: string; id: string; workflow: boolean }) {
  const { t } = useTranslation(['editor', 'content']);
  const client = getApiClient();
  const qc = useQueryClient();
  const perms = usePermissions();
  const { location } = useRouterState();
  const adminBase = getAdminBase(location.pathname);
  const fieldsQuery = useQuery({ queryKey: ['fields', collection], queryFn: async () => (await client.schema.listFields(collection)).data });
  const itemQuery = useQuery({ queryKey: siteKey('editor-item', collection, id), queryFn: async () => (await client.items(collection as never).detail(id)).data as ItemRow });
  const [draft, setDraft] = useState<Record<string, unknown> | null>(null);
  const [base, setBase] = useState<{ version: number; data: Record<string, unknown> } | null>(null);
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' });
  const [conflict, setConflict] = useState<{ fields: string[]; latest: ItemRow } | null>(null);
  const [tab, setTab] = useState<'seo' | 'indexing' | 'props'>('seo');
  const [activeHeading, setActiveHeading] = useState<number | null>(null);
  const [previewMessage, setPreviewMessage] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (itemQuery.data && draft === null) {
      setDraft({ ...itemQuery.data.data });
      setBase({ version: itemQuery.data.version, data: { ...itemQuery.data.data } });
    }
  }, [itemQuery.data, draft]);

  const fields = useMemo(() => (fieldsQuery.data ?? []).filter((f) => !f.hidden && perms.fieldAllowed(collection, 'read', f.name)), [fieldsQuery.data, perms, collection]);
  const bodyField = fields.find((f) => f.name === 'body' && f.interface === RICH_TEXT) ?? fields.find((f) => f.interface === RICH_TEXT);
  const seoFields = fields.filter(isSeo);
  const propFields = fields.filter((f) => f.name !== 'title' && f !== bodyField && !isSeo(f));
  const dirty = !!draft && !!base && !jsonEqual(draft, base.data);
  const key = `article:${collection}:${id}`;

  // Leaving the page or switching site with unsaved changes asks first.
  useEffect(() => {
    setUnsaved(key, dirty);
    if (!dirty) return () => setUnsaved(key, false);
    const onLeave = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onLeave);
    return () => {
      window.removeEventListener('beforeunload', onLeave);
      setUnsaved(key, false);
    };
  }, [dirty, key]);
  useEffect(() => {
    if (dirty && saveState.kind !== 'saving' && saveState.kind !== 'failed') setSaveState({ kind: 'dirty' });
  }, [dirty, saveState.kind]);

  const checks = useItemChecks(collection, id);
  const save = useMutation({
    mutationFn: async () => {
      setSaveState({ kind: 'saving' });
      return (await client.items(collection as never).patch(id, { data: draft!, expectedVersion: base!.version })).data as ItemRow;
    },
    onSuccess: (saved) => {
      setBase({ version: saved.version, data: { ...saved.data } });
      setDraft((current) => (current && jsonEqual(current, draft) ? { ...saved.data } : current));
      setSaveState({ kind: 'saved', at: new Date() });
      setConflict(null);
      setCheckedAt(new Date());
      void qc.invalidateQueries({ queryKey: siteKey('checks', collection, id) });
    },
    onError: async (err) => {
      const conflictInfo = versionConflictOf(err);
      if (conflictInfo) {
        const latest = (await client.items(collection as never).detail(id)).data as ItemRow;
        setConflict({ fields: conflictInfo.changedFields, latest });
        setSaveState({ kind: 'dirty' });
        return;
      }
      setSaveState({ kind: 'failed', reason: err instanceof HeoPressError ? err.message : err instanceof Error ? err.message : String(err) });
    },
  });
  // A published page's address change may break links to it: ask first (HeoPress P07 task 5.5), as the generic form does.
  const [impactPrompt, setImpactPrompt] = useState<{ impact: Awaited<ReturnType<typeof checkImpact>> & { kind: 'ask' } } | null>(null);
  const doSave = useCallback(() => {
    if (!draft || !base || save.isPending) return;
    const moved = itemQuery.data?.status === 'published' && (['slug', 'path'] as const).some((f) => f in base.data && draft[f] !== base.data[f]);
    if (!moved) return save.mutate();
    void checkImpact(async () => (await client.site.linkImpact(id)).data).then((decision) => {
      if (decision.kind === 'proceed') save.mutate();
      else setImpactPrompt({ impact: decision });
    });
  }, [draft, base, save, itemQuery.data?.status, client, id]);
  useSaveHandler(doSave, dirty && !save.isPending);

  /** Their changes to fields I did not touch come in; mine stay; the next save is based on their version. */
  const merge = () => {
    if (!conflict || !draft || !base) return;
    const mine = new Set(Object.keys(draft).filter((k) => !jsonEqual(draft[k], base.data[k])));
    const merged = { ...conflict.latest.data };
    for (const k of mine) merged[k] = draft[k];
    setDraft(merged);
    setBase({ version: conflict.latest.version, data: { ...conflict.latest.data } });
    setConflict(null);
  };
  const takeTheirs = () => {
    if (!conflict) return;
    setDraft({ ...conflict.latest.data });
    setBase({ version: conflict.latest.version, data: { ...conflict.latest.data } });
    setConflict(null);
  };

  const submit = useMutation({
    mutationFn: async () => {
      if (workflow) await client.rawRequest(`/api/v1/editorial/${collection}/${id}/submit-review`, { method: 'POST', body: JSON.stringify({ expectedVersion: base?.version }) });
      else await client.items(collection as never).patch(id, { status: 'published', expectedVersion: base!.version });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: siteKey('editor-item', collection, id) });
      setDraft(null);
    },
  });
  const preview = async () => {
    setPreviewMessage(null);
    try {
      const res = (await client.rawRequest<{ url: string }>('/api/v1/preview-links', { method: 'POST', body: JSON.stringify({ kind: 'item', collection, target_id: id }) })).data;
      window.open(res.url, '_blank', 'noopener');
    } catch {
      setPreviewMessage(t('previewOff'));
    }
  };

  // Where I am in the body, for the others (presence meta): the index of the block holding the caret.
  const [block, setBlock] = useState<number | null>(null);
  useEffect(() => {
    const onSelect = () => {
      const container = bodyRef.current?.querySelector('[contenteditable="true"]');
      const anchor = document.getSelection()?.anchorNode;
      if (!container || !anchor || !container.contains(anchor)) return;
      let node: Node | null = anchor;
      while (node && node.parentNode !== container) node = node.parentNode;
      setBlock(node ? Array.prototype.indexOf.call(container.childNodes, node) : null);
    };
    document.addEventListener('selectionchange', onSelect);
    return () => document.removeEventListener('selectionchange', onSelect);
  }, []);
  const myName = activeSession()?.userId ?? '';
  const { coEditors } = useCoEditorsWithMeta(collection, id, useMemo(() => ({ name: myName, ...(block !== null ? { block } : {}) }), [myName, block]));

  // The outline follows the body; the heading in view is highlighted.
  const bodyHtml = bodyField && typeof draft?.[bodyField.name] === 'string' ? (draft[bodyField.name] as string) : '';
  const outline = useMemo(() => outlineOf(bodyHtml), [bodyHtml]);
  useEffect(() => {
    const main = document.getElementById('main-content');
    if (!main) return;
    const onScroll = () => {
      const headings = bodyRef.current?.querySelectorAll('h2, h3') ?? [];
      let current: number | null = null;
      headings.forEach((h, i) => {
        if (h.getBoundingClientRect().top < 160) current = i;
      });
      setActiveHeading(current);
    };
    main.addEventListener('scroll', onScroll, { passive: true });
    return () => main.removeEventListener('scroll', onScroll);
  }, []);
  const jump = (h: Heading) => {
    const el = bodyRef.current?.querySelectorAll('h2, h3')[h.index];
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setActiveHeading(h.index);
  };

  if (itemQuery.isLoading || !draft || !bodyField) {
    return (
      <div className="p-6">
        <Skeleton className="mb-4 h-10 w-2/3" />
        <Skeleton className="h-96" />
      </div>
    );
  }
  const item = itemQuery.data!;
  const title = typeof draft.title === 'string' ? draft.title : '';
  const state = item.status === 'published' ? 'published' : (item.editorialState ?? 'draft');
  const seoTitle = typeof draft.seo_title === 'string' && draft.seo_title ? draft.seo_title : title;
  const seoDescription = typeof draft.seo_description === 'string' ? draft.seo_description : typeof draft.excerpt === 'string' ? draft.excerpt : '';
  const path = typeof draft.path === 'string' ? draft.path : typeof draft.slug === 'string' ? `/${draft.slug}/` : '';
  const others = coEditors.filter((c) => c.userId !== myName);

  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b border-line bg-panel px-4 py-2.5">
        <Link to={withAdminBase(adminBase, '/content') as never} aria-label={t('back')} className="rounded-ctl p-1.5 text-icon hover:bg-panel-2">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        </Link>
        <div className="min-w-0 flex-1 basis-[calc(100%-3rem)] sm:basis-auto">
          <p className="t-aux">{collection}</p>
          <p className="truncate text-[14px] font-semibold">{title || t('titlePlaceholder')}</p>
        </div>
        <span className="rounded-full bg-panel-2 px-2 py-0.5 text-[11.5px]">{t(`content:state.${state}`)}</span>
        <SaveStatus state={saveState} onRetry={doSave} />
        {others.length ? (
          <span role="group" className="flex -space-x-1.5" aria-label={t('present', { names: others.map((o) => String(o.meta?.name ?? o.userId)).join(', ') })}>
            {others.slice(0, 4).map((o) => (
              <span key={o.sessionId} className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-panel bg-soft text-[11px] font-semibold text-brand" aria-label={String(o.meta?.name ?? o.userId)}>
                {String(o.meta?.name ?? o.userId).slice(0, 1).toUpperCase()}
              </span>
            ))}
          </span>
        ) : null}
        <Link to={withAdminBase(adminBase, `/content/${collection}/${id}`) as never} search={{ form: 'full' } as never} className="rounded-ctl px-2 py-1.5 text-[13px] text-dim hover:bg-panel-2">
          {t('fullForm')}
        </Link>
        <button type="button" onClick={() => void preview()} className="inline-flex items-center gap-1.5 rounded-ctl border border-line px-2.5 py-1.5 text-[13px] hover:bg-panel-2">
          <Eye className="h-3.5 w-3.5" aria-hidden="true" />
          {t('preview')}
        </button>
        <button type="button" disabled={!dirty || save.isPending} onClick={doSave} className="rounded-ctl border border-line px-3 py-1.5 text-[13px] hover:bg-panel-2 disabled:opacity-50">
          {t('save')}
        </button>
        {perms.can(collection, 'update') && state !== 'published' && state !== 'in_review' ? (
          <button type="button" disabled={dirty || submit.isPending} onClick={() => submit.mutate()} className="inline-flex items-center gap-1.5 rounded-ctl bg-brand px-3 py-1.5 text-[13px] text-brand-fg disabled:opacity-50">
            <Send className="h-3.5 w-3.5" aria-hidden="true" />
            {workflow ? t('submitReview') : t('publish')}
          </button>
        ) : null}
      </header>
      {impactPrompt ? (
        <LinkImpactDialog
          itemId={id}
          change="move"
          impact={impactPrompt.impact.impact}
          canRedirect={perms.isAdmin}
          onCancel={() => setImpactPrompt(null)}
          onProceed={() => {
            setImpactPrompt(null);
            save.mutate();
          }}
        />
      ) : null}
      {previewMessage ? <p role="status" className="bg-warn-soft px-4 py-1.5 text-[12.5px] text-warn">{previewMessage}</p> : null}
      {conflict ? (
        <div role="alert" className="border-b border-warn/40 bg-warn-soft px-4 py-3 text-[13px]">
          <p className="font-medium text-warn">{t('conflict.title')}</p>
          <p>{t('conflict.changed', { fields: conflict.fields.join(', ') || '—' })}</p>
          <p className="t-aux">{t('conflict.hint')}</p>
          <div className="mt-2 flex gap-2">
            <button type="button" onClick={merge} className="rounded-ctl bg-brand px-3 py-1 text-brand-fg">{t('conflict.merge')}</button>
            <button type="button" onClick={takeTheirs} className="rounded-ctl border border-line bg-panel px-3 py-1">{t('conflict.theirs')}</button>
          </div>
        </div>
      ) : null}

      <div className="grid flex-1 grid-cols-1 gap-0 min-[1100px]:grid-cols-[minmax(0,1fr)_320px] min-[1400px]:grid-cols-[200px_minmax(0,1fr)_320px]">
        <nav aria-label={t('outline')} className="hidden border-r border-line px-3 py-4 min-[1400px]:block">
          <h2 className="mb-2 px-1 text-[11.5px] font-semibold uppercase tracking-wide text-dim">{t('outline')}</h2>
          {outline.length === 0 ? (
            <p className="px-1 t-aux">{t('noHeadings')}</p>
          ) : (
            <ol className="flex flex-col gap-0.5">
              {outline.map((h) => (
                <li key={h.index}>
                  <button type="button" onClick={() => jump(h)} aria-current={activeHeading === h.index ? 'location' : undefined} className={cn('w-full truncate rounded-ctl px-1.5 py-1 text-left text-[12.5px]', h.level === 3 && 'pl-4', activeHeading === h.index ? 'bg-sel font-medium text-fg' : 'text-dim hover:bg-panel-2')}>
                    {h.text}
                  </button>
                </li>
              ))}
            </ol>
          )}
        </nav>

        <div className="min-w-0 px-4 py-6 sm:px-8">
          <div className="mx-auto max-w-[760px]">
            <label htmlFor="article-title" className="sr-only">{t('titlePlaceholder')}</label>
            <input
              id="article-title"
              value={title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              placeholder={t('titlePlaceholder')}
              className="mb-4 w-full bg-transparent text-[28px] font-semibold leading-tight outline-none placeholder:text-dim"
            />
            <div ref={bodyRef} className="relative">
              <RichTextVariant.Provider value="article">
                <FieldsTab fields={[bodyField]} value={draft} onChange={setDraft} collection={collection} perms={perms} pinnedFields={[]} chrome="none" />
              </RichTextVariant.Provider>
              <PeerMarkers peers={others} container={bodyRef} />
            </div>
          </div>
        </div>

        <aside aria-label={t('tabs.seo')} className="border-t border-line bg-panel min-[1100px]:border-l min-[1100px]:border-t-0">
          <div role="tablist" className="flex border-b border-line">
            {(['seo', 'indexing', 'props'] as const).map((k) => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={cn('flex-1 py-2.5 text-[12.5px]', tab === k ? 'border-b-2 border-brand font-medium' : 'text-dim hover:bg-panel-2')}>
                {t(`tabs.${k}`)}
              </button>
            ))}
          </div>
          <div role="tabpanel" className="flex flex-col gap-4 p-4">
            <p className="t-aux">
              {checkedAt ? (
                <>
                  {t('inspector.checkedAt')} <RelativeTime value={checkedAt} />
                </>
              ) : (
                t('inspector.notSaved')
              )}
            </p>
            {tab === 'seo' ? (
              <>
                <section aria-label={t('inspector.serp')} className="rounded-ctl border border-line p-3">
                  <p className="truncate text-[15px] text-brand">{seoTitle || '—'}</p>
                  <p className="truncate text-[12px] text-ok">{path}</p>
                  <p className="line-clamp-2 text-[12.5px] text-dim">{seoDescription || '—'}</p>
                </section>
                {seoDescription ? (
                  <p className={cn('text-[12.5px]', descriptionHint(seoDescription) === 'ok' ? 'text-ok' : 'text-warn')}>
                    {t('inspector.descriptionHint', { count: [...seoDescription.trim()].length, hint: t(`inspector.${descriptionHint(seoDescription)}`) })}
                  </p>
                ) : null}
                {seoFields.length ? <FieldsTab fields={seoFields} value={draft} onChange={setDraft} collection={collection} perms={perms} pinnedFields={[]} chrome="compact" /> : null}
                <ChecksList checks={checks.data?.checks.filter((c) => c.id === 'title' || c.id === 'description' || c.id === 'indexing')} loading={checks.isLoading} />
              </>
            ) : tab === 'indexing' ? (
              <>
                <ChecksList checks={checks.data?.checks.filter((c) => c.id === 'structured_data' || c.id === 'links' || c.id === 'images')} loading={checks.isLoading} />
                <Row label={t('inspector.markdown')}>{path ? t('inspector.markdownAt', { path: path.replace(/\/$/, '') }) : t('inspector.none')}</Row>
              </>
            ) : (
              <>
                <Row label={t('inspector.author')}>{item.userCreated ?? t('inspector.none')}</Row>
                <ReviewerRow collection={collection} id={id} />
                {propFields.length ? <FieldsTab fields={propFields} value={draft} onChange={setDraft} collection={collection} perms={perms} pinnedFields={[]} chrome="compact" /> : null}
              </>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-3 text-[13px]">
      <span className="text-dim">{label}</span>
      <span className="truncate">{children}</span>
    </div>
  );
}

function ReviewerRow({ collection, id }: { collection: string; id: string }) {
  const { t } = useTranslation('editor');
  const history = useQuery({
    queryKey: siteKey('review-history', collection, id),
    queryFn: async () => (await getApiClient().rawRequest<Array<{ kind: string; by: string | null }>>(`/api/v1/studio/content/items/${collection}/${id}/history`)).data,
  });
  const decided = history.data?.find((h) => h.kind !== 'submitted');
  return <Row label={t('inspector.reviewer')}>{decided?.by ?? t('inspector.none')}</Row>;
}

function SaveStatus({ state, onRetry }: { state: SaveState; onRetry: () => void }) {
  const { t } = useTranslation('editor');
  if (state.kind === 'idle') return null;
  if (state.kind === 'failed') {
    return (
      <span role="alert" className="flex items-center gap-2 text-[12.5px] text-bad">
        {t('saveState.failed', { reason: state.reason })}
        <button type="button" onClick={onRetry} className="rounded-ctl border border-bad/40 px-2 py-0.5 hover:bg-bad-soft">
          {t('saveState.retry')}
        </button>
      </span>
    );
  }
  return (
    <span role="status" className={cn('text-[12.5px]', state.kind === 'dirty' ? 'text-warn' : 'text-dim')}>
      {state.kind === 'saved' ? (
        <>
          {t('saveState.saved')} <RelativeTime value={state.at} />
        </>
      ) : (
        t(`saveState.${state.kind}`)
      )}
    </span>
  );
}

/** Others' places in the body: their name beside the block they are in (from presence meta). */
function PeerMarkers({ peers, container }: { peers: Array<{ sessionId: string; userId: string; meta?: Record<string, unknown> }>; container: React.RefObject<HTMLDivElement | null> }) {
  const { t } = useTranslation('editor');
  const [, force] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => force((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, []);
  const editable = container.current?.querySelector('[contenteditable="true"]');
  if (!editable || !container.current) return null;
  const box = container.current.getBoundingClientRect();
  return (
    <>
      {peers
        .filter((p) => typeof p.meta?.block === 'number')
        .map((p) => {
          const el = editable.childNodes[p.meta!.block as number] as HTMLElement | undefined;
          if (!el?.getBoundingClientRect) return null;
          const r = el.getBoundingClientRect();
          const name = String(p.meta?.name ?? p.userId);
          return (
            <span key={p.sessionId} role="note" aria-label={t('editing', { name })} className="pointer-events-none absolute -right-2 translate-x-full rounded-full bg-ai px-2 py-0.5 text-[11px] text-white" style={{ top: r.top - box.top }}>
              {name}
            </span>
          );
        })}
    </>
  );
}

/** Co-editors of the item, sending where I am as presence meta. */
function useCoEditorsWithMeta(collection: string, id: string, meta: Record<string, unknown>) {
  return useCoEditors(collection, id, meta);
}


/** `/content/$collection/$id`: article collections get the article editor, everything else the generic form. */
export function ItemRoute() {
  const { collection, id } = useParams({ strict: false }) as { collection: string; id: string };
  const meta = useQuery({
    queryKey: ['collection', collection],
    queryFn: async () => (await getApiClient().schema.getCollection(collection)).data,
  });
  // `?form=full`: every field and action of the generic form (delete, unpublish, translations, revisions).
  const full = (useRouterState({ select: (st) => st.location.search }) as { form?: string }).form === 'full';
  if (full) return <ItemDetailPage />;
  if (meta.isLoading) {
    return (
      <div className="p-6">
        <Skeleton className="h-96" />
      </div>
    );
  }
  const m = meta.data?.meta as Record<string, unknown> | undefined;
  if (!isArticleCollection(collection, m)) return <ItemDetailPage />;
  // A new article starts from its few required fields, then opens here.
  if (id === 'new') return <NewArticlePage collection={collection} />;
  return <ArticleEditor key={`${collection}/${id}`} collection={collection} id={id} workflow={m?.editorialWorkflow === true} />;
}
