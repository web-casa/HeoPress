import { useQuery } from '@tanstack/react-query';
import { Building2, Plus } from 'lucide-react';
import { useId, useState } from 'react';
import { getActiveSite, setActiveSite } from '@/lib/api';
import { getAdminBase } from '@/lib/admin-base';
import { siteFetch } from '@/lib/http';
import { switchSite } from '@/lib/session/switch';

/**
 * The current site, and switching to another one the person can use Studio
 * on (HeoPress P04 task 9.10). A switch saves the other site's session and
 * reloads Studio there; see `lib/session/switch.ts`. The instance
 * administrator can also create a site, becoming its Administrator, and is
 * taken there (HeoPress P07 task 0.1).
 */

interface MySite {
  id: string;
  name: string;
  displayTitle: string | null;
  roleName: string | null;
  current: boolean;
  mfaRequired: boolean;
}

export function SiteSwitcher() {
  const selectId = useId();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ message: string; signInTo?: string } | null>(null);
  const sites = useQuery({
    queryKey: ['my-sites', getActiveSite()],
    queryFn: async () => {
      const res = await siteFetch('/api/v1/auth/sites');
      if (!res.ok) throw new Error('Could not load your sites.');
      const body = (await res.json()) as { data: MySite[]; meta?: { canCreateSites?: boolean } };
      return { list: body.data, canCreate: body.meta?.canCreateSites === true };
    },
  });

  const list = sites.data?.list ?? [];
  const current = list.find((s) => s.current);
  const label = (s: MySite) => s.displayTitle || s.name;
  if (!current) return null;
  const create = sites.data?.canCreate ? <NewSite /> : null;
  if (list.length < 2) {
    return (
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground" aria-label="Current site">
          <Building2 className="h-4 w-4" aria-hidden="true" />
          {label(current)}
        </span>
        {create}
      </div>
    );
  }

  const onChange = async (siteId: string) => {
    if (siteId === current.id) return;
    const target = list.find((s) => s.id === siteId);
    setBusy(true);
    setFailure(null);
    const result = await switchSite(siteId, {
      confirmUnknownWrites: () =>
        window.confirm(
          `A change on ${label(current)} is still being saved and its result is unknown. Switch anyway? ` +
            `Check it when you return to ${label(current)}.`,
        ),
    });
    if (result.ok) return; // the page reloads on the other site
    setBusy(false);
    setFailure({ message: result.message, ...(result.code === 'MFA_REQUIRED' && target ? { signInTo: target.id } : {}) });
  };

  return (
    <div className="flex items-center gap-2">
      <label htmlFor={selectId} className="sr-only">
        Switch site
      </label>
      <Building2 className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
      <select
        id={selectId}
        value={current.id}
        disabled={busy}
        onChange={(e) => void onChange(e.target.value)}
        className="h-9 rounded-md border border-border bg-background px-2 text-sm"
      >
        {list.map((s) => (
          <option key={s.id} value={s.id}>
            {label(s)}
            {s.roleName ? ` — ${s.roleName}` : ''}
            {s.mfaRequired ? ' (2FA)' : ''}
          </option>
        ))}
      </select>
      {create}
      {busy ? <span className="text-xs text-muted-foreground">Switching…</span> : null}
      {failure ? (
        <span role="alert" className="text-xs text-destructive">
          {failure.message}
          {failure.signInTo ? (
            <button
              type="button"
              className="ml-1 underline"
              onClick={() => {
                setActiveSite(failure.signInTo!);
                const base = getAdminBase(window.location.pathname);
                window.location.assign(base ? `${base}/login` : '/');
              }}
            >
              Sign in there
            </button>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

/** Create a site (instance administrator): id, name and default language; then switch to it. */
function NewSite() {
  const formId = useId();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (form: HTMLFormElement) => {
    const data = new FormData(form);
    const id = String(data.get('id') ?? '').trim();
    const body = { id, name: String(data.get('name') ?? '').trim(), defaultLanguage: String(data.get('defaultLanguage') ?? '').trim() || undefined };
    setBusy(true);
    setError(null);
    const res = await siteFetch('/api/v1/instance/sites', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) {
      const err = (await res.json().catch(() => null)) as { errors?: Array<{ message?: string }> } | null;
      setBusy(false);
      setError(err?.errors?.[0]?.message ?? 'Could not create the site.');
      return;
    }
    // The creator is its Administrator: go there — to its identity first (P07 task 2.12: who the site speaks for).
    const result = await switchSite(id, {
      confirmUnknownWrites: () => window.confirm('A change on this site is still being saved and its result is unknown. Switch to the new site anyway?'),
      navigate: (base) => window.location.assign(`${base.replace(/\/$/, '')}/settings/identity?new=1`),
    });
    if (result.ok) return;
    setBusy(false);
    setError(`Created. ${result.message}`);
  };

  if (!open) {
    return (
      <button type="button" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground" onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" aria-hidden="true" />
        New site
      </button>
    );
  }
  return (
    <form
      aria-label="New site"
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void onSubmit(e.currentTarget);
      }}
    >
      <label htmlFor={`${formId}-id`} className="sr-only">
        Site id
      </label>
      <input id={`${formId}-id`} name="id" required pattern="[a-z0-9][a-z0-9_\-]*" placeholder="site-id" className="h-9 w-32 rounded-md border border-border bg-background px-2 text-sm" />
      <label htmlFor={`${formId}-name`} className="sr-only">
        Site name
      </label>
      <input id={`${formId}-name`} name="name" required maxLength={200} placeholder="Name" className="h-9 w-40 rounded-md border border-border bg-background px-2 text-sm" />
      <label htmlFor={`${formId}-lang`} className="sr-only">
        Default language
      </label>
      <input id={`${formId}-lang`} name="defaultLanguage" placeholder="en" className="h-9 w-16 rounded-md border border-border bg-background px-2 text-sm" />
      <button type="submit" disabled={busy} className="h-9 rounded-md border border-border px-3 text-sm">
        {busy ? 'Creating…' : 'Create'}
      </button>
      <button type="button" disabled={busy} className="h-9 px-2 text-sm text-muted-foreground" onClick={() => setOpen(false)}>
        Cancel
      </button>
      {error ? (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      ) : null}
    </form>
  );
}
