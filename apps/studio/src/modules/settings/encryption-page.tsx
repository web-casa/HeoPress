// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Loader2, Lock, ShieldCheck } from 'lucide-react';
import i18n from 'i18next';
import { Trans, useTranslation } from 'react-i18next';
import { siteFetch } from '@/lib/http';

/**
 * Encryption settings — envelope (per-record DEK) mode toggle
 * (regulated-content-readiness task 3.6; Req 4.5).
 *
 * Envelope mode is an operator-controlled setting (NOT a raw env var) so it
 * cannot be flipped accidentally and every change is audited. Changing it
 * requires the admin to re-enter their password (step-up auth); the server
 * then runs a background migration that converts existing records to the new
 * mode. Reads stay correct throughout because every record is self-describing
 * (its stored wrapped DEK is the source of truth).
 *
 * Consumes:
 *   GET  /api/v1/admin/encryption/envelope  → { data: EnvelopeSetting }
 *   POST /api/v1/admin/encryption/envelope  { enabled, password }
 *   POST /api/v1/admin/encryption/envelope/migrate  (drain more batches)
 */

interface MigrationState {
  direction: 'to_envelope' | 'to_shared' | null;
  status: 'idle' | 'running' | 'completed';
  cursor: string | null;
  processed: number;
  startedAt: string | null;
  updatedAt: string | null;
}
interface EnvelopeSetting {
  enabled: boolean;
  migration: MigrationState;
}

const BASE = '/api/v1/admin/encryption/envelope';

async function fetchEnvelope(): Promise<EnvelopeSetting> {
  const res = await siteFetch(BASE, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(res.status === 403 ? i18n.t('system:encryption.errors.forbidden') : i18n.t('system:encryption.errors.load'));
  const json = (await res.json()) as { data: EnvelopeSetting };
  return json.data;
}

async function setEnvelope(enabled: boolean, password: string): Promise<void> {
  const res = await siteFetch(BASE, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ enabled, password }),
  });
  if (res.ok) return;
  let code = 'UNKNOWN';
  try {
    const body = (await res.json()) as { errors?: { code?: string; message?: string }[] };
    code = body.errors?.[0]?.code ?? code;
    if (res.status === 401) throw new Error(i18n.t('system:encryption.errors.password'));
    throw new Error(body.errors?.[0]?.message ?? i18n.t('system:encryption.errors.request', { code }));
  } catch (e) {
    if (e instanceof Error && e.message) throw e;
    throw new Error(i18n.t('system:encryption.errors.request', { code: res.status }));
  }
}

async function drainMigration(): Promise<void> {
  await siteFetch(`${BASE}/migrate`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  });
}

export function EncryptionSettingsPage() {
  const { t } = useTranslation(['system', 'common']);
  const qc = useQueryClient();
  const passwordFieldId = useId();
  const [password, setPassword] = useState('');
  const [pendingEnabled, setPendingEnabled] = useState<boolean | null>(null);

  const settingQuery = useQuery({ queryKey: ['encryption-envelope'], queryFn: fetchEnvelope });
  const setting = settingQuery.data;
  const migrating = setting?.migration.status === 'running';

  const toggleMutation = useMutation({
    mutationFn: async (enabled: boolean) => setEnvelope(enabled, password),
    onSuccess: () => {
      setPassword('');
      setPendingEnabled(null);
      void qc.invalidateQueries({ queryKey: ['encryption-envelope'] });
    },
  });

  const drainMutation = useMutation({
    mutationFn: drainMigration,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['encryption-envelope'] }),
  });

  function confirmToggle() {
    if (pendingEnabled === null || password.length === 0) return;
    toggleMutation.mutate(pendingEnabled);
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <Lock className="size-5" aria-hidden /> {t('encryption.title')}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t('encryption.description')}
        </p>
      </header>

      {settingQuery.isLoading && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden /> {t('common:loading')}
        </p>
      )}
      {settingQuery.isError && (
        <p className="text-sm text-destructive">{(settingQuery.error as Error).message}</p>
      )}

      {setting && (
        <section className="space-y-4 rounded-lg border p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium">{t('encryption.mode')}</p>
              <p className="text-sm text-muted-foreground">
                <Trans
                  t={t}
                  i18nKey="encryption.currently"
                  values={{ state: setting.enabled ? t('encryption.enabled') : t('encryption.disabled') }}
                  components={{ state: <span className={setting.enabled ? 'text-emerald-600' : 'text-muted-foreground'} /> }}
                />
              </p>
            </div>
            {setting.enabled ? (
              <ShieldCheck className="size-6 text-emerald-600" aria-hidden />
            ) : null}
          </div>

          {migrating && (
            <div className="rounded-md bg-muted p-3 text-sm">
              <p className="flex items-center gap-2 font-medium">
                <Loader2 className="size-4 animate-spin" aria-hidden /> {t('encryption.migrating')}
              </p>
              <p className="text-muted-foreground">
                {t('encryption.progress', {
                  direction:
                    setting.migration.direction === 'to_envelope' ? t('encryption.toEnvelope') : t('encryption.toShared'),
                  count: setting.migration.processed,
                })}
              </p>
              <button
                type="button"
                className="mt-2 rounded border px-2 py-1 text-xs hover:bg-background"
                onClick={() => drainMutation.mutate()}
                disabled={drainMutation.isPending}
              >
                {drainMutation.isPending ? t('encryption.draining') : t('encryption.continue')}
              </button>
            </div>
          )}

          {/* Step-up: confirm the change by re-entering the admin password. */}
          {pendingEnabled === null ? (
            <button
              type="button"
              className="rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted"
              onClick={() => setPendingEnabled(!setting.enabled)}
              disabled={migrating}
            >
              {setting.enabled ? t('encryption.disableMode') : t('encryption.enableMode')}
            </button>
          ) : (
            <div className="space-y-3 rounded-md border border-amber-300 bg-amber-50 p-3">
              <p className="text-sm font-medium">
                {pendingEnabled ? t('encryption.confirmEnable') : t('encryption.confirmDisable')}
              </p>
              <p className="text-xs text-muted-foreground">
                {t('encryption.reenter')}
              </p>
              <label htmlFor={passwordFieldId} className="block text-sm">
                {t('encryption.password')}
                <input
                  id={passwordFieldId}
                  type="password"
                  autoComplete="current-password"
                  className="mt-1 w-full rounded border px-2 py-1"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </label>
              {toggleMutation.isError && (
                <p className="text-sm text-destructive">{(toggleMutation.error as Error).message}</p>
              )}
              <div className="flex gap-2">
                <button
                  type="button"
                  className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
                  onClick={confirmToggle}
                  disabled={password.length === 0 || toggleMutation.isPending}
                >
                  {toggleMutation.isPending ? t('encryption.applying') : t('encryption.confirm')}
                </button>
                <button
                  type="button"
                  className="rounded-md border px-3 py-2 text-sm"
                  onClick={() => {
                    setPendingEnabled(null);
                    setPassword('');
                    toggleMutation.reset();
                  }}
                >
                  {t('common:cancel')}
                </button>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
