import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { StorageProfileCreateInput, StorageProfileResource } from '@heopress/contracts/schemas';
import { Check, HardDrive, Plus, Trash2, Zap } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import i18n from 'i18next';
import { useTranslation } from 'react-i18next';
import { siteFetch } from '@/lib/http';

/**
 * Storage settings of the current site (HeoPress P04 task 6.3): the storage
 * profiles a site can keep its media in, which one new uploads go to, a
 * connection test, and creating one. Secrets are write-only — the API shows
 * a mask when one is stored, and so does this page. Moving existing media
 * between profiles is an API operation (`docs/en/deployment/object-storage.md`).
 */

interface ProfilesAnswer {
  data: StorageProfileResource[];
  meta: { boundProfileId: string | null };
}

interface TestResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

const BASE = '/api/v1/storage-profiles';

/** A refused request, with its status (403: not an administrator of this site). */
class StorageApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** A request to the storage API; rejects with the API's own message. */
async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await siteFetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  if (res.status === 204) return undefined as T;
  const body = (await res.json().catch(() => null)) as { errors?: Array<{ message?: string }> } | null;
  if (!res.ok) {
    throw new StorageApiError(body?.errors?.map((e) => e.message).filter(Boolean).join(' ') || i18n.t('system:storage.errors.request', { status: res.status }), res.status);
  }
  return body as T;
}

