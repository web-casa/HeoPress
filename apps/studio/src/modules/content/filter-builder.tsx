// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { Plus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ItemFilter, ItemFilterOp } from '@heopress/sdk';
import type { FieldResource } from '@heopress/sdk';

export interface FilterCondition {
  /** Field name; structural columns (id, status, sort, ...) are also valid. */
  field: string;
  op: ItemFilterOp;
  value: string;
}

/** i18n key (under `items:filter.op`) per operator. */
const OP_KEYS: Record<ItemFilterOp, string> = {
  _eq: 'eq',
  _neq: 'neq',
  _contains: 'contains',
  _starts_with: 'startsWith',
  _ends_with: 'endsWith',
  _in: 'in',
  _nin: 'nin',
  _gt: 'gt',
  _gte: 'gte',
  _lt: 'lt',
  _lte: 'lte',
  _null: 'null',
  _nnull: 'nnull',
  _json_contains: 'jsonContains',
  _has_key: 'hasKey',
  _has_any_keys: 'hasAnyKeys',
  _has_all_keys: 'hasAllKeys',
};

const OP_ORDER: ItemFilterOp[] = [
  '_eq',
  '_neq',
  '_contains',
  '_starts_with',
  '_ends_with',
  '_in',
  '_nin',
  '_gt',
  '_gte',
  '_lt',
  '_lte',
  '_null',
  '_nnull',
];

const STRUCTURAL: Array<{ name: string; label: string }> = [
  { name: 'id', label: 'id' },
  { name: 'status', label: 'status' },
  { name: 'created_at', label: 'created_at' },
  { name: 'updated_at', label: 'updated_at' },
];

interface FilterBuilderProps {
  fields: FieldResource[];
  value: FilterCondition[];
  onChange: (next: FilterCondition[]) => void;
}

/**
 * Minimal AND-only filter builder. Each row maps to a single
 * `{ <field>: { <op>: <value> } }` clause; the parent combines them with
 * the implicit top-level AND that the BE accepts.
 */
export function FilterBuilder({ fields, value, onChange }: FilterBuilderProps) {
  const { t } = useTranslation('items');
  const options = [
    ...STRUCTURAL,
    ...fields
      .filter((f) => !f.hidden)
      .map((f) => ({ name: f.name, label: f.name })),
  ];

  const update = (idx: number, patch: Partial<FilterCondition>) => {
    onChange(value.map((c, i) => (i === idx ? { ...c, ...patch } : c)));
  };

  const remove = (idx: number) => {
    onChange(value.filter((_, i) => i !== idx));
  };

  const add = () => {
    onChange([
      ...value,
      { field: options[0]?.name ?? 'status', op: '_eq', value: '' },
    ]);
  };

  return (
    <div className="space-y-2">
      {value.map((c, idx) => {
        const isNullOp = c.op === '_null' || c.op === '_nnull';
        return (
          <div key={idx} className="flex flex-wrap items-center gap-2">
            <select
              value={c.field}
              onChange={(e) => update(idx, { field: e.target.value })}
              className="rounded-md border bg-background px-2 py-1 text-xs"
            >
              {options.map((o) => (
                <option key={o.name} value={o.name}>{o.label}</option>
              ))}
            </select>
            <select
              value={c.op}
              onChange={(e) => update(idx, { op: e.target.value as ItemFilterOp })}
              className="rounded-md border bg-background px-2 py-1 text-xs"
            >
              {OP_ORDER.map((o) => (
                <option key={o} value={o}>{t(`filter.op.${OP_KEYS[o]}`)}</option>
              ))}
            </select>
            {!isNullOp && (
              <input
                value={c.value}
                onChange={(e) => update(idx, { value: e.target.value })}
                placeholder={t('filter.value')}
                className="min-w-[10rem] flex-1 rounded-md border bg-background px-2 py-1 text-xs"
              />
            )}
            <button
              type="button"
              onClick={() => remove(idx)}
              className="rounded-md p-1 text-muted-foreground hover:bg-accent"
              aria-label={t('filter.remove')}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
      <button
        type="button"
        onClick={add}
        className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
      >
        <Plus className="h-3 w-3" />
        {t('filter.add')}
      </button>
    </div>
  );
}

/**
 * Compile UI conditions into the SDK's `ItemFilter` payload.
 * Values for `_in` / `_nin` are split by comma; `_null` / `_nnull` always set true.
 */
export function compileFilter(rows: FilterCondition[]): ItemFilter | undefined {
  const clauses: ItemFilter[] = [];
  for (const row of rows) {
    if (!row.field) continue;
    if (row.op === '_null' || row.op === '_nnull') {
      clauses.push({ [row.field]: { [row.op]: true } as never });
      continue;
    }
    if (row.value === '' || row.value === undefined) continue;
    let parsed: unknown = row.value;
    if (row.op === '_in' || row.op === '_nin') {
      parsed = row.value.split(',').map((s) => s.trim()).filter(Boolean);
    } else if (['_gt', '_gte', '_lt', '_lte'].includes(row.op)) {
      const n = Number(row.value);
      if (!Number.isNaN(n)) parsed = n;
    }
    clauses.push({ [row.field]: { [row.op]: parsed } as never });
  }
  if (!clauses.length) return undefined;
  if (clauses.length === 1) return clauses[0];
  return { _and: clauses };
}
