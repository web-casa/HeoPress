// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { useMemo, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { useServerFeatures } from '@/lib/features';
import {
  AlignLeft,
  AlignJustify,
  FileText,
  Code2,
  Terminal,
  Link2,
  Palette,
  Hash,
  Star,
  ChevronDown,
  Tag,
  ToggleLeft,
  Calendar,
  ArrowRight,
  ArrowLeft,
  LayoutGrid,
  Paperclip,
  FolderOpen,
  Search,
  Sparkles,
  Braces,
  Repeat,
  SeparatorHorizontal,
  Info,
  Lock,
  X,
  AlertTriangle,
  Eye,
  EyeOff,
  Table2,
  SquarePen,
  ListChecks,
  CircleDot,
  ListTree,
  Smile,
  SlidersHorizontal,
  KeyRound,
  TextSearch,
  Heading,
  ExternalLink,
  Network,
  Boxes,
  Rows3,
  PanelTopOpen,
  FolderTree,
  Map as MapIcon,
  type LucideIcon,
} from 'lucide-react';
import {
  findInterfaceCatalogueItem,
  INTERFACE_CATALOGUE,
  INTERFACE_GROUPS,
  interfaceDescription,
  interfaceGroupLabel,
  interfaceLabel,
} from '@/modules/content/interfaces/catalogue';
import { DISPLAY_CATALOGUE, displayHint, displayLabel } from '@/modules/content/displays/registry';
import { MustacheTemplateEditor } from '@/modules/content/mustache-template-editor';
import { useSaveHandler } from '@/lib/keybindings/use-keybindings';

const NAME_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;

const TABS = ['Field', 'Interface', 'Table display', 'Validation', 'Conditions', 'Layout', 'Storage'] as const;
type InspectorTab = (typeof TABS)[number];

/** `dataModel:inspector.tabs.<key>` for each inspector tab. */
const TAB_KEYS: Record<InspectorTab, string> = {
  Field: 'field',
  Interface: 'interface',
  'Table display': 'tableDisplay',
  Validation: 'validation',
  Conditions: 'conditions',
  Layout: 'layout',
  Storage: 'storage',
};

// Icons per interface id
const IFACE_ICONS: Record<string, LucideIcon> = {
  'input': AlignLeft,
  'input-multiline': AlignJustify,
  'wysiwyg': FileText,
  'markdown': Code2,
  'code': Terminal,
  'slug': Link2,
  'color': Palette,
  'input-number': Hash,
  'rating': Star,
  'select-dropdown': ChevronDown,
  'select-multiple-dropdown': ListChecks,
  'select-radio': CircleDot,
  'select-multiple-checkbox': ListChecks,
  'select-multiple-checkbox-tree': ListTree,
  'select-icon': Smile,
  'slider': SlidersHorizontal,
  'tags': Tag,
  'toggle': ToggleLeft,
  'datetime': Calendar,
  'relation-m2o': ArrowRight,
  'relation-o2m': ArrowLeft,
  'relation-m2m': LayoutGrid,
  'relation-m2a': Network,
  'relation-o2m-tree-view': ListTree,
  'collection-item-dropdown': Boxes,
  'map': MapIcon,
  'file': Paperclip,
  'files': FolderOpen,
  'seo': Search,
  'aio': Sparkles,
  'json-raw': Braces,
  'repeater': Repeat,
  'presentation-divider': SeparatorHorizontal,
  'presentation-notice': Info,
  'presentation-header': Heading,
  'presentation-links': ExternalLink,
  'input-hash': KeyRound,
  'input-autocomplete-api': TextSearch,
  'group-raw': Rows3,
  'group-detail': FolderTree,
  'group-accordion': PanelTopOpen,
};

export interface FieldFormState {
  name: string;
  type: string;
  interface: string;
  label?: string | null;
  note?: string | null;
  defaultValue?: unknown;
  nullable?: boolean;
  unique?: boolean;
  indexed?: boolean;
  searchable?: boolean;
  length?: number | null;
  precision?: number | null;
  scale?: number | null;
  special?: unknown[];
  options?: Record<string, unknown>;
  required: boolean;
  readonly?: boolean;
  hidden?: boolean;
  encrypted?: boolean;
  versioned?: boolean;
  rawEnabled?: boolean;
  group?: string | null;
  width?: 'half' | 'full' | 'fill';
  sortOrder: number;
  display?: string | null;
  displayOptions?: Record<string, unknown>;
  validation?: Record<string, unknown>;
  conditions?: unknown[];
  translations?: Record<string, unknown>;
  system?: boolean;
  locked?: boolean;
}

