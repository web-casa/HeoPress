import { useQuery } from '@tanstack/react-query';
import { Check, ChevronsUpDown, Plus, Search, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { getActiveSite, setActiveSite } from '@/lib/api';
import { getAdminBase } from '@/lib/admin-base';
import { siteFetch } from '@/lib/http';
import { hasUnsaved } from '@/workspace/unsaved';
import i18n from 'i18next';
import { switchSite } from '@/lib/session/switch';

/**
 * The current site, and switching to another one the person can use Studio
 * on (HeoPress P04 task 9.10). A switch saves the other site's session and
 * reloads Studio there; see `lib/session/switch.ts`. The instance
 * administrator can also create a site, becoming its Administrator, and is
 * taken there (HeoPress P07 task 0.1).
 *
 * The current site opens a list of the sites (searchable once there are
 * many), each with its id and the person's role; creating a site is the
 * list's last entry and opens a dialog.
 */

interface MySite {
  id: string;
  name: string;
  displayTitle: string | null;
  roleName: string | null;
  current: boolean;
  mfaRequired: boolean;
}

/** From this many sites on, the list can be searched. */
const SEARCH_FROM = 6;

const label = (s: MySite) => s.displayTitle || s.name;

function SiteMark({ site }: { site: MySite }) {
  return (
    <span aria-hidden="true" className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] bg-brand-soft text-[12px] font-semibold text-brand">
      {label(site).trim().charAt(0).toUpperCase() || '·'}
    </span>
  );
}

