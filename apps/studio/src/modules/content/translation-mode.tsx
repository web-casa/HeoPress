// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import type { FieldResource, TmSource } from '@heopress/sdk';
import { useTranslation } from 'react-i18next';
import { TmSuggestPopover } from './tm-suggest-popover';
import {
  completionPct,
  localeValue,
  setLocaleValue,
  translatableFields,
} from './translatable-fields';

/**
 * Side-by-side locale editor (translation-memory-ui Req 4 + 5).
 *
 * For each translatable field it shows the source locale (read-only) beside the
 * target locale (editable), with a TM suggestion popover under the target
 * input. It writes through the existing per-locale value map
 * (`data[field][locale]`) — no new storage mechanism — and reports each
 * human-edited field so the editor can learn it into TM on save.
 */
export function TranslationMode({
  fields,
  draft,
  onChange,
  sourceLocale,
  targetLocale,
  readOnly,
  onFieldEdited,
}: {
  fields: FieldResource[];
  draft: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  sourceLocale: string;
  targetLocale: string;
  readOnly?: boolean;
  /** Called when a target value changes, tagged with its origin (human input vs applied MT). */
  onFieldEdited?: (fieldName: string, source: TmSource) => void;
}) {
  const { t } = useTranslation('items');
  const translatable = translatableFields(fields);
  const pct = completionPct(fields, draft, targetLocale);

  const setTarget = (field: FieldResource, text: string, source: TmSource) => {
    onChange({ ...draft, [field.name]: setLocaleValue(draft[field.name], targetLocale, text) });
    onFieldEdited?.(field.name, source);
  };

  if (translatable.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {t('translation.noTranslatable')}
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          {t('translation.translating')} <span className="font-mono">{sourceLocale}</span> →{' '}
          <span className="font-mono">{targetLocale}</span>
        </p>
        <div className="flex items-center gap-2 text-xs" data-testid="tm-completion">
          <span className="text-muted-foreground">{t('translation.complete', { pct })}</span>
          <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
            <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
          </div>
        </div>
      </div>

      {translatable.map((field) => {
        const source = localeValue(draft[field.name], sourceLocale);
        const target = localeValue(draft[field.name], targetLocale);
        return (
          <div key={field.id} className="rounded-lg border bg-background p-3">
            <div className="mb-2 text-xs font-medium text-muted-foreground">
              {field.label ?? field.name}
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div>
                <span className="mb-1 block text-[10px] font-medium uppercase text-muted-foreground">
                  {t('translation.sourceLocale', { locale: sourceLocale })}
                </span>
                <textarea
                  value={source}
                  readOnly
                  rows={2}
                  aria-label={t('translation.sourceAria', { field: field.name, locale: sourceLocale })}
                  className="w-full rounded-md border bg-muted/30 px-2 py-1.5 text-sm text-muted-foreground"
                />
              </div>
              <div>
                <span className="mb-1 block text-[10px] font-medium uppercase text-muted-foreground">
                  {t('translation.targetLocale', { locale: targetLocale })}
                </span>
                <textarea
                  value={target}
                  readOnly={readOnly}
                  onChange={(e) => setTarget(field, e.target.value, 'human')}
                  rows={2}
                  aria-label={t('translation.targetAria', { field: field.name, locale: targetLocale })}
                  className="w-full rounded-md border bg-background px-2 py-1.5 text-sm outline-none focus:border-primary"
                />
                {!readOnly && (
                  <TmSuggestPopover
                    sourceText={source}
                    sourceLang={sourceLocale}
                    targetLang={targetLocale}
                    onApply={(text, src) => setTarget(field, text, src)}
                  />
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
