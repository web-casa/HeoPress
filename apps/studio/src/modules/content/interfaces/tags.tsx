// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { useState, type KeyboardEvent } from 'react';
import { readOptions, type InterfaceComponent } from './types';

interface TagsOptions {
  placeholder?: string;
  /** Restrict to a fixed allow-list. */
  allowed?: string[];
}

/** `tags` — chip-style multi-string editor. Enter / comma commits a tag. */
export const TagsInterface: InterfaceComponent<string[]> = ({
  value,
  field,
  disabled,
  onChange,
}) => {
  const opts = readOptions<TagsOptions>(field);
  const { t: tr } = useTranslation('items');
  const [draft, setDraft] = useState('');
  const tags = Array.isArray(value) ? value : [];

  const commit = (raw: string) => {
    const next = raw.trim();
    if (!next) return;
    if (opts.allowed && !opts.allowed.includes(next)) return;
    if (tags.includes(next)) return;
    onChange([...tags, next]);
    setDraft('');
  };

  const remove = (idx: number) => {
    onChange(tags.filter((_, i) => i !== idx));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      commit(draft);
    } else if (e.key === 'Backspace' && draft === '' && tags.length) {
      remove(tags.length - 1);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-1 rounded-ctl border border-line bg-bg px-2 py-1">
      {tags.map((t, idx) => (
        <span
          key={idx}
          className="inline-flex items-center gap-1 rounded bg-panel-2 px-1.5 py-0.5 text-xs"
        >
          {t}
          {!disabled && (
            <button
              type="button"
              onClick={() => remove(idx)}
              className="text-dim hover:text-bad"
              aria-label={tr('interfaces.removeItem', { item: t })}
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </span>
      ))}
      <input
        type="text"
        value={draft}
        disabled={disabled}
        placeholder={opts.placeholder ?? tr('interfaces.addTag')}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => commit(draft)}
        className="min-w-[8rem] flex-1 bg-transparent py-0.5 text-sm focus:outline-none"
      />
    </div>
  );
};
