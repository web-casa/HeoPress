import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { HeoPressError } from '@heopress/sdk';
import { Link2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '@/workspace/ui/page-header';
import { getApiClient } from '@/lib/api';

/**
 * Links — the site's broken internal links and orphan pages (HeoPress P07 tasks 5.3, 5.4; spec seo/link-graph).
 *
 * A broken link opens its page in the editor; an orphan page shows what still reaches it (the site's lists, registered
 * navigation links) apart from links in other pages' text. Administrators can scan the whole site now and register the
 * navigation the content does not hold (a theme's menu, a footer).
 */

const REASON: Record<string, string> = { missing: 'links.reason.missing', unpublished: 'links.reason.unpublished', deleted: 'links.reason.deleted' };
const inputClass = 'w-full rounded-ctl border border-line bg-bg px-2.5 py-1.5 text-[13px] outline-none focus:border-brand';

function messageOf(err: unknown, fallback: string): string {
  if (err instanceof HeoPressError) {
    const first = (err.body as { errors?: Array<{ message?: string }> })?.errors?.[0];
    if (first?.message) return first.message;
  }
  return fallback;
}

export function LinkReportPage() {
  const { t } = useTranslation('siteOps');
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
    <div className="space-y-6">
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <Link2 className="h-5 w-5" aria-hidden="true" />
            {t('links.title')}
          </span>
        }
        description={t('links.description')}
      />

      <section aria-label={t('links.scan')} className="flex flex-wrap items-center gap-3 text-sm">
        <span>
          {data?.scan
            ? data.scan.status === 'running'
              ? t('links.scanning', { count: data.scan.processed })
              : t('links.lastScan', { date: data.scan.finishedAt ? new Date(data.scan.finishedAt).toLocaleString() : '' })
            : t('links.notScanned')}
        </span>
        {isAdmin ? (
          <button type="button" className="inline-flex h-8 items-center gap-1 rounded-ctl border border-line px-2 hover:bg-panel-2" onClick={() => scan.mutate()} disabled={scan.isPending}>
            <RefreshCw className="h-4 w-4" aria-hidden="true" /> {t('links.scanNow')}
          </button>
        ) : null}
        {data?.truncated ? <span role="note">{t('links.truncated')}</span> : null}
      </section>

      {report.isLoading ? <p className="text-sm text-dim">{t('common:loading')}</p> : null}
      {report.isError ? (
        <p role="alert" className="text-sm text-bad">
          {t('reachability.loadFailed')}
        </p>
      ) : null}

      {data ? (
        <section aria-labelledby="broken-heading" className="space-y-2">
          <h2 id="broken-heading" className="font-medium">
            {t('links.broken', { count: data.brokenTotal })}
          </h2>
          {data.broken.length ? (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-dim">
                  <th className="py-1">{t('links.col.on')}</th>
                  <th>{t('links.col.link')}</th>
                  <th>{t('links.col.why')}</th>
                </tr>
              </thead>
              <tbody>
                {data.broken.map((b, i) => (
                  <tr key={`${b.href}:${i}`} className="border-t border-line">
                    <td className="py-1">
                      {b.source.kind === 'item' ? (
                        <Link to="/content/$collection/$id" params={{ collection: b.source.collection, id: b.source.itemId }} className="underline">
                          {b.source.title || b.source.itemId}
                        </Link>
                      ) : (
                        <>{t('links.navigation', { label: b.source.label })}</>
                      )}
                    </td>
                    <td>
                      <span className="font-mono">{b.href}</span> {b.anchorText ? <span className="text-dim">“{b.anchorText}”</span> : null}
                    </td>
                    <td>{t(REASON[b.reason] ?? 'links.reason.other', { reason: b.reason })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-sm">{t('links.noBroken')}</p>
          )}
        </section>
      ) : null}

      {data ? (
        <section aria-labelledby="orphans-heading" className="space-y-2">
          <h2 id="orphans-heading" className="font-medium">
            {t('links.orphans', { count: data.orphansTotal })}
          </h2>
          {data.orphans.length ? (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-dim">
                  <th className="py-1">{t('links.col.page')}</th>
                  <th>{t('links.col.listing')}</th>
                  <th>{t('links.col.navigation')}</th>
                </tr>
              </thead>
              <tbody>
                {data.orphans.map((o) => (
                  <tr key={o.itemId} className="border-t border-line">
                    <td className="py-1">
                      <Link to="/content/$collection/$id" params={{ collection: o.collection, id: o.itemId }} className="underline">
                        {o.title || o.itemId}
                      </Link>
                    </td>
                    <td>{o.listing ? t('links.yes') : t('links.no')}</td>
                    <td>{o.navigation}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-sm">{t('links.noOrphans')}</p>
          )}
        </section>
      ) : null}

      {isAdmin && manual.data ? (
        <section aria-labelledby="nav-heading" className="space-y-2">
          <h2 id="nav-heading" className="font-medium">
            {t('links.registered')}
          </h2>
          <p className="text-sm text-dim">{t('links.registeredHelp')}</p>
          {manual.data.length ? (
            <ul aria-label={t('links.registeredLinks')} className="divide-y divide-line rounded-ctl border border-line">
              {manual.data.map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-2 p-2 text-sm">
                  <span>
                    {m.label} · <span className="font-mono">{m.url}</span>
                  </span>
                  <button type="button" aria-label={t('links.removeLink', { label: m.label })} className="rounded p-1 hover:bg-panel-2" onClick={() => remove.mutate(m.id)}>
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
                {t('links.where')}
              </label>
              <input id={ids.label} className={inputClass} value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t('links.wherePlaceholder')} />
            </div>
            <div>
              <label htmlFor={ids.url} className="text-sm">
                {t('links.address')}
              </label>
              <input id={ids.url} className={inputClass} value={url} onChange={(e) => setUrl(e.target.value)} placeholder={t('links.addressPlaceholder')} />
            </div>
            <button type="submit" className="inline-flex h-9 items-center gap-1 rounded-ctl border border-line px-3 text-[13px] hover:bg-panel-2" disabled={add.isPending || !label.trim() || !url.trim()}>
              <Plus className="h-4 w-4" aria-hidden="true" /> {t('links.add')}
            </button>
          </form>
          {add.isError ? (
            <p role="alert" className="text-sm text-bad">
              {messageOf(add.error, t('links.addFailed'))}
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
