import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getApiClient } from '@/lib/api';
import { PageHeader } from '../ui/page-header';
import { Skeleton } from '../ui/skeleton';
import { grantableGroups, toggle, TOOL_GROUPS, type ConsentRequestView, type ToolGroup } from './agent-access-api';

/**
 * The OAuth consent page (HeoPress P10 task 1.2; spec agents/mcp-access "OAuth 2.1 授权"): an agent asked to act for
 * the signed-in person. They tick the sites and tool groups it may use; the decision goes back to the agent.
 * Nothing is ticked for them except the read-only group.
 */
export function AgentConsentPage() {
  const { t } = useTranslation('agentAccess');
  const client = getApiClient();
  const request = new URLSearchParams(window.location.search).get('request') ?? '';
  const view = useQuery({
    queryKey: ['agent-consent', request],
    queryFn: async () => (await client.rawRequest<ConsentRequestView>(`/api/v1/agent-access/consent?request=${encodeURIComponent(request)}`)).data,
    retry: false,
  });
  const [sites, setSites] = useState<string[] | null>(null);
  const [groups, setGroups] = useState<ToolGroup[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const decide = useMutation({
    mutationFn: async (approve: boolean) =>
      (
        await client.rawRequest<{ redirectTo: string }>('/api/v1/agent-access/consent', {
          method: 'POST',
          body: JSON.stringify({ request, approve, siteIds: chosenSites, toolGroups: chosenGroups }),
        })
      ).data,
    onSuccess: (out) => window.location.assign(out.redirectTo),
  });

  if (view.isLoading) return <Skeleton className="h-64" />;
  if (view.isError || !view.data) {
    return (
      <p role="alert" className="rounded-card border border-line bg-panel p-4 text-[13px] text-bad">
        {t('consent.invalid')}
      </p>
    );
  }
  const data = view.data;
  const allowed = grantableGroups(data);
  const chosenSites = sites ?? [];
  const chosenGroups = groups ?? (allowed.includes('read') ? ['read' as ToolGroup] : []);
  const name = data.client.name ?? data.client.id;

  const submit = (approve: boolean) => {
    if (approve && chosenSites.length === 0) return setProblem(t('consent.chooseSite'));
    if (approve && chosenGroups.length === 0) return setProblem(t('consent.chooseGroup'));
    setProblem(null);
    decide.mutate(approve);
  };

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title={t('consent.title')} description={t('consent.intro', { client: name })} />
      <form
        aria-label={t('consent.title')}
        onSubmit={(e) => {
          e.preventDefault();
          submit(true);
        }}
        className="space-y-5 rounded-card border border-line bg-panel p-5"
      >
        <fieldset>
          <legend className="t-section">{t('consent.sites')}</legend>
          <p className="t-aux mb-2">{t('consent.sitesHint')}</p>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {data.sites.map((s) => (
              <label key={s.id} className="flex items-center gap-2 text-[13px]">
                <input type="checkbox" checked={chosenSites.includes(s.id)} onChange={() => setSites(toggle(chosenSites, s.id, data.sites.map((x) => x.id)))} />
                <span>{s.name}</span>
                <span className="t-aux font-mono">{s.id}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend className="t-section">{t('consent.tools')}</legend>
          <div className="mt-2 space-y-1.5">
            {TOOL_GROUPS.map((g) => {
              const enabled = allowed.includes(g);
              return (
                <label key={g} className="flex items-start gap-2 text-[13px]">
                  <input type="checkbox" className="mt-0.5" disabled={!enabled} checked={chosenGroups.includes(g)} onChange={() => setGroups(toggle(chosenGroups, g, TOOL_GROUPS))} />
                  <span>
                    <span className="font-medium">{t(`groups.${g}`)}</span>
                    <span className="t-aux block">{enabled ? t(`groupHints.${g}`) : t('consent.notRequested')}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
        {data.client.redirectHost ? <p className="t-aux">{t('consent.redirect', { host: data.client.redirectHost })}</p> : null}
        {problem || decide.error ? (
          <p role="alert" className="text-[12.5px] text-bad">
            {problem ?? t('consent.failed', { reason: decide.error instanceof Error ? decide.error.message : String(decide.error) })}
          </p>
        ) : null}
        {decide.isSuccess ? <p role="status">{t('consent.redirecting')}</p> : null}
        <div className="flex justify-end gap-2">
          <button type="button" disabled={decide.isPending} onClick={() => submit(false)} className="rounded-ctl border border-line px-3 py-1.5 text-[13px]">
            {t('consent.deny')}
          </button>
          <button type="submit" disabled={decide.isPending} className="rounded-ctl bg-brand px-3 py-1.5 text-[13px] text-brand-fg disabled:opacity-50">
            {t('consent.approve')}
          </button>
        </div>
      </form>
    </div>
  );
}
