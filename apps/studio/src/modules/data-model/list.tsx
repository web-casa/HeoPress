// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Database, Plus } from 'lucide-react';
import { getApiClient } from '@/lib/api';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '@/workspace/ui/page-header';

/**
 * Settings → Data Model: list all collections in the active site.
 * Phase A FE entry point. Wires to GET /api/v1/collections via the SDK.
 */
export function CollectionsListPage() {
  const { t } = useTranslation('dataModel');
  const client = getApiClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ['collections'],
    queryFn: async () => {
      const res = await client.schema.listCollections();
      return res.data;
    },
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('title')}
        description={t('list.description')}
        actions={
        <Link
          to="/data-model/new"
          className="inline-flex items-center gap-2 rounded-ctl bg-brand px-3 py-1.5 text-[13px] text-brand-fg hover:opacity-90"
        >
          <Plus className="h-4 w-4" />
          {t('list.new')}
        </Link>
        }
      />

      {isLoading && (
        <p className="text-sm text-dim">{t('list.loading')}</p>
      )}

      {error && (
        <div className="rounded-ctl border border-bad/40 bg-bad-soft p-4 text-sm text-bad">
          {t('list.loadFailed')}
        </div>
      )}

      {data && data.length === 0 && (
        <div className="rounded-card border border-line border-dashed p-12 text-center">
          <Database className="mx-auto mb-3 h-8 w-8 text-dim" />
          <h2 className="text-base font-medium">{t('list.empty')}</h2>
          <p className="mt-1 text-sm text-dim">
            {t('list.emptyHint')}
          </p>
        </div>
      )}

      {data && data.length > 0 && (
        <div className="overflow-x-auto rounded-card border border-line bg-panel">
          <table className="w-full text-[13px]">
            <thead className="bg-panel-2 text-left text-[12px] text-dim">
              <tr>
                <th className="px-4 py-2 font-medium">{t('list.name')}</th>
                <th className="px-4 py-2 font-medium">{t('list.singleton')}</th>
                <th className="px-4 py-2 font-medium">{t('list.updated')}</th>
              </tr>
            </thead>
            <tbody>
              {data.map((c) => (
                <tr key={c.id} className="border-t border-line hover:bg-panel-2">
                  <td className="px-4 py-3">
                    <Link
                      to="/data-model/$name"
                      params={{ name: c.name }}
                      className="font-medium text-brand hover:underline"
                    >
                      {c.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-dim">
                    {c.singleton ? t('yes') : t('no')}
                  </td>
                  <td className="px-4 py-3 text-dim">
                    {c.updatedAt
                      ? new Date(c.updatedAt).toLocaleString()
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
