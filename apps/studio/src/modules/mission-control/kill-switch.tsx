// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { OctagonX } from 'lucide-react';
import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { cn } from '@/lib/cn';
import { missionControlApi } from './api';

/**
 * Kill switch UI (content-os task 18.3; Req 16.6): four escalating scopes.
 * Freezing a role or the whole site is a two-step confirm — type the scope
 * name to arm the button. Lifting is immediate (restoring safety is cheap).
 */

const SCOPES = [
  { id: 'run', needsTarget: true, confirm: false },
  { id: 'intent', needsTarget: true, confirm: false },
  { id: 'role', needsTarget: true, confirm: true },
  { id: 'site', needsTarget: false, confirm: true },
] as const;

export function KillSwitchPanel() {
  const { t } = useTranslation('agents');
  const queryClient = useQueryClient();
  const [scope, setScope] = useState<(typeof SCOPES)[number]['id']>('run');
  const [targetId, setTargetId] = useState('');
  const [reason, setReason] = useState('');
  const [confirmText, setConfirmText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const stateQuery = useQuery({ queryKey: ['mc-kill-switch'], queryFn: missionControlApi.killSwitch });

  const activateMutation = useMutation({
    mutationFn: () =>
      missionControlApi.activateKillSwitch(scope, targetId.trim() || undefined, reason.trim() || undefined),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mc-kill-switch'] });
      setConfirmText('');
      setError(null);
    },
    onError: (err: Error) => setError(err.message),
  });

  const liftMutation = useMutation({
    mutationFn: ({ liftScope, target }: { liftScope: 'role' | 'site'; target?: string }) =>
      missionControlApi.liftKillSwitch(liftScope, target),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['mc-kill-switch'] }),
    onError: (err: Error) => setError(err.message),
  });

  const selected = SCOPES.find((s) => s.id === scope)!;
  // Two-step confirm for freezes: the user must type the scope id to arm.
  const armed = !selected.confirm || confirmText.trim().toLowerCase() === selected.id;
  const active = stateQuery.data?.active ?? [];

  return (
    <div className="space-y-6">
      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">{error}</p>
      )}

      <section className="rounded-lg border border-destructive/30 p-4">
        <h3 className="mb-3 inline-flex items-center gap-2 text-sm font-semibold text-destructive">
          <OctagonX className="h-4 w-4" /> {t('killSwitch.stopTitle')}
        </h3>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {SCOPES.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => {
                setScope(s.id);
                setConfirmText('');
              }}
              className={cn(
                'rounded-md border px-2 py-2 text-xs',
                scope === s.id ? 'border-destructive bg-destructive/10 font-medium' : 'hover:bg-muted',
              )}
              title={t(`killSwitch.scopes.${s.id}.hint`)}
            >
              {t(`killSwitch.scopes.${s.id}.label`)}
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">{t(`killSwitch.scopes.${selected.id}.hint`)}</p>

        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {selected.needsTarget && (
            <label className="block text-xs font-medium text-muted-foreground">
              {t(`killSwitch.target.${scope}`)}
              <input
                value={targetId}
                onChange={(e) => setTargetId(e.target.value)}
                className="mt-1 w-full rounded-md border bg-background px-2 py-2 text-sm"
              />
            </label>
          )}
          <label className="block text-xs font-medium text-muted-foreground">
            {t('killSwitch.reason')}
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="mt-1 w-full rounded-md border bg-background px-2 py-2 text-sm"
            />
          </label>
        </div>

        {selected.confirm && (
          <label className="mt-3 block text-xs font-medium text-destructive">
            <Trans
              t={t}
              i18nKey="killSwitch.confirmStep"
              values={{ word: selected.id }}
              components={{ code: <code className="rounded bg-destructive/10 px-1" /> }}
            />
            <input
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              className="mt-1 w-full rounded-md border border-destructive/40 bg-background px-2 py-2 text-sm"
            />
          </label>
        )}

        <button
          type="button"
          onClick={() => activateMutation.mutate()}
          disabled={!armed || activateMutation.isPending || (selected.needsTarget && !targetId.trim())}
          className="mt-3 rounded-md bg-destructive px-3 py-1.5 text-xs font-medium text-destructive-foreground disabled:opacity-50"
        >
          {activateMutation.isPending ? t('killSwitch.stopping') : t(`killSwitch.scopes.${selected.id}.label`)}
        </button>
      </section>

      <section>
        <h3 className="mb-2 text-sm font-semibold">{t('killSwitch.activeFreezes')}</h3>
        {active.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('killSwitch.nothingFrozen')}</p>
        ) : (
          <ul className="space-y-2">
            {active.map((freeze) => (
              <li
                key={freeze.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm"
              >
                <span>
                  <strong>{t(`killSwitch.scopeName.${freeze.scope}`, { defaultValue: freeze.scope })}</strong>
                  {freeze.targetRole ? ` · ${freeze.targetRole}` : ''}
                  {freeze.reason && <span className="ml-2 text-xs text-muted-foreground">{freeze.reason}</span>}
                  <span className="ml-2 text-xs text-muted-foreground">
                    {t('killSwitch.since', { time: new Date(freeze.createdAt).toLocaleString() })}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() =>
                    liftMutation.mutate({
                      liftScope: freeze.scope as 'role' | 'site',
                      target: freeze.targetRole ?? undefined,
                    })
                  }
                  disabled={liftMutation.isPending}
                  className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
                >
                  {t('killSwitch.lift')}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
