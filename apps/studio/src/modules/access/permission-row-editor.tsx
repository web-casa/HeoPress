// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import Editor from '@/lib/code-editor';
import { useMutation } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { PermissionAction, PermissionRow } from '@heopress/sdk';
import { useTranslation } from 'react-i18next';
import { getApiClient } from '@/lib/api';
import { cn } from '@/lib/cn';

const ACTION_TONE: Record<PermissionAction, string> = {
  create: 'bg-emerald-100 text-emerald-700',
  read: 'bg-sky-100 text-sky-700',
  update: 'bg-amber-100 text-amber-700',
  delete: 'bg-rose-100 text-rose-700',
  share: 'bg-purple-100 text-purple-700',
  read_decrypted: 'bg-indigo-100 text-indigo-700',
  review: 'bg-teal-100 text-teal-700',
};

interface PermissionRowEditorProps {
  policyId: string;
  row: PermissionRow;
  onChange: () => void;
}

/**
 * Inline editor for a single permission row. Provides:
 *  - Fields whitelist (with `*` and `-prefix` exclusions).
 *  - Row-level rule (`permissions`) with both a flat GUI builder and a
 *    Monaco JSON pane for `_and`/`_or`/`_not` nesting.
 *  - Validation + Presets as JSON (Monaco).
 *
 * Each editor debounces a single PATCH; we don't autosave per keystroke to
 * keep the audit log readable.
 */
