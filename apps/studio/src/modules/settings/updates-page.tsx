// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { ReleaseUpdateNotice } from '@/components/release-update-notice';
import {
  RELEASE_MANIFEST_URL,
  checkReleaseManifest,
  getLastReleaseUpdateCheckAt,
  isReleaseUpdateCheckEnabled,
  setReleaseUpdateCheckEnabled,
  type ReleaseUpdateStatus,
} from '@/lib/release-updates';
import { PageHeader } from '@/workspace/ui/page-header';

export function UpdatesPage() {
  const { t } = useTranslation('system');
  const [enabled, setEnabled] = useState(() => isReleaseUpdateCheckEnabled());
  const [lastCheckAt, setLastCheckAt] = useState(() => getLastReleaseUpdateCheckAt());
  const [status, setStatus] = useState<ReleaseUpdateStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    setLastCheckAt(getLastReleaseUpdateCheckAt());
  }, [enabled, status]);

  const updatePreference = (nextEnabled: boolean) => {
    setReleaseUpdateCheckEnabled(nextEnabled);
    setEnabled(nextEnabled);
    if (!nextEnabled) {
      setStatus(null);
      setError(null);
    }
  };

  const runManualCheck = async () => {
    setChecking(true);
    try {
      const nextStatus = await checkReleaseManifest();
      setStatus(nextStatus);
      setLastCheckAt(getLastReleaseUpdateCheckAt());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('updates.readFailed'));
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('updates.title')}
        description={t('updates.description')}
      />

      <section className="rounded-card border border-line bg-panel p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-2">
            <h2 className="t-section">{t('updates.checksTitle')}</h2>
            <p className="max-w-2xl text-sm text-dim">
              <Trans
                t={t}
                i18nKey="updates.checksBody"
                values={{ url: RELEASE_MANIFEST_URL }}
                components={{ code: <code className="rounded bg-panel-2 px-1 py-0.5" /> }}
              />
            </p>
            <p className="max-w-2xl text-sm text-dim">
              {t('updates.privacy')}
            </p>
          </div>

          <label className="inline-flex shrink-0 items-center gap-2 rounded-card border border-line px-3 py-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => updatePreference(event.target.checked)}
              className="h-4 w-4 rounded border-line text-brand focus:ring-brand"
            />
            {t('updates.enable')}
          </label>
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-3 border-t pt-4">
          <button
            type="button"
            onClick={() => void runManualCheck()}
            disabled={!enabled || checking}
            className="inline-flex items-center gap-2 rounded-ctl bg-brand px-3 py-2 text-sm font-semibold text-brand-fg transition hover:bg-brand/95 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw className={checking ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} aria-hidden="true" />
            {checking ? t('updates.checking') : t('updates.checkNow')}
          </button>
          <span className="text-sm text-dim">
            {lastCheckAt ? t('updates.lastChecked', { time: new Date(lastCheckAt).toLocaleString() }) : t('updates.never')}
          </span>
        </div>

        {error ? (
          <p className="mt-4 rounded-ctl border border-bad/40 bg-bad-soft px-3 py-2 text-sm text-bad">
            {error}
          </p>
        ) : null}
      </section>

      {enabled ? (
        <section aria-label={t('updates.status')}>
          {status?.updateAvailable ? (
            <ReleaseUpdateNotice initialStatus={status} />
          ) : (
            <div className="rounded-card border border-line bg-panel p-4 text-sm text-dim">
              {status
                ? t('updates.current', { channel: status.targetChannel, version: status.target.version })
                : t('updates.hint')}
            </div>
          )}
        </section>
      ) : (
        <section className="rounded-card border border-dashed p-4 text-sm text-dim">
          {t('updates.disabled')}
        </section>
      )}

      <section className="rounded-card border border-line bg-panel-2 p-5 text-sm text-dim">
        <h2 className="t-section">{t('updates.guardrails')}</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>{t('updates.guard1')}</li>
          <li>{t('updates.guard2')}</li>
          <li>{t('updates.guard3')}</li>
        </ul>
      </section>
    </div>
  );
}
