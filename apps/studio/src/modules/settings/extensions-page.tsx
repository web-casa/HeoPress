// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Puzzle, Upload, Power, ShieldAlert, ArrowUpCircle } from 'lucide-react';
import { useState } from 'react';
import { getApiClient } from '@/lib/api';
import type { ExtensionResource } from '@heopress/sdk';
import { manifestCapabilities } from '@heopress/contracts/schemas';
import { validateCapabilities } from '@heopress/contracts/extensions';
import { PageHeader } from '@/workspace/ui/page-header';
import { PermissionApprovalDialog, PermissionList, apiErrorMessage } from './extension-permissions';
import { ExtensionErrorNotice, PluginCollections } from './plugin-collections';

/** Example values, not translated. */
const EXAMPLES = { bundleUrl: 'https://example.com/bundle.js', name: 'acme-glossary', capabilities: 'items:read:posts\next:events' };
const TYPES = ['hook', 'endpoint', 'panel', 'module', 'interface', 'display', 'layout'] as const;

interface InstallForm {
  name: string;
  version: string;
  type: (typeof TYPES)[number];
  bundleUrl: string;
  capabilities: string;
  outboundHosts: string;
}

const lines = (text: string) => text.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);

type Approval =
  | { kind: 'install'; capabilities: string[] }
  | { kind: 'upgrade'; ext: ExtensionResource }
  | { kind: 'confirm'; ext: ExtensionResource };

