// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { ArrowLeft, Eye, EyeOff, KeyRound, ShieldCheck } from 'lucide-react';
import i18n from 'i18next';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useForm, type SubmitHandler } from 'react-hook-form';
import { z } from 'zod';
import { joinAdminPathLogin } from '../setup/steps/step-done';
import {
  evaluatePasswordRules,
  PASSWORD_MIN_LENGTH,
  PASSWORD_SPECIAL_CHARS,
  type PasswordRuleId,
} from '../setup/schemas/account';
import { publicFetch } from '@/lib/http';

/**
 * "Backup code recovery" page — PUBLIC, pre-auth recovery UI.
 *
 * Implements Req 14.4 and design.md §5.1 (the `/recovery/*` routes under
 * `publicLayoutRoute`). This is the operator-facing counterpart to the
 * CMS endpoint built in task 10.7:
 *
 *   POST /api/v1/admin/security/recover
 *     body { email, backupCode }
 *     → 200 { data: { adminPath, oneTimeUnlockToken } }
 *     → 401 { errors: [{ code: 'INVALID_BACKUP_CODE' }] }   (generic)
 *     → 429 { errors: [{ code: 'RATE_LIMITED' }] } + Retry-After header
 *
 * ── Anti-enumeration parity with the server (Req 14.4) ───────────────
 *
 * The CMS collapses EVERY failure branch (unknown email, non-bootstrap
 * account, no matching code, internal error) into a single generic 401
 * `INVALID_BACKUP_CODE` after a uniform random delay. This page mirrors
 * that on the client: a 401 renders ONE generic message ("That email and
 * backup code didn't match…") and NEVER attributes the failure to a
 * specific field — doing otherwise would re-introduce the email-exists
 * signal the server works to suppress.
 *
 * ── On success ───────────────────────────────────────────────────────
 *
 * The 200 body carries:
 *   - `adminPath`         — the secret Studio path the operator likely
 *                           lost; we surface it prominently with a link
 *                           to `${adminPath}/login` so they can navigate
 *                           back in.
 *   - `oneTimeUnlockToken`— a 15-minute single-use credential that lets
 *                           them set a new password without exposing the
 *                           raw token in the UI.
 *
 * The login link is a PLAIN `<a href>` (NOT a TanStack `<Link>`) — same
 * rationale as `step-done.tsx`: we want a full document load so the admin
 * path guard middleware (task 4.2) and the authenticated AppShell route
 * tree engage fresh, rather than an in-memory SPA route swap that the
 * public layout doesn't know about. We reuse the exported
 * `joinAdminPathLogin` helper from the Done step so the `${adminPath}/login`
 * join logic stays in one place.
 *
 * ── Accessibility ────────────────────────────────────────────────────
 *
 *   - `useId()`-driven label/error wiring; `<label htmlFor>` per input.
 *   - `aria-invalid` + `aria-describedby` on each field for inline
 *     client-validation errors.
 *   - The server-error banner is `role="alert"` so it's announced when
 *     it appears.
 *   - A link to `/recovery/forgot-path` for operators who lost the admin
 *     path itself (not just access).
 *
 * ── i18n ─────────────────────────────────────────────────────────────
 *
 * Copy lives in the Studio `setup` namespace under `backupCode.*`
 * (zh-CN + en). The page is public and pre-auth: the language comes from
 * the locally saved choice or the browser (`src/i18n/index.ts`).
 *
 * Spec refs: requirements §14.4; design.md §5.1 (route tree), §4.7
 * (endpoint contract), §5.6 (i18n keys).
 */

// ────────────────────────────────────────────────────────────────────────
// Form schema
// ────────────────────────────────────────────────────────────────────────

/**
 * Client-side schema. We keep validation deliberately light — the server
 * is authoritative on the `XXXX-XXXX` backup-code format, so we only
 * require a non-empty string here (over-validating the shape would just
 * give an attacker a free oracle on the format). Email gets a basic RFC
 * check so an obvious typo is caught before a network round-trip.
 */
/** Built per form so its messages follow the current language. */
const backupCodeSchema = () =>
  z.object({
    email: z.string().email(i18n.t('setup:backupCode.invalidEmail')),
    backupCode: z.string().min(1, i18n.t('setup:backupCode.codeRequired')),
  });

