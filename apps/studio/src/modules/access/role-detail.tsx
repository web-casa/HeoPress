// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import type { AccessConflict, AccessConflictReport } from '@heopress/sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { AlertTriangle, ArrowLeft, Plus, Trash2, UserPlus, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getApiClient } from '@/lib/api';

/**
 * Role detail page — flag toggles + attached policies + assigned users.
 * Wires to the Phase C `/api/v1/roles/:id` endpoints exposed in the SDK.
 */
export function RoleDetailPage() {
  const { t } = useTranslation('access');
  const { id } = useParams({ strict: false }) as { id: string };
  const client = getApiClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [conflictReport, setConflictReport] = useState<AccessConflictReport | null>(null);

  const roleQuery = useQuery({
    queryKey: ['access', 'role', id],
    queryFn: async () => (await client.roles.detail(id)).data,
  });

  const policiesQuery = useQuery({
    queryKey: ['access', 'policies'],
    queryFn: async () => (await client.policies.list()).data,
  });

  const updateRole = useMutation({
    mutationFn: (patch: Parameters<typeof client.roles.update>[1]) =>
      client.roles.update(id, patch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['access', 'role', id] }),
  });

  const removeRole = useMutation({
    mutationFn: () => client.roles.delete(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['access', 'roles'] });
      void navigate({ to: '/access/roles' });
    },
  });

  const attachPolicy = useMutation({
    mutationFn: async (policyId: string) => {
      const report = (await client.access.checkConflicts({
        target: { type: 'role', id },
        addPolicies: [policyId],
      })).data;

      setConflictReport(report);
      if (report.conflicts.length > 0) {
        throw new Error(t('roleDetail.conflictsBlock'));
      }
      const overrideWarnings = report.warnings.length > 0;
      if (
        overrideWarnings &&
        !confirm(t('roleDetail.attachWithWarnings', { count: report.warnings.length }))
      ) {
        throw new Error(t('roleDetail.attachCancelled'));
      }

      return client.roles.attachPolicy(id, { policyId, overrideWarnings });
    },
    onSuccess: () => {
      setConflictReport(null);
      void queryClient.invalidateQueries({ queryKey: ['access', 'role', id] });
    },
  });

  const detachPolicy = useMutation({
    mutationFn: (policyId: string) => client.roles.detachPolicy(id, policyId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['access', 'role', id] }),
  });

  const assignUser = useMutation({
    mutationFn: (userId: string) => client.roles.assignUser(id, { userId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['access', 'role', id] }),
  });

  const removeUser = useMutation({
    mutationFn: (userId: string) => client.roles.removeUser(id, userId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['access', 'role', id] }),
  });

  if (roleQuery.isLoading) {
    return <p className="text-sm text-dim">{t('roleDetail.loading')}</p>;
  }
  if (roleQuery.error || !roleQuery.data) {
    return (
      <div className="rounded-ctl border border-bad/40 bg-bad-soft p-3 text-sm text-bad">
        {t('roleDetail.notFound')}
      </div>
    );
  }

  const role = roleQuery.data;
  const policiesById = new Map((policiesQuery.data ?? []).map((p) => [p.id, p]));
  const attachedIds = new Set(role.policies.map((p) => p.policyId));
  const detachable = role.policies.slice().sort((a, b) => a.priority - b.priority);
  const available = (policiesQuery.data ?? []).filter((p) => !attachedIds.has(p.id));

  return (
    <div className="space-y-5">
      <Link
        to="/access/roles"
        className="inline-flex items-center gap-1 text-xs text-dim hover:text-fg"
      >
        <ArrowLeft className="h-3 w-3" /> {t('roleDetail.back')}
      </Link>

      <header className="flex items-start justify-between gap-4">
        <div className="flex-1 space-y-2">
          <input
            value={role.name}
            onChange={(e) => updateRole.mutate({ name: e.target.value })}
            className="w-full rounded-ctl border bg-bg px-3 py-1.5 text-lg font-semibold border-line"
          />
          <textarea
            value={role.description ?? ''}
            placeholder={t('roleDetail.descriptionPlaceholder')}
            onChange={(e) => updateRole.mutate({ description: e.target.value })}
            rows={2}
            className="w-full rounded-ctl border border-line bg-bg px-2.5 py-1.5 text-[13px] outline-none focus:border-brand text-dim"
          />
        </div>
        <button
          type="button"
          onClick={() => {
            if (confirm(t('roles.deleteConfirm', { name: role.name }))) removeRole.mutate();
          }}
          className="inline-flex items-center gap-1 rounded-ctl border border-bad/40 px-2 py-1 text-xs text-bad hover:bg-bad-soft"
        >
          <Trash2 className="h-3.5 w-3.5" /> {t('roleDetail.delete')}
        </button>
      </header>

      <section className="grid gap-3 sm:grid-cols-2">
        <FlagToggle
          label={t('roleDetail.adminAccess')}
          hint={t('roleDetail.adminAccessHint')}
          checked={role.adminAccess}
          onChange={(v) => updateRole.mutate({ adminAccess: v })}
        />
        <FlagToggle
          label={t('roleDetail.appAccess')}
          hint={t('roleDetail.appAccessHint')}
          checked={role.appAccess}
          onChange={(v) => updateRole.mutate({ appAccess: v })}
        />
      </section>

      <section className="rounded-card border p-4 border-line">
        <header className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold">{t('roleDetail.attachedPolicies')}</h3>
          <span className="text-xs text-dim">{t('roleDetail.attachedCount', { count: role.policies.length })}</span>
        </header>
        {detachable.length === 0 && (
          <p className="text-xs text-dim">{t('roleDetail.noPolicies')}</p>
        )}
        {detachable.length > 0 && (
          <ul className="space-y-1">
            {detachable.map((p) => {
              const meta = policiesById.get(p.policyId);
              return (
                <li
                  key={p.policyId}
                  className="flex items-center justify-between rounded-ctl border bg-panel-2 px-3 py-2 text-sm border-line"
                >
                  <Link
                    to="/access/policies/$id"
                    params={{ id: p.policyId }}
                    className="text-brand hover:underline"
                  >
                    {meta?.name ?? p.policyId}
                  </Link>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-dim">
                      {t('roleDetail.priority', { priority: p.priority })}
                    </span>
                    <button
                      type="button"
                      onClick={() => detachPolicy.mutate(p.policyId)}
                      className="rounded-ctl p-1 text-dim hover:bg-bad-soft hover:text-bad"
                      aria-label={t('roleDetail.detachPolicy')}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {available.length > 0 && (
          <div className="mt-3 flex items-center gap-2">
            <select
              defaultValue=""
              onChange={(e) => {
                const v = e.target.value;
                if (v) {
                  attachPolicy.mutate(v);
                  e.target.value = '';
                }
              }}
              className="flex-1 rounded-ctl border bg-bg px-2 py-1 text-xs border-line"
            >
              <option value="" disabled>
                {t('roleDetail.attachPlaceholder')}
              </option>
              {available.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <Link
              to="/access/policies"
              className="inline-flex items-center gap-1 rounded-ctl border px-2 py-1 text-xs border-line"
            >
              <Plus className="h-3 w-3" /> {t('roleDetail.managePolicies')}
            </Link>
          </div>
        )}
        {conflictReport && (
          <ConflictReportPanel
            conflicts={conflictReport.conflicts}
            warnings={conflictReport.warnings}
          />
        )}
        {attachPolicy.error && (
          <p role="alert" className="mt-2 text-xs text-bad">
            {(attachPolicy.error as Error).message}
          </p>
        )}
      </section>

      <section className="rounded-card border p-4 border-line">
        <header className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold">{t('roleDetail.members')}</h3>
          <span className="text-xs text-dim">{t('roleDetail.assignedCount', { count: role.users.length })}</span>
        </header>
        {role.users.length === 0 && (
          <p className="text-xs text-dim">
            {t('roleDetail.noMembers')}
          </p>
        )}
        {role.users.length > 0 && (
          <ul className="space-y-1">
            {role.users.map((u) => (
              <li
                key={u.userId}
                className="flex items-center justify-between rounded-ctl border bg-panel-2 px-3 py-2 text-xs border-line"
              >
                <span className="font-mono">{u.userId}</span>
                <button
                  type="button"
                  onClick={() => removeUser.mutate(u.userId)}
                  className="rounded-ctl p-1 text-dim hover:bg-bad-soft hover:text-bad"
                  aria-label={t('roleDetail.removeUser')}
                >
                  <X className="h-3 w-3" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <AssignUserInline onAssign={(userId) => assignUser.mutate(userId)} />
      </section>
    </div>
  );
}

function FlagToggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-2 rounded-ctl border p-3 text-[13px] hover:bg-panel-2 border-line">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5"
      />
      <div>
        <span className="font-medium">{label}</span>
        <p className="text-xs text-dim">{hint}</p>
      </div>
    </label>
  );
}

function ConflictReportPanel({
  conflicts,
  warnings,
}: {
  conflicts: AccessConflict[];
  warnings: AccessConflict[];
}) {
  const { t } = useTranslation('access');
  if (conflicts.length === 0 && warnings.length === 0) {
    return (
      <div className="mt-3 rounded-ctl border border-ok/40 bg-ok-soft px-3 py-2 text-xs text-ok">
        {t('roleDetail.conflict.none')}
      </div>
    );
  }

  return (
    <div className="mt-3 space-y-2 rounded-ctl border border-warn/40 bg-warn-soft px-3 py-2 text-xs">
      <div className="flex items-center gap-2 font-medium text-warn">
        <AlertTriangle className="h-3.5 w-3.5" />
        {t('roleDetail.conflict.preview')}
      </div>
      {conflicts.length > 0 && (
        <ConflictList
          title={t('roleDetail.conflict.blocking')}
          items={conflicts}
          className="border-bad/40 bg-bad-soft text-bad"
        />
      )}
      {warnings.length > 0 && (
        <ConflictList
          title={t('roleDetail.conflict.warnings')}
          items={warnings}
          className="border-warn/40 bg-bg/60 text-fg"
        />
      )}
    </div>
  );
}

function ConflictList({
  title,
  items,
  className,
}: {
  title: string;
  items: AccessConflict[];
  className: string;
}) {
  return (
    <div className={`rounded-ctl border px-2 py-1.5 ${className} border-line`}>
      <p className="mb-1 font-medium">{title}</p>
      <ul className="space-y-1">
        {items.map((item, index) => (
          <li key={`${item.collection}:${item.action}:${index}`}>
            <span className="font-mono">{item.collection}</span> / {item.action}: {item.reason}
          </li>
        ))}
      </ul>
    </div>
  );
}

function AssignUserInline({ onAssign }: { onAssign: (userId: string) => void }) {
  const { t } = useTranslation('access');
  const [userId, setUserId] = useState('');
  return (
    <div className="mt-3 flex items-center gap-2">
      <input
        value={userId}
        onChange={(e) => setUserId(e.target.value)}
        placeholder={t('roleDetail.userIdPlaceholder')}
        className="flex-1 rounded-ctl border bg-bg px-2 py-1 text-xs font-mono border-line"
      />
      <button
        type="button"
        disabled={!userId.trim()}
        onClick={() => {
          onAssign(userId.trim());
          setUserId('');
        }}
        className="inline-flex items-center gap-1 rounded-ctl bg-brand px-2 py-1 text-xs text-brand-fg disabled:opacity-50"
      >
        <UserPlus className="h-3 w-3" /> {t('roleDetail.assign')}
      </button>
    </div>
  );
}
