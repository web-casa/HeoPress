import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  NOTIFICATION_CHANNEL_KINDS,
  NOTIFICATION_EVENT_KINDS,
  type NotificationChannelKind,
  type NotificationChannelResource,
  type NotificationDeliveryResource,
  type NotificationEventKind,
} from '@heopress/contracts/schemas';
import { getApiClient } from '@/lib/api';
import { cn } from '@/lib/cn';
import { siteKey } from '../api';
import { inputClass } from '../seo/seo-kit';
import { PageHeader } from '../ui/page-header';
import { RelativeTime } from '../ui/relative-time';
import { Skeleton } from '../ui/skeleton';

/**
 * Settings › Notifications (HeoPress P10 tasks 5.2, 5.5): the site's IM / webhook channels — WeCom, Feishu, DingTalk,
 * Telegram, a signed webhook — and which events each receives. The target (URL, signing secret, bot token) is
 * write-only: the list shows its host only, and editing a channel keeps the target unless a new one is entered.
 * Messages carry the event title, the site and a Studio link; never article text.
 */

const BASE = '/api/v1/notification-channels';

interface Draft {
  name: string;
  kind: NotificationChannelKind;
  url: string;
  secret: string;
  token: string;
  chatId: string;
  events: NotificationEventKind[];
  linkBaseUrl: string;
}

const EMPTY: Draft = { name: '', kind: 'wecom', url: '', secret: '', token: '', chatId: '', events: ['approval', 'veto', 'incident', 'budget'], linkBaseUrl: '' };

/** The request body for a draft; `target` only when one was entered (editing keeps the stored one otherwise). */
export function draftBody(d: Draft, editing: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = { name: d.name.trim(), events: d.events, linkBaseUrl: d.linkBaseUrl.trim() || null };
  if (!editing) body.kind = d.kind;
  const target =
    d.kind === 'telegram'
      ? d.token.trim() || d.chatId.trim()
        ? { token: d.token.trim(), chatId: d.chatId.trim() }
        : null
      : d.url.trim()
        ? { url: d.url.trim(), ...(d.secret ? { secret: d.secret } : {}) }
        : null;
  if (target) body.target = target;
  return body;
}

