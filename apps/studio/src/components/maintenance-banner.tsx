import { useQuery } from '@tanstack/react-query';
import { Wrench } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getApiClient } from '@/lib/api';

export interface MaintenanceState {
  active: boolean;
  since: string | null;
}

/** `GET /api/v1/system/maintenance` answers `{ data: { active, reason, since } }`. */
export function readMaintenance(body: unknown): MaintenanceState {
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const data = record.data && typeof record.data === 'object' ? (record.data as Record<string, unknown>) : record;
  return { active: data.active === true, since: typeof data.since === 'string' ? data.since : null };
}

/**
 * Maintenance notice (HeoPress P13 upgrade write freeze): while an upgrade runs, the server refuses every change with
 * 503 `MAINTENANCE`. The banner says so before someone loses an edit to a failed save. Polled every 30 seconds.
 */
export function MaintenanceBanner({ initial }: { initial?: MaintenanceState }) {
  const { t, i18n } = useTranslation('shell');
  const query = useQuery({
    queryKey: ['system-maintenance'],
    queryFn: async () => readMaintenance(await getApiClient().rawRequest<unknown>('/api/v1/system/maintenance')),
    initialData: initial,
    refetchInterval: 30_000,
    retry: false,
  });
  const state = query.data;
  if (!state?.active) return null;
  const since = state.since ? new Date(state.since) : null;
  return (
    <div role="status" className="flex items-start gap-2 border-b border-warn/40 bg-warn-soft px-4 py-2 text-sm text-warn">
      <Wrench className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0">
        <p className="font-medium">{t('maintenance.title')}</p>
        <p className="text-xs">
          {t('maintenance.body')}
          {since && !Number.isNaN(since.getTime()) ? ` ${t('maintenance.since', { time: since.toLocaleString(i18n.language) })}` : null}
        </p>
      </div>
    </div>
  );
}
