// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
/**
 * Settings → Change Feed (spec cdc-extension-integration, Req 8.1, 8.3).
 *
 * Minimal v1 panel: subscription list (status/kind/lag/lastDeliveredAt),
 * recent deliveries per subscription, and pause / resume / replay /
 * dispatch-now actions — destructive/rewinding actions confirm first.
 * The feed routes are not part of the typed SDK yet, so calls go through
 * `rawRequest` (the CDC control-plane panel convention).
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Rss, Pause, Play, RotateCcw, Send, Trash2 } from 'lucide-react';
import { useState } from 'react';
import i18n from 'i18next';
import { useTranslation } from 'react-i18next';
import { getApiClient } from '@/lib/api';
import { PageHeader } from '@/workspace/ui/page-header';

const BASE = '/api/v1/cdc';

export interface ChangeFeedSubscription {
  id: string;
  name: string;
  kind: 'pull' | 'webhook' | 'extension';
  status: 'active' | 'paused' | 'dead' | 'stale';
  collections: string[];
  operations: string[];
  payloadMode: string;
  cursor: string | null;
  lastDeliveredAt: string | null;
  consecutiveFailures: number;
  lag: { events: number; behindMs: number | null };
}

export interface ChangeFeedDelivery {
  id: string;
  attempt: number;
  status: 'success' | 'failed';
  httpStatus: number | null;
  errorMessage: string | null;
  eventCount: number;
  durationMs: number;
  createdAt: string;
}

async function listSubscriptions(): Promise<ChangeFeedSubscription[]> {
  const res = await getApiClient().rawRequest<ChangeFeedSubscription[]>(
    `${BASE}/subscriptions`,
  );
  return res.data;
}

async function listDeliveries(id: string): Promise<ChangeFeedDelivery[]> {
  const res = await getApiClient().rawRequest<ChangeFeedDelivery[]>(
    `${BASE}/subscriptions/${encodeURIComponent(id)}/deliveries?limit=20`,
  );
  return res.data;
}

function post(path: string, body?: unknown) {
  return getApiClient().rawRequest(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function patch(path: string, body: unknown) {
  return getApiClient().rawRequest(`${BASE}${path}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const STATUS_STYLE: Record<ChangeFeedSubscription['status'], string> = {
  active: 'bg-ok-soft text-ok',
  paused: 'bg-warn-soft text-warn',
  dead: 'bg-bad-soft text-bad',
  stale: 'bg-warn-soft text-warn',
};

export function formatLag(lag: ChangeFeedSubscription['lag']): string {
  if (lag.events === 0) return i18n.t('system:changeFeed.caughtUp');
  const events = i18n.t('system:changeFeed.events', { count: lag.events });
  if (lag.behindMs === null) return events;
  return lag.behindMs > 60_000
    ? i18n.t('system:changeFeed.behindMinutes', { events, value: Math.round(lag.behindMs / 60_000) })
    : i18n.t('system:changeFeed.behindSeconds', { events, value: Math.round(lag.behindMs / 1000) });
}

export function ChangeFeedPage() {
  const { t } = useTranslation(['system', 'common']);
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState<string | null>(null);

  const subsQuery = useQuery({
    queryKey: ['cdc-feed-subscriptions'],
    queryFn: listSubscriptions,
    refetchInterval: 10_000,
  });
  const deliveriesQuery = useQuery({
    queryKey: ['cdc-feed-deliveries', expanded],
    queryFn: () => listDeliveries(expanded!),
    enabled: expanded !== null,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['cdc-feed-subscriptions'] });
  const pauseResume = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'active' | 'paused' }) =>
      patch(`/subscriptions/${encodeURIComponent(id)}`, { status }),
    onSuccess: invalidate,
  });
  const replay = useMutation({
    mutationFn: ({ id, occurredAfter }: { id: string; occurredAfter: string }) =>
      post(`/subscriptions/${encodeURIComponent(id)}/replay`, { occurred_after: occurredAfter }),
    onSuccess: invalidate,
  });
  const dispatchNow = useMutation({
    mutationFn: (id: string) => post(`/subscriptions/${encodeURIComponent(id)}/dispatch`),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      getApiClient().rawRequest(`${BASE}/subscriptions/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }),
    onSuccess: invalidate,
  });

  const subs = subsQuery.data ?? [];

  const onReplay = (sub: ChangeFeedSubscription) => {
    const iso = window.prompt(
      t('changeFeed.replayPrompt', { name: sub.name }),
      new Date(Date.now() - 3_600_000).toISOString(),
    );
    if (!iso) return;
    if (
      window.confirm(
        t('changeFeed.replayConfirm', { name: sub.name, time: iso }),
      )
    ) {
      replay.mutate({ id: sub.id, occurredAfter: iso });
    }
  };

  const onDelete = (sub: ChangeFeedSubscription) => {
    if (
      window.confirm(
        t('changeFeed.deleteConfirm', { name: sub.name }),
      )
    ) {
      remove.mutate(sub.id);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('changeFeed.title')}
        description={t('changeFeed.description')}
      />

      <div className="grid gap-4">
        {subsQuery.isLoading && <div className="text-dim">{t('common:loading')}</div>}
        {subs.length === 0 && !subsQuery.isLoading && (
          <div className="rounded-card border border-dashed p-12 text-center text-dim">
            {t('changeFeed.empty')}
          </div>
        )}
        {subs.map((sub) => (
          <div key={sub.id} className="rounded-card border border-line bg-panel p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-start gap-4">
                <div className="mt-1 flex h-10 w-10 items-center justify-center rounded-card bg-brand-soft text-brand">
                  <Rss className="h-5 w-5" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{sub.name}</span>
                    <span className="rounded-full bg-panel-2 px-2 py-0.5 text-xs">{t(`changeFeed.kind.${sub.kind}`, { defaultValue: sub.kind })}</span>
                    <span
                      data-testid={`status-${sub.id}`}
                      className={`rounded-full px-2 py-0.5 text-xs ${STATUS_STYLE[sub.status]}`}
                    >
                      {t(`changeFeed.status.${sub.status}`, { defaultValue: sub.status })}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-dim">
                    {t('changeFeed.lag', { lag: formatLag(sub.lag) })}
                    {' · '}
                    {sub.lastDeliveredAt
                      ? t('changeFeed.lastDelivered', { time: new Date(sub.lastDeliveredAt).toLocaleString() })
                      : t('changeFeed.neverDelivered')}
                    {sub.consecutiveFailures > 0
                      ? ` · ${t('changeFeed.failures', { count: sub.consecutiveFailures })}`
                      : ''}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-1">
                {sub.status === 'active' && (
                  <button
                    type="button"
                    title={t('changeFeed.pause')}
                    aria-label={t('changeFeed.pauseNamed', { name: sub.name })}
                    onClick={() => pauseResume.mutate({ id: sub.id, status: 'paused' })}
                    className="rounded-ctl p-2 hover:bg-panel-2"
                  >
                    <Pause className="h-4 w-4" />
                  </button>
                )}
                {sub.status === 'paused' && (
                  <button
                    type="button"
                    title={t('changeFeed.resume')}
                    aria-label={t('changeFeed.resumeNamed', { name: sub.name })}
                    onClick={() => pauseResume.mutate({ id: sub.id, status: 'active' })}
                    className="rounded-ctl p-2 hover:bg-panel-2"
                  >
                    <Play className="h-4 w-4" />
                  </button>
                )}
                <button
                  type="button"
                  title={t('changeFeed.replay')}
                  aria-label={t('changeFeed.replayNamed', { name: sub.name })}
                  onClick={() => onReplay(sub)}
                  className="rounded-ctl p-2 hover:bg-panel-2"
                >
                  <RotateCcw className="h-4 w-4" />
                </button>
                {sub.kind !== 'pull' && (
                  <button
                    type="button"
                    title={t('changeFeed.dispatch')}
                    aria-label={t('changeFeed.dispatchNamed', { name: sub.name })}
                    onClick={() => dispatchNow.mutate(sub.id)}
                    className="rounded-ctl p-2 hover:bg-panel-2"
                  >
                    <Send className="h-4 w-4" />
                  </button>
                )}
                <button
                  type="button"
                  title={t('changeFeed.delete')}
                  aria-label={t('changeFeed.deleteNamed', { name: sub.name })}
                  onClick={() => onDelete(sub)}
                  className="rounded-ctl p-2 text-bad hover:bg-bad-soft"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setExpanded(expanded === sub.id ? null : sub.id)}
                  className="ml-2 rounded-ctl border border-line px-2 py-1 text-xs"
                >
                  {expanded === sub.id ? t('changeFeed.hideDeliveries') : t('changeFeed.deliveries')}
                </button>
              </div>
            </div>

            {expanded === sub.id && (
              <div className="mt-4 border-t pt-3">
                {deliveriesQuery.isLoading && (
                  <div className="text-sm text-dim">{t('changeFeed.loadingDeliveries')}</div>
                )}
                {(deliveriesQuery.data ?? []).length === 0 && !deliveriesQuery.isLoading && (
                  <div className="text-sm text-dim">{t('changeFeed.noDeliveries')}</div>
                )}
                <ul className="space-y-1 text-sm">
                  {(deliveriesQuery.data ?? []).map((d) => (
                    <li key={d.id} className="flex items-center gap-3">
                      <span
                        className={
                          d.status === 'success' ? 'text-ok' : 'text-bad'
                        }
                      >
                        {t(`changeFeed.deliveryStatus.${d.status}`, { defaultValue: d.status })}
                      </span>
                      <span className="text-dim">
                        {t('changeFeed.attempt', { attempt: d.attempt })} · {t('changeFeed.events', { count: d.eventCount })} ·{' '}
                        {t('changeFeed.duration', { ms: d.durationMs })}
                        {d.httpStatus ? ` · HTTP ${d.httpStatus}` : ''}
                        {d.errorMessage ? ` · ${d.errorMessage}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
