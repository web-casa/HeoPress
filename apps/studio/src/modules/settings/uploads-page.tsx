// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trans, useTranslation } from 'react-i18next';
import { UploadCloud, Save, ShieldCheck, AlertTriangle } from 'lucide-react';
import { useEffect, useState } from 'react';
import i18n from 'i18next';
import { getApiClient } from '@/lib/api';
import { formatSafeError } from '@heopress/contracts/utils';
import type { UploadConfigResource } from '@heopress/sdk';
import { PageHeader } from '@/workspace/ui/page-header';

const BYTES_PER_MB = 1024 * 1024;

/**
 * Settings → Uploads. Lets an admin choose which file types (extensions) may be
 * uploaded and the maximum size. The same allowlist is what the server-side
 * upload guard enforces on every upload surface; this page only edits it.
 */
export function UploadsSettingsPage() {
  const { t } = useTranslation(['system', 'common']);
  const client = getApiClient();
  const qc = useQueryClient();

  const configQuery = useQuery({
    queryKey: ['upload-config'],
    queryFn: async () => (await client.uploads.getConfig()).data,
  });

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [maxMb, setMaxMb] = useState<string>('10');
  const [error, setError] = useState<string | null>(null);

  // Seed the form once the effective config loads.
  useEffect(() => {
    const cfg = configQuery.data;
    if (!cfg) return;
    setSelected(new Set(cfg.allowedMimeTypes));
    setMaxMb((cfg.maxBytes / BYTES_PER_MB).toFixed(cfg.maxBytes % BYTES_PER_MB === 0 ? 0 : 2));
  }, [configQuery.data]);

  const saveMutation = useMutation({
    mutationFn: (input: { maxBytes: number; allowedMimeTypes: string[] }) =>
      client.uploads.updateConfig(input),
    onSuccess: () => {
      setError(null);
      qc.invalidateQueries({ queryKey: ['upload-config'] });
    },
    onError: (err) => setError(friendlyError(err)),
  });

  const catalogue = configQuery.data?.catalogue ?? [];

  const toggle = (mime: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(mime)) next.delete(mime);
      else next.add(mime);
      return next;
    });
  };

  const onSave = () => {
    setError(null);
    const mb = Number.parseFloat(maxMb);
    if (!Number.isFinite(mb) || mb <= 0) {
      setError(t('uploads.errors.size'));
      return;
    }
    if (selected.size === 0) {
      setError(t('uploads.errors.types'));
      return;
    }
    saveMutation.mutate({
      maxBytes: Math.round(mb * BYTES_PER_MB),
      allowedMimeTypes: [...selected],
    });
  };

  const allowedExtensions = catalogue
    .filter((entry) => selected.has(entry.mime))
    .flatMap((entry) => entry.extensions);

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader
        title={<span className="flex items-center gap-2"><UploadCloud className="h-5 w-5" /> {t('uploads.title')}</span>}
        description={t('uploads.description')}
      />

      {configQuery.isLoading ? (
        <div className="text-dim">{t('common:loading')}</div>
      ) : (
        <>
          <section className="space-y-3 rounded-card border border-line bg-panel p-5">
            <h2 className="t-section">
              {t('uploads.allowedTypes')}
            </h2>
            <div className="grid gap-2 sm:grid-cols-2">
              {catalogue.map((entry) => (
                <label
                  key={entry.mime}
                  className="flex cursor-pointer items-start gap-3 rounded-card border border-line p-3 hover:bg-panel-2"
                >
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={selected.has(entry.mime)}
                    onChange={() => toggle(entry.mime)}
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{entry.label}</span>
                    <span className="block font-mono text-xs text-dim">
                      {entry.extensions.join(', ')} · {entry.mime}
                    </span>
                    {entry.note && (
                      <span className="mt-1 flex items-start gap-1 text-[11px] text-warn">
                        <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /> {entry.note}
                      </span>
                    )}
                  </span>
                </label>
              ))}
            </div>
          </section>

          <section className="space-y-2 rounded-card border border-line bg-panel p-5">
            <h2 className="t-section">
              {t('uploads.maxSize')}
            </h2>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min="0.1"
                step="0.1"
                value={maxMb}
                onChange={(e) => setMaxMb(e.target.value)}
                className="w-32 rounded-ctl border px-3 py-2 text-sm outline-none focus:border-brand"
              />
              <span className="text-sm text-dim">{t('uploads.perFile')}</span>
            </div>
          </section>

          <section className="flex items-start gap-2 rounded-card border border-dashed bg-panel-2 p-3 text-xs text-dim">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-ok" />
            <span>
              <Trans
                t={t}
                i18nKey="uploads.pickerNote"
                values={{ extensions: allowedExtensions.join(', ') || '—' }}
                components={{ mono: <span className="font-mono" /> }}
              />
            </span>
          </section>

          {error && (
            <div className="rounded-ctl border border-bad/40 bg-bad-soft px-3 py-2 text-sm text-bad">
              {error}
            </div>
          )}

          <div className="flex justify-end">
            <button
              type="button"
              onClick={onSave}
              disabled={saveMutation.isPending}
              className="inline-flex items-center gap-2 rounded-ctl bg-brand px-4 py-2 text-sm font-medium text-brand-fg disabled:opacity-50"
            >
              <Save className="h-4 w-4" /> {saveMutation.isPending ? t('uploads.saving') : t('common:save')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function friendlyError(err: unknown): string {
  const message = formatSafeError(err);
  if (typeof message === 'string' && /403|forbidden/i.test(message)) {
    return i18n.t('system:uploads.errors.forbidden');
  }
  return i18n.t('system:uploads.errors.saveFailed');
}

// Re-exported type for callers that want the shape.
export type { UploadConfigResource };