type BackupCodeFormValues = z.infer<ReturnType<typeof backupCodeSchema>>;

const resetPasswordSchema = z
  .object({
    password: z.string(),
    confirmPassword: z.string(),
  })
  .superRefine((value, ctx) => {
    const rules = evaluatePasswordRules(value.password);
    for (const [rule, ok] of Object.entries(rules) as Array<[PasswordRuleId, boolean]>) {
      if (!ok) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: passwordRuleLabel(rule),
          path: ['password'],
          params: { rule },
        });
      }
    }
    if (value.password !== value.confirmPassword) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: i18n.t('setup:backupCode.passwordMismatch'),
        path: ['confirmPassword'],
      });
    }
  });

type ResetPasswordFormValues = z.infer<typeof resetPasswordSchema>;

// ────────────────────────────────────────────────────────────────────────
// Recovery request + result types
// ────────────────────────────────────────────────────────────────────────

/** Shape of the 200 `data` envelope from `POST /admin/security/recover`. */
export interface RecoverSuccess {
  adminPath: string;
  oneTimeUnlockToken: string;
}

/**
 * Normalized recovery error codes. Mirrors the server's error envelope
 * (`INVALID_BACKUP_CODE`, `RATE_LIMITED`) plus a `VALIDATION_ERROR` /
 * `UNKNOWN` bucket for malformed requests and unexpected responses.
 */
export type RecoverErrorCode =
  | 'INVALID_BACKUP_CODE'
  | 'RATE_LIMITED'
  | 'VALIDATION_ERROR'
  | 'UNKNOWN';

/**
 * Error subtype the mutation throws on any non-200 response. `retryAfterSeconds`
 * is populated from the `Retry-After` header on a 429 when present.
 */
export class RecoverError extends Error {
  readonly code: RecoverErrorCode;
  readonly status: number | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(
    code: RecoverErrorCode,
    message: string,
    status: number | undefined,
    retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'RecoverError';
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

class ResetPasswordError extends Error {
  readonly code: 'INVALID_RECOVERY_TOKEN' | 'RATE_LIMITED' | 'VALIDATION_ERROR' | 'UNKNOWN';
  readonly retryAfterSeconds: number | undefined;

  constructor(
    code: ResetPasswordError['code'],
    message: string,
    retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ResetPasswordError';
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Parse the `Retry-After` header into whole seconds. The header may be a
 * delta-seconds integer (the form our CMS emits) or an HTTP-date; we
 * handle the integer form and fall back to `undefined` for anything we
 * can't read as a positive number, so the UI degrades to a generic
 * "try again later" message rather than rendering NaN.
 */
export function parseRetryAfterSeconds(
  header: string | null,
): number | undefined {
  if (header === null) return undefined;
  const trimmed = header.trim();
  if (trimmed.length === 0) return undefined;
  const asInt = Number(trimmed);
  if (Number.isFinite(asInt) && asInt >= 0) {
    return Math.ceil(asInt);
  }
  // HTTP-date form: compute the delta from now. Defensive — our server
  // emits delta-seconds, but a proxy could rewrite it.
  const asDate = Date.parse(trimmed);
  if (Number.isFinite(asDate)) {
    const deltaMs = asDate - Date.now();
    return deltaMs > 0 ? Math.ceil(deltaMs / 1000) : 0;
  }
  return undefined;
}

/** Project-standard error envelope (loose — `code` may be absent). */
interface ErrorEnvelope {
  errors?: Array<{ code?: string; message?: string }>;
}

function firstErrorCode(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const envelope = body as ErrorEnvelope;
  if (!Array.isArray(envelope.errors)) return undefined;
  return envelope.errors[0]?.code;
}

/**
 * POST the recover request and map the response to a typed result.
 * Mirrors the fetch conventions in `use-complete-setup.ts`
 * (`credentials: 'same-origin'`, JSON content + accept headers).
 */
async function postRecover(
  values: BackupCodeFormValues,
): Promise<RecoverSuccess> {
  let response: Response;
  try {
    response = await publicFetch('/api/v1/admin/security/recover', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        email: values.email,
        backupCode: values.backupCode,
      }),
    });
  } catch {
    throw new RecoverError(
      'UNKNOWN',
      i18n.t('setup:backupCode.errors.network'),
      undefined,
    );
  }

  if (response.status === 200) {
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new RecoverError(
        'UNKNOWN',
        i18n.t('setup:backupCode.errors.unparsable'),
        200,
      );
    }
    const data = (parsed as { data?: Partial<RecoverSuccess> })?.data;
    if (
      !data ||
      typeof data.adminPath !== 'string' ||
      typeof data.oneTimeUnlockToken !== 'string'
    ) {
      throw new RecoverError(
        'UNKNOWN',
        i18n.t('setup:backupCode.errors.missingDetails'),
        200,
      );
    }
    return {
      adminPath: data.adminPath,
      oneTimeUnlockToken: data.oneTimeUnlockToken,
    };
  }

