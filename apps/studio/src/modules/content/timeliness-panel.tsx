import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlarmClock, Clock, Lock, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getApiClient } from '@/lib/api';
import { cn } from '@/lib/cn';

/**
 * Timeliness marks in the item editor (HeoPress v1.1; spec content/timeliness-marks).
 *
 * A mark is an operator's explicit, dated "needs an update": a short reason and an optional deadline. It lives in the
 * item's own columns, so it survives ordinary content writes. A marked item shows the badge (reason, deadline) and
 * "clear"; an unmarked one offers the form. The write is versioned like a hold, so a stale editor is refused rather
 * than silently overwriting; on success the returned version is handed back so the parent's next save is based on it
 * (`onChanged`).
 */

export interface TimelinessMarkView {
  needsUpdateSince: string | null;
  reason: string | null;
  dueAt: string | null;
}

const day = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
};

/** The "needs update" badge: the mark's reason and deadline, when they are known. */
export function TimelinessBadge({
  mark,
  detailed = false,
}: {
  mark: TimelinessMarkView;
  /** `true` in the editor (reason and deadline), `false` for a list row (the badge alone, with a tooltip). */
  detailed?: boolean;
}) {
  const { t } = useTranslation('items');
  return (
    <span
      data-testid="timeliness-badge"
      title={
        detailed
          ? undefined
          : [mark.reason, mark.dueAt ? t('timeliness.due', { date: day(mark.dueAt) }) : null].filter(Boolean).join(' · ') || undefined
      }
      className="inline-flex flex-wrap items-center gap-1 rounded-full border border-warn/40 bg-warn-soft px-2 py-0.5 text-[11px] font-medium text-warn"
    >
      <AlarmClock className="h-3 w-3" aria-hidden />
      {t('timeliness.badge')}
      {detailed && mark.needsUpdateSince ? (
        <span className="font-normal opacity-80">{t('timeliness.marked', { date: day(mark.needsUpdateSince) })}</span>
      ) : null}
      {detailed && mark.reason ? <span className="font-normal text-fg">{mark.reason}</span> : null}
      {detailed && mark.dueAt ? <span className="font-normal text-fg">{t('timeliness.due', { date: day(mark.dueAt) })}</span> : null}
    </span>
  );
}

/** The editor's timeliness panel: the mark when set, the form when it is not. */
export function TimelinessPanel({
  collection,
  itemId,
  mark,
  version,
  canUpdate,
  onChanged,
}: {
  collection: string;
  itemId: string;
  mark: TimelinessMarkView;
  /** The item version the form acts on (the editor's base version). */
  version: number;
  canUpdate: boolean;
  /** Called with the item's new version after a mark or a clear. */
  onChanged: (version: number) => void;
}) {
  const { t } = useTranslation('items');
  const client = getApiClient();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [error, setError] = useState<string | null>(null);

  const refresh = (nextVersion: number) => {
    setError(null);
    setOpen(false);
    setReason('');
    setDueAt('');
    void qc.invalidateQueries({ queryKey: ['item', collection, itemId] });
    void qc.invalidateQueries({ queryKey: ['items', collection] });
    onChanged(nextVersion);
  };

  const markMutation = useMutation({
    mutationFn: async () =>
      (
        await client.items(collection as never).markTimeliness(itemId, {
          reason: reason.trim(),
          dueAt: dueAt ? new Date(dueAt).toISOString() : null,
          expectedVersion: version,
        })
      ).data,
    onSuccess: (saved) => refresh(saved.version),
    onError: (err: unknown) => {
      setError(err instanceof Error ? err.message : t('timeliness.failed'));
      // A refused mark (conflict, permission) may mean the item moved: show the current row.
      void qc.invalidateQueries({ queryKey: ['item', collection, itemId] });
    },
  });

  const clearMutation = useMutation({
    mutationFn: async () => (await client.items(collection as never).clearTimeliness(itemId, { expectedVersion: version })).data,
    onSuccess: (saved) => refresh(saved.version),
    onError: (err: unknown) => {
      setError(err instanceof Error ? err.message : t('timeliness.failed'));
      void qc.invalidateQueries({ queryKey: ['item', collection, itemId] });
    },
  });

  const busy = markMutation.isPending || clearMutation.isPending;
  const marked = Boolean(mark.needsUpdateSince);

  return (
    <section aria-labelledby="timeliness-heading" className="mt-4 space-y-2 border-t border-line pt-3">
      <h2 id="timeliness-heading" className="flex items-center gap-1 text-xs font-semibold uppercase text-dim">
        <Clock className="h-3.5 w-3.5" aria-hidden /> {t('timeliness.heading')}
      </h2>

      {error && (
        <p role="alert" className="rounded-ctl border border-bad/40 bg-bad-soft p-2 text-xs text-bad">
          {error}
        </p>
      )}

      {marked ? (
        <div className="space-y-2">
          <TimelinessBadge mark={mark} detailed />
          <button
            type="button"
            onClick={() => clearMutation.mutate()}
            disabled={!canUpdate || busy}
            title={canUpdate ? undefined : t('detail.noUpdate')}
            className={cn(
              'inline-flex items-center gap-1 rounded-ctl border border-line px-2 py-1 text-xs',
              canUpdate ? 'hover:bg-panel-2' : 'cursor-not-allowed text-dim',
            )}
          >
            {canUpdate ? <X className="h-3.5 w-3.5" aria-hidden /> : <Lock className="h-3.5 w-3.5" aria-hidden />}
            {t('timeliness.clear')}
          </button>
        </div>
      ) : !canUpdate ? (
        <p className="text-xs text-dim">{t('timeliness.notMarked')}</p>
      ) : !open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1 rounded-ctl border border-line px-2 py-1 text-xs hover:bg-panel-2"
        >
          <AlarmClock className="h-3.5 w-3.5" aria-hidden /> {t('timeliness.mark')}
        </button>
      ) : (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (reason.trim()) markMutation.mutate();
          }}
        >
          <label className="block text-xs text-dim">
            {t('timeliness.reason')}
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t('timeliness.reasonPlaceholder')}
              maxLength={200}
              required
              className="mt-1 w-full rounded-ctl border border-line bg-bg px-2 py-1 text-sm"
            />
          </label>
          <label className="block text-xs text-dim">
            {t('timeliness.dueAt')}
            <input
              type="datetime-local"
              value={dueAt}
              onChange={(e) => setDueAt(e.target.value)}
              className="mt-1 w-full rounded-ctl border border-line bg-bg px-2 py-1 text-sm"
            />
          </label>
          <div className="flex items-center gap-2">
            <button
              type="submit"
              disabled={busy || !reason.trim()}
              className="inline-flex items-center gap-1 rounded-ctl bg-brand px-3 py-1 text-xs font-medium text-brand-fg disabled:opacity-50"
            >
              <AlarmClock className="h-3.5 w-3.5" aria-hidden /> {t('timeliness.save')}
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setError(null);
              }}
              className="rounded-ctl border border-line px-2 py-1 text-xs hover:bg-panel-2"
            >
              {t('timeliness.cancel')}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
