// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Puzzle, Upload, Trash2, Power, Code } from 'lucide-react';
import { useState } from 'react';
import { getApiClient } from '@/lib/api';
import type { ExtensionResource } from '@heopress/sdk';
import { PageHeader } from '@/workspace/ui/page-header';

/** An example address, not translated. */
const BUNDLE_URL_EXAMPLE = 'https://example.com/bundle.js';

export function ExtensionsPage() {
  const { t } = useTranslation(['system', 'common']);
  const client = getApiClient();
  const qc = useQueryClient();

  const extensionsQuery = useQuery({
    queryKey: ['extensions'],
    queryFn: async () => (await client.extensions.list()).data,
  });

  const extensions = extensionsQuery.data ?? [];

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      client.extensions.update(id, { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['extensions'] }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => client.extensions.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['extensions'] }),
  });

  // Mock install from bundle URL
  const [installUrl, setInstallUrl] = useState('');
  const installMutation = useMutation({
    mutationFn: () => client.extensions.create({
      name: `Extension ${Math.floor(Math.random() * 1000)}`,
      version: '1.0.0',
      type: 'module',
      enabled: false,
      bundleUrl: installUrl,
      capabilities: ['read_items'],
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['extensions'] });
      setInstallUrl('');
    },
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('extensions.title')}
        description={t('extensions.description')}
      />

      <div className="flex gap-2">
        <input
          type="text"
          placeholder={BUNDLE_URL_EXAMPLE}
          value={installUrl}
          onChange={(e) => setInstallUrl(e.target.value)}
          className="w-full max-w-md rounded-ctl border px-3 py-2 text-sm outline-none focus:border-brand"
        />
        <button
          type="button"
          onClick={() => installMutation.mutate()}
          disabled={!installUrl || installMutation.isPending}
          className="inline-flex items-center gap-2 rounded-ctl bg-brand px-3 py-1.5 text-sm font-medium text-brand-fg disabled:opacity-50"
        >
          <Upload className="h-4 w-4" /> {t('extensions.install')}
        </button>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {extensionsQuery.isLoading && <div className="text-dim">{t('common:loading')}</div>}
        {extensions.length === 0 && !extensionsQuery.isLoading && (
          <div className="col-span-full rounded-card border border-dashed p-12 text-center text-dim">
            {t('extensions.empty')}
          </div>
        )}
        {extensions.map((ext) => (
          <div key={ext.id} className="flex flex-col justify-between rounded-card border border-line bg-panel p-4">
            <div>
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div className={`flex h-10 w-10 items-center justify-center rounded-card ${ext.enabled ? 'bg-brand-soft text-brand' : 'bg-panel-2 text-dim'}`}>
                    <Puzzle className="h-5 w-5" />
                  </div>
                  <div>
                    <h3 className="font-semibold flex items-center gap-2">
                      {ext.name}
                      <span className="text-xs font-normal text-dim bg-panel-2 px-1.5 py-0.5 rounded">{`v${ext.version}`}</span>
                    </h3>
                    <p className="text-xs text-dim capitalize">{t('extensions.typeLabel', { type: ext.type })}</p>
                  </div>
                </div>
                <button
                  onClick={() => toggleMutation.mutate({ id: ext.id, enabled: !ext.enabled })}
                  className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors ${ext.enabled ? 'bg-ok-soft text-ok hover:bg-ok-soft' : 'bg-panel-2 text-dim hover:bg-panel-2'}`}
                  title={ext.enabled ? t('extensions.disable') : t('extensions.enable')}
                >
                  <Power className="h-4 w-4" />
                </button>
              </div>
              <div className="mt-4 flex flex-wrap gap-1">
                {ext.capabilities.map(cap => (
                  <span key={cap} className="inline-flex items-center gap-1 rounded border border-line px-1.5 py-0.5 text-[10px] uppercase text-dim">
                    <Code className="h-3 w-3" />
                    {cap}
                  </span>
                ))}
              </div>
            </div>
            <div className="mt-4 flex items-center justify-end border-t pt-3">
              <button
                onClick={() => {
                  if (confirm(t('extensions.confirmUninstall'))) deleteMutation.mutate(ext.id);
                }}
                className="text-sm font-medium text-bad hover:underline"
              >
                {t('extensions.uninstall')}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
