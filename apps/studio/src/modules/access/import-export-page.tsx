// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Download, FileJson, ShieldAlert, Upload, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from 'i18next';
import type {
  AccessConflict,
  AccessExportManifest,
  AccessImportDiff,
  AccessImportDiffSection,
  AccessImportDryRunResult,
  AccessImportMode,
} from '@heopress/sdk';
import { getApiClient } from '@/lib/api';
import { cn } from '@/lib/cn';

const IMPORT_MODES: Array<{ value: AccessImportMode; key: string }> = [
  { value: 'merge', key: 'merge' },
  { value: 'replace-managed', key: 'replaceManaged' },
  { value: 'replace-all', key: 'replaceAll' },
];

type AccessImportEntityDiffKey = Exclude<keyof AccessImportDiff, 'bindings'>;

const DIFF_SECTIONS: Array<{ key: AccessImportEntityDiffKey; label: string }> = [
  { key: 'roles', label: 'roles' },
  { key: 'policies', label: 'policies' },
  { key: 'apiKeys', label: 'apiKeys' },
];

const BINDING_SECTIONS: Array<{ key: keyof AccessImportDiff['bindings']; label: string }> = [
  { key: 'rolePolicies', label: 'rolePolicies' },
  { key: 'userRoles', label: 'userRoles' },
  { key: 'userPolicies', label: 'userPolicies' },
  { key: 'apiKeyRoles', label: 'apiKeyRoles' },
  { key: 'apiKeyPolicies', label: 'apiKeyPolicies' },
];

export function AccessImportExportPage() {
  const { t } = useTranslation('access');
  const client = getApiClient();
  const queryClient = useQueryClient();
  const [importing, setImporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const exportManifest = useMutation({
    mutationFn: async () => (await client.access.exportManifest()).data,
    onSuccess: (manifest) => {
      downloadManifest(manifest);
      setExportError(null);
    },
    onError: (error) => setExportError((error as Error).message),
  });

  return (
    <div className="space-y-5">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h2 className="t-section">{t('importExport.title')}</h2>
          <p className="text-xs text-dim">
            {t('importExport.description')}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => exportManifest.mutate()}
            disabled={exportManifest.isPending}
            className="inline-flex items-center gap-2 rounded-ctl border px-3 py-1.5 text-[13px] font-medium hover:bg-panel-2 disabled:opacity-50 border-line"
          >
            <Download className="h-4 w-4" /> {exportManifest.isPending ? t('importExport.exporting') : t('importExport.export')}
          </button>
          <button
            type="button"
            onClick={() => setImporting(true)}
            className="inline-flex items-center gap-2 rounded-ctl bg-brand px-3 py-1.5 text-[13px] font-medium text-brand-fg hover:opacity-90"
          >
            <Upload className="h-4 w-4" /> {t('importExport.import')}
          </button>
        </div>
      </header>

      {exportError && (
        <div role="alert" className="rounded-ctl border border-bad/40 bg-bad-soft p-3 text-sm text-bad">
          {exportError}
        </div>
      )}

      <section className="grid gap-3 md:grid-cols-3">
        <Capability icon={FileJson} title={t('importExport.capabilities.portableTitle')} text={t('importExport.capabilities.portableText')} />
        <Capability icon={ShieldAlert} title={t('importExport.capabilities.dryRunTitle')} text={t('importExport.capabilities.dryRunText')} />
        <Capability icon={CheckCircle2} title={t('importExport.capabilities.auditedTitle')} text={t('importExport.capabilities.auditedText')} />
      </section>

      {importing && (
        <AccessImportDialog
          onClose={() => setImporting(false)}
          onApplied={() => {
            setImporting(false);
            queryClient.invalidateQueries({ queryKey: ['access'] });
          }}
        />
      )}
    </div>
  );
}

