import type { CollectionResource, FieldResource } from '@heopress/sdk';

/**
 * Display names for collections and fields in the current Studio language. `translations` is keyed by locale
 * (`zh-CN`, then the bare language `zh`) and holds either a plain string or `{ label, pluralLabel }`; without a
 * matching entry the stored label wins, then the raw name.
 */
function translated(translations: Record<string, unknown> | undefined, lang: string, keys: string[]): string | undefined {
  if (!translations || !lang) return undefined;
  for (const loc of [lang, lang.split('-')[0] ?? lang]) {
    const entry = translations[loc];
    if (typeof entry === 'string' && entry.trim()) return entry;
    if (entry && typeof entry === 'object') {
      for (const k of keys) {
        const v = (entry as Record<string, unknown>)[k];
        if (typeof v === 'string' && v.trim()) return v;
      }
    }
  }
  return undefined;
}

export function collectionDisplayName(c: Pick<CollectionResource, 'name' | 'label' | 'pluralLabel' | 'translations'> | undefined, name: string, lang: string): string {
  if (!c) return name;
  return translated(c.translations, lang, ['pluralLabel', 'label', 'name']) || c.pluralLabel || c.label || c.name || name;
}

export function fieldDisplayName(f: Pick<FieldResource, 'name' | 'label' | 'translations'>, lang: string): string {
  return translated(f.translations, lang, ['label', 'name']) || f.label || f.name;
}
