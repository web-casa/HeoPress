import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { EditorialProfileContent, EditorialProfileVersion } from '@heopress/sdk';
import { AlertTriangle, BookOpenText, Check, History, Save, Send } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import i18n from 'i18next';
import { useTranslation } from 'react-i18next';
import { getApiClient } from '@/lib/api';

/**
 * Settings → Editorial profile (HeoPress P05 task 2.3; spec
 * content/editorial-profiles; design C): who the site writes for, how it
 * sounds, its terms, how it cites, its structure, quality and publishing
 * rules, and what it does not write about.
 *
 * Saving always makes a new version (the history stays readable); one
 * version is in effect, and an administrator publishes a version to make it
 * so. AI tasks and external agents follow the version in effect, and their
 * runs record its number.
 */

const EMPTY: EditorialProfileContent = {
  audience: '',
  tone: '',
  glossary: [],
  citationPolicy: '',
  structureRules: [],
  qualityRules: [],
  publishRules: [],
  forbiddenTopics: [],
};

/** One rule per line in the form; empty lines dropped. */
const lines = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

/** Glossary lines: `term = preferred` (or just `term`). */
const glossaryFrom = (text: string): EditorialProfileContent['glossary'] =>
  lines(text).map((line) => {
    const [term, preferred] = line.split('=').map((p) => p.trim());
    return preferred ? { term: term!, preferred } : { term: term! };
  });
const glossaryText = (glossary: EditorialProfileContent['glossary']) => glossary.map((g) => (g.preferred ? `${g.term} = ${g.preferred}` : g.term)).join('\n');

interface Form {
  audience: string;
  tone: string;
  glossary: string;
  citationPolicy: string;
  structureRules: string;
  qualityRules: string;
  publishRules: string;
  forbiddenTopics: string;
}

const toForm = (c: EditorialProfileContent): Form => ({
  audience: c.audience,
  tone: c.tone,
  glossary: glossaryText(c.glossary),
  citationPolicy: c.citationPolicy,
  structureRules: c.structureRules.join('\n'),
  qualityRules: c.qualityRules.join('\n'),
  publishRules: c.publishRules.join('\n'),
  forbiddenTopics: c.forbiddenTopics.join('\n'),
});

const toContent = (f: Form): EditorialProfileContent => ({
  audience: f.audience.trim(),
  tone: f.tone.trim(),
  glossary: glossaryFrom(f.glossary),
  citationPolicy: f.citationPolicy.trim(),
  structureRules: lines(f.structureRules),
  qualityRules: lines(f.qualityRules),
  publishRules: lines(f.publishRules),
  forbiddenTopics: lines(f.forbiddenTopics),
});

/** Label and hint come from `system:editorial.fields.<key>.{label,hint}`. */
const FIELDS: Array<{ key: keyof Form; rows: number }> = [
  { key: 'audience', rows: 2 },
  { key: 'tone', rows: 2 },
  { key: 'glossary', rows: 4 },
  { key: 'citationPolicy', rows: 3 },
  { key: 'structureRules', rows: 3 },
  { key: 'qualityRules', rows: 3 },
  { key: 'publishRules', rows: 3 },
  { key: 'forbiddenTopics', rows: 3 },
];

const errorText = (err: unknown) => (err instanceof Error ? err.message : i18n.t('system:editorial.error'));

