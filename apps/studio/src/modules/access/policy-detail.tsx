// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import Editor from '@/lib/code-editor';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { ArrowLeft, Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { PermissionAction } from '@heopress/sdk';
import { useTranslation } from 'react-i18next';
import { getApiClient } from '@/lib/api';
import { cn } from '@/lib/cn';
import { usePermissions } from '@/lib/use-permissions';
import { PermissionRowEditor } from './permission-row-editor';
import {
  buildAccessCollectionGroups,
  firstCollectionOption,
  type AccessCollectionGroup,
} from './system-collections';

const ACTION_OPTIONS: PermissionAction[] = ['create', 'read', 'update', 'delete', 'share', 'review'];

/**
 * Policy detail page. Renders identity + guards + the list of permission rows
 * attached to this policy. Each row can be expanded to edit `fields`,
 * `permissions` (the row-level rule DSL), `validation`, and `presets`.
 */
export function PolicyDetailPage() {
  const { t } = useTranslation('access');
  const { id } = useParams({ strict: false }) as { id: string };
  const client = getApiClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const perms = usePermissions();

  const policyQuery = useQuery({
    queryKey: ['access', 'policy', id],
    queryFn: async () => (await client.policies.detail(id)).data,
  });

  const collectionsQuery = useQuery({
    queryKey: ['collections'],
    queryFn: async () => (await client.schema.listCollections()).data,
  });

  const updatePolicy = useMutation({
    mutationFn: (patch: Parameters<typeof client.policies.update>[1]) =>
      client.policies.update(id, patch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['access', 'policy', id] }),
  });

  const removePolicy = useMutation({
    mutationFn: () => client.policies.delete(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['access', 'policies'] });
      void navigate({ to: '/access/policies' });
    },
  });

  const addPermission = useMutation({
    mutationFn: (input: { collection: string; action: PermissionAction }) =>
      client.policies.addPermission(id, { ...input, fields: ['*'] }),
    onSuccess: () => {
      setAdding(false);
      void queryClient.invalidateQueries({ queryKey: ['access', 'policy', id] });
    },
  });

  if (policyQuery.isLoading) {
    return <p className="text-sm text-dim">{t('policyDetail.loading')}</p>;
  }
  if (policyQuery.error || !policyQuery.data) {
    return (
      <div className="rounded-ctl border border-bad/40 bg-bad-soft p-3 text-sm text-bad">
        {t('policyDetail.notFound')}
      </div>
    );
  }

  const policy = policyQuery.data;

  return (
    <div className="space-y-5">
      <Link
        to="/access/policies"
        className="inline-flex items-center gap-1 text-xs text-dim hover:text-fg"
      >
        <ArrowLeft className="h-3 w-3" /> {t('policyDetail.back')}
      </Link>

      <header className="flex items-start justify-between gap-4">
        <div className="flex-1 space-y-2">
          <input
            value={policy.name}
            onChange={(e) => updatePolicy.mutate({ name: e.target.value })}
            className="w-full rounded-ctl border bg-bg px-3 py-1.5 text-lg font-semibold border-line"
          />
          <textarea
            value={policy.description ?? ''}
            placeholder={t('roleDetail.descriptionPlaceholder')}
            onChange={(e) => updatePolicy.mutate({ description: e.target.value })}
            rows={2}
            className="w-full rounded-ctl border border-line bg-bg px-2.5 py-1.5 text-[13px] outline-none focus:border-brand text-dim"
          />
        </div>
        <button
          type="button"
          onClick={() => {
            if (confirm(t('policies.deleteConfirm', { name: policy.name }))) removePolicy.mutate();
          }}
          className="inline-flex items-center gap-1 rounded-ctl border border-bad/40 px-2 py-1 text-xs text-bad hover:bg-bad-soft"
        >
          <Trash2 className="h-3.5 w-3.5" /> {t('roleDetail.delete')}
        </button>
      </header>

      <GuardsSection
        rules={policy.rules ?? {}}
        onChange={(rules) => updatePolicy.mutate({ rules })}
      />

      <section className="rounded-card border p-4 border-line">
        <header className="mb-3 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold">{t('policyDetail.rows')}</h3>
            <p className="text-xs text-dim">
              {t('policyDetail.rowsHint')}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="inline-flex items-center gap-1 rounded-ctl bg-brand px-2 py-1 text-xs font-medium text-brand-fg"
          >
            <Plus className="h-3 w-3" /> {t('policyDetail.addPermission')}
          </button>
        </header>

        {policy.permissions.length === 0 && (
          <p className="rounded-ctl border border-dashed p-6 text-center text-xs text-dim border-line">
            {t('policyDetail.noRows')}
          </p>
        )}

        <ul className="space-y-3">
          {policy.permissions.map((row) => (
            <li key={row.id}>
              <PermissionRowEditor
                policyId={id}
                row={row}
                onChange={() =>
                  queryClient.invalidateQueries({ queryKey: ['access', 'policy', id] })
                }
              />
            </li>
          ))}
        </ul>
      </section>

      {adding && (
        <AddPermissionDialog
          collectionGroups={buildAccessCollectionGroups(
            (collectionsQuery.data ?? []).map((c) => c.name),
            perms.isAdmin,
          )}
          onClose={() => setAdding(false)}
          onSubmit={(collection, action) => addPermission.mutate({ collection, action })}
          submitting={addPermission.isPending}
          error={addPermission.error as Error | null}
        />
      )}
    </div>
  );
}

