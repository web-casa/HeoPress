// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '@/workspace/ui/page-header';
import {
  Rocket,
  Plus,
  Trash2,
  RefreshCw,
  ScrollText,
  CheckCircle2,
  XCircle,
  Loader2,
  Clock,
  Ban,
} from 'lucide-react';
import { useState } from 'react';
import { getApiClient } from '@/lib/api';
import type { DeploymentResource, DeploymentTargetResource } from '@heopress/sdk';
import { StaticSiteSection, VercelHobbyNotice } from './static-site-section';

const STATUS_STYLE: Record<string, { cls: string; Icon: typeof CheckCircle2 }> = {
  ready: { cls: 'bg-ok-soft text-ok', Icon: CheckCircle2 },
  building: { cls: 'bg-warn-soft text-warn', Icon: Loader2 },
  queued: { cls: 'bg-brand-soft text-brand', Icon: Clock },
  error: { cls: 'bg-bad-soft text-bad', Icon: XCircle },
  canceled: { cls: 'bg-panel-2 text-dim', Icon: Ban },
};

const FALLBACK_STYLE = { cls: 'bg-panel-2 text-dim', Icon: Clock };

function StatusBadge({ status }: { status: string }) {
  const { t } = useTranslation('siteOps');
  const { Icon, cls } = STATUS_STYLE[status] ?? FALLBACK_STYLE;
  return (
    <span className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium ${cls}`}>
      <Icon className={`h-3 w-3 ${status === 'building' ? 'animate-spin' : ''}`} />
      {t(`deployments.status.${status}`, { defaultValue: status })}
    </span>
  );
}

export function DeploymentsPage() {
  const { t } = useTranslation('siteOps');
  const client = getApiClient();
  const qc = useQueryClient();

  const targetsQuery = useQuery({
    queryKey: ['deployment-targets'],
    queryFn: async () => (await client.deployments.targets.list()).data ?? [],
  });

  const deploymentsQuery = useQuery({
    queryKey: ['deployments'],
    queryFn: async () => (await client.deployments.list()).data ?? [],
    // Poll while any deployment is in flight so the UI tracks status (Req 8.5).
    refetchInterval: (query) => {
      const data = query.state.data as DeploymentResource[] | undefined;
      return data?.some((d) => d.status === 'queued' || d.status === 'building') ? 5000 : false;
    },
  });

  const [creating, setCreating] = useState(false);
  const [logsFor, setLogsFor] = useState<DeploymentResource | null>(null);

  const targets = targetsQuery.data ?? [];
  const deployments = deploymentsQuery.data ?? [];

  const deployMutation = useMutation({
    mutationFn: (targetId: string) => client.deployments.targets.deploy(targetId, { reason: 'manual deploy from Studio' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['deployments'] }),
  });

  const refreshMutation = useMutation({
    mutationFn: (id: string) => client.deployments.refresh(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['deployments'] }),
  });

  const deleteTargetMutation = useMutation({
    mutationFn: (id: string) => client.deployments.targets.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['deployment-targets'] }),
  });

  const targetName = (id: string) => targets.find((target) => target.id === id)?.name ?? id;

  return (
    <div className="space-y-8">
      <PageHeader
        title={t('deployments.title')}
        description={t('deployments.description')}
        actions={
          <button type="button" onClick={() => setCreating(true)} className="inline-flex items-center gap-2 rounded-ctl bg-brand px-3 py-1.5 text-[13px] text-brand-fg disabled:opacity-50">
            <Plus className="h-4 w-4" /> {t('deployments.connectTarget')}
          </button>
        }
      />

      <StaticSiteSection targets={targets} />

      {/* Targets ------------------------------------------------------------ */}
      <section className="space-y-3">
        <h2 className="t-section">{t('deployments.targets')}</h2>
        {targetsQuery.isLoading && <div className="text-dim">{t('common:loading')}</div>}
        {targets.length === 0 && !targetsQuery.isLoading && (
          <div className="rounded-card border border-dashed p-10 text-center text-dim border-line">
            {t('deployments.noTargets')}
          </div>
        )}
        <div className="grid gap-3">
          {targets.map((target) => (
            <div key={target.id} className="flex items-center justify-between rounded-card border bg-panel p-4 border-line">
              <div className="flex items-start gap-4">
                <div className="mt-1 flex h-10 w-10 items-center justify-center rounded-card bg-brand-soft text-brand">
                  <Rocket className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="font-semibold">
                    {target.name} <span className="text-xs font-normal text-dim">({target.provider})</span>
                  </h3>
                  <p className="text-sm text-dim">
                    {target.projectId}
                    {target.defaultBranch ? ` · ${target.defaultBranch}` : ''}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => deployMutation.mutate(target.id)}
                  disabled={deployMutation.isPending || target.status !== 'active'}
                  className="inline-flex items-center gap-1.5 rounded-ctl bg-brand px-2.5 py-1.5 text-[13px] text-brand-fg disabled:opacity-50"
                >
                  <Rocket className="h-3.5 w-3.5" /> {t('deployments.deployNow')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (confirm(t('deployments.confirmDelete'))) deleteTargetMutation.mutate(target.id);
                  }}
                  className="text-dim hover:text-bad"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Deployments -------------------------------------------------------- */}
      <section className="space-y-3">
        <h2 className="t-section">{t('deployments.recent')}</h2>
        {deployments.length === 0 && !deploymentsQuery.isLoading && (
          <div className="rounded-card border border-dashed p-10 text-center text-dim border-line">
            {t('deployments.empty')}
          </div>
        )}
        <div className="overflow-hidden rounded-card border border-line">
          <table className="w-full text-sm">
            <thead className="bg-panel-2 text-left text-[12px] text-dim">
              <tr>
                <th className="px-4 py-2">{t('deployments.col.target')}</th>
                <th className="px-4 py-2">{t('deployments.col.status')}</th>
                <th className="px-4 py-2">{t('deployments.col.branch')}</th>
                <th className="px-4 py-2">{t('deployments.col.url')}</th>
                <th className="px-4 py-2 text-right">{t('deployments.col.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {deployments.map((d) => (
                <tr key={d.id} className="border-t border-line">
                  <td className="px-4 py-2 font-medium">{targetName(d.targetId)}</td>
                  <td className="px-4 py-2"><StatusBadge status={d.status} /></td>
                  <td className="px-4 py-2 text-dim">
                    {d.branch ?? '—'}
                    {d.commitSha ? ` · ${d.commitSha.slice(0, 7)}` : ''}
                  </td>
                  <td className="px-4 py-2">
                    {d.url ? (
                      <a href={d.url} target="_blank" rel="noreferrer" className="text-brand hover:underline">
                        {t('common:open')}
                      </a>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        type="button"
                        title={t('deployments.refreshStatus')}
                        onClick={() => refreshMutation.mutate(d.id)}
                        className="text-dim hover:text-fg"
                      >
                        <RefreshCw className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        title={t('deployments.viewLogs')}
                        onClick={() => setLogsFor(d)}
                        className="text-dim hover:text-fg"
                      >
                        <ScrollText className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {creating && (
        <CreateTargetDialog
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            qc.invalidateQueries({ queryKey: ['deployment-targets'] });
          }}
        />
      )}

      {logsFor && <LogsDialog deployment={logsFor} onClose={() => setLogsFor(null)} />}
    </div>
  );
}

function CreateTargetDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation('siteOps');
  const client = getApiClient();
  const [form, setForm] = useState({
    provider: 'vercel' as DeploymentTargetResource['provider'],
    name: '',
    projectId: '',
    token: '',
    defaultBranch: '',
  });
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      client.deployments.targets.create({
        provider: form.provider,
        name: form.name,
        projectId: form.projectId,
        token: form.token,
        defaultBranch: form.defaultBranch || undefined,
      }),
    onSuccess: onSaved,
    onError: (err: unknown) => setError(err instanceof Error ? err.message : t('deployments.saveFailed')),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-card border bg-panel p-6 border-line">
        <h2 className="t-section">{t('deployments.connectTitle')}</h2>
        <p className="mt-1 text-sm text-dim">
          {t('deployments.tokenNote')}
        </p>
        <div className="mt-4 space-y-3">
          <label className="block text-sm">
            <span className="mb-1 block font-medium">{t('git.provider')}</span>
            <select
              value={form.provider}
              onChange={(e) => setForm({ ...form, provider: e.target.value as DeploymentTargetResource['provider'] })}
              className="w-full rounded-ctl border border-line bg-bg px-2.5 py-1.5 text-[13px] outline-none focus:border-brand"
            >
              <option value="vercel">{t('deployments.providers.vercel')}</option>
              <option value="netlify">{t('deployments.providers.netlify')}</option>
              <option value="cloudflare-pages">{t('deployments.providers.cloudflare-pages')}</option>
            </select>
          </label>
          {form.provider === 'vercel' && <VercelHobbyNotice />}
          <label className="block text-sm">
            <span className="mb-1 block font-medium">{t('email.name')}</span>
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="w-full rounded-ctl border border-line bg-bg px-2.5 py-1.5 text-[13px] outline-none focus:border-brand"
              placeholder={t('deployments.namePlaceholder')}
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium">
              {form.provider === 'vercel' ? t('deployments.vercelProject') : form.provider === 'cloudflare-pages' ? t('deployments.cloudflareProject') : t('deployments.netlifySite')}
            </span>
            {form.provider === 'cloudflare-pages' && <span className="mb-1 block text-xs text-dim">{t('deployments.cloudflareHint')}</span>}
            <input
              value={form.projectId}
              onChange={(e) => setForm({ ...form, projectId: e.target.value })}
              className="w-full rounded-ctl border border-line bg-bg px-2.5 py-1.5 text-[13px] outline-none focus:border-brand"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium">{t('git.token')}</span>
            <input
              type="password"
              value={form.token}
              onChange={(e) => setForm({ ...form, token: e.target.value })}
              className="w-full rounded-ctl border border-line bg-bg px-2.5 py-1.5 text-[13px] outline-none focus:border-brand"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium">{t('deployments.defaultBranch')}</span>
            <input
              value={form.defaultBranch}
              onChange={(e) => setForm({ ...form, defaultBranch: e.target.value })}
              className="w-full rounded-ctl border border-line bg-bg px-2.5 py-1.5 text-[13px] outline-none focus:border-brand"
              placeholder={t('deployments.branchPlaceholder')}
            />
          </label>
          {error && <p className="text-sm text-bad">{error}</p>}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-ctl px-3 py-1.5 text-sm">
            {t('common:cancel')}
          </button>
          <button
            type="button"
            onClick={() => save.mutate()}
            disabled={save.isPending || !form.name || !form.projectId || !form.token}
            className="rounded-ctl bg-brand px-3 py-1.5 text-[13px] text-brand-fg disabled:opacity-50"
          >
            {save.isPending ? t('deployments.verifying') : t('git.connectShort')}
          </button>
        </div>
      </div>
    </div>
  );
}

function LogsDialog({ deployment, onClose }: { deployment: DeploymentResource; onClose: () => void }) {
  const { t } = useTranslation('siteOps');
  const client = getApiClient();
  const logsQuery = useQuery({
    queryKey: ['deployment-logs', deployment.id],
    queryFn: async () => (await client.deployments.logs(deployment.id)).data?.log ?? '',
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="flex h-[70vh] w-full max-w-3xl flex-col rounded-card border bg-panel p-6 border-line">
        <div className="flex items-center justify-between">
          <h2 className="t-section">{t('deployments.buildLog')}</h2>
          <StatusBadge status={deployment.status} />
        </div>
        {deployment.errorMessage && (
          <p className="mt-2 rounded-ctl bg-bad-soft p-2 text-sm text-bad">{deployment.errorMessage}</p>
        )}
        <pre className="mt-3 flex-1 overflow-auto rounded-ctl bg-panel-2 p-3 text-xs leading-relaxed">
          {logsQuery.isLoading ? t('common:loading') : logsQuery.data || deployment.logExcerpt || t('deployments.noLog')}
        </pre>
        <div className="mt-4 flex justify-end">
          <button type="button" onClick={onClose} className="rounded-ctl px-3 py-1.5 text-sm">
            {t('common:close')}
          </button>
        </div>
      </div>
    </div>
  );
}
