// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { GlossaryEntry, GlossaryRule } from '@heopress/sdk';
import { getApiClient } from '@/lib/api';
import { PageHeader } from '@/workspace/ui/page-header';

/**
 * Site glossary manager (HeoPress v1.4, spec `ai/site-glossary`).
 *
 * The site's terminology for a language pair: `prefer` (render it this way), `do-not-translate` (keep the source
 * spelling) and `forbidden` (never use this wording). Every row the two-model translation gates see comes from here,
 * so this screen is the operator's only way to make a term binding — the translation service itself never invents one.
 *
 * Site-scoped by the API (the request's site, never the body); reading is open to members, changing to administrators.
 */

const PAGE_SIZE = 50;
const RULES: GlossaryRule[] = ['prefer', 'do-not-translate', 'forbidden'];

interface FormState {
  sourceLang: string;
  targetLang: string;
  term: string;
  translation: string;
  rule: GlossaryRule;
  note: string;
}

const emptyForm = (): FormState => ({ sourceLang: 'en', targetLang: 'zh-CN', term: '', translation: '', rule: 'prefer', note: '' });

function formOf(entry: GlossaryEntry): FormState {
  return {
    sourceLang: entry.sourceLang,
    targetLang: entry.targetLang,
    term: entry.term,
    translation: entry.translation,
    rule: entry.rule,
    note: entry.note ?? '',
  };
}

/** The rule selector plus the help text that explains what the chosen rule binds the translator to. */
function RuleField({ value, onChange }: { value: GlossaryRule; onChange: (rule: GlossaryRule) => void }) {
  const { t } = useTranslation('glossary');
  const helpKey = value === 'do-not-translate' ? 'rule.doNotTranslateHelp' : value === 'forbidden' ? 'rule.forbiddenHelp' : 'rule.preferHelp';
  return (
    <label className="text-xs">
      <span className="mb-1 block text-dim">{t('form.rule')}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as GlossaryRule)}
        aria-label={t('form.ruleAria')}
        className="w-full rounded-ctl border border-line bg-bg px-2 py-1.5"
      >
        {RULES.map((rule) => (
          <option key={rule} value={rule}>
            {t(`rule.${rule}`)}
          </option>
        ))}
      </select>
      <span className="mt-1 block text-[11px] text-dim">{t(helpKey)}</span>
    </label>
  );
}

function EntryForm({ initial, onClose }: { initial?: GlossaryEntry; onClose: () => void }) {
  const { t } = useTranslation('glossary');
  const client = getApiClient();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<FormState>(initial ? formOf(initial) : emptyForm());

  const mutation = useMutation({
    mutationFn: () => {
      const payload = { ...form, note: form.note.trim() ? form.note.trim() : null };
      return initial ? client.glossary.update(initial.id, payload) : client.glossary.create(payload);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['glossary-entries'] });
      onClose();
    },
  });

  const set =
    (key: keyof FormState) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setForm((prev) => ({ ...prev, [key]: e.target.value }));

  /** A do-not-translate term keeps its own spelling, so the translation field follows the term. */
  const setRule = (rule: GlossaryRule) =>
    setForm((prev) => ({
      ...prev,
      rule,
      translation: rule === 'do-not-translate' ? prev.term : prev.translation,
    }));

  const setTerm = (term: string) =>
    setForm((prev) => ({
      ...prev,
      term,
      translation: prev.rule === 'do-not-translate' ? term : prev.translation,
    }));

  return (
    <div className="space-y-2 rounded-card border border-line bg-panel p-4">
      <h3 className="t-section">{initial ? t('form.editTitle') : t('form.addTitle')}</h3>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <label className="text-xs">
          <span className="mb-1 block text-dim">{t('form.sourceLang')}</span>
          <input
            value={form.sourceLang}
            onChange={set('sourceLang')}
            aria-label={t('form.sourceLangAria')}
            className="w-full rounded-ctl border border-line bg-bg px-2 py-1.5 font-mono"
          />
        </label>
        <label className="text-xs">
          <span className="mb-1 block text-dim">{t('form.targetLang')}</span>
          <input
            value={form.targetLang}
            onChange={set('targetLang')}
            aria-label={t('form.targetLangAria')}
            className="w-full rounded-ctl border border-line bg-bg px-2 py-1.5 font-mono"
          />
        </label>
        <RuleField value={form.rule} onChange={setRule} />
        <label className="text-xs">
          <span className="mb-1 block text-dim">{t('form.term')} *</span>
          <input
            value={form.term}
            onChange={(e) => setTerm(e.target.value)}
            aria-label={t('form.termAria')}
            className="w-full rounded-ctl border border-line bg-bg px-2 py-1.5"
          />
        </label>
        <label className="text-xs sm:col-span-2">
          <span className="mb-1 block text-dim">{t('form.translation')} *</span>
          <input
            value={form.translation}
            onChange={set('translation')}
            aria-label={t('form.translationAria')}
            className="w-full rounded-ctl border border-line bg-bg px-2 py-1.5"
          />
        </label>
        <label className="text-xs sm:col-span-2">
          <span className="mb-1 block text-dim">{t('form.note')}</span>
          <input
            value={form.note}
            onChange={set('note')}
            aria-label={t('form.noteAria')}
            className="w-full rounded-ctl border border-line bg-bg px-2 py-1.5"
          />
        </label>
      </div>
      {mutation.isError && (
        <p className="text-xs text-bad">
          {mutation.error instanceof Error ? mutation.error.message : t('form.saveFailed')}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => mutation.mutate()}
          disabled={mutation.isPending || !form.term.trim() || !form.translation.trim()}
          className="rounded-ctl bg-brand px-3 py-1.5 text-xs font-medium text-brand-fg hover:opacity-90 disabled:opacity-50"
        >
          {mutation.isPending ? t('saving') : t('form.save')}
        </button>
        <button type="button" onClick={onClose} className="rounded-ctl border border-line px-3 py-1.5 text-xs hover:bg-panel-2">
          {t('common:cancel')}
        </button>
      </div>
    </div>
  );
}