interface FieldInspectorProps {
  state: FieldFormState;
  siblingFields?: Array<{ name: string; type: string; interface: string }>;
  onCancel: () => void;
  onSubmit: (state: FieldFormState) => void;
  isSubmitting: boolean;
}

export function FieldInspector({
  state,
  siblingFields = [],
  onCancel,
  onSubmit,
  isSubmitting,
}: FieldInspectorProps) {
  const { t } = useTranslation('dataModel');
  const [form, setForm] = useState<FieldFormState>(state);
  const [tab, setTab] = useState<InspectorTab>('Field');
  const [optionsDraft, setOptionsDraft] = useState(() => stringifyJson(state.options ?? {}));
  const [displayOptionsDraft, setDisplayOptionsDraft] = useState(() =>
    stringifyJson(state.displayOptions ?? {}),
  );
  const [validationDraft, setValidationDraft] = useState(() =>
    stringifyJson(state.validation ?? { rules: [] }),
  );
  const [conditionsDraft, setConditionsDraft] = useState(() =>
    stringifyJson(state.conditions ?? []),
  );
  const [defaultValueDraft, setDefaultValueDraft] = useState(() =>
    state.defaultValue === undefined ? '' : stringifyJson(state.defaultValue),
  );
  const [specialDraft, setSpecialDraft] = useState(() => (state.special ?? []).join(', '));
  const [translationsDraft, setTranslationsDraft] = useState(() =>
    stringifyJson(state.translations ?? {}),
  );

  const valid = NAME_PATTERN.test(form.name);
  const optionsJson = useMemo(() => parseJsonObject(optionsDraft), [optionsDraft]);
  const displayOptionsJson = useMemo(() => parseJsonObject(displayOptionsDraft), [displayOptionsDraft]);
  const validationJson = useMemo(() => parseJsonObject(validationDraft), [validationDraft]);
  const conditionsJson = useMemo(() => parseJsonArray(conditionsDraft), [conditionsDraft]);
  const translationsJson = useMemo(() => parseJsonObject(translationsDraft), [translationsDraft]);
  const defaultValueJson = useMemo(() => parseOptionalJson(defaultValueDraft), [defaultValueDraft]);
  const jsonValid =
    optionsJson.ok &&
    displayOptionsJson.ok &&
    validationJson.ok &&
    conditionsJson.ok &&
    translationsJson.ok &&
    defaultValueJson.ok;
  const canEditStorage = !form.locked;
  const canSubmit = valid && jsonValid && !isSubmitting;

  // Shared by the Save button and the Cmd/Ctrl+S "save and stay" shortcut.
  const submit = () =>
    onSubmit({
      ...form,
      defaultValue: defaultValueJson.value,
      special: specialDraft
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      options: optionsJson.value,
      displayOptions: displayOptionsJson.value,
      validation: validationJson.value,
      conditions: conditionsJson.value,
      translations: translationsJson.value,
    });

  useSaveHandler(submit, canSubmit);

  const isRelation = form.interface?.startsWith('relation-') || form.interface === 'files';
  const isMustache = form.display === 'mustache' || form.display === 'mustache-template';
  const needsTableDisplayConfig = isRelation && !form.display;

  const sample = useMemo(() => {
    const row: Record<string, unknown> = { id: 'sample-id' };
    for (const f of siblingFields) {
      if (f.type === 'boolean') row[f.name] = true;
      else if (f.type === 'integer' || f.type === 'decimal') row[f.name] = 42;
      else row[f.name] = `<${f.name}>`;
    }
    return row;
  }, [siblingFields]);

  const updateDisplayOption = (key: string, value: unknown) => {
    const next = { ...(displayOptionsJson.ok ? displayOptionsJson.value : {}), [key]: value };
    setDisplayOptionsDraft(stringifyJson(next));
    setForm({ ...form, displayOptions: next });
  };

  const handleInterfaceChange = (ifaceId: string) => {
    const iface = findInterfaceCatalogueItem(ifaceId);
    const nextOptions = iface?.defaultOptions ?? {};
    const nextSpecial = iface?.defaultSpecial ?? [];
    setForm({
      ...form,
      interface: ifaceId,
      type: iface?.type ?? form.type,
      options: nextOptions,
      special: nextSpecial,
      display: iface?.defaultDisplay ?? null,
      width: iface?.width ?? form.width,
    });
    setOptionsDraft(stringifyJson(nextOptions));
    setSpecialDraft(nextSpecial.join(', '));
    setDisplayOptionsDraft('{}');
  };

  const currentIfaceItem = findInterfaceCatalogueItem(form.interface);
  const IfaceIcon = IFACE_ICONS[form.interface] ?? Braces;

  return (
    <div className="fixed inset-0 z-40 flex">
      {/* Backdrop */}
      <div
        className="flex-1 bg-black/30 backdrop-blur-[1px]"
        onClick={onCancel}
        aria-hidden="true"
      />

      {/* Sidebar panel */}
      <div className="flex h-full w-full max-w-[460px] flex-col bg-panel shadow-2xl">
        {/* Panel header */}
        <div className="flex items-center gap-3 border-b border-line px-5 py-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-card bg-brand-soft text-brand">
            <IfaceIcon className="h-4 w-4" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold leading-tight truncate">
              {form.name || t('inspector.newField')}
            </h3>
            <p className="text-xs text-dim">
              {currentIfaceItem ? interfaceLabel(currentIfaceItem) : form.interface}
              {form.locked && (
                <span className="ml-2 inline-flex items-center gap-0.5 text-warn">
                  <Lock className="h-3 w-3" /> {t('inspector.system')}
                </span>
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-ctl p-1 text-dim hover:bg-panel-2 hover:text-fg"
            aria-label={t('common:close')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex overflow-x-auto border-b border-line px-3 scrollbar-none">
          {TABS.map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`shrink-0 border-b-2 px-3 py-2.5 text-xs font-medium transition-colors ${
                tab === id
                  ? 'border-brand text-fg'
                  : 'border-transparent text-dim hover:text-fg'
              }`}
            >
              {id === 'Table display' && needsTableDisplayConfig ? (
                <span className="flex items-center gap-1">
                  {t(`inspector.tabs.${TAB_KEYS[id]}`)}
                  <AlertTriangle className="h-3 w-3 text-warn" />
                </span>
              ) : (
                t(`inspector.tabs.${TAB_KEYS[id]}`)
              )}
            </button>
          ))}
        </div>

        {/* Tab content — scrollable */}
        <div className="flex-1 overflow-y-auto px-5 py-5">
          {tab === 'Field' && (
            <FieldTab
              form={form}
              setForm={setForm}
              valid={valid}
              canEditStorage={canEditStorage}
            />
          )}

          {tab === 'Interface' && (
            <InterfaceTab
              form={form}
              canEditStorage={canEditStorage}
              optionsDraft={optionsDraft}
              optionsJsonOk={optionsJson.ok}
              onInterfaceChange={handleInterfaceChange}
              onOptionsDraftChange={setOptionsDraft}
            />
          )}

          {tab === 'Table display' && (
            <TableDisplayTab
              form={form}
              setForm={setForm}
              siblingFields={siblingFields}
              sample={sample}
              displayOptionsDraft={displayOptionsDraft}
              displayOptionsJson={displayOptionsJson}
              setDisplayOptionsDraft={setDisplayOptionsDraft}
              updateDisplayOption={updateDisplayOption}
              isMustache={isMustache}
              isRelation={isRelation}
              needsTableDisplayConfig={needsTableDisplayConfig}
            />
          )}

          {tab === 'Validation' && (
            <ValidationTab
              form={form}
              setForm={setForm}
              canEditStorage={canEditStorage}
              validationDraft={validationDraft}
              validationJsonOk={validationJson.ok}
              onValidationDraftChange={setValidationDraft}
            />
          )}

          {tab === 'Conditions' && (
            <JsonTextarea
              label={t('inspector.conditions')}
              hint={t('inspector.conditionsHint')}
              value={conditionsDraft}
              onChange={setConditionsDraft}
              valid={conditionsJson.ok}
              rows={14}
            />
          )}

          {tab === 'Layout' && (
            <LayoutTab form={form} setForm={setForm} />
          )}

          {tab === 'Storage' && (
            <StorageTab
              form={form}
              setForm={setForm}
              canEditStorage={canEditStorage}
              defaultValueDraft={defaultValueDraft}
              setDefaultValueDraft={setDefaultValueDraft}
              defaultValueJsonOk={defaultValueJson.ok}
              specialDraft={specialDraft}
              setSpecialDraft={setSpecialDraft}
              translationsDraft={translationsDraft}
              setTranslationsDraft={setTranslationsDraft}
              translationsJsonOk={translationsJson.ok}
            />
          )}
        </div>

        {/* Footer actions */}
        <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-ctl border border-line px-4 py-2 text-sm hover:bg-panel-2"
          >
            {t('common:cancel')}
          </button>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={submit}
            className="rounded-ctl bg-brand px-4 py-2 text-sm font-medium text-brand-fg disabled:opacity-50"
          >
            {isSubmitting ? t('saving') : t('inspector.saveField')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Tab sub-components ───────────────────────────────────────────────────────

interface FieldTabProps {
  form: FieldFormState;
  setForm: (f: FieldFormState) => void;
  valid: boolean;
  canEditStorage: boolean;
}

function FieldTab({ form, setForm, valid, canEditStorage }: FieldTabProps) {
  const { t } = useTranslation('dataModel');
  return (
    <div className="space-y-4">
      <FormField label={t('wizard.machineName')} hint={t('inspector.machineNameHint')}>
        <input
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value.toLowerCase() })}
          disabled={!canEditStorage}
          placeholder={t('inspector.machineNamePlaceholder')}
          autoFocus
          className="w-full rounded-ctl border border-line bg-bg px-3 py-2 text-sm font-mono disabled:opacity-60"
        />
        {form.name && !valid && (
          <p className="mt-1 text-xs text-bad">
            {t('inspector.invalidName')}
          </p>
        )}
      </FormField>

      <FormField label={t('wizard.label')} hint={t('inspector.labelHint')}>
        <input
          value={form.label ?? ''}
          onChange={(e) => setForm({ ...form, label: e.target.value || null })}
          placeholder={t('inspector.labelPlaceholder')}
          className="w-full rounded-ctl border border-line bg-bg px-3 py-2 text-sm"
        />
      </FormField>

      <FormField label={t('inspector.note')} hint={t('inspector.noteHint')}>
        <textarea
          value={form.note ?? ''}
          onChange={(e) => setForm({ ...form, note: e.target.value || null })}
          rows={3}
          placeholder={t('inspector.notePlaceholder')}
          className="w-full rounded-ctl border border-line bg-bg px-3 py-2 text-sm"
        />
      </FormField>
    </div>
  );
}

