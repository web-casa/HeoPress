// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { getApiClient } from '@/lib/api';
import { readDisplayOptions, type DisplayComponent } from './types';

interface RelationDisplayOptions {
  collection?: string;
  displayField?: string;
}

/**
 * `relation` — resolves a single id to its `displayField`.
 * Lazy fetch: only triggers when there's a value, with 30s stale time so
 * scrolling a list doesn't refetch every cell.
 */
export const RelationDisplay: DisplayComponent<string> = ({ value, field }) => {
  const { t } = useTranslation('items');
  const opts = readDisplayOptions<RelationDisplayOptions>(field);
  const client = getApiClient();
  const display = opts.displayField ?? 'id';

  const query = useQuery({
    enabled: !!value && !!opts.collection,
    queryKey: ['relation-display', opts.collection, value, display],
    staleTime: 30_000,
    queryFn: async () => {
      const res = await client.items(opts.collection as never).detail(value as string);
      return res.data;
    },
  });

  if (!value) return <span className="text-dim">—</span>;
  if (!opts.collection) {
    return (
      <span className="font-mono text-xs text-dim">
        {String(value).slice(0, 8)}…
      </span>
    );
  }
  if (query.isLoading) {
    return <span className="text-xs text-dim">{t('displays.loading')}</span>;
  }
  const label = query.data?.data?.[display];
  return (
    <span title={String(value)}>
      {label !== undefined ? String(label) : `${String(value).slice(0, 8)}…`}
    </span>
  );
};
