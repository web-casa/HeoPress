// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AGGREGATES, PANEL_TYPES, type Aggregate, type PanelQuery, type PanelType } from '@heopress/contracts';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getApiClient } from '@/lib/api';
import { insightsApi, type Panel } from './api';

/**
 * Inline panel editor (Req 7). Structured form → PanelQuery; field selectors
 * are restricted to the chosen collection's fields (matching the backend
 * whitelist). Includes a live preview before saving.
 * See `docs/legacy/kiro-specs/insights-dashboard`.
 */

interface Props {
  dashboardId: string;
  existing?: Panel;
  onClose: () => void;
}

export function PanelEditor({ dashboardId, existing, onClose }: Props) {
  const { t } = useTranslation('insights');
  const client = getApiClient();
  const queryClient = useQueryClient();

  const [name, setName] = useState(existing?.name ?? '');
  const [type, setType] = useState<PanelType>(existing?.type ?? 'metric');
  const [collection, setCollection] = useState(existing?.query.collection ?? '');
  const [aggregate, setAggregate] = useState<Aggregate>(existing?.query.aggregate ?? 'count');
  const [field, setField] = useState(existing?.query.field ?? '');
  const [groupBy, setGroupBy] = useState(existing?.query.groupBy ?? '');

  const collectionsQuery = useQuery({
    queryKey: ['collections'],
    queryFn: async () => (await client.schema.listCollections()).data,
  });
  const fieldsQuery = useQuery({
    queryKey: ['fields', collection],
    queryFn: async () => (await client.schema.listFields(collection)).data,
    enabled: !!collection,
  });

  const collections = (collectionsQuery.data ?? []) as { name: string }[];
  const fields = (fieldsQuery.data ?? []) as { name: string }[];

  const buildQuery = (): PanelQuery => ({
    collection,
    aggregate,
    ...(aggregate !== 'count' && field ? { field } : {}),
    ...(groupBy ? { groupBy } : {}),
  });

  const previewMutation = useMutation({
    mutationFn: () => insightsApi.previewPanel(dashboardId, buildQuery()),
  });

  const saveMutation = useMutation({
    mutationFn: () => {
      const payload = {
        name: name.trim(),
        type,
        position: existing?.position ?? { x: 0, y: 0, w: 4, h: 4 },
        query: buildQuery(),
      };
      return existing
        ? insightsApi.updatePanel(dashboardId, existing.id, payload)
        : insightsApi.createPanel(dashboardId, payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['insights-panels', dashboardId] });
      onClose();
    },
  });

  const canSave = name.trim() && collection && (aggregate === 'count' || field);

  return (
    <div className="space-y-3 rounded-lg border bg-background p-4">
      <div className="grid grid-cols-2 gap-3">
        <Labeled label={t('editor.name')}>
          <input value={name} onChange={(e) => setName(e.target.value)} className="w-full rounded border px-2 py-1 text-sm" />
        </Labeled>
        <Labeled label={t('editor.type')}>
          <select value={type} onChange={(e) => setType(e.target.value as PanelType)} className="w-full rounded border px-2 py-1 text-sm">
            {PANEL_TYPES.map((pt) => (
              <option key={pt} value={pt}>{t(`panelTypes.${pt}`)}</option>
            ))}
          </select>
        </Labeled>
        <Labeled label={t('editor.collection')}>
          <select value={collection} onChange={(e) => { setCollection(e.target.value); setField(''); setGroupBy(''); }} className="w-full rounded border px-2 py-1 text-sm">
            <option value="">{t('editor.select')}</option>
            {collections.map((c) => (
              <option key={c.name} value={c.name}>{c.name}</option>
            ))}
          </select>
        </Labeled>
        <Labeled label={t('editor.aggregate')}>
          <select value={aggregate} onChange={(e) => setAggregate(e.target.value as Aggregate)} className="w-full rounded border px-2 py-1 text-sm">
            {AGGREGATES.map((a) => (
              <option key={a} value={a}>{t(`aggregates.${a}`)}</option>
            ))}
          </select>
        </Labeled>
        {aggregate !== 'count' && (
          <Labeled label={t('editor.field')}>
            <select value={field} onChange={(e) => setField(e.target.value)} className="w-full rounded border px-2 py-1 text-sm">
              <option value="">{t('editor.select')}</option>
              {fields.map((f) => (
                <option key={f.name} value={f.name}>{f.name}</option>
              ))}
            </select>
          </Labeled>
        )}
        <Labeled label={t('editor.groupBy')}>
          <select value={groupBy} onChange={(e) => setGroupBy(e.target.value)} className="w-full rounded border px-2 py-1 text-sm">
            <option value="">{t('editor.none')}</option>
            {fields.map((f) => (
              <option key={f.name} value={f.name}>{f.name}</option>
            ))}
          </select>
        </Labeled>
      </div>

      <div className="flex items-center gap-2">
        <button type="button" onClick={() => previewMutation.mutate()} disabled={!collection || (aggregate !== 'count' && !field)} className="rounded border px-3 py-1 text-sm hover:bg-muted disabled:opacity-50">
          {t('editor.preview')}
        </button>
        <button type="button" onClick={() => saveMutation.mutate()} disabled={!canSave || saveMutation.isPending} className="rounded bg-primary px-3 py-1 text-sm text-primary-foreground disabled:opacity-50">
          {existing ? t('editor.save') : t('addPanel')}
        </button>
        <button type="button" onClick={onClose} className="rounded border px-3 py-1 text-sm hover:bg-muted">{t('editor.cancel')}</button>
        {saveMutation.isError && <span className="text-xs text-destructive">{(saveMutation.error as Error).message}</span>}
      </div>

      {previewMutation.isError && <p className="text-xs text-destructive">{(previewMutation.error as Error).message}</p>}
      {previewMutation.data && (
        <pre className="max-h-32 overflow-auto rounded bg-muted/40 p-2 text-xs">
          {JSON.stringify(previewMutation.data.data, null, 2)}
        </pre>
      )}
    </div>
  );
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
