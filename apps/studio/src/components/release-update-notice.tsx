// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { AlertTriangle, ExternalLink, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  RELEASE_UPDATE_CHECK_INTERVAL_MS,
  UPGRADE_GUIDE_URL,
  checkReleaseManifest,
  isReleaseUpdateCheckEnabled,
  type ReleaseUpdateStatus,
} from '@/lib/release-updates';

interface ReleaseUpdateNoticeProps {
  compact?: boolean;
  initialStatus?: ReleaseUpdateStatus | null;
}

/**
 * Opt-in Studio update checker.
 *
 * This component only reads the public release manifest over an anonymous GET.
 * It does not send the active site id, token, hostname, installed extensions,
 * telemetry payloads, or any UI command that could restart services or run
 * migrations. Operators must enable the check explicitly in Settings → Updates.
 */
export function ReleaseUpdateNotice({ compact = false, initialStatus = null }: ReleaseUpdateNoticeProps) {
  const { t } = useTranslation('widgets');
  const [enabled, setEnabled] = useState(() => isReleaseUpdateCheckEnabled());
  const [status, setStatus] = useState<ReleaseUpdateStatus | null>(initialStatus);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    setStatus(initialStatus);
  }, [initialStatus]);

  const refreshPreference = useCallback(() => {
    setEnabled(isReleaseUpdateCheckEnabled());
  }, []);

  const runCheck = useCallback(async () => {
    if (!isReleaseUpdateCheckEnabled()) {
      setStatus(null);
      setError(null);
      setEnabled(false);
      return;
    }

    setChecking(true);
    try {
      const nextStatus = await checkReleaseManifest();
      setStatus(nextStatus);
      setError(null);
      setEnabled(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('release.manifestUnreadable'));
    } finally {
      setChecking(false);
    }
  }, [t]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (!event.key || event.key === 'heopress.releaseUpdates.optIn') {
        refreshPreference();
      }
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener('focus', refreshPreference);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('focus', refreshPreference);
    };
  }, [refreshPreference]);

  useEffect(() => {
    if (!enabled) return undefined;

    void runCheck();

    const interval = window.setInterval(() => {
      void runCheck();
    }, RELEASE_UPDATE_CHECK_INTERVAL_MS);

    return () => window.clearInterval(interval);
  }, [enabled, runCheck]);

  if (!enabled) return null;

  if (status?.updateAvailable) {
    const upgradeGuideUrl = status.target.upgradeGuideUrl ?? UPGRADE_GUIDE_URL;

    return (
      <div
        role="status"
        className={compact
          ? 'flex max-w-xl items-center gap-2 rounded-ctl border border-warn/40 bg-warn-soft px-3 py-1.5 text-xs text-warn shadow-sm'
          : 'rounded-card border border-warn/40 bg-warn-soft p-4 text-sm text-warn shadow-sm'}
      >
        <AlertTriangle className="h-4 w-4 shrink-0 text-warn" aria-hidden="true" />
        <div className={compact ? 'min-w-0 truncate' : 'space-y-2'}>
          <p className="font-medium">
            {t('release.available', { version: status.target.version })}
          </p>
          {!compact ? (
            <p className="text-warn">
              {t('release.released', { date: status.target.releaseDate })}
            </p>
          ) : null}
          {status.target.migrationWarning || status.belowMinimumSafeUpgradeVersion ? (
            <p className="font-medium text-warn">
              {status.belowMinimumSafeUpgradeVersion
                ? t('release.reviewGuideBelow', { version: status.target.minimumSafeUpgradeVersion })
                : t('release.reviewGuide')}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            <a
              href={upgradeGuideUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-semibold text-brand hover:underline"
            >
              {t('release.upgradeGuide')}
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            </a>
            <a
              href={status.target.changelogUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-dim hover:text-fg hover:underline"
            >
              {t('release.changelog')}
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            </a>
          </div>
        </div>
      </div>
    );
  }

  if (!compact && error) {
    return (
      <div className="rounded-card border border-line bg-panel-2 p-4 text-sm text-dim">
        {t('release.checkError', { error })}
      </div>
    );
  }

  if (!compact) {
    return (
      <div className="rounded-card border border-line bg-panel p-4 text-sm text-dim shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <span>{checking ? t('release.checking') : t('release.upToDate')}</span>
          <button
            type="button"
            onClick={() => void runCheck()}
            disabled={checking}
            className="inline-flex items-center gap-1 rounded-ctl border border-line px-2.5 py-1.5 text-xs font-medium text-fg hover:bg-panel-2 disabled:opacity-50"
          >
            <RefreshCw className={checking ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} aria-hidden="true" />
            {t('release.checkNow')}
          </button>
        </div>
      </div>
    );
  }

  return null;
}
