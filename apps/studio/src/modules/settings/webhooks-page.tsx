// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Webhook, Plus, Trash2, Edit, Save, Activity } from 'lucide-react';
import { useState } from 'react';
import { getApiClient } from '@/lib/api';
import { useSaveHandler } from '@/lib/keybindings/use-keybindings';
import type { WebhookResource } from '@heopress/sdk';
import { PageHeader } from '@/workspace/ui/page-header';

export function WebhooksPage() {
  const { t } = useTranslation(['system', 'common']);
  const client = getApiClient();
  const qc = useQueryClient();

  const webhooksQuery = useQuery({
    queryKey: ['webhooks'],
    queryFn: async () => (await client.webhooks.list()).data,
  });

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<WebhookResource | null>(null);

  const webhooks = webhooksQuery.data ?? [];

  const deleteMutation = useMutation({
    mutationFn: (id: string) => client.webhooks.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['webhooks'] }),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('webhooks.title')}
        description={t('webhooks.description')}
        actions={
          <>
            <button
          type="button"
          onClick={() => setCreating(true)}
          className="inline-flex items-center gap-2 rounded-ctl bg-brand px-3 py-1.5 text-sm font-medium text-brand-fg"
        >
          <Plus className="h-4 w-4" /> {t('webhooks.add')}
        </button>
          </>
        }
      />

      <div className="grid gap-4">
        {webhooksQuery.isLoading && <div className="text-dim">{t('common:loading')}</div>}
        {webhooks.length === 0 && !webhooksQuery.isLoading && (
          <div className="rounded-card border border-dashed p-12 text-center text-dim">
            {t('webhooks.empty')}
          </div>
        )}
        {webhooks.map((hook) => (
          <div key={hook.id} className="flex items-center justify-between rounded-card border border-line bg-panel p-4">
            <div className="flex items-start gap-4">
              <div className="mt-1 flex h-10 w-10 items-center justify-center rounded-card bg-brand-soft text-brand">
                <Webhook className="h-5 w-5" />
              </div>
              <div>
                <h3 className="font-semibold">{hook.name}</h3>
                <p className="text-sm text-dim">{hook.url}</p>
                <div className="mt-2 flex gap-2">
                  <span className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${hook.status === 'active' ? 'bg-ok-soft text-ok' : 'bg-panel-2 text-dim'}`}>
                    {hook.status === 'active' ? t('webhooks.active') : hook.status === 'inactive' ? t('webhooks.inactive') : hook.status}
                  </span>
                  <span className="inline-flex items-center gap-1 text-xs text-dim">
                    <Activity className="h-3 w-3" />
                    {t('webhooks.actions', { count: hook.actions.length })}
                  </span>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => setEditing(hook)} aria-label={t('webhooks.edit')} className="text-dim hover:text-fg">
                <Edit className="h-4 w-4" />
              </button>
              <button
                onClick={() => {
                  if (confirm(t('webhooks.confirmDelete'))) deleteMutation.mutate(hook.id);
                }}
                className="text-dim hover:text-bad"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          </div>
        ))}
      </div>

      {(creating || editing) && (
        <WebhookEditorDialog hook={editing} onClose={() => { setCreating(false); setEditing(null); }} />
      )}
    </div>
  );
}

function WebhookEditorDialog({ hook, onClose }: { hook: WebhookResource | null; onClose: () => void }) {
  const { t } = useTranslation(['system', 'common']);
  const client = getApiClient();
  const qc = useQueryClient();
  
  const [name, setName] = useState(hook?.name ?? '');
  const [url, setUrl] = useState(hook?.url ?? '');
  const [status, setStatus] = useState(hook?.status ?? 'active');

  const mutation = useMutation({
    mutationFn: () => {
      const payload = { name, url, status };
      if (hook) return client.webhooks.update(hook.id, payload);
      return client.webhooks.create(payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['webhooks'] });
      onClose();
    },
  });

  // Cmd/Ctrl+S → save this webhook (mirrors the Save button's gating).
  useSaveHandler(() => mutation.mutate(), !mutation.isPending && !!name && !!url);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-card border border-line bg-panel p-6 shadow-lg">
        <h2 className="t-section mb-4">{hook ? t('webhooks.edit') : t('webhooks.add')}</h2>
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium">{t('webhooks.name')}</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-ctl border px-3 py-2 text-sm outline-none focus:border-brand"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">{t('webhooks.url')}</label>
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className="w-full rounded-ctl border px-3 py-2 text-sm outline-none focus:border-brand"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">{t('webhooks.status')}</label>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="w-full rounded-ctl border px-3 py-2 text-sm outline-none focus:border-brand"
            >
              <option value="active">{t('webhooks.active')}</option>
              <option value="inactive">{t('webhooks.inactive')}</option>
            </select>
          </div>
          <div className="flex justify-end gap-2 mt-6">
            <button onClick={onClose} className="rounded-ctl px-4 py-2 text-sm font-medium hover:bg-panel-2">
              {t('common:cancel')}
            </button>
            <button
              onClick={() => mutation.mutate()}
              disabled={!name || !url || mutation.isPending}
              className="rounded-ctl bg-brand px-4 py-2 text-sm font-medium text-brand-fg disabled:opacity-50"
            >
              <Save className="mr-2 h-4 w-4 inline" />
              {mutation.isPending ? t('webhooks.saving') : t('common:save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
