import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { HeoPressError } from '@heopress/sdk';
import { FileText, Save, Trash2 } from 'lucide-react';
import { useId, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { getApiClient } from '@/lib/api';

/**
 * Root files — files served at the site's root (HeoPress P07 task 3.8; spec seo/crawl-discovery "站点根文件").
 *
 * Search engine verification files, `ads.txt`, `app-ads.txt`, a web app manifest: text, typed by their extension. Names
 * the system makes itself (`robots.txt`, the sitemaps, the feeds, `llms.txt`) cannot be used. Every change is audited and
 * shows on the site at once.
 */

function messageOf(err: unknown, fallback: string): string {
  if (err instanceof HeoPressError) {
    const first = (err.body as { errors?: Array<{ message?: string }> })?.errors?.[0];
    if (first?.message) return first.message;
  }
  return fallback;
}

const inputClass = 'w-full rounded-ctl border border-line bg-bg px-2.5 py-1.5 text-[13px] outline-none focus:border-brand';

export function RootFilesPage() {
  const { t } = useTranslation('siteOps');
  const client = getApiClient();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['site-root-files'], queryFn: async () => (await client.site.rootFiles()).data });
  const [filename, setFilename] = useState('');
  const [content, setContent] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const ids = { name: useId(), content: useId() };

  const save = useMutation({
    mutationFn: async () => (await client.site.putRootFile(filename.trim(), content)).data,
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['site-root-files'] });
      setEditing(null);
      setFilename('');
      setContent('');
    },
  });
  const remove = useMutation({
    mutationFn: async (name: string) => (await client.site.deleteRootFile(name)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['site-root-files'] }),
  });
  const edit = async (name: string) => {
    const file = (await client.site.rootFile(name)).data;
    setEditing(name);
    setFilename(name);
    setContent(file.content ?? '');
  };

  return (
    <div className="max-w-2xl space-y-6">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 t-section">
          <FileText className="h-5 w-5" aria-hidden="true" />
          {t('rootFiles.title')}
        </h1>
        <p className="text-sm text-dim">
          <Trans t={t} i18nKey="rootFiles.description" components={{ code: <code /> }} />
        </p>
      </header>

      {list.isLoading ? <p className="text-sm text-dim">{t('common:loading')}</p> : null}
      {list.isError ? (
        <p role="alert" className="text-sm text-bad">
          {t('rootFiles.loadFailed')}
        </p>
      ) : null}
      {list.data ? (
        list.data.length ? (
          <ul aria-label={t('rootFiles.title')} className="divide-y divide-line rounded-ctl border border-line">
            {list.data.map((f) => (
              <li key={f.filename} className="flex items-center justify-between gap-2 p-2 text-sm">
                <span>
                  <span className="font-mono">/{f.filename}</span> <span className="text-dim">{t('rootFiles.size', { count: f.size })}</span>
                </span>
                <span className="flex gap-2">
                  <button type="button" className="underline" onClick={() => void edit(f.filename)}>
                    {t('rootFiles.edit')}
                  </button>
                  <button type="button" aria-label={t('rootFiles.delete', { name: f.filename })} className="text-bad" onClick={() => remove.mutate(f.filename)}>
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </button>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-dim">{t('rootFiles.empty')}</p>
        )
      ) : null}
      {remove.isError ? (
        <p role="alert" className="text-sm text-bad">
          {messageOf(remove.error, t('rootFiles.deleteFailed'))}
        </p>
      ) : null}

      <form
        aria-label={editing ? t('rootFiles.editName', { name: editing }) : t('rootFiles.add')}
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <h2 className="text-sm font-semibold">{editing ? t('rootFiles.editName', { name: editing }) : t('rootFiles.add')}</h2>
        <div className="space-y-1">
          <label htmlFor={ids.name} className="text-sm font-medium">
            {t('rootFiles.name')}
          </label>
          <input id={ids.name} required readOnly={!!editing} placeholder={t('rootFiles.namePlaceholder')} value={filename} onChange={(e) => setFilename(e.target.value)} className={inputClass} />
        </div>
        <div className="space-y-1">
          <label htmlFor={ids.content} className="text-sm font-medium">
            {t('rootFiles.content')}
          </label>
          <textarea id={ids.content} rows={8} value={content} onChange={(e) => setContent(e.target.value)} className="w-full rounded-ctl border border-line bg-bg px-2.5 py-1.5 text-[13px] outline-none focus:border-brand font-mono" />
        </div>
        {save.isError ? (
          <p role="alert" className="text-sm text-bad">
            {messageOf(save.error, t('rootFiles.saveFailed'))}
          </p>
        ) : null}
        <button type="submit" disabled={save.isPending} className="inline-flex items-center gap-1 rounded-ctl bg-brand px-3 py-1.5 text-[13px] text-brand-fg">
          <Save className="h-4 w-4" aria-hidden="true" />
          {t('common:save')}
        </button>
      </form>
    </div>
  );
}
