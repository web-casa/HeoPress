import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useRouterState } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getAdminBase } from '@/lib/admin-base';
import { getApiClient } from '@/lib/api';
import { cn } from '@/lib/cn';
import { withAdminBase } from '@/lib/keybindings/commands';
import { activeSession } from '@/lib/session/current';
import { siteKey } from '../api';
import { inputClass } from '../seo/seo-kit';
import { PageHeader } from '../ui/page-header';
import { RelativeTime } from '../ui/relative-time';
import { Skeleton } from '../ui/skeleton';

/**
 * Settings › Members & permissions (HeoPress P07a task 12.5; spec studio/settings "成员与权限"): the site's members with
 * their account state, inviting several addresses at once (each answered on its own), changing a role and removing a
 * member after saying what follows. The server keeps the site's last administrator (task 12.4); its refusal is shown.
 */

export interface Member {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  status: string;
  lastSeenAt: string | null;
  roleId: string | null;
}

interface Role {
  id: string;
  name: string;
}

export type AccountState = 'active' | 'invited' | 'disabled';

/** The account state shown: active, not yet accepted, or disabled (any other state of the account). */
export function accountState(status: string): AccountState {
  return status === 'active' ? 'active' : status === 'invited' ? 'invited' : 'disabled';
}

/** Addresses typed or pasted: split on commas, semicolons, spaces and lines; repeats once. */
export function parseEmails(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean))];
}

type InviteResult = { email: string; outcome: 'invited' | 'already' | 'failed'; reason?: string };

const errorText = (err: unknown) => {
  const body = (err as { body?: { errors?: Array<{ message?: string }> } }).body;
  return body?.errors?.[0]?.message ?? (err instanceof Error ? err.message : String(err));
};

