import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { create } from 'zustand';

/** At least 8 seconds to undo a cheap action (ADR-0019 §5.3). */
export const UNDO_WINDOW_MS = 8_000;

interface Toast {
  id: number;
  message: string;
  onUndo?: () => void;
}

interface ToastState {
  toasts: Toast[];
  show(message: string, onUndo?: () => void): number;
  dismiss(id: number): void;
}

let nextId = 1;

export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  show(message, onUndo) {
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts, { id, message, onUndo }] }));
    return id;
  },
  dismiss(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
}));

/** Show `message` with an Undo button for `UNDO_WINDOW_MS`. */
export function showUndo(message: string, onUndo: () => void): number {
  return useToasts.getState().show(message, onUndo);
}

function ToastItem({ toast }: { toast: Toast }) {
  const { t } = useTranslation('common');
  const dismiss = useToasts((s) => s.dismiss);
  useEffect(() => {
    const timer = window.setTimeout(() => dismiss(toast.id), UNDO_WINDOW_MS);
    return () => window.clearTimeout(timer);
  }, [toast.id, dismiss]);
  return (
    <div className="flex items-center gap-3 rounded-pop border border-line bg-fg px-4 py-2.5 text-[13px] text-bg shadow-xl">
      <span className="flex-1">{toast.message}</span>
      {toast.onUndo ? (
        <button
          type="button"
          className="rounded-ctl px-2 py-1 font-semibold text-brand-soft hover:underline"
          onClick={() => {
            toast.onUndo?.();
            dismiss(toast.id);
          }}
        >
          {t('undo')}
        </button>
      ) : null}
      <button type="button" aria-label={t('close')} className="px-1 opacity-70 hover:opacity-100" onClick={() => dismiss(toast.id)}>
        ×
      </button>
    </div>
  );
}

/** Mounted once by the shell; announces new toasts politely. */
export function ToastRegion() {
  const toasts = useToasts((s) => s.toasts);
  return (
    <div aria-live="polite" className="pointer-events-none fixed bottom-4 left-1/2 z-[70] flex w-[min(92vw,480px)] -translate-x-1/2 flex-col gap-2 [&>*]:pointer-events-auto">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>
  );
}
