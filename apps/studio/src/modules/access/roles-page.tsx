// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RoleResource } from '@heopress/sdk';
import { getApiClient } from '@/lib/api';

/**
 * Roles list page. Shows every role in the active site plus a primary CTA to
 * create a new one. Drilling in opens `RoleDetailPage` which handles policy
 * attachments and user assignment.
 */
export function RolesListPage() {
  const { t } = useTranslation('access');
  const client = getApiClient();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);

  const rolesQuery = useQuery({
    queryKey: ['access', 'roles'],
    queryFn: async () => (await client.roles.list()).data,
  });

  const removeRole = useMutation({
    mutationFn: (id: string) => client.roles.delete(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['access', 'roles'] }),
  });

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between">
        <div>
          <h2 className="t-section">{t('roles.title')}</h2>
          <p className="text-xs text-dim">{t('roles.description')}</p>
        </div>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="inline-flex items-center gap-2 rounded-ctl bg-brand px-3 py-1.5 text-[13px] font-medium text-brand-fg hover:opacity-90"
        >
          <Plus className="h-4 w-4" /> {t('roles.new')}
        </button>
      </header>

      {rolesQuery.error && (
        <div className="rounded-ctl border border-bad/40 bg-bad-soft p-3 text-sm text-bad">
          {t('roles.loadFailed')}
        </div>
      )}

      {rolesQuery.data && rolesQuery.data.length === 0 && (
        <div className="rounded-card border border-dashed p-12 text-center border-line">
          <ShieldCheck className="mx-auto mb-3 h-8 w-8 text-dim" />
          <h3 className="text-base font-medium">{t('roles.emptyTitle')}</h3>
          <p className="mt-1 text-sm text-dim">
            {t('roles.emptyBody')}
          </p>
        </div>
      )}

      {rolesQuery.data && rolesQuery.data.length > 0 && (
        <div className="overflow-hidden rounded-card border border-line">
          <table className="w-full text-sm">
            <thead className="bg-panel-2 text-left text-xs uppercase text-dim">
              <tr>
                <th className="px-4 py-2 font-medium">{t('roles.columns.name')}</th>
                <th className="px-4 py-2 font-medium">{t('roles.columns.admin')}</th>
                <th className="px-4 py-2 font-medium">{t('roles.columns.appAccess')}</th>
                <th className="px-4 py-2 font-medium">{t('roles.columns.description')}</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {rolesQuery.data.map((r) => (
                <tr key={r.id} className="border-t hover:bg-panel-2">
                  <td className="px-4 py-2">
                    <Link
                      to="/access/roles/$id"
                      params={{ id: r.id }}
                      className="font-medium text-brand hover:underline"
                    >
                      {r.name}
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-xs">{r.adminAccess ? t('roles.yes') : t('roles.no')}</td>
                  <td className="px-4 py-2 text-xs">{r.appAccess ? t('roles.yes') : t('roles.no')}</td>
                  <td className="px-4 py-2 text-xs text-dim">
                    {r.description ?? '—'}
                  </td>
                  <td className="px-2 py-2">
                    <button
                      type="button"
                      aria-label={t('roles.deleteLabel', { name: r.name })}
                      onClick={() => {
                        if (confirm(t('roles.deleteConfirm', { name: r.name }))) removeRole.mutate(r.id);
                      }}
                      className="rounded-ctl p-1 text-dim hover:bg-bad-soft hover:text-bad"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creating && (
        <CreateRoleDialog
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            queryClient.invalidateQueries({ queryKey: ['access', 'roles'] });
          }}
        />
      )}
    </div>
  );
}

function CreateRoleDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (role: RoleResource) => void;
}) {
  const { t } = useTranslation('access');
  const client = getApiClient();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [adminAccess, setAdminAccess] = useState(false);
  const [appAccess, setAppAccess] = useState(true);

  const create = useMutation({
    mutationFn: async () => {
      const res = await client.roles.create({
        name: name.trim(),
        description: description.trim() || undefined,
        adminAccess,
        appAccess,
      });
      return res.data;
    },
    onSuccess: (role) => onCreated(role),
  });

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-md rounded-card border bg-bg p-5 shadow-lg border-line">
        <h3 className="mb-3 text-base font-semibold">{t('roles.new')}</h3>
        <div className="space-y-3 text-sm">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-dim">{t('roles.columns.name')}</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              placeholder={t('roles.namePlaceholder')}
              className="w-full rounded-ctl border border-line bg-bg px-2.5 py-1.5 text-[13px] outline-none focus:border-brand"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-dim">{t('roles.columns.description')}</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="w-full rounded-ctl border border-line bg-bg px-2.5 py-1.5 text-[13px] outline-none focus:border-brand"
            />
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={adminAccess}
              onChange={(e) => setAdminAccess(e.target.checked)}
            />
            <span>{t('roles.adminAccessHint')}</span>
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={appAccess}
              onChange={(e) => setAppAccess(e.target.checked)}
            />
            <span>{t('roles.appAccessHint')}</span>
          </label>
          {create.error && (
            <p className="text-xs text-bad">{(create.error as Error).message}</p>
          )}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-ctl border px-3 py-1.5 text-xs border-line"
          >
            {t('common:cancel')}
          </button>
          <button
            type="button"
            disabled={!name.trim() || create.isPending}
            onClick={() => create.mutate()}
            className="rounded-ctl bg-brand px-3 py-1.5 text-xs font-medium text-brand-fg disabled:opacity-50"
          >
            {create.isPending ? t('roles.creating') : t('roles.create')}
          </button>
        </div>
      </div>
    </div>
  );
}
