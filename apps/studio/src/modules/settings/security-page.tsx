// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Loader2, Shield } from 'lucide-react';
import { getActiveSite, getActiveToken, logoutEverywhere } from '@/lib/api';
import { getApiBaseUrl } from '@/lib/api-base';
import i18n from 'i18next';
import { useTranslation } from 'react-i18next';
import { siteFetch } from '@/lib/http';
import { PageHeader } from '@/workspace/ui/page-header';

interface TotpStatus {
  enabled: boolean;
  enrolledAt: string | null;
  recoveryCodesRemaining: number;
}

/**
 * `/api/v1/me/tfa*` sits behind `withAuth`, which only reads the
 * `Authorization` header — there is no session cookie. The bearer token has to
 * be attached explicitly, and the base URL resolved through `getApiBaseUrl()`
 * so the page also works when the Studio is served from a different origin
 * than the CMS (standalone Pages deploy, desktop shell — contract C2).
 */
const headers = () => ({
  Accept: 'application/json',
  'Content-Type': 'application/json',
  'X-HeoPress-Site': getActiveSite(),
  'X-HeoPress-Client': 'studio',
  Authorization: `Bearer ${getActiveToken()}`,
});

const url = (path: string) => `${getApiBaseUrl()}${path}`;

async function fetchStatus(): Promise<TotpStatus> {
  const res = await siteFetch(url('/api/v1/me/tfa'), { headers: headers() });
  if (!res.ok) throw new Error(i18n.t('system:security.errors.load'));
  const json = (await res.json()) as { data: TotpStatus };
  return json.data;
}

