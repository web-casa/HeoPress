// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { zodResolver } from '@hookform/resolvers/zod';
import { Lock } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, type ReactNode } from 'react';
import { useForm, type Resolver, type SubmitHandler } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import {
  projectConfigurationSchema,
  normalizeSiteUrl,
  type ProjectConfigurationFormValues,
} from '../schemas/project';
import { useSetupStore } from '../setup-store';

let projectDraft: ProjectConfigurationFormValues | null = null;

export function getProjectDraft(): ProjectConfigurationFormValues | null {
  return projectDraft;
}

export function clearProjectDraft(): void {
  projectDraft = null;
}

export function setProjectDraft(value: ProjectConfigurationFormValues): void {
  projectDraft = value;
}

interface ProjectFormFields {
  defaultLanguage: string;
  siteUrl: string;
  displayTitle: string;
  theme: null;
}

export interface StepProjectProps {
  onSubmitted?: (values: ProjectConfigurationFormValues) => void;
}

export function StepProject({ onSubmitted }: StepProjectProps) {
  const { t } = useTranslation('setup');
  const setProjectValid = useSetupStore((s) => s.setProjectValid);

  const languageId = useId();
  const siteUrlId = useId();
  const titleId = useId();

  // Zod 4 input/output diverge on `theme.default(null)`; form defaults always
  // provide a full ProjectFormFields value.
  const form = useForm<ProjectFormFields>({
    resolver: zodResolver(projectConfigurationSchema) as Resolver<ProjectFormFields>,
    mode: 'onBlur',
    reValidateMode: 'onChange',
    shouldUnregister: false,
    defaultValues: projectDraft ?? {
      defaultLanguage: 'en',
      siteUrl: 'http://localhost:2026',
      displayTitle: 'HeoPress',
      theme: null,
    },
  });

  const {
    register,
    handleSubmit,
    watch,
    trigger,
    formState: { errors, isSubmitting, isValid },
  } = form;

  const watched = watch();
  const hasErrors = Boolean(
    errors.defaultLanguage || errors.siteUrl || errors.displayTitle,
  );

  const siteUrlPreview = useMemo(() => {
    if (!watched.siteUrl?.trim()) return null;
    try {
      return normalizeSiteUrl(watched.siteUrl);
    } catch {
      return null;
    }
  }, [watched.siteUrl]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void trigger();
    }, hasErrors ? 150 : 350);
    return () => window.clearTimeout(timeout);
  }, [
    hasErrors,
    watched.defaultLanguage,
    watched.displayTitle,
    watched.siteUrl,
    trigger,
  ]);

  useEffect(() => {
    if (!isValid) setProjectValid(false);
  }, [isValid, setProjectValid]);

  const onSubmit: SubmitHandler<ProjectFormFields> = useCallback(
    (values) => {
      const parsed = projectConfigurationSchema.parse(values);
      setProjectDraft(parsed);
      setProjectValid(true);
      onSubmitted?.(parsed);
    },
    [onSubmitted, setProjectValid],
  );

  return (
    <form
      noValidate
      className="space-y-6"
      onSubmit={handleSubmit(onSubmit)}
      aria-labelledby="setup-step-heading"
    >
      <header className="space-y-1">
        <h2 id="setup-step-heading" className="text-lg font-semibold tracking-tight">
          {t('steps.project.title')}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t('steps.project.description')}
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id={languageId}
          label={t('steps.project.language.label')}
          error={errors.defaultLanguage?.message}
          helpText={t('steps.project.language.help')}
        >
          <select
            id={languageId}
            className={inputClass(Boolean(errors.defaultLanguage))}
            aria-invalid={errors.defaultLanguage ? 'true' : 'false'}
            {...register('defaultLanguage')}
          >
            <option value="en">{t('steps.project.language.en')}</option>
            <option value="vi">{t('steps.project.language.vi')}</option>
            <option value="ja">{t('steps.project.language.ja')}</option>
            <option value="fr">{t('steps.project.language.fr')}</option>
            <option value="en-US">{t('steps.project.language.enUS')}</option>
          </select>
        </Field>

        <Field
          id={titleId}
          label={t('steps.project.displayTitle.label')}
          error={errors.displayTitle?.message}
          helpText={t('steps.project.displayTitle.help')}
        >
          <input
            id={titleId}
            type="text"
            className={inputClass(Boolean(errors.displayTitle))}
            aria-invalid={errors.displayTitle ? 'true' : 'false'}
            placeholder={t('steps.project.displayTitle.placeholder')}
            {...register('displayTitle')}
          />
        </Field>
      </div>

      <Field
        id={siteUrlId}
        label={t('steps.project.siteUrl.label')}
        error={errors.siteUrl?.message}
        helpText={t('steps.project.siteUrl.help')}
      >
        <input
          id={siteUrlId}
          type="url"
          inputMode="url"
          className={inputClass(Boolean(errors.siteUrl))}
          aria-invalid={errors.siteUrl ? 'true' : 'false'}
          placeholder={t('steps.project.siteUrl.placeholder')}
          {...register('siteUrl')}
        />
        {siteUrlPreview ? (
          <p className="mt-1 text-xs text-muted-foreground">
            {t('steps.project.siteUrl.preview')} <code className="font-mono text-foreground">{siteUrlPreview}</code>
          </p>
        ) : null}
      </Field>

      <section
        aria-disabled="true"
        className="rounded-md border border-border bg-muted/30 p-4 opacity-75"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-foreground">{t('steps.project.theme.title')}</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('steps.project.theme.description')}
            </p>
          </div>
          <span className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs font-medium text-muted-foreground">
            <Lock className="h-3 w-3" aria-hidden="true" />
            {t('steps.project.theme.disabled')}
          </span>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto]">
          <div className="rounded-md border border-white/70 bg-white/80 p-4 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-wide text-[#b42907]">
              {t('steps.project.theme.horizon')}
            </p>
            <p className="mt-2 text-sm font-semibold text-[#1a1c1c]">
              {t('steps.project.theme.horizonName')}
            </p>
            <p className="mt-1 text-xs text-[#5a413b]">
              {t('steps.project.theme.horizonDescription')}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="h-8 w-8 rounded-full bg-[#ff5e3a]" />
            <span className="h-8 w-8 rounded-full bg-[#f9f9f9] ring-1 ring-border" />
            <span className="h-8 w-8 rounded-full bg-[#2f3131]" />
          </div>
        </div>
      </section>

      <div className="flex items-center justify-end gap-3 pt-2">
        <button
          type="submit"
          disabled={isSubmitting || !isValid}
          className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t('steps.continue')}
        </button>
      </div>
    </form>
  );
}

interface FieldProps {
  id: string;
  label: string;
  error?: string;
  helpText?: string;
  children: ReactNode;
}

function Field({ id, label, error, helpText, children }: FieldProps) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium text-foreground">
        {label}
      </label>
      {children}
      {helpText ? (
        <p id={`${id}-help`} className="text-xs text-muted-foreground">
          {helpText}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-xs text-red-600">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function inputClass(hasError: boolean): string {
  const base =
    'block w-full rounded-md border bg-background px-3 py-2 text-sm outline-none transition focus:ring-2 focus:ring-primary/30';
  const border = hasError
    ? 'border-red-500 focus:border-red-500 focus:ring-red-500/30'
    : 'border-border focus:border-primary';
  return `${base} ${border}`;
}

export default StepProject;
