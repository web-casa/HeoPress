// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/cn';
import { missionControlApi, type AgentRoleInput, type AgentRoleRow } from './api';
import { MissionControlLayout } from './layout';

/**
 * Agents page (content-os-ui task 16; Req 16.1-16.5) — the agent role
 * library made operable. Roles define WHO can act (capability ceiling per
 * persona, model, prompt ref); the trust ledger defines HOW MUCH autonomy
 * each (role, capability) has earned. Creating/editing requires an admin —
 * the backend enforces it (403) and the page surfaces that instead of a
 * silently failing form.
 */

const NAME_PATTERN = /^[a-z][a-z0-9_-]*$/;

function parseCapabilities(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function CreateRoleForm({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('agents');
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [model, setModel] = useState('');
  const [capabilities, setCapabilities] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (input: AgentRoleInput) => missionControlApi.createRole(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['mc-agent-roles'] });
      onClose();
    },
  });

  const submit = () => {
    if (!NAME_PATTERN.test(name)) {
      setLocalError(t('roles.nameInvalid', { pattern: '^[a-z][a-z0-9_-]*$' }));
      return;
    }
    setLocalError(null);
    mutation.mutate({
      name,
      capabilities: parseCapabilities(capabilities),
      ...(description ? { description } : {}),
      ...(model ? { model } : {}),
    });
  };

  return (
    <div className="space-y-3 rounded-card border border-line bg-panel p-4">
      <div className="flex items-center justify-between">
        <h3 className="t-section">{t('roles.newTitle')}</h3>
        <button type="button" onClick={onClose} aria-label={t('roles.closeCreate')} className="rounded-ctl border border-line p-1 hover:bg-panel-2">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="text-xs">
          <span className="mb-1 block text-dim">{t('roles.nameRequired')}</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('roles.namePlaceholder')}
            className="w-full rounded-ctl border border-line bg-bg px-2 py-1.5 font-mono"
          />
        </label>
        <label className="text-xs">
          <span className="mb-1 block text-dim">{t('roles.model')}</span>
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={t('roles.defaultModel')}
            className="w-full rounded-ctl border border-line bg-bg px-2 py-1.5"
          />
        </label>
        <label className="text-xs sm:col-span-2">
          <span className="mb-1 block text-dim">{t('roles.description')}</span>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="w-full rounded-ctl border border-line bg-bg px-2 py-1.5"
          />
        </label>
        <label className="text-xs sm:col-span-2">
          <span className="mb-1 block text-dim">{t('roles.capabilitiesRequired')}</span>
          <input
            value={capabilities}
            onChange={(e) => setCapabilities(e.target.value)}
            placeholder={t('roles.capabilitiesPlaceholder')}
            className="w-full rounded-ctl border border-line bg-bg px-2 py-1.5 font-mono"
          />
        </label>
      </div>
      {(localError || mutation.isError) && (
        <p className="text-xs text-bad">
          {localError ??
            (mutation.error instanceof Error ? mutation.error.message : t('roles.createFailed'))}
        </p>
      )}
      <button
        type="button"
        onClick={submit}
        disabled={mutation.isPending || !name || !capabilities.trim()}
        className="rounded-ctl bg-brand px-3 py-1.5 text-xs font-medium text-brand-fg hover:opacity-90 disabled:opacity-50"
      >
        {mutation.isPending ? t('roles.creating') : t('roles.create')}
      </button>
    </div>
  );
}