export function ExtensionsPage() {
  const { t } = useTranslation(['system', 'common']);
  const client = getApiClient();
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ['extensions'] });

  const extensionsQuery = useQuery({
    queryKey: ['extensions'],
    queryFn: async () => (await client.extensions.list()).data,
  });
  const extensions = extensionsQuery.data ?? [];

  const [approval, setApproval] = useState<Approval | null>(null);
  const [form, setForm] = useState<InstallForm>({ name: '', version: '1.0.0', type: 'hook', bundleUrl: '', capabilities: '', outboundHosts: '' });
  const [formError, setFormError] = useState<string | null>(null);

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => client.extensions.update(id, { enabled }),
    onSettled: refresh,
  });
  const deleteMutation = useMutation({
    mutationFn: (id: string) => client.extensions.delete(id),
    onSuccess: refresh,
  });

  /** Install / approve upgrade / confirm, each with exactly the capabilities shown in the dialog. */
  const approveMutation = useMutation({
    mutationFn: async (a: Approval) => {
      if (a.kind === 'install') {
        return client.extensions.create({
          name: form.name, version: form.version, type: form.type, bundleUrl: form.bundleUrl, enabled: false,
          capabilities: lines(form.capabilities),
          manifest: lines(form.outboundHosts).length ? { outboundHosts: lines(form.outboundHosts) } : {},
          approvedCapabilities: a.capabilities,
        });
      }
      if (a.kind === 'upgrade') return client.extensions.approveUpgrade(a.ext.id, a.ext.pendingUpgrade!.requestedCapabilities);
      return client.extensions.confirmPermissions(a.ext.id, a.ext.capabilities);
    },
    onSuccess: (_data, a) => {
      if (a.kind === 'install') setForm({ name: '', version: '1.0.0', type: 'hook', bundleUrl: '', capabilities: '', outboundHosts: '' });
      setApproval(null);
      void refresh();
    },
  });
  const rejectMutation = useMutation({
    mutationFn: (id: string) => client.extensions.rejectUpgrade(id),
    onSuccess: refresh,
  });

  const review = () => {
    setFormError(null);
    const capabilities = lines(form.capabilities);
    const errors = validateCapabilities(capabilities).errors;
    if (errors.length > 0) {
      setFormError(errors.map((e) => `${e.capability}: ${e.reason}`).join('; '));
      return;
    }
    approveMutation.reset();
    setApproval({ kind: 'install', capabilities: manifestCapabilities({ capabilities, outboundHosts: lines(form.outboundHosts) }) });
  };

  const input = 'w-full rounded-ctl border border-line bg-panel px-3 py-1.5 text-sm outline-none focus:border-brand';

  return (
    <div className="space-y-6">
      <PageHeader title={t('extensions.title')} description={t('extensions.description')} />

      <form
        className="grid gap-2 rounded-card border border-line bg-panel p-4 md:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          review();
        }}
        aria-label={t('extensions.installTitle')}
      >
        <h2 className="text-sm font-semibold md:col-span-2">{t('extensions.installTitle')}</h2>
        <label className="text-xs text-dim">
          {t('extensions.fields.name')}
          <input className={input} placeholder={EXAMPLES.name} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
        </label>
        <label className="text-xs text-dim">
          {t('extensions.fields.version')}
          <input className={input} value={form.version} onChange={(e) => setForm({ ...form, version: e.target.value })} required />
        </label>
        <label className="text-xs text-dim">
          {t('extensions.fields.type')}
          <select className={input} value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as InstallForm['type'] })}>
            {TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
          </select>
        </label>
        <label className="text-xs text-dim">
          {t('extensions.fields.bundleUrl')}
          <input className={input} placeholder={EXAMPLES.bundleUrl} value={form.bundleUrl} onChange={(e) => setForm({ ...form, bundleUrl: e.target.value })} required />
        </label>
        <label className="text-xs text-dim">
          {t('extensions.fields.capabilities')}
          <textarea className={`${input} font-mono`} rows={3} placeholder={EXAMPLES.capabilities} value={form.capabilities} onChange={(e) => setForm({ ...form, capabilities: e.target.value })} />
        </label>
        <label className="text-xs text-dim">
          {t('extensions.fields.outboundHosts')}
          <textarea className={`${input} font-mono`} rows={3} value={form.outboundHosts} onChange={(e) => setForm({ ...form, outboundHosts: e.target.value })} />
        </label>
        {formError && <p className="text-sm text-bad md:col-span-2">{formError}</p>}
        <div className="md:col-span-2">
          <button type="submit" className="inline-flex items-center gap-2 rounded-ctl bg-brand px-3 py-1.5 text-sm font-medium text-brand-fg">
            <Upload className="h-4 w-4" /> {t('extensions.reviewPermissions')}
          </button>
        </div>
      </form>

      <div className="grid gap-4 md:grid-cols-2">
        {extensionsQuery.isLoading && <div className="text-dim">{t('common:loading')}</div>}
        {extensions.length === 0 && !extensionsQuery.isLoading && (
          <div className="col-span-full rounded-card border border-dashed p-12 text-center text-dim">{t('extensions.empty')}</div>
        )}
        {extensions.map((ext) => (
          <article key={ext.id} className="flex flex-col justify-between rounded-card border border-line bg-panel p-4" data-testid={`extension-${ext.name}`}>
            <div>
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div className={`flex h-10 w-10 items-center justify-center rounded-card ${ext.enabled ? 'bg-brand-soft text-brand' : 'bg-panel-2 text-dim'}`}>
                    <Puzzle className="h-5 w-5" />
                  </div>
                  <div>
                    <h3 className="flex items-center gap-2 font-semibold">
                      {ext.name}
                      <span className="rounded bg-panel-2 px-1.5 py-0.5 text-xs font-normal text-dim">{`v${ext.version}`}</span>
                    </h3>
                    <p className="text-xs capitalize text-dim">{t('extensions.typeLabel', { type: ext.type })}</p>
                  </div>
                </div>
                <button
                  onClick={() => toggleMutation.mutate({ id: ext.id, enabled: !ext.enabled })}
                  className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors ${ext.enabled ? 'bg-ok-soft text-ok' : 'bg-panel-2 text-dim'}`}
                  title={ext.enabled ? t('extensions.disable') : t('extensions.enable')}
                  aria-label={ext.enabled ? t('extensions.disable') : t('extensions.enable')}
                >
                  <Power className="h-4 w-4" />
                </button>
              </div>

              {ext.permissionsStatus === 'reconfirm' && (
                <div className="mt-3 flex items-start justify-between gap-2 rounded-ctl border border-warn bg-warn-soft p-2 text-sm">
                  <span className="flex items-start gap-2"><ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warn" />{t('extensions.reconfirmNotice')}</span>
                  <button type="button" className="shrink-0 text-sm font-medium text-brand hover:underline" onClick={() => { approveMutation.reset(); setApproval({ kind: 'confirm', ext }); }}>
                    {t('extensions.reviewPermissions')}
                  </button>
                </div>
              )}

              {ext.pendingUpgrade && (
                <div className="mt-3 rounded-ctl border border-warn bg-warn-soft p-2 text-sm" data-testid="pending-upgrade">
                  <p className="flex items-center gap-2 font-medium">
                    <ArrowUpCircle className="h-4 w-4 text-warn" />
                    {t('extensions.upgradePending', { version: ext.pendingUpgrade.version, count: ext.pendingUpgrade.diff.added.length })}
                  </p>
                  <div className="mt-2 flex gap-3">
                    <button type="button" className="font-medium text-brand hover:underline" onClick={() => { approveMutation.reset(); setApproval({ kind: 'upgrade', ext }); }}>
                      {t('extensions.reviewUpgrade')}
                    </button>
                    <button type="button" className="text-dim hover:underline" onClick={() => rejectMutation.mutate(ext.id)}>
                      {t('extensions.rejectUpgrade')}
                    </button>
                  </div>
                </div>
              )}

              {toggleMutation.error && toggleMutation.variables?.id === ext.id && <ExtensionErrorNotice error={toggleMutation.error} />}

              <div className="mt-4">
                <PermissionList capabilities={ext.capabilities} />
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
          </article>
        ))}
      </div>

      <PluginCollections />

      {approval && (
        <PermissionApprovalDialog
          title={
            approval.kind === 'install'
              ? t('extensions.approveInstallTitle', { name: form.name })
              : approval.kind === 'upgrade'
                ? t('extensions.approveUpgradeTitle', { name: approval.ext.name, version: approval.ext.pendingUpgrade?.version })
                : t('extensions.confirmTitle', { name: approval.ext.name })
          }
          intro={approval.kind === 'upgrade' ? t('extensions.approveUpgradeIntro') : approval.kind === 'confirm' ? t('extensions.confirmIntro') : t('extensions.approveInstallIntro')}
          capabilities={
            approval.kind === 'install'
              ? approval.capabilities
              : approval.kind === 'upgrade'
                ? approval.ext.pendingUpgrade!.requestedCapabilities
                : approval.ext.capabilities
          }
          diff={approval.kind === 'upgrade' ? approval.ext.pendingUpgrade!.diff : undefined}
          approveLabel={approval.kind === 'install' ? t('extensions.approveAndInstall') : approval.kind === 'upgrade' ? t('extensions.approveAndUpgrade') : t('extensions.confirmPermissions')}
          pending={approveMutation.isPending}
          error={apiErrorMessage(approveMutation.error)}
          onApprove={() => approveMutation.mutate(approval)}
          onCancel={() => setApproval(null)}
        />
      )}
    </div>
  );
}