export function SecuritySettingsPage() {
  const { t } = useTranslation(['system', 'common']);
  const qc = useQueryClient();
  const passwordId = useId();
  const codeId = useId();
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [setupSecret, setSetupSecret] = useState<string | null>(null);
  const [otpauthUrl, setOtpauthUrl] = useState<string | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [recoveryCode, setRecoveryCode] = useState('');
  const [disableWithRecovery, setDisableWithRecovery] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const statusQuery = useQuery({ queryKey: ['me-tfa'], queryFn: fetchStatus });
  const enabled = statusQuery.data?.enabled ?? false;

  const setupMutation = useMutation({
    mutationFn: async () => {
      const res = await siteFetch(url('/api/v1/me/tfa/setup'), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ password }),
      });
      const body = await res.json().catch(() => null) as { data?: { secret?: string; otpauthUrl?: string }; errors?: { message?: string }[] };
      if (!res.ok) throw new Error(body?.errors?.[0]?.message ?? t('security.errors.setup'));
      return body.data!;
    },
    onSuccess: (data) => {
      setSetupSecret(data.secret ?? null);
      setOtpauthUrl(data.otpauthUrl ?? null);
      setPassword('');
      setMessage(null);
    },
    onError: (err: Error) => setMessage(err.message),
  });

  const confirmMutation = useMutation({
    mutationFn: async () => {
      if (!setupSecret) throw new Error(t('security.errors.startFirst'));
      const res = await siteFetch(url('/api/v1/me/tfa/confirm'), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ secret: setupSecret, code }),
      });
      const body = await res.json().catch(() => null) as { data?: { recoveryCodes?: string[] }; errors?: { message?: string }[] };
      if (!res.ok) throw new Error(body?.errors?.[0]?.message ?? t('security.errors.confirm'));
      return body.data!.recoveryCodes ?? [];
    },
    onSuccess: (codes) => {
      setRecoveryCodes(codes);
      setSetupSecret(null);
      setOtpauthUrl(null);
      setCode('');
      void qc.invalidateQueries({ queryKey: ['me-tfa'] });
    },
    onError: (err: Error) => setMessage(err.message),
  });

  const disableMutation = useMutation({
    mutationFn: async () => {
      const res = await siteFetch(url('/api/v1/me/tfa'), {
        method: 'DELETE',
        headers: headers(),
        // A recovery code is the only way out when the encryption key that
        // wrapped this seed is gone: authenticator codes can no longer be
        // verified, so requiring one would strand the account.
        body: JSON.stringify(
          disableWithRecovery ? { password, recoveryCode } : { password, code },
        ),
      });
      const body = await res.json().catch(() => null) as { errors?: { message?: string }[] };
      if (!res.ok) throw new Error(body?.errors?.[0]?.message ?? t('security.errors.disable'));
    },
    onSuccess: () => {
      setPassword('');
      setCode('');
      setRecoveryCode('');
      setDisableWithRecovery(false);
      setRecoveryCodes(null);
      void qc.invalidateQueries({ queryKey: ['me-tfa'] });
    },
    onError: (err: Error) => setMessage(err.message),
  });

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader
        title={<span className="flex items-center gap-2"><Shield className="h-5 w-5" aria-hidden="true" /> {t('security.title')}</span>}
        description={t('security.description')}
      />

      {message ? (
        <p role="alert" className="text-sm text-bad">{message}</p>
      ) : null}

      <section className="rounded-ctl border border-line bg-bg p-4 space-y-3">
        <h2 className="t-section">{t('security.tfaTitle')}</h2>
        {statusQuery.isPending ? (
          <p className="text-sm text-dim">{t('common:loading')}</p>
        ) : statusQuery.isError ? (
          // Never fall through to "Disabled" on a failed load: that reads as a
          // definite security state and would invite a second enrollment.
          <p role="alert" className="text-sm text-bad">
            {t('security.statusFailed')}
          </p>
        ) : (
          <p className="text-sm text-dim">
            {t('security.status', { state: enabled ? t('security.enabled') : t('security.disabled') })}
            {enabled && statusQuery.data?.recoveryCodesRemaining != null
              ? ` · ${t('security.codesRemaining', { count: statusQuery.data.recoveryCodesRemaining })}`
              : null}
          </p>
        )}

        {statusQuery.isSuccess && !enabled && !setupSecret ? (
          <div className="space-y-3">
            <label htmlFor={passwordId} className="block text-sm font-medium">{t('security.confirmPassword')}</label>
            <input
              id={passwordId}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="block w-full rounded-ctl border border-line px-3 py-2 text-sm"
            />
            <button
              type="button"
              disabled={setupMutation.isPending || password.length === 0}
              onClick={() => setupMutation.mutate()}
              className="inline-flex items-center gap-2 rounded-ctl bg-brand px-4 py-2 text-sm font-medium text-brand-fg disabled:opacity-60"
            >
              {setupMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {t('security.enable')}
            </button>
          </div>
        ) : null}

        {setupSecret ? (
          <div className="space-y-3">
            <p className="text-sm">{t('security.addSecret')}</p>
            <code className="block break-all rounded bg-panel-2 p-2 text-xs">{setupSecret}</code>
            {otpauthUrl ? (
              <p className="text-xs text-dim break-all">{t('security.uri', { uri: otpauthUrl })}</p>
            ) : null}
            <label htmlFor={codeId} className="block text-sm font-medium">{t('security.enterCode')}</label>
            <input
              id={codeId}
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={8}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="block w-full rounded-ctl border border-line px-3 py-2 text-sm"
            />
            <button
              type="button"
              disabled={confirmMutation.isPending || code.length < 6}
              onClick={() => confirmMutation.mutate()}
              className="rounded-ctl bg-brand px-4 py-2 text-sm font-medium text-brand-fg disabled:opacity-60"
            >
              {t('security.confirmEnable')}
            </button>
          </div>
        ) : null}

        {recoveryCodes?.length ? (
          <div className="space-y-2 rounded-ctl border border-warn/40 bg-warn-soft p-3 text-sm">
            <p className="font-medium">{t('security.saveCodes')}</p>
            <ul className="font-mono text-xs space-y-1">
              {recoveryCodes.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {enabled ? (
          <div className="space-y-3 border-t border-line pt-4">
            <p className="text-sm font-medium">{t('security.disable')}</p>
            <input
              type="password"
              placeholder={t('security.password')}
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="block w-full rounded-ctl border border-line px-3 py-2 text-sm"
            />
            {disableWithRecovery ? (
              <input
                type="text"
                placeholder={t('security.recoveryCode')}
                value={recoveryCode}
                onChange={(e) => setRecoveryCode(e.target.value)}
                className="block w-full rounded-ctl border border-line px-3 py-2 text-sm"
              />
            ) : (
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder={t('security.totpCode')}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                className="block w-full rounded-ctl border border-line px-3 py-2 text-sm"
              />
            )}
            <button
              type="button"
              className="text-sm text-brand underline-offset-2 hover:underline"
              onClick={() => {
                setDisableWithRecovery((v) => !v);
                setMessage(null);
              }}
            >
              {disableWithRecovery
                ? t('security.useAuthenticator')
                : t('security.useRecovery')}
            </button>
            <button
              type="button"
              disabled={
                disableMutation.isPending ||
                password.length === 0 ||
                (disableWithRecovery ? recoveryCode.length === 0 : code.length < 6)
              }
              onClick={() => disableMutation.mutate()}
              className="block rounded-ctl border border-bad/40 px-4 py-2 text-sm text-bad disabled:opacity-60"
            >
              {t('security.disable')}
            </button>
          </div>
        ) : null}
      </section>

      <SignOutEverywhere />
    </div>
  );
}

/**
 * End every login of this account — all devices, all sites (HeoPress P04).
 * Then this browser signs in again.
 */
function SignOutEverywhere() {
  const { t } = useTranslation('system');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <section className="rounded-ctl border border-line bg-bg p-4 space-y-2">
      <h2 className="t-section">{t('security.sessions')}</h2>
      <p className="text-sm text-dim">
        {t('security.sessionsBody')}
      </p>
      {error ? <p role="alert" className="text-sm text-bad">{error}</p> : null}
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          if (!window.confirm(t('security.confirmSignOut'))) return;
          setBusy(true);
          setError(null);
          logoutEverywhere()
            .then(() => window.location.reload())
            .catch(() => {
              setError(t('security.signOutFailed'));
              setBusy(false);
            });
        }}
        className="rounded-ctl border border-bad/40 px-4 py-2 text-sm text-bad disabled:opacity-60"
      >
        {t('security.signOutAll')}
      </button>
    </section>
  );
}

export default SecuritySettingsPage;
