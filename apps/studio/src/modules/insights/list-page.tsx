// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { insightsApi } from './api';
import { PageHeader } from '@/workspace/ui/page-header';

/**
 * Insights dashboard list (Req 5). Card grid + create form + empty state.
 * See `docs/legacy/kiro-specs/insights-dashboard`.
 */

/** Admin-base aware link prefix (mirrors mission-control's pattern). */
function useInsightsBase(): string {
  const params = useParams({ strict: false }) as { adminPath?: string };
  return params.adminPath ? `/${params.adminPath}/insights` : '/insights';
}

export function InsightsListPage() {
  const { t } = useTranslation('insights');
  const base = useInsightsBase();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);

  const dashboardsQuery = useQuery({ queryKey: ['insights-dashboards'], queryFn: insightsApi.listDashboards });

  const createMutation = useMutation({
    mutationFn: () => insightsApi.createDashboard({ name: name.trim() }),
    onSuccess: () => {
      setName('');
      setCreating(false);
      queryClient.invalidateQueries({ queryKey: ['insights-dashboards'] });
    },
  });

  const dashboards = dashboardsQuery.data ?? [];

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('title')}
        description={t('list.subtitle')}
        actions={
        <button
          type="button"
          onClick={() => setCreating((v) => !v)}
          className="rounded-ctl bg-brand px-3 py-1.5 text-[13px] text-brand-fg hover:opacity-90"
        >
          {t('list.new')}
        </button>
        }
      />

      {creating && (
        <form
          className="flex items-center gap-2 rounded-card border border-line bg-panel p-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) createMutation.mutate();
          }}
        >
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('list.namePlaceholder')}
            className="flex-1 rounded border border-line px-2 py-1 text-sm"
          />
          <button type="submit" disabled={!name.trim() || createMutation.isPending} className="rounded-ctl bg-brand px-3 py-1 text-sm text-brand-fg disabled:opacity-50">
            {t('list.create')}
          </button>
          {createMutation.isError && (
            <span className="text-xs text-bad">{(createMutation.error as Error).message}</span>
          )}
        </form>
      )}

      {dashboardsQuery.isLoading ? (
        <p className="text-sm text-dim">{t('list.loading')}</p>
      ) : dashboards.length === 0 ? (
        <div className="rounded-card border border-line border-dashed p-8 text-center">
          <p className="text-sm text-dim">{t('list.empty')}</p>
          <button type="button" onClick={() => setCreating(true)} className="mt-2 text-sm text-brand hover:underline">
            {t('list.createFirst')}
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {dashboards.map((d) => (
            <Link
              key={d.id}
              to={`${base}/${d.id}` as never}
              className="rounded-card border border-line bg-panel p-4 transition hover:border-brand"
            >
              <div className="flex items-center gap-2">
                <span className="text-lg">{d.icon ?? '📊'}</span>
                <span className="font-medium">{d.name}</span>
              </div>
              {d.note && <p className="mt-1 line-clamp-2 text-xs text-dim">{d.note}</p>}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