export function MembersPage() {
  const { t } = useTranslation('settings');
  const qc = useQueryClient();
  const client = getApiClient();
  const { location } = useRouterState();
  const adminBase = getAdminBase(location.pathname);
  const members = useQuery({ queryKey: siteKey('members'), queryFn: async () => (await client.rawRequest<Member[]>('/api/v1/users')).data });
  const roles = useQuery({ queryKey: siteKey('roles'), queryFn: async () => (await client.rawRequest<Role[]>('/api/v1/roles')).data });
  const [emails, setEmails] = useState('');
  const [inviteRole, setInviteRole] = useState('');
  const [results, setResults] = useState<InviteResult[]>([]);
  const [removing, setRemoving] = useState<Member | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: siteKey('members') });

  const invite = useMutation({
    mutationFn: async () => {
      const out: InviteResult[] = [];
      for (const email of parseEmails(emails)) {
        try {
          const res = (await client.rawRequest<unknown>('/api/v1/users/invite', { method: 'POST', body: JSON.stringify({ email, ...(inviteRole ? { roleId: inviteRole } : {}) }) })) as { meta?: { alreadyMember?: boolean } };
          out.push({ email, outcome: res.meta?.alreadyMember ? 'already' : 'invited' });
        } catch (err) {
          out.push({ email, outcome: 'failed', reason: errorText(err) });
        }
        setResults([...out]);
      }
      return out;
    },
    onSuccess: (out) => {
      if (out.every((r) => r.outcome !== 'failed')) setEmails('');
      void refresh();
    },
  });
  const changeRole = useMutation({
    mutationFn: ({ id, roleId }: { id: string; roleId: string | null }) => client.rawRequest(`/api/v1/users/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ roleId }) }),
    onSuccess: () => {
      setFailure(null);
      void refresh();
    },
    onError: (err) => {
      setFailure(errorText(err));
      void refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => client.rawRequest(`/api/v1/users/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => {
      setRemoving(null);
      setFailure(null);
      void refresh();
    },
    onError: (err) => {
      setRemoving(null);
      setFailure(errorText(err));
    },
  });

  const me = activeSession()?.userId;

  return (
    <>
      <PageHeader
        title={t('members.title')}
        description={t('members.description')}
        actions={
          <>
            {(['roles', 'policies'] as const).map((k) => (
              <Link key={k} to={withAdminBase(adminBase, `/settings/advanced/access/${k}`) as never} className="rounded-ctl border border-line px-2.5 py-1.5 text-[13px] hover:bg-panel-2">
                {t(`members.${k}`)}
              </Link>
            ))}
            <Link to={withAdminBase(adminBase, '/settings/advanced/teams') as never} className="rounded-ctl border border-line px-2.5 py-1.5 text-[13px] hover:bg-panel-2">
              {t('members.teams')}
            </Link>
          </>
        }
      />

      <section aria-label={t('members.invite')} className="mb-5 flex flex-col gap-3 rounded-card border border-line bg-panel p-4">
        <h2 className="t-section">{t('members.invite')}</h2>
        <label htmlFor="invite-emails" className="text-[13px] font-medium">
          {t('members.emails')}
        </label>
        <textarea id="invite-emails" rows={2} className={inputClass} value={emails} onChange={(e) => setEmails(e.target.value)} placeholder={t('members.emailsPlaceholder')} />
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <label htmlFor="invite-role" className="text-[13px] font-medium">
              {t('members.role')}
            </label>
            <select id="invite-role" className={inputClass} value={inviteRole} onChange={(e) => setInviteRole(e.target.value)}>
              <option value="">{t('members.noRole')}</option>
              {(roles.data ?? []).map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </div>
          <button type="button" disabled={!parseEmails(emails).length || invite.isPending} onClick={() => invite.mutate()} className="rounded-ctl bg-brand px-3 py-1.5 text-[13px] text-brand-fg disabled:opacity-50">
            {t('members.send', { count: parseEmails(emails).length })}
          </button>
        </div>
        {results.length ? (
          <ul aria-label={t('members.results')} className="flex flex-col gap-1 text-[13px]">
            {results.map((r) => (
              <li key={r.email} className="flex gap-2">
                <span className="font-mono text-[12px]">{r.email}</span>
                <span className={r.outcome === 'failed' ? 'text-bad' : r.outcome === 'already' ? 'text-dim' : 'text-ok'}>{r.outcome === 'failed' ? t('members.outcome.failed', { reason: r.reason }) : t(`members.outcome.${r.outcome}`)}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      {failure ? (
        <p role="alert" className="mb-3 rounded-ctl border border-bad/40 bg-bad-soft px-3 py-2 text-[13px] text-bad">
          {failure}
        </p>
      ) : null}

      {members.isLoading ? (
        <Skeleton className="h-48" />
      ) : (
        <div className="overflow-x-auto rounded-card border border-line bg-panel">
          <table className="w-full min-w-[640px] text-left text-[13px]">
            <caption className="sr-only">{t('members.title')}</caption>
            <thead className="t-aux">
              <tr className="border-b border-line">
                <th className="px-4 py-2">{t('members.person')}</th>
                <th className="px-4 py-2">{t('members.role')}</th>
                <th className="px-4 py-2">{t('members.account')}</th>
                <th className="px-4 py-2">{t('members.lastSeen')}</th>
                <th className="px-4 py-2">
                  <span className="sr-only">{t('members.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {(members.data ?? []).map((m) => {
                const name = [m.firstName, m.lastName].filter(Boolean).join(' ');
                const state = accountState(m.status);
                return (
                  <tr key={m.id} data-member={m.email} className="border-b border-line last:border-0">
                    <td className="px-4 py-2">
                      <p className="font-medium">{name || m.email}</p>
                      {name ? <p className="t-aux">{m.email}</p> : null}
                    </td>
                    <td className="px-4 py-2">
                      <label htmlFor={`role-${m.id}`} className="sr-only">
                        {t('members.roleOf', { email: m.email })}
                      </label>
                      <select id={`role-${m.id}`} className={cn(inputClass, 'w-auto')} value={m.roleId ?? ''} disabled={changeRole.isPending} onChange={(e) => changeRole.mutate({ id: m.id, roleId: e.target.value || null })}>
                        <option value="">{t('members.noRole')}</option>
                        {(roles.data ?? []).map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-4 py-2">
                      <span className={cn('rounded-full px-2 py-0.5 text-[11.5px]', state === 'active' ? 'bg-ok-soft text-ok' : state === 'invited' ? 'bg-warn-soft text-warn' : 'bg-panel-2 text-dim')}>{t(`members.state.${state}`)}</span>
                    </td>
                    <td className="px-4 py-2 t-aux">{m.lastSeenAt ? <RelativeTime value={m.lastSeenAt} /> : t('members.never')}</td>
                    <td className="px-4 py-2 text-right">
                      <button type="button" onClick={() => setRemoving(m)} className="rounded-ctl px-2 py-1 text-[12.5px] text-bad hover:bg-bad-soft">
                        {m.id === me ? t('members.leave') : t('members.remove')}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {removing ? (
        <div role="dialog" aria-modal="true" aria-labelledby="remove-title" className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4">
          <div className="w-full max-w-md rounded-card border border-line bg-panel p-5 shadow-lg">
            <h2 id="remove-title" className="t-section">
              {t('members.confirmTitle', { email: removing.email })}
            </h2>
            <p className="mt-2 text-[13px]">{accountState(removing.status) === 'invited' ? t('members.confirmInvited') : t('members.confirmBody')}</p>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setRemoving(null)} className="rounded-ctl border border-line px-3 py-1.5 text-[13px]">
                {t('members.cancel')}
              </button>
              <button type="button" disabled={remove.isPending} onClick={() => remove.mutate(removing.id)} className="rounded-ctl bg-bad px-3 py-1.5 text-[13px] text-white">
                {t('members.confirm')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
