// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { readOptions, type InterfaceComponent } from './types';

interface TextOptions {
  placeholder?: string;
  maxLength?: number;
}

/** `input` — single-line text. */
export const TextInterface: InterfaceComponent<string> = ({
  value,
  field,
  disabled,
  onChange,
}) => {
  const opts = readOptions<TextOptions>(field);
  return (
    <input
      type="text"
      value={value ?? ''}
      placeholder={opts.placeholder}
      maxLength={opts.maxLength}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-ctl border border-line bg-bg px-2 py-1 text-sm disabled:opacity-50"
    />
  );
};

/** `input-multiline` — textarea. */
export const TextMultilineInterface: InterfaceComponent<string> = ({
  value,
  field,
  disabled,
  onChange,
}) => {
  const opts = readOptions<TextOptions & { rows?: number }>(field);
  return (
    <textarea
      value={value ?? ''}
      placeholder={opts.placeholder}
      maxLength={opts.maxLength}
      rows={opts.rows ?? 4}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-ctl border border-line bg-bg px-2 py-1 text-sm disabled:opacity-50"
    />
  );
};
