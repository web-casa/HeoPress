// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Keyboard, RotateCcw } from 'lucide-react';
import { Trans, useTranslation } from 'react-i18next';
import { getApiClient } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useKeybindingsStore } from '@/lib/keybindings/store';
import {
  ACTIONS,
  ACTIONS_BY_ID,
  findConflicts,
  type ActionCategory,
} from '@/lib/keybindings/actions';
import { eventToChord, formatChord } from '@/lib/keybindings/chord';
import {
  detectPlatform,
  isReserved,
  isAltGrRisk,
  SOFT_RESERVED_CHORDS,
} from '@/lib/keybindings/platform';

const CATEGORY_ORDER: ActionCategory[] = ['Editing', 'Navigation', 'Global'];

/**
 * Keyboard shortcuts settings. Lists every action, shows its effective chord,
 * and lets the operator rebind / reset. Edits update the Zustand store
 * (so they take effect live) and persist to `users.preferences.keybindings`
 * via `PATCH /me/preferences`.
 */
export function KeyboardSettingsPage() {
  const { t } = useTranslation('system');
  const actionText = (id: string, field: 'label' | 'description', fallback: string) =>
    t(`keyboard.actions.${id.replace(/\./g, '_')}.${field}`, { defaultValue: fallback });
  const actionLabel = (id: string) => actionText(id, 'label', ACTIONS_BY_ID[id]?.label ?? id);
  const client = getApiClient();
  const qc = useQueryClient();
  const platform = useMemo(() => detectPlatform(), []);

  const resolvedKeymap = useKeybindingsStore((s) => s.resolvedKeymap);
  const setBinding = useKeybindingsStore((s) => s.setBinding);
  const resetBinding = useKeybindingsStore((s) => s.resetBinding);
  const resetAll = useKeybindingsStore((s) => s.resetAll);

  const [capturing, setCapturing] = useState<string | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);

  const conflicts = useMemo(() => findConflicts(resolvedKeymap), [resolvedKeymap]);

  const persistMutation = useMutation({
    mutationFn: (keybindings: Record<string, string>) =>
      client.me.updatePreferences({ keybindings }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['me', 'preferences'] });
    },
  });

  // Read overrides straight from the store after a mutation so we persist the
  // freshest map (store updates are synchronous).
  const persist = () => {
    persistMutation.mutate(useKeybindingsStore.getState().overrides);
  };

  // Capture the next chord while rebinding. Reserved chords are rejected with a
  // message; anything else is applied + persisted, and capture closes.
  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setCapturing(null);
        setCaptureError(null);
        return;
      }
      const chord = eventToChord(e, platform);
      if (!chord) return; // bare modifier — keep waiting for a full chord
      if (isReserved(chord)) {
        setCaptureError(t('keyboard.reserved', { chord: formatChord(chord, platform) }));
        return;
      }
      setBinding(capturing, chord);
      setCapturing(null);
      setCaptureError(null);
      persist();
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capturing, platform]);

  const handleReset = (actionId: string) => {
    resetBinding(actionId);
    persist();
  };
  const handleResetAll = () => {
    resetAll();
    persist();
  };

  return (
    <div className="mx-auto max-w-3xl space-y-8 p-6">
      <header className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-3xl font-semibold tracking-tight">
            <Keyboard className="h-7 w-7" /> {t('keyboard.title')}
          </h1>
          <p className="text-sm text-muted-foreground">
            <Trans
              t={t}
              i18nKey="keyboard.description"
              values={{ key: platform === 'mac' ? 'Cmd (⌘)' : 'Ctrl' }}
              components={{ kbd: <kbd className="rounded border bg-muted px-1" /> }}
            />
          </p>
        </div>
        <button
          type="button"
          onClick={handleResetAll}
          className="inline-flex shrink-0 items-center gap-1 rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
        >
          <RotateCcw className="h-3.5 w-3.5" /> {t('keyboard.resetAll')}
        </button>
      </header>

      {persistMutation.isError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive">
          {t('keyboard.saveFailed')}
        </div>
      )}

      {CATEGORY_ORDER.map((category) => {
        const actions = ACTIONS.filter((a) => a.category === category);
        if (actions.length === 0) return null;
        return (
          <section key={category} className="space-y-2">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {t(`keyboard.categories.${category}`)}
            </h2>
            <ul className="divide-y rounded-md border">
              {actions.map((action) => {
                const chord = resolvedKeymap[action.id] ?? '';
                const isConflict = chord !== '' && conflicts.has(chord);
                const softWarning = SOFT_RESERVED_CHORDS.get(chord);
                const altGr = chord !== '' && isAltGrRisk(chord, platform);
                return (
                  <li
                    key={action.id}
                    className="flex items-center justify-between gap-4 px-3 py-3"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{actionLabel(action.id)}</p>
                      <p className="text-xs text-muted-foreground">
                        {actionText(action.id, 'description', action.description)}
                      </p>
                      {isConflict && (
                        <p className="mt-1 flex items-center gap-1 text-xs text-destructive">
                          <AlertTriangle className="h-3 w-3" />{' '}
                          {t('keyboard.conflicts', {
                            actions: (conflicts.get(chord) ?? [])
                              .filter((id) => id !== action.id)
                              .map((id) => actionLabel(id))
                              .join(', '),
                          })}
                        </p>
                      )}
                      {!isConflict && (softWarning || altGr) && (
                        <p className="mt-1 flex items-center gap-1 text-xs text-amber-600">
                          <AlertTriangle className="h-3 w-3" />
                          {altGr
                            ? t('keyboard.altGr')
                            : t(`keyboard.soft.${chord.replace(/\+/g, '_')}`, { defaultValue: softWarning })}
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setCaptureError(null);
                          setCapturing(action.id);
                        }}
                        className={cn(
                          'min-w-24 rounded-md border px-3 py-1.5 text-sm font-mono',
                          capturing === action.id
                            ? 'border-primary bg-primary/10 text-primary'
                            : 'hover:bg-muted',
                        )}
                      >
                        {capturing === action.id
                          ? t('keyboard.pressKeys')
                          : chord
                            ? formatChord(chord, platform)
                            : t('keyboard.unassigned')}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleReset(action.id)}
                        title={t('keyboard.resetDefault')}
                        aria-label={t('keyboard.resetAction', { action: actionLabel(action.id) })}
                        className="rounded-md border p-1.5 text-muted-foreground hover:bg-muted"
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}

      {capturing && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4"
          role="presentation"
          onClick={() => setCapturing(null)}
        >
          <div
            className="w-full max-w-sm rounded-lg border bg-background p-6 text-center shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-sm font-medium">
              {t('keyboard.capture', { action: actionLabel(capturing) })}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              <Trans t={t} i18nKey="keyboard.escHint" components={{ kbd: <kbd className="rounded border bg-muted px-1" /> }} />
            </p>
            {captureError && (
              <p className="mt-3 text-xs text-destructive">{captureError}</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
