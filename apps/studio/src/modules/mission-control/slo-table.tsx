// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { useQueries, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/cn';
import { missionControlApi, type ContentIntent } from './api';

/**
 * SLO health table (content-os-ui task 3.2/6.1; Req 2.4, 5.1).
 * Health = share of an intent's detected drifts that are resolved. A
 * collection with open drifts is out of SLO; no drifts means healthy.
 * Shared by the dashboard summary and the intents page — rows link to the
 * intent detail when `linkBase` is given.
 */

export interface SloRow {
  intent: ContentIntent;
  open: number;
  total: number;
  health: number;
}

export function useSloRows(enabled = true): { rows: SloRow[]; isLoading: boolean } {
  const intentsQuery = useQuery({ queryKey: ['mc-intents'], queryFn: missionControlApi.intents, enabled });
  const intents = intentsQuery.data ?? [];

  const driftQueries = useQueries({
    queries: intents.map((intent) => ({
      queryKey: ['mc-drifts', intent.id],
      queryFn: () => missionControlApi.drifts(intent.id),
      enabled: intents.length > 0,
    })),
  });

  const rows = intents.map((intent, i): SloRow => {
    const drifts = driftQueries[i]?.data ?? [];
    const open = drifts.filter((d) => d.status === 'open' || d.status === 'assigned').length;
    const total = drifts.length;
    return {
      intent,
      open,
      total,
      health: total === 0 ? 100 : Math.round(((total - open) / total) * 100),
    };
  });

  return { rows, isLoading: intentsQuery.isLoading };
}

export function IntentStatusBadge({ status }: { status: string }) {
  const { t } = useTranslation('agents');
  return (
    <span
      className={cn(
        'rounded-full px-2 py-0.5 text-xs',
        status === 'active' && 'bg-ok-soft text-ok',
        status === 'paused' && 'bg-panel-2 text-dim',
        status === 'error' && 'bg-bad-soft text-bad',
      )}
    >
      {t(`intentStatus.${status}`, { defaultValue: status })}
    </span>
  );
}

export function HealthBar({ health }: { health: number }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className="h-2 w-24 overflow-hidden rounded-full bg-panel-2">
        <span
          className={cn(
            'block h-full rounded-full',
            health >= 90 ? 'bg-ok' : health >= 60 ? 'bg-warn' : 'bg-bad',
          )}
          style={{ width: `${health}%` }}
        />
      </span>
      <span className="text-xs">{health}%</span>
    </span>
  );
}

export function SloTable({ rows, linkBase }: { rows: SloRow[]; linkBase?: string }) {
  const { t } = useTranslation('agents');
  if (rows.length === 0) {
    return (
      <p className="text-sm text-dim">
        {t('slo.empty')}
      </p>
    );
  }

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-line text-left text-xs uppercase text-dim">
          <th className="py-2">{t('slo.intent')}</th>
          <th>{t('slo.collection')}</th>
          <th>{t('slo.status')}</th>
          <th>{t('slo.openDrifts')}</th>
          <th>{t('slo.health')}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ intent, open, health }) => (
          <tr key={intent.id} className="border-b border-line last:border-0">
            <td className="py-2 font-medium">
              {linkBase ? (
                <Link to={`${linkBase}/${intent.id}` as never} className="hover:underline">
                  {intent.name}
                </Link>
              ) : (
                intent.name
              )}
            </td>
            <td>
              <code className="rounded bg-panel-2 px-1 text-xs">{intent.collection}</code>
            </td>
            <td>
              <IntentStatusBadge status={intent.status} />
            </td>
            <td>{open}</td>
            <td>
              <HealthBar health={health} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
