import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LLM_TASK_TYPES, type LlmProviderCreateInput, type LlmProviderResource, type LlmTaskType } from '@heopress/contracts/schemas';
import { ArrowDown, ArrowUp, Bot, Plus, Trash2, X, Zap } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import i18n from 'i18next';
import { useTranslation } from 'react-i18next';
import { siteFetch } from '@/lib/http';
import { PageHeader } from '@/workspace/ui/page-header';

/**
 * Model settings of the current site (HeoPress P04 task 7.6): the site's
 * model providers (with the capability probe), the failover list of each
 * task type, currency and monthly budget, this month's usage, and the
 * attempts whose cost is unknown, to reconcile. Keys are write-only — the
 * API shows a mask when one is stored, and so does this page. Money is
 * entered and shown in currency units and sent as micro-units, converted
 * exactly (never through floating point). See
 * `docs/en/deployment/model-providers.md`.
 */

const BASE = '/api/v1/llm';
const MICROS = 1_000_000n;

/** A refused request, with its status (403: not an administrator of this site). */
class ModelsApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await siteFetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  if (res.status === 204) return undefined as T;
  const body = (await res.json().catch(() => null)) as { errors?: Array<{ message?: string }> } | null;
  if (!res.ok) {
    throw new ModelsApiError(body?.errors?.map((e) => e.message).filter(Boolean).join(' ') || i18n.t('system:models.errors.request', { status: res.status }), res.status);
  }
  return body as T;
}

/** "0.27" → 270000 micro-units; null when it is not a non-negative amount with at most 6 decimals. */
export function toMicros(units: string): number | null {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(units.trim());
  if (!m) return null;
  const micros = BigInt(m[1]!) * MICROS + BigInt((m[2] ?? '').padEnd(6, '0'));
  return micros <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(micros) : null;
}

/** 270000 → "0.27": exact, without trailing zeros. */
export function fromMicros(micros: number): string {
  const v = BigInt(micros);
  const sign = v < 0n ? '-' : '';
  const abs = v < 0n ? -v : v;
  const frac = (abs % MICROS).toString().padStart(6, '0').replace(/0+$/, '');
  return `${sign}${abs / MICROS}${frac ? `.${frac}` : ''}`;
}

interface RouteList {
  taskType: string;
  providers: Array<{ id: string; name: string; available: boolean }>;
}
interface Settings {
  currency: string;
  monthlyBudgetMicros: number | null;
  budgetTimezone: string;
}
interface Usage {
  period: string;
  currency: string;
  monthlyBudgetMicros: number | null;
  committedMicros: number;
  remainingMicros: number | null;
  byModel: Array<{
    source: string;
    providerId: string | null;
    instanceRef: string | null;
    name: string | null;
    model: string | null;
    attempts: number;
    settledMicros: number;
    reservedMicros: number;
    unknownCount: number;
    unknownMicros: number;
    inputTokens: number;
    outputTokens: number;
  }>;
  carriedOver: Array<{ period: string; unknownCount: number; reservedCount: number; micros: number }>;
}
interface Attempt {
  id: string;
  name: string | null;
  model: string | null;
  outcome: string;
  billing: string;
  version: number;
  reservedMicros: number;
  errorCode: string | null;
  period: string;
  createdAt: string;
}

/** A task type's name, from `system:models.tasks.<type>`. */
const taskLabel = (taskType: LlmTaskType) => i18n.t(`system:models.tasks.${taskType}`);

const button = 'rounded-ctl border border-line px-3 py-1.5 text-sm hover:bg-panel-2 disabled:opacity-50';
const primary = 'rounded-ctl bg-brand px-4 py-2 text-sm font-medium text-brand-fg hover:bg-brand/90 disabled:opacity-50';
const input = 'h-9 w-full rounded-ctl border border-line bg-bg px-3 text-sm';
const errorText = (err: unknown) => (err instanceof Error ? err.message : i18n.t('system:models.errors.generic'));