  // Non-200 — classify against the documented contract.
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (response.status === 401) {
    // Generic — the server already refuses to say which field was wrong.
    throw new RecoverError(
      'INVALID_BACKUP_CODE',
      i18n.t('setup:backupCode.errors.mismatch'),
      401,
    );
  }

  if (response.status === 429) {
    const retryAfter = parseRetryAfterSeconds(
      response.headers.get('Retry-After'),
    );
    throw new RecoverError(
      'RATE_LIMITED',
      i18n.t('setup:backupCode.errors.rateLimited'),
      429,
      retryAfter,
    );
  }

  if (response.status === 400) {
    throw new RecoverError(
      'VALIDATION_ERROR',
      i18n.t('setup:backupCode.errors.invalidRequest'),
      400,
    );
  }

  const code = firstErrorCode(body);
  throw new RecoverError(
    code === 'RATE_LIMITED'
      ? 'RATE_LIMITED'
      : code === 'INVALID_BACKUP_CODE'
        ? 'INVALID_BACKUP_CODE'
        : 'UNKNOWN',
    i18n.t('setup:backupCode.errors.unexpected', { status: response.status }),
    response.status,
  );
}

async function postResetPassword(args: {
  unlockToken: string;
  password: string;
}): Promise<void> {
  let response: Response;
  try {
    response = await publicFetch('/api/v1/admin/security/reset-password', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(args),
    });
  } catch {
    throw new ResetPasswordError('UNKNOWN', i18n.t('setup:backupCode.reset.network'));
  }

  if (response.status === 200) return;

  if (response.status === 401) {
    throw new ResetPasswordError(
      'INVALID_RECOVERY_TOKEN',
      i18n.t('setup:backupCode.reset.expired'),
    );
  }

  if (response.status === 429) {
    throw new ResetPasswordError(
      'RATE_LIMITED',
      i18n.t('setup:backupCode.errors.rateLimited'),
      parseRetryAfterSeconds(response.headers.get('Retry-After')),
    );
  }

  if (response.status === 400) {
    throw new ResetPasswordError(
      'VALIDATION_ERROR',
      i18n.t('setup:backupCode.reset.weak'),
    );
  }

  throw new ResetPasswordError(
    'UNKNOWN',
    i18n.t('setup:backupCode.reset.unexpected', { status: response.status }),
  );
}

// ────────────────────────────────────────────────────────────────────────
// Component
// ────────────────────────────────────────────────────────────────────────

