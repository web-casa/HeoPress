// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '@/workspace/ui/page-header';
import {
  GitBranch,
  Plus,
  Trash2,
  Save,
  KeyRound,
  RefreshCw,
  ExternalLink,
  GitPullRequest,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { useSaveHandler } from '@/lib/keybindings/use-keybindings';
import type {
  GitIntegrationResource,
  PullRequestResource,
} from '@heopress/contracts/schemas';
import { gitApi, type CreateIntegrationPayload } from './git-api';

const CI_BADGE: Record<string, string> = {
  success: 'bg-ok-soft text-ok',
  failure: 'bg-bad-soft text-bad',
  pending: 'bg-warn-soft text-warn',
  unknown: 'bg-panel-2 text-dim',
};

export function GitIntegrationsPage() {
  const { t } = useTranslation('siteOps');
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: ['git-integrations'],
    queryFn: () => gitApi.list(),
  });

  const [creating, setCreating] = useState(false);
  const [viewing, setViewing] = useState<GitIntegrationResource | null>(null);
  const integrations = query.data ?? [];

  const deleteMutation = useMutation({
    mutationFn: (id: string) => gitApi.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['git-integrations'] }),
  });

  const rotateMutation = useMutation({
    mutationFn: (id: string) => gitApi.rotateSecret(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['git-integrations'] }),
  });

  const authorize = async (id: string) => {
    try {
      const { authorizeUrl } = await gitApi.authorize(id);
      window.open(authorizeUrl, '_blank', 'noopener');
    } catch (e) {
      alert((e as Error).message);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('git.title')}
        description={t('git.description')}
        actions={
          <button type="button" onClick={() => setCreating(true)} className="inline-flex items-center gap-2 rounded-ctl bg-brand px-3 py-1.5 text-[13px] text-brand-fg disabled:opacity-50">
            <Plus className="h-4 w-4" /> {t('git.connect')}
          </button>
        }
      />

      <div className="grid gap-4">
        {query.isLoading && (
          <div className="text-dim">{t('common:loading')}</div>
        )}
        {query.isError && (
          <div className="rounded-card border border-bad/40 bg-bad-soft p-4 text-sm text-bad">
            {(query.error as Error).message}
          </div>
        )}
        {integrations.length === 0 && !query.isLoading && !query.isError && (
          <div className="rounded-card border border-dashed p-12 text-center text-dim border-line">
            {t('git.empty')}
          </div>
        )}
        {integrations.map((it) => (
          <div
            key={it.id}
            className="rounded-card border bg-panel p-4 border-line"
          >
            <div className="flex items-start justify-between">
              <div className="flex items-start gap-4">
                <div className="mt-1 flex h-10 w-10 items-center justify-center rounded-card bg-brand-soft text-brand">
                  <GitBranch className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="font-semibold">
                    {it.displayName}{' '}
                    <span className="text-xs font-normal text-dim">
                      ({it.provider})
                    </span>
                  </h3>
                  <p className="text-sm text-dim">
                    {it.repoFullName}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <span
                      className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${
                        it.status === 'connected'
                          ? 'bg-ok-soft text-ok'
                          : it.status === 'error'
                            ? 'bg-bad-soft text-bad'
                            : 'bg-panel-2 text-dim'
                      }`}
                    >
                      {t(`git.status.${it.status}`, { defaultValue: it.status })}
                    </span>
                    <span className="text-xs text-dim">
                      {it.authMethod === 'app' ? t('git.appInstall') : t('git.oauthPat')}
                    </span>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  title={t('git.viewPrs')}
                  onClick={() => setViewing(it)}
                  className="text-dim hover:text-fg"
                >
                  <GitPullRequest className="h-4 w-4" />
                </button>
                {it.authMethod === 'pat' && (
                  <button
                    title={t('git.authorize')}
                    onClick={() => authorize(it.id)}
                    className="text-dim hover:text-fg"
                  >
                    <ExternalLink className="h-4 w-4" />
                  </button>
                )}
                <button
                  title={t('git.rotate')}
                  onClick={() => {
                    if (confirm(t('git.confirmRotate')))
                      rotateMutation.mutate(it.id);
                  }}
                  className="text-dim hover:text-fg"
                >
                  <KeyRound className="h-4 w-4" />
                </button>
                <button
                  title={t('git.disconnect')}
                  onClick={() => {
                    if (confirm(t('git.confirmDisconnect')))
                      deleteMutation.mutate(it.id);
                  }}
                  className="text-dim hover:text-bad"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
            <div className="mt-3 rounded-ctl bg-panel-2 p-2 text-xs text-dim">
              <span className="font-medium">{t('git.webhookUrl')}</span>{' '}
              <code className="break-all">{it.webhookUrl}</code>
            </div>
          </div>
        ))}
      </div>

      {creating && <CreateDialog onClose={() => setCreating(false)} />}
      {viewing && (
        <PullRequestsDrawer
          integration={viewing}
          onClose={() => setViewing(null)}
        />
      )}
    </div>
  );
}

function CreateDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('siteOps');
  const qc = useQueryClient();
  const [provider, setProvider] = useState<'github' | 'gitlab'>('github');
  const [repoFullName, setRepoFullName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [authMethod, setAuthMethod] = useState<'app' | 'pat'>('pat');
  const [token, setToken] = useState('');
  const [installationId, setInstallationId] = useState('');

  const mutation = useMutation({
    mutationFn: () => {
      const payload: CreateIntegrationPayload = {
        provider,
        repoFullName,
        displayName: displayName || repoFullName,
        authMethod,
        ...(authMethod === 'pat' && token ? { token } : {}),
        ...(authMethod === 'app' && installationId ? { installationId } : {}),
      };
      return gitApi.create(payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['git-integrations'] });
      onClose();
    },
  });

  const valid =
    !!repoFullName &&
    (authMethod === 'pat' ? !!token : !!installationId);

  useSaveHandler(() => mutation.mutate(), !mutation.isPending && valid);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-card border bg-panel p-6 border-line">
        <h2 className="mb-4 t-section">{t('git.connect')}</h2>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1 block text-sm font-medium">{t('git.provider')}</label>
              <select
                value={provider}
                onChange={(e) =>
                  setProvider(e.target.value as 'github' | 'gitlab')
                }
                className="w-full rounded-ctl border border-line bg-bg px-2.5 py-1.5 text-[13px] outline-none focus:border-brand"
              >
                <option value="github">{t('git.providers.github')}</option>
                <option value="gitlab">{t('git.providers.gitlab')}</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">{t('git.auth')}</label>
              <select
                value={authMethod}
                onChange={(e) =>
                  setAuthMethod(e.target.value as 'app' | 'pat')
                }
                className="w-full rounded-ctl border border-line bg-bg px-2.5 py-1.5 text-[13px] outline-none focus:border-brand"
              >
                <option value="pat">{t('git.oauthPat')}</option>
                <option value="app">{t('git.appInstallation')}</option>
              </select>
            </div>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">
              {t('git.repository')}
            </label>
            <input
              type="text"
              value={repoFullName}
              onChange={(e) => setRepoFullName(e.target.value)}
              placeholder={t('git.repoPlaceholder')}
              className="w-full rounded-ctl border border-line bg-bg px-2.5 py-1.5 text-[13px] outline-none focus:border-brand"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">
              {t('git.displayName')}
            </label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="w-full rounded-ctl border border-line bg-bg px-2.5 py-1.5 text-[13px] outline-none focus:border-brand"
            />
          </div>
          {authMethod === 'pat' ? (
            <div>
              <label className="mb-1 block text-sm font-medium">
                {t('git.token')}
              </label>
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder={t('git.tokenPlaceholder')}
                className="w-full rounded-ctl border border-line bg-bg px-2.5 py-1.5 text-[13px] outline-none focus:border-brand"
              />
              <p className="mt-1 text-xs text-dim">
                {t('git.tokenHelp')}
              </p>
            </div>
          ) : (
            <div>
              <label className="mb-1 block text-sm font-medium">
                {t('git.installationId')}
              </label>
              <input
                type="text"
                value={installationId}
                onChange={(e) => setInstallationId(e.target.value)}
                className="w-full rounded-ctl border border-line bg-bg px-2.5 py-1.5 text-[13px] outline-none focus:border-brand"
              />
            </div>
          )}
          {mutation.isError && (
            <p className="text-sm text-bad">
              {(mutation.error as Error).message}
            </p>
          )}
          <div className="mt-6 flex justify-end gap-2">
            <button
              onClick={onClose}
              className="rounded-ctl px-4 py-2 text-sm font-medium hover:bg-panel-2"
            >
              {t('common:cancel')}
            </button>
            <button
              onClick={() => mutation.mutate()}
              disabled={!valid || mutation.isPending}
              className="rounded-ctl bg-brand px-3 py-1.5 text-[13px] text-brand-fg disabled:opacity-50"
            >
              <Save className="mr-2 inline h-4 w-4" />
              {mutation.isPending ? t('git.connecting') : t('git.connectShort')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function PullRequestsDrawer({
  integration,
  onClose,
}: {
  integration: GitIntegrationResource;
  onClose: () => void;
}) {
  const { t } = useTranslation('siteOps');
  const qc = useQueryClient();
  const [log, setLog] = useState<{ pr: number; text: string } | null>(null);

  const prsQuery = useQuery({
    queryKey: ['git-prs', integration.id],
    queryFn: () => gitApi.listPullRequests(integration.id),
  });

  const refresh = useMutation({
    mutationFn: () => gitApi.refreshPullRequests(integration.id),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ['git-prs', integration.id] }),
  });

  const prs = prsQuery.data ?? [];

  const validate = async (prNumber: number) => {
    try {
      const r = await gitApi.validate(integration.id, prNumber);
      alert(
        t('git.validationResult', { state: r.state, summary: r.summary }) +
          (r.statusPosted ? '' : `\n${t('git.statusNotPosted')}`),
      );
    } catch (e) {
      alert((e as Error).message);
    }
  };

  const viewLogs = async (prNumber: number) => {
    try {
      const runs = await gitApi.listCi(integration.id, prNumber);
      if (runs.length === 0) {
        setLog({ pr: prNumber, text: t('git.noCiRuns') });
        return;
      }
      const { log: text } = await gitApi.fetchLog(
        integration.id,
        runs[0]!.providerRunId,
      );
      setLog({ pr: prNumber, text });
    } catch (e) {
      setLog({ pr: prNumber, text: (e as Error).message });
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40 backdrop-blur-sm">
      <div className="flex h-full w-full max-w-xl flex-col border-l bg-panel border-line">
        <div className="flex items-center justify-between border-b p-4 border-line">
          <div>
            <h2 className="font-semibold">{t('git.pullRequests')}</h2>
            <p className="text-xs text-dim">
              {integration.repoFullName}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => refresh.mutate()}
              disabled={refresh.isPending}
              className="inline-flex items-center gap-1 rounded-ctl border px-2 py-1 text-xs hover:bg-panel-2 disabled:opacity-50 border-line"
            >
              <RefreshCw
                className={`h-3 w-3 ${refresh.isPending ? 'animate-spin' : ''}`}
              />
              {t('git.refresh')}
            </button>
            <button onClick={onClose} className="hover:text-bad">
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div className="flex-1 space-y-2 overflow-y-auto p-4">
          {prsQuery.isLoading && (
            <div className="text-dim">{t('common:loading')}</div>
          )}
          {prs.length === 0 && !prsQuery.isLoading && (
            <div className="rounded-card border border-dashed p-8 text-center text-sm text-dim border-line">
              {t('git.noPrs')}
            </div>
          )}
          {prs.map((pr: PullRequestResource) => (
            <div key={pr.id} className="rounded-card border p-3 border-line">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">
                  #{pr.number} {pr.title}
                </span>
                <span
                  className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${
                    CI_BADGE[pr.ciStatus] ?? CI_BADGE.unknown
                  }`}
                >
                  {t(`git.ci.${pr.ciStatus}`, { defaultValue: pr.ciStatus })}
                </span>
              </div>
              <div className="mt-1 flex items-center justify-between text-xs text-dim">
                <span>
                  {t(`git.prState.${pr.state}`, { defaultValue: pr.state })} · {pr.author ?? t('git.unknownAuthor')}
                </span>
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => validate(pr.number)}
                    className="text-brand hover:underline"
                  >
                    {t('git.validate')}
                  </button>
                  <button
                    onClick={() => viewLogs(pr.number)}
                    className="text-brand hover:underline"
                  >
                    {t('git.viewLog')}
                  </button>
                  {pr.previewUrl && (
                    <a
                      href={pr.previewUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-brand hover:underline"
                    >
                      {t('git.preview')} <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>

        {log && (
          <div className="max-h-[40%] overflow-auto border-t bg-black p-3 font-mono text-xs text-green-200 border-line">
            <div className="mb-2 flex items-center justify-between text-green-400">
              <span>{t('git.logTitle', { pr: log.pr })}</span>
              <button onClick={() => setLog(null)}>
                <X className="h-4 w-4" />
              </button>
            </div>
            <pre className="whitespace-pre-wrap">{log.text}</pre>
          </div>
        )}
      </div>
    </div>
  );
}