export function EditorialProfilePage() {
  const { t } = useTranslation(['system', 'common']);
  const client = getApiClient();
  const qc = useQueryClient();
  const versions = useQuery({
    queryKey: ['editorial-profile', 'versions'],
    queryFn: async () => (await client.editorialProfile.versions()).data,
  });
  const [selected, setSelected] = useState<number | null>(null);
  const [form, setForm] = useState<Form>(toForm(EMPTY));
  const [notice, setNotice] = useState<string | null>(null);
  const formId = useId();

  const list = versions.data ?? [];
  const inEffect = list.find((v) => v.status === 'published') ?? null;
  const shown: EditorialProfileVersion | null = list.find((v) => v.version === selected) ?? inEffect ?? list[0] ?? null;

  // The form starts from the version shown (the one in effect by default).
  useEffect(() => {
    setForm(toForm(shown?.content ?? EMPTY));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when another version is shown
  }, [shown?.version]);

  const refresh = () => qc.invalidateQueries({ queryKey: ['editorial-profile'] });
  const save = useMutation({
    mutationFn: async () => (await client.editorialProfile.create(toContent(form))).data,
    onSuccess: (v) => {
      setSelected(v.version);
      setNotice(t('editorial.saved', { version: v.version }));
      void refresh();
    },
  });
  const publish = useMutation({
    mutationFn: async (n: number) => (await client.editorialProfile.publish(n)).data,
    onSuccess: (v) => {
      setNotice(t('editorial.published', { version: v.version }));
      void refresh();
    },
  });

  if (versions.isError) {
    return (
      <div role="alert" className="m-6 flex items-center gap-3 rounded-md bg-rose-50 p-3 text-sm text-rose-800">
        <AlertTriangle className="h-4 w-4" aria-hidden /> {t('editorial.loadFailed')}
        <button type="button" onClick={() => void versions.refetch()} className="rounded-md border px-2 py-1">
          {t('editorial.tryAgain')}
        </button>
      </div>
    );
  }
  if (versions.isLoading) return <p className="p-6 text-sm text-muted-foreground">{t('common:loading')}</p>;

  const failure = save.error ?? publish.error;
  return (
    <div className="mx-auto grid max-w-5xl gap-6 p-6 lg:grid-cols-[1fr_16rem]">
      <div className="space-y-4">
        <header>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <BookOpenText className="h-5 w-5" aria-hidden /> {t('editorial.title')}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {inEffect ? t('editorial.inEffect', { version: inEffect.version }) : t('editorial.noneInEffect')}{' '}
            {t('editorial.followNote')}
          </p>
        </header>
        <form
          id={formId}
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            setNotice(null);
            save.mutate();
          }}
        >
          {FIELDS.map((f) => (
            <label key={f.key} className="block space-y-1">
              <span className="text-sm font-medium">{t(`editorial.fields.${f.key}.label`)}</span>
              <span className="block text-xs text-muted-foreground">{t(`editorial.fields.${f.key}.hint`)}</span>
              <textarea
                value={form[f.key]}
                onChange={(e) => setForm((prev) => ({ ...prev, [f.key]: e.target.value }))}
                rows={f.rows}
                className="w-full rounded-md border bg-background p-2 text-sm"
              />
            </label>
          ))}
          {failure && (
            <p role="alert" className="flex items-center gap-2 rounded-md bg-rose-50 p-2 text-sm text-rose-800">
              <AlertTriangle className="h-4 w-4" aria-hidden /> {errorText(failure)}
            </p>
          )}
          {notice && (
            <p className="flex items-center gap-2 text-sm text-emerald-700">
              <Check className="h-4 w-4" aria-hidden /> {notice}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button type="submit" disabled={save.isPending} className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50">
              <Save className="h-4 w-4" aria-hidden /> {t('editorial.saveNew')}
            </button>
          </div>
        </form>
      </div>

      <aside aria-labelledby="versions-heading" className="space-y-2">
        <h2 id="versions-heading" className="flex items-center gap-2 text-sm font-medium">
          <History className="h-4 w-4" aria-hidden /> {t('editorial.versions')}
        </h2>
        {list.length === 0 && <p className="text-sm text-muted-foreground">{t('editorial.noneYet')}</p>}
        <ul className="space-y-1">
          {list.map((v) => (
            <li key={v.version} aria-label={t('editorial.version', { version: v.version })} className={`rounded-md border p-2 text-sm ${shown?.version === v.version ? 'border-primary' : ''}`}>
              <button type="button" onClick={() => setSelected(v.version)} className="w-full text-left">
                <span className="font-medium">{t('editorial.version', { version: v.version })}</span>{' '}
                <span className="text-xs text-muted-foreground">{v.status === 'published' ? t('editorial.statusInEffect') : v.status === 'draft' ? t('editorial.statusDraft') : v.status}</span>
                <span className="block text-xs text-muted-foreground">{new Date(v.createdAt).toLocaleString()}</span>
              </button>
              {v.status !== 'published' && (
                <button
                  type="button"
                  onClick={() => {
                    setNotice(null);
                    publish.mutate(v.version);
                  }}
                  disabled={publish.isPending}
                  className="mt-1 inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs disabled:opacity-50"
                >
                  <Send className="h-3 w-3" aria-hidden /> {t('editorial.putInEffect')}
                </button>
              )}
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}