function RuleBadge({ rule }: { rule: GlossaryRule }) {
  const { t } = useTranslation('glossary');
  const tone = rule === 'forbidden' ? 'text-bad' : 'text-dim';
  return <span className={`rounded bg-panel-2 px-1.5 py-0.5 text-[10px] font-medium ${tone}`}>{t(`rule.${rule}`)}</span>;
}

function EntryRow({ row, onEdit }: { row: GlossaryEntry; onEdit: (entry: GlossaryEntry) => void }) {
  const { t } = useTranslation('glossary');
  const client = getApiClient();
  const queryClient = useQueryClient();
  const deleteMutation = useMutation({
    mutationFn: () => client.glossary.delete(row.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['glossary-entries'] }),
  });

  return (
    <tr className="border-b border-line align-top last:border-0">
      <td className="py-2 font-mono text-xs">
        {row.sourceLang}→{row.targetLang}
      </td>
      <td className="max-w-xs truncate py-2 text-xs" title={row.term}>
        {row.term}
      </td>
      <td className="max-w-xs truncate py-2 text-xs" title={row.translation}>
        {row.translation}
      </td>
      <td className="py-2 text-xs">
        <RuleBadge rule={row.rule} />
      </td>
      <td className="max-w-xs truncate py-2 text-xs text-dim" title={row.note ?? ''}>
        {row.note ?? '—'}
      </td>
      <td className="py-2 text-right">
        <div className="flex justify-end gap-1">
          <button
            type="button"
            onClick={() => onEdit(row)}
            aria-label={t('entries.editAria', { term: row.term })}
            className="rounded p-1 text-dim hover:text-fg"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => deleteMutation.mutate()}
            aria-label={t('entries.deleteAria', { term: row.term })}
            className="rounded p-1 text-dim hover:text-bad"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </td>
    </tr>
  );
}

export function GlossaryPage() {
  const { t } = useTranslation('glossary');
  const client = getApiClient();
  const [editing, setEditing] = useState<GlossaryEntry | null>(null);
  const [adding, setAdding] = useState(false);
  const [fromFilter, setFromFilter] = useState('');
  const [toFilter, setToFilter] = useState('');
  const [page, setPage] = useState(0);

  const entriesQuery = useQuery({
    queryKey: ['glossary-entries', fromFilter, toFilter, page],
    queryFn: () =>
      client.glossary.list({
        from: fromFilter || undefined,
        to: toFilter || undefined,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      }),
  });

  const entries = entriesQuery.data?.data ?? [];
  const total = (entriesQuery.data?.meta?.total as number | undefined) ?? entries.length;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const closeForm = () => {
    setAdding(false);
    setEditing(null);
  };
  const resetPage =
    <T,>(setter: (value: T) => void) =>
    (value: T) => {
      setter(value);
      setPage(0);
    };

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('page.title')}
        description={t('page.subtitle')}
        actions={
          !adding &&
          !editing && (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="inline-flex items-center gap-1 rounded-ctl bg-brand px-3 py-1.5 text-xs font-medium text-brand-fg hover:opacity-90"
            >
              <Plus className="h-3.5 w-3.5" /> {t('form.addTitle')}
            </button>
          )
        }
      />

      {(adding || editing) && <EntryForm {...(editing ? { initial: editing } : {})} onClose={closeForm} />}

      <div className="rounded-card border border-line bg-panel p-4">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h3 className="t-section">{t('entries.title')}</h3>
          <input
            value={fromFilter}
            onChange={(e) => resetPage(setFromFilter)(e.target.value)}
            placeholder={t('entries.fromPlaceholder')}
            aria-label={t('entries.filterFromAria')}
            className="w-24 rounded-ctl border border-line bg-bg px-2 py-1 font-mono text-xs"
          />
          <span className="text-xs text-dim">→</span>
          <input
            value={toFilter}
            onChange={(e) => resetPage(setToFilter)(e.target.value)}
            placeholder={t('entries.toPlaceholder')}
            aria-label={t('entries.filterToAria')}
            className="w-24 rounded-ctl border border-line bg-bg px-2 py-1 font-mono text-xs"
          />
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
                  <th>{t('entries.term')}</th>
                  <th>{t('entries.translation')}</th>
                  <th>{t('entries.rule')}</th>
                  <th>{t('entries.note')}</th>
                  <th aria-label={t('entries.actions')} />
                </tr>
              </thead>
              <tbody>
                {entries.map((row) => (
                  <EntryRow
                    key={row.id}
                    row={row}
                    onEdit={(entry) => {
                      setAdding(false);
                      setEditing(entry);
                    }}
                  />
                ))}
              </tbody>
            </table>
            <div className="mt-3 flex items-center justify-between text-xs text-dim">
              <span>{t('entries.pageInfo', { count: total, page: page + 1, pages: pageCount })}</span>
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
