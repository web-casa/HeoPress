import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { HeoPressError } from '@heopress/sdk';
import { FileText, Save, Trash2 } from 'lucide-react';
import { useId, useState } from 'react';
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

const inputClass = 'h-9 w-full rounded-md border border-border bg-background px-2 text-sm';

export function RootFilesPage() {
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
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <FileText className="h-5 w-5" aria-hidden="true" />
          Root files
        </h1>
        <p className="text-sm text-muted-foreground">
          Files served at your site&apos;s root, such as a search engine verification file or <code>ads.txt</code>. Text only (.txt, .html, .htm, .xml, .json,
          .webmanifest), at most 512 KB. Files the system makes, such as <code>robots.txt</code> and the sitemaps, cannot be replaced.
        </p>
      </header>

      {list.isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
      {list.isError ? (
        <p role="alert" className="text-sm text-destructive">
          The root files could not be loaded.
        </p>
      ) : null}
      {list.data ? (
        list.data.length ? (
          <ul aria-label="Root files" className="divide-y divide-border rounded-md border border-border">
            {list.data.map((f) => (
              <li key={f.filename} className="flex items-center justify-between gap-2 p-2 text-sm">
                <span>
                  <span className="font-mono">/{f.filename}</span> <span className="text-muted-foreground">· {f.size} bytes</span>
                </span>
                <span className="flex gap-2">
                  <button type="button" className="underline" onClick={() => void edit(f.filename)}>
                    Edit
                  </button>
                  <button type="button" aria-label={`Delete ${f.filename}`} className="text-destructive" onClick={() => remove.mutate(f.filename)}>
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </button>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No root files yet.</p>
        )
      ) : null}
      {remove.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {messageOf(remove.error, 'The file could not be deleted.')}
        </p>
      ) : null}

      <form
        aria-label={editing ? `Edit ${editing}` : 'Add a root file'}
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <h2 className="text-sm font-semibold">{editing ? `Edit ${editing}` : 'Add a root file'}</h2>
        <div className="space-y-1">
          <label htmlFor={ids.name} className="text-sm font-medium">
            Name
          </label>
          <input id={ids.name} required readOnly={!!editing} placeholder="google0123456789abcdef.html" value={filename} onChange={(e) => setFilename(e.target.value)} className={inputClass} />
        </div>
        <div className="space-y-1">
          <label htmlFor={ids.content} className="text-sm font-medium">
            Content
          </label>
          <textarea id={ids.content} rows={8} value={content} onChange={(e) => setContent(e.target.value)} className="w-full rounded-md border border-border bg-background p-2 font-mono text-sm" />
        </div>
        {save.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {messageOf(save.error, 'The file could not be saved.')}
          </p>
        ) : null}
        <button type="submit" disabled={save.isPending} className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground">
          <Save className="h-4 w-4" aria-hidden="true" />
          Save
        </button>
      </form>
    </div>
  );
}
