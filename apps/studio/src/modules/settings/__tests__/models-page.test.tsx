// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

/**
 * The model settings page (HeoPress P04 task 7.6): providers listed with the
 * key only as the API's mask, the capability probe, creating a provider (the
 * key is sent once and kept nowhere; prices sent as exact micro-units),
 * ordering a task's failover list, currency and budget, this month's usage,
 * and reconciling an unknown cost; a non-administrator gets no form.
 */

const h = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/lib/http', () => ({ siteFetch: h.fetch }));

import { ModelsSettingsPage, fromMicros, toMicros } from '../models-page';

const MASK = '••••••••';
const provider = (over: Record<string, unknown> = {}) => ({
  id: 'p_1',
  kind: 'openai_compatible',
  name: 'DeepSeek',
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  apiKey: MASK,
  capabilities: { tools: true, json: true, maxContext: 64000 },
  probe: null,
  pricing: { kind: 'per_1m_tokens', inputMicros: 2_000_000, outputMicros: 8_000_000 },
  currency: 'CNY',
  timeoutMs: 60000,
  disabled: false,
  createdAt: '2026-10-17T00:00:00.000Z',
  updatedAt: '2026-10-17T00:00:00.000Z',
  ...over,
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const usage = {
  period: '2026-10',
  currency: 'CNY',
  monthlyBudgetMicros: 500_000_000,
  committedMicros: 1_250_000,
  remainingMicros: 498_750_000,
  byModel: [
    { source: 'site', providerId: 'p_1', instanceRef: null, name: 'DeepSeek', model: 'deepseek-chat', attempts: 3, settledMicros: 1_000_000, reservedMicros: 0, unknownCount: 1, unknownMicros: 250_000, inputTokens: 1200, outputTokens: 300 },
  ],
  carriedOver: [{ period: '2026-09', unknownCount: 1, reservedCount: 0, micros: 30 }],
};
const pendingAttempt = { id: 'att_1', name: 'DeepSeek', model: 'deepseek-chat', outcome: 'failed_transferable', billing: 'unknown', version: 2, reservedMicros: 250_000, errorCode: 'PROVIDER_HTTP_429', period: '2026-10', createdAt: '2026-10-17T00:00:00.000Z' };

type Handler = (init: RequestInit) => Response;
function routes(over: Record<string, Handler> = {}) {
  const handlers: Record<string, Handler> = {
    'GET /api/v1/llm/providers': () => json({ data: [provider(), provider({ id: 'p_2', name: 'Qwen', model: 'qwen-plus' })] }),
    'GET /api/v1/llm/routes': () => json({ data: [{ taskType: 'translation', providers: [{ id: 'p_1', name: 'DeepSeek', available: true }, { id: 'p_2', name: 'Qwen', available: true }] }] }),
    'GET /api/v1/llm/settings': () => json({ data: { currency: 'CNY', monthlyBudgetMicros: 500_000_000, budgetTimezone: 'Asia/Shanghai' } }),
    'GET /api/v1/llm/usage': () => json({ data: usage }),
    'GET /api/v1/llm/attempts?pending=1&limit=100': () => json({ data: [pendingAttempt], meta: { next: null } }),
    ...over,
  };
  h.fetch.mockImplementation(async (url: string, init: RequestInit = {}) => {
    const key = `${(init.method ?? 'GET').toUpperCase()} ${url}`;
    const handler = handlers[key];
    if (!handler) throw new Error(`unexpected ${key}`);
    return handler(init);
  });
}
const bodyOf = (init: RequestInit) => JSON.parse(String(init.body)) as Record<string, unknown>;

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ModelsSettingsPage />
    </QueryClientProvider>,
  );
  return client;
}

const cacheText = (client: QueryClient) =>
  JSON.stringify([client.getQueryCache().getAll().map((q) => q.state), client.getMutationCache().getAll().map((m) => m.state)]);

describe('money in micro-units', () => {
  it('converts exactly, never through floating point', () => {
    expect(toMicros('0.27')).toBe(270_000);
    expect(toMicros('2')).toBe(2_000_000);
    expect(toMicros('0.000001')).toBe(1);
    expect(toMicros('1.1')).toBe(1_100_000); // 1.1 * 1e6 in floating point is 1100000.0000000002
    expect(toMicros('0.0000001')).toBeNull();
    expect(toMicros('-1')).toBeNull();
    expect(toMicros('abc')).toBeNull();
    expect(toMicros('99999999999')).toBeNull(); // beyond the exact integer range in micro-units
    expect(fromMicros(270_000)).toBe('0.27');
    expect(fromMicros(2_000_000)).toBe('2');
    expect(fromMicros(1)).toBe('0.000001');
  });
});