export function NotificationsSettingsPage() {
  const { t } = useTranslation('settings');
  const qc = useQueryClient();
  const client = getApiClient();
  const channels = useQuery({ queryKey: siteKey('notification-channels'), queryFn: async () => (await client.rawRequest<NotificationChannelResource[]>(BASE)).data });
  const deliveries = useQuery({
    queryKey: siteKey('notification-deliveries'),
    queryFn: async () => (await client.rawRequest<NotificationDeliveryResource[]>(`${BASE}/deliveries?limit=20`)).data,
  });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editing, setEditing] = useState<NotificationChannelResource | null>(null);
  const [removing, setRemoving] = useState<NotificationChannelResource | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: siteKey('notification-channels') });
    void qc.invalidateQueries({ queryKey: siteKey('notification-deliveries') });
  };

  const save = useMutation({
    mutationFn: async (d: Draft) =>
      editing
        ? client.rawRequest(`${BASE}/${encodeURIComponent(editing.id)}`, { method: 'PATCH', body: JSON.stringify(draftBody(d, true)) })
        : client.rawRequest(BASE, { method: 'POST', body: JSON.stringify(draftBody(d, false)) }),
    onSuccess: () => {
      setDraft(null);
      setEditing(null);
      refresh();
    },
  });
  const toggle = useMutation({
    mutationFn: (c: NotificationChannelResource) => client.rawRequest(`${BASE}/${encodeURIComponent(c.id)}`, { method: 'PATCH', body: JSON.stringify({ enabled: !c.enabled }) }),
    onSuccess: refresh,
  });
  const test = useMutation({
    mutationFn: async (c: NotificationChannelResource) => (await client.rawRequest<NotificationDeliveryResource>(`${BASE}/${encodeURIComponent(c.id)}/test`, { method: 'POST', body: '{}' })).data,
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: string) => client.rawRequest(`${BASE}/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => {
      setRemoving(null);
      refresh();
    },
  });

  const startNew = () => {
    setEditing(null);
    setDraft({ ...EMPTY });
    save.reset();
  };
  const startEdit = (c: NotificationChannelResource) => {
    setEditing(c);
    setDraft({ ...EMPTY, name: c.name, kind: c.kind, events: c.events, linkBaseUrl: c.linkBaseUrl ?? '' });
    save.reset();
  };
  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const nameOf = (id: string) => channels.data?.find((c) => c.id === id)?.name ?? id;

  return (
    <>
      <PageHeader
        title={t('notificationChannels.title')}
        description={t('notificationChannels.description')}
        actions={
          <button type="button" onClick={startNew} className="rounded-ctl bg-brand px-3 py-1.5 text-[13px] text-brand-fg">
            {t('notificationChannels.add')}
          </button>
        }
      />

      {draft ? (
        <form
          aria-label={editing ? t('notificationChannels.editTitle', { name: editing.name }) : t('notificationChannels.add')}
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.name.trim()) save.mutate(draft);
          }}
          className="mb-5 grid gap-3 rounded-card border border-line bg-panel p-4 sm:grid-cols-2"
        >
          <label className="flex flex-col gap-1 text-[13px]">
            <span className="font-medium">{t('notificationChannels.name')}</span>
            <input className={inputClass} value={draft.name} onChange={(e) => set({ name: e.target.value })} />
          </label>
          <label className="flex flex-col gap-1 text-[13px]">
            <span className="font-medium">{t('notificationChannels.kind')}</span>
            <select className={inputClass} value={draft.kind} disabled={!!editing} onChange={(e) => set({ kind: e.target.value as NotificationChannelKind })}>
              {NOTIFICATION_CHANNEL_KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(`notificationChannels.kinds.${k}`)}
                </option>
              ))}
            </select>
          </label>
          {draft.kind === 'telegram' ? (
            <>
              <label className="flex flex-col gap-1 text-[13px]">
                <span className="font-medium">{t('notificationChannels.token')}</span>
                <input className={inputClass} type="password" autoComplete="off" value={draft.token} onChange={(e) => set({ token: e.target.value })} placeholder={editing ? t('notificationChannels.keepTarget') : ''} />
              </label>
              <label className="flex flex-col gap-1 text-[13px]">
                <span className="font-medium">{t('notificationChannels.chatId')}</span>
                <input className={inputClass} value={draft.chatId} onChange={(e) => set({ chatId: e.target.value })} placeholder="-1001234567890" />
              </label>
            </>
          ) : (
            <>
              <label className="flex flex-col gap-1 text-[13px]">
                <span className="font-medium">{t('notificationChannels.url')}</span>
                <input className={inputClass} type="password" autoComplete="off" value={draft.url} onChange={(e) => set({ url: e.target.value })} placeholder={editing ? t('notificationChannels.keepTarget') : 'https://'} />
              </label>
              <label className="flex flex-col gap-1 text-[13px]">
                <span className="font-medium">{t('notificationChannels.secret')}</span>
                <input className={inputClass} type="password" autoComplete="off" value={draft.secret} onChange={(e) => set({ secret: e.target.value })} />
              </label>
            </>
          )}
          <label className="flex flex-col gap-1 text-[13px] sm:col-span-2">
            <span className="font-medium">{t('notificationChannels.linkBase')}</span>
            <input className={inputClass} value={draft.linkBaseUrl} onChange={(e) => set({ linkBaseUrl: e.target.value })} placeholder={t('notificationChannels.linkBasePlaceholder')} />
            <span className="t-aux">{t('notificationChannels.linkBaseHint')}</span>
          </label>
          <fieldset className="sm:col-span-2">
            <legend className="mb-1 text-[13px] font-medium">{t('notificationChannels.events')}</legend>
            <div className="flex flex-wrap gap-3">
              {NOTIFICATION_EVENT_KINDS.map((ev) => (
                <label key={ev} className="inline-flex items-center gap-1.5 text-[13px]">
                  <input
                    type="checkbox"
                    checked={draft.events.includes(ev)}
                    onChange={(e) => set({ events: e.target.checked ? [...draft.events, ev] : draft.events.filter((x) => x !== ev) })}
                  />
                  {t(`notificationChannels.eventKinds.${ev}`)}
                </label>
              ))}
            </div>
          </fieldset>
          <p className="t-aux sm:col-span-2">{t('notificationChannels.privacy')}</p>
          {save.error ? (
            <p role="alert" className="text-[12.5px] text-bad sm:col-span-2">
              {save.error instanceof Error ? save.error.message : String(save.error)}
            </p>
          ) : null}
          <div className="flex justify-end gap-2 sm:col-span-2">
            <button type="button" onClick={() => setDraft(null)} className="rounded-ctl border border-line px-3 py-1.5 text-[13px]">
              {t('notificationChannels.cancel')}
            </button>
            <button type="submit" disabled={!draft.name.trim() || save.isPending} className="rounded-ctl bg-brand px-3 py-1.5 text-[13px] text-brand-fg disabled:opacity-50">
              {t('notificationChannels.save')}
            </button>
          </div>
        </form>
      ) : null}

      {channels.isLoading ? (
        <Skeleton className="h-32" />
      ) : (channels.data ?? []).length === 0 ? (
        <p className="text-[13px] text-dim">{t('notificationChannels.empty')}</p>
      ) : (
        <div className="overflow-x-auto rounded-card border border-line bg-panel">
          <table className="w-full min-w-[680px] text-left text-[13px]">
            <caption className="sr-only">{t('notificationChannels.title')}</caption>
            <thead className="t-aux">
              <tr className="border-b border-line">
                <th className="px-4 py-2">{t('notificationChannels.name')}</th>
                <th className="px-4 py-2">{t('notificationChannels.kind')}</th>
                <th className="px-4 py-2">{t('notificationChannels.target')}</th>
                <th className="px-4 py-2">{t('notificationChannels.events')}</th>
                <th className="px-4 py-2">{t('notificationChannels.recent')}</th>
                <th className="px-4 py-2">
                  <span className="sr-only">{t('notificationChannels.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {(channels.data ?? []).map((c) => (
                <tr key={c.id} data-channel={c.name} className={cn('border-b border-line last:border-0', !c.enabled && 'text-dim')}>
                  <td className="px-4 py-2 font-medium">{c.name}</td>
                  <td className="px-4 py-2">{t(`notificationChannels.kinds.${c.kind}`)}</td>
                  <td className="px-4 py-2 font-mono text-[12px]">{c.targetHint}</td>
                  <td className="px-4 py-2">{c.events.map((e) => t(`notificationChannels.eventKinds.${e}`)).join(', ') || '—'}</td>
                  <td className="px-4 py-2 t-aux">
                    {t('notificationChannels.counts', { sent: c.deliveries?.sent ?? 0, pending: c.deliveries?.pending ?? 0, failed: c.deliveries?.failed ?? 0 })}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 text-right">
                    <button type="button" onClick={() => test.mutate(c)} disabled={test.isPending} className="rounded-ctl px-2 py-1 text-[12.5px] hover:bg-panel-2">
                      {t('notificationChannels.test')}
                    </button>
                    <button type="button" onClick={() => toggle.mutate(c)} className="rounded-ctl px-2 py-1 text-[12.5px] hover:bg-panel-2">
                      {c.enabled ? t('notificationChannels.disable') : t('notificationChannels.enable')}
                    </button>
                    <button type="button" onClick={() => startEdit(c)} className="rounded-ctl px-2 py-1 text-[12.5px] hover:bg-panel-2">
                      {t('notificationChannels.edit')}
                    </button>
                    <button type="button" onClick={() => setRemoving(c)} className="rounded-ctl px-2 py-1 text-[12.5px] text-bad hover:bg-bad-soft">
                      {t('notificationChannels.delete')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {test.data ? (
        <p role="status" className={cn('mt-3 text-[13px]', test.data.status === 'sent' ? 'text-ok' : 'text-bad')}>
          {test.data.status === 'sent' ? t('notificationChannels.testSent') : t('notificationChannels.testFailed', { error: test.data.lastError ?? '' })}
        </p>
      ) : null}

      <h2 className="t-section mb-2 mt-6">{t('notificationChannels.deliveries')}</h2>
      {(deliveries.data ?? []).length === 0 ? (
        <p className="text-[13px] text-dim">{t('notificationChannels.noDeliveries')}</p>
      ) : (
        <ul className="divide-y divide-line rounded-card border border-line bg-panel text-[13px]">
          {(deliveries.data ?? []).map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2">
              <span className={cn('rounded-full px-1.5 py-0.5 text-[11px]', d.status === 'sent' ? 'bg-ok-soft text-ok' : d.status === 'failed' ? 'bg-bad-soft text-bad' : 'bg-warn-soft text-warn')}>
                {t(`notificationChannels.status.${d.status}`)}
              </span>
              <span className="font-medium">{d.title}</span>
              <span className="t-aux">{nameOf(d.channelId)}</span>
              <span className="t-aux">{t('notificationChannels.attempts', { n: d.attempts, max: d.maxAttempts })}</span>
              {d.lastError ? <code className="t-aux">{d.lastError}</code> : null}
              <span className="ml-auto t-aux">
                <RelativeTime value={d.createdAt} />
              </span>
            </li>
          ))}
        </ul>
      )}

      {removing ? (
        <div role="dialog" aria-modal="true" aria-labelledby="channel-remove-title" className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4">
          <div className="w-full max-w-md rounded-card border border-line bg-panel p-5 shadow-lg">
            <h2 id="channel-remove-title" className="t-section">
              {t('notificationChannels.deleteTitle', { name: removing.name })}
            </h2>
            <p className="mt-2 text-[13px]">{t('notificationChannels.deleteBody')}</p>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setRemoving(null)} className="rounded-ctl border border-line px-3 py-1.5 text-[13px]">
                {t('notificationChannels.cancel')}
              </button>
              <button type="button" onClick={() => remove.mutate(removing.id)} className="rounded-ctl bg-bad px-3 py-1.5 text-[13px] text-white">
                {t('notificationChannels.delete')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
