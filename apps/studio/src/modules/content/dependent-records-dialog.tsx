// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { useMutation } from '@tanstack/react-query';
import { AlertTriangle, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getApiClient } from '@/lib/api';

/** One group of records that reference the item being deleted. */
export interface DependentGroup {
  relation: string;
  collection: string;
  field: string;
  onDelete: string;
  count: number;
  sample: Array<{ id: string }>;
}

type Action = 'set_null' | 'delete' | 'reassign';

/**
 * Shown when deleting an item is blocked because other records reference it
 * (HTTP 409 DEPENDENT_RECORDS_EXIST). For each dependency group the editor
 * picks a resolution; once all groups are cleared the parent retries the delete.
 * Spec: fk-dependent-records Req 11.
 */
export function DependentRecordsDialog(props: {
  collection: string;
  itemId: string;
  groups: DependentGroup[];
  onClose: () => void;
  onAllResolved: () => void;
}) {
  const client = getApiClient();
  const { t } = useTranslation('items');
  const [resolved, setResolved] = useState<Record<string, boolean>>({});
  const [choice, setChoice] = useState<Record<string, Action>>({});
  const [reassignTo, setReassignTo] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const resolveMutation = useMutation({
    mutationFn: async (group: DependentGroup) => {
      const action = choice[group.relation] ?? 'set_null';
      await client.rawRequest(`/api/v1/items/${props.collection}/${props.itemId}/resolve-dependents`, {
        method: 'POST',
        body: JSON.stringify({
          action,
          relation: group.relation,
          newTargetId: action === 'reassign' ? reassignTo[group.relation] : undefined,
        }),
      });
    },
    onSuccess: (_data, group) => {
      const next = { ...resolved, [group.relation]: true };
      setResolved(next);
      setError(null);
      if (props.groups.every((g) => next[g.relation])) props.onAllResolved();
    },
    onError: (err: unknown) => {
      setError((err as { body?: { errors?: Array<{ message?: string }> } })?.body?.errors?.[0]?.message ?? t('dependents.failed'));
    },
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-card border border-line bg-panel p-5 shadow-xl">
        <div className="mb-3 flex items-start justify-between">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <AlertTriangle className="h-4 w-4 text-bad" />
            {t('dependents.title')}
          </div>
          <button type="button" onClick={props.onClose} aria-label={t('common:close')} className="text-dim hover:text-fg">
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="mb-4 text-xs text-dim">
          {t('dependents.intro')}
        </p>

        <div className="space-y-3">
          {props.groups.map((g) => (
            <div key={g.relation} className="rounded-ctl border border-line p-3 text-xs">
              <div className="mb-2 flex items-center justify-between">
                <span className="font-medium">
                  {g.count} × {g.collection}.{g.field}
                </span>
                {resolved[g.relation] ? (
                  <span className="text-ok">{t('dependents.resolved')}</span>
                ) : (
                  <span className="text-dim">{t('dependents.onDelete', { action: g.onDelete })}</span>
                )}
              </div>
              {!resolved[g.relation] && (
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    className="rounded border border-line bg-bg px-2 py-1"
                    value={choice[g.relation] ?? 'set_null'}
                    onChange={(e) => setChoice({ ...choice, [g.relation]: e.target.value as Action })}
                  >
                    <option value="set_null">{t('dependents.setNull')}</option>
                    <option value="reassign">{t('dependents.reassign')}</option>
                    <option value="delete">{t('dependents.delete')}</option>
                  </select>
                  {(choice[g.relation] ?? 'set_null') === 'reassign' && (
                    <input
                      placeholder={t('dependents.targetId')}
                      className="rounded border border-line bg-bg px-2 py-1"
                      value={reassignTo[g.relation] ?? ''}
                      onChange={(e) => setReassignTo({ ...reassignTo, [g.relation]: e.target.value })}
                    />
                  )}
                  <button
                    type="button"
                    disabled={resolveMutation.isPending}
                    onClick={() => resolveMutation.mutate(g)}
                    className="rounded bg-brand px-2 py-1 text-brand-fg hover:opacity-90"
                  >
                    {t('dependents.apply')}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>

        {error && <div className="mt-3 rounded border border-bad/40 bg-bad-soft p-2 text-xs text-bad">{error}</div>}
      </div>
    </div>
  );
}
