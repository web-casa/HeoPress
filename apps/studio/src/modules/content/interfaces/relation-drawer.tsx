// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Check, Loader2, Plus, Search, X } from 'lucide-react';
import { useState } from 'react';
import type { FieldResource } from '@heopress/sdk';
import { getApiClient } from '@/lib/api';
import { cn } from '@/lib/cn';
import { resolveInterface } from './registry';

type Mode = 'existing' | 'new';

interface RelationDrawerProps {
  /** Target collection to pick from / create into. */
  collection: string;
  /** Field on the related collection used as the human label. */
  displayField?: string;
  /** Ids already selected — hidden from the "Add existing" list. */
  excludeIds?: string[];
  /** Allow selecting more than one existing item before confirming. */
  multiple?: boolean;
  /** Which tab opens first. */
  initialMode?: Mode;
  onClose: () => void;
  /** Called with the chosen/created item ids. */
  onSelect: (ids: string[]) => void;
}

/**
 * Shared relational picker drawer used by o2m / m2m / m2a interfaces.
 * Offers two modes: "Add existing" (searchable multi-select) and "Create new"
 * (an inline form built from the target collection's fields).
 */
export function RelationDrawer({
  collection,
  displayField = 'title',
  excludeIds = [],
  multiple = true,
  initialMode = 'existing',
  onClose,
  onSelect,
}: RelationDrawerProps) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const { t } = useTranslation('items');

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/30 backdrop-blur-[1px]" onClick={onClose} aria-hidden="true" />
      <div className="flex h-full w-full max-w-[520px] flex-col bg-panel shadow-2xl">
        <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-4">
          <div>
            <h3 className="text-sm font-semibold">
              {mode === 'existing' ? t('interfaces.addExisting') : t('interfaces.createNew')} —{' '}
              <span className="font-mono text-dim">{collection}</span>
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-ctl p-1 text-dim hover:bg-panel-2 hover:text-fg"
            aria-label={t('interfaces.close')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex border-b border-line px-3">
          {(['existing', 'new'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={cn(
                'border-b-2 px-3 py-2.5 text-xs font-medium transition-colors',
                mode === m
                  ? 'border-brand text-fg'
                  : 'border-transparent text-dim hover:text-fg',
              )}
            >
              {m === 'existing' ? t('interfaces.addExisting') : t('interfaces.createNew')}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {mode === 'existing' ? (
            <ExistingPicker
              collection={collection}
              displayField={displayField}
              excludeIds={excludeIds}
              multiple={multiple}
              onConfirm={(ids) => {
                onSelect(ids);
                onClose();
              }}
            />
          ) : (
            <CreateForm
              collection={collection}
              onCreated={(id) => {
                onSelect([id]);
                onClose();
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function ExistingPicker({
  collection,
  displayField,
  excludeIds,
  multiple,
  onConfirm,
}: {
  collection: string;
  displayField: string;
  excludeIds: string[];
  multiple: boolean;
  onConfirm: (ids: string[]) => void;
}) {
  const client = getApiClient();
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const { t } = useTranslation('items');

  const query = useQuery({
    queryKey: ['relation-drawer-existing', collection, search, displayField],
    queryFn: async () =>
      client.items(collection as never).list({
        limit: 50,
        filter: search ? { [displayField]: { _contains: search } } : undefined,
      }),
  });

  const toggle = (id: string) => {
    if (!multiple) {
      onConfirm([id]);
      return;
    }
    setPicked((prev) => (prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]));
  };

  const rows = (query.data?.data ?? []).filter((r) => !excludeIds.includes(r.id));

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 rounded-ctl border border-line bg-bg px-2">
        <Search className="h-3.5 w-3.5 text-dim" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('interfaces.searchBy', { field: displayField })}
          className="w-full bg-transparent py-1.5 text-sm focus:outline-none"
        />
      </div>

      <ul className="divide-y rounded-ctl border border-line">
        {query.isLoading && <li className="px-3 py-2 text-xs text-dim">{t('interfaces.loading')}</li>}
        {!query.isLoading && rows.length === 0 && (
          <li className="px-3 py-2 text-xs text-dim">{t('interfaces.noMatches')}</li>
        )}
        {rows.map((row) => {
          const active = picked.includes(row.id);
          return (
            <li key={row.id}>
              <button
                type="button"
                onClick={() => toggle(row.id)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-panel-2"
              >
                {multiple && (
                  <span
                    className={cn(
                      'flex h-4 w-4 items-center justify-center rounded border border-line',
                      active ? 'border-brand bg-brand text-brand-fg' : 'border-line',
                    )}
                  >
                    {active && <Check className="h-3 w-3" />}
                  </span>
                )}
                <span className="font-mono text-xs text-dim">{row.id.slice(0, 6)}…</span>
                <span>{String(row.data?.[displayField] ?? '—')}</span>
              </button>
            </li>
          );
        })}
      </ul>

      {multiple && (
        <div className="flex justify-end">
          <button
            type="button"
            disabled={picked.length === 0}
            onClick={() => onConfirm(picked)}
            className="inline-flex items-center gap-1 rounded-ctl bg-brand px-3 py-1.5 text-xs font-medium text-brand-fg disabled:opacity-50"
          >
            <Plus className="h-3.5 w-3.5" />
            {picked.length > 0 ? t('interfaces.addCount', { count: picked.length }) : t('interfaces.add')}
          </button>
        </div>
      )}
    </div>
  );
}

function CreateForm({
  collection,
  onCreated,
}: {
  collection: string;
  onCreated: (id: string) => void;
}) {
  const client = getApiClient();
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const { t } = useTranslation('items');

  const fieldsQuery = useQuery({
    queryKey: ['relation-drawer-fields', collection],
    queryFn: async () => (await client.schema.listFields(collection)).data,
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      const res = await client.items(collection as never).create({ data: draft });
      return res.data;
    },
    onSuccess: (row) => onCreated(row.id),
  });

  const editable: FieldResource[] = (fieldsQuery.data ?? []).filter(
    (f) => !f.hidden && f.type !== 'alias' && f.name !== 'id' && !f.interface.startsWith('presentation-'),
  );

  if (fieldsQuery.isLoading) {
    return <p className="text-sm text-dim">{t('interfaces.loadingFields')}</p>;
  }

  return (
    <div className="space-y-4">
      {editable.map((f) => {
        const Interface = resolveInterface(f);
        return (
          <div key={f.id}>
            <label className="mb-1 flex items-center gap-1 text-xs font-medium text-dim">
              <span>{f.label || f.name}</span>
              {f.required && <span className="text-bad">*</span>}
            </label>
            <Interface
              field={f}
              value={draft[f.name]}
              onChange={(next) => setDraft((prev) => ({ ...prev, [f.name]: next }))}
            />
          </div>
        );
      })}

      {createMutation.error && (
        <p className="rounded-ctl border border-bad/40 bg-bad-soft p-2 text-xs text-bad">
          {t('interfaces.createFailed')}
        </p>
      )}

      <div className="flex justify-end">
        <button
          type="button"
          disabled={createMutation.isPending}
          onClick={() => createMutation.mutate()}
          className="inline-flex items-center gap-1 rounded-ctl bg-brand px-3 py-1.5 text-xs font-medium text-brand-fg disabled:opacity-50"
        >
          {createMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
          {t('interfaces.createAndAdd')}
        </button>
      </div>
    </div>
  );
}
