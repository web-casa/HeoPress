// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import {
  AlertTriangle,
  BookOpen,
  Check,
  Copy,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import i18n from 'i18next';
import { useTranslation } from 'react-i18next';
import { useNavigate } from '@tanstack/react-router';
import {
  useCallback,
  useId,
  useMemo,
  useState,
  type ChangeEvent,
  type ReactNode,
} from 'react';
import { z } from 'zod';
import {
  accountSchema,
  evaluatePasswordRules,
  PASSWORD_MIN_LENGTH,
  type AccountFormValues,
} from './schemas/account';
import {
  adminPathSchema,
  normalizeAdminPath,
  type AdminPathFormValues,
} from './schemas/admin-path';
import {
  lockoutPolicySchema,
  POLICY_PRESETS,
  type LockoutPolicyFormValues,
  type PolicyPresetId,
} from './schemas/policy';
import {
  projectConfigurationSchema,
  type ProjectConfigurationFormValues,
} from './schemas/project';
import { SETUP_TOKEN_STORAGE_KEY } from './setup-state-gate';
import { useSetupStore } from './setup-store';
import {
  getAccountDraft,
  setAccountDraft,
} from './steps/step-account';
import {
  getPathDraft,
  setPathDraft,
} from './steps/step-path';
import {
  getPolicyDraft,
  inferActivePreset,
  setPolicyDraft,
} from './steps/step-security';
import {
  getProjectDraft,
  setProjectDraft,
} from './steps/step-project';
import { wordlistGenerateUnique } from './wordlist';
import { publicFetch } from '@/lib/http';

type SimpleStep = 'essentials' | 'review' | 'recovery';

type InviteRole = 'admin' | 'member';

interface InviteDraft {
  email: string;
  role: InviteRole;
}

interface SimpleSetupDraft {
  account: AccountFormValues;
  path: AdminPathFormValues;
  project: ProjectConfigurationFormValues;
}

/**
 * Documentation links surfaced from the wizard. The base intro page and a
 * security-presets guide. Mirrors the hardcoded `https://docs.heopress.example/*`
 * pattern already used in `apps/studio/src/lib/release-updates.ts`. If/when a
 * docs route is added in-app these can point there instead.
 */
const DOCS_BASE_URL = 'https://docs.heopress.example';
const DOCS_SECURITY_URL = 'https://docs.heopress.example/setup/security-presets';
const DOCS_USERS_URL = 'https://docs.heopress.example/setup/users';

interface SetupCompleteResponse {
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
  };
  adminPath: string;
  backupCodes: string[];
  setupToken: null;
  invitedCount?: number;
}

interface FieldErrors {
  email?: string;
  password?: string;
  confirmPassword?: string;
  firstName?: string;
  lastName?: string;
  adminPath?: string;
}

/** Password rules in display order; labels live under `setup:wizard.passwordRules.*`. */
const PASSWORD_RULES = ['length', 'lowercase', 'uppercase', 'digit', 'special'] as const;

const SIMPLE_STEPS: Array<{ id: SimpleStep }> = [
  { id: 'essentials' },
  { id: 'review' },
  { id: 'recovery' },
];

const DEFAULT_ACCOUNT = {
  email: '',
  password: '',
  confirmPassword: '',
  firstName: '',
  lastName: '',
};

const DEFAULT_PROJECT = {
  defaultLanguage: 'en',
  siteUrl: 'http://localhost:2026',
  displayTitle: 'HeoPress',
  theme: null,
};