interface InterfaceTabProps {
  form: FieldFormState;
  canEditStorage: boolean;
  optionsDraft: string;
  optionsJsonOk: boolean;
  onInterfaceChange: (id: string) => void;
  onOptionsDraftChange: (v: string) => void;
}

function InterfaceTab({
  form,
  canEditStorage,
  optionsDraft,
  optionsJsonOk,
  onInterfaceChange,
  onOptionsDraftChange,
}: InterfaceTabProps) {
  const { t } = useTranslation('dataModel');
  const currentItem = findInterfaceCatalogueItem(form.interface);

  return (
    <div className="space-y-5">
      <div>
        <div className="mb-3 flex items-center gap-2">
          <SquarePen className="h-4 w-4 text-dim" />
          <h4 className="text-sm font-medium">{t('inspector.formInterface')}</h4>
        </div>
        <p className="mb-4 text-xs text-dim">
          {t('inspector.formInterfaceHint')}
        </p>

        <div className="space-y-4">
          {INTERFACE_GROUPS.map((group) => {
            const items = INTERFACE_CATALOGUE.filter((i) => i.group === group);
            if (items.length === 0) return null;
            return (
              <div key={group}>
                <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-dim">
                  {interfaceGroupLabel(group)}
                </p>
                <div className="grid grid-cols-3 gap-2">
                  {items.map((item) => {
                    const Icon = IFACE_ICONS[item.id] ?? Braces;
                    const selected = form.interface === item.id;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        disabled={!canEditStorage}
                        onClick={() => onInterfaceChange(item.id)}
                        title={interfaceDescription(item)}
                        className={`flex flex-col items-center gap-1.5 rounded-card border p-2.5 text-center transition-all ${
                          selected
                            ? 'border-brand bg-brand-soft text-brand ring-1 ring-brand'
                            : 'hover:border-line hover:bg-panel-2 disabled:cursor-not-allowed disabled:opacity-40'
                        }`}
                      >
                        <Icon className="h-4 w-4" />
                        <span className="text-[10px] font-medium leading-tight">{interfaceLabel(item)}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {currentItem?.description && (
        <div className="rounded-ctl border border-line bg-panel-2 p-3 text-xs text-dim">
          <strong className="text-fg">{t('inspector.labelColon', { label: interfaceLabel(currentItem) })}</strong>{' '}
          {interfaceDescription(currentItem)}
        </div>
      )}

      <JsonTextarea
        label={t('inspector.interfaceOptions')}
        hint={t('inspector.interfaceOptionsHint')}
        value={optionsDraft}
        onChange={onOptionsDraftChange}
        valid={optionsJsonOk}
        rows={8}
      />
    </div>
  );
}

interface TableDisplayTabProps {
  form: FieldFormState;
  setForm: (f: FieldFormState) => void;
  siblingFields: Array<{ name: string; type: string; interface: string }>;
  sample: Record<string, unknown>;
  displayOptionsDraft: string;
  displayOptionsJson: { ok: boolean; value: Record<string, unknown> };
  setDisplayOptionsDraft: (v: string) => void;
  updateDisplayOption: (key: string, value: unknown) => void;
  isMustache: boolean;
  isRelation: boolean;
  needsTableDisplayConfig: boolean;
}

function TableDisplayTab({
  form,
  setForm,
  siblingFields,
  sample,
  displayOptionsDraft,
  displayOptionsJson,
  setDisplayOptionsDraft,
  updateDisplayOption,
  isMustache,
  isRelation,
  needsTableDisplayConfig,
}: TableDisplayTabProps) {
  const { t } = useTranslation('dataModel');
  const allFields = [
    { name: form.name, type: form.type, interface: form.interface },
    ...siblingFields,
  ];

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <Table2 className="h-4 w-4 text-dim" />
        <div>
          <h4 className="text-sm font-medium">{t('inspector.displayInTables')}</h4>
          <p className="text-xs text-dim">
            {t('inspector.displayInTablesHint')}
          </p>
        </div>
      </div>

      {needsTableDisplayConfig && (
        <div className="flex items-start gap-2 rounded-ctl border border-warn/40 bg-warn-soft p-3 text-xs text-warn">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <p>
            {t('inspector.relationWarning')}
          </p>
        </div>
      )}

      <FormField label={t('inspector.displayType')} hint={t('inspector.displayTypeHint')}>
        <select
          value={form.display ?? ''}
          onChange={(e) => {
            setForm({ ...form, display: e.target.value || null });
            setDisplayOptionsDraft('{}');
          }}
          className="w-full rounded-ctl border border-line bg-bg px-3 py-2 text-sm"
        >
          <option value="">{t('inspector.displayAuto')}</option>
          {DISPLAY_CATALOGUE.map((d) => (
            <option key={d.id} value={d.id} title={displayHint(d)}>
              {displayLabel(d)}
            </option>
          ))}
        </select>
        {form.display && (
          <p className="mt-1 text-xs text-dim">
            {(() => {
              const d = DISPLAY_CATALOGUE.find((entry) => entry.id === form.display);
              return d ? displayHint(d) : null;
            })()}
          </p>
        )}
      </FormField>

      {/* Mustache / template display */}
      {isMustache && (
        <FormField
          label={t('display.title')}
          hint={
            <Trans
              t={t}
              i18nKey="inspector.templateHint"
              values={{ example: '{{field_name}}', trigger: '{{{' }}
              components={{ c: <code className="rounded bg-panel-2 px-1 font-mono" /> }}
            />
          }
        >
          <MustacheTemplateEditor
            value={String(
              (displayOptionsJson.ok ? displayOptionsJson.value : {}).template ?? '',
            )}
            onChange={(next) => updateDisplayOption('template', next)}
            fields={allFields.map((f) => ({ name: f.name, hint: `${f.type}/${f.interface}` }))}
            sample={sample}
          />
        </FormField>
      )}

      {/* Relation display — displayField shortcut */}
      {isRelation && form.display === 'relation' && (
        <FormField
          label={t('inspector.relatedField')}
          hint={
            <Trans
              t={t}
              i18nKey="inspector.relatedFieldHint"
              values={{ example: '{{title}} ({{id}})' }}
              components={{
                btn: (
                  <button
                    type="button"
                    className="underline underline-offset-2 hover:text-fg"
                    onClick={() => {
                      setForm({ ...form, display: 'mustache-template' });
                      setDisplayOptionsDraft('{}');
                    }}
                  />
                ),
                c: <code className="rounded bg-panel-2 px-1 font-mono" />,
              }}
            />
          }
        >
          <input
            value={String(
              (displayOptionsJson.ok ? displayOptionsJson.value : {}).displayField ?? 'title',
            )}
            onChange={(e) => updateDisplayOption('displayField', e.target.value)}
            placeholder={t('inspector.relatedFieldPlaceholder')}
            className="w-full rounded-ctl border border-line bg-bg px-3 py-2 text-sm font-mono"
          />
        </FormField>
      )}

      {/* Relation + mustache template */}
      {isRelation && isMustache && (
        <FormField
          label={t('inspector.relatedTemplate')}
          hint={
            <>
              {t('inspector.relatedTemplateHint')}{' '}
              <code className="rounded bg-panel-2 px-1 font-mono">{'{{title}}'}</code>{' '}
              <code className="rounded bg-panel-2 px-1 font-mono">{'{{id}}'}</code>
            </>
          }
        >
          <MustacheTemplateEditor
            value={String(
              (displayOptionsJson.ok ? displayOptionsJson.value : {}).template ?? '',
            )}
            onChange={(next) => updateDisplayOption('template', next)}
            fields={allFields.map((f) => ({ name: f.name, hint: `${f.type}/${f.interface}` }))}
            sample={sample}
            placeholder={t('inspector.relatedTemplatePlaceholder', { title: '{{title}}', id: '{{id}}' })}
          />
        </FormField>
      )}

      {/* Display options JSON — always shown as advanced */}
      <details className="group">
        <summary className="cursor-pointer select-none text-xs font-medium text-dim hover:text-fg">
          {t('inspector.advancedDisplay')}
        </summary>
        <div className="mt-3">
          <JsonTextarea
            label={t('inspector.displayOptionsJson')}
            value={displayOptionsDraft}
            onChange={setDisplayOptionsDraft}
            valid={displayOptionsJson.ok}
            rows={8}
          />
        </div>
      </details>
    </div>
  );
}

interface ValidationTabProps {
  form: FieldFormState;
  setForm: (f: FieldFormState) => void;
  canEditStorage: boolean;
  validationDraft: string;
  validationJsonOk: boolean;
  onValidationDraftChange: (v: string) => void;
}

function ValidationTab({
  form,
  setForm,
  canEditStorage,
  validationDraft,
  validationJsonOk,
  onValidationDraftChange,
}: ValidationTabProps) {
  const { t } = useTranslation('dataModel');
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <ToggleField
          label={t('inspector.required')}
          description={t('inspector.requiredHint')}
          checked={form.required}
          disabled={!canEditStorage}
          onChange={(v) => setForm({ ...form, required: v })}
        />
        <ToggleField
          label={t('inspector.nullable')}
          description={t('inspector.nullableHint')}
          checked={form.nullable ?? true}
          disabled={!canEditStorage}
          onChange={(v) => setForm({ ...form, nullable: v })}
        />
      </div>

      <JsonTextarea
        label={t('inspector.validationRules')}
        hint={t('inspector.validationRulesHint')}
        value={validationDraft}
        onChange={onValidationDraftChange}
        valid={validationJsonOk}
        rows={12}
      />
    </div>
  );
}

interface LayoutTabProps {
  form: FieldFormState;
  setForm: (f: FieldFormState) => void;
}

function LayoutTab({ form, setForm }: LayoutTabProps) {
  const { t } = useTranslation('dataModel');
  return (
    <div className="space-y-5">
      <FormField label={t('inspector.width')} hint={t('inspector.widthHint')}>
        <div className="flex gap-2">
          {(['half', 'full', 'fill'] as const).map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => setForm({ ...form, width: w })}
              className={`flex-1 rounded-ctl border py-2 text-xs font-medium capitalize transition-colors ${
                (form.width ?? 'full') === w
                  ? 'border-brand bg-brand-soft text-brand'
                  : 'hover:bg-panel-2'
              }`}
            >
              {t(`inspector.widths.${w}`)}
            </button>
          ))}
        </div>
      </FormField>

      <div className="grid grid-cols-2 gap-3">
        <ToggleField
          label={t('inspector.hidden')}
          description={t('inspector.hiddenHint')}
          icon={EyeOff}
          checked={form.hidden ?? false}
          onChange={(v) => setForm({ ...form, hidden: v })}
        />
        <ToggleField
          label={t('inspector.readonly')}
          description={t('inspector.readonlyHint')}
          icon={Lock}
          checked={form.readonly ?? false}
          onChange={(v) => setForm({ ...form, readonly: v })}
        />
      </div>

      <FormField label={t('inspector.group')} hint={t('inspector.groupHint')}>
        <input
          value={form.group ?? ''}
          onChange={(e) => setForm({ ...form, group: e.target.value || null })}
          placeholder={t('inspector.groupPlaceholder')}
          className="w-full rounded-ctl border border-line bg-bg px-3 py-2 text-sm"
        />
      </FormField>
    </div>
  );
}

interface StorageTabProps {
  form: FieldFormState;
  setForm: (f: FieldFormState) => void;
  canEditStorage: boolean;
  defaultValueDraft: string;
  setDefaultValueDraft: (v: string) => void;
  defaultValueJsonOk: boolean;
  specialDraft: string;
  setSpecialDraft: (v: string) => void;
  translationsDraft: string;
  setTranslationsDraft: (v: string) => void;
  translationsJsonOk: boolean;
}

function StorageTab({
  form,
  setForm,
  canEditStorage,
  defaultValueDraft,
  setDefaultValueDraft,
  defaultValueJsonOk,
  specialDraft,
  setSpecialDraft,
  translationsDraft,
  setTranslationsDraft,
  translationsJsonOk,
}: StorageTabProps) {
  const { t } = useTranslation('dataModel');
  const { fieldEncryption } = useServerFeatures();
  return (
    <div className="space-y-4">
      <FormField label={t('inspector.dbType')} hint={t('inspector.dbTypeHint')}>
        <input
          value={form.type}
          disabled={!canEditStorage}
          onChange={(e) => setForm({ ...form, type: e.target.value })}
          className="w-full rounded-ctl border border-line bg-bg px-3 py-2 text-sm font-mono disabled:opacity-60"
        />
      </FormField>

      <div className="grid grid-cols-2 gap-3">
        <NumberInput
          label={t('inspector.length')}
          value={form.length}
          onChange={(length) => setForm({ ...form, length })}
        />
        <NumberInput
          label={t('inspector.precision')}
          value={form.precision}
          onChange={(precision) => setForm({ ...form, precision })}
        />
        <NumberInput
          label={t('inspector.scale')}
          value={form.scale}
          onChange={(scale) => setForm({ ...form, scale })}
          min={0}
        />
        <NumberInput
          label={t('inspector.sortOrder')}
          value={form.sortOrder}
          onChange={(v) => setForm({ ...form, sortOrder: v ?? 0 })}
          min={0}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <ToggleField label={t('inspector.unique')} checked={form.unique ?? false} onChange={(v) => setForm({ ...form, unique: v })} />
        <ToggleField label={t('inspector.indexed')} checked={form.indexed ?? false} onChange={(v) => setForm({ ...form, indexed: v })} />
        <ToggleField label={t('inspector.searchable')} checked={form.searchable ?? true} onChange={(v) => setForm({ ...form, searchable: v })} />
        <ToggleField label={t('inspector.rawEnabled')} checked={form.rawEnabled ?? true} onChange={(v) => setForm({ ...form, rawEnabled: v })} />
        {/* Content field encryption is off by default (P02 5.2); an already
            encrypted field still shows the toggle so it can be turned off. */}
        {(fieldEncryption || form.encrypted) && (
          <ToggleField label={t('inspector.encrypted')} checked={form.encrypted ?? false} onChange={(v) => setForm({ ...form, encrypted: v })} />
        )}
        <ToggleField label={t('inspector.versioned')} checked={form.versioned ?? false} onChange={(v) => setForm({ ...form, versioned: v })} />
      </div>

      <FormField label={t('inspector.defaultValue')}>
        <textarea
          value={defaultValueDraft}
          onChange={(e) => setDefaultValueDraft(e.target.value)}
          rows={3}
          placeholder={t('inspector.defaultValuePlaceholder')}
          className="w-full rounded-ctl border border-line bg-bg px-3 py-2 font-mono text-xs"
        />
        {!defaultValueJsonOk && (
          <p className="mt-1 text-xs text-bad">{t('inspector.invalidJson')}</p>
        )}
      </FormField>

      <FormField label={t('inspector.special')} hint={t('inspector.specialHint')}>
        <input
          value={specialDraft}
          onChange={(e) => setSpecialDraft(e.target.value)}
          placeholder={t('inspector.specialPlaceholder')}
          className="w-full rounded-ctl border border-line bg-bg px-3 py-2 text-sm"
        />
      </FormField>

      <JsonTextarea
        label={t('inspector.translations')}
        hint={t('inspector.translationsHint')}
        value={translationsDraft}
        onChange={setTranslationsDraft}
        valid={translationsJsonOk}
        rows={8}
      />
    </div>
  );
}

// ─── Shared helper components ────────────────────────────────────────────────

interface FormFieldProps {
  label: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
}

function FormField({ label, hint, children }: FormFieldProps) {
  return (
    <label className="block space-y-1.5">
      <span className="block text-sm font-medium">{label}</span>
      {hint && <p className="text-xs text-dim">{hint}</p>}
      {children}
    </label>
  );
}

interface ToggleFieldProps {
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  icon?: LucideIcon;
  onChange: (v: boolean) => void;
}

function ToggleField({ label, description, checked, disabled, icon: Icon, onChange }: ToggleFieldProps) {
  return (
    <label className="flex cursor-pointer items-start gap-2 rounded-card border border-line p-3 hover:bg-panel-2">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5"
      />
      <div>
        <span className="flex items-center gap-1 text-xs font-medium">
          {Icon && <Icon className="h-3 w-3" />}
          {label}
        </span>
        {description && (
          <p className="text-[10px] text-dim">{description}</p>
        )}
      </div>
    </label>
  );
}

function JsonTextarea({
  label,
  hint,
  value,
  onChange,
  valid,
  rows,
}: {
  label: string;
  hint?: React.ReactNode;
  value: string;
  onChange: (value: string) => void;
  valid: boolean;
  rows: number;
}) {
  const { t } = useTranslation('dataModel');
  return (
    <label className="block space-y-1.5">
      <span className="block text-sm font-medium">{label}</span>
      {hint && <p className="text-xs text-dim">{hint}</p>}
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        className="w-full rounded-ctl border border-line bg-bg px-3 py-2 font-mono text-xs"
      />
      {!valid && <p className="text-xs text-bad">{t('inspector.invalidJson')}</p>}
    </label>
  );
}

function NumberInput({
  label,
  value,
  onChange,
  min = 1,
}: {
  label: string;
  value?: number | null;
  onChange: (value: number | null) => void;
  min?: number;
}) {
  return (
    <div className="space-y-1.5">
      <label className="block text-sm font-medium">{label}</label>
      <input
        type="number"
        min={min}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
        className="w-full rounded-ctl border border-line bg-bg px-3 py-2 text-sm"
      />
    </div>
  );
}

// ─── JSON helpers ────────────────────────────────────────────────────────────

function stringifyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

type JsonResult<T> = { ok: true; value: T } | { ok: false; value: T };

function parseJsonObject(value: string): JsonResult<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ok: true, value: parsed as Record<string, unknown> };
    }
  } catch {
    // handled below
  }
  return { ok: false, value: {} };
}

function parseJsonArray(value: string): JsonResult<unknown[]> {
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return { ok: true, value: parsed };
  } catch {
    // handled below
  }
  return { ok: false, value: [] };
}

function parseOptionalJson(value: string): JsonResult<unknown> {
  if (!value.trim()) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(value) };
  } catch {
    return { ok: false, value: undefined };
  }
}
