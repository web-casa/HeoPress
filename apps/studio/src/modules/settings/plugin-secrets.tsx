import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PluginSecretResource } from '@heopress/sdk';
import { getApiClient } from '@/lib/api';
import { inputClass } from '@/workspace/seo/seo-kit';

/**
 * A plugin's secrets (HeoPress v1.2, spec extensions/plugin-secrets).
 *
 * The server lists the names the manifest declares and whether each has a value; this panel sets/rotates or deletes one.
 * The value only ever lives in the password field until it is submitted: the response carries the name and a
 * `configured` flag, never the value, a fragment of it or the ciphertext, so nothing here can display one.
 */
export function PluginSecrets({ pluginId, declaredNames }: { pluginId: string; declaredNames: string[] }) {
  // No declared secret → no panel and no request; the hook body lives in the inner component so the rule of hooks holds.
  return declaredNames.length === 0 ? null : <PluginSecretsPanel pluginId={pluginId} declaredNames={declaredNames} />;
}

function PluginSecretsPanel({ pluginId, declaredNames }: { pluginId: string; declaredNames: string[] }) {
  const { t } = useTranslation('system');
  const client = getApiClient();
  const qc = useQueryClient();
  const queryKey = ['plugin-secrets', pluginId];
  const secrets = useQuery({
    queryKey,
    queryFn: async () => (await client.extensions.listSecrets(pluginId)).data,
  });
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const close = () => {
    setEditing(null);
    setDraft('');
  };
  const save = useMutation({
    mutationFn: ({ name, value }: { name: string; value: string }) => client.extensions.setSecret(pluginId, name, value),
    onSuccess: async () => {
      close();
      await qc.invalidateQueries({ queryKey });
    },
  });
  const remove = useMutation({
    mutationFn: (name: string) => client.extensions.deleteSecret(pluginId, name),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey });
    },
  });

  const rows: PluginSecretResource[] =
    secrets.data ?? declaredNames.map((name) => ({ name, configured: false, declared: true }));
  const error = save.error ?? remove.error;

  return (
    <section className="mt-4 rounded-ctl border border-line p-3" data-testid="plugin-secrets" aria-label={t('extensions.secrets.title')}>
      <h4 className="flex items-center gap-2 text-sm font-semibold">
        <KeyRound className="h-4 w-4 text-dim" />
        {t('extensions.secrets.title')}
      </h4>
      <p className="mt-1 text-xs text-dim">{t('extensions.secrets.description')}</p>
      {secrets.isLoading ? null : (
        <ul className="mt-3 space-y-2">
          {rows.map((row) => (
            <li key={row.name} className="rounded-ctl bg-panel-2 px-2 py-2" data-secret={row.name}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-2 font-mono text-[13px]">
                  {row.name}
                  <span
                    data-testid={`secret-state-${row.name}`}
                    className={`rounded px-1.5 py-0.5 text-[12px] font-sans ${row.configured ? 'bg-ok-soft text-ok' : 'bg-panel text-dim'}`}
                  >
                    {row.configured ? t('extensions.secrets.configured') : t('extensions.secrets.notConfigured')}
                  </span>
                  {!row.declared && <span className="text-[12px] text-warn">{t('extensions.secrets.undeclared')}</span>}
                </span>
                <span className="flex items-center gap-2">
                  <button
                    type="button"
                    className="text-[13px] font-medium text-brand hover:underline"
                    onClick={() => {
                      save.reset();
                      setEditing(row.name);
                      setDraft('');
                    }}
                  >
                    {row.configured ? t('extensions.secrets.replace') : t('extensions.secrets.set')}
                  </button>
                  {row.configured && (
                    <button
                      type="button"
                      className="text-[13px] text-bad hover:underline"
                      aria-label={t('extensions.secrets.delete')}
                      onClick={() => {
                        if (confirm(t('extensions.secrets.confirmDelete', { name: row.name }))) remove.mutate(row.name);
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </span>
              </div>
              {editing === row.name && (
                <form
                  className="mt-2 flex flex-wrap items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (draft.trim() !== '') save.mutate({ name: row.name, value: draft });
                  }}
                >
                  <input
                    type="password"
                    autoComplete="new-password"
                    className={`${inputClass} max-w-sm`}
                    aria-label={t('extensions.secrets.valueLabel', { name: row.name })}
                    placeholder={t('extensions.secrets.valuePlaceholder')}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    autoFocus
                  />
                  <button type="submit" className="text-[13px] font-medium text-brand hover:underline" disabled={save.isPending}>
                    {t('extensions.secrets.save')}
                  </button>
                  <button type="button" className="text-[13px] text-dim hover:underline" onClick={close}>
                    {t('extensions.secrets.cancel')}
                  </button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
      {error ? <p className="mt-2 text-xs text-bad">{t('extensions.secrets.failed')}</p> : null}
    </section>
  );
}
