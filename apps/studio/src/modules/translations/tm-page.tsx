// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TmEntry, TmSource } from '@heopress/sdk';
import { getApiClient } from '@/lib/api';
import { PageHeader } from '@/workspace/ui/page-header';

/**
 * Translation memory manager (translation-memory-ui Req 1–2).
 *
 * Surfaces the TM entry store (list / filter / edit / delete with pagination)
 * plus the two pipelines built on it — fuzzy lookup (TM only) and full
 * translate (TM → glossary → MT provider). The try-out panels let an operator
 * see exactly what an agent translating content would get.
 */

const PAGE_SIZE = 25;
const SOURCES: TmSource[] = ['human', 'mt', 'imported'];

function UpsertForm({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('tm');
  const client = getApiClient();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    sourceLang: 'en',
    targetLang: 'vi',
    sourceText: '',
    targetText: '',
  });

  const mutation = useMutation({
    mutationFn: () => client.tm.upsert({ ...form, source: 'human' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tm-entries'] });
      onClose();
    },
  });

  const set =
    (key: keyof typeof form) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setForm((prev) => ({ ...prev, [key]: e.target.value }));

  return (
    <div className="space-y-2 rounded-card border border-line bg-panel p-4">
      <h3 className="t-section">{t('add.title')}</h3>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <label className="text-xs">
          <span className="mb-1 block text-dim">{t('add.sourceLang')}</span>
          <input value={form.sourceLang} onChange={set('sourceLang')} aria-label={t('add.sourceLangAria')} className="w-full rounded-ctl border border-line bg-bg px-2 py-1.5 font-mono" />
        </label>
        <label className="text-xs">
          <span className="mb-1 block text-dim">{t('add.targetLang')}</span>
          <input value={form.targetLang} onChange={set('targetLang')} aria-label={t('add.targetLangAria')} className="w-full rounded-ctl border border-line bg-bg px-2 py-1.5 font-mono" />
        </label>
        <label className="text-xs col-span-2 sm:col-span-4">
          <span className="mb-1 block text-dim">{t('add.sourceText')} *</span>
          <textarea value={form.sourceText} onChange={set('sourceText')} rows={2} aria-label={t('add.sourceTextAria')} className="w-full rounded-ctl border border-line bg-bg px-2 py-1.5" />
        </label>
        <label className="text-xs col-span-2 sm:col-span-4">
          <span className="mb-1 block text-dim">{t('add.targetText')} *</span>
          <textarea value={form.targetText} onChange={set('targetText')} rows={2} aria-label={t('add.targetTextAria')} className="w-full rounded-ctl border border-line bg-bg px-2 py-1.5" />
        </label>
      </div>
      {mutation.isError && (
        <p className="text-xs text-bad">
          {mutation.error instanceof Error ? mutation.error.message : t('add.saveFailed')}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => mutation.mutate()}
          disabled={mutation.isPending || !form.sourceText.trim() || !form.targetText.trim()}
          className="rounded-ctl bg-brand px-3 py-1.5 text-xs font-medium text-brand-fg hover:opacity-90 disabled:opacity-50"
        >
          {mutation.isPending ? t('saving') : t('add.save')}
        </button>
        <button type="button" onClick={onClose} className="rounded-ctl border border-line px-3 py-1.5 text-xs hover:bg-panel-2">
          {t('common:cancel')}
        </button>
      </div>
    </div>
  );
}

function LookupPanel() {
  const { t } = useTranslation('tm');
  const client = getApiClient();
  const [query, setQuery] = useState('');
  const [sourceLang, setSourceLang] = useState('en');
  const [targetLang, setTargetLang] = useState('vi');

  const mutation = useMutation({
    mutationFn: () => client.tm.lookup({ query, sourceLang, targetLang }),
  });

  return (
    <section className="rounded-card border border-line bg-panel p-4">
      <h3 className="mb-2 t-section">{t('lookup.title')}</h3>
      <div className="space-y-2">
        <textarea
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          rows={2}
          placeholder={t('lookup.placeholder')}
          aria-label={t('lookup.queryAria')}
          className="w-full rounded-ctl border border-line bg-bg px-2 py-1.5 text-xs"
        />
        <div className="flex items-center gap-2">
          <input value={sourceLang} onChange={(e) => setSourceLang(e.target.value)} aria-label={t('lookup.sourceLangAria')} className="w-14 rounded-ctl border border-line bg-bg px-2 py-1 font-mono text-xs" />
          <span className="text-xs text-dim">→</span>
          <input value={targetLang} onChange={(e) => setTargetLang(e.target.value)} aria-label={t('lookup.targetLangAria')} className="w-14 rounded-ctl border border-line bg-bg px-2 py-1 font-mono text-xs" />
          <button
            type="button"
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending || !query.trim()}
            className="rounded-ctl border border-line px-3 py-1 text-xs font-medium hover:bg-panel-2 disabled:opacity-50"
          >
            {mutation.isPending ? t('lookup.pending') : t('lookup.submit')}
          </button>
        </div>
        {mutation.isError && (
          <p className="text-xs text-bad">
            {mutation.error instanceof Error ? mutation.error.message : t('lookup.failed')}
          </p>
        )}
        {mutation.isSuccess &&
          (mutation.data ? (
            <div className="rounded-ctl border border-line bg-panel-2 p-2 text-xs">
              <p className="font-medium">{mutation.data.targetText}</p>
              <p className="text-dim">{t('lookup.similarity', { value: mutation.data.similarity })}</p>
            </div>
          ) : (
            <p className="text-xs text-dim">{t('lookup.noMatch')}</p>
          ))}
      </div>
    </section>
  );
}

