import { IMPORT_MEDIA_REF_PREFIX } from '@heopress/contracts/schemas';
import { sanitizeRichText } from '../site-network/public-projection';

/**
 * Imported rich text (HeoPress P12 task 6.4; spec migration/import-bundle "导入安全"): media references are
 * resolved, then the HTML goes through the same sanitiser as every public rich text (`sanitizeRichText`), keeping
 * only the attributes of custom-component blocks on top (what the Astro importer leaves for components it does not
 * know). Anything executable that was there — scripts, frames, event handlers, `javascript:` links, styles — is
 * removed and named as a safety issue: the item imports, but its batch cannot be activated until a person has
 * looked at it and the bundle was imported again.
 */

/** Attributes a custom-component block keeps (never rendered as script; the public projection drops them). */
const CUSTOM_COMPONENT_ATTRIBUTES: Record<string, string[]> = {
  div: ['data-block-type', 'data-component', 'data-props', 'data-source'],
  span: ['data-block-type', 'data-component', 'data-props', 'data-source'],
};

const UNSAFE: Array<[RegExp, string]> = [
  [/<\s*script\b/i, 'script element'],
  [/<\s*(iframe|frame|frameset)\b/i, 'frame element'],
  [/<\s*(object|embed|applet)\b/i, 'embedded object'],
  [/<\s*style\b/i, 'style element'],
  [/<\s*(form|input|button|textarea|select)\b/i, 'form element'],
  [/<\s*(meta|link|base)\b/i, 'document metadata element'],
  [/<[^>]*\son[a-z]+\s*=/i, 'event handler attribute'],
  [/(href|src|action|formaction|poster|xlink:href)\s*=\s*["']?\s*(javascript|vbscript|data):/i, 'script or data URL'],
];

/** What in `html` is executable or unsafe (by name), before sanitising. */
export function unsafeMarkup(html: string): string[] {
  return UNSAFE.filter(([re]) => re.test(html)).map(([, name]) => name);
}

const MEDIA_REF = new RegExp(`${IMPORT_MEDIA_REF_PREFIX.replace(/[-:]/g, '\\$&')}([A-Za-z0-9._\\-/:@]+)`, 'g');

/** Replace every `heopress-media:<id>` in `text`; ids `resolve` does not know are listed. */
export function resolveMediaRefs(text: string, resolve: (id: string) => string | null): { text: string; missing: string[] } {
  const missing: string[] = [];
  const out = text.replace(MEDIA_REF, (whole, id: string) => {
    const url = resolve(id);
    if (url === null) {
      missing.push(id);
      return whole;
    }
    return url;
  });
  return { text: out, missing };
}

export interface PreparedRichText {
  html: string;
  /** Unsafe markup that was removed (empty: nothing). */
  issues: string[];
  missingMedia: string[];
}

export function prepareRichText(html: string, resolve: (id: string) => string | null): PreparedRichText {
  const { text, missing } = resolveMediaRefs(html, resolve);
  const issues = unsafeMarkup(text);
  return { html: sanitizeRichText(text, CUSTOM_COMPONENT_ATTRIBUTES), issues, missingMedia: missing };
}
