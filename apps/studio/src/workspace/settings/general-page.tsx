import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouterState } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getAdminBase } from '@/lib/admin-base';
import { getApiClient } from '@/lib/api';
import { siteKey } from '../api';
import { Field, inputClass, UnsavedBar, useLeaveGuard } from '../seo/seo-kit';
import { PageHeader } from '../ui/page-header';
import { Skeleton } from '../ui/skeleton';

/**
 * Settings › General (HeoPress P07a task 12.2; spec studio/settings "常规"): the site's name, default language and time
 * zone, checked in place; the admin entry path is shown read-only with what it does.
 */

interface SiteRow {
  name: string;
  defaultLanguage: string;
}

interface ContentSettings {
  availableLocales: string[];
  timezone: string;
  version: number;
  [key: string]: unknown;
}

interface Draft {
  name: string;
  defaultLanguage: string;
  timezone: string;
}

/** The IANA zones this browser knows (the CMS checks again); a short fallback where the list is unavailable. */
export function knownTimeZones(): string[] {
  try {
    const zones = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone');
    if (zones?.length) return zones.includes('UTC') ? zones : ['UTC', ...zones];
  } catch {
    // fall through
  }
  return ['UTC', 'Asia/Shanghai', 'Asia/Tokyo', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles'];
}

export type GeneralErrors = Partial<Record<keyof Draft, string>>;

/** Field errors, as keys of the `settings` namespace. */
export function validateGeneral(d: Draft, locales: string[], zones: string[]): GeneralErrors {
  const errors: GeneralErrors = {};
  if (!d.name.trim()) errors.name = 'general.errors.nameRequired';
  else if (d.name.length > 255) errors.name = 'general.errors.nameTooLong';
  if (!locales.includes(d.defaultLanguage)) errors.defaultLanguage = 'general.errors.language';
  if (!zones.includes(d.timezone.trim())) errors.timezone = 'general.errors.timezone';
  return errors;
}

export function GeneralPage() {
  const { t } = useTranslation('settings');
  const qc = useQueryClient();
  const { location } = useRouterState();
  const client = getApiClient();
  const site = useQuery({ queryKey: siteKey('site-row'), queryFn: async () => (await client.rawRequest<SiteRow>('/api/v1/site')).data });
  const content = useQuery({ queryKey: siteKey('content-settings'), queryFn: async () => (await client.rawRequest<ContentSettings>('/api/v1/site/content-settings')).data });
  const zones = useMemo(knownTimeZones, []);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const saved: Draft | null = site.data && content.data ? { name: site.data.name, defaultLanguage: site.data.defaultLanguage, timezone: content.data.timezone } : null;
  const value = draft ?? saved;
  const changed = draft && saved ? (Object.keys(saved) as Array<keyof Draft>).filter((k) => draft[k] !== saved[k]) : [];
  const errors = draft ? validateGeneral(draft, content.data?.availableLocales ?? [], zones) : {};
  useLeaveGuard('settings:general', changed.length > 0);

  const save = useMutation({
    mutationFn: async () => {
      if (!draft || !saved || !content.data) return;
      if (draft.name !== saved.name || draft.defaultLanguage !== saved.defaultLanguage) {
        await client.rawRequest('/api/v1/site', { method: 'PATCH', body: JSON.stringify({ name: draft.name.trim(), defaultLanguage: draft.defaultLanguage }) });
      }
      if (draft.timezone !== saved.timezone) {
        await client.rawRequest('/api/v1/site/content-settings', { method: 'PUT', body: JSON.stringify({ ...content.data, timezone: draft.timezone.trim() }) });
      }
    },
    onSuccess: async () => {
      await Promise.all([qc.invalidateQueries({ queryKey: siteKey('site-row') }), qc.invalidateQueries({ queryKey: siteKey('content-settings') })]);
      setDraft(null);
      setSavedNote(t('general.saved'));
    },
  });

  if (!value) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-1/3" />
        <Skeleton className="h-48" />
      </div>
    );
  }
  const set = (patch: Partial<Draft>) => {
    setSavedNote(null);
    setDraft({ ...value, ...patch });
  };
  const adminBase = getAdminBase(location.pathname) || '/';

  return (
    <>
      <PageHeader title={t('general.title')} description={t('general.description')} />
      <div className="flex flex-col gap-5 rounded-card border border-line bg-panel p-5">
        <Field id="general-name" label={t('general.name')} error={errors.name ? t(errors.name) : null}>
          <input id="general-name" className={inputClass} value={value.name} aria-invalid={!!errors.name} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field id="general-language" label={t('general.language')} hint={t('general.languageHint')} error={errors.defaultLanguage ? t(errors.defaultLanguage) : null}>
          <select id="general-language" className={inputClass} value={value.defaultLanguage} onChange={(e) => set({ defaultLanguage: e.target.value })}>
            {(content.data?.availableLocales ?? []).map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field
          id="general-timezone"
          label={t('general.timezone')}
          hint={t('general.timezoneHint')}
          error={errors.timezone ? t(errors.timezone, { examples: ['UTC', 'Asia/Shanghai', 'Europe/Berlin'].join(', ') }) : null}
        >
          <input id="general-timezone" list="general-timezones" className={inputClass} value={value.timezone} aria-invalid={!!errors.timezone} onChange={(e) => set({ timezone: e.target.value })} />
          <datalist id="general-timezones">
            {zones.map((z) => (
              <option key={z} value={z} />
            ))}
          </datalist>
        </Field>
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium">{t('general.adminPath')}</span>
          <code className="w-fit rounded-ctl bg-panel-2 px-2 py-1 text-[13px]">{adminBase}</code>
          <p className="t-aux">{t('general.adminPathHint')}</p>
        </div>
      </div>
      <UnsavedBar
        count={changed.length}
        errors={Object.keys(errors).length}
        saving={save.isPending}
        failed={save.error ? t('general.failed', { reason: save.error instanceof Error ? save.error.message : String(save.error) }) : null}
        savedNote={savedNote}
        onDiscard={() => {
          setDraft(null);
          save.reset();
        }}
        onSave={() => save.mutate()}
      />
    </>
  );
}