export function SimpleSetupWizard() {
  const { t } = useTranslation('setup');
  const navigate = useNavigate();
  const [step, setStep] = useState<SimpleStep>('essentials');
  const [account, setAccount] = useState(() => getAccountDraft() ?? DEFAULT_ACCOUNT);
  const [adminPath, setAdminPath] = useState(
    () => getPathDraft()?.adminPath ?? wordlistGenerateUnique() ?? '',
  );
  const [securityPreset, setSecurityPreset] = useState<PolicyPresetId>(() => {
    const policyDraft = getPolicyDraft();
    return policyDraft ? inferActivePreset(policyDraft) ?? 'standard' : 'standard';
  });
  const [draft, setDraft] = useState<SimpleSetupDraft | null>(null);
  const [invites, setInvites] = useState<InviteDraft[]>([]);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [completion, setCompletion] = useState<SetupCompleteResponse | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const activeIndex = SIMPLE_STEPS.findIndex((item) => item.id === step);

  const validateEssentials = useCallback((): SimpleSetupDraft | null => {
    const nextErrors: FieldErrors = {};

    const accountResult = accountSchema.safeParse(account);
    if (!accountResult.success) {
      mergeZodIssues(nextErrors, accountResult.error);
    }

    const pathResult = adminPathSchema.safeParse({ adminPath });
    if (!pathResult.success) {
      nextErrors.adminPath = firstIssueMessage(pathResult.error);
    }

    const projectResult = projectConfigurationSchema.safeParse(
      getProjectDraft() ?? DEFAULT_PROJECT,
    );
    if (!projectResult.success) {
      mergeZodIssues(nextErrors, projectResult.error);
    }

    setErrors(nextErrors);
    if (!accountResult.success || !pathResult.success || !projectResult.success) {
      return null;
    }

    const nextDraft = {
      account: accountResult.data,
      path: pathResult.data,
      project: projectResult.data,
    };
    persistEssentialsDraft(nextDraft);
    setDraft(nextDraft);
    return nextDraft;
  }, [account, adminPath]);

  const handleContinue = useCallback(() => {
    const validDraft = validateEssentials();
    if (validDraft === null) return;
    setDraft(validDraft);
    setStep('review');
    setSubmitError(null);
  }, [validateEssentials]);

  const clearError = useCallback((field: keyof FieldErrors) => {
    setErrors((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  }, []);

  const handleAdvancedSetup = useCallback(() => {
    const hasAccountInput = Object.values(account).some(
      (value) => value.trim().length > 0,
    );
    if (!hasAccountInput) {
      void navigate({ to: '/setup/advance' });
      return;
    }
    const validDraft = validateEssentials();
    if (validDraft === null) return;
    void navigate({ to: '/setup/security' });
  }, [account, navigate, validateEssentials]);

  const handleComplete = useCallback(async () => {
    const validDraft = draft ?? validateEssentials();
    if (validDraft === null) {
      setStep('essentials');
      return;
    }

    let policy: LockoutPolicyFormValues;
    try {
      policy = lockoutPolicySchema.parse({
        ...POLICY_PRESETS[securityPreset],
      });
    } catch {
      setSubmitError(t('wizard.presetInvalid'));
      return;
    }

    setIsSubmitting(true);
    setSubmitError(null);
    try {
      const result = await postSetupComplete({
        account: validDraft.account,
        adminPath: validDraft.path.adminPath,
        policy,
        project: validDraft.project,
        invites: sanitizeInvites(invites),
      });

      const store = useSetupStore.getState();
      store.setAccountValid(true);
      store.setPathValid(true);
      store.setPolicyValid(true);
      store.setProjectValid(true);
      store.setAdminPath(result.adminPath);
      store.setCompleted(true);
      clearSetupToken();

      setCompletion(result);
      setStep('recovery');
    } catch (error) {
      setSubmitError(
        error instanceof Error ? error.message : t('wizard.completeFailed'),
      );
    } finally {
      setIsSubmitting(false);
    }
  }, [draft, invites, securityPreset, t, validateEssentials]);

  return (
    <div className="min-h-screen bg-bg px-4 py-8 sm:py-12">
      <main className="mx-auto w-full max-w-4xl space-y-6">
        <header className="space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="space-y-1">
              <p className="text-xs font-semibold uppercase text-brand">
                {t('wizard.eyebrow')}
              </p>
              <h1 className="t-page">
                {t('wizard.title')}
              </h1>
              <p className="max-w-2xl text-sm text-dim">
                {t('wizard.description')}
              </p>
            </div>
            <button
              type="button"
              onClick={handleAdvancedSetup}
              className="inline-flex items-center justify-center rounded-ctl border border-line bg-bg px-3 py-2 text-[13px] font-medium text-fg shadow-sm transition hover:bg-panel-2"
            >
              {t('wizard.advancedSetup')}
            </button>
          </div>
          <SimpleProgress
            activeIndex={activeIndex}
            onStepSelect={(selectedStep) => {
              if (selectedStep === 'essentials') setStep('essentials');
            }}
          />
        </header>

        <section className="rounded-ctl border bg-bg p-5 shadow-sm sm:p-6 border-line">
          {step === 'essentials' ? (
            <EssentialsStep
              account={account}
              adminPath={adminPath}
              errors={errors}
              onAccountChange={setAccount}
              onAdminPathChange={setAdminPath}
              onClearError={clearError}
              onContinue={handleContinue}
              onAdvancedSetup={handleAdvancedSetup}
            />
          ) : null}

          {step === 'review' && draft ? (
            <ReviewStep
              draft={draft}
              securityPreset={securityPreset}
              invites={invites}
              submitError={submitError}
              isSubmitting={isSubmitting}
              onBack={() => setStep('essentials')}
              onPresetChange={setSecurityPreset}
              onInvitesChange={setInvites}
              onComplete={handleComplete}
              onAdvancedSetup={() => {
                persistPolicyPreset(securityPreset);
                void navigate({ to: '/setup/security' });
              }}
            />
          ) : null}

          {step === 'recovery' && completion ? (
            <RecoveryStep completion={completion} />
          ) : null}
        </section>
      </main>
    </div>
  );
}

interface EssentialsStepProps {
  account: typeof DEFAULT_ACCOUNT;
  adminPath: string;
  errors: FieldErrors;
  onAccountChange: (value: typeof DEFAULT_ACCOUNT) => void;
  onAdminPathChange: (value: string) => void;
  onClearError: (field: keyof FieldErrors) => void;
  onContinue: () => void;
  onAdvancedSetup: () => void;
}

function EssentialsStep({
  account,
  adminPath,
  errors,
  onAccountChange,
  onAdminPathChange,
  onClearError,
  onContinue,
  onAdvancedSetup,
}: EssentialsStepProps) {
  const { t } = useTranslation('setup');
  const emailId = useId();
  const firstNameId = useId();
  const lastNameId = useId();
  const passwordId = useId();
  const confirmPasswordId = useId();
  const pathId = useId();
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  const passwordRules = useMemo(
    () => evaluatePasswordRules(account.password),
    [account.password],
  );
  const pathPreview = useMemo(() => normalizeAdminPath(adminPath), [adminPath]);

  const handleGeneratePath = useCallback(() => {
    const next = wordlistGenerateUnique();
    if (next !== null) {
      onAdminPathChange(next);
      onClearError('adminPath');
    }
  }, [onAdminPathChange, onClearError]);

  const updateAccount = useCallback(
    <K extends keyof typeof DEFAULT_ACCOUNT>(key: K) =>
      (event: ChangeEvent<HTMLInputElement>) => {
        onAccountChange({ ...account, [key]: event.target.value });
        onClearError(key);
        if (key === 'password') onClearError('confirmPassword');
      },
    [account, onAccountChange, onClearError],
  );

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h2 className="text-lg font-semibold tracking-tight">
          {t('wizard.essentials.title')}
        </h2>
        <p className="text-sm text-dim">
          {t('wizard.essentials.description')}
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id={emailId} label={t('wizard.essentials.email')} error={errors.email}>
          <input
            id={emailId}
            type="email"
            value={account.email}
            onChange={updateAccount('email')}
            className={inputClass(Boolean(errors.email))}
            autoComplete="email"
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id={firstNameId} label={t('wizard.essentials.firstName')} error={errors.firstName}>
            <input
              id={firstNameId}
              value={account.firstName}
              onChange={updateAccount('firstName')}
              className={inputClass(Boolean(errors.firstName))}
              autoComplete="given-name"
            />
          </Field>
          <Field id={lastNameId} label={t('wizard.essentials.lastName')} error={errors.lastName}>
            <input
              id={lastNameId}
              value={account.lastName}
              onChange={updateAccount('lastName')}
              className={inputClass(Boolean(errors.lastName))}
              autoComplete="family-name"
            />
          </Field>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id={passwordId} label={t('wizard.essentials.password')} error={errors.password}>
          <div className="relative">
            <input
              id={passwordId}
              type={showPassword ? 'text' : 'password'}
              value={account.password}
              onChange={updateAccount('password')}
              className={inputClass(Boolean(errors.password), 'pr-10')}
              autoComplete="new-password"
            />
            <button
              type="button"
              onClick={() => setShowPassword((value) => !value)}
              aria-label={showPassword ? t('wizard.essentials.hidePassword') : t('wizard.essentials.showPassword')}
              className="absolute inset-y-0 right-0 inline-flex w-10 items-center justify-center text-dim transition hover:text-fg"
            >
              {showPassword ? (
                <EyeOff className="h-4 w-4" aria-hidden="true" />
              ) : (
                <Eye className="h-4 w-4" aria-hidden="true" />
              )}
            </button>
          </div>
          <ul className="mt-2 grid gap-1 text-xs sm:grid-cols-2">
            {PASSWORD_RULES.map((key) => {
              const passed = passwordRules[key];
              return (
                <li
                  key={key}
                  className={`flex items-center gap-1.5 ${passed ? 'font-semibold text-ok' : 'text-dim'
                    }`}
                >
                  <Check
                    className={passed ? 'h-3.5 w-3.5 text-ok' : 'h-3.5 w-3.5 text-dim/50'}
                    aria-hidden="true"
                  />
                  <span>{t(`wizard.passwordRules.${key}`, { count: PASSWORD_MIN_LENGTH })}</span>
                </li>
              );
            })}
          </ul>
        </Field>
        <Field
          id={confirmPasswordId}
          label={t('wizard.essentials.confirmPassword')}
          error={errors.confirmPassword}
        >
          <div className="relative">
            <input
              id={confirmPasswordId}
              type={showConfirmPassword ? 'text' : 'password'}
              value={account.confirmPassword}
              onChange={updateAccount('confirmPassword')}
              className={inputClass(Boolean(errors.confirmPassword), 'pr-10')}
              autoComplete="new-password"
            />
            <button
              type="button"
              onClick={() => setShowConfirmPassword((value) => !value)}
              aria-label={showConfirmPassword ? t('wizard.essentials.hidePassword') : t('wizard.essentials.showPassword')}
              className="absolute inset-y-0 right-0 inline-flex w-10 items-center justify-center text-dim transition hover:text-fg"
            >
              {showConfirmPassword ? (
                <EyeOff className="h-4 w-4" aria-hidden="true" />
              ) : (
                <Eye className="h-4 w-4" aria-hidden="true" />
              )}
            </button>
          </div>
        </Field>
      </div>

      <Field
        id={pathId}
        label={t('wizard.essentials.adminPath')}
        error={errors.adminPath}
        helpText={t('wizard.essentials.adminPathHelp')}
      >
        <div className="flex gap-2">
          <input
            id={pathId}
            value={adminPath}
            onChange={(event) => {
              onAdminPathChange(event.target.value);
              onClearError('adminPath');
            }}
            className={inputClass(Boolean(errors.adminPath), 'font-mono')}
            autoComplete="off"
            spellCheck={false}
          />
          <button
            type="button"
            onClick={handleGeneratePath}
            className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-ctl border border-line bg-bg px-3 py-2 text-[13px] font-medium text-fg shadow-sm transition hover:bg-panel-2"
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            {t('wizard.essentials.generate')}
          </button>
        </div>
        {pathPreview ? (
          <p className="mt-1 text-xs text-dim">
            {t('wizard.essentials.preview')}{' '}
            <code className="font-mono text-fg">{pathPreview}</code>
          </p>
        ) : null}
      </Field>

      <div className="flex flex-col gap-3 pt-2 sm:flex-row sm:items-center sm:justify-between">
        <button
          type="button"
          onClick={onAdvancedSetup}
          className="text-left text-sm text-dim underline-offset-2 hover:text-fg hover:underline"
        >
          {t('wizard.essentials.continueAdvanced')}
        </button>
        <button type="button" onClick={onContinue} className={primaryButtonClass}>
          {t('wizard.essentials.review')}
        </button>
      </div>
    </div>
  );
}

interface ReviewStepProps {
  draft: SimpleSetupDraft;
  securityPreset: PolicyPresetId;
  invites: InviteDraft[];
  submitError: string | null;
  isSubmitting: boolean;
  onBack: () => void;
  onPresetChange: (preset: PolicyPresetId) => void;
  onInvitesChange: (invites: InviteDraft[]) => void;
  onComplete: () => void;
  onAdvancedSetup: () => void;
}

function ReviewStep({
  draft,
  securityPreset,
  invites,
  submitError,
  isSubmitting,
  onBack,
  onPresetChange,
  onInvitesChange,
  onComplete,
  onAdvancedSetup,
}: ReviewStepProps) {
  const preset = POLICY_PRESETS[securityPreset];
  const presetSelectId = useId();
  const { t } = useTranslation('setup');
  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h2 className="text-lg font-semibold tracking-tight">
          {t('wizard.review.title')}
        </h2>
        <p className="text-sm text-dim">
          {t('wizard.review.description')}
        </p>
      </header>

      <div className="space-y-2">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <Field
            id={presetSelectId}
            label={t('wizard.review.preset')}
            helpText={describePreset(securityPreset)}
          >
            <select
              id={presetSelectId}
              value={securityPreset}
              onChange={(event) =>
                onPresetChange(event.target.value as PolicyPresetId)
              }
              className={inputClass(false, 'sm:w-64 capitalize')}
            >
              {(['standard', 'strict', 'lenient'] as PolicyPresetId[]).map(
                (id) => (
                  <option key={id} value={id} className="capitalize">
                    {t(`wizard.presets.${id}`)}
                  </option>
                ),
              )}
            </select>
          </Field>
          <a
            href={DOCS_SECURITY_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 pb-2 text-sm text-brand underline-offset-2 hover:underline"
          >
            <BookOpen className="h-4 w-4" aria-hidden="true" />
            {t('wizard.review.presetDocs')}
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
        </div>
      </div>

      <InviteUsersSection invites={invites} onInvitesChange={onInvitesChange} />

      <section className="grid gap-4 lg:grid-cols-2">
        <ReviewGroup title={t('wizard.steps.essentials')}>
          <ReviewItem label={t('wizard.essentials.email')} value={draft.account.email} />
          <ReviewItem label={t('wizard.review.adminPath')} value={draft.path.adminPath} />
        </ReviewGroup>

        <ReviewGroup title={t('wizard.review.securityDefaults')}>
          <ReviewItem
            label={t('wizard.review.userLockout')}
            value={t('wizard.review.lockoutValue', { count: preset.userMaxFailedAttempts, duration: formatDuration(preset.userLockoutDurationSeconds) })}
          />
          <ReviewItem
            label={t('wizard.review.ipLockout')}
            value={t('wizard.review.lockoutValue', { count: preset.ipMaxFailedAttempts, duration: formatDuration(preset.ipLockoutDurationSeconds) })}
          />
          <ReviewItem
            label={t('wizard.review.detection')}
            value={[
              preset.geoAnomalyEnabled ? t('wizard.review.detectionGeo') : null,
              preset.timeAnomalyEnabled ? t('wizard.review.detectionTime') : null,
              preset.deviceAnomalyEnabled ? t('wizard.review.detectionDevice') : null,
            ]
              .filter(Boolean)
              .join(t('wizard.review.listSeparator')) || t('wizard.review.detectionNone')}
          />
          <ReviewItem
            label={t('wizard.review.notification')}
            value={preset.notifyChannels.map((channel) => t(`wizard.review.channels.${channel}`)).join(t('wizard.review.listSeparator'))}
          />
        </ReviewGroup>
      </section>

      <aside className="flex items-start gap-3 rounded-ctl border border-warn/40 bg-warn-soft p-4 text-sm text-warn">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
        <div>
          <p className="font-medium">{t('wizard.review.advancedTitle')}</p>
          <p className="mt-1">
            {t('wizard.review.advancedBody')}
          </p>
        </div>
      </aside>

      {submitError ? (
        <p role="alert" className="rounded-ctl border border-bad/40 bg-bad-soft p-3 text-sm text-bad">
          {submitError}
        </p>
      ) : null}

      <div className="flex flex-col gap-3 pt-2 sm:flex-row sm:items-center sm:justify-between">
        <button
          type="button"
          onClick={onAdvancedSetup}
          className="text-sm text-dim underline-offset-2 hover:text-fg hover:underline"
        >
          {t('wizard.review.openAdvanced')}
        </button>
        <div className="flex justify-end gap-3">
          <button type="button" onClick={onBack} className={secondaryButtonClass}>
            {t('wizard.review.back')}
          </button>
          <button
            type="button"
            onClick={onComplete}
            disabled={isSubmitting}
            className={primaryButtonClass}
          >
            {isSubmitting ? t('wizard.review.creating') : t('wizard.review.create')}
          </button>
        </div>
      </div>
    </div>
  );
}

const INVITE_ROLE_OPTIONS: ReadonlyArray<InviteRole> = ['member', 'admin'];

/**
 * Optional invite list rendered inside the review step. Each row is an email
 * + role. Invites are created as `status: 'invited'` users when setup
 * completes (see `postSetupComplete`); leaving this empty is valid. Rows with
 * an invalid or empty email are dropped on submit by `sanitizeInvites`, but we
 * surface a soft inline hint so the operator isn't surprised.
 */
function InviteUsersSection({
  invites,
  onInvitesChange,
}: {
  invites: InviteDraft[];
  onInvitesChange: (invites: InviteDraft[]) => void;
}) {
  const { t } = useTranslation('setup');
  const updateInvite = useCallback(
    (index: number, patch: Partial<InviteDraft>) => {
      onInvitesChange(
        invites.map((invite, i) =>
          i === index ? { ...invite, ...patch } : invite,
        ),
      );
    },
    [invites, onInvitesChange],
  );

  const addInvite = useCallback(() => {
    onInvitesChange([...invites, { email: '', role: 'member' }]);
  }, [invites, onInvitesChange]);

  const removeInvite = useCallback(
    (index: number) => {
      onInvitesChange(invites.filter((_, i) => i !== index));
    },
    [invites, onInvitesChange],
  );

  return (
    <section className="space-y-3 rounded-ctl border border-line p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold text-fg">
            {t('wizard.invites.title')}
          </h3>
          <p className="text-xs text-dim">
            {t('wizard.invites.description')}
          </p>
        </div>
        <a
          href={DOCS_USERS_URL}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 text-sm text-brand underline-offset-2 hover:underline"
        >
          <BookOpen className="h-4 w-4" aria-hidden="true" />
          {t('wizard.invites.docs')}
          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
        </a>
      </div>

      {invites.length > 0 ? (
        <ul className="space-y-2">
          {invites.map((invite, index) => {
            const showInvalid =
              invite.email.trim().length > 0 && !isValidEmail(invite.email);
            return (
              <li
                key={index}
                className="flex flex-col gap-2 sm:flex-row sm:items-start"
              >
                <div className="flex-1">
                  <input
                    type="email"
                    value={invite.email}
                    onChange={(event) =>
                      updateInvite(index, { email: event.target.value })
                    }
                    placeholder={t('wizard.invites.emailPlaceholder')}
                    aria-label={t('wizard.invites.emailLabel', { index: index + 1 })}
                    className={inputClass(showInvalid)}
                    autoComplete="off"
                  />
                  {showInvalid ? (
                    <p className="mt-1 text-xs text-bad">
                      {t('wizard.invites.emailInvalid')}
                    </p>
                  ) : null}
                </div>
                <select
                  value={invite.role}
                  onChange={(event) =>
                    updateInvite(index, {
                      role: event.target.value as InviteRole,
                    })
                  }
                  aria-label={t('wizard.invites.roleLabel', { index: index + 1 })}
                  className={inputClass(false, 'sm:w-36')}
                >
                  {INVITE_ROLE_OPTIONS.map((role) => (
                    <option key={role} value={role}>
                      {t(`wizard.invites.roles.${role}`)}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => removeInvite(index)}
                  aria-label={t('wizard.invites.remove', { index: index + 1 })}
                  className={secondaryButtonClass}
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      <button
        type="button"
        onClick={addInvite}
        className={secondaryButtonClass}
      >
        <Plus className="h-4 w-4" aria-hidden="true" />
        {t('wizard.invites.add')}
      </button>
    </section>
  );
}

function RecoveryStep({ completion }: { completion: SetupCompleteResponse }) {
  const { t } = useTranslation('setup');
  const [confirmed, setConfirmed] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');
  const adminUrl = buildAdminLoginUrl(completion.adminPath);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(completion.backupCodes.join('\n'));
      setCopyState('copied');
    } catch {
      setCopyState('error');
    }
  }, [completion.backupCodes]);

  const handleDownload = useCallback(() => {
    const content = completion.backupCodes.join('\n');
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    try {
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'heopress-backup-codes.txt';
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
    } finally {
      URL.revokeObjectURL(url);
    }
  }, [completion.backupCodes]);

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <div className="flex items-center gap-2 text-ok">
          <ShieldCheck className="h-5 w-5" aria-hidden="true" />
          <span className="text-sm font-medium">{t('wizard.recovery.created')}</span>
        </div>
        <h2 className="text-lg font-semibold tracking-tight">
          {t('wizard.recovery.title')}
        </h2>
        <p className="text-sm text-dim">
          {t('wizard.recovery.description')}
        </p>
      </header>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-medium text-fg">{t('wizard.recovery.codes')}</p>
          <div className="flex gap-2">
            <button type="button" onClick={handleCopy} className={secondaryButtonClass}>
              {copyState === 'copied' ? (
                <Check className="h-4 w-4 text-ok" aria-hidden="true" />
              ) : (
                <Copy className="h-4 w-4" aria-hidden="true" />
              )}
              {t('wizard.recovery.copy')}
            </button>
            <button type="button" onClick={handleDownload} className={secondaryButtonClass}>
              <Download className="h-4 w-4" aria-hidden="true" />
              {t('wizard.recovery.download')}
            </button>
          </div>
        </div>
        <ul className="grid gap-2 sm:grid-cols-2">
          {completion.backupCodes.map((code) => (
            <li key={code}>
              <code className="block rounded-ctl border border-line bg-panel-2 px-3 py-2 text-center font-mono text-sm tracking-wider break-all">
                {code}
              </code>
            </li>
          ))}
        </ul>
        {copyState === 'error' ? (
          <p role="alert" className="text-xs text-bad">
            {t('wizard.recovery.copyFailed')}
          </p>
        ) : null}
      </section>

      {completion.invitedCount && completion.invitedCount > 0 ? (
        <p className="rounded-ctl border border-ok/40 bg-ok-soft px-3 py-2 text-sm text-ok">
          {t('wizard.recovery.invited', { count: completion.invitedCount })}
        </p>
      ) : null}

      <label className="flex items-start gap-3 text-sm">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-line text-brand focus:ring-2 focus:ring-brand/30"
        />
        <span>{t('wizard.recovery.confirm')}</span>
      </label>

      <div className="flex flex-col gap-3 pt-2 sm:flex-row sm:items-center sm:justify-between">
        <code className="rounded-ctl border border-line bg-panel-2 px-3 py-2 font-mono text-sm break-all">
          {adminUrl}
        </code>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <a
            href={DOCS_BASE_URL}
            target="_blank"
            rel="noreferrer"
            className={secondaryButtonClass}
          >
            <BookOpen className="h-4 w-4" aria-hidden="true" />
            {t('wizard.recovery.docs')}
          </a>
          <a
            href={adminUrl}
            aria-disabled={!confirmed}
            className={
              confirmed
                ? primaryButtonClass
                : `${primaryButtonClass} pointer-events-none opacity-50`
            }
          >
            {t('wizard.recovery.goToLogin')}
          </a>
        </div>
      </div>
    </div>
  );
}

function SimpleProgress({
  activeIndex,
  onStepSelect,
}: {
  activeIndex: number;
  onStepSelect: (step: SimpleStep) => void;
}) {
  const { t } = useTranslation('setup');
  return (
    <ol className="grid gap-2 sm:grid-cols-3 cursor-pointer">
      {SIMPLE_STEPS.map((item, index) => {
        const done = index < activeIndex;
        const active = index === activeIndex;
        const canNavigateBack = done && activeIndex < SIMPLE_STEPS.length - 1;
        const marker = (
          <span className="flex items-center gap-2">
            <span
              className={
                done
                  ? 'inline-flex h-6 w-6 items-center justify-center rounded-full bg-brand text-xs font-semibold text-brand-fg'
                  : active
                    ? 'inline-flex h-6 w-6 items-center justify-center rounded-full border border-brand text-xs font-semibold text-brand'
                    : 'inline-flex h-6 w-6 items-center justify-center rounded-full border border-line text-xs font-semibold text-dim'
              }
            >
              {done ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : index + 1}
            </span>
            <span
              className={
                active || canNavigateBack
                  ? 'font-medium text-fg'
                  : 'text-dim'
              }
            >
              {t(`wizard.steps.${item.id}`)}
            </span>
          </span>
        );
        return (
          <li
            key={item.id}
            className={
              active
                ? 'rounded-ctl border border-brand bg-bg p-3 text-sm ring-1 ring-brand/30'
                : 'rounded-ctl border border-line bg-bg p-3 text-sm'
            }
          >
            {canNavigateBack ? (
              <button
                type="button"
                onClick={() => onStepSelect(item.id)}
                className="rounded-ctl outline-none transition hover:opacity-85 focus-visible:ring-2 focus-visible:ring-brand/30"
                aria-label={t('wizard.editStep', { step: t(`wizard.steps.${item.id}`) })}
              >
                {marker}
              </button>
            ) : (
              marker
            )}
          </li>
        );
      })}
    </ol>
  );
}

function ReviewGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-3 rounded-ctl border border-line p-4">
      <h3 className="text-sm font-semibold text-fg">{title}</h3>
      <dl className="space-y-2">{children}</dl>
    </div>
  );
}

function ReviewItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1 text-sm sm:grid-cols-[9rem_1fr]">
      <dt className="text-dim">{label}</dt>
      <dd className="font-medium text-fg break-words">{value}</dd>
    </div>
  );
}

function Field({
  id,
  label,
  error,
  helpText,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  helpText?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium text-fg">
        {label}
      </label>
      {children}
      {helpText ? (
        <p className="text-xs text-dim">{helpText}</p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-bad">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function mergeZodIssues(target: FieldErrors, error: z.ZodError): void {
  for (const issue of error.issues) {
    const key = issue.path[0];
    if (typeof key !== 'string') continue;
    if (key in target && target[key as keyof FieldErrors]) continue;
    target[key as keyof FieldErrors] = issue.message;
  }
}

function persistEssentialsDraft(draft: SimpleSetupDraft): void {
  setAccountDraft(draft.account);
  setPathDraft(draft.path);
  setProjectDraft(draft.project);

  const store = useSetupStore.getState();
  store.setAccountValid(true);
  store.setPathValid(true);
  store.setProjectValid(true);
  store.setAdminPath(draft.path.adminPath);
}

function persistPolicyPreset(preset: PolicyPresetId): void {
  const parsed = lockoutPolicySchema.parse({
    ...POLICY_PRESETS[preset],
  });
  setPolicyDraft(parsed);
  useSetupStore.getState().setPolicyValid(true);
}

function firstIssueMessage(error: z.ZodError): string {
  return error.issues[0]?.message ?? i18n.t('setup:wizard.invalidValue');
}

function describePreset(preset: PolicyPresetId): string {
  switch (preset) {
    case 'strict':
      return i18n.t('setup:wizard.presetDescriptions.strict');
    case 'lenient':
      return i18n.t('setup:wizard.presetDescriptions.lenient');
    case 'standard':
      return i18n.t('setup:wizard.presetDescriptions.standard');
  }
}

function formatDuration(seconds: number): string {
  if (seconds % 3600 === 0) return i18n.t('setup:wizard.duration.hours', { count: seconds / 3600 });
  if (seconds % 60 === 0) return i18n.t('setup:wizard.duration.minutes', { count: seconds / 60 });
  return i18n.t('setup:wizard.duration.seconds', { count: seconds });
}

function readSetupTokenForRequest(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const stored = window.sessionStorage.getItem(SETUP_TOKEN_STORAGE_KEY);
    if (stored && stored.trim().length > 0) return stored;
  } catch {
    // sessionStorage may be unavailable.
  }
  try {
    const url = new URL(window.location.href);
    const fromQuery = url.searchParams.get('token');
    if (fromQuery && fromQuery.trim().length > 0) return fromQuery;
  } catch {
    // ignore malformed URLs.
  }
  return null;
}

function clearSetupToken(): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(SETUP_TOKEN_STORAGE_KEY);
  } catch {
    // ignore
  }
}

async function postSetupComplete(body: {
  account: AccountFormValues;
  adminPath: string;
  policy: LockoutPolicyFormValues;
  project: ProjectConfigurationFormValues;
  invites: InviteDraft[];
}): Promise<SetupCompleteResponse> {
  const token = readSetupTokenForRequest();
  // Omit `invites` entirely when empty so the request matches the original
  // shape on a no-invite setup (the field is optional server-side).
  const payload = body.invites.length > 0 ? body : { ...body, invites: undefined };
  const response = await publicFetch('/api/v1/setup/complete', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(
      token === null ? payload : { ...payload, setupToken: token },
    ),
  });

  let parsed: unknown = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }

  if (response.status !== 201) {
    throw new Error(extractSetupErrorMessage(parsed, response.status));
  }

  if (!isSetupCompleteResponse(parsed)) {
    throw new Error(i18n.t('setup:wizard.badResponse'));
  }
  return parsed;
}