export function StorageSettingsPage() {
  const { t } = useTranslation(['system', 'common']);
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ['storage-profiles'], queryFn: () => call<ProfilesAnswer>('') });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['storage-profiles'] });

  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [tests, setTests] = useState<Record<string, TestResult>>({});
  const [creating, setCreating] = useState(false);

  const bind = useMutation({
    mutationFn: (profileId: string | null) => call('/binding', { method: 'PUT', body: JSON.stringify({ profileId }) }),
    onSuccess: invalidate,
  });
  const remove = useMutation({ mutationFn: (id: string) => call(`/${id}`, { method: 'DELETE' }), onSuccess: invalidate });
  const test = useMutation({ mutationFn: (id: string) => call<{ data: TestResult }>(`/${id}/test`, { method: 'POST' }) });

  const run = (rowId: string, action: () => Promise<unknown>) => {
    setRowErrors(({ [rowId]: _cleared, ...rest }) => rest);
    action().catch((err: unknown) => {
      setRowErrors((prev) => ({ ...prev, [rowId]: err instanceof Error ? err.message : t('storage.errors.generic') }));
    });
  };
  const busy = bind.isPending || remove.isPending || test.isPending;

  const profiles = query.data?.data ?? [];
  const boundId = query.data?.meta.boundProfileId ?? null;
  // Storage is managed by the site's administrators only: say so, and offer
  // no form (its secret field would be filled for nothing).
  const forbidden = query.error instanceof StorageApiError && query.error.status === 403;

  return (
    <div className="mx-auto max-w-3xl space-y-8 p-6">
      <header className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-3xl font-semibold tracking-tight">{t('storage.title')}</h1>
          <p className="text-sm text-muted-foreground">
            {t('storage.description')}
          </p>
        </div>
        {query.isSuccess ? (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="inline-flex shrink-0 items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" /> {t('storage.newProfile')}
          </button>
        ) : null}
      </header>

      {creating && query.isSuccess ? (
        <CreateProfileForm
          onCancel={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            void invalidate();
          }}
        />
      ) : null}

      {query.isLoading ? (
        <p className="text-muted-foreground">{t('common:loading')}</p>
      ) : forbidden ? (
        <p role="alert" className="text-muted-foreground">
          {t('storage.forbidden')}
        </p>
      ) : query.isError ? (
        <p className="text-destructive">{t('storage.loadFailed')}</p>
      ) : (
        <ul className="space-y-2" aria-label={t('storage.profiles')}>
          <li className="rounded-md border border-border p-4" data-testid="storage-default">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                <HardDrive className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                <span className="font-medium">{t('storage.instanceDefault')}</span>
                {boundId === null ? <InUse /> : null}
              </div>
              {boundId !== null ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => run('default', () => bind.mutateAsync(null))}
                  className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
                >
                  {t('storage.useForNew')}
                </button>
              ) : null}
            </div>
            <p className="mt-1 text-sm text-muted-foreground">{t('storage.instanceDefaultBody')}</p>
            {rowErrors.default ? <RowError message={rowErrors.default} /> : null}
          </li>
          {profiles.map((p) => (
            <ProfileRow
              key={p.id}
              profile={p}
              bound={p.id === boundId}
              busy={busy}
              testResult={tests[p.id] ?? null}
              error={rowErrors[p.id] ?? null}
              onTest={() =>
                run(p.id, async () => {
                  const out = await test.mutateAsync(p.id);
                  setTests((prev) => ({ ...prev, [p.id]: out.data }));
                })
              }
              onBind={() => run(p.id, () => bind.mutateAsync(p.id))}
              onRemove={() => {
                if (window.confirm(t('storage.confirmDelete', { name: p.name }))) run(p.id, () => remove.mutateAsync(p.id));
              }}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function InUse() {
  const { t } = useTranslation('system');
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">
      <Check className="h-3 w-3" aria-hidden="true" /> {t('storage.inUse')}
    </span>
  );
}

function RowError({ message }: { message: string }) {
  return (
    <p role="alert" className="mt-2 text-sm text-destructive">
      {message}
    </p>
  );
}

function ProfileRow(props: {
  profile: StorageProfileResource;
  bound: boolean;
  busy: boolean;
  testResult: TestResult | null;
  error: string | null;
  onTest: () => void;
  onBind: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation('system');
  const { profile: p } = props;
  const details: Array<[string, string]> = [
    [t('storage.fields.driver'), p.driver === 's3' ? t('storage.driverS3') : t('storage.driverLocal')],
    ...(p.driver === 's3'
      ? ([
          [t('storage.fields.bucket'), p.bucket ?? '—'],
          [t('storage.fields.endpoint'), p.endpoint ?? 'AWS S3'],
          [t('storage.fields.region'), p.region ?? '—'],
          [t('storage.fields.accessKey'), p.accessKeyId ?? '—'],
          // The API returns a mask, never the secret; shown as it comes.
          [t('storage.fields.secretKey'), p.secretAccessKey ?? t('storage.notSet')],
        ] as Array<[string, string]>)
      : []),
    [t('storage.fields.publicAddress'), p.publicBaseUrl ?? '—'],
    [t('storage.fields.objects'), String(p.objectCount)],
  ];
  return (
    <li className="rounded-md border border-border p-4" data-testid={`storage-profile-${p.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <HardDrive className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <span className="font-medium">{p.name}</span>
          {props.bound ? <InUse /> : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={props.busy}
            onClick={props.onTest}
            className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
          >
            <Zap className="h-3.5 w-3.5" aria-hidden="true" /> {t('storage.test')}
          </button>
          {!props.bound ? (
            <button
              type="button"
              disabled={props.busy}
              onClick={props.onBind}
              className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
            >
              {t('storage.useForNew')}
            </button>
          ) : null}
          <button
            type="button"
            disabled={props.busy}
            onClick={props.onRemove}
            aria-label={t('storage.deleteNamed', { name: p.name })}
            className="rounded-md border border-border px-2 py-1.5 text-sm text-destructive hover:bg-muted disabled:opacity-50"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>
      <dl className="mt-3 grid grid-cols-[auto,1fr] gap-x-4 gap-y-1 text-sm">
        {details.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="break-all font-mono text-xs leading-5">{v}</dd>
          </div>
        ))}
      </dl>
      {props.testResult ? (
        <p role="status" className={`mt-2 text-sm ${props.testResult.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-destructive'}`}>
          {props.testResult.ok
            ? t('storage.testOk', { ms: props.testResult.latencyMs })
            : t('storage.testFailed', { error: props.testResult.error ?? t('storage.unknownError') })}
        </p>
      ) : null}
      {props.error ? <RowError message={props.error} /> : null}
    </li>
  );
}

function CreateProfileForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: () => void }) {
  const { t } = useTranslation(['system', 'common']);
  const id = useId();
  const [driver, setDriver] = useState<'local' | 's3'>('s3');
  const [form, setForm] = useState({
    name: '',
    bucket: '',
    endpoint: '',
    region: '',
    forcePathStyle: false,
    accessKeyId: '',
    secretAccessKey: '',
    publicBaseUrl: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = (k: keyof typeof form) => (v: string | boolean) => setForm((f) => ({ ...f, [k]: v }));
  const orNull = (v: string) => (v.trim() ? v.trim() : null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaving(true);
    const input: StorageProfileCreateInput = {
      name: form.name,
      driver,
      publicBaseUrl: orNull(form.publicBaseUrl),
      ...(driver === 's3'
        ? {
            bucket: orNull(form.bucket),
            endpoint: orNull(form.endpoint),
            region: orNull(form.region),
            forcePathStyle: form.forcePathStyle,
            accessKeyId: orNull(form.accessKeyId),
            secretAccessKey: form.secretAccessKey || null,
          }
        : {}),
    };
    try {
      await call('', { method: 'POST', body: JSON.stringify(input) });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('storage.errors.create'));
    } finally {
      setSaving(false);
    }
  };

  const field = (key: keyof typeof form, label: string, opts: { type?: string; placeholder?: string; hint?: string } = {}) => (
    <div className="space-y-1">
      <label htmlFor={`${id}-${key}`} className="text-sm font-medium">
        {label}
      </label>
      <input
        id={`${id}-${key}`}
        type={opts.type ?? 'text'}
        value={form[key] as string}
        placeholder={opts.placeholder}
        autoComplete={opts.type === 'password' ? 'new-password' : 'off'}
        onChange={(e) => set(key)(e.target.value)}
        className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm"
      />
      {opts.hint ? <p className="text-xs text-muted-foreground">{opts.hint}</p> : null}
    </div>
  );

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-4 rounded-md border border-border p-4" aria-label={t('storage.newProfile')}>
      <h2 className="text-lg font-semibold">{t('storage.newProfile')}</h2>
      {field('name', t('storage.fields.name'), { placeholder: t('storage.namePlaceholder') })}
      <div className="space-y-1">
        <label htmlFor={`${id}-driver`} className="text-sm font-medium">
          {t('storage.fields.driver')}
        </label>
        <select
          id={`${id}-driver`}
          value={driver}
          onChange={(e) => setDriver(e.target.value as 'local' | 's3')}
          className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
        >
          <option value="s3">{t('storage.optionS3')}</option>
          <option value="local">{t('storage.optionLocal')}</option>
        </select>
      </div>
      {driver === 's3' ? (
        <>
          {field('bucket', t('storage.fields.bucket'))}
          {field('endpoint', t('storage.fields.endpoint'), { placeholder: 'https://<account>.r2.cloudflarestorage.com', hint: t('storage.endpointHint') })}
          {field('region', t('storage.fields.region'), { placeholder: 'auto' })}
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.forcePathStyle} onChange={(e) => set('forcePathStyle')(e.target.checked)} />
            {t('storage.pathStyle')}
          </label>
          {field('accessKeyId', t('storage.fields.accessKeyId'))}
          {field('secretAccessKey', t('storage.fields.secretAccessKey'), {
            type: 'password',
            hint: t('storage.secretHint'),
          })}
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          {t('storage.localBody')}
        </p>
      )}
      {field('publicBaseUrl', t('storage.fields.publicAddress'), {
        placeholder: 'https://img.example.com',
        hint: t('storage.publicHint'),
      })}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={saving}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {saving ? t('storage.creating') : t('storage.create')}
        </button>
        <button type="button" onClick={onCancel} className="rounded-md border border-border px-4 py-2 text-sm hover:bg-muted">
          {t('common:cancel')}
        </button>
      </div>
    </form>
  );
}
