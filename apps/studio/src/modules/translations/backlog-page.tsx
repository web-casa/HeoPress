import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useState } from 'react';
import { getApiClient } from '@/lib/api';
import { PageHeader } from '@/workspace/ui/page-header';

/**
 * The translation backlog (v1.1; spec i18n/translation-backlog): the published items whose translation into the chosen
 * language is missing, stale or in review, in three columns. "Create translation" calls the group's drafts endpoint
 * (`createDraft` copies the source's title, slug and SEO fields into a draft); a row without a group says so instead of
 * creating a group behind the operator's back.
 */

type BacklogState = 'missing' | 'stale' | 'in_review';

interface BacklogItem {
  itemId: string;
  groupId: string | null;
  title: string;
  slug: string | null;
  state: BacklogState;
  updatedAt: string | null;
}

interface Backlog {
  locale: string;
  counts: Record<BacklogState, number>;
  items: BacklogItem[];
  truncated: boolean;
}

const COLUMNS: BacklogState[] = ['missing', 'stale', 'in_review'];

export function TranslationBacklogPage() {
  const { t } = useTranslation('backlog');
  const client = getApiClient();
  const qc = useQueryClient();
  const [collection, setCollection] = useState('articles');
  const [locale, setLocale] = useState('');

  const collections = useQuery({
    queryKey: ['collections', 'names'],
    queryFn: async () => (await client.schema.collections.list()).data.map((c) => c.name),
  });
  const locales = useQuery({
    queryKey: ['settings', 'locales'],
    queryFn: async () => {
      try {
        const res = await client.settings.get('locales');
        const value = res.data as { value?: { supported?: string[] } } | undefined;
        return value?.value?.supported ?? [];
      } catch {
        return [];
      }
    },
  });

  const target = locale || locales.data?.[0] || '';
  const backlog = useQuery({
    queryKey: ['translation-backlog', collection, target],
    enabled: Boolean(target),
    queryFn: async () => {
      const res = await client.request<Backlog>(
        `/api/v1/translation-groups/backlog?collection=${encodeURIComponent(collection)}&locale=${encodeURIComponent(target)}`,
      );
      return res.data;
    },
  });

  const create = useMutation({
    mutationFn: async (item: BacklogItem) => {
      if (!item.groupId) throw new Error(t('backlog.noGroup'));
      await client.request(`/api/v1/translation-groups/${item.groupId}/drafts`, {
        method: 'POST',
        body: JSON.stringify({ locale: target }),
      });
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['translation-backlog', collection, target] }),
  });

  const items = backlog.data?.items ?? [];
  const counts = backlog.data?.counts;

  return (
    <div className="space-y-6">
      <PageHeader title={t('backlog.title')} description={t('backlog.description')} />
      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('backlog.collection')}</span>
          <select
            className="rounded-md border border-input bg-background px-3 py-2"
            value={collection}
            onChange={(e) => setCollection(e.target.value)}
          >
            {(collections.data ?? []).map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('backlog.locale')}</span>
          <select
            className="rounded-md border border-input bg-background px-3 py-2"
            value={target}
            onChange={(e) => setLocale(e.target.value)}
          >
            {(locales.data ?? []).map((tag) => (
              <option key={tag} value={tag}>
                {tag}
              </option>
            ))}
          </select>
        </label>
      </div>

      {backlog.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {t('backlog.failed')}
        </p>
      ) : null}
      {backlog.data?.truncated ? <p className="text-sm text-muted-foreground">{t('backlog.truncated')}</p> : null}

      <div className="grid gap-4 md:grid-cols-3">
        {COLUMNS.map((state) => (
          <section key={state} aria-label={t(`backlog.columns.${state}`)} className="rounded-lg border border-border">
            <header className="flex items-center justify-between border-b border-border px-3 py-2">
              <h2 className="text-sm font-medium">{t(`backlog.columns.${state}`)}</h2>
              <span data-testid={`backlog-count-${state}`} className="text-sm text-muted-foreground">
                {counts?.[state] ?? 0}
              </span>
            </header>
            <ul className="divide-y divide-border">
              {items.filter((i) => i.state === state).length === 0 ? (
                <li className="px-3 py-4 text-sm text-muted-foreground">{t('backlog.empty')}</li>
              ) : (
                items
                  .filter((i) => i.state === state)
                  .map((item) => (
                    <li key={item.itemId} className="flex items-center justify-between gap-2 px-3 py-2">
                      <span className="truncate text-sm">{item.title || item.slug || item.itemId}</span>
                      <button
                        type="button"
                        className="shrink-0 rounded-md border border-input px-2 py-1 text-xs disabled:opacity-50"
                        disabled={!item.groupId || create.isPending}
                        title={item.groupId ? t('backlog.create') : t('backlog.noGroup')}
                        onClick={() => create.mutate(item)}
                      >
                        {t('backlog.create')}
                      </button>
                    </li>
                  ))
              )}
            </ul>
          </section>
        ))}
      </div>
      {create.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {(create.error as Error).message}
        </p>
      ) : null}
    </div>
  );
}
