// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { useNavigate } from '@tanstack/react-router';
import { LogIn } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { getActiveSite, hasActiveToken, setActiveLogin } from '@/lib/api';
import { publicFetch } from '@/lib/http';
import { ADMIN_PATH_REGEX } from '@/modules/setup/schemas/admin-path';

interface AdminLoginPageProps {
  adminPath: string;
}

type LoginStatus = 'idle' | 'submitting' | 'error';
type LoginStep = 'credentials' | 'mfa';

export function AdminLoginPage({ adminPath }: AdminLoginPageProps) {
  const { t } = useTranslation('setup');
  const navigate = useNavigate();
  const normalizedAdminPath = useMemo(() => normalizeRouteAdminPath(adminPath), [adminPath]);
  const recoveryBasePath = normalizedAdminPath ? `${normalizedAdminPath}/recovery` : '/recovery';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [step, setStep] = useState<LoginStep>('credentials');
  const [challengeToken, setChallengeToken] = useState<string | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [status, setStatus] = useState<LoginStatus>('idle');
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (normalizedAdminPath && hasActiveToken()) {
      navigate({ to: normalizedAdminPath });
    }
  }, [navigate, normalizedAdminPath]);

  const finishLogin = useCallback(
    async (token: string, refreshToken?: string) => {
      if (!refreshToken) {
        setStatus('error');
        setMessage(t('login.failed'));
        return;
      }
      try {
        // Stored before anything relies on it (P04: a session the next page
        // load cannot find would look like a logout).
        await setActiveLogin({ token, refreshToken });
      } catch {
        setStatus('error');
        setMessage(t('login.sessionNotSaved'));
        return;
      }
      if (normalizedAdminPath) navigate({ to: normalizedAdminPath });
    },
    [navigate, normalizedAdminPath, t],
  );

  const onSubmitCredentials = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setStatus('submitting');
      setMessage(null);

      try {
        const response = await publicFetch('/api/v1/auth/login', {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'X-HeoPress-Site': getActiveSite(),
            'X-HeoPress-Client': 'studio',
          },
          body: JSON.stringify({ email, password }),
        });

        const body = await response.json().catch(() => null) as {
          data?: { token?: string; refreshToken?: string; status?: string; challengeToken?: string };
          errors?: Array<{ message?: string; code?: string }>;
        } | null;

        if (body?.data?.status === 'mfa_required' && body.data.challengeToken) {
          setChallengeToken(body.data.challengeToken);
          setStep('mfa');
          setStatus('idle');
          return;
        }

        if (!response.ok || !body?.data?.token) {
          setStatus('error');
          setMessage(body?.errors?.[0]?.message ?? t('login.failed'));
          return;
        }

        await finishLogin(body.data.token, body.data.refreshToken);
      } catch {
        setStatus('error');
        setMessage(t('login.unreachable'));
      }
    },
    [email, finishLogin, password, t],
  );

  const onSubmitMfa = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!challengeToken) return;
      setStatus('submitting');
      setMessage(null);

      try {
        const payload = useRecovery
          ? { challengeToken, recoveryCode }
          : { challengeToken, code: totpCode };

        const response = await publicFetch('/api/v1/auth/verify-totp', {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'X-HeoPress-Site': getActiveSite(),
            'X-HeoPress-Client': 'studio',
          },
          body: JSON.stringify(payload),
        });

        const body = await response.json().catch(() => null) as {
          data?: { token?: string; refreshToken?: string };
          errors?: Array<{ message?: string }>;
        } | null;

        if (!response.ok || !body?.data?.token) {
          setStatus('error');
          setMessage(body?.errors?.[0]?.message ?? t('login.verifyFailed'));
          return;
        }

        await finishLogin(body.data.token, body.data.refreshToken);
      } catch {
        setStatus('error');
        setMessage(t('login.unreachable'));
      }
    },
    [challengeToken, finishLogin, recoveryCode, totpCode, useRecovery, t],
  );

  // After every hook: returning earlier changed the hook order whenever
  // adminPath switched between valid and invalid (HeoPress P01 lint fix).
  if (!normalizedAdminPath) {
    return <AdminLoginNotFound />;
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-bg px-4 py-12">
      <section className="w-full max-w-sm space-y-5 rounded-card border border-line bg-panel p-6 shadow-sm">
        <header className="space-y-1">
          <h1 className="text-lg font-semibold tracking-tight">{t('login.title')}</h1>
          <p className="text-sm text-dim">
            {step === 'credentials' ? t('login.subtitle') : t('login.mfaSubtitle')}
          </p>
        </header>

        {step === 'credentials' ? (
          <form className="space-y-4" onSubmit={onSubmitCredentials}>
            <div className="space-y-1">
              <label htmlFor="admin-login-email" className="block text-sm font-medium">
                {t('login.email')}
              </label>
              <input
                id="admin-login-email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="w-full rounded-ctl border border-line bg-bg px-2.5 py-1.5 text-[13px] outline-none focus:border-brand block transition focus:ring-2 focus:ring-brand/30"
              />
            </div>

            <div className="space-y-1">
              <label htmlFor="admin-login-password" className="block text-sm font-medium">
                {t('login.password')}
              </label>
              <input
                id="admin-login-password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="w-full rounded-ctl border border-line bg-bg px-2.5 py-1.5 text-[13px] outline-none focus:border-brand block transition focus:ring-2 focus:ring-brand/30"
              />
            </div>

            {message ? (
              <p role="alert" className="text-sm text-bad">
                {message}
              </p>
            ) : null}

            <button
              type="submit"
              disabled={status === 'submitting'}
              className="inline-flex w-full items-center justify-center gap-2 rounded-ctl bg-brand px-4 py-2 text-[13px] font-medium text-brand-fg shadow-sm transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <LogIn className="h-4 w-4" aria-hidden="true" />
              {status === 'submitting' ? t('login.signingIn') : t('login.signIn')}
            </button>
          </form>
        ) : (
          <form className="space-y-4" onSubmit={onSubmitMfa}>
            {!useRecovery ? (
              <div className="space-y-1">
                <label htmlFor="admin-login-totp" className="block text-sm font-medium">
                  {t('login.totpCode')}
                </label>
                <input
                  id="admin-login-totp"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  required={!useRecovery}
                  maxLength={8}
                  value={totpCode}
                  onChange={(event) => setTotpCode(event.target.value)}
                  className="w-full rounded-ctl border border-line bg-bg px-2.5 py-1.5 text-[13px] outline-none focus:border-brand block"
                />
              </div>
            ) : (
              <div className="space-y-1">
                <label htmlFor="admin-login-recovery" className="block text-sm font-medium">
                  {t('login.recoveryCode')}
                </label>
                <input
                  id="admin-login-recovery"
                  required={useRecovery}
                  value={recoveryCode}
                  onChange={(event) => setRecoveryCode(event.target.value)}
                  className="w-full rounded-ctl border border-line bg-bg px-2.5 py-1.5 text-[13px] outline-none focus:border-brand block"
                />
              </div>
            )}

            <button
              type="button"
              className="text-sm text-brand underline-offset-2 hover:underline"
              onClick={() => {
                setUseRecovery((v) => !v);
                setMessage(null);
              }}
            >
              {useRecovery ? t('login.useTotp') : t('login.useRecovery')}
            </button>

            {message ? (
              <p role="alert" className="text-sm text-bad">
                {message}
              </p>
            ) : null}

            <button
              type="submit"
              disabled={status === 'submitting'}
              className="inline-flex w-full items-center justify-center gap-2 rounded-ctl bg-brand px-4 py-2 text-[13px] font-medium text-brand-fg disabled:opacity-60"
            >
              {status === 'submitting' ? t('login.verifying') : t('login.verify')}
            </button>

            <button
              type="button"
              className="w-full text-sm text-dim"
              onClick={() => {
                setStep('credentials');
                setChallengeToken(null);
                setTotpCode('');
                setRecoveryCode('');
                setMessage(null);
              }}
            >
              {t('login.back')}
            </button>
          </form>
        )}

        {step === 'credentials' ? (
          <div className="space-y-2 border-t border-line pt-4 text-sm">
            <a
              href={`${recoveryBasePath}/backup-code`}
              className="block font-medium text-brand underline-offset-2 hover:underline"
            >
              {t('login.forgot')}
            </a>
          </div>
        ) : null}
      </section>
    </main>
  );
}

function normalizeRouteAdminPath(segment: string): string | null {
  const candidate = `/${segment.replace(/^\/+|\/+$/g, '')}`;
  return ADMIN_PATH_REGEX.test(candidate) ? candidate : null;
}

function AdminLoginNotFound() {
  const { t } = useTranslation('setup');
  return (
    <main className="flex min-h-screen items-center justify-center bg-bg px-4 py-12">
      <section role="alert" className="w-full max-w-sm rounded-card border border-line bg-panel p-6 shadow-sm">
        <h1 className="text-lg font-semibold tracking-tight">{t('login.notFoundTitle')}</h1>
        <p className="mt-2 text-sm text-dim">
          {t('login.notFoundBody')}
        </p>
      </section>
    </main>
  );
}

export default AdminLoginPage;