export function AccessImportDialog({
  onClose,
  onApplied,
}: {
  onClose: () => void;
  onApplied: () => void;
}) {
  const { t } = useTranslation('access');
  const client = getApiClient();
  const [manifest, setManifest] = useState<AccessExportManifest | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [dryRun, setDryRun] = useState<AccessImportDryRunResult | null>(null);
  const [mode, setMode] = useState<AccessImportMode>('merge');
  const [applied, setApplied] = useState(false);

  const dryRunMutation = useMutation({
    mutationFn: async (input: AccessExportManifest) => (await client.access.dryRunImport(input)).data,
    onSuccess: (result) => {
      setDryRun(result);
      setApplied(false);
    },
  });

  const applyMutation = useMutation({
    mutationFn: async () => {
      if (!manifest) throw new Error(t('importExport.errors.chooseManifest'));
      return (await client.access.importManifest(manifest, { mode })).data;
    },
    onSuccess: () => {
      setApplied(true);
      onApplied();
    },
  });

  const totals = useMemo(() => (dryRun ? summarizeImportDiff(dryRun.diff) : null), [dryRun]);
  const blocking = dryRun?.conflicts.conflicts ?? [];
  const warnings = dryRun?.conflicts.warnings ?? [];
  const canApply = !!manifest && !!dryRun?.valid && !dryRunMutation.isPending && !applyMutation.isPending;

  async function readManifest(file: File): Promise<void> {
    setFileName(file.name);
    setParseError(null);
    setDryRun(null);
    setApplied(false);

    try {
      const parsed = JSON.parse(await readFileText(file)) as AccessExportManifest;
      if (!parsed || parsed.schema !== 'heopress.access@v1') {
        throw new Error(t('importExport.errors.notManifest'));
      }
      setManifest(parsed);
      dryRunMutation.mutate(parsed);
    } catch (error) {
      setManifest(null);
      setParseError((error as Error).message);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-card border bg-bg shadow-lg border-line">
        <header className="flex items-center justify-between border-b px-5 py-4 border-line">
          <div>
            <h3 className="text-base font-semibold">{t('importExport.dialog.title')}</h3>
            <p className="text-xs text-dim">{t('importExport.dialog.description')}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('importExport.dialog.close')}
            className="rounded-ctl p-1 text-dim hover:bg-panel-2 hover:text-fg"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-auto p-5">
          <label className="block rounded-ctl border border-dashed p-4 border-line">
            <span className="mb-2 block text-sm font-medium">{t('importExport.dialog.manifestJson')}</span>
            <input
              type="file"
              accept="application/json,.json"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void readManifest(file);
              }}
              className="block w-full text-sm file:mr-3 file:rounded-ctl file:border-0 file:bg-brand file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-brand-fg border-line"
            />
            {fileName && <span className="mt-2 block text-xs text-dim">{fileName}</span>}
          </label>

          {parseError && <AlertPanel tone="danger" title={t('importExport.dialog.parseFailed')} items={[parseError]} />}
          {dryRunMutation.error && (
            <AlertPanel tone="danger" title={t('importExport.dialog.dryRunFailed')} items={[(dryRunMutation.error as Error).message]} />
          )}
          {dryRunMutation.isPending && <p className="text-sm text-dim">{t('importExport.dialog.running')}</p>}

          {dryRun && (
            <>
              <div className="grid gap-2 sm:grid-cols-4">
                <Metric label={t('importExport.status.create')} value={totals?.create ?? 0} />
                <Metric label={t('importExport.status.update')} value={totals?.update ?? 0} />
                <Metric label={t('importExport.status.unchanged')} value={totals?.unchanged ?? 0} />
                <Metric label={t('importExport.status.delete')} value={totals?.delete ?? 0} />
              </div>

              <DryRunStatus dryRun={dryRun} />
              <DiffPanel diff={dryRun.diff} />
              <ConflictPanel title={t('importExport.dialog.blocking')} conflicts={blocking} tone="danger" />
              <ConflictPanel title={t('importExport.dialog.warnings')} conflicts={warnings} tone="warning" />

              <section className="rounded-ctl border p-3 border-line">
                <h4 className="mb-2 text-sm font-semibold">{t('importExport.dialog.applyMode')}</h4>
                <div className="grid gap-2 md:grid-cols-3">
                  {IMPORT_MODES.map((item) => (
                    <label
                      key={item.value}
                      className={cn(
                        'rounded-ctl border p-3 text-sm border-line',
                        mode === item.value && 'border-brand bg-brand-soft',
                      )}
                    >
                      <span className="flex items-center gap-2 font-medium">
                        <input
                          type="radio"
                          name="access-import-mode"
                          value={item.value}
                          checked={mode === item.value}
                          onChange={() => setMode(item.value)}
                        />
                        {t(`importExport.modes.${item.key}.label`)}
                      </span>
                      <span className="mt-1 block text-xs text-dim">{t(`importExport.modes.${item.key}.hint`)}</span>
                    </label>
                  ))}
                </div>
              </section>
            </>
          )}

          {applyMutation.error && (
            <AlertPanel tone="danger" title={t('importExport.dialog.importFailed')} items={[(applyMutation.error as Error).message]} />
          )}
          {applied && <AlertPanel tone="success" title={t('importExport.dialog.applied')} items={[t('importExport.dialog.appliedBody')]} />}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t px-5 py-4 border-line">
          <button type="button" onClick={onClose} className="rounded-ctl border px-3 py-1.5 text-sm border-line">
            {t('common:cancel')}
          </button>
          <button
            type="button"
            disabled={!canApply}
            onClick={() => applyMutation.mutate()}
            className="rounded-ctl bg-brand px-3 py-1.5 text-[13px] font-medium text-brand-fg disabled:opacity-50"
          >
            {applyMutation.isPending ? t('importExport.dialog.applying') : t('importExport.dialog.apply')}
          </button>
        </footer>
      </div>
    </div>
  );
}

export function summarizeImportDiff(diff: AccessImportDiff): Omit<AccessImportDiffSection, 'entries'> {
  const sections = [
    diff.roles,
    diff.policies,
    diff.apiKeys,
    ...Object.values(diff.bindings),
  ];
  return sections.reduce(
    (acc, section) => ({
      create: acc.create + section.create,
      update: acc.update + section.update,
      unchanged: acc.unchanged + section.unchanged,
      delete: acc.delete + section.delete,
    }),
    { create: 0, update: 0, unchanged: 0, delete: 0 },
  );
}