function RoleRow({ role }: { role: AgentRoleRow }) {
  const { t } = useTranslation('agents');
  const queryClient = useQueryClient();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['mc-agent-roles'] });

  const toggleMutation = useMutation({
    mutationFn: () => missionControlApi.updateRole(role.name, { enabled: !role.enabled }),
    onSuccess: invalidate,
  });
  const deleteMutation = useMutation({
    mutationFn: () => missionControlApi.deleteRole(role.name),
    onSuccess: invalidate,
    onSettled: () => setConfirmingDelete(false),
  });

  return (
    <tr className="border-b border-line align-top last:border-0">
      <td className="py-2">
        <span className="font-mono text-sm font-medium">{role.name}</span>
        {role.description && (
          <p className="mt-0.5 max-w-xs text-xs text-dim">{role.description}</p>
        )}
      </td>
      <td className="py-2 text-xs">{role.model ?? <span className="text-dim">{t('roles.defaultModel')}</span>}</td>
      <td className="py-2">
        <div className="flex max-w-sm flex-wrap gap-1">
          {role.capabilities.map((cap) => (
            <code key={cap} className="rounded bg-panel-2 px-1 py-0.5 text-[10px]">
              {cap}
            </code>
          ))}
        </div>
      </td>
      <td className="py-2">
        <button
          type="button"
          role="switch"
          aria-checked={role.enabled}
          aria-label={t('roles.enabledAria', { name: role.name })}
          onClick={() => toggleMutation.mutate()}
          disabled={toggleMutation.isPending}
          className={cn(
            'relative h-5 w-9 rounded-full transition-colors disabled:opacity-50',
            role.enabled ? 'bg-brand' : 'bg-line',
          )}
        >
          <span
            className={cn(
              'absolute top-0.5 h-4 w-4 rounded-full bg-panel transition-all',
              role.enabled ? 'left-[18px]' : 'left-0.5',
            )}
          />
        </button>
      </td>
      <td className="py-2 text-right">
        {confirmingDelete ? (
          <span className="inline-flex gap-1">
            <button
              type="button"
              onClick={() => setConfirmingDelete(false)}
              className="rounded-ctl border border-line px-2 py-1 text-xs hover:bg-panel-2"
            >
              {t('actions.cancel')}
            </button>
            <button
              type="button"
              onClick={() => deleteMutation.mutate()}
              disabled={deleteMutation.isPending}
              className="rounded-ctl bg-bad px-2 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {t('roles.confirmDelete')}
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmingDelete(true)}
            aria-label={t('roles.deleteAria', { name: role.name })}
            className="rounded-ctl border border-line p-1.5 text-bad hover:bg-bad-soft"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
        {(toggleMutation.isError || deleteMutation.isError) && (
          <p className="mt-1 text-right text-[10px] text-bad">
            {((toggleMutation.error ?? deleteMutation.error) as Error)?.message ?? t('actions.failed')}
          </p>
        )}
      </td>
    </tr>
  );
}

function AgentsBody() {
  const { t } = useTranslation('agents');
  const [creating, setCreating] = useState(false);
  const rolesQuery = useQuery({ queryKey: ['mc-agent-roles'], queryFn: missionControlApi.roles });

  if (rolesQuery.isLoading) {
    return <p className="text-sm text-dim">{t('roles.loading')}</p>;
  }
  if (rolesQuery.isError) {
    const message =
      rolesQuery.error instanceof Error ? rolesQuery.error.message : t('roles.loadFailed');
    return <p className="text-sm text-bad">{message}</p>;
  }

  const roles = rolesQuery.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-dim">
          {t('roles.intro')}
        </p>
        {!creating && (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="inline-flex items-center gap-1 rounded-ctl bg-brand px-3 py-1.5 text-xs font-medium text-brand-fg hover:opacity-90"
          >
            <Plus className="h-3.5 w-3.5" /> {t('roles.new')}
          </button>
        )}
      </div>

      {creating && <CreateRoleForm onClose={() => setCreating(false)} />}

      <div className="rounded-card border border-line bg-panel p-4">
        {roles.length === 0 ? (
          <p className="text-sm text-dim">{t('roles.empty')}</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase text-dim">
                <th className="py-2">{t('roles.colRole')}</th>
                <th>{t('roles.model')}</th>
                <th>{t('roles.colCapabilities')}</th>
                <th>{t('roles.colEnabled')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {roles.map((role) => (
                <RoleRow key={role.id} role={role} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export function AgentsPage() {
  return (
    <MissionControlLayout>
      <AgentsBody />
    </MissionControlLayout>
  );
}
