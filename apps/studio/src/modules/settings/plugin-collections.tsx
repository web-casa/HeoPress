// Plugin collections and route conflicts on the Extensions page (HeoPress P12 tasks 2.1, 2.2).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Database, Download, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { getApiClient } from '@/lib/api';
import type { ExtensionRouteConflict, PluginCollectionResource } from '@heopress/sdk';
import { apiErrorMessage } from './extension-permissions';

/** The route conflicts a refused enable or install carries (`ROUTE_CONFLICT`), if any. */
function routeConflictsOf(error: unknown): ExtensionRouteConflict[] {
  const first = (error as { body?: { errors?: Array<{ code?: string; details?: { conflicts?: unknown } }> } } | null)?.body?.errors?.[0];
  return first?.code === 'ROUTE_CONFLICT' && Array.isArray(first.details?.conflicts) ? (first.details.conflicts as ExtensionRouteConflict[]) : [];
}

/** Why a plugin could not be enabled: the message, and each conflicting path with what already answers it. */
export function ExtensionErrorNotice({ error }: { error: unknown }) {
  const { t } = useTranslation('system');
  if (!error) return null;
  const conflicts = routeConflictsOf(error);
  return (
    <div className="mt-3 rounded-ctl border border-bad bg-bad-soft p-2 text-sm" role="alert" data-testid="extension-error">
      <p>{conflicts.length ? t('extensions.routeConflicts', { count: conflicts.length }) : apiErrorMessage(error)}</p>
      {conflicts.length > 0 && (
        <ul className="mt-1 space-y-0.5 font-mono text-xs">
          {conflicts.map((c) => (
            <li key={`${c.route}:${c.path}:${c.reason}`}>
              {c.path} — {t(`extensions.conflictReason.${c.reason}`)}{c.with ? ` (${c.with})` : ''}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function download(namespace: string, body: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(body, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${namespace}-collections.json`;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * The site's plugin collections by namespace: their data stays while the plugin is off. Deleting it for good needs the
 * plugin disabled, a fresh export (downloaded here) and the namespace typed as confirmation.
 */
export function PluginCollections() {
  const { t } = useTranslation('system');
  const client = getApiClient();
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ['extensions', 'collections'], queryFn: async () => (await client.extensions.collections()).data });
  const [digests, setDigests] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState<{ namespace: string; typed: string } | null>(null);

  const exportMutation = useMutation({
    mutationFn: async (namespace: string) => (await client.extensions.exportCollections(namespace)).data,
    onSuccess: (data) => {
      download(data.namespace, data);
      setDigests((d) => ({ ...d, [data.namespace]: data.digest }));
      void qc.invalidateQueries({ queryKey: ['extensions', 'collections'] });
    },
  });
  const purgeMutation = useMutation({
    mutationFn: ({ namespace, confirm }: { namespace: string; confirm: string }) =>
      client.extensions.purgeCollections(namespace, { confirm, exportDigest: digests[namespace] ?? '' }),
    onSuccess: () => {
      setConfirming(null);
      void qc.invalidateQueries({ queryKey: ['extensions', 'collections'] });
    },
  });

  const rows = query.data ?? [];
  if (!rows.length) return null;
  const byNamespace = new Map<string, PluginCollectionResource[]>();
  for (const r of rows) byNamespace.set(r.namespace, [...(byNamespace.get(r.namespace) ?? []), r]);

  return (
    <section className="rounded-card border border-line bg-panel p-4" aria-label={t('extensions.collections.title')} data-testid="plugin-collections">
      <h2 className="flex items-center gap-2 text-sm font-semibold"><Database className="h-4 w-4" />{t('extensions.collections.title')}</h2>
      <p className="mt-1 text-xs text-dim">{t('extensions.collections.description')}</p>
      <ul className="mt-3 divide-y divide-line">
        {[...byNamespace].map(([namespace, list]) => (
          <li key={namespace} className="py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="font-mono text-sm">{namespace}</p>
                <p className="text-xs text-dim">
                  {list.map((c) => t('extensions.collections.entry', { name: `${c.namespace}.${c.name.slice(c.namespace.length + 2)}`, count: c.items })).join(' · ')}
                </p>
                <p className="text-xs text-dim">
                  {list[0]!.export ? t('extensions.collections.lastExport', { at: list[0]!.export.at.slice(0, 16).replace('T', ' ') }) : t('extensions.collections.neverExported')}
                </p>
              </div>
              <div className="flex gap-3 text-sm">
                <button type="button" className="inline-flex items-center gap-1 font-medium text-brand hover:underline" onClick={() => exportMutation.mutate(namespace)}>
                  <Download className="h-4 w-4" />{t('extensions.collections.export')}
                </button>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 font-medium text-bad hover:underline disabled:opacity-50"
                  disabled={!digests[namespace]}
                  title={digests[namespace] ? undefined : t('extensions.collections.exportFirst')}
                  onClick={() => { purgeMutation.reset(); setConfirming({ namespace, typed: '' }); }}
                >
                  <Trash2 className="h-4 w-4" />{t('extensions.collections.delete')}
                </button>
              </div>
            </div>
            {confirming?.namespace === namespace && (
              <form
                className="mt-2 space-y-2 rounded-ctl border border-bad p-2 text-sm"
                onSubmit={(e) => { e.preventDefault(); purgeMutation.mutate({ namespace, confirm: confirming.typed }); }}
              >
                <label className="block text-xs text-dim">
                  {t('extensions.collections.confirmPrompt', { namespace })}
                  <input
                    className="mt-1 w-full rounded-ctl border border-line bg-panel px-3 py-1.5 font-mono text-sm outline-none focus:border-brand"
                    value={confirming.typed}
                    onChange={(e) => setConfirming({ namespace, typed: e.target.value })}
                  />
                </label>
                {purgeMutation.error && <p className="text-bad">{apiErrorMessage(purgeMutation.error)}</p>}
                <div className="flex gap-3">
                  <button type="submit" className="font-medium text-bad hover:underline disabled:opacity-50" disabled={confirming.typed !== namespace || purgeMutation.isPending}>
                    {t('extensions.collections.deleteForGood')}
                  </button>
                  <button type="button" className="text-dim hover:underline" onClick={() => setConfirming(null)}>{t('extensions.collections.cancel')}</button>
                </div>
              </form>
            )}
          </li>
        ))}
      </ul>
      {exportMutation.error && <p className="mt-2 text-sm text-bad">{apiErrorMessage(exportMutation.error)}</p>}
    </section>
  );
}
