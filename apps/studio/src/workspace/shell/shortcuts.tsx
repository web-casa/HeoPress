import { useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { withAdminBase } from '@/lib/keybindings/commands';
import type { ModuleDef } from './modules';
import { createSequenceMatcher } from './sequences';

/** Mount `G` + letter module jumps and `?` help once, in the shell. */
export function useModuleJumps(modules: readonly ModuleDef[], adminBase: string, onHelp: () => void): void {
  const navigate = useNavigate();
  const latest = useRef({ modules, adminBase, onHelp });
  latest.current = { modules, adminBase, onHelp };
  const keys = useMemo(() => new Set(modules.map((m) => m.key)), [modules]);

  useEffect(() => {
    const match = createSequenceMatcher(keys);
    const onKey = (e: KeyboardEvent) => {
      const result = match(e);
      if (!result) return;
      if (result.kind === 'help') {
        e.preventDefault();
        latest.current.onHelp();
      } else if (result.kind === 'jump') {
        const target = latest.current.modules.find((m) => m.key === result.key);
        if (target) {
          e.preventDefault();
          void navigate({ to: withAdminBase(latest.current.adminBase, target.path) as never });
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [keys, navigate]);
}

export function ShortcutsDialog({ open, onClose, modules }: { open: boolean; onClose: () => void; modules: readonly ModuleDef[] }) {
  const { t } = useTranslation('shell');
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal?.();
    if (!open && dialog.open) dialog.close?.();
  }, [open]);
  const rows: Array<[string, string]> = [
    ['⌘K', t('shortcuts.palette')],
    ['?', t('shortcuts.help')],
    ['J', t('shortcuts.next')],
    ['K', t('shortcuts.previous')],
    ...modules.map((m): [string, string] => [`G ${m.key.toUpperCase()}`, t('shortcuts.goTo', { module: t(`modules.${m.id}`) })]),
  ];
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-labelledby="ws-shortcuts-title"
      className="w-[min(92vw,420px)] rounded-pop border border-line bg-panel p-0 text-fg shadow-2xl backdrop:bg-black/40"
    >
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <h2 id="ws-shortcuts-title" className="t-section">{t('shortcuts.title')}</h2>
        <button type="button" onClick={onClose} className="rounded-ctl px-2 py-1 text-sm text-dim hover:bg-panel-2">
          {t('close')}
        </button>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 px-4 py-3 text-sm">
        {rows.map(([keys, label]) => (
          <div key={keys} className="contents">
            <dt><kbd className="rounded border border-line bg-panel-2 px-1.5 py-0.5 font-mono text-[12px]">{keys}</kbd></dt>
            <dd className="text-dim">{label}</dd>
          </div>
        ))}
      </dl>
    </dialog>
  );
}