function extractSetupErrorMessage(body: unknown, status: number): string {
  if (typeof body === 'object' && body !== null) {
    const errors = (body as { errors?: Array<{ message?: string }> }).errors;
    const message = errors?.[0]?.message;
    if (message) return message;
  }
  return i18n.t('setup:wizard.httpFailed', { status });
}

function isSetupCompleteResponse(value: unknown): value is SetupCompleteResponse {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<SetupCompleteResponse>;
  return (
    typeof candidate.adminPath === 'string' &&
    Array.isArray(candidate.backupCodes) &&
    candidate.backupCodes.every((code) => typeof code === 'string') &&
    candidate.setupToken === null
  );
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmail(value: string): boolean {
  return EMAIL_PATTERN.test(value.trim());
}

/**
 * Reduce the wizard's invite rows to a clean payload for the API: trim +
 * lowercase emails, drop empty/invalid rows, and de-duplicate by email
 * (first occurrence wins). The server re-validates and re-de-dupes, so this
 * is purely to avoid sending obvious junk.
 */
function sanitizeInvites(invites: InviteDraft[]): InviteDraft[] {
  const seen = new Set<string>();
  const result: InviteDraft[] = [];
  for (const invite of invites) {
    const email = invite.email.trim().toLowerCase();
    if (!email || !isValidEmail(email) || seen.has(email)) continue;
    seen.add(email);
    result.push({ email, role: invite.role });
  }
  return result;
}

function buildAdminLoginUrl(adminPath: string): string {
  const normalized = adminPath.startsWith('/') ? adminPath : `/${adminPath}`;
  return `${normalized}/login`;
}

const primaryButtonClass =
  'inline-flex items-center justify-center rounded-ctl bg-brand px-4 py-2 text-sm font-medium text-brand-fg shadow-sm transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50';

const secondaryButtonClass =
  'inline-flex items-center justify-center gap-1.5 rounded-ctl border border-line bg-bg px-3 py-2 text-sm font-medium text-fg shadow-sm transition hover:bg-panel-2 disabled:cursor-not-allowed disabled:opacity-50';

function inputClass(hasError: boolean, extra = ''): string {
  const base =
    'block w-full rounded-ctl border bg-bg px-3 py-2 text-sm outline-none transition focus:ring-2 focus:ring-brand/30 border-line';
  const border = hasError
    ? 'border-bad/40 focus:border-bad/40 focus:ring-bad/30'
    : 'border-line focus:border-brand';
  return `${base} ${border} ${extra}`.trim();
}

export default SimpleSetupWizard;
