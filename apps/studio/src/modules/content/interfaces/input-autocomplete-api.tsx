// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { readOptions, type InterfaceComponent } from './types';
import { publicFetch } from '@/lib/http';

interface AutocompleteOptions {
  /** URL template; `{{value}}` is replaced with the URL-encoded search term. */
  url?: string;
  /** Dot-path to the results array in the JSON response (e.g. `data.items`). */
  resultsPath?: string;
  /** Dot-path (relative to each result) to the value to store. */
  valuePath?: string;
  /** Dot-path (relative to each result) to the label to display. */
  textPath?: string;
  placeholder?: string;
}

/** Resolve a dot-path against an unknown JSON value. */
function dig(obj: unknown, path?: string): unknown {
  if (!path) return obj;
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[key];
    return undefined;
  }, obj);
}

/**
 * `input-autocomplete-api` — free-text input whose suggestions are fetched from
 * an external API as the user types. Stores the chosen/typed value as a string.
 */
export const InputAutocompleteApiInterface: InterfaceComponent<string> = ({
  value,
  field,
  disabled,
  onChange,
}) => {
  const opts = readOptions<AutocompleteOptions>(field);
  const { t } = useTranslation('items');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);

  const query = useQuery({
    enabled: open && !!opts.url && search.trim().length > 0,
    queryKey: ['autocomplete-api', opts.url, search],
    queryFn: async () => {
      const url = (opts.url ?? '').replace('{{value}}', encodeURIComponent(search));
      const res = await publicFetch(url);
      if (!res.ok) throw new Error(`Request failed: ${res.status}`);
      const json: unknown = await res.json();
      const results = dig(json, opts.resultsPath);
      const rows = Array.isArray(results) ? results : [];
      return rows.map((row) => ({
        value: String(dig(row, opts.valuePath) ?? ''),
        text: String(dig(row, opts.textPath) ?? dig(row, opts.valuePath) ?? ''),
      }));
    },
  });

  if (!opts.url) {
    return <p className="text-xs text-bad">{t('interfaces.missingOption', { option: 'url', kind: 'autocomplete' })}</p>;
  }

  return (
    <div className="relative">
      <input
        type="text"
        disabled={disabled}
        value={open ? search : typeof value === 'string' ? value : ''}
        placeholder={opts.placeholder ?? t('interfaces.typeToSearch')}
        onFocus={() => {
          setSearch(typeof value === 'string' ? value : '');
          setOpen(true);
        }}
        onChange={(e) => {
          setSearch(e.target.value);
          onChange(e.target.value === '' ? null : e.target.value);
        }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        className="w-full rounded-ctl border border-line bg-bg px-2 py-1 text-sm disabled:opacity-50"
      />
      {open && search.trim().length > 0 && (
        <div className="absolute z-10 mt-1 w-full rounded-ctl border border-line bg-panel shadow-lg">
          <ul className="max-h-60 overflow-y-auto py-1">
            {query.isLoading && <li className="px-2 py-1 text-xs text-dim">{t('interfaces.loading')}</li>}
            {query.error && <li className="px-2 py-1 text-xs text-bad">{t('interfaces.requestFailed')}</li>}
            {query.data?.length === 0 && (
              <li className="px-2 py-1 text-xs text-dim">{t('interfaces.noMatches')}</li>
            )}
            {query.data?.map((row, i) => (
              <li key={`${row.value}-${i}`}>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    onChange(row.value);
                    setSearch(row.value);
                    setOpen(false);
                  }}
                  className="w-full px-2 py-1 text-left text-xs hover:bg-panel-2"
                >
                  {row.text}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};