interface PolicyGuardRules {
  validFrom?: string | null;
  validUntil?: string | null;
  ipAllow?: string[];
  ipDeny?: string[];
}

/**
 * GUI + Monaco for the policy `rules` blob. The BE evaluator reads
 * `validFrom`, `validUntil`, `ipAllow`, `ipDeny`; everything else is preserved
 * verbatim so future fields (custom flags) survive a round-trip edit.
 */
function GuardsSection({
  rules,
  onChange,
}: {
  rules: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const { t } = useTranslation('access');
  const guards = rules as PolicyGuardRules;
  const [mode, setMode] = useState<'gui' | 'json'>('gui');
  const text = useMemo(() => JSON.stringify(rules ?? {}, null, 2), [rules]);

  const update = (patch: Partial<PolicyGuardRules>) => {
    onChange({ ...rules, ...patch });
  };

  return (
    <section className="rounded-card border p-4 border-line">
      <header className="mb-3 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">{t('policyDetail.guards.title')}</h3>
          <p className="text-xs text-dim">
            {t('policyDetail.guards.hint')}
          </p>
        </div>
        <div className="flex items-center gap-1 rounded-ctl border bg-panel-2 p-0.5 text-xs border-line">
          <button
            type="button"
            onClick={() => setMode('gui')}
            className={cn('rounded px-2 py-0.5', mode === 'gui' && 'bg-bg shadow-sm')}
          >
            {t('policyDetail.guards.gui')}
          </button>
          <button
            type="button"
            onClick={() => setMode('json')}
            className={cn('rounded px-2 py-0.5', mode === 'json' && 'bg-bg shadow-sm')}
          >
            {t('policyDetail.guards.json')}
          </button>
        </div>
      </header>

      {mode === 'gui' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="mb-1 block text-xs font-medium text-dim">{t('policyDetail.guards.validFrom')}</span>
            <input
              type="datetime-local"
              value={toLocalDateInput(guards.validFrom)}
              onChange={(e) =>
                update({ validFrom: e.target.value ? new Date(e.target.value).toISOString() : null })
              }
              className="w-full rounded-ctl border bg-bg px-2 py-1 text-xs border-line"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-xs font-medium text-dim">{t('policyDetail.guards.validUntil')}</span>
            <input
              type="datetime-local"
              value={toLocalDateInput(guards.validUntil)}
              onChange={(e) =>
                update({ validUntil: e.target.value ? new Date(e.target.value).toISOString() : null })
              }
              className="w-full rounded-ctl border bg-bg px-2 py-1 text-xs border-line"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-xs font-medium text-dim">
              {t('policyDetail.guards.ipAllow')}
            </span>
            <input
              value={(guards.ipAllow ?? []).join(', ')}
              onChange={(e) =>
                update({ ipAllow: splitCsv(e.target.value) })
              }
              className="w-full rounded-ctl border bg-bg px-2 py-1 text-xs border-line"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-xs font-medium text-dim">
              {t('policyDetail.guards.ipDeny')}
            </span>
            <input
              value={(guards.ipDeny ?? []).join(', ')}
              onChange={(e) =>
                update({ ipDeny: splitCsv(e.target.value) })
              }
              className="w-full rounded-ctl border bg-bg px-2 py-1 text-xs border-line"
            />
          </label>
        </div>
      )}

      {mode === 'json' && (
        <div className="overflow-hidden rounded-ctl border border-line">
          <Editor
            height="180px"
            defaultLanguage="json"
            value={text}
            onChange={(v) => {
              try {
                const parsed = JSON.parse(v ?? '{}');
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                  onChange(parsed);
                }
              } catch {
                /* ignore until JSON is valid */
              }
            }}
            options={{
              minimap: { enabled: false },
              fontSize: 12,
              scrollBeyondLastLine: false,
            }}
          />
        </div>
      )}
    </section>
  );
}

function toLocalDateInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function splitCsv(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function AddPermissionDialog({
  collectionGroups,
  onClose,
  onSubmit,
  submitting,
  error,
}: {
  collectionGroups: AccessCollectionGroup[];
  onClose: () => void;
  onSubmit: (collection: string, action: PermissionAction) => void;
  submitting: boolean;
  error: Error | null;
}) {
  const { t } = useTranslation('access');
  const [collection, setCollection] = useState(firstCollectionOption(collectionGroups));
  const [action, setAction] = useState<PermissionAction>('read');
  const sensitiveCount = collectionGroups.find((group) => group.id === 'sensitive')?.options.length ?? 0;

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-md rounded-card border bg-bg p-5 shadow-lg border-line">
        <h3 className="mb-3 text-base font-semibold">{t('policyDetail.addPermission')}</h3>
        <div className="space-y-3 text-sm">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-dim">{t('policyDetail.collection')}</span>
            {collectionGroups.length === 0 ? (
              <input
                value={collection}
                onChange={(e) => setCollection(e.target.value)}
                placeholder={t('policyDetail.collectionPlaceholder')}
                className="w-full rounded-ctl border border-line bg-bg px-2.5 py-1.5 text-[13px] outline-none focus:border-brand"
              />
            ) : (
              <select
                value={collection}
                onChange={(e) => setCollection(e.target.value)}
                className="w-full rounded-ctl border border-line bg-bg px-2.5 py-1.5 text-[13px] outline-none focus:border-brand"
              >
                {collectionGroups.map((group) => (
                  <optgroup key={group.id} label={group.label}>
                    {group.options.map((option) => (
                      <option key={option.name} value={option.name}>
                        {option.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            )}
          </label>
          <div className="rounded-ctl border bg-panel-2 px-3 py-2 text-xs text-dim border-line">
            {collectionGroups.map((group) => (
              <p key={group.id}>
                <span className="font-medium text-fg">{t('policyDetail.groupLabel', { label: group.label })}</span>{' '}
                {group.hint}
              </p>
            ))}
            {sensitiveCount === 0 && (
              <p className="mt-1">
                {t('policyDetail.sensitiveHidden')}
              </p>
            )}
          </div>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-dim">{t('policyDetail.action')}</span>
            <select
              value={action}
              onChange={(e) => setAction(e.target.value as PermissionAction)}
              className="w-full rounded-ctl border border-line bg-bg px-2.5 py-1.5 text-[13px] outline-none focus:border-brand"
            >
              {ACTION_OPTIONS.map((a) => (
                <option key={a} value={a}>
                  {t(`matrix.actions.${a}`)}
                </option>
              ))}
            </select>
          </label>
          {error && <p className="text-xs text-bad">{error.message}</p>}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-ctl border px-3 py-1.5 text-xs border-line">
            {t('common:cancel')}
          </button>
          <button
            type="button"
            disabled={!collection.trim() || submitting}
            onClick={() => onSubmit(collection.trim(), action)}
            className="rounded-ctl bg-brand px-3 py-1.5 text-xs font-medium text-brand-fg disabled:opacity-50"
          >
            {submitting ? t('policyDetail.adding') : t('policyDetail.add')}
          </button>
        </div>
      </div>
    </div>
  );
}
