import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { TranslationGroupResource } from '@heopress/sdk';
import { AlertTriangle, Languages, Lock, Plus, Star, Trash2 } from 'lucide-react';
import { useId, useState } from 'react';
import i18n from 'i18next';
import { useTranslation } from 'react-i18next';
import { getActiveSite, getApiClient } from '@/lib/api';

/**
 * Translation group panel of the item editor (HeoPress P05 task 4.3; spec
 * i18n/translation-groups; design D "Studio"): the language versions of the
 * item, each with its language, role and status; members of another site
 * the editor may not read appear only as their public address, or not at
 * all. Editors of every site involved can add an item (of this site, or of
 * another site by its site ID), make a member the source, mark the source
 * internal-only, or take a member out. Every change names the group version
 * shown, so a change made meanwhile is reported rather than overwritten.
 * Above it, the translation state of each language of the site (computed:
 * missing, draft, in review, published, stale); an editor can start a new
 * translation draft in a language (the source's SEO fields copied, never its
 * canonical URL). Shared fields waiting to sync from the source are marked; one blocked
 * there (no permission, or on hold) can be applied by an editor of the
 * member's site.
 */

const errorText = (err: unknown) => (err instanceof Error ? err.message : i18n.t('items:translation.changeFailed'));

const STATE_STYLE = {
  missing: 'bg-slate-100 text-slate-600',
  draft: 'bg-slate-200 text-slate-800',
  in_review: 'bg-amber-100 text-amber-800',
  published: 'bg-emerald-100 text-emerald-800',
  stale: 'bg-rose-100 text-rose-800',
} as const;