export function ModelsSettingsPage() {
  const { t } = useTranslation(['system', 'common']);
  const qc = useQueryClient();
  const providers = useQuery({ queryKey: ['llm', 'providers'], queryFn: () => call<{ data: LlmProviderResource[] }>('/providers') });
  const ready = providers.isSuccess;
  const routes = useQuery({ queryKey: ['llm', 'routes'], queryFn: () => call<{ data: RouteList[] }>('/routes'), enabled: ready });
  const settings = useQuery({ queryKey: ['llm', 'settings'], queryFn: () => call<{ data: Settings }>('/settings'), enabled: ready });
  const usage = useQuery({ queryKey: ['llm', 'usage'], queryFn: () => call<{ data: Usage }>('/usage'), enabled: ready });
  const pending = useQuery({ queryKey: ['llm', 'pending'], queryFn: () => call<{ data: Attempt[] }>('/attempts?pending=1&limit=100'), enabled: ready });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['llm'] });
  const [creating, setCreating] = useState(false);
  // Models are managed by the site's administrators only: say so, and offer no form.
  const forbidden = providers.error instanceof ModelsApiError && providers.error.status === 403;
  const currency = settings.data?.data.currency ?? '';

  return (
    <div className="space-y-10">
      <PageHeader
        title={t('models.title')}
        description={t('models.description')}
        actions={
          <>
            {ready ? (
          <button type="button" onClick={() => setCreating(true)} className={`inline-flex shrink-0 items-center gap-2 ${primary}`}>
            <Plus className="h-4 w-4" /> {t('models.newProvider')}
          </button>
        ) : null}
          </>
        }
      />

      {creating && ready && settings.isSuccess ? (
        <CreateProviderForm
          currency={currency}
          onCancel={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            refresh();
          }}
        />
      ) : null}

      {providers.isLoading ? (
        <p className="text-dim">{t('common:loading')}</p>
      ) : forbidden ? (
        <p role="alert" className="text-dim">
          {t('models.forbidden')}
        </p>
      ) : providers.isError ? (
        <p className="text-bad">{t('models.loadFailed')}</p>
      ) : (
        <>
          <ProvidersSection providers={providers.data!.data} onChanged={refresh} />
          {routes.data ? <RoutesSection providers={providers.data!.data} routes={routes.data.data} onChanged={refresh} /> : null}
          {settings.data ? <BudgetSection settings={settings.data.data} onChanged={refresh} /> : null}
          {usage.data ? <UsageSection usage={usage.data.data} /> : null}
          {pending.data ? <ReconcileSection attempts={pending.data.data} currency={currency} onChanged={refresh} /> : null}
        </>
      )}
    </div>
  );
}

// ── providers ───────────────────────────────────────────────────────────

