// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { getActiveSite, getActiveToken, getApiClient } from '@/lib/api';
import { siteFetch } from '@/lib/http';
import i18n from 'i18next';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '@/workspace/ui/page-header';

/**
 * Materialized views manager (studio-ops-ui task 1; Req 1).
 *
 * Surfaces /api/v1/materialize: denormalized physical tables (mat_*)
 * refreshed from a source collection by trigger (auto), cron, or hand.
 * Deleting DROPS the physical table — that is not revertable, hence the
 * two-step confirm.
 */

const TARGET_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;

interface MaterializationRow {
  id: string;
  collection?: string;
  sourceCollection?: string;
  target: string;
  refreshStrategy: string;
  refreshCron?: string | null;
  lastRefreshAt?: string | null;
  [key: string]: unknown;
}

async function materializeFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getActiveToken();
  const site = getActiveSite();
  const res = await siteFetch(`/api/v1/materialize${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(site ? { 'X-HeoPress-Site': site } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const body = (await res.json().catch(() => ({}))) as {
    data?: T;
    errors?: Array<{ code: string; message: string }>;
  };
  if (!res.ok) {
    throw new Error(body.errors?.[0]?.message ?? i18n.t('siteOps:email.requestFailed', { status: res.status }));
  }
  return body.data as T;
}

function CreateForm({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('siteOps');
  const queryClient = useQueryClient();
  const collectionsQuery = useQuery({
    queryKey: ['mc-collections'],
    queryFn: async () => (await getApiClient().schema.listCollections()).data,
  });
  const [collection, setCollection] = useState('');
  const [target, setTarget] = useState('');
  const [strategy, setStrategy] = useState<'auto' | 'cron' | 'manual'>('manual');
  const [cron, setCron] = useState('0 * * * *');
  const [localError, setLocalError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (input: Record<string, unknown>) =>
      materializeFetch('', { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['materialize-list'] });
      onClose();
    },
  });

  const submit = () => {
    if (!TARGET_PATTERN.test(target)) {
      setLocalError(t('materialize.targetInvalid', { pattern: '^[a-z][a-z0-9_]{0,62}$' }));
      return;
    }
    setLocalError(null);
    mutation.mutate({
      collection,
      target,
      refreshStrategy: strategy,
      ...(strategy === 'cron' ? { refreshCron: cron } : {}),
      projection: { fields: ['*'] },
    });
  };

  const collections = (collectionsQuery.data ?? []) as Array<{ name: string; label?: string | null }>;

  return (
    <div className="space-y-3 rounded-card border bg-panel p-4 border-line">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">{t('materialize.new')}</h3>
        <button type="button" onClick={onClose} aria-label={t('materialize.closeForm')} className="rounded-ctl border p-1 hover:bg-panel-2 border-line">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <label className="text-xs">
          <span className="mb-1 block text-dim">{t('materialize.sourceRequired')}</span>
          {collectionsQuery.isError ? (
            <input
              value={collection}
              onChange={(e) => setCollection(e.target.value)}
              placeholder={t('materialize.sourcePlaceholder')}
              aria-label={t('materialize.source')}
              className="w-full rounded-ctl border border-line bg-bg px-2.5 py-1.5 text-[13px] outline-none focus:border-brand font-mono"
            />
          ) : (
            <select
              value={collection}
              onChange={(e) => setCollection(e.target.value)}
              aria-label={t('materialize.source')}
              className="w-full rounded-ctl border border-line bg-bg px-2.5 py-1.5 text-[13px] outline-none focus:border-brand"
            >
              <option value="">{t('materialize.choose')}</option>
              {collections.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.label ?? c.name}
                </option>
              ))}
            </select>
          )}
        </label>
        <label className="text-xs">
          <span className="mb-1 block text-dim">{t('materialize.targetRequired')}</span>
          <input
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder={t('materialize.targetPlaceholder')}
            className="w-full rounded-ctl border border-line bg-bg px-2.5 py-1.5 text-[13px] outline-none focus:border-brand font-mono"
          />
        </label>
        <label className="text-xs">
          <span className="mb-1 block text-dim">{t('materialize.strategy')}</span>
          <select
            value={strategy}
            onChange={(e) => setStrategy(e.target.value as typeof strategy)}
            aria-label={t('materialize.strategy')}
            className="w-full rounded-ctl border border-line bg-bg px-2.5 py-1.5 text-[13px] outline-none focus:border-brand"
          >
            <option value="manual">{t('materialize.strategies.manual')}</option>
            <option value="cron">{t('materialize.strategies.cron')}</option>
            <option value="auto">{t('materialize.strategies.autoTrigger')}</option>
          </select>
        </label>
        {strategy === 'cron' && (
          <label className="text-xs">
            <span className="mb-1 block text-dim">{t('materialize.cron')}</span>
            <input
              value={cron}
              onChange={(e) => setCron(e.target.value)}
              aria-label={t('materialize.refreshCron')}
              className="w-full rounded-ctl border border-line bg-bg px-2.5 py-1.5 text-[13px] outline-none focus:border-brand font-mono"
            />
          </label>
        )}
      </div>
      {(localError || mutation.isError) && (
        <p className="text-xs text-bad">
          {localError ??
            (mutation.error instanceof Error ? mutation.error.message : t('materialize.createFailed'))}
        </p>
      )}
      <button
        type="button"
        onClick={submit}
        disabled={mutation.isPending || !collection || !target}
        className="rounded-ctl bg-brand px-3 py-1.5 text-[13px] text-brand-fg hover:opacity-90 disabled:opacity-50"
      >
        {mutation.isPending ? t('domains.creating') : t('materialize.create')}
      </button>
    </div>
  );
}

function MaterializationRowView({ row }: { row: MaterializationRow }) {
  const { t } = useTranslation('siteOps');
  const queryClient = useQueryClient();
  const [confirmingDrop, setConfirmingDrop] = useState(false);
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['materialize-list'] });

  const refreshMutation = useMutation({
    mutationFn: () => materializeFetch(`/${row.id}/refresh`, { method: 'POST', body: '{}' }),
    onSuccess: invalidate,
  });
  const dropMutation = useMutation({
    mutationFn: () => materializeFetch(`/${row.id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
    onSettled: () => setConfirmingDrop(false),
  });

  const source = row.collection ?? row.sourceCollection ?? '—';

  return (
    <tr className="border-b align-top last:border-0 border-line">
      <td className="py-2">
        <code className="rounded bg-panel-2 px-1 text-xs">{String(source)}</code>
      </td>
      <td className="py-2 font-mono text-xs">{t('materialize.tableName', { target: row.target })}</td>
      <td className="py-2 text-xs">
        {t(`materialize.strategies.${row.refreshStrategy}`, { defaultValue: row.refreshStrategy })}
        {row.refreshCron ? <code className="ml-1 rounded bg-panel-2 px-1">{row.refreshCron}</code> : null}
      </td>
      <td className="py-2 text-xs text-dim">
        {row.lastRefreshAt ? new Date(row.lastRefreshAt).toLocaleString() : t('materialize.never')}
      </td>
      <td className="py-2 text-right">
        <span className="inline-flex items-center gap-1">
          <button
            type="button"
            onClick={() => refreshMutation.mutate()}
            disabled={refreshMutation.isPending}
            aria-label={t('materialize.refreshTarget', { target: row.target })}
            className="inline-flex items-center gap-1 rounded-ctl border px-2 py-1 text-xs hover:bg-panel-2 disabled:opacity-50 border-line"
          >
            <RefreshCw className="h-3 w-3" />
            {refreshMutation.isPending ? t('materialize.refreshing') : t('materialize.refreshNow')}
          </button>
          {confirmingDrop ? (
            <>
              <button
                type="button"
                onClick={() => setConfirmingDrop(false)}
                className="rounded-ctl border px-2 py-1 text-xs hover:bg-panel-2 border-line"
              >
                {t('common:cancel')}
              </button>
              <button
                type="button"
                onClick={() => dropMutation.mutate()}
                disabled={dropMutation.isPending}
                className="rounded-ctl bg-bad px-2 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {t('materialize.confirmDrop')}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmingDrop(true)}
              aria-label={t('materialize.dropTarget', { target: row.target })}
              className="rounded-ctl border p-1.5 text-bad hover:bg-bad-soft border-line"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </span>
        {(refreshMutation.isError || dropMutation.isError) && (
          <p className="mt-1 text-right text-[10px] text-bad">
            {((refreshMutation.error ?? dropMutation.error) as Error)?.message ?? t('materialize.actionFailed')}
          </p>
        )}
      </td>
    </tr>
  );
}

export function MaterializePage() {
  const { t } = useTranslation('siteOps');
  const [creating, setCreating] = useState(false);
  const listQuery = useQuery({
    queryKey: ['materialize-list'],
    queryFn: () => materializeFetch<MaterializationRow[]>(''),
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('materialize.title')}
        description={t('materialize.description')}
        actions={
          !creating && (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="inline-flex items-center gap-1 rounded-ctl bg-brand px-3 py-1.5 text-[13px] text-brand-fg disabled:opacity-50"
            >
              <Plus className="h-3.5 w-3.5" /> {t('materialize.new')}
            </button>
          )
        }
      />

      {creating && <CreateForm onClose={() => setCreating(false)} />}

      <div className="rounded-card border bg-panel p-4 border-line">
        {listQuery.isLoading ? (
          <p className="text-sm text-dim">{t('materialize.loading')}</p>
        ) : listQuery.isError ? (
          <p className="text-sm text-bad">
            {listQuery.error instanceof Error ? listQuery.error.message : t('materialize.loadFailed')}
          </p>
        ) : (listQuery.data ?? []).length === 0 ? (
          <p className="text-sm text-dim">{t('materialize.empty')}</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-panel-2 text-left text-[12px] text-dim">
                <th className="py-2">{t('materialize.col.source')}</th>
                <th>{t('materialize.col.table')}</th>
                <th>{t('materialize.col.strategy')}</th>
                <th>{t('materialize.col.lastRefresh')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(listQuery.data ?? []).map((row) => (
                <MaterializationRowView key={row.id} row={row} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