export function BackupCodePage() {
  const { t } = useTranslation('setup');
  const emailId = useId();
  const codeId = useId();
  const bannerId = useId();

  const form = useForm<BackupCodeFormValues>({
    resolver: zodResolver(backupCodeSchema()),
    mode: 'onBlur',
    reValidateMode: 'onChange',
    defaultValues: { email: '', backupCode: '' },
  });

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = form;

  const mutation = useMutation<RecoverSuccess, RecoverError, BackupCodeFormValues>(
    {
      mutationKey: ['recovery', 'backup-code'],
      mutationFn: postRecover,
      retry: false,
    },
  );

  const onSubmit: SubmitHandler<BackupCodeFormValues> = (values) => {
    mutation.mutate(values);
  };

  // On success, swap the form out for a success panel that surfaces the
  // recovered admin path + unlock token.
  if (mutation.isSuccess) {
    return <RecoverySuccessPanel result={mutation.data} />;
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 px-4 py-12">
      <div className="w-full max-w-md rounded-xl border bg-background p-8 shadow-sm">
        <form noValidate className="space-y-6" onSubmit={handleSubmit(onSubmit)}>
          <BackButton />

          <header className="space-y-2">
            <div className="flex items-center gap-2">
              <KeyRound className="h-5 w-5 text-primary" aria-hidden="true" />
              <h1 className="text-lg font-semibold tracking-tight">
                {t('backupCode.title')}
              </h1>
            </div>
            <p className="text-sm text-muted-foreground">
              {t('backupCode.intro')}
            </p>
          </header>

          {/* ── Server error banner (generic, anti-enumeration) ──────── */}
          {mutation.isError ? (
            <ServerErrorBanner id={bannerId} error={mutation.error} />
          ) : null}

          {/* ── Email ────────────────────────────────────────────────── */}
          <Field id={emailId} label={t('backupCode.email')} error={errors.email?.message}>
            <input
              id={emailId}
              type="email"
              inputMode="email"
              autoComplete="username"
              spellCheck={false}
              aria-invalid={errors.email ? 'true' : 'false'}
              aria-describedby={errors.email ? `${emailId}-error` : undefined}
              className={inputClass(Boolean(errors.email))}
              {...register('email')}
            />
          </Field>

          {/* ── Backup code ──────────────────────────────────────────── */}
          <Field id={codeId} label={t('backupCode.code')} error={errors.backupCode?.message}>
            <input
              id={codeId}
              type="text"
              inputMode="text"
              autoComplete="one-time-code"
              spellCheck={false}
              placeholder={t('backupCode.codePlaceholder')}
              aria-invalid={errors.backupCode ? 'true' : 'false'}
              aria-describedby={errors.backupCode ? `${codeId}-error` : undefined}
              className={`${inputClass(Boolean(errors.backupCode))} font-mono tracking-wider`}
              {...register('backupCode')}
            />
          </Field>

          {/* ── Submit ───────────────────────────────────────────────── */}
          <button
            type="submit"
            disabled={isSubmitting || mutation.isPending}
            className="inline-flex w-full items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {mutation.isPending ? t('backupCode.checking') : t('backupCode.submit')}
          </button>

          {/* ── Lost-the-path link ───────────────────────────────────── */}
          <p className="text-center text-sm text-muted-foreground">
            {t('backupCode.lostPath')}{' '}
            <a
              href="forgot-path"
              className="font-medium text-primary underline-offset-2 hover:underline"
            >
              {t('backupCode.lostPathLink')}
            </a>
            {t('backupCode.sentenceEnd')}
          </p>
        </form>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Sub-components
// ────────────────────────────────────────────────────────────────────────

interface ServerErrorBannerProps {
  id: string;
  error: RecoverError;
}

/**
 * Top-of-form error banner. Renders generic copy keyed off the
 * normalized error `code`:
 *
 *   - INVALID_BACKUP_CODE → generic "email and code didn't match" (never
 *     attributes the failure to a single field — anti-enumeration).
 *   - RATE_LIMITED        → "too many attempts" + the wait when the
 *     `Retry-After` header was present.
 *   - everything else     → a neutral try-again message.
 */
function ServerErrorBanner({ id, error }: ServerErrorBannerProps) {
  const { t } = useTranslation('setup');
  let message: string;
  switch (error.code) {
    case 'INVALID_BACKUP_CODE':
      message = t('backupCode.banner.mismatch');
      break;
    case 'RATE_LIMITED':
      message =
        error.retryAfterSeconds !== undefined
          ? t('backupCode.banner.rateLimitedWait', { wait: formatWait(error.retryAfterSeconds) })
          : t('backupCode.banner.rateLimited');
      break;
    default:
      message = t('backupCode.banner.generic');
      break;
  }

  return (
    <div
      id={id}
      role="alert"
      className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-700/60 dark:bg-red-950/40 dark:text-red-200"
    >
      {message}
    </div>
  );
}

interface RecoverySuccessPanelProps {
  result: RecoverSuccess;
}

/**
 * Success panel shown after a 200 response. Surfaces the recovered admin
 * path prominently with a full-navigation link to `${adminPath}/login`,
 * plus the one-time unlock token (with a note on its 15-minute,
 * single-use nature).
 */
function RecoverySuccessPanel({ result }: RecoverySuccessPanelProps) {
  const { t } = useTranslation('setup');
  const loginHref = joinAdminPathLogin(result.adminPath);
  const passwordId = useId();
  const confirmId = useId();
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  const form = useForm<ResetPasswordFormValues>({
    resolver: zodResolver(resetPasswordSchema),
    mode: 'onBlur',
    reValidateMode: 'onChange',
    defaultValues: { password: '', confirmPassword: '' },
  });

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = form;

  const resetMutation = useMutation<void, ResetPasswordError, ResetPasswordFormValues>({
    mutationKey: ['recovery', 'reset-password'],
    mutationFn: (values) =>
      postResetPassword({
        unlockToken: result.oneTimeUnlockToken,
        password: values.password,
      }),
    retry: false,
  });

  const passwordRules = evaluatePasswordRules(watch('password') ?? '');

  const onResetSubmit: SubmitHandler<ResetPasswordFormValues> = (values) => {
    resetMutation.mutate(values);
  };

  if (resetMutation.isSuccess) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted/30 px-4 py-12">
        <div className="w-full max-w-md space-y-6 rounded-xl border bg-background p-8 shadow-sm">
          <BackButton />

          <header className="space-y-2">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-emerald-600" aria-hidden="true" />
              <h1 className="text-lg font-semibold tracking-tight">
                {t('backupCode.reset.doneTitle')}
              </h1>
            </div>
            <p className="text-sm text-muted-foreground" aria-live="polite">
              {t('backupCode.reset.doneBody')}
            </p>
          </header>

          {loginHref ? (
            <a
              href={loginHref}
              className="inline-flex w-full items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90"
            >
              {t('backupCode.goToLogin')}
            </a>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 px-4 py-12">
      <div className="w-full max-w-md space-y-6 rounded-xl border bg-background p-8 shadow-sm">
        <BackButton />

        <header className="space-y-2">
          <div className="flex items-center gap-2">
            <ShieldCheck
              className="h-5 w-5 text-emerald-600"
              aria-hidden="true"
            />
            <h1 className="text-lg font-semibold tracking-tight">
              {t('backupCode.successTitle')}
            </h1>
          </div>
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {t('backupCode.successBody')}
          </p>
        </header>

        {/* ── Admin path ─────────────────────────────────────────────── */}
        <section className="space-y-2">
          <p className="text-sm font-medium text-foreground">{t('backupCode.adminPath')}</p>
          <code className="block break-all rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-sm">
            {result.adminPath}
          </code>
        </section>

        <form noValidate className="space-y-4" onSubmit={handleSubmit(onResetSubmit)}>
          {resetMutation.isError ? (
            <div
              role="alert"
              className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800"
            >
              {resetMutation.error.code === 'RATE_LIMITED' &&
              resetMutation.error.retryAfterSeconds !== undefined
                ? t('backupCode.banner.rateLimitedWait', {
                  wait: formatWait(resetMutation.error.retryAfterSeconds),
                })
                : resetMutation.error.message}
            </div>
          ) : null}

          <Field id={passwordId} label={t('backupCode.reset.newPassword')} error={errors.password?.message}>
            <div className="relative">
              <input
                id={passwordId}
                type={showPassword ? 'text' : 'password'}
                autoComplete="new-password"
                aria-invalid={errors.password ? 'true' : 'false'}
                className={`${inputClass(Boolean(errors.password))} pr-10`}
                {...register('password')}
              />
              <PasswordVisibilityButton
                pressed={showPassword}
                onClick={() => setShowPassword((value) => !value)}
                label={showPassword ? t('backupCode.reset.hideNew') : t('backupCode.reset.showNew')}
              />
            </div>
          </Field>

          <PasswordRules rules={passwordRules} />

          <Field
            id={confirmId}
            label={t('backupCode.reset.confirmPassword')}
            error={errors.confirmPassword?.message}
          >
            <div className="relative">
              <input
                id={confirmId}
                type={showConfirmPassword ? 'text' : 'password'}
                autoComplete="new-password"
                aria-invalid={errors.confirmPassword ? 'true' : 'false'}
                className={`${inputClass(Boolean(errors.confirmPassword))} pr-10`}
                {...register('confirmPassword')}
              />
              <PasswordVisibilityButton
                pressed={showConfirmPassword}
                onClick={() => setShowConfirmPassword((value) => !value)}
                label={
                  showConfirmPassword
                    ? t('backupCode.reset.hideConfirm')
                    : t('backupCode.reset.showConfirm')
                }
              />
            </div>
          </Field>

          <button
            type="submit"
            disabled={isSubmitting || resetMutation.isPending}
            className="inline-flex w-full items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {resetMutation.isPending ? t('backupCode.reset.updating') : t('backupCode.reset.submit')}
          </button>
        </form>

        {/*
          Plain anchor — NOT a TanStack <Link>. A full document load lets
          the admin path guard (task 4.2) and the authenticated AppShell
          route tree pick the request up fresh; an in-memory SPA swap
          would land on a route the public layout can't serve.
        */}
        {loginHref ? (
          <a
            href={loginHref}
            className="inline-flex w-full items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90"
          >
            {t('backupCode.goToLogin')}
          </a>
        ) : (
          <p role="alert" className="text-sm text-red-600">
            {t('backupCode.invalidPath')}
          </p>
        )}
      </div>
    </div>
  );
}

function passwordRuleLabel(rule: PasswordRuleId): string {
  switch (rule) {
    case 'length':
      return i18n.t('setup:backupCode.rules.length', { count: PASSWORD_MIN_LENGTH });
    case 'lowercase':
      return i18n.t('setup:backupCode.rules.lowercase');
    case 'uppercase':
      return i18n.t('setup:backupCode.rules.uppercase');
    case 'digit':
      return i18n.t('setup:backupCode.rules.digit');
    case 'special':
      return i18n.t('setup:backupCode.rules.special', { chars: [...PASSWORD_SPECIAL_CHARS].join(' ') });
  }
}

function PasswordRules({ rules }: { rules: Record<PasswordRuleId, boolean> }) {
  const { t } = useTranslation('setup');
  return (
    <ul className="space-y-1 text-xs text-muted-foreground">
      {(Object.keys(rules) as PasswordRuleId[]).map((rule) => (
        <li
          key={rule}
          className={rules[rule] ? 'text-emerald-700' : 'text-muted-foreground'}
        >
          {rules[rule] ? t('backupCode.rules.met') : t('backupCode.rules.notMet')}
          {passwordRuleLabel(rule)}
        </li>
      ))}
    </ul>
  );
}

function BackButton() {
  const { t } = useTranslation('setup');
  return (
    <button
      type="button"
      onClick={() => window.history.back()}
      className="inline-flex items-center gap-2 text-sm font-medium text-muted-foreground transition hover:text-foreground"
    >
      <ArrowLeft className="h-4 w-4" aria-hidden="true" />
      {t('backupCode.back')}
    </button>
  );
}

function PasswordVisibilityButton({
  pressed,
  onClick,
  label,
}: {
  pressed: boolean;
  onClick: () => void;
  label: string;
}) {
  const Icon = pressed ? EyeOff : Eye;
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      onClick={onClick}
      className="absolute right-2 top-1/2 inline-flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground"
    >
      <Icon className="h-4 w-4" aria-hidden="true" />
    </button>
  );
}

interface FieldProps {
  id: string;
  label: string;
  error?: string;
  children: React.ReactNode;
}

/**
 * Label + inline error wrapper. Owns the `<label htmlFor>` linkage so
 * each input gets a clickable label and a stable `role="alert"` error
 * region the screen reader can announce.
 */
function Field({ id, label, error, children }: FieldProps) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium text-foreground">
        {label}
      </label>
      {children}
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-xs text-red-600">
          {error}
        </p>
      ) : null}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

/**
 * Render a wait duration in human-friendly units. Pure + exported for
 * unit tests.
 */
export function formatWait(seconds: number): string {
  if (seconds < 60) {
    const s = Math.max(1, Math.ceil(seconds));
    return i18n.t('setup:backupCode.wait.seconds', { count: s });
  }
  const minutes = Math.ceil(seconds / 60);
  return i18n.t('setup:backupCode.wait.minutes', { count: minutes });
}

function inputClass(hasError: boolean, extra = ''): string {
  const base =
    'block w-full rounded-md border bg-background px-3 py-2 text-sm outline-none transition focus:ring-2 focus:ring-primary/30';
  const border = hasError
    ? 'border-red-500 focus:border-red-500 focus:ring-red-500/30'
    : 'border-border focus:border-primary';
  return `${base} ${border} ${extra}`.trim();
}

export default BackupCodePage;
