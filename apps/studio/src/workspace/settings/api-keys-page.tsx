import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useRouterState } from '@tanstack/react-router';
import { Copy } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getAdminBase } from '@/lib/admin-base';
import { getApiClient } from '@/lib/api';
import { cn } from '@/lib/cn';
import { withAdminBase } from '@/lib/keybindings/commands';
import { siteKey } from '../api';
import { inputClass } from '../seo/seo-kit';
import { PageHeader } from '../ui/page-header';
import { RelativeTime } from '../ui/relative-time';
import { Skeleton } from '../ui/skeleton';

/**
 * Settings › API & keys (HeoPress P07a task 12.6; spec studio/settings "API 与密钥"): the site's keys with their last 4
 * characters, what they may do, when they were made and last used; a key unused for 90 days is marked for revoking. A new
 * key is shown in full once; revoking says first that calls with it fail at once.
 */

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  last4: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  expiresAt: string | null;
  roles: Array<{ roleId: string }>;
  policies: Array<{ policyId: string }>;
}

const DAY = 86_400_000;

/** Unused for 90 days (never used counts from its creation): revoking is suggested. */
export function staleKey(key: Pick<ApiKey, 'lastUsedAt' | 'createdAt' | 'revokedAt'>, now = Date.now()): boolean {
  if (key.revokedAt) return false;
  return now - Date.parse(key.lastUsedAt ?? key.createdAt) > 90 * DAY;
}