export function PermissionRowEditor({ policyId, row, onChange }: PermissionRowEditorProps) {
  const { t } = useTranslation('access');
  const client = getApiClient();
  const [open, setOpen] = useState(false);
  const [fields, setFields] = useState<string[]>(row.fields);
  const [permissions, setPermissions] = useState<Record<string, unknown>>(row.permissions);
  const [validation, setValidation] = useState<Record<string, unknown>>(row.validation);
  const [presets, setPresets] = useState<Record<string, unknown>>(row.presets);
  const [mode, setMode] = useState<'gui' | 'json'>('gui');
  const [permJsonError, setPermJsonError] = useState<string | null>(null);

  // Re-hydrate local state when the row prop changes (e.g. parent refetch).
  useEffect(() => {
    setFields(row.fields);
    setPermissions(row.permissions);
    setValidation(row.validation);
    setPresets(row.presets);
  }, [row.id, row.fields, row.permissions, row.validation, row.presets]);

  const isDirty = useMemo(() => {
    return (
      JSON.stringify(fields) !== JSON.stringify(row.fields) ||
      JSON.stringify(permissions) !== JSON.stringify(row.permissions) ||
      JSON.stringify(validation) !== JSON.stringify(row.validation) ||
      JSON.stringify(presets) !== JSON.stringify(row.presets)
    );
  }, [fields, permissions, validation, presets, row]);

  const save = useMutation({
    mutationFn: () =>
      client.policies.patchPermission(policyId, row.id, {
        fields,
        permissions,
        validation,
        presets,
      }),
    onSuccess: () => onChange(),
  });

  const remove = useMutation({
    mutationFn: () => client.policies.removePermission(policyId, row.id),
    onSuccess: () => onChange(),
  });

  const fieldsLabel =
    fields.length === 0 ? t('rowEditor.noFields') : fields.includes('*') ? t('rowEditor.allFields') : t('rowEditor.fieldCount', { count: fields.length });

  return (
    <div className="overflow-hidden rounded-md border bg-background">
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex flex-1 items-center gap-2 text-left text-sm"
        >
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          <span
            className={cn(
              'rounded px-1.5 py-0.5 text-[10px] uppercase',
              ACTION_TONE[row.action] ?? 'bg-muted text-foreground',
            )}
          >
            {t(`matrix.actions.${row.action}`)}
          </span>
          <span className="font-medium">{row.collection}</span>
          <span className="text-xs text-muted-foreground">· {fieldsLabel}</span>
          {Object.keys(row.permissions ?? {}).length > 0 && (
            <span className="text-xs text-muted-foreground">· {t('matrix.conditional')}</span>
          )}
        </button>
        <button
          type="button"
          aria-label={t('rowEditor.deleteRow')}
          onClick={() => {
            if (confirm(t('rowEditor.deleteConfirm', { action: t(`matrix.actions.${row.action}`), collection: row.collection }))) remove.mutate();
          }}
          className="rounded-md p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      {open && (
        <div className="space-y-4 border-t bg-muted/10 p-4 text-sm">
          <FieldsSection value={fields} onChange={setFields} />

          <div>
            <header className="mb-2 flex items-center justify-between">
              <div>
                <h4 className="text-xs font-semibold uppercase text-muted-foreground">
                  {t('rowEditor.ruleTitle')}
                </h4>
                <p className="text-[11px] text-muted-foreground">
                  {t('rowEditor.ruleHint')}
                </p>
              </div>
              <div className="flex items-center gap-1 rounded-md border bg-background p-0.5 text-xs">
                <button
                  type="button"
                  onClick={() => setMode('gui')}
                  className={cn('rounded px-2 py-0.5', mode === 'gui' && 'bg-muted shadow-sm')}
                >
                  {t('policyDetail.guards.gui')}
                </button>
                <button
                  type="button"
                  onClick={() => setMode('json')}
                  className={cn('rounded px-2 py-0.5', mode === 'json' && 'bg-muted shadow-sm')}
                >
                  {t('policyDetail.guards.json')}
                </button>
              </div>
            </header>

            {mode === 'gui' && (
              <RuleBuilder value={permissions} onChange={setPermissions} />
            )}

            {mode === 'json' && (
              <div className="space-y-1">
                <div className="overflow-hidden rounded-md border">
                  <Editor
                    height="180px"
                    defaultLanguage="json"
                    value={JSON.stringify(permissions ?? {}, null, 2)}
                    onChange={(v) => {
                      try {
                        const parsed = JSON.parse(v ?? '{}');
                        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                          setPermissions(parsed);
                          setPermJsonError(null);
                        } else {
                          setPermJsonError(t('rowEditor.topLevelObject'));
                        }
                      } catch (e) {
                        setPermJsonError((e as Error).message);
                      }
                    }}
                    options={{
                      minimap: { enabled: false },
                      fontSize: 12,
                      scrollBeyondLastLine: false,
                    }}
                  />
                </div>
                {permJsonError && <p className="text-xs text-destructive">{permJsonError}</p>}
              </div>
            )}
          </div>

          <JsonBlock
            label={t('rowEditor.validation')}
            hint={t('rowEditor.validationHint')}
            value={validation}
            onChange={setValidation}
          />
          <JsonBlock
            label={t('sandbox.presets')}
            hint={t('rowEditor.presetsHint')}
            value={presets}
            onChange={setPresets}
          />

          <footer className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">
              {save.error ? <span className="text-destructive">{(save.error as Error).message}</span> : '\u00A0'}
            </span>
            <button
              type="button"
              onClick={() => save.mutate()}
              disabled={!isDirty || save.isPending || !!permJsonError}
              className={cn(
                'rounded-md px-3 py-1 text-xs font-medium',
                isDirty && !permJsonError
                  ? 'bg-primary text-primary-foreground hover:opacity-90'
                  : 'bg-muted text-muted-foreground',
              )}
            >
              {save.isPending ? t('rowEditor.saving') : isDirty ? t('rowEditor.saveChanges') : t('rowEditor.saved')}
            </button>
          </footer>
        </div>
      )}
    </div>
  );
}

