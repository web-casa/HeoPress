import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { HeoPressError } from '@heopress/sdk';
import { Link2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useId, useState } from 'react';
import { getApiClient } from '@/lib/api';

/**
 * Links — the site's broken internal links and orphan pages (HeoPress P07 tasks 5.3, 5.4; spec seo/link-graph).
 *
 * A broken link opens its page in the editor; an orphan page shows what still reaches it (the site's lists, registered
 * navigation links) apart from links in other pages' text. Administrators can scan the whole site now and register the
 * navigation the content does not hold (a theme's menu, a footer).
 */

const REASON: Record<string, string> = { missing: 'no such page', unpublished: 'unpublished', deleted: 'deleted' };
const inputClass = 'h-9 w-full rounded-md border border-border bg-background px-2 text-sm';

function messageOf(err: unknown, fallback: string): string {
  if (err instanceof HeoPressError) {
    const first = (err.body as { errors?: Array<{ message?: string }> })?.errors?.[0];
    if (first?.message) return first.message;
  }
  return fallback;
}

export function LinkReportPage() {
  const client = getApiClient();
  const qc = useQueryClient();
  const report = useQuery({ queryKey: ['site-links'], queryFn: async () => (await client.site.linkReport()).data });
  const manual = useQuery({ queryKey: ['site-links-manual'], queryFn: async () => (await client.site.manualLinks()).data, retry: false });
  const isAdmin = !(manual.error instanceof HeoPressError && manual.error.status === 403);
  const scan = useMutation({ mutationFn: async () => (await client.site.scanLinks()).data, onSuccess: () => qc.invalidateQueries({ queryKey: ['site-links'] }) });
  const [label, setLabel] = useState('');
  const [url, setUrl] = useState('');
  const ids = { label: useId(), url: useId() };
  const add = useMutation({
    mutationFn: async () => (await client.site.addManualLink({ label, url })).data,
    onSuccess: async () => {
      setLabel('');
      setUrl('');
      await qc.invalidateQueries({ queryKey: ['site-links-manual'] });
      await qc.invalidateQueries({ queryKey: ['site-links'] });
    },
  });
  const remove = useMutation({
    mutationFn: async (id: string) => (await client.site.deleteManualLink(id)).data,
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['site-links-manual'] });
      await qc.invalidateQueries({ queryKey: ['site-links'] });
    },
  });
  const data = report.data;

  return (
    <div className="max-w-4xl space-y-6">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <Link2 className="h-5 w-5" aria-hidden="true" />
          Links
        </h1>
        <p className="text-sm text-muted-foreground">
          Links between your published pages: those that lead nowhere, and pages no other page links to. Only pages you may read are shown.
        </p>
      </header>

      <section aria-label="Scan" className="flex flex-wrap items-center gap-3 text-sm">
        <span>
          {data?.scan
            ? data.scan.status === 'running'
              ? `Scanning… ${data.scan.processed} pages so far`
              : `Last full scan ${data.scan.finishedAt ? new Date(data.scan.finishedAt).toLocaleString() : ''}`
            : 'Not scanned yet'}
        </span>
        {isAdmin ? (
          <button type="button" className="inline-flex h-8 items-center gap-1 rounded-md border border-border px-2" onClick={() => scan.mutate()} disabled={scan.isPending}>
            <RefreshCw className="h-4 w-4" aria-hidden="true" /> Scan now
          </button>
        ) : null}
        {data?.truncated ? <span role="note">The report reached a limit: it may be incomplete.</span> : null}
      </section>

      {report.isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
      {report.isError ? (
        <p role="alert" className="text-sm text-destructive">
          The report could not be loaded.
        </p>
      ) : null}

      {data ? (
        <section aria-labelledby="broken-heading" className="space-y-2">
          <h2 id="broken-heading" className="font-medium">
            Broken links ({data.brokenTotal})
          </h2>
          {data.broken.length ? (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-1">On</th>
                  <th>Link</th>
                  <th>Why</th>
                </tr>
              </thead>
              <tbody>
                {data.broken.map((b, i) => (
                  <tr key={`${b.href}:${i}`} className="border-t border-border">
                    <td className="py-1">
                      {b.source.kind === 'item' ? (
                        <Link to="/content/$collection/$id" params={{ collection: b.source.collection, id: b.source.itemId }} className="underline">
                          {b.source.title || b.source.itemId}
                        </Link>
                      ) : (
                        <>Navigation: {b.source.label}</>
                      )}
                    </td>
                    <td>
                      <span className="font-mono">{b.href}</span> {b.anchorText ? <span className="text-muted-foreground">“{b.anchorText}”</span> : null}
                    </td>
                    <td>{REASON[b.reason] ?? b.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-sm">No broken links.</p>
          )}
        </section>
      ) : null}

      {data ? (
        <section aria-labelledby="orphans-heading" className="space-y-2">
          <h2 id="orphans-heading" className="font-medium">
            Pages no other page links to ({data.orphansTotal})
          </h2>
          {data.orphans.length ? (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-1">Page</th>
                  <th>On the site&apos;s lists</th>
                  <th>Navigation links</th>
                </tr>
              </thead>
              <tbody>
                {data.orphans.map((o) => (
                  <tr key={o.itemId} className="border-t border-border">
                    <td className="py-1">
                      <Link to="/content/$collection/$id" params={{ collection: o.collection, id: o.itemId }} className="underline">
                        {o.title || o.itemId}
                      </Link>
                    </td>
                    <td>{o.listing ? 'Yes' : 'No'}</td>
                    <td>{o.navigation}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-sm">Every page has a link from another page.</p>
          )}
        </section>
      ) : null}

      {isAdmin && manual.data ? (
        <section aria-labelledby="nav-heading" className="space-y-2">
          <h2 id="nav-heading" className="font-medium">
            Registered navigation links
          </h2>
          <p className="text-sm text-muted-foreground">Links your theme&apos;s menus or footer hold, which the content does not: counted apart for orphan pages.</p>
          {manual.data.length ? (
            <ul aria-label="Registered links" className="divide-y divide-border rounded-md border border-border">
              {manual.data.map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-2 p-2 text-sm">
                  <span>
                    {m.label} · <span className="font-mono">{m.url}</span>
                  </span>
                  <button type="button" aria-label={`Remove ${m.label}`} className="rounded p-1 hover:bg-muted" onClick={() => remove.mutate(m.id)}>
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <form
            className="grid gap-2 sm:grid-cols-[1fr_2fr_auto] sm:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              add.mutate();
            }}
          >
            <div>
              <label htmlFor={ids.label} className="text-sm">
                Where
              </label>
              <input id={ids.label} className={inputClass} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Header menu" />
            </div>
            <div>
              <label htmlFor={ids.url} className="text-sm">
                Address
              </label>
              <input id={ids.url} className={inputClass} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/about/" />
            </div>
            <button type="submit" className="inline-flex h-9 items-center gap-1 rounded-md border border-border px-3 text-sm" disabled={add.isPending || !label.trim() || !url.trim()}>
              <Plus className="h-4 w-4" aria-hidden="true" /> Add
            </button>
          </form>
          {add.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {messageOf(add.error, 'The link could not be added.')}
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