export function SiteSwitcher() {
  const { t } = useTranslation('shell');
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
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

  // Closes on a click outside or Escape, back to the trigger.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [open]);
  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  const list = sites.data?.list ?? [];
  const canCreate = sites.data?.canCreate === true;
  const current = list.find((s) => s.current);
  if (!current) return null;

  if (list.length < 2 && !canCreate) {
    return (
      <div className="flex min-w-0 items-center gap-2 px-1 text-[13px] font-medium" aria-label={t('site.current')}>
        <SiteMark site={current} />
        <span className="truncate">{label(current)}</span>
      </div>
    );
  }

  const needle = query.trim().toLowerCase();
  const shown = needle ? list.filter((s) => `${label(s)} ${s.name} ${s.id}`.toLowerCase().includes(needle)) : list;

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onPick = async (siteId: string) => {
    setOpen(false);
    if (siteId === current.id) return;
    // Unsaved edits on this page are lost by a switch: ask first (HeoPress P07a, ADR-0019 §5.4).
    if (hasUnsaved() && !window.confirm(i18n.t('editor:leave'))) return;
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

  // Arrow keys move between the entries of the open list; Escape closes it.
  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [...(rootRef.current?.querySelectorAll<HTMLElement>('[data-entry]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === 'ArrowDown' ? (at + 1) % items.length : (at <= 0 ? items.length : at) - 1;
    items[next]?.focus();
  };

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        ref={triggerRef}
        type="button"
        aria-label={`${t('site.switch')}: ${label(current)}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        data-site={current.id}
        disabled={busy}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className="flex h-9 w-full min-w-0 items-center gap-2 rounded-ctl border border-line bg-panel px-2 text-left text-[13px] font-medium hover:bg-panel-2 disabled:opacity-60"
      >
        <SiteMark site={current} />
        <span className="min-w-0 flex-1 truncate">{busy ? t('site.switching') : label(current)}</span>
        <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-icon" aria-hidden="true" />
      </button>

      {open ? (
        <div
          onKeyDown={onListKey}
          className="absolute left-0 top-full z-40 mt-1 w-[260px] max-w-[calc(100vw-24px)] overflow-hidden rounded-card border border-line bg-panel shadow-lg"
        >
          {list.length >= SEARCH_FROM ? (
            <div className="flex items-center gap-2 border-b border-line px-2.5">
              <Search className="h-3.5 w-3.5 shrink-0 text-icon" aria-hidden="true" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label={t('site.search')}
                placeholder={t('site.search')}
                className="h-9 w-full bg-transparent text-[13px] outline-none"
              />
            </div>
          ) : null}
          <div id={listId} role="listbox" aria-label={t('site.switch')} className="max-h-[320px] overflow-y-auto p-1">
            {shown.map((s, i) => (
              <div
                key={s.id}
                role="option"
                aria-selected={s.current}
                data-site={s.id}
                data-entry=""
                tabIndex={-1}
                // The first entry takes focus when there is no search box, so the arrow keys work at once.
                ref={(el) => {
                  if (el && i === 0 && list.length < SEARCH_FROM && document.activeElement === triggerRef.current) el.focus();
                }}
                onClick={() => void onPick(s.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    void onPick(s.id);
                  }
                }}
                className="flex cursor-pointer items-center gap-2.5 rounded-ctl px-2 py-1.5 outline-none hover:bg-panel-2 focus:bg-panel-2"
              >
                <SiteMark site={s} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium">{label(s)}</span>
                  <span className="block truncate text-[11.5px] text-dim">
                    {s.id}
                    {s.roleName ? ` · ${s.roleName}` : ''}
                  </span>
                </span>
                {s.mfaRequired ? <span className="rounded-[4px] border border-line px-1 text-[10.5px] text-dim">{t('widgets:siteSwitcher.mfa')}</span> : null}
                {s.current ? <Check className="h-4 w-4 shrink-0 text-brand" aria-hidden="true" /> : null}
              </div>
            ))}
            {shown.length === 0 ? <p className="px-2 py-3 text-center text-[12.5px] text-dim">{t('site.noMatch')}</p> : null}
          </div>
          {canCreate ? (
            <div className="border-t border-line p-1">
              <button
                type="button"
                data-entry=""
                onClick={() => {
                  setOpen(false);
                  setCreating(true);
                }}
                className="flex w-full items-center gap-2.5 rounded-ctl px-2 py-1.5 text-left text-[13px] outline-none hover:bg-panel-2 focus:bg-panel-2"
              >
                <span aria-hidden="true" className="flex h-6 w-6 items-center justify-center rounded-[6px] border border-dashed border-line text-icon">
                  <Plus className="h-3.5 w-3.5" />
                </span>
                {t('site.new')}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {failure ? (
        <p role="alert" className="mt-1.5 text-[12px] text-bad">
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
              {t('widgets:siteSwitcher.signInThere')}
            </button>
          ) : null}
        </p>
      ) : null}

      {creating ? (
        <NewSiteDialog
          onClose={() => {
            setCreating(false);
            triggerRef.current?.focus();
          }}
        />
      ) : null}
    </div>
  );
}

/** A site id from its name: lowercase letters, digits and hyphens (empty when the name has none, e.g. in Chinese). */
export function siteIdFrom(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

/** Create a site (instance administrator): name, id and default language; then switch to it. */
function NewSiteDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('shell');
  const formId = useId();
  const [name, setName] = useState('');
  const [id, setId] = useState('');
  const [idEdited, setIdEdited] = useState(false);
  const [language, setLanguage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const siteId = idEdited ? id : siteIdFrom(name);

  const onSubmit = async () => {
    const body = { id: siteId.trim(), name: name.trim(), defaultLanguage: language.trim() || undefined };
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
    const result = await switchSite(body.id, {
      confirmUnknownWrites: () => window.confirm('A change on this site is still being saved and its result is unknown. Switch to the new site anyway?'),
      navigate: (base) => window.location.assign(`${base.replace(/\/$/, '')}/settings/identity?new=1`),
    });
    if (result.ok) return;
    setBusy(false);
    setError(`Created. ${result.message}`);
  };

  const inputClass = 'h-9 w-full rounded-ctl border border-line bg-bg px-2.5 text-[13px] outline-none focus:border-brand';
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !busy) onClose();
      }}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${formId}-title`}
        className="w-full max-w-md rounded-card border border-line bg-panel shadow-xl"
        onSubmit={(e) => {
          e.preventDefault();
          void onSubmit();
        }}
      >
        <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div>
            <h2 id={`${formId}-title`} className="t-section">
              {t('site.new')}
            </h2>
            <p className="t-aux mt-0.5">{t('site.newHint')}</p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label={t('close')} className="flex h-7 w-7 items-center justify-center rounded-ctl text-icon hover:bg-panel-2">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        <div className="flex flex-col gap-4 px-5 py-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${formId}-name`} className="text-[13px] font-medium">
              {t('site.name')}
            </label>
            <input id={`${formId}-name`} autoFocus required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${formId}-id`} className="text-[13px] font-medium">
              {t('site.id')}
            </label>
            <input
              id={`${formId}-id`}
              required
              pattern="[a-z0-9][a-z0-9_\-]*"
              value={siteId}
              onChange={(e) => {
                setIdEdited(true);
                setId(e.target.value);
              }}
              placeholder={t('widgets:siteSwitcher.idPlaceholder')}
              className={`${inputClass} font-mono`}
            />
            <p className="t-aux">{t('site.idHint')}</p>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${formId}-lang`} className="text-[13px] font-medium">
              {t('site.language')}
            </label>
            <input id={`${formId}-lang`} value={language} onChange={(e) => setLanguage(e.target.value)} placeholder={t('widgets:siteSwitcher.languagePlaceholder')} className={`${inputClass} w-32`} />
            <p className="t-aux">{t('site.languageHint')}</p>
          </div>
          {error ? (
            <p role="alert" className="rounded-ctl bg-bad-soft px-3 py-2 text-[12.5px] text-bad">
              {error}
            </p>
          ) : null}
        </div>
        <div className="flex justify-end gap-2 border-t border-line px-5 py-3">
          <button type="button" onClick={onClose} disabled={busy} className="rounded-ctl border border-line px-3 py-1.5 text-[13px] hover:bg-panel-2">
            {t('site.cancel')}
          </button>
          <button type="submit" disabled={busy} className="rounded-ctl bg-brand px-3 py-1.5 text-[13px] text-brand-fg disabled:opacity-50">
            {busy ? t('site.creating') : t('site.create')}
          </button>
        </div>
      </form>
    </div>
  );
}