export function ApiKeysSettingsPage() {
  const { t } = useTranslation('settings');
  const qc = useQueryClient();
  const client = getApiClient();
  const { location } = useRouterState();
  const adminBase = getAdminBase(location.pathname);
  const keys = useQuery({ queryKey: siteKey('api-keys'), queryFn: async () => (await client.rawRequest<ApiKey[]>('/api/v1/api-keys')).data });
  const roles = useQuery({ queryKey: siteKey('roles'), queryFn: async () => (await client.rawRequest<Array<{ id: string; name: string }>>('/api/v1/roles')).data });
  const policies = useQuery({ queryKey: siteKey('policies'), queryFn: async () => (await client.rawRequest<Array<{ id: string; name: string }>>('/api/v1/policies')).data });
  const [name, setName] = useState('');
  const [shown, setShown] = useState<{ name: string; token: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: siteKey('api-keys') });

  const create = useMutation({
    mutationFn: async () => (await client.rawRequest<ApiKey & { token: string }>('/api/v1/api-keys', { method: 'POST', body: JSON.stringify({ name: name.trim() }) })).data,
    onSuccess: (key) => {
      setShown({ name: key.name, token: key.token });
      setCopied(false);
      setName('');
      void refresh();
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => client.rawRequest(`/api/v1/api-keys/${encodeURIComponent(id)}/revoke`, { method: 'POST', body: '{}' }),
    onSuccess: () => {
      setRevoking(null);
      void refresh();
    },
  });

  const scopeOf = (k: ApiKey) => {
    const names = [
      ...k.roles.map((r) => roles.data?.find((x) => x.id === r.roleId)?.name ?? r.roleId),
      ...k.policies.map((p) => policies.data?.find((x) => x.id === p.policyId)?.name ?? p.policyId),
    ];
    return names.length ? names.join(', ') : t('apiKeys.noScope');
  };

  return (
    <>
      <PageHeader
        title={t('apiKeys.title')}
        description={t('apiKeys.description')}
        actions={
          <Link to={withAdminBase(adminBase, '/settings/advanced/access/api-keys') as never} className="rounded-ctl border border-line px-2.5 py-1.5 text-[13px] hover:bg-panel-2">
            {t('apiKeys.permissions')}
          </Link>
        }
      />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) create.mutate();
        }}
        className="mb-5 flex flex-wrap items-end gap-2 rounded-card border border-line bg-panel p-4"
      >
        <div className="flex min-w-[220px] flex-1 flex-col gap-1">
          <label htmlFor="key-name" className="text-[13px] font-medium">
            {t('apiKeys.name')}
          </label>
          <input id="key-name" className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder={t('apiKeys.namePlaceholder')} />
        </div>
        <button type="submit" disabled={!name.trim() || create.isPending} className="rounded-ctl bg-brand px-3 py-1.5 text-[13px] text-brand-fg disabled:opacity-50">
          {t('apiKeys.create')}
        </button>
        {create.error ? (
          <p role="alert" className="w-full text-[12.5px] text-bad">
            {create.error instanceof Error ? create.error.message : String(create.error)}
          </p>
        ) : null}
      </form>

      {keys.isLoading ? (
        <Skeleton className="h-40" />
      ) : (keys.data ?? []).length === 0 ? (
        <p className="text-[13px] text-dim">{t('apiKeys.empty')}</p>
      ) : (
        <div className="overflow-x-auto rounded-card border border-line bg-panel">
          <table className="w-full min-w-[680px] text-left text-[13px]">
            <caption className="sr-only">{t('apiKeys.title')}</caption>
            <thead className="t-aux">
              <tr className="border-b border-line">
                <th className="px-4 py-2">{t('apiKeys.name')}</th>
                <th className="px-4 py-2">{t('apiKeys.key')}</th>
                <th className="px-4 py-2">{t('apiKeys.scope')}</th>
                <th className="px-4 py-2">{t('apiKeys.created')}</th>
                <th className="px-4 py-2">{t('apiKeys.lastUsed')}</th>
                <th className="px-4 py-2">
                  <span className="sr-only">{t('apiKeys.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {(keys.data ?? []).map((k) => (
                <tr key={k.id} data-key={k.name} className={cn('border-b border-line last:border-0', k.revokedAt && 'text-dim')}>
                  <td className="px-4 py-2 font-medium">{k.name}</td>
                  <td className="px-4 py-2 font-mono text-[12px]">{k.last4 ? `••••${k.last4}` : `${k.prefix}…`}</td>
                  <td className="px-4 py-2">{scopeOf(k)}</td>
                  <td className="px-4 py-2 t-aux">
                    <RelativeTime value={k.createdAt} />
                  </td>
                  <td className="px-4 py-2 t-aux">
                    {k.lastUsedAt ? <RelativeTime value={k.lastUsedAt} /> : t('apiKeys.never')}
                    {staleKey(k) ? <span className="ml-2 rounded-full bg-warn-soft px-1.5 py-0.5 text-[11px] text-warn">{t('apiKeys.stale')}</span> : null}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {k.revokedAt ? (
                      <span className="t-aux">{t('apiKeys.revoked')}</span>
                    ) : (
                      <button type="button" onClick={() => setRevoking(k)} className="rounded-ctl px-2 py-1 text-[12.5px] text-bad hover:bg-bad-soft">
                        {t('apiKeys.revoke')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {shown ? (
        <div role="dialog" aria-modal="true" aria-labelledby="key-shown-title" className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4">
          <div className="w-full max-w-lg rounded-card border border-line bg-panel p-5 shadow-lg">
            <h2 id="key-shown-title" className="t-section">
              {t('apiKeys.shownTitle', { name: shown.name })}
            </h2>
            <p className="mt-2 text-[13px] text-warn">{t('apiKeys.shownOnce')}</p>
            <div className="mt-3 flex items-center gap-2">
              <code aria-label={t('apiKeys.fullKey')} className="min-w-0 flex-1 break-all rounded-ctl bg-panel-2 px-2 py-1.5 text-[12px]">
                {shown.token}
              </code>
              <button
                type="button"
                onClick={() => void navigator.clipboard?.writeText(shown.token).then(() => setCopied(true), () => setCopied(false))}
                className="inline-flex items-center gap-1 rounded-ctl border border-line px-2 py-1.5 text-[12.5px]"
              >
                <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                {copied ? t('apiKeys.copied') : t('apiKeys.copy')}
              </button>
            </div>
            <div className="mt-4 flex justify-end">
              <button type="button" onClick={() => setShown(null)} className="rounded-ctl bg-brand px-3 py-1.5 text-[13px] text-brand-fg">
                {t('apiKeys.done')}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {revoking ? (
        <div role="dialog" aria-modal="true" aria-labelledby="key-revoke-title" className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4">
          <div className="w-full max-w-md rounded-card border border-line bg-panel p-5 shadow-lg">
            <h2 id="key-revoke-title" className="t-section">
              {t('apiKeys.revokeTitle', { name: revoking.name })}
            </h2>
            <p className="mt-2 text-[13px]">{t('apiKeys.revokeBody')}</p>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setRevoking(null)} className="rounded-ctl border border-line px-3 py-1.5 text-[13px]">
                {t('apiKeys.cancel')}
              </button>
              <button type="button" disabled={revoke.isPending} onClick={() => revoke.mutate(revoking.id)} className="rounded-ctl bg-bad px-3 py-1.5 text-[13px] text-white">
                {t('apiKeys.revokeConfirm')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
