import { expect, test, type Page } from '@playwright/test';
import { ADMIN, seed, signIn, useSite } from './fixtures';

/**
 * Model settings in Studio (HeoPress P04 task 7.6): an administrator adds
 * model providers, probes them through the real gateway and ledger (against
 * the stand-in service, e2e/mock-model-server.mjs), orders a task's failover
 * list, sets the budget, sees this month's usage and reconciles a cost the
 * ledger could not know (a 429 without usage). The API key is sent once,
 * reaches the model service, and is never shown — on the page or in any API
 * answer.
 */

const SECRET = 'sk-e2e-model-key-never-shown';
const MASK = '••••••••';
const MODEL = `http://127.0.0.1:${process.env.E2E_MODEL_PORT ?? 1993}`;
const form = (page: Page) => page.getByRole('form', { name: 'New model provider' });
const providerRow = (page: Page, name: string) => page.locator('[data-testid^="llm-provider-"]', { hasText: name });

async function create(page: Page, fields: Record<string, string>): Promise<void> {
  await page.getByRole('button', { name: /new provider/i }).click();
  for (const [label, value] of Object.entries(fields)) await form(page).getByLabel(label, { exact: true }).fill(value);
  await form(page).getByRole('button', { name: 'Create' }).click();
  await expect(form(page)).toHaveCount(0);
}

test('an administrator adds and probes model providers, orders failover, sets a budget and reconciles; the key stays masked', async ({ page, request }) => {
  const s = seed();
  await useSite(page, s.sites.a);
  await signIn(page, ADMIN.email, ADMIN.password);
  // Every model API answer, its body read in full; one cut off by a reload is recorded as unread (null).
  const answers: Array<Promise<{ method: string; path: string; body: string | null }>> = [];
  page.on('response', (res) => {
    const path = new URL(res.url()).pathname;
    if (!path.startsWith('/api/v1/llm')) return;
    const method = res.request().method();
    answers.push(res.text().then((body) => ({ method, path, body }), () => ({ method, path, body: null })));
  });
  await page.goto(`${ADMIN.path}/settings/models`);
  await expect(page.getByRole('heading', { name: 'Models', exact: true })).toBeVisible();
  await expect(page.getByText('No providers yet')).toBeVisible();

  // A provider that answers: the probe sees the tool call and the JSON.
  const prices = { 'Input price (USD per 1M tokens)': '1', 'Output price (USD per 1M tokens)': '2' };
  await create(page, { Name: 'Mock model', 'API root': `${MODEL}/ok/v1`, Model: 'mock-1', 'API key': SECRET, ...prices });
  await expect(providerRow(page, 'Mock model').getByText(MASK)).toBeVisible();
  await providerRow(page, 'Mock model').getByRole('button', { name: /probe/i }).click();
  await expect(providerRow(page, 'Mock model').getByTestId('llm-probe')).toHaveText('Probe: tool calls ✓ · JSON ✓');

  // A provider that is rate limited: the probe says so; the cost of those requests is unknown.
  await create(page, { Name: 'Limited', 'API root': `${MODEL}/limited/v1`, Model: 'mock-2', 'API key': 'sk-limited', ...prices });
  await providerRow(page, 'Limited').getByRole('button', { name: /probe/i }).click();
  await expect(providerRow(page, 'Limited').getByTestId('llm-probe')).toHaveText('Probe: tool calls ✗ (PROVIDER_HTTP_429) · JSON ✗ (PROVIDER_HTTP_429)');

  // Translation tries Limited first, then Mock model.
  const route = page.getByTestId('llm-route-translation');
  await route.getByRole('button', { name: 'Edit' }).click();
  await route.getByLabel(/Add a provider/).selectOption({ label: 'Mock model' });
  await route.getByLabel(/Add a provider/).selectOption({ label: 'Limited' });
  await route.getByRole('button', { name: 'Move Limited up' }).click();
  await route.getByRole('button', { name: 'Save order' }).click();
  await expect(route.getByRole('button', { name: 'Edit' })).toBeVisible();
  await expect(route.getByRole('list', { name: 'Translation order' }).getByRole('listitem')).toHaveText(['1.Limited', '2.Mock model']);

  // A budget of 10 USD a month.
  const budget = page.getByRole('form', { name: 'Currency and budget' });
  await budget.getByLabel('Monthly budget').fill('10');
  await budget.getByRole('button', { name: 'Save' }).click();
  await expect(budget.getByRole('status')).toHaveText('Saved.');

  // After a reload (the answers so far read in full first): the usage of the probes, and the two unknown costs to reconcile.
  // Saving refetches the page's queries: let them finish, so no answer is cut off by the reload.
  await page.waitForLoadState('networkidle');
  const read = await Promise.all(answers.splice(0));
  await page.reload();
  await expect(page.getByTestId('llm-usage-summary')).toContainText('of 10 USD');
  const usage = page.getByRole('table', { name: 'Usage by model' });
  await expect(usage.getByRole('row', { name: /Mock model/ })).toContainText('40 / 10');
  await expect(usage.getByRole('row', { name: /Limited/ })).toContainText('2 (');
  const pending = page.locator('[data-testid^="llm-pending-"]');
  await expect(pending).toHaveCount(2);
  await pending.first().getByLabel('Evidence').fill('429s are not billed (provider FAQ)');
  await pending.first().getByRole('button', { name: 'Reconcile' }).click();
  await expect(pending).toHaveCount(1);

  // The key reached the model service, and nothing the API answered carried it.
  const received = (await (await request.get(`${MODEL}/requests`)).json()) as Array<{ path: string; authorization: string | null }>;
  expect(received.filter((r) => r.path === '/ok/v1/chat/completions').map((r) => r.authorization)).toEqual([`Bearer ${SECRET}`, `Bearer ${SECRET}`]);
  await expect(page.getByText(SECRET)).toHaveCount(0);
  read.push(...(await Promise.all(answers)));
  // Only a refetch (GET) cut off by the reload may be unread; every write's answer was read, and
  // the provider list read after the reload carries no key either.
  expect(read.filter((a) => a.body === null && a.method !== 'GET')).toEqual([]);
  expect(read.some((a) => a.method === 'GET' && a.path === '/api/v1/llm/providers' && a.body !== null && a.body.includes('Mock model'))).toBe(true);
  expect(read.some((a) => a.method === 'POST' && a.path === '/api/v1/llm/providers' && a.body?.includes('Mock model'))).toBe(true);
  expect(read.filter((a) => a.body?.includes(SECRET))).toEqual([]);
});
