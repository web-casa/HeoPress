// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { Check, Minus, X } from 'lucide-react';
import type { DisplayComponent } from './types';

/** `boolean-icon` — green check / red X / dash for null. */
export const BooleanIconDisplay: DisplayComponent<boolean> = ({ value }) => {
  if (value === null || value === undefined)
    return <Minus className="h-3.5 w-3.5 text-dim" />;
  return value ? (
    <Check className="h-3.5 w-3.5 text-ok" />
  ) : (
    <X className="h-3.5 w-3.5 text-bad" />
  );
};