function DiffPanel({ diff }: { diff: AccessImportDiff }) {
  const { t } = useTranslation('access');
  return (
    <section className="rounded-ctl border border-line">
      <h4 className="border-b px-3 py-2 text-sm font-semibold border-line">{t('importExport.dialog.diff')}</h4>
      <div className="divide-y">
        {DIFF_SECTIONS.map((section) => (
          <DiffSection key={section.key} label={t(`importExport.sections.${section.label}`)} section={diff[section.key]} />
        ))}
        {BINDING_SECTIONS.map((section) => (
          <DiffSection key={section.key} label={t(`importExport.sections.${section.label}`)} section={diff.bindings[section.key]} />
        ))}
      </div>
    </section>
  );
}

function DiffSection({ label, section }: { label: string; section: AccessImportDiffSection }) {
  return (
    <details className="group" open={section.create + section.update + section.delete > 0}>
      <summary className="flex cursor-pointer items-center justify-between px-3 py-2 text-sm">
        <span className="font-medium">{label}</span>
        <span className="text-xs text-dim">
          +{section.create} / ~{section.update} / ={section.unchanged} / -{section.delete}
        </span>
      </summary>
      {section.entries.length > 0 && (
        <ul className="space-y-1 px-3 pb-3 text-xs">
          {section.entries.map((entry) => (
            <li key={`${entry.ref}:${entry.status}`} className="flex items-center justify-between rounded bg-panel-2 px-2 py-1">
              <span className="font-mono">{entry.ref}</span>
              <StatusPill status={entry.status} />
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

function ConflictPanel({
  title,
  conflicts,
  tone,
}: {
  title: string;
  conflicts: AccessConflict[];
  tone: 'danger' | 'warning';
}) {
  if (!conflicts.length) return null;
  return (
    <AlertPanel
      tone={tone}
      title={i18n.t('access:importExport.titleCount', { title, count: conflicts.length })}
      items={conflicts.map(
        (item) =>
          `${item.collection}:${item.action} ${item.reason} (${item.existingPolicy} / ${item.incomingPolicy})`,
      )}
    />
  );
}

function DryRunStatus({ dryRun }: { dryRun: AccessImportDryRunResult }) {
  const { t } = useTranslation('access');
  const hasReview = dryRun.conflicts.warnings.length > 0 || dryRun.conflicts.conflicts.length > 0;
  if (dryRun.valid && !hasReview) {
    return <AlertPanel tone="success" title={t('importExport.dryRun.passed')} items={[t('importExport.dryRun.passedBody')]} />;
  }
  if (dryRun.valid) {
    return <AlertPanel tone="warning" title={t('importExport.dryRun.warnings')} items={[t('importExport.dryRun.warningsBody')]} />;
  }
  const errors = dryRun.errors.map((error) => `${error.path ? `${error.path}: ` : ''}${error.message}`);
  return <AlertPanel tone="danger" title={t('importExport.dryRun.blocked')} items={errors.length ? errors : [t('importExport.dryRun.blockedBody')]} />;
}

function AlertPanel({
  tone,
  title,
  items,
}: {
  tone: 'success' | 'warning' | 'danger';
  title: string;
  items: string[];
}) {
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn(
        'rounded-ctl border p-3 text-sm border-line',
        tone === 'success' && 'border-ok/40 bg-ok-soft text-ok',
        tone === 'warning' && 'border-warn/40 bg-warn-soft text-warn',
        tone === 'danger' && 'border-bad/40 bg-bad-soft text-bad',
      )}
    >
      <div className="mb-1 flex items-center gap-2 font-semibold">
        {tone === 'success' ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
        {title}
      </div>
      <ul className="space-y-1 text-xs">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-ctl border p-3 border-line">
      <div className="text-xs text-dim">{label}</div>
      <div className="text-xl font-semibold">{value}</div>
    </div>
  );
}

function StatusPill({ status }: { status: AccessImportDiffSection['entries'][number]['status'] }) {
  const { t } = useTranslation('access');
  return (
    <span
      className={cn(
        'rounded px-1.5 py-0.5 text-[11px] font-medium',
        status === 'create' && 'bg-ok-soft text-ok',
        status === 'update' && 'bg-brand-soft text-brand',
        status === 'unchanged' && 'bg-panel-2 text-dim',
        status === 'delete' && 'bg-rose-100 text-rose-800',
      )}
    >
      {t(`importExport.status.${status}`)}
    </span>
  );
}

function Capability({
  icon: Icon,
  title,
  text,
}: {
  icon: typeof FileJson;
  title: string;
  text: string;
}) {
  return (
    <div className="rounded-card border p-4 border-line">
      <Icon className="mb-3 h-5 w-5 text-brand" />
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="mt-1 text-xs text-dim">{text}</p>
    </div>
  );
}

function downloadManifest(manifest: AccessExportManifest): void {
  const body = JSON.stringify(manifest, null, 2);
  const blob = new Blob([body], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `heopress-access-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function readFileText(file: File): Promise<string> {
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error(i18n.t('access:importExport.errors.readFailed')));
    reader.readAsText(file);
  });
}