function ProvidersSection({ providers, onChanged }: { providers: LlmProviderResource[]; onChanged: () => void }) {
  const { t } = useTranslation('system');
  const [errors, setErrors] = useState<Record<string, string>>({});
  // A probe whose result the API did not keep: the configuration changed while it ran.
  const [stale, setStale] = useState<Record<string, true>>({});
  const act = useMutation({ mutationFn: (fn: () => Promise<unknown>) => fn() });
  const run = (id: string, fn: () => Promise<unknown>) => {
    setErrors(({ [id]: _cleared, ...rest }) => rest);
    act.mutateAsync(fn).then(onChanged, (err: unknown) => setErrors((prev) => ({ ...prev, [id]: errorText(err) })));
  };
  return (
    <section className="space-y-3" aria-labelledby="models-providers">
      <h2 id="models-providers" className="t-section">
        {t('models.providers')}
      </h2>
      {providers.length === 0 ? (
        <p className="text-sm text-dim">{t('models.noProviders')}</p>
      ) : (
        <ul className="space-y-2" aria-label={t('models.providerList')}>
          {providers.map((p) => {
            // What the API holds is the truth: a result is shown only for the configuration it probed.
            const probe = p.probe;
            return (
              <li key={p.id} className="rounded-ctl border border-line p-4" data-testid={`llm-provider-${p.id}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Bot className="h-4 w-4 text-dim" aria-hidden="true" />
                    <span className="font-medium">{p.name}</span>
                    {p.disabled ? <span className="rounded-full bg-panel-2 px-2 py-0.5 text-xs">{t('models.disabled')}</span> : null}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={act.isPending || p.disabled}
                      className={`inline-flex items-center gap-1 ${button}`}
                      onClick={() =>
                        run(p.id, async () => {
                          const out = await call<{ meta: { recorded: boolean } }>(`/providers/${p.id}/probe`, { method: 'POST' });
                          setStale(({ [p.id]: _cleared, ...rest }) => (out.meta.recorded ? rest : { ...rest, [p.id]: true }));
                        })
                      }
                    >
                      <Zap className="h-3.5 w-3.5" aria-hidden="true" /> {t('models.probe')}
                    </button>
                    <button
                      type="button"
                      disabled={act.isPending}
                      className={button}
                      onClick={() => run(p.id, () => call(`/providers/${p.id}`, { method: 'PATCH', body: JSON.stringify({ disabled: !p.disabled }) }))}
                    >
                      {p.disabled ? t('models.enable') : t('models.disable')}
                    </button>
                    <button
                      type="button"
                      disabled={act.isPending}
                      aria-label={t('models.deleteNamed', { name: p.name })}
                      className={`${button} text-bad`}
                      onClick={() => {
                        if (window.confirm(t('models.confirmDelete', { name: p.name }))) {
                          run(p.id, () => call(`/providers/${p.id}`, { method: 'DELETE' }));
                        }
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </div>
                </div>
                <dl className="mt-3 grid grid-cols-[auto,1fr] gap-x-4 gap-y-1 text-sm">
                  <Detail label={t('models.fields.model')} value={p.model} />
                  <Detail label={t('models.fields.endpoint')} value={p.baseUrl} />
                  {/* The API returns a mask, never the key; shown as it comes. */}
                  <Detail label={t('models.fields.apiKey')} value={p.apiKey ?? t('models.notSet')} />
                  <Detail
                    label={t('models.fields.declared')}
                    value={[
                      p.capabilities.tools ? t('models.toolCalls') : null,
                      p.capabilities.json ? 'JSON' : null,
                      p.capabilities.maxContext ? t('models.tokens', { count: p.capabilities.maxContext }) : null,
                    ]
                      .filter(Boolean)
                      .join(', ') || t('models.nothing')}
                  />
                  <Detail
                    label={t('models.fields.price')}
                    value={
                      p.pricing.kind === 'per_1m_tokens'
                        ? t('models.pricePerTokens', {
                            input: fromMicros(p.pricing.inputMicros),
                            output: fromMicros(p.pricing.outputMicros),
                            currency: p.currency,
                          })
                        : t('models.pricePerRequest', { price: fromMicros(p.pricing.requestMicros), currency: p.currency })
                    }
                  />
                </dl>
                {probe ? (
                  <p role="status" className="mt-2 text-sm" data-testid="llm-probe">
                    {t('models.probeResult', {
                      tools: probe.tools.ok ? '✓' : `✗ (${probe.tools.error ?? t('models.failed')})`,
                      json: probe.json.ok ? '✓' : `✗ (${probe.json.error ?? t('models.failed')})`,
                    })}
                  </p>
                ) : null}
                {stale[p.id] && !probe ? (
                  <p role="status" className="mt-2 text-sm text-dim">
                    {t('models.probeStale')}
                  </p>
                ) : null}
                {errors[p.id] ? (
                  <p role="alert" className="mt-2 text-sm text-bad">
                    {errors[p.id]}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="contents">
      <dt className="text-dim">{label}</dt>
      <dd className="break-all font-mono text-xs leading-5">{value}</dd>
    </div>
  );
}

function CreateProviderForm({ currency, onCancel, onCreated }: { currency: string; onCancel: () => void; onCreated: () => void }) {
  const { t } = useTranslation(['system', 'common']);
  const id = useId();
  const [form, setForm] = useState({ name: '', baseUrl: '', model: '', apiKey: '', maxContext: '', inputPrice: '', outputPrice: '', requestPrice: '' });
  const [tools, setTools] = useState(true);
  const [json, setJson] = useState(true);
  const [pricing, setPricing] = useState<'per_1m_tokens' | 'per_request'>('per_1m_tokens');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const prices = pricing === 'per_1m_tokens' ? [toMicros(form.inputPrice), toMicros(form.outputPrice)] : [toMicros(form.requestPrice)];
    if (prices.some((p) => p === null)) {
      setError(t('models.errors.prices', { currency }));
      return;
    }
    const body: LlmProviderCreateInput = {
      kind: 'openai_compatible',
      name: form.name,
      baseUrl: form.baseUrl,
      model: form.model,
      apiKey: form.apiKey || null,
      capabilities: { tools, json, maxContext: form.maxContext.trim() ? Number(form.maxContext) : null },
      pricing: pricing === 'per_1m_tokens' ? { kind: 'per_1m_tokens', inputMicros: prices[0]!, outputMicros: prices[1]! } : { kind: 'per_request', requestMicros: prices[0]! },
      currency,
    };
    setSaving(true);
    try {
      await call('/providers', { method: 'POST', body: JSON.stringify(body) });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('models.errors.create'));
    } finally {
      setSaving(false);
    }
  };

  const field = (key: keyof typeof form, label: string, opts: { type?: string; placeholder?: string; hint?: string; inputMode?: 'decimal' | 'numeric' } = {}) => (
    <div className="space-y-1">
      <label htmlFor={`${id}-${key}`} className="text-sm font-medium">
        {label}
      </label>
      <input
        id={`${id}-${key}`}
        type={opts.type ?? 'text'}
        inputMode={opts.inputMode}
        value={form[key]}
        placeholder={opts.placeholder}
        autoComplete={opts.type === 'password' ? 'new-password' : 'off'}
        onChange={(e) => set(key)(e.target.value)}
        className={input}
      />
      {opts.hint ? <p className="text-xs text-dim">{opts.hint}</p> : null}
    </div>
  );

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-4 rounded-ctl border border-line p-4" aria-label={t('models.newModelProvider')}>
      <h2 className="t-section">{t('models.newModelProvider')}</h2>
      <p className="text-sm text-dim">{t('models.newProviderBody')}</p>
      {field('name', t('models.fields.name'), { placeholder: 'DeepSeek' })}
      {field('baseUrl', t('models.fields.apiRoot'), { placeholder: 'https://api.deepseek.com', hint: t('models.apiRootHint') })}
      {field('model', t('models.fields.model'), { placeholder: 'deepseek-flash' })}
      {field('apiKey', t('models.fields.apiKey'), { type: 'password', hint: t('models.apiKeyHint') })}
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t('models.declaredCapabilities')}</legend>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={tools} onChange={(e) => setTools(e.target.checked)} /> {t('models.toolCallsLabel')}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={json} onChange={(e) => setJson(e.target.checked)} /> {t('models.jsonOutput')}
        </label>
      </fieldset>
      {field('maxContext', t('models.fields.contextWindow'), { inputMode: 'numeric', hint: t('models.contextHint') })}
      <div className="space-y-1">
        <label htmlFor={`${id}-pricing`} className="text-sm font-medium">
          {t('models.fields.pricing')}
        </label>
        <select id={`${id}-pricing`} value={pricing} onChange={(e) => setPricing(e.target.value as typeof pricing)} className={input}>
          <option value="per_1m_tokens">{t('models.perMillion')}</option>
          <option value="per_request">{t('models.perRequest')}</option>
        </select>
      </div>
      {pricing === 'per_1m_tokens' ? (
        <>
          {field('inputPrice', t('models.fields.inputPrice', { currency }), { inputMode: 'decimal', placeholder: '2' })}
          {field('outputPrice', t('models.fields.outputPrice', { currency }), { inputMode: 'decimal', placeholder: '8' })}
        </>
      ) : (
        field('requestPrice', t('models.fields.requestPrice', { currency }), { inputMode: 'decimal' })
      )}
      {error ? (
        <p role="alert" className="text-sm text-bad">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <button type="submit" disabled={saving} className={primary}>
          {saving ? t('models.creating') : t('models.create')}
        </button>
        <button type="button" onClick={onCancel} className={button}>
          {t('common:cancel')}
        </button>
      </div>
    </form>
  );
}

// ── failover lists ──────────────────────────────────────────────────────

function RoutesSection({ providers, routes, onChanged }: { providers: LlmProviderResource[]; routes: RouteList[]; onChanged: () => void }) {
  const { t } = useTranslation('system');
  return (
    <section className="space-y-3" aria-labelledby="models-routes">
      <div className="space-y-1">
        <h2 id="models-routes" className="t-section">
          {t('models.failover')}
        </h2>
        <p className="text-sm text-dim">
          {t('models.failoverBody')}
        </p>
      </div>
      <ul className="space-y-2">
        {LLM_TASK_TYPES.map((taskType) => (
          <RouteEditor
            key={taskType}
            taskType={taskType}
            providers={providers}
            current={routes.find((r) => r.taskType === taskType)?.providers ?? []}
            onChanged={onChanged}
          />
        ))}
      </ul>
    </section>
  );
}

function RouteEditor(props: { taskType: LlmTaskType; providers: LlmProviderResource[]; current: RouteList['providers']; onChanged: () => void }) {
  const { t } = useTranslation(['system', 'common']);
  const id = useId();
  const [list, setList] = useState<Array<{ id: string; name: string }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (ids: string[]) => call('/routes', { method: 'PUT', body: JSON.stringify({ taskType: props.taskType, providerIds: ids }) }),
    onSuccess: () => {
      setList(null);
      props.onChanged();
    },
    onError: (err) => setError(errorText(err)),
  });
  const editing = list !== null;
  const shown = list ?? props.current;
  const addable = props.providers.filter((p) => !p.disabled && !shown.some((s) => s.id === p.id));
  const move = (i: number, by: number) =>
    setList((l) => {
      const next = [...(l ?? [])];
      const [item] = next.splice(i, 1);
      next.splice(i + by, 0, item!);
      return next;
    });

  return (
    <li className="rounded-ctl border border-line p-3" data-testid={`llm-route-${props.taskType}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">{taskLabel(props.taskType)}</span>
        {!editing ? (
          <button type="button" className={button} onClick={() => setList(props.current.map(({ id: pid, name }) => ({ id: pid, name })))}>
            {t('models.edit')}
          </button>
        ) : null}
      </div>
      {shown.length === 0 ? (
        <p className="mt-1 text-sm text-dim">{t('models.noList')}</p>
      ) : (
        <ol className="mt-2 space-y-1" aria-label={t('models.order', { task: taskLabel(props.taskType) })}>
          {shown.map((p, i) => (
            <li key={p.id} className="flex items-center gap-2 text-sm">
              <span className="w-5 text-dim">{i + 1}.</span>
              <span className={'available' in p && p.available === false ? 'line-through' : ''}>{p.name}</span>
              {editing ? (
                <span className="ml-auto flex gap-1">
                  <button type="button" aria-label={t('models.moveUp', { name: p.name })} disabled={i === 0} className={button} onClick={() => move(i, -1)}>
                    <ArrowUp className="h-3 w-3" aria-hidden="true" />
                  </button>
                  <button type="button" aria-label={t('models.moveDown', { name: p.name })} disabled={i === shown.length - 1} className={button} onClick={() => move(i, 1)}>
                    <ArrowDown className="h-3 w-3" aria-hidden="true" />
                  </button>
                  <button type="button" aria-label={t('models.remove', { name: p.name })} className={button} onClick={() => setList((l) => (l ?? []).filter((x) => x.id !== p.id))}>
                    <X className="h-3 w-3" aria-hidden="true" />
                  </button>
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      )}
      {editing ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {addable.length ? (
            <>
              <label htmlFor={`${id}-add`} className="sr-only">
                {t('models.addTo', { task: taskLabel(props.taskType) })}
              </label>
              <select
                id={`${id}-add`}
                value=""
                className="h-8 rounded-ctl border border-line bg-bg px-2 text-sm"
                onChange={(e) => {
                  const p = props.providers.find((x) => x.id === e.target.value);
                  if (p) setList((l) => [...(l ?? []), { id: p.id, name: p.name }]);
                }}
              >
                <option value="">{t('models.addProvider')}</option>
                {addable.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </>
          ) : null}
          <button
            type="button"
            className={primary}
            disabled={save.isPending}
            onClick={() => {
              setError(null);
              save.mutate(shown.map((p) => p.id));
            }}
          >
            {t('models.saveOrder')}
          </button>
          <button type="button" className={button} onClick={() => setList(null)}>
            {t('common:cancel')}
          </button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-sm text-bad">
          {error}
        </p>
      ) : null}
    </li>
  );
}

// ── budget and usage ────────────────────────────────────────────────────

function BudgetSection({ settings, onChanged }: { settings: Settings; onChanged: () => void }) {
  const { t } = useTranslation(['system', 'common']);
  const id = useId();
  const [currency, setCurrency] = useState(settings.currency);
  const [budget, setBudget] = useState(settings.monthlyBudgetMicros === null ? '' : fromMicros(settings.monthlyBudgetMicros));
  const [timezone, setTimezone] = useState(settings.budgetTimezone);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const save = useMutation({
    mutationFn: (body: Settings) => call('/settings', { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: () => {
      setMessage({ ok: true, text: t('models.saved') });
      onChanged();
    },
    onError: (err) => setMessage({ ok: false, text: errorText(err) }),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const micros = budget.trim() === '' ? null : toMicros(budget);
    if (budget.trim() !== '' && micros === null) {
      setMessage({ ok: false, text: t('models.errors.budget') });
      return;
    }
    save.mutate({ currency: currency.trim().toUpperCase(), monthlyBudgetMicros: micros, budgetTimezone: timezone.trim() || 'UTC' });
  };
  return (
    <section className="space-y-3" aria-labelledby="models-budget">
      <h2 id="models-budget" className="t-section">
        {t('models.budgetTitle')}
      </h2>
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-3" aria-label={t('models.budgetTitle')}>
        <div className="space-y-1">
          <label htmlFor={`${id}-currency`} className="text-sm font-medium">
            {t('models.currency')}
          </label>
          <input id={`${id}-currency`} value={currency} onChange={(e) => setCurrency(e.target.value)} className={input} />
        </div>
        <div className="space-y-1">
          <label htmlFor={`${id}-budget`} className="text-sm font-medium">
            {t('models.monthlyBudget')}
          </label>
          <input id={`${id}-budget`} inputMode="decimal" value={budget} placeholder={t('models.noBudgetPlaceholder')} onChange={(e) => setBudget(e.target.value)} className={input} />
        </div>
        <div className="space-y-1">
          <label htmlFor={`${id}-tz`} className="text-sm font-medium">
            {t('models.budgetTz')}
          </label>
          <input id={`${id}-tz`} value={timezone} onChange={(e) => setTimezone(e.target.value)} className={input} />
        </div>
        <div className="flex items-center gap-3 sm:col-span-3">
          <button type="submit" className={primary} disabled={save.isPending}>
            {t('common:save')}
          </button>
          {message ? (
            <p role={message.ok ? 'status' : 'alert'} className={`text-sm ${message.ok ? 'text-dim' : 'text-bad'}`}>
              {message.text}
            </p>
          ) : null}
        </div>
        <p className="text-xs text-dim sm:col-span-3">
          {t('models.currencyNote')}
        </p>
      </form>
    </section>
  );
}

function UsageSection({ usage }: { usage: Usage }) {
  const { t } = useTranslation('system');
  const money = (m: number) => `${fromMicros(m)} ${usage.currency}`;
  return (
    <section className="space-y-3" aria-labelledby="models-usage">
      <h2 id="models-usage" className="t-section">
        {t('models.usageIn', { period: usage.period })}
      </h2>
      <p className="text-sm" data-testid="llm-usage-summary">
        {usage.monthlyBudgetMicros !== null
          ? t('models.committedOf', {
              committed: money(usage.committedMicros),
              budget: money(usage.monthlyBudgetMicros),
              left: money(usage.remainingMicros ?? 0),
            })
          : t('models.committedNoBudget', { committed: money(usage.committedMicros) })}
      </p>
      {usage.byModel.length === 0 ? (
        <p className="text-sm text-dim">{t('models.noCalls')}</p>
      ) : (
        <table className="w-full text-sm" aria-label={t('models.usageByModel')}>
          <thead className="text-left text-dim">
            <tr>
              <th className="py-1 font-normal">{t('models.columns.providerModel')}</th>
              <th className="py-1 font-normal">{t('models.columns.attempts')}</th>
              <th className="py-1 font-normal">{t('models.columns.tokens')}</th>
              <th className="py-1 font-normal">{t('models.columns.settled')}</th>
              <th className="py-1 font-normal">{t('models.columns.unknown')}</th>
            </tr>
          </thead>
          <tbody>
            {usage.byModel.map((r) => (
              <tr key={`${r.providerId ?? r.instanceRef}:${r.name}:${r.model}`} className="border-t border-line">
                <td className="py-1">
                  {r.name ?? r.instanceRef} <span className="text-dim">{r.model}</span>
                  {r.source === 'instance' ? <span className="text-dim"> {t('models.instance')}</span> : null}
                </td>
                <td className="py-1">{r.attempts}</td>
                <td className="py-1">
                  {r.inputTokens} / {r.outputTokens}
                </td>
                <td className="py-1">{money(r.settledMicros)}</td>
                <td className="py-1">{r.unknownCount ? t('models.unknownReserved', { count: r.unknownCount, amount: money(r.unknownMicros) }) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {usage.carriedOver.length ? (
        <p className="text-sm text-dim">
          {t('models.carriedOver', { list: usage.carriedOver.map((c) => `${c.period}: ${money(c.micros)}`).join(', ') })}
        </p>
      ) : null}
    </section>
  );
}

// ── reconciliation ──────────────────────────────────────────────────────

function ReconcileSection({ attempts, currency, onChanged }: { attempts: Attempt[]; currency: string; onChanged: () => void }) {
  const { t } = useTranslation('system');
  return (
    <section className="space-y-3" aria-labelledby="models-reconcile">
      <div className="space-y-1">
        <h2 id="models-reconcile" className="t-section">
          {t('models.reconcileTitle')}
        </h2>
        <p className="text-sm text-dim">
          {t('models.reconcileBody')}
        </p>
      </div>
      {attempts.length === 0 ? (
        <p className="text-sm text-dim">{t('models.nothingToReconcile')}</p>
      ) : (
        <ul className="space-y-2" aria-label={t('models.reconcileTitle')}>
          {attempts.map((a) => (
            <ReconcileRow key={a.id} attempt={a} currency={currency} onChanged={onChanged} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ReconcileRow({ attempt: a, currency, onChanged }: { attempt: Attempt; currency: string; onChanged: () => void }) {
  const { t } = useTranslation('system');
  const id = useId();
  const [conclusion, setConclusion] = useState<'cancelled' | 'settled'>('cancelled');
  const [amount, setAmount] = useState('');
  const [evidence, setEvidence] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: unknown) => call(`/attempts/${a.id}/reconcile`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: onChanged,
    onError: (err) => setError(errorText(err)),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (conclusion === 'settled') {
      const micros = toMicros(amount);
      if (micros === null) {
        setError(t('models.errors.actualCost', { currency }));
        return;
      }
      save.mutate({ conclusion, actualMicros: micros, evidence, version: a.version });
    } else {
      save.mutate({ conclusion, evidence, version: a.version });
    }
  };
  return (
    <li className="rounded-ctl border border-line p-3" data-testid={`llm-pending-${a.id}`}>
      <p className="text-sm">
        <span className="font-medium">{a.name}</span> <span className="text-dim">{a.model}</span> ·{' '}
        {new Date(a.createdAt).toLocaleString()} · {a.errorCode ?? a.outcome} · {t('models.reserved', { amount: fromMicros(a.reservedMicros), currency })}
      </p>
      <form onSubmit={submit} className="mt-2 flex flex-wrap items-end gap-2" aria-label={t('models.reconcileNamed', { id: a.id })}>
        <div className="space-y-1">
          <label htmlFor={`${id}-c`} className="text-xs text-dim">
            {t('models.conclusion')}
          </label>
          <select id={`${id}-c`} value={conclusion} onChange={(e) => setConclusion(e.target.value as typeof conclusion)} className="h-8 rounded-ctl border border-line bg-bg px-2 text-sm">
            <option value="cancelled">{t('models.notBilled')}</option>
            <option value="settled">{t('models.billed')}</option>
          </select>
        </div>
        {conclusion === 'settled' ? (
          <div className="space-y-1">
            <label htmlFor={`${id}-a`} className="text-xs text-dim">
              {t('models.actualCost', { currency })}
            </label>
            <input id={`${id}-a`} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className="h-8 w-28 rounded-ctl border border-line bg-bg px-2 text-sm" />
          </div>
        ) : null}
        <div className="min-w-48 flex-1 space-y-1">
          <label htmlFor={`${id}-e`} className="text-xs text-dim">
            {t('models.evidence')}
          </label>
          <input id={`${id}-e`} value={evidence} placeholder={t('models.evidencePlaceholder')} onChange={(e) => setEvidence(e.target.value)} className="h-8 w-full rounded-ctl border border-line bg-bg px-2 text-sm" />
        </div>
        <button type="submit" className={button} disabled={save.isPending}>
          {t('models.reconcile')}
        </button>
      </form>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-bad">
          {error}
        </p>
      ) : null}
    </li>
  );
}
