import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useBlocker } from '@tanstack/react-router';
import { Lock } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { SiteSeoSettings } from '@heopress/contracts/schemas';
import { getApiClient } from '@/lib/api';
import { usePermissions } from '@/lib/use-permissions';
import { siteKey } from '../api';
import { setUnsaved } from '../unsaved';
import { changedPaths, effectiveForDiff, validateSeo, type SeoErrors } from './seo-rules';

/**
 * The SEO / GEO module's frame (HeoPress P07a tasks 8.2, 8.4; spec studio/seo-settings): each section explains on the left
 * and holds its form on the right; members see every section read-only with the reason; unsaved changes show in a bar at
 * the bottom and are asked about before leaving the page, the section or the site.
 */

export function SeoSection({ title, explain, children, aside }: { title: string; explain: ReactNode; children: ReactNode; aside?: ReactNode }) {
  const { t } = useTranslation('seo');
  const { isAdmin } = usePermissions();
  return (
    <section aria-label={title} className="grid gap-6 pb-24 min-[900px]:grid-cols-[minmax(0,280px)_minmax(0,1fr)]">
      {/* Lined up with the form: the title starts where the card's first field does. */}
      <div className="min-[900px]:pt-5">
        <h1 className="text-[17px] font-semibold leading-6">{title}</h1>
        <div className="mt-2 flex flex-col gap-2 text-[13px] leading-relaxed text-dim">{explain}</div>
        {!isAdmin ? (
          <p role="note" className="mt-4 flex items-start gap-2 rounded-ctl border border-line bg-panel-2 px-3 py-2 text-[12.5px]">
            <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-icon" aria-hidden="true" />
            {t('readOnly')}
          </p>
        ) : null}
        {aside}
      </div>
      {/* A disabled fieldset turns every control of the form off at once for members. */}
      <fieldset disabled={!isAdmin} className="flex min-w-0 flex-col gap-5 rounded-card border border-line bg-panel p-5 disabled:opacity-90">
        {children}
      </fieldset>
    </section>
  );
}

/** A labelled control with its hint and, when invalid, the message (already translated) beside it. */
export function Field({ id, label, hint, error, children }: { id: string; label: string; hint?: ReactNode; error?: string | null; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[13px] font-medium">
        {label}
      </label>
      {children}
      {hint ? <p className="t-aux">{hint}</p> : null}
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-[12.5px] text-bad">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export const inputClass = 'w-full rounded-ctl border border-line bg-bg px-2.5 py-1.5 text-[13px] outline-none focus:border-brand disabled:cursor-not-allowed disabled:opacity-60';

/** Asks before leaving with unsaved changes: another route, closing the tab, or switching site (the site switcher reads `hasUnsaved`). */
export function useLeaveGuard(key: string, dirty: boolean): void {
  const { t } = useTranslation('editor');
  useEffect(() => {
    setUnsaved(key, dirty);
    return () => setUnsaved(key, false);
  }, [key, dirty]);
  useBlocker({ shouldBlockFn: () => !window.confirm(t('leave')), disabled: !dirty, enableBeforeUnload: () => dirty });
}

/** The bottom bar: how many changes, discard, save — or how many errors to fix first; then when the change takes effect. */
export function UnsavedBar({ count, errors, saving, failed, savedNote, onDiscard, onSave }: { count: number; errors: number; saving: boolean; failed: string | null; savedNote: string | null; onDiscard: () => void; onSave: () => void }) {
  const { t } = useTranslation('seo');
  if (!count && !failed && !savedNote) return null;
  return (
    <div role="region" aria-label={t('bar.label')} className="sticky bottom-0 z-10 -mx-4 mt-4 flex flex-wrap items-center gap-3 border-t border-line bg-panel px-4 py-3 sm:-mx-6 sm:px-6">
      {count ? (
        <>
          <span className="text-[13px] font-medium text-warn">{t('bar.count', { count })}</span>
          {failed ? (
            <span role="alert" className="text-[12.5px] text-bad">
              {failed}
            </span>
          ) : null}
          <span className="flex-1" />
          <button type="button" onClick={onDiscard} className="rounded-ctl border border-line px-3 py-1.5 text-[13px] hover:bg-panel-2">
            {t('bar.discard')}
          </button>
          <button type="button" disabled={errors > 0 || saving} onClick={onSave} className="rounded-ctl bg-brand px-3 py-1.5 text-[13px] text-brand-fg disabled:opacity-50">
            {errors > 0 ? t('bar.fixFirst', { count: errors }) : saving ? t('bar.saving') : t('bar.save')}
          </button>
        </>
      ) : (
        <p role="status" className="text-[13px] text-ok">
          {savedNote}
        </p>
      )}
    </div>
  );
}

interface SeoView {
  settings: SiteSeoSettings;
  version: number;
}

/** The site's SEO settings as a draft: what changed, what is wrong, discard and save (against the version read). */
export function useSeoDraft(section: string) {
  const { t } = useTranslation('seo');
  const qc = useQueryClient();
  const query = useQuery({ queryKey: siteKey('seo-settings'), queryFn: async () => (await getApiClient().rawRequest<SeoView>('/api/v1/site/seo-settings')).data });
  const [draft, setDraft] = useState<SiteSeoSettings | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const saved = query.data?.settings ?? null;
  const value = draft ?? saved;
  const changes = useMemo(() => (draft && saved ? changedPaths(effectiveForDiff(saved), effectiveForDiff(draft)) : []), [draft, saved]);
  const errors: SeoErrors = useMemo(() => (draft ? validateSeo(draft) : {}), [draft]);
  useLeaveGuard(`seo:${section}`, changes.length > 0);
  const save = useMutation({
    mutationFn: async () => (await getApiClient().rawRequest<SeoView>('/api/v1/site/seo-settings', { method: 'PUT', body: JSON.stringify({ ...draft, version: query.data?.version ?? 0 }) })).data,
    onSuccess: (view) => {
      qc.setQueryData(siteKey('seo-settings'), view);
      setDraft(null);
      setSavedNote(t('bar.saved'));
    },
  });
  const update = (fn: (s: SiteSeoSettings) => SiteSeoSettings) => {
    if (!value) return;
    setSavedNote(null);
    setDraft(fn(structuredClone(value)));
  };
  const failed = save.error ? ((save.error as { status?: number }).status === 409 ? t('bar.conflict') : t('bar.failed', { reason: save.error instanceof Error ? save.error.message : String(save.error) })) : null;
  return {
    loading: query.isLoading,
    value,
    update,
    errors,
    bar: (
      <UnsavedBar
        count={changes.length}
        errors={Object.keys(errors).length}
        saving={save.isPending}
        failed={failed}
        savedNote={savedNote}
        onDiscard={() => {
          setDraft(null);
          save.reset();
        }}
        onSave={() => save.mutate()}
      />
    ),
  };
}

export function Toggle({ id, label, hint, checked, onChange }: { id: string; label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-start gap-3">
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-1 disabled:cursor-not-allowed" />
      <label htmlFor={id} className="flex flex-col">
        <span className="text-[13px] font-medium">{label}</span>
        {hint ? <span className="t-aux">{hint}</span> : null}
      </label>
    </div>
  );
}
