import { AlertTriangle, X } from 'lucide-react';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * A delete refused because the item changed since it was opened (HeoPress P14 task 6.4; spec
 * content/write-concurrency "基于版本的条件删除"): nothing was deleted. The editor reloads the item to see the
 * change before deciding again, or keeps the page as it is.
 */
export function DeleteConflictDialog(props: {
  currentVersion: number;
  changedFields: string[];
  onReload: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('items');
  const id = useId();
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div role="alertdialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-body`} className="w-full max-w-md rounded-card border border-line bg-panel p-5 shadow-xl">
        <div className="mb-3 flex items-start justify-between">
          <h2 id={`${id}-title`} className="flex items-center gap-2 text-sm font-semibold">
            <AlertTriangle className="h-4 w-4 text-warn" aria-hidden="true" />
            {t('deleteConflict.title')}
          </h2>
          <button type="button" onClick={props.onClose} aria-label={t('common:close')} className="text-dim hover:text-fg">
            <X className="h-4 w-4" />
          </button>
        </div>
        <p id={`${id}-body`} className="mb-4 text-xs text-dim">
          {props.changedFields.length > 0
            ? t('deleteConflict.bodyFields', { version: props.currentVersion, fields: props.changedFields.join(', ') })
            : t('deleteConflict.body', { version: props.currentVersion })}
        </p>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={props.onClose} className="rounded-ctl border border-line px-3 py-1.5 text-xs text-fg hover:bg-panel-2">
            {t('deleteConflict.keep')}
          </button>
          <button type="button" onClick={props.onReload} className="rounded-ctl bg-brand px-3 py-1.5 text-xs font-medium text-brand-fg hover:opacity-90">
            {t('deleteConflict.reload')}
          </button>
        </div>
      </div>
    </div>
  );
}
