import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Command } from 'cmdk';
import { FileText, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { search, type SearchHit } from '@heopress/sdk';
import { getApiClient } from '@/lib/api';
import { withAdminBase } from '@/lib/keybindings/commands';
import type { PermissionAction } from '@heopress/sdk';
import { usePermissions } from '@/lib/use-permissions';
import { availableCommands, type PaletteCommand } from './commands';

const DEBOUNCE_MS = 250;

/**
 * ⌘K / Ctrl+K palette (ADR-0019 §5.1): jump to modules and views, find
 * content of the current site by title, run actions — only what the user may
 * do. Focus returns to where it was when the palette closes.
 */
export function CommandPalette({
  open,
  onClose,
  adminBase,
  onAction,
}: {
  open: boolean;
  onClose: () => void;
  adminBase: string;
  onAction: (id: string) => void;
}) {
  const { t } = useTranslation(['shell', 'nav']);
  const navigate = useNavigate();
  const { isAdmin, can } = usePermissions();
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const returnFocus = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  // Remember the focused element before the input takes focus (during render, ahead of autoFocus).
  if (open && !wasOpen.current) returnFocus.current = document.activeElement as HTMLElement | null;
  wasOpen.current = open;

  useEffect(() => {
    if (open) {
      setQuery('');
      setDebounced('');
    } else if (returnFocus.current) {
      returnFocus.current.focus?.();
      returnFocus.current = null;
    }
  }, [open]);

  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(query.trim()), DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [open, onClose]);

  const commands = useMemo(
    () => availableCommands(isAdmin, (collection, action) => can(collection, action as PermissionAction)),
    [isAdmin, can],
  );

  const hits = useQuery({
    queryKey: ['palette-search', debounced],
    enabled: open && debounced.length >= 2,
    queryFn: async () => (await getApiClient().request(search(debounced, { limit: 8 }))).data as SearchHit[],
    placeholderData: (prev) => prev,
  });

  if (!open) return null;

  const run = (command: PaletteCommand) => {
    onClose();
    if (command.kind === 'jump' && command.to) void navigate({ to: withAdminBase(adminBase, command.to) as never });
    else onAction(command.id);
  };
  const openHit = (hit: SearchHit) => {
    const id = typeof hit.id === 'string' ? hit.id : String(hit.id ?? '');
    if (!hit._collection || !id) return;
    onClose();
    void navigate({ to: withAdminBase(adminBase, `/content/${hit._collection}/${id}`) as never });
  };

  const jumps = commands.filter((c) => c.kind === 'jump');
  const actions = commands.filter((c) => c.kind === 'action');
  const itemClass =
    'flex cursor-pointer items-center gap-2 rounded-ctl px-2.5 py-2 text-[13.5px] text-fg aria-selected:bg-sel aria-selected:text-fg';
  const groupClass = 'px-1 py-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[11.5px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-dim';

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center bg-black/40 p-4 pt-[12vh]" role="presentation" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('search')}
        className="w-full max-w-xl overflow-hidden rounded-pop border border-line bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <Command label={t('search')} loop shouldFilter>
          <div className="flex items-center gap-2 border-b border-line px-3">
            <Search className="h-4 w-4 shrink-0 text-icon" aria-hidden="true" />
            <Command.Input
              autoFocus
              value={query}
              onValueChange={setQuery}
              placeholder={t('searchHint')}
              className="h-12 flex-1 bg-transparent text-[14px] outline-none placeholder:text-dim"
            />
            <kbd className="rounded border border-line bg-panel-2 px-1.5 py-0.5 font-mono text-[10.5px] text-dim">{t('keys.esc')}</kbd>
          </div>
          <Command.List className="max-h-[52vh] overflow-y-auto p-1.5">
            <Command.Empty className="px-2 py-6 text-center text-[13px] text-dim">{t('paletteEmpty')}</Command.Empty>
            {hits.data && hits.data.length > 0 ? (
              <Command.Group heading={t('paletteContent')} className={groupClass}>
                {hits.data.map((hit) => {
                  const id = typeof hit.id === 'string' ? hit.id : String(hit.id ?? '');
                  return (
                    <Command.Item key={`${hit._collection}:${id}`} value={`content ${hit._title ?? id} ${debounced}`} onSelect={() => openHit(hit)} className={itemClass}>
                      <FileText className="h-4 w-4 text-icon" aria-hidden="true" />
                      <span className="flex-1 truncate">{hit._title || id}</span>
                      <span className="text-[11.5px] text-dim">{hit._collection}</span>
                    </Command.Item>
                  );
                })}
              </Command.Group>
            ) : null}
            <Command.Group heading={t('paletteJump')} className={groupClass}>
              {jumps.map((c) => (
                <Command.Item key={c.id} value={`${t(c.label)} ${t(`modules.${c.module}`)} ${c.keywords ?? ''}`} onSelect={() => run(c)} className={itemClass}>
                  <span className="flex-1">{t(c.label)}</span>
                  <span className="text-[11.5px] text-dim">{t(`modules.${c.module}`)}</span>
                </Command.Item>
              ))}
            </Command.Group>
            <Command.Group heading={t('paletteActions')} className={groupClass}>
              {actions.map((c) => (
                <Command.Item key={c.id} value={`${t(c.label)} ${c.keywords ?? ''}`} onSelect={() => run(c)} className={itemClass}>
                  {t(c.label)}
                </Command.Item>
              ))}
            </Command.Group>
          </Command.List>
        </Command>
      </div>
    </div>
  );
}