/** Editable list of field names; `*` is a quick-pick. */
function FieldsSection({
  value,
  onChange,
}: {
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const { t } = useTranslation('access');
  const [next, setNext] = useState('');
  const allMode = value.length === 1 && value[0] === '*';

  return (
    <div>
      <header className="mb-2 flex items-center justify-between">
        <div>
          <h4 className="text-xs font-semibold uppercase text-muted-foreground">{t('matrix.inspector.fields')}</h4>
          <p className="text-[11px] text-muted-foreground">
            {t('rowEditor.fieldsHint')}
          </p>
        </div>
        <button
          type="button"
          onClick={() => onChange(['*'])}
          className={cn(
            'rounded-md border px-2 py-0.5 text-xs',
            allMode && 'border-primary text-primary',
          )}
        >
          {t('rowEditor.allFieldsButton')}
        </button>
      </header>
      <div className="flex flex-wrap items-center gap-1.5">
        {value.map((f, idx) => (
          <span
            key={`${f}-${idx}`}
            className={cn(
              'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs',
              f.startsWith('-') && 'border-rose-300 bg-rose-50 text-rose-700',
              f === '*' && 'border-primary bg-primary/10 text-primary',
            )}
          >
            <code className="font-mono">{f}</code>
            <button
              type="button"
              onClick={() => onChange(value.filter((_, i) => i !== idx))}
              className="text-muted-foreground hover:text-destructive"
              aria-label={t('rowEditor.removeField', { field: f })}
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        <input
          value={next}
          onChange={(e) => setNext(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && next.trim()) {
              e.preventDefault();
              onChange([...value, next.trim()]);
              setNext('');
            }
          }}
          placeholder={t('rowEditor.addField')}
          className="min-w-[8rem] flex-1 rounded-md border bg-background px-2 py-0.5 text-xs"
        />
      </div>
    </div>
  );
}

/** Generic JSON block (Monaco) for validation / presets. */
function JsonBlock({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const { t } = useTranslation('access');
  const [error, setError] = useState<string | null>(null);
  return (
    <div>
      <h4 className="mb-1 text-xs font-semibold uppercase text-muted-foreground">{label}</h4>
      <p className="mb-1 text-[11px] text-muted-foreground">{hint}</p>
      <div className="overflow-hidden rounded-md border">
        <Editor
          height="120px"
          defaultLanguage="json"
          value={JSON.stringify(value ?? {}, null, 2)}
          onChange={(v) => {
            try {
              const parsed = JSON.parse(v ?? '{}');
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                onChange(parsed);
                setError(null);
              } else {
                setError(t('rowEditor.mustBeObject'));
              }
            } catch (e) {
              setError((e as Error).message);
            }
          }}
          options={{
            minimap: { enabled: false },
            fontSize: 12,
            scrollBeyondLastLine: false,
          }}
        />
      </div>
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
    </div>
  );
}

/* ---------------- Flat rule builder ---------------- */

const RULE_OPS = ['_eq', '_neq', '_in', '_nin', '_gt', '_gte', '_lt', '_lte', '_contains', '_starts_with', '_ends_with'] as const;
type RuleOp = (typeof RULE_OPS)[number];

const MAGIC_VARS = ['$CURRENT_USER', '$CURRENT_SITE', '$CURRENT_ROLE', '$NOW', '$IP'];

interface FlatCondition {
  field: string;
  op: RuleOp;
  value: string;
  /** When `true`, value is parsed as the literal magic var (no quoting). */
  magic?: boolean;
}

/**
 * Round-trip a flat AND-only rule into / out of the policy DSL JSON.
 * Nested `_or` / `_not` rules survive as a single read-only summary; users
 * can switch to JSON mode to edit them.
 */
function RuleBuilder({
  value,
  onChange,
}: {
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const { t } = useTranslation('access');
  const { conditions, hasNested } = useMemo(() => parseFlat(value), [value]);

  const update = (next: FlatCondition[]) => {
    onChange(buildFlat(next));
  };

  if (hasNested) {
    return (
      <div className="rounded-md border border-dashed bg-muted/30 p-3 text-xs text-muted-foreground">
        {t('rowEditor.nested')}
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-md border bg-background p-3">
      {conditions.length === 0 && (
        <p className="text-xs text-muted-foreground">
          {t('rowEditor.noConditions')}
        </p>
      )}
      {conditions.map((c, idx) => (
        <div key={idx} className="flex flex-wrap items-center gap-1.5">
          <input
            value={c.field}
            onChange={(e) => update(replace(conditions, idx, { ...c, field: e.target.value }))}
            placeholder={t('rowEditor.fieldPlaceholder')}
            className="w-32 rounded-md border bg-background px-2 py-0.5 text-xs"
          />
          <select
            value={c.op}
            onChange={(e) => update(replace(conditions, idx, { ...c, op: e.target.value as RuleOp }))}
            className="rounded-md border bg-background px-2 py-0.5 text-xs"
          >
            {RULE_OPS.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
          <input
            value={c.value}
            onChange={(e) => update(replace(conditions, idx, { ...c, value: e.target.value }))}
            placeholder={c.magic ? t('rowEditor.magicValuePlaceholder') : t('rowEditor.valuePlaceholder')}
            className="min-w-[10rem] flex-1 rounded-md border bg-background px-2 py-0.5 text-xs font-mono"
          />
          <select
            value=""
            onChange={(e) => {
              if (e.target.value) {
                update(replace(conditions, idx, { ...c, value: e.target.value, magic: true }));
                e.target.value = '';
              }
            }}
            className="rounded-md border bg-background px-1 py-0.5 text-xs"
          >
            <option value="">{t('rowEditor.magicVar')}</option>
            {MAGIC_VARS.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => update(conditions.filter((_, i) => i !== idx))}
            className="rounded-md p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            aria-label={t('rowEditor.removeCondition')}
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => update([...conditions, { field: '', op: '_eq', value: '' }])}
        className="rounded-md border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent"
      >
        {t('rowEditor.addCondition')}
      </button>
    </div>
  );
}

function replace<T>(arr: T[], idx: number, next: T): T[] {
  return arr.map((x, i) => (i === idx ? next : x));
}

/** Walk a rule and either return the AND-flat list or flag nested ops. */
function parseFlat(rule: Record<string, unknown>): {
  conditions: FlatCondition[];
  hasNested: boolean;
} {
  if (!rule || typeof rule !== 'object') return { conditions: [], hasNested: false };

  // Top-level _and is fine — flatten its children which must each be a single-field clause.
  const list = Array.isArray((rule as { _and?: unknown[] })._and)
    ? ((rule as { _and: Array<Record<string, unknown>> })._and ?? [])
    : Object.keys(rule).length === 0
      ? []
      : [rule];

  const conditions: FlatCondition[] = [];
  let hasNested = false;

  for (const clause of list) {
    if ('_or' in clause || '_not' in clause || '_and' in clause) {
      hasNested = true;
      continue;
    }
    const entries = Object.entries(clause);
    if (entries.length !== 1) {
      hasNested = true;
      continue;
    }
    const [field, opObj] = entries[0] as [string, Record<string, unknown>];
    const opEntries = Object.entries(opObj ?? {});
    if (opEntries.length !== 1) {
      hasNested = true;
      continue;
    }
    const [op, raw] = opEntries[0] as [string, unknown];
    if (!RULE_OPS.includes(op as RuleOp)) {
      hasNested = true;
      continue;
    }
    const stringValue =
      Array.isArray(raw) ? raw.map(String).join(',') : raw === null || raw === undefined ? '' : String(raw);
    conditions.push({
      field,
      op: op as RuleOp,
      value: stringValue,
      magic: typeof raw === 'string' && raw.startsWith('$'),
    });
  }
  return { conditions, hasNested };
}

function buildFlat(conditions: FlatCondition[]): Record<string, unknown> {
  if (conditions.length === 0) return {};
  const clauses: Array<Record<string, unknown>> = conditions
    .filter((c) => c.field.trim())
    .map((c) => ({ [c.field.trim()]: { [c.op]: coerce(c) } }));
  if (clauses.length === 0) return {};
  if (clauses.length === 1) return clauses[0] as Record<string, unknown>;
  return { _and: clauses };
}

function coerce(c: FlatCondition): unknown {
  if (c.value.startsWith('$')) return c.value;
  if (c.op === '_in' || c.op === '_nin') {
    return c.value.split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (c.op === '_gt' || c.op === '_gte' || c.op === '_lt' || c.op === '_lte') {
    const n = Number(c.value);
    if (!Number.isNaN(n)) return n;
  }
  return c.value;
}