function TranslatePanel() {
  const { t } = useTranslation('tm');
  const client = getApiClient();
  const [text, setText] = useState('');
  const [from, setFrom] = useState('en');
  const [to, setTo] = useState('vi');

  const mutation = useMutation({
    mutationFn: () => client.tm.translate({ text, from, to }),
  });

  return (
    <section className="rounded-card border border-line bg-panel p-4">
      <h3 className="mb-2 t-section">{t('translate.title')}</h3>
      <div className="space-y-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={2}
          placeholder={t('translate.placeholder')}
          aria-label={t('translate.textAria')}
          className="w-full rounded-ctl border border-line bg-bg px-2 py-1.5 text-xs"
        />
        <div className="flex items-center gap-2">
          <input value={from} onChange={(e) => setFrom(e.target.value)} aria-label={t('translate.fromAria')} className="w-14 rounded-ctl border border-line bg-bg px-2 py-1 font-mono text-xs" />
          <span className="text-xs text-dim">→</span>
          <input value={to} onChange={(e) => setTo(e.target.value)} aria-label={t('translate.toAria')} className="w-14 rounded-ctl border border-line bg-bg px-2 py-1 font-mono text-xs" />
          <button
            type="button"
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending || !text.trim()}
            className="rounded-ctl border border-line px-3 py-1 text-xs font-medium hover:bg-panel-2 disabled:opacity-50"
          >
            {mutation.isPending ? t('translate.pending') : t('translate.submit')}
          </button>
        </div>
        {mutation.isError && (
          <p className="text-xs text-bad">
            {mutation.error instanceof Error ? mutation.error.message : t('translate.failed')}
          </p>
        )}
        {mutation.isSuccess && (
          <pre className="overflow-x-auto rounded-ctl border border-line bg-panel-2 p-2 font-mono text-xs">
            {JSON.stringify(mutation.data.data, null, 2)}
          </pre>
        )}
      </div>
    </section>
  );
}

function SourceBadge({ source }: { source: string }) {
  const { t } = useTranslation('tm');
  return (
    <span className="rounded bg-panel-2 px-1.5 py-0.5 text-[10px] font-medium uppercase text-dim">
      {t(`origin.${source}`, { defaultValue: source })}
    </span>
  );
}

function EntryRow({ row }: { row: TmEntry }) {
  const { t } = useTranslation('tm');
  const client = getApiClient();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [targetText, setTargetText] = useState(row.targetText);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['tm-entries'] });

  const saveMutation = useMutation({
    mutationFn: () => client.tm.update(row.id, { targetText }),
    onSuccess: () => {
      invalidate();
      setEditing(false);
    },
  });
  const deleteMutation = useMutation({
    mutationFn: () => client.tm.delete(row.id),
    onSuccess: invalidate,
  });

  return (
    <tr className="border-b border-line align-top last:border-0">
      <td className="py-2 font-mono text-xs">
        {row.sourceLang}→{row.targetLang}
      </td>
      <td className="max-w-xs truncate py-2 text-xs" title={row.sourceText}>
        {row.sourceText}
      </td>
      <td className="max-w-xs py-2 text-xs">
        {editing ? (
          <textarea
            value={targetText}
            onChange={(e) => setTargetText(e.target.value)}
            rows={2}
            aria-label={t('entries.editTargetAria', { id: row.id })}
            className="w-full rounded-ctl border border-line bg-bg px-2 py-1 text-xs"
          />
        ) : (
          <span className="block truncate" title={row.targetText}>
            {row.targetText}
          </span>
        )}
      </td>
      <td className="py-2 text-xs">{row.quality ?? '—'}</td>
      <td className="py-2 text-xs">
        <SourceBadge source={row.source} />
        {row.provider ? <span className="ml-1 text-dim">({row.provider})</span> : null}
      </td>
      <td className="py-2 text-right">
        {editing ? (
          <div className="flex justify-end gap-1">
            <button
              type="button"
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending || !targetText.trim()}
              aria-label={t('entries.saveAria', { id: row.id })}
              className="rounded p-1 text-dim hover:text-brand disabled:opacity-50"
            >
              <Check className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => {
                setTargetText(row.targetText);
                setEditing(false);
              }}
              aria-label={t('entries.cancelAria', { id: row.id })}
              className="rounded p-1 text-dim hover:text-fg"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <div className="flex justify-end gap-1">
            <button
              type="button"
              onClick={() => setEditing(true)}
              aria-label={t('entries.editAria', { id: row.id })}
              className="rounded p-1 text-dim hover:text-fg"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => deleteMutation.mutate()}
              aria-label={t('entries.deleteAria', { id: row.id })}
              className="rounded p-1 text-dim hover:text-bad"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </td>
    </tr>
  );
}

