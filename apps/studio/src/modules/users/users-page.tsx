// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Mail, Shield, UserX, UserCheck, ShieldAlert, Trash2, Edit } from 'lucide-react';
import { useState } from 'react';
import { getApiClient } from '@/lib/api';
import { cn } from '@/lib/cn';
import type { UserResource } from '@heopress/sdk';

export function UsersPage() {
  const { t } = useTranslation('access');
  const client = getApiClient();
  const qc = useQueryClient();

  const usersQuery = useQuery({
    queryKey: ['users'],
    queryFn: async () => (await client.users.list()).data,
  });

  const rolesQuery = useQuery({
    queryKey: ['roles'],
    queryFn: async () => (await client.roles.list()).data,
  });

  const [inviting, setInviting] = useState(false);
  const [editing, setEditing] = useState<UserResource | null>(null);

  const users = usersQuery.data ?? [];
  const roles = rolesQuery.data ?? [];

  const deleteMutation = useMutation({
    mutationFn: (id: string) => client.users.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  });

  const getRoleName = (roleId: string | null) => {
    if (!roleId) return t('users.noRole');
    return roles.find(r => r.id === roleId)?.name ?? t('users.unknownRole');
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{t('users.title')}</h1>
        <button
          type="button"
          onClick={() => setInviting(true)}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
        >
          <Mail className="h-4 w-4" /> {t('users.invite')}
        </button>
      </div>

      <div className="overflow-hidden rounded-lg border bg-background shadow-sm">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground border-b">
            <tr>
              <th className="px-4 py-3">{t('users.columns.user')}</th>
              <th className="px-4 py-3">{t('users.columns.role')}</th>
              <th className="px-4 py-3">{t('users.columns.status')}</th>
              <th className="px-4 py-3">{t('users.columns.lastSeen')}</th>
              <th className="w-24 px-4 py-3 text-right">{t('users.columns.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {usersQuery.isLoading && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">{t('common:loading')}</td></tr>
            )}
            {!usersQuery.isLoading && users.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">{t('users.empty')}</td></tr>
            )}
            {users.map((row) => (
              <tr key={row.id} className="border-b hover:bg-muted/10 last:border-0">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-primary font-medium">
                      {row.firstName?.[0] ?? row.email[0]?.toUpperCase() ?? '?'}
                    </div>
                    <div>
                      <div className="font-medium text-foreground">
                        {row.firstName} {row.lastName}
                      </div>
                      <div className="text-xs text-muted-foreground">{row.email}</div>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3">
                  <span className="inline-flex items-center gap-1 rounded bg-muted px-2 py-0.5 text-xs text-foreground">
                    <Shield className="h-3 w-3" />
                    {getRoleName(row.roleId)}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <UserStatusBadge status={row.status} />
                </td>
                <td className="px-4 py-3 text-xs text-muted-foreground">
                  {row.lastSeenAt ? new Date(row.lastSeenAt).toLocaleString() : t('users.never')}
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="flex items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setEditing(row)}
                      className="text-muted-foreground hover:text-foreground"
                      aria-label={t('users.edit')}
                    >
                      <Edit className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (confirm(t('users.confirmRemove'))) {
                          deleteMutation.mutate(row.id);
                        }
                      }}
                      className="text-muted-foreground hover:text-destructive"
                      aria-label={t('users.remove')}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {inviting && (
        <InviteDialog onClose={() => setInviting(false)} />
      )}
      
      {editing && (
        <EditUserDialog user={editing} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}

function UserStatusBadge({ status }: { status: string }) {
  const { t } = useTranslation('access');
  if (status === 'active') {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">
        <UserCheck className="h-3 w-3" /> {t('users.status.active')}
      </span>
    );
  }
  if (status === 'invited') {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800">
        <Mail className="h-3 w-3" /> {t('users.status.invited')}
      </span>
    );
  }
  if (status === 'suspended') {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
        <UserX className="h-3 w-3" /> {t('users.status.suspended')}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
      {status}
    </span>
  );
}

function InviteDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('access');
  const client = getApiClient();
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [roleId, setRoleId] = useState('');

  const rolesQuery = useQuery({
    queryKey: ['roles'],
    queryFn: async () => (await client.roles.list()).data,
  });

  const mutation = useMutation({
    mutationFn: () => client.users.invite({ email, roleId: roleId || undefined }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['users'] });
      onClose();
    },
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-xl border bg-background p-6 shadow-lg">
        <h2 className="text-lg font-semibold mb-4">{t('users.inviteTitle')}</h2>
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium">{t('users.email')}</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-md border px-3 py-2 text-sm outline-none focus:border-primary"
              placeholder={t('users.emailPlaceholder')}
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">{t('users.assignRole')}</label>
            <select
              value={roleId}
              onChange={(e) => setRoleId(e.target.value)}
              className="w-full rounded-md border px-3 py-2 text-sm outline-none focus:border-primary"
            >
              <option value="">{t('users.noRole')}</option>
              {(rolesQuery.data ?? []).map(r => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
          </div>
          <div className="flex justify-end gap-2 mt-6">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-4 py-2 text-sm font-medium hover:bg-muted"
            >
              {t('common:cancel')}
            </button>
            <button
              type="button"
              onClick={() => mutation.mutate()}
              disabled={!email || mutation.isPending}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {mutation.isPending ? t('users.inviting') : t('users.sendInvite')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function EditUserDialog({ user, onClose }: { user: UserResource; onClose: () => void }) {
  const { t } = useTranslation('access');
  const client = getApiClient();
  const qc = useQueryClient();
  const [roleId, setRoleId] = useState(user.roleId ?? '');
  const [status, setStatus] = useState(user.status);

  const rolesQuery = useQuery({
    queryKey: ['roles'],
    queryFn: async () => (await client.roles.list()).data,
  });

  const mutation = useMutation({
    mutationFn: () => client.users.update(user.id, { roleId: roleId || null, status }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['users'] });
      onClose();
    },
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-xl border bg-background p-6 shadow-lg">
        <h2 className="text-lg font-semibold mb-4">{t('users.editTitle', { email: user.email })}</h2>
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium">{t('users.columns.role')}</label>
            <select
              value={roleId}
              onChange={(e) => setRoleId(e.target.value)}
              className="w-full rounded-md border px-3 py-2 text-sm outline-none focus:border-primary"
            >
              <option value="">{t('users.noRole')}</option>
              {(rolesQuery.data ?? []).map(r => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">{t('users.columns.status')}</label>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="w-full rounded-md border px-3 py-2 text-sm outline-none focus:border-primary"
            >
              <option value="active">{t('users.status.active')}</option>
              <option value="invited">{t('users.status.invited')}</option>
              <option value="suspended">{t('users.status.suspended')}</option>
            </select>
          </div>
          <div className="flex justify-end gap-2 mt-6">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-4 py-2 text-sm font-medium hover:bg-muted"
            >
              {t('common:cancel')}
            </button>
            <button
              type="button"
              onClick={() => mutation.mutate()}
              disabled={mutation.isPending}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {mutation.isPending ? t('users.saving') : t('common:save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
