// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import type { DisplayComponent } from './types';

/**
 * `raw` — minimal pass-through cell.
 *
 * Stringifies the value with `JSON.stringify` (objects/arrays) or the native
 * coercion (scalars). Useful for debugging schemas and as the deliberate
 * "no formatting" choice in the display picker.
 */
export const RawDisplay: DisplayComponent<unknown> = ({ value }) => {
  if (value === null || value === undefined)
    return <span className="text-dim">—</span>;
  let s: string;
  if (typeof value === 'string') s = value;
  else if (typeof value === 'number' || typeof value === 'boolean') s = String(value);
  else {
    try {
      s = JSON.stringify(value);
    } catch {
      s = '[object]';
    }
  }
  return <span className="font-mono text-xs">{s}</span>;
};
