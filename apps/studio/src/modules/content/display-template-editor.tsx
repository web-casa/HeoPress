// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileText, Blocks, ArrowRightLeft } from 'lucide-react';
import { MustacheTemplateEditor } from './mustache-template-editor';
import { BlockTemplateEditor } from './block-template-editor';
import {
  parseComponentTemplate,
  serializeComponentTemplate,
  emptyComponentTemplate,
  type ComponentTemplate,
} from './block-template-types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FieldOption {
  name: string;
  type?: string;
  hint?: string;
}

interface DisplayTemplateEditorProps {
  /**
   * Raw string stored in `collections.displayTemplate`.
   * Mustache:  `"{{title}} — {{slug}}"`
   * Block DSL: `'{"kind":"component-template","template":[...]}'`
   */
  value: string | null;
  onChange: (next: string | null) => void;
  /** Fields of the collection for autocomplete and binding selectors. */
  fields?: FieldOption[];
  /** Sample row for live preview. Falls back to generated stubs. */
  sample?: Record<string, unknown>;
}

type Mode = 'mustache' | 'block';

// ---------------------------------------------------------------------------
// Mode detection
// ---------------------------------------------------------------------------

function detectMode(value: string | null | undefined): Mode {
  if (!value) return 'mustache';
  return parseComponentTemplate(value) !== null ? 'block' : 'mustache';
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * DisplayTemplateEditor — Phase F FE.
 *
 * Unified editor that switches between:
 * - **Mustache mode**: `MustacheTemplateEditor` (Phase B)
 * - **Block Builder mode**: `BlockTemplateEditor` (Phase F)
 *
 * Mode is auto-detected from the `value`:
 *   - JSON with `kind: "component-template"` → Block Builder
 *   - Everything else → Mustache
 *
 * Authors can switch modes manually. Switching from Mustache → Block offers
 * starting with a blank template (the mustache string cannot be auto-migrated).
 * Switching from Block → Mustache clears the value.
 */
export function DisplayTemplateEditor({
  value,
  onChange,
  fields = [],
  sample,
}: DisplayTemplateEditorProps) {
  const { t } = useTranslation('items');
  const [mode, setMode] = useState<Mode>(() => detectMode(value));
  const [switchConfirmDir, setSwitchConfirmDir] = useState<Mode | null>(null);

  // Re-detect the mode when the value is reset to null or loaded from null
  // (adjusting state on a prop change during render, not in an effect).
  const isNull = value === null;
  const [prevIsNull, setPrevIsNull] = useState(isNull);
  if (isNull !== prevIsNull) {
    setPrevIsNull(isNull);
    setMode(detectMode(value));
  }

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  const handleModeSwitch = (next: Mode) => {
    if (next === mode) return;
    // Confirm before discarding work
    if (mode === 'mustache' && value && value.trim() !== '') {
      setSwitchConfirmDir(next);
      return;
    }
    if (mode === 'block' && value) {
      setSwitchConfirmDir(next);
      return;
    }
    applyModeSwitch(next);
  };

  const applyModeSwitch = (next: Mode) => {
    setSwitchConfirmDir(null);
    if (next === 'block') {
      // Start fresh block template
      const ct = emptyComponentTemplate();
      onChange(serializeComponentTemplate(ct));
    } else {
      // Clear — can't auto-migrate JSON DSL to mustache string
      onChange('');
    }
    setMode(next);
  };

  const handleMustacheChange = (next: string) => {
    onChange(next || null);
  };

  const handleBlockChange = (next: ComponentTemplate) => {
    onChange(serializeComponentTemplate(next));
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const mustacheFields = fields.map((f) => ({
    name: f.name,
    hint: f.hint ?? f.type,
  }));

  const blockFields = fields.map((f) => ({
    name: f.name,
    type: f.type ?? 'string',
  }));

  const blockValue = mode === 'block' ? (parseComponentTemplate(value) ?? emptyComponentTemplate()) : null;

  return (
    <div className="space-y-3">
      {/* Mode toggle */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-0.5 rounded-lg border bg-muted/30 p-0.5">
          <button
            type="button"
            onClick={() => handleModeSwitch('mustache')}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              mode === 'mustache'
                ? 'bg-background shadow-sm text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
            title={t('displayTemplate.mustacheTitle', { skipInterpolation: true })}
          >
            <FileText className="h-3.5 w-3.5" />
            {t('displayTemplate.mustache')}
          </button>
          <button
            type="button"
            onClick={() => handleModeSwitch('block')}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              mode === 'block'
                ? 'bg-background shadow-sm text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
            title={t('displayTemplate.blockTitle')}
          >
            <Blocks className="h-3.5 w-3.5" />
            {t('displayTemplate.block')}
          </button>
        </div>
        <span className="text-[10px] text-muted-foreground">
          {mode === 'mustache'
            ? t('displayTemplate.mustacheHint', { skipInterpolation: true })
            : t('displayTemplate.blockHint')}
        </span>
      </div>

      {/* Confirm dialog when switching with unsaved data */}
      {switchConfirmDir && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/30 px-4 py-3 text-xs space-y-2">
          <div className="flex items-center gap-2 font-medium text-amber-700 dark:text-amber-300">
            <ArrowRightLeft className="h-3.5 w-3.5" />
            {t('displayTemplate.switchTo', { mode: switchConfirmDir === 'block' ? t('displayTemplate.block') : t('displayTemplate.mustache') })}
          </div>
          <p className="text-amber-700/80 dark:text-amber-400/80">
            {switchConfirmDir === 'block'
              ? t('displayTemplate.toBlockWarning')
              : t('displayTemplate.toMustacheWarning')}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => applyModeSwitch(switchConfirmDir)}
              className="rounded-md bg-amber-600 px-3 py-1 text-xs font-medium text-white hover:bg-amber-700"
            >
              {t('displayTemplate.switchAnyway')}
            </button>
            <button
              type="button"
              onClick={() => setSwitchConfirmDir(null)}
              className="rounded-md border px-3 py-1 text-xs hover:bg-muted"
            >
              {t('displayTemplate.cancel')}
            </button>
          </div>
        </div>
      )}

      {/* Editor */}
      {mode === 'mustache' && (
        <MustacheTemplateEditor
          value={value ?? ''}
          onChange={handleMustacheChange}
          fields={mustacheFields}
          sample={sample}
          placeholder={t('displayTemplate.placeholder', { skipInterpolation: true })}
        />
      )}

      {mode === 'block' && blockValue && (
        <BlockTemplateEditor
          value={blockValue}
          onChange={handleBlockChange}
          fields={blockFields}
          sample={sample}
        />
      )}
    </div>
  );
}