describe('ModelsSettingsPage', () => {
  beforeEach(() => {
    h.fetch.mockReset();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('lists providers with the key masked, their prices, the failover order and this month’s usage', async () => {
    routes();
    renderPage();
    const row = await screen.findByTestId('llm-provider-p_1');
    expect(within(row).getByText(MASK)).toBeTruthy();
    expect(within(row).getByText('2 in / 8 out CNY per 1M tokens')).toBeTruthy();
    const order = await screen.findByRole('list', { name: 'Translation order' });
    expect(within(order).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['1.DeepSeek', '2.Qwen']);
    expect(await screen.findByTestId('llm-usage-summary')).toHaveTextContent('Committed 1.25 CNY of 500 CNY (498.75 CNY left)');
    expect(screen.getByRole('table', { name: 'Usage by model' })).toHaveTextContent('1200 / 300');
    expect(screen.getByText(/Still open from earlier months: 2026-09: 0.00003 CNY/)).toBeTruthy();
  });

  it('probes a provider and shows what the API kept for it', async () => {
    let probe: unknown = null;
    routes({
      'GET /api/v1/llm/providers': () => json({ data: [provider({ probe })] }),
      'POST /api/v1/llm/providers/p_1/probe': () => {
        probe = { at: '2026-10-18T00:00:00.000Z', tools: { ok: true }, json: { ok: false, error: 'NOT_JSON' } };
        return json({ data: provider({ probe }), meta: { probe, recorded: true } });
      },
    });
    renderPage();
    const row = await screen.findByTestId('llm-provider-p_1');
    fireEvent.click(within(row).getByRole('button', { name: /probe/i }));
    expect(await within(row).findByTestId('llm-probe')).toHaveTextContent('Probe: tool calls ✓ · JSON ✗ (NOT_JSON)');
  });

  it('a probe the API did not keep (the provider changed meanwhile) shows no result, and says to probe again', async () => {
    const verdicts = { tools: { ok: true }, json: { ok: true } };
    routes({
      'GET /api/v1/llm/providers': () => json({ data: [provider({ probe: null })] }),
      'POST /api/v1/llm/providers/p_1/probe': () => json({ data: provider({ probe: null }), meta: { probe: verdicts, recorded: false } }),
    });
    renderPage();
    const row = await screen.findByTestId('llm-provider-p_1');
    fireEvent.click(within(row).getByRole('button', { name: /probe/i }));
    expect(await within(row).findByText('The provider changed while it was being probed: probe it again.')).toBeTruthy();
    expect(within(row).queryByTestId('llm-probe')).toBeNull();
  });

  it('creates a provider: prices as exact micro-units in the site currency; the key is sent once and kept nowhere', async () => {
    const posts: Array<Record<string, unknown>> = [];
    routes({
      'POST /api/v1/llm/providers': (init) => {
        posts.push(bodyOf(init));
        return json({ data: provider({ id: 'p_3', name: 'Kimi' }) }, 201);
      },
    });
    const client = renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /new provider/i }));
    const form = await screen.findByRole('form', { name: 'New model provider' });
    const type = (label: string | RegExp, value: string) => fireEvent.change(within(form).getByLabelText(label), { target: { value } });
    type('Name', 'Kimi');
    type('API root', 'https://api.moonshot.cn/v1');
    type('Model', 'moonshot-v1-32k');
    type('API key', 'sk-kimi-secret');
    type(/Input price/, '1.1');
    type(/Output price/, '24');
    fireEvent.click(within(form).getByLabelText('JSON output'));
    expect(within(form).getByLabelText('API key')).toHaveAttribute('type', 'password');
    fireEvent.click(within(form).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(screen.queryByRole('form', { name: 'New model provider' })).toBeNull());
    expect(posts).toEqual([
      {
        kind: 'openai_compatible',
        name: 'Kimi',
        baseUrl: 'https://api.moonshot.cn/v1',
        model: 'moonshot-v1-32k',
        apiKey: 'sk-kimi-secret',
        capabilities: { tools: true, json: false, maxContext: null },
        pricing: { kind: 'per_1m_tokens', inputMicros: 1_100_000, outputMicros: 24_000_000 },
        currency: 'CNY',
      },
    ]);
    expect(document.body.innerHTML).not.toContain('sk-kimi-secret');
    expect(cacheText(client)).not.toContain('sk-kimi-secret');
    fireEvent.click(screen.getByRole('button', { name: /new provider/i }));
    expect(within(await screen.findByRole('form', { name: 'New model provider' })).getByLabelText('API key')).toHaveValue('');
  });

  it('a provider without prices is not sent', async () => {
    routes();
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /new provider/i }));
    const form = await screen.findByRole('form', { name: 'New model provider' });
    fireEvent.click(within(form).getByRole('button', { name: 'Create' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('Prices are required');
    expect(h.fetch.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'POST')).toBe(false);
  });

  it('reorders a failover list and saves it', async () => {
    const puts: Array<Record<string, unknown>> = [];
    routes({
      'PUT /api/v1/llm/routes': (init) => {
        puts.push(bodyOf(init));
        return json({ data: [] });
      },
    });
    renderPage();
    const route = await screen.findByTestId('llm-route-translation');
    fireEvent.click(within(route).getByRole('button', { name: 'Edit' }));
    fireEvent.click(within(route).getByRole('button', { name: 'Move Qwen up' }));
    fireEvent.click(within(route).getByRole('button', { name: 'Save order' }));
    await waitFor(() => expect(puts).toEqual([{ taskType: 'translation', providerIds: ['p_2', 'p_1'] }]));
  });

  it('a refused list shows the API’s reason', async () => {
    routes({ 'PUT /api/v1/llm/routes': () => json({ errors: [{ code: 'CAPABILITY_UNSUPPORTED', message: 'Qwen does not declare tool calls, which chat needs.' }] }, 422) });
    renderPage();
    const route = await screen.findByTestId('llm-route-chat');
    fireEvent.click(within(route).getByRole('button', { name: 'Edit' }));
    fireEvent.change(within(route).getByLabelText(/Add a provider/), { target: { value: 'p_2' } });
    fireEvent.click(within(route).getByRole('button', { name: 'Save order' }));
    expect(await within(route).findByRole('alert')).toHaveTextContent('Qwen does not declare tool calls');
  });

  it('saves the currency and budget in micro-units', async () => {
    const puts: Array<Record<string, unknown>> = [];
    routes({
      'PUT /api/v1/llm/settings': (init) => {
        puts.push(bodyOf(init));
        return json({ data: bodyOf(init) });
      },
    });
    renderPage();
    const form = await screen.findByRole('form', { name: 'Currency and budget' });
    expect(within(form).getByLabelText('Monthly budget')).toHaveValue('500');
    fireEvent.change(within(form).getByLabelText('Monthly budget'), { target: { value: '120.5' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(puts).toEqual([{ currency: 'CNY', monthlyBudgetMicros: 120_500_000, budgetTimezone: 'Asia/Shanghai' }]));
  });

  it('reconciles an unknown cost with its evidence and the version it read', async () => {
    const posts: Array<Record<string, unknown>> = [];
    routes({
      'POST /api/v1/llm/attempts/att_1/reconcile': (init) => {
        posts.push(bodyOf(init));
        return json({ data: {} });
      },
    });
    renderPage();
    const row = await screen.findByTestId('llm-pending-att_1');
    expect(row).toHaveTextContent('PROVIDER_HTTP_429');
    fireEvent.change(within(row).getByLabelText('Conclusion'), { target: { value: 'settled' } });
    fireEvent.change(within(row).getByLabelText(/Actual cost/), { target: { value: '0.31' } });
    fireEvent.change(within(row).getByLabelText('Evidence'), { target: { value: 'invoice line 4' } });
    fireEvent.click(within(row).getByRole('button', { name: 'Reconcile' }));
    await waitFor(() => expect(posts).toEqual([{ conclusion: 'settled', actualMicros: 310_000, evidence: 'invoice line 4', version: 2 }]));
  });

  it('a non-administrator is told models are managed by administrators, and gets no form', async () => {
    routes({ 'GET /api/v1/llm/providers': () => json({ errors: [{ code: 'FORBIDDEN', message: 'Forbidden' }] }, 403) });
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('Only administrators of this site can manage its models.');
    expect(screen.queryByRole('button', { name: /new provider/i })).toBeNull();
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });
});
