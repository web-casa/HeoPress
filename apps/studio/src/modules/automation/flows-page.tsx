// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, Play, Workflow, Plus, Edit } from 'lucide-react';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import i18n from 'i18next';
import { getActiveSite, getActiveToken } from '@/lib/api';
import { siteFetch } from '@/lib/http';

interface FlowRow {
  id: string;
  name: string;
  description: string | null;
  status: 'active' | 'inactive' | 'draft';
  triggerType: 'webhook' | 'event' | 'schedule' | 'manual';
}

function flowsApi(path: string, init?: RequestInit) {
  return siteFetch(`/api/v1/flows${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getActiveToken()}`,
      'X-HeoPress-Site': getActiveSite(),
      ...(init?.headers ?? {}),
    },
  }).then((r) => {
    if (!r.ok) throw new Error(i18n.t('flows:apiError', { status: r.status }));
    return r.json();
  });
}

export function FlowsListPage() {
  const { t } = useTranslation('flows');
  const qc = useQueryClient();
  const flowsQuery = useQuery({
    queryKey: ['flows'],
    queryFn: async () => (await flowsApi('')).data as FlowRow[],
  });

  const runMutation = useMutation({
    mutationFn: (id: string) => flowsApi(`/${id}/run`, { method: 'POST', body: '{}' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['flows'] }),
  });

  const flows = flowsQuery.data ?? [];

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">{t('list.title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('list.subtitle')}
          </p>
        </div>
        <Link
          to="/automation/flows/new"
          className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
        >
          <Plus className="h-4 w-4" /> {t('list.create')}
        </Link>
      </header>

      <div className="grid gap-3">
        {flowsQuery.isLoading && <div className="text-muted-foreground">{t('list.loading')}</div>}
        {!flowsQuery.isLoading && flows.length === 0 && (
          <div className="rounded-xl border border-dashed p-12 text-center text-muted-foreground">
            {t('list.empty')}
          </div>
        )}
        {flows.map((flow) => (
          <div
            key={flow.id}
            className="flex items-center justify-between rounded-lg border bg-background p-4 shadow-sm"
          >
            <div className="flex items-start gap-4">
              <div className="mt-1 flex h-10 w-10 items-center justify-center rounded-lg bg-violet-100 text-violet-600">
                <Workflow className="h-5 w-5" />
              </div>
              <div>
                <h3 className="font-semibold">{flow.name}</h3>
                {flow.description && (
                  <p className="text-sm text-muted-foreground">{flow.description}</p>
                )}
                <div className="mt-2 flex gap-2 text-xs">
                  <span
                    className={`inline-flex rounded px-2 py-0.5 font-medium ${flow.status === 'active'
                        ? 'bg-emerald-100 text-emerald-800'
                        : flow.status === 'draft'
                          ? 'bg-amber-100 text-amber-800'
                          : 'bg-muted text-muted-foreground'
                      }`}
                  >
                    {t(`status.${flow.status}`, { defaultValue: flow.status })}
                  </span>
                  <span className="inline-flex items-center gap-1 text-muted-foreground">
                    <Activity className="h-3 w-3" />
                    {t('list.trigger', { type: t(`trigger.${flow.triggerType}`, { defaultValue: flow.triggerType }) })}
                  </span>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Link
                to="/automation/flows/$id"
                params={{ id: flow.id }}
                className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline px-3 py-1.5 border border-primary/20 rounded-md hover:bg-primary/5 transition"
              >
                <Edit className="h-3.5 w-3.5" /> {t('list.edit')}
              </Link>
              {flow.triggerType === 'manual' && flow.status === 'active' && (
                <button
                  type="button"
                  disabled={runMutation.isPending}
                  onClick={() => runMutation.mutate(flow.id)}
                  className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
                >
                  <Play className="h-4 w-4" /> {t('list.run')}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
