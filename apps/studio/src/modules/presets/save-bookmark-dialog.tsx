// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createBookmark, type PresetScope, type ViewState } from './api';

/**
 * Save-bookmark dialog (presets-inheritance Req 5.2, 5.3). Captures the current
 * view state as a named bookmark. Scope `user` is always available; `role`/
 * `global` are offered only when `canManageShared` (the current user is an
 * admin) — the server also enforces this, so a non-admin can never write a
 * shared bookmark even if the option were forced.
 */

export interface SaveBookmarkDialogProps {
  collection: string;
  view: ViewState;
  canManageShared: boolean;
  onClose: () => void;
}

export function SaveBookmarkDialog({ collection, view, canManageShared, onClose }: SaveBookmarkDialogProps) {
  const { t } = useTranslation('dataModel');
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [scope, setScope] = useState<PresetScope>('user');

  const mutation = useMutation({
    mutationFn: () =>
      createBookmark({
        collection,
        bookmark: name.trim(),
        // user scope → the server stamps the acting user; role/global → unowned
        // columns (server requires admin). We only send roleId=null for global.
        ...(scope === 'global' ? { roleId: null, userId: null } : {}),
        layout: view.layout,
        layoutQuery: view.layoutQuery,
        layoutOptions: view.layoutOptions,
        search: view.search,
        filter: view.filter,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['preset-bookmarks', collection] });
      onClose();
    },
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" role="dialog" aria-modal="true">
      <div className="w-full max-w-sm space-y-4 rounded-card border border-line bg-panel p-5 shadow-lg">
        <h2 className="text-base font-semibold">{t('presets.saveBookmark')}</h2>

        <label className="block space-y-1">
          <span className="text-sm text-dim">{t('presets.name')}</span>
          <input
            autoFocus
            className="w-full rounded-ctl border border-line px-3 py-1.5 text-sm"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('presets.namePlaceholder')}
          />
        </label>

        {canManageShared && (
          <label className="block space-y-1">
            <span className="text-sm text-dim">{t('presets.scopeLabel')}</span>
            <select
              className="w-full rounded-ctl border border-line px-3 py-1.5 text-sm"
              value={scope}
              onChange={(e) => setScope(e.target.value as PresetScope)}
            >
              <option value="user">{t('presets.justMe')}</option>
              <option value="global">{t('presets.everyone')}</option>
            </select>
          </label>
        )}

        {mutation.isError && (
          <p className="text-sm text-bad">{(mutation.error as Error).message}</p>
        )}

        <div className="flex justify-end gap-2">
          <button type="button" className="rounded-ctl px-3 py-1.5 text-sm hover:bg-panel-2" onClick={onClose}>
            {t('common:cancel')}
          </button>
          <button
            type="button"
            disabled={!name.trim() || mutation.isPending}
            className="rounded-ctl bg-brand px-3 py-1.5 text-sm text-brand-fg disabled:opacity-50"
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? t('saving') : t('common:save')}
          </button>
        </div>
      </div>
    </div>
  );
}