export function TranslationGroupPanel({ collection, itemId, canUpdate }: { collection: string; itemId: string; canUpdate: boolean }) {
  const { t } = useTranslation('items');
  const client = getApiClient();
  const qc = useQueryClient();
  const site = getActiveSite();
  const ids = { item: useId(), site: useId(), locale: useId() };
  const [draftLocale, setDraftLocale] = useState('');
  const [newItem, setNewItem] = useState('');
  const [newSite, setNewSite] = useState('');
  const [error, setError] = useState<string | null>(null);

  const key = ['translation-group', itemId];
  const query = useQuery({
    queryKey: key,
    queryFn: async () => (await client.translationGroups.forItem(itemId)).data,
  });
  const group = query.data ?? null;
  const statusQuery = useQuery({
    queryKey: ['translation-status', collection, itemId],
    queryFn: async () => (await client.translationGroups.status(collection, itemId)).data,
  });

  const change = useMutation({
    mutationFn: async (run: () => Promise<{ data: TranslationGroupResource | null }>) => (await run()).data,
    onMutate: () => setError(null),
    onSuccess: () => {
      setNewItem('');
      setNewSite('');
      setDraftLocale('');
      void qc.invalidateQueries({ queryKey: key });
      void qc.invalidateQueries({ queryKey: ['translation-status', collection, itemId] });
    },
    onError: (err) => {
      setError(errorText(err));
      void qc.invalidateQueries({ queryKey: key });
    },
  });

  if (query.isError) {
    return (
      <p role="alert" className="flex items-center gap-2 rounded-md bg-rose-50 p-2 text-sm text-rose-800">
        <AlertTriangle className="h-4 w-4" aria-hidden /> {t('translation.loadFailed')}
      </p>
    );
  }
  if (query.isLoading) return <p className="text-sm text-muted-foreground">{t('translation.loading')}</p>;

  return (
    <section aria-labelledby="translation-group-heading" className="space-y-3">
      <h2 id="translation-group-heading" className="flex items-center gap-2 text-sm font-semibold">
        <Languages className="h-4 w-4" aria-hidden /> {t('translation.heading')}
      </h2>
      {error && (
        <p role="alert" className="flex items-center gap-2 rounded-md bg-rose-50 p-2 text-sm text-rose-800">
          <AlertTriangle className="h-4 w-4" aria-hidden /> {error}
        </p>
      )}
      {statusQuery.data && (
        <ul aria-label={t('translation.statusLabel')} className="flex flex-wrap gap-2 text-xs">
          {statusQuery.data.locales.map((l) => (
            <li key={l.locale} data-testid={`status-${l.locale}`} className={`rounded px-2 py-0.5 ${STATE_STYLE[l.state]}`}>
              <span className="font-mono">{l.locale}</span> {t(`translation.state.${l.state}`)}
            </li>
          ))}
        </ul>
      )}
      {!group ? (
        <div className="space-y-2 text-sm">
          <p className="text-muted-foreground">{t('translation.noGroup')}</p>
          {canUpdate && (
            <button
              type="button"
              onClick={() => change.mutate(() => client.translationGroups.create(itemId))}
              disabled={change.isPending}
              className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm disabled:opacity-50"
            >
              <Plus className="h-4 w-4" aria-hidden /> {t('translation.startGroup')}
            </button>
          )}
        </div>
      ) : (
        <>
          <table className="w-full text-sm" aria-label={t('translation.members')}>
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="py-1 font-medium">{t('translation.col.language')}</th>
                <th className="py-1 font-medium">{t('translation.col.item')}</th>
                <th className="py-1 font-medium">{t('translation.col.status')}</th>
                <th className="py-1 font-medium">
                  <span className="sr-only">{t('translation.col.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {group.members.map((m) => (
                <tr key={m.itemId} className="border-t" data-testid={`member-${m.locale}`}>
                  <td className="py-1.5 font-mono text-xs">{m.locale}</td>
                  <td className="py-1.5">
                    {m.siteId === site ? (
                      <Link to="/content/$collection/$id" params={{ collection: m.collection, id: m.itemId }} className="hover:underline">
                        {m.title ?? m.itemId}
                      </Link>
                    ) : (
                      <span>
                        {m.title ?? m.itemId} <span className="text-xs text-muted-foreground">{t('translation.siteSuffix', { site: m.siteId })}</span>
                      </span>
                    )}
                    {m.role === 'source' && (
                      <span className="ml-2 inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 text-xs text-amber-800">
                        <Star className="h-3 w-3" aria-hidden /> {t('translation.source')}
                      </span>
                    )}
                    {m.internalOnly && (
                      <span className="ml-2 inline-flex items-center gap-1 rounded bg-slate-100 px-1.5 text-xs text-slate-700">
                        <Lock className="h-3 w-3" aria-hidden /> {t('translation.internalOnly')}
                      </span>
                    )}
                    {m.itemId === itemId && <span className="ml-2 text-xs text-muted-foreground">{t('translation.thisItem')}</span>}
                    {m.sharedSync && (
                      <span className="ml-2 inline-flex items-center gap-1 rounded bg-sky-100 px-1.5 text-xs text-sky-800" data-testid="shared-sync">
                        {m.sharedSync.status === 'blocked_hold'
                          ? t('translation.sharedSyncHold', { fields: m.sharedSync.fields.join(', ') })
                          : m.sharedSync.status === 'blocked_permission'
                            ? t('translation.sharedSyncPermission', { fields: m.sharedSync.fields.join(', ') })
                            : t('translation.sharedSync', { fields: m.sharedSync.fields.join(', ') })}
                      </span>
                    )}
                  </td>
                  <td className="py-1.5 text-xs">{m.status}</td>
                  <td className="py-1.5 text-right">
                    {canUpdate && (
                      <span className="inline-flex gap-1">
                        {m.sharedSync && m.sharedSync.status !== 'pending' && (
                          <button
                            type="button"
                            onClick={() => change.mutate(async () => {
                              await client.translationGroups.applyShared(group.id, m.itemId);
                              return client.translationGroups.get(group.id);
                            })}
                            className="rounded border px-1.5 py-0.5 text-xs"
                          >
                            {t('translation.applyShared')}
                          </button>
                        )}
                        {m.role !== 'source' && (
                          <button
                            type="button"
                            onClick={() => change.mutate(() => client.translationGroups.setSource(group.id, m.itemId, group.version))}
                            className="rounded border px-1.5 py-0.5 text-xs"
                          >
                            {t('translation.makeSource')}
                          </button>
                        )}
                        {m.role === 'source' && (
                          <button
                            type="button"
                            onClick={() => change.mutate(() => client.translationGroups.setInternalOnly(group.id, m.itemId, !m.internalOnly, group.version))}
                            className="rounded border px-1.5 py-0.5 text-xs"
                          >
                            {m.internalOnly ? t('translation.allowPublishing') : t('translation.setInternalOnly')}
                          </button>
                        )}
                        <button
                          type="button"
                          aria-label={t('translation.removeMember', { locale: m.locale })}
                          onClick={() => change.mutate(() => client.translationGroups.removeMember(group.id, m.itemId, group.version))}
                          className="rounded border px-1.5 py-0.5 text-xs"
                        >
                          <Trash2 className="h-3 w-3" aria-hidden />
                        </button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
              {group.public.map((p) => (
                <tr key={p.url} className="border-t text-muted-foreground">
                  <td className="py-1.5 font-mono text-xs">{p.locale}</td>
                  <td className="py-1.5 text-xs" colSpan={3}>
                    <a href={p.url} className="hover:underline" rel="noreferrer" target="_blank">
                      {p.url}
                    </a>{' '}
                    {t('translation.otherSitePublished')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {canUpdate && (
            <form
              className="flex flex-wrap items-end gap-2 border-t pt-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (!newItem.trim()) return;
                change.mutate(() =>
                  client.translationGroups.addMember(group.id, {
                    itemId: newItem.trim(),
                    ...(newSite.trim() ? { siteId: newSite.trim() } : {}),
                    expectedVersion: group.version,
                  }),
                );
              }}
            >
              <label htmlFor={ids.item} className="text-xs">
                {t('translation.itemId')}
                <input id={ids.item} value={newItem} onChange={(e) => setNewItem(e.target.value)} className="mt-1 block rounded-md border bg-background px-2 py-1 font-mono text-xs" />
              </label>
              <label htmlFor={ids.site} className="text-xs">
                {t('translation.siteId')}
                <input id={ids.site} value={newSite} onChange={(e) => setNewSite(e.target.value)} className="mt-1 block rounded-md border bg-background px-2 py-1 font-mono text-xs" />
              </label>
              <button type="submit" disabled={change.isPending || !newItem.trim()} className="inline-flex items-center gap-1 rounded-md border px-3 py-1 text-sm disabled:opacity-50">
                <Plus className="h-4 w-4" aria-hidden /> {t('translation.addToGroup')}
              </button>
            </form>
          )}
          {canUpdate && (
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (!draftLocale.trim()) return;
                change.mutate(async () => ({ data: (await client.translationGroups.createDraft(group.id, draftLocale.trim())).data.group }));
              }}
            >
              <label htmlFor={ids.locale} className="text-xs">
                {t('translation.newDraft')}
                <input id={ids.locale} value={draftLocale} onChange={(e) => setDraftLocale(e.target.value)} placeholder={t('translation.localePlaceholder')} className="mt-1 block rounded-md border bg-background px-2 py-1 font-mono text-xs" />
              </label>
              <button type="submit" disabled={change.isPending || !draftLocale.trim()} className="inline-flex items-center gap-1 rounded-md border px-3 py-1 text-sm disabled:opacity-50">
                <Plus className="h-4 w-4" aria-hidden /> {t('translation.createDraft')}
              </button>
            </form>
          )}
          <p className="text-xs text-muted-foreground">
            {t('translation.footer', { collection, version: group.version })}
          </p>
        </>
      )}
    </section>
  );
}
