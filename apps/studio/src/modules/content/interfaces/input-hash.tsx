// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { useTranslation } from 'react-i18next';
import { KeyRound, X } from 'lucide-react';
import { useState } from 'react';
import { readOptions, type InterfaceComponent } from './types';

interface HashOptions {
  placeholder?: string;
  masked?: boolean;
}

/**
 * `input-hash` — secret input whose value is one-way hashed server-side on
 * save. Once a value exists we render a "hashed" badge instead of the cleartext
 * (the API never returns the raw hash for editing); clearing lets the user set
 * a new value. The stored cell value is the plaintext the user typed; the BE
 * `hash` special replaces it with the digest on write.
 */
export const InputHashInterface: InterfaceComponent<string> = ({
  value,
  field,
  disabled,
  onChange,
}) => {
  const opts = readOptions<HashOptions>(field);
  const { t } = useTranslation('items');
  // A non-empty value coming from the server means "already hashed".
  const [editing, setEditing] = useState(false);
  const hasStored = typeof value === 'string' && value.length > 0;

  if (hasStored && !editing) {
    return (
      <div className="flex items-center gap-2 rounded-ctl border border-line bg-panel-2 px-2 py-1.5 text-sm">
        <KeyRound className="h-3.5 w-3.5 text-dim" />
        <span className="text-xs text-dim">{t('interfaces.hash.set')}</span>
        {!disabled && (
          <button
            type="button"
            onClick={() => {
              setEditing(true);
              onChange(null);
            }}
            className="ml-auto inline-flex items-center gap-1 rounded border border-line px-1.5 py-0.5 text-xs hover:bg-panel-2"
          >
            <X className="h-3 w-3" /> {t('interfaces.hash.reset')}
          </button>
        )}
      </div>
    );
  }

  return (
    <input
      type="password"
      autoComplete="new-password"
      disabled={disabled}
      value={typeof value === 'string' ? value : ''}
      placeholder={opts.placeholder ?? t('interfaces.hash.placeholder')}
      onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
      className="w-full rounded-ctl border border-line bg-bg px-2 py-1 text-sm disabled:opacity-50"
    />
  );
};