export function TranslationMemoryPage() {
  const { t } = useTranslation('tm');
  const client = getApiClient();
  const [adding, setAdding] = useState(false);
  const [sourceFilter, setSourceFilter] = useState('');
  const [targetFilter, setTargetFilter] = useState('');
  const [entrySource, setEntrySource] = useState<TmSource | ''>('');
  const [page, setPage] = useState(0);

  const entriesQuery = useQuery({
    queryKey: ['tm-entries', sourceFilter, targetFilter, entrySource, page],
    queryFn: () =>
      client.tm.list({
        source: sourceFilter || undefined,
        target: targetFilter || undefined,
        entrySource: entrySource || undefined,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      }),
  });

  const entries = entriesQuery.data?.data ?? [];
  const total = (entriesQuery.data?.meta?.total as number | undefined) ?? entries.length;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const resetPage = <T,>(setter: (v: T) => void) => (v: T) => {
    setter(v);
    setPage(0);
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('page.title')}
        description={t('page.subtitle')}
        actions={!adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="inline-flex items-center gap-1 rounded-ctl bg-brand px-3 py-1.5 text-xs font-medium text-brand-fg hover:opacity-90"
          >
            <Plus className="h-3.5 w-3.5" /> {t('add.title')}
          </button>
        )}
      />

      {adding && <UpsertForm onClose={() => setAdding(false)} />}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <LookupPanel />
        <TranslatePanel />
      </div>

      <div className="rounded-card border border-line bg-panel p-4">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h3 className="t-section">{t('entries.title')}</h3>
          <input
            value={sourceFilter}
            onChange={(e) => resetPage(setSourceFilter)(e.target.value)}
            placeholder={t('entries.sourcePlaceholder')}
            aria-label={t('entries.filterSourceAria')}
            className="w-24 rounded-ctl border border-line bg-bg px-2 py-1 font-mono text-xs"
          />
          <input
            value={targetFilter}
            onChange={(e) => resetPage(setTargetFilter)(e.target.value)}
            placeholder={t('entries.targetPlaceholder')}
            aria-label={t('entries.filterTargetAria')}
            className="w-24 rounded-ctl border border-line bg-bg px-2 py-1 font-mono text-xs"
          />
          <select
            value={entrySource}
            onChange={(e) => resetPage(setEntrySource)(e.target.value as TmSource | '')}
            aria-label={t('entries.filterOriginAria')}
            className="rounded-ctl border border-line bg-bg px-2 py-1 text-xs"
          >
            <option value="">{t('entries.allOrigins')}</option>
            {SOURCES.map((s) => (
              <option key={s} value={s}>
                {t(`origin.${s}`)}
              </option>
            ))}
          </select>
        </div>
        {entriesQuery.isLoading ? (
          <p className="text-sm text-dim">{t('entries.loading')}</p>
        ) : entriesQuery.isError ? (
          <p className="text-sm text-bad">
            {entriesQuery.error instanceof Error ? entriesQuery.error.message : t('common:errors.load')}
          </p>
        ) : entries.length === 0 ? (
          <p className="text-sm text-dim">{t('entries.empty')}</p>
        ) : (
          <>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs uppercase text-dim">
                  <th className="py-2">{t('entries.pair')}</th>
                  <th>{t('entries.source')}</th>
                  <th>{t('entries.target')}</th>
                  <th>{t('entries.quality')}</th>
                  <th>{t('entries.origin')}</th>
                  <th aria-label={t('entries.actions')} />
                </tr>
              </thead>
              <tbody>
                {entries.map((row) => (
                  <EntryRow key={row.id} row={row} />
                ))}
              </tbody>
            </table>
            <div className="mt-3 flex items-center justify-between text-xs text-dim">
              <span>
                {t('entries.pageInfo', { count: total, page: page + 1, pages: pageCount })}
              </span>
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page === 0}
                  className="rounded-ctl border border-line px-2 py-1 hover:bg-panel-2 disabled:opacity-40"
                >
                  {t('entries.prev')}
                </button>
                <button
                  type="button"
                  onClick={() => setPage((p) => (p + 1 < pageCount ? p + 1 : p))}
                  disabled={page + 1 >= pageCount}
                  className="rounded-ctl border border-line px-2 py-1 hover:bg-panel-2 disabled:opacity-40"
                >
                  {t('entries.next')}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
