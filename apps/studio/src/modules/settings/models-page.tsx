import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LLM_TASK_TYPES, type LlmProviderCreateInput, type LlmProviderResource, type LlmTaskType } from '@heopress/contracts/schemas';
import { ArrowDown, ArrowUp, Bot, Plus, Trash2, X, Zap } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { siteFetch } from '@/lib/http';

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
    throw new ModelsApiError(body?.errors?.map((e) => e.message).filter(Boolean).join(' ') || `Request failed (${res.status}).`, res.status);
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

const TASK_LABELS: Record<LlmTaskType, string> = {
  default: 'Default (any task without its own list)',
  chat: 'Chat (Copilot)',
  generation: 'Generation',
  translation: 'Translation',
  intent: 'Intent',
  constitution: 'Constitution',
  decision: 'Decision',
};

const button = 'rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50';
const primary = 'rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50';
const input = 'h-9 w-full rounded-md border border-border bg-background px-3 text-sm';
const errorText = (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong.');

export function ModelsSettingsPage() {
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
    <div className="mx-auto max-w-4xl space-y-10 p-6">
      <header className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-3xl font-semibold tracking-tight">Models</h1>
          <p className="text-sm text-muted-foreground">
            The AI models this site uses, the order they are tried in for each task, and what they cost. A site without
            its own providers uses the instance default.
          </p>
        </div>
        {ready ? (
          <button type="button" onClick={() => setCreating(true)} className={`inline-flex shrink-0 items-center gap-2 ${primary}`}>
            <Plus className="h-4 w-4" /> New provider
          </button>
        ) : null}
      </header>

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
        <p className="text-muted-foreground">Loading…</p>
      ) : forbidden ? (
        <p role="alert" className="text-muted-foreground">
          Only administrators of this site can manage its models.
        </p>
      ) : providers.isError ? (
        <p className="text-destructive">Failed to load the model providers.</p>
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
      <h2 id="models-providers" className="text-xl font-semibold">
        Providers
      </h2>
      {providers.length === 0 ? (
        <p className="text-sm text-muted-foreground">No providers yet: every task uses the instance default.</p>
      ) : (
        <ul className="space-y-2" aria-label="Model providers">
          {providers.map((p) => {
            // What the API holds is the truth: a result is shown only for the configuration it probed.
            const probe = p.probe;
            return (
              <li key={p.id} className="rounded-md border border-border p-4" data-testid={`llm-provider-${p.id}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Bot className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                    <span className="font-medium">{p.name}</span>
                    {p.disabled ? <span className="rounded-full bg-muted px-2 py-0.5 text-xs">Disabled</span> : null}
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
                      <Zap className="h-3.5 w-3.5" aria-hidden="true" /> Probe
                    </button>
                    <button
                      type="button"
                      disabled={act.isPending}
                      className={button}
                      onClick={() => run(p.id, () => call(`/providers/${p.id}`, { method: 'PATCH', body: JSON.stringify({ disabled: !p.disabled }) }))}
                    >
                      {p.disabled ? 'Enable' : 'Disable'}
                    </button>
                    <button
                      type="button"
                      disabled={act.isPending}
                      aria-label={`Delete ${p.name}`}
                      className={`${button} text-destructive`}
                      onClick={() => {
                        if (window.confirm(`Delete the model provider “${p.name}”? Its usage stays in the ledger.`)) {
                          run(p.id, () => call(`/providers/${p.id}`, { method: 'DELETE' }));
                        }
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </div>
                </div>
                <dl className="mt-3 grid grid-cols-[auto,1fr] gap-x-4 gap-y-1 text-sm">
                  <Detail label="Model" value={p.model} />
                  <Detail label="Endpoint" value={p.baseUrl} />
                  {/* The API returns a mask, never the key; shown as it comes. */}
                  <Detail label="API key" value={p.apiKey ?? 'Not set'} />
                  <Detail
                    label="Declared"
                    value={[p.capabilities.tools ? 'tool calls' : null, p.capabilities.json ? 'JSON' : null, p.capabilities.maxContext ? `${p.capabilities.maxContext} tokens` : null]
                      .filter(Boolean)
                      .join(', ') || 'nothing'}
                  />
                  <Detail
                    label="Price"
                    value={
                      p.pricing.kind === 'per_1m_tokens'
                        ? `${fromMicros(p.pricing.inputMicros)} in / ${fromMicros(p.pricing.outputMicros)} out ${p.currency} per 1M tokens`
                        : `${fromMicros(p.pricing.requestMicros)} ${p.currency} per request`
                    }
                  />
                </dl>
                {probe ? (
                  <p role="status" className="mt-2 text-sm" data-testid="llm-probe">
                    Probe: tool calls {probe.tools.ok ? '✓' : `✗ (${probe.tools.error ?? 'failed'})`} · JSON{' '}
                    {probe.json.ok ? '✓' : `✗ (${probe.json.error ?? 'failed'})`}
                  </p>
                ) : null}
                {stale[p.id] && !probe ? (
                  <p role="status" className="mt-2 text-sm text-muted-foreground">
                    The provider changed while it was being probed: probe it again.
                  </p>
                ) : null}
                {errors[p.id] ? (
                  <p role="alert" className="mt-2 text-sm text-destructive">
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
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="break-all font-mono text-xs leading-5">{value}</dd>
    </div>
  );
}

function CreateProviderForm({ currency, onCancel, onCreated }: { currency: string; onCancel: () => void; onCreated: () => void }) {
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
      setError(`Prices are required: an amount in ${currency} with at most 6 decimals (0 for free).`);
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
      setError(err instanceof Error ? err.message : 'The provider could not be created.');
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
      {opts.hint ? <p className="text-xs text-muted-foreground">{opts.hint}</p> : null}
    </div>
  );

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-4 rounded-md border border-border p-4" aria-label="New model provider">
      <h2 className="text-lg font-semibold">New model provider</h2>
      <p className="text-sm text-muted-foreground">An OpenAI-compatible service: DeepSeek, Qwen, Kimi, GLM, or any other with a /chat/completions endpoint.</p>
      {field('name', 'Name', { placeholder: 'DeepSeek' })}
      {field('baseUrl', 'API root', { placeholder: 'https://api.deepseek.com', hint: 'Without /chat/completions, credentials or a query string.' })}
      {field('model', 'Model', { placeholder: 'deepseek-flash' })}
      {field('apiKey', 'API key', { type: 'password', hint: 'Stored encrypted. It is never shown again — only a mask.' })}
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Declared capabilities</legend>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={tools} onChange={(e) => setTools(e.target.checked)} /> Tool calls
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={json} onChange={(e) => setJson(e.target.checked)} /> JSON output
        </label>
      </fieldset>
      {field('maxContext', 'Context window (tokens)', { inputMode: 'numeric', hint: 'Optional, declared only.' })}
      <div className="space-y-1">
        <label htmlFor={`${id}-pricing`} className="text-sm font-medium">
          Pricing
        </label>
        <select id={`${id}-pricing`} value={pricing} onChange={(e) => setPricing(e.target.value as typeof pricing)} className={input}>
          <option value="per_1m_tokens">Per million tokens</option>
          <option value="per_request">Per request</option>
        </select>
      </div>
      {pricing === 'per_1m_tokens' ? (
        <>
          {field('inputPrice', `Input price (${currency} per 1M tokens)`, { inputMode: 'decimal', placeholder: '2' })}
          {field('outputPrice', `Output price (${currency} per 1M tokens)`, { inputMode: 'decimal', placeholder: '8' })}
        </>
      ) : (
        field('requestPrice', `Price per request (${currency})`, { inputMode: 'decimal' })
      )}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <button type="submit" disabled={saving} className={primary}>
          {saving ? 'Creating…' : 'Create'}
        </button>
        <button type="button" onClick={onCancel} className={button}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// ── failover lists ──────────────────────────────────────────────────────

function RoutesSection({ providers, routes, onChanged }: { providers: LlmProviderResource[]; routes: RouteList[]; onChanged: () => void }) {
  return (
    <section className="space-y-3" aria-labelledby="models-routes">
      <div className="space-y-1">
        <h2 id="models-routes" className="text-xl font-semibold">
          Failover order
        </h2>
        <p className="text-sm text-muted-foreground">
          For each task, the providers to try in order: the first is the primary, the others are backups. A task without
          a list uses the default list, then the instance default.
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
    <li className="rounded-md border border-border p-3" data-testid={`llm-route-${props.taskType}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">{TASK_LABELS[props.taskType]}</span>
        {!editing ? (
          <button type="button" className={button} onClick={() => setList(props.current.map(({ id: pid, name }) => ({ id: pid, name })))}>
            Edit
          </button>
        ) : null}
      </div>
      {shown.length === 0 ? (
        <p className="mt-1 text-sm text-muted-foreground">No list</p>
      ) : (
        <ol className="mt-2 space-y-1" aria-label={`${TASK_LABELS[props.taskType]} order`}>
          {shown.map((p, i) => (
            <li key={p.id} className="flex items-center gap-2 text-sm">
              <span className="w-5 text-muted-foreground">{i + 1}.</span>
              <span className={'available' in p && p.available === false ? 'line-through' : ''}>{p.name}</span>
              {editing ? (
                <span className="ml-auto flex gap-1">
                  <button type="button" aria-label={`Move ${p.name} up`} disabled={i === 0} className={button} onClick={() => move(i, -1)}>
                    <ArrowUp className="h-3 w-3" aria-hidden="true" />
                  </button>
                  <button type="button" aria-label={`Move ${p.name} down`} disabled={i === shown.length - 1} className={button} onClick={() => move(i, 1)}>
                    <ArrowDown className="h-3 w-3" aria-hidden="true" />
                  </button>
                  <button type="button" aria-label={`Remove ${p.name}`} className={button} onClick={() => setList((l) => (l ?? []).filter((x) => x.id !== p.id))}>
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
                Add a provider to {TASK_LABELS[props.taskType]}
              </label>
              <select
                id={`${id}-add`}
                value=""
                className="h-8 rounded-md border border-border bg-background px-2 text-sm"
                onChange={(e) => {
                  const p = props.providers.find((x) => x.id === e.target.value);
                  if (p) setList((l) => [...(l ?? []), { id: p.id, name: p.name }]);
                }}
              >
                <option value="">Add a provider…</option>
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
            Save order
          </button>
          <button type="button" className={button} onClick={() => setList(null)}>
            Cancel
          </button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </li>
  );
}

// ── budget and usage ────────────────────────────────────────────────────

function BudgetSection({ settings, onChanged }: { settings: Settings; onChanged: () => void }) {
  const id = useId();
  const [currency, setCurrency] = useState(settings.currency);
  const [budget, setBudget] = useState(settings.monthlyBudgetMicros === null ? '' : fromMicros(settings.monthlyBudgetMicros));
  const [timezone, setTimezone] = useState(settings.budgetTimezone);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const save = useMutation({
    mutationFn: (body: Settings) => call('/settings', { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: () => {
      setMessage({ ok: true, text: 'Saved.' });
      onChanged();
    },
    onError: (err) => setMessage({ ok: false, text: errorText(err) }),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const micros = budget.trim() === '' ? null : toMicros(budget);
    if (budget.trim() !== '' && micros === null) {
      setMessage({ ok: false, text: 'The budget is an amount with at most 6 decimals, or empty for no budget.' });
      return;
    }
    save.mutate({ currency: currency.trim().toUpperCase(), monthlyBudgetMicros: micros, budgetTimezone: timezone.trim() || 'UTC' });
  };
  return (
    <section className="space-y-3" aria-labelledby="models-budget">
      <h2 id="models-budget" className="text-xl font-semibold">
        Currency and budget
      </h2>
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-3" aria-label="Currency and budget">
        <div className="space-y-1">
          <label htmlFor={`${id}-currency`} className="text-sm font-medium">
            Currency
          </label>
          <input id={`${id}-currency`} value={currency} onChange={(e) => setCurrency(e.target.value)} className={input} />
        </div>
        <div className="space-y-1">
          <label htmlFor={`${id}-budget`} className="text-sm font-medium">
            Monthly budget
          </label>
          <input id={`${id}-budget`} inputMode="decimal" value={budget} placeholder="No budget" onChange={(e) => setBudget(e.target.value)} className={input} />
        </div>
        <div className="space-y-1">
          <label htmlFor={`${id}-tz`} className="text-sm font-medium">
            Budget time zone
          </label>
          <input id={`${id}-tz`} value={timezone} onChange={(e) => setTimezone(e.target.value)} className={input} />
        </div>
        <div className="flex items-center gap-3 sm:col-span-3">
          <button type="submit" className={primary} disabled={save.isPending}>
            Save
          </button>
          {message ? (
            <p role={message.ok ? 'status' : 'alert'} className={`text-sm ${message.ok ? 'text-muted-foreground' : 'text-destructive'}`}>
              {message.text}
            </p>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground sm:col-span-3">
          Every provider's prices are in this currency; it cannot change once the site has model usage.
        </p>
      </form>
    </section>
  );
}

function UsageSection({ usage }: { usage: Usage }) {
  const money = (m: number) => `${fromMicros(m)} ${usage.currency}`;
  return (
    <section className="space-y-3" aria-labelledby="models-usage">
      <h2 id="models-usage" className="text-xl font-semibold">
        Usage in {usage.period}
      </h2>
      <p className="text-sm" data-testid="llm-usage-summary">
        Committed {money(usage.committedMicros)}
        {usage.monthlyBudgetMicros !== null ? ` of ${money(usage.monthlyBudgetMicros)} (${money(usage.remainingMicros ?? 0)} left)` : ' (no budget)'}
      </p>
      {usage.byModel.length === 0 ? (
        <p className="text-sm text-muted-foreground">No model calls this month.</p>
      ) : (
        <table className="w-full text-sm" aria-label="Usage by model">
          <thead className="text-left text-muted-foreground">
            <tr>
              <th className="py-1 font-normal">Provider / model</th>
              <th className="py-1 font-normal">Attempts</th>
              <th className="py-1 font-normal">Tokens in / out</th>
              <th className="py-1 font-normal">Settled</th>
              <th className="py-1 font-normal">Unknown</th>
            </tr>
          </thead>
          <tbody>
            {usage.byModel.map((r) => (
              <tr key={`${r.providerId ?? r.instanceRef}:${r.name}:${r.model}`} className="border-t border-border">
                <td className="py-1">
                  {r.name ?? r.instanceRef} <span className="text-muted-foreground">{r.model}</span>
                  {r.source === 'instance' ? <span className="text-muted-foreground"> (instance)</span> : null}
                </td>
                <td className="py-1">{r.attempts}</td>
                <td className="py-1">
                  {r.inputTokens} / {r.outputTokens}
                </td>
                <td className="py-1">{money(r.settledMicros)}</td>
                <td className="py-1">{r.unknownCount ? `${r.unknownCount} (${money(r.unknownMicros)} reserved)` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {usage.carriedOver.length ? (
        <p className="text-sm text-muted-foreground">
          Still open from earlier months: {usage.carriedOver.map((c) => `${c.period}: ${money(c.micros)}`).join(', ')} — counted against this month until reconciled.
        </p>
      ) : null}
    </section>
  );
}

// ── reconciliation ──────────────────────────────────────────────────────

function ReconcileSection({ attempts, currency, onChanged }: { attempts: Attempt[]; currency: string; onChanged: () => void }) {
  return (
    <section className="space-y-3" aria-labelledby="models-reconcile">
      <div className="space-y-1">
        <h2 id="models-reconcile" className="text-xl font-semibold">
          Costs to reconcile
        </h2>
        <p className="text-sm text-muted-foreground">
          Requests that were (or may have been) sent without a usage report: timeouts, dropped connections, errors such as
          rate limits. Their reservation stays against the budget until you enter the cost from the provider's console or
          invoice, or confirm it was not billed.
        </p>
      </div>
      {attempts.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing to reconcile.</p>
      ) : (
        <ul className="space-y-2" aria-label="Costs to reconcile">
          {attempts.map((a) => (
            <ReconcileRow key={a.id} attempt={a} currency={currency} onChanged={onChanged} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ReconcileRow({ attempt: a, currency, onChanged }: { attempt: Attempt; currency: string; onChanged: () => void }) {
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
        setError(`Enter the actual cost in ${currency}.`);
        return;
      }
      save.mutate({ conclusion, actualMicros: micros, evidence, version: a.version });
    } else {
      save.mutate({ conclusion, evidence, version: a.version });
    }
  };
  return (
    <li className="rounded-md border border-border p-3" data-testid={`llm-pending-${a.id}`}>
      <p className="text-sm">
        <span className="font-medium">{a.name}</span> <span className="text-muted-foreground">{a.model}</span> ·{' '}
        {new Date(a.createdAt).toLocaleString()} · {a.errorCode ?? a.outcome} · reserved {fromMicros(a.reservedMicros)} {currency}
      </p>
      <form onSubmit={submit} className="mt-2 flex flex-wrap items-end gap-2" aria-label={`Reconcile ${a.id}`}>
        <div className="space-y-1">
          <label htmlFor={`${id}-c`} className="text-xs text-muted-foreground">
            Conclusion
          </label>
          <select id={`${id}-c`} value={conclusion} onChange={(e) => setConclusion(e.target.value as typeof conclusion)} className="h-8 rounded-md border border-border bg-background px-2 text-sm">
            <option value="cancelled">Not billed</option>
            <option value="settled">Billed</option>
          </select>
        </div>
        {conclusion === 'settled' ? (
          <div className="space-y-1">
            <label htmlFor={`${id}-a`} className="text-xs text-muted-foreground">
              Actual cost ({currency})
            </label>
            <input id={`${id}-a`} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className="h-8 w-28 rounded-md border border-border bg-background px-2 text-sm" />
          </div>
        ) : null}
        <div className="min-w-48 flex-1 space-y-1">
          <label htmlFor={`${id}-e`} className="text-xs text-muted-foreground">
            Evidence
          </label>
          <input id={`${id}-e`} value={evidence} placeholder="Invoice, console, provider FAQ…" onChange={(e) => setEvidence(e.target.value)} className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm" />
        </div>
        <button type="submit" className={button} disabled={save.isPending}>
          Reconcile
        </button>
      </form>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </li>
  );
}
