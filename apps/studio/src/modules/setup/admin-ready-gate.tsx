// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { hasActiveToken } from '@/lib/api';
import { ADMIN_PATH_REGEX } from './schemas/admin-path';
import { shouldAutoRedirectToAdmin } from './setup-environment';
import { selectAdminPath, useSetupStore } from './setup-store';
import {
  shouldShowSetupStateError,
  useSetupStateQuery,
} from './use-setup-state-query';

interface AdminReadyGateProps {
  children: ReactNode;
}

/**
 * Guard for the authenticated Studio shell.
 *
 * The public setup wizard owns first-time initialization. Until the backend
 * reports `initialized`, dashboard chrome and admin modules should not mount.
 */
export function AdminReadyGate({ children }: AdminReadyGateProps) {
  const navigate = useNavigate();
  const { location } = useRouterState();
  const adminPath = useSetupStore(selectAdminPath);
  const query = useSetupStateQuery();
  const [hasFailed, setHasFailed] = useState(false);

  useEffect(() => {
    if (query.isError) setHasFailed(true);
    if (query.isSuccess) setHasFailed(false);
  }, [query.isError, query.isSuccess]);

  useEffect(() => {
    if (query.data?.state === 'uninitialized') {
      navigate({ to: '/setup' });
      return;
    }
    if (
      query.data?.state === 'initialized' &&
      !hasActiveToken() &&
      adminPath &&
      shouldAutoRedirectToAdmin()
    ) {
      navigate({ to: `${adminPath}/login` });
    }
  }, [adminPath, navigate, query.data?.state]);

  // Stable error screen first — never fall back to the spinner while a
  // manual retry is in flight (avoids a continuous-refresh feeling when
  // the CMS is down).
  if (
    shouldShowSetupStateError({
      isError: query.isError,
      isSuccess: query.isSuccess,
      isFetching: query.isFetching,
      hasFailed,
    })
  ) {
    return (
      <AdminReadyErrorScreen
        isRetrying={query.isFetching}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }

  if (query.isPending || query.data?.state === 'uninitialized') {
    return <AdminReadyLoadingScreen />;
  }

  if (!hasActiveToken()) {
    return <AdminReadyLoginRequiredScreen currentPath={location.pathname} />;
  }

  return <>{children}</>;
}

function AdminReadyLoadingScreen() {
  const { t } = useTranslation('setup');
  return (
    <div
      className="flex min-h-screen items-center justify-center bg-muted/30"
      role="status"
      aria-live="polite"
      aria-label={t('gate.checking')}
    >
      <span className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
    </div>
  );
}

/**
 * The sign-in page for the admin URL the visitor opened, or null when the
 * address cannot be one. Built only from the address itself: the admin path
 * stays a secret, so every well-formed path gets the same link.
 */
export function loginHrefFor(currentPath: string): string | null {
  const first = `/${currentPath.split('/').filter(Boolean)[0] ?? ''}`;
  return ADMIN_PATH_REGEX.test(first) ? `${first}/login` : null;
}

export function AdminReadyLoginRequiredScreen({ currentPath }: { currentPath: string }) {
  const { t } = useTranslation('setup');
  const loginHref = loginHrefFor(currentPath);
  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 px-4 py-12">
      <div role="alert" className="w-full max-w-md rounded-md border bg-background p-8 shadow-sm">
        <div className="space-y-4">
          <h1 className="text-lg font-semibold">{t('readyGate.signInTitle')}</h1>
          {loginHref ? (
            <>
              <p className="text-sm text-muted-foreground">{t('readyGate.signInBody')}</p>
              <a
                href={loginHref}
                className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              >
                {t('readyGate.goToSignIn')}
              </a>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t('readyGate.openAdminUrl')}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function AdminReadyErrorScreen({
  onRetry,
  isRetrying = false,
}: {
  onRetry: () => void;
  isRetrying?: boolean;
}) {
  const { t } = useTranslation('setup');
  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 px-4 py-12">
      <div role="alert" className="w-full max-w-md rounded-xl border bg-background p-8 shadow-sm">
        <div className="space-y-4">
          <h1 className="text-lg font-semibold">{t('gate.unreachableTitle')}</h1>
          <p className="text-sm text-muted-foreground">
            {t('gate.unreachableBody')}
          </p>
          <button
            type="button"
            onClick={onRetry}
            disabled={isRetrying}
            aria-busy={isRetrying}
            className="inline-flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {isRetrying ? (
              <span
                className="h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground border-t-transparent"
                aria-hidden
              />
            ) : null}
            {isRetrying ? t('gate.retrying') : t('gate.retry')}
          </button>
        </div>
      </div>
    </div>
  );
}
