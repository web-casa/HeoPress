// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { lazy, Suspense, useContext } from 'react';
import { RichTextVariant } from '@/workspace/rich-text/variant';
import type { InterfaceComponent } from './types';

// Loaded with the first rich-text field, not with Studio (ADR-0020).
const RichTextEditor = lazy(() => import('@/workspace/rich-text/rich-text-editor').then((m) => ({ default: m.RichTextEditor })));

/** `wysiwyg`: the Tiptap rich-text editor (ADR-0020); HTML in, sanitised HTML out. */
export const WysiwygInterface: InterfaceComponent<string> = ({ value, field, disabled, onChange }) => {
  const variant = useContext(RichTextVariant);
  return (
    <Suspense fallback={<div className="min-h-24 rounded-ctl border border-line bg-bg" aria-busy="true" />}>
      <RichTextEditor value={value} onChange={(html) => onChange(html)} disabled={disabled} label={field.label ?? field.name} variant={variant} />
    </Suspense>
  );
};
