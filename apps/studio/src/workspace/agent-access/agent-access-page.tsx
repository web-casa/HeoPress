import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getApiClient } from '@/lib/api';
import { inputClass } from '../seo/seo-kit';
import { PageHeader } from '../ui/page-header';
import { RelativeTime } from '../ui/relative-time';
import { Skeleton } from '../ui/skeleton';
import { toggle, TOOL_GROUPS, type AgentGrant, type GrantsView, type ToolGroup } from './agent-access-api';

/**
 * Settings › Agent access (HeoPress P10 tasks 1.2, 1.3): the agents connected to the signed-in person and their
 * personal access tokens, each with its sites and tool groups; a new token is shown once; revoking ends it at once.
 */
export function AgentAccessPage() {
  const { t } = useTranslation('agentAccess');
  const client = getApiClient();
  const qc = useQueryClient();
  const key = ['agent-access-grants'];
  const view = useQuery({ queryKey: key, queryFn: async () => (await client.rawRequest<GrantsView>('/api/v1/agent-access/grants')).data });
  const [name, setName] = useState('');
  const [sites, setSites] = useState<string[]>([]);
  const [groups, setGroups] = useState<ToolGroup[]>(['read']);
  const [days, setDays] = useState('90');
  const [shown, setShown] = useState<{ name: string; token: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [revoking, setRevoking] = useState<AgentGrant | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: key });

  const create = useMutation({
    mutationFn: async () =>
      (
        await client.rawRequest<{ token: string; grant: AgentGrant }>('/api/v1/agent-access/tokens', {
          method: 'POST',
          body: JSON.stringify({ name: name.trim(), siteIds: sites, toolGroups: groups, expiresInDays: Number(days) }),
        })
      ).data,
    onSuccess: (out) => {
      setShown({ name: out.grant.name, token: out.token });
      setCopied(false);
      setName('');
      void refresh();
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => client.rawRequest(`/api/v1/agent-access/grants/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => {
      setRevoking(null);
      void refresh();
    },
  });

  if (view.isLoading) return <Skeleton className="h-64" />;
  const data = view.data;
  const siteName = (id: string) => data?.sites.find((s) => s.id === id)?.name ?? id;

  return (
    <>
      <PageHeader title={t('page.title')} description={t('page.description')} />
      {data ? (
        <p className="mb-4 text-[13px]">
          <span className="t-aux mr-2">{t('page.endpoint')}</span>
          <code className="rounded-ctl bg-panel-2 px-1.5 py-0.5 text-[12px]">{data.mcpEndpoint}</code>
        </p>
      ) : null}

      <form
        aria-label={t('page.newToken')}
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() && sites.length && groups.length) create.mutate();
        }}
        className="mb-5 space-y-3 rounded-card border border-line bg-panel p-4"
      >
        <h2 className="t-section">{t('page.newToken')}</h2>
        <div className="flex flex-wrap gap-3">
          <div className="flex min-w-[220px] flex-1 flex-col gap-1">
            <label htmlFor="pat-name" className="text-[13px] font-medium">
              {t('page.tokenName')}
            </label>
            <input id="pat-name" className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder={t('page.tokenNamePlaceholder')} />
          </div>
          <div className="flex w-36 flex-col gap-1">
            <label htmlFor="pat-days" className="text-[13px] font-medium">
              {t('page.expiresInDays')}
            </label>
            <input id="pat-days" type="number" min={1} max={365} className={inputClass} value={days} onChange={(e) => setDays(e.target.value)} />
          </div>
        </div>
        <fieldset>
          <legend className="text-[13px] font-medium">{t('page.sites')}</legend>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
            {(data?.sites ?? []).map((s) => (
              <label key={s.id} className="flex items-center gap-1.5 text-[13px]">
                <input type="checkbox" checked={sites.includes(s.id)} onChange={() => setSites(toggle(sites, s.id, (data?.sites ?? []).map((x) => x.id)))} />
                {s.name}
                <span className="t-aux font-mono">{s.id}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend className="text-[13px] font-medium">{t('page.tools')}</legend>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
            {TOOL_GROUPS.map((g) => (
              <label key={g} className="flex items-center gap-1.5 text-[13px]" title={t(`groupHints.${g}`)}>
                <input type="checkbox" checked={groups.includes(g)} onChange={() => setGroups(toggle(groups, g, TOOL_GROUPS))} />
                {t(`groups.${g}`)}
              </label>
            ))}
          </div>
        </fieldset>
        <button type="submit" disabled={!name.trim() || !sites.length || !groups.length || create.isPending} className="rounded-ctl bg-brand px-3 py-1.5 text-[13px] text-brand-fg disabled:opacity-50">
          {t('page.create')}
        </button>
        {create.error ? (
          <p role="alert" className="text-[12.5px] text-bad">
            {t('page.failed', { reason: create.error instanceof Error ? create.error.message : String(create.error) })}
          </p>
        ) : null}
      </form>

      <h2 className="t-section mb-2">{t('page.connected')}</h2>
      {(data?.grants ?? []).length === 0 ? (
        <p className="text-[13px] text-dim">{t('page.empty')}</p>
      ) : (
        <div className="overflow-x-auto rounded-card border border-line bg-panel">
          <table className="w-full min-w-[720px] text-left text-[13px]">
            <caption className="sr-only">{t('page.connected')}</caption>
            <thead className="t-aux">
              <tr className="border-b border-line">
                <th className="px-4 py-2">{t('page.name')}</th>
                <th className="px-4 py-2">{t('page.kind')}</th>
                <th className="px-4 py-2">{t('page.sites')}</th>
                <th className="px-4 py-2">{t('page.tools')}</th>
                <th className="px-4 py-2">{t('page.lastUsed')}</th>
                <th className="px-4 py-2">
                  <span className="sr-only">{t('page.revoke')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {(data?.grants ?? []).map((g) => (
                <tr key={g.id} data-grant={g.name} className="border-b border-line last:border-0">
                  <td className="px-4 py-2 font-medium">
                    {g.name}
                    {g.tokenPrefix ? <span className="t-aux ml-2 font-mono">{g.tokenPrefix}…</span> : null}
                  </td>
                  <td className="px-4 py-2">{g.kind === 'pat' ? t('page.kindPat') : t('page.kindOauth')}</td>
                  <td className="px-4 py-2">{g.siteIds.map(siteName).join(', ')}</td>
                  <td className="px-4 py-2">{g.toolGroups.map((x) => t(`groups.${x}`)).join(', ')}</td>
                  <td className="px-4 py-2 t-aux">{g.lastUsedAt ? <RelativeTime value={g.lastUsedAt} /> : t('page.never')}</td>
                  <td className="px-4 py-2 text-right">
                    <button type="button" onClick={() => setRevoking(g)} className="rounded-ctl px-2 py-1 text-[12.5px] text-bad hover:bg-bad-soft">
                      {t('page.revoke')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {shown ? (
        <div role="dialog" aria-modal="true" aria-labelledby="pat-shown-title" className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4">
          <div className="w-full max-w-lg rounded-card border border-line bg-panel p-5 shadow-lg">
            <h2 id="pat-shown-title" className="t-section">
              {t('page.shownTitle', { name: shown.name })}
            </h2>
            <p className="mt-2 text-[13px] text-warn">{t('page.shownOnce')}</p>
            <div className="mt-3 flex items-center gap-2">
              <code aria-label={t('page.fullToken')} className="min-w-0 flex-1 break-all rounded-ctl bg-panel-2 px-2 py-1.5 text-[12px]">
                {shown.token}
              </code>
              <button
                type="button"
                onClick={() => void navigator.clipboard?.writeText(shown.token).then(() => setCopied(true), () => setCopied(false))}
                className="inline-flex items-center gap-1 rounded-ctl border border-line px-2 py-1.5 text-[12.5px]"
              >
                <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                {copied ? t('page.copied') : t('page.copy')}
              </button>
            </div>
            <div className="mt-4 flex justify-end">
              <button type="button" onClick={() => setShown(null)} className="rounded-ctl bg-brand px-3 py-1.5 text-[13px] text-brand-fg">
                {t('page.done')}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {revoking ? (
        <div role="dialog" aria-modal="true" aria-labelledby="grant-revoke-title" className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4">
          <div className="w-full max-w-md rounded-card border border-line bg-panel p-5 shadow-lg">
            <h2 id="grant-revoke-title" className="t-section">
              {t('page.revokeTitle', { name: revoking.name })}
            </h2>
            <p className="mt-2 text-[13px]">{t('page.revokeBody')}</p>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setRevoking(null)} className="rounded-ctl border border-line px-3 py-1.5 text-[13px]">
                {t('page.cancel')}
              </button>
              <button type="button" disabled={revoke.isPending} onClick={() => revoke.mutate(revoking.id)} className="rounded-ctl bg-bad px-3 py-1.5 text-[13px] text-white">
                {t('page.revokeConfirm')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
