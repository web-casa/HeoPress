import { expect, test, type Page } from '@playwright/test';
import { ADMIN, seed, signIn, useSite } from './fixtures';

/**
 * The AI pipeline screens (HeoPress P09 tasks 2.3, 4.1, 5.1). The seed (scripts/e2e-studio-seed.ts) leaves two
 * translated drafts of the links site in the review queue — "AI harbour 1" needs a person (its source's terms narrowed),
 * "AI harbour 2" passed the gate but has no publish tier — and one flow drafted by an agent. The workbench's model is the
 * stand-in service's `/article` answer.
 */

const MODEL = `http://127.0.0.1:${process.env.E2E_MODEL_PORT ?? 1993}`;

async function asAdmin(page: Page): Promise<Record<string, string>> {
  await useSite(page, seed().links.site);
  await page.addInitScript(() => window.localStorage.setItem('heopress.studio.language', 'en'));
  await signIn(page, ADMIN.email, ADMIN.password);
  const token = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.startsWith('heopress.session.v2|'))!;
    return (JSON.parse(localStorage.getItem(key)!) as { token: string }).token;
  });
  return { authorization: `Bearer ${token}`, 'x-heopress-site': seed().links.site, 'content-type': 'application/json' };
}

test('task 2.3: the review queue shows score, evidence and suggestions; a batch reports each entry', async ({ page }) => {
  await asAdmin(page);
  await page.goto(`${ADMIN.path}/content/ai-review`);
  await expect(page.getByRole('heading', { name: 'AI review', level: 1 })).toBeVisible();
  const first = page.getByTestId('ai-review-entry').filter({ hasText: 'AI harbour 1' });
  const second = page.getByTestId('ai-review-entry').filter({ hasText: 'AI harbour 2' });
  await expect(first.getByText('Gate: needs a person')).toBeVisible();
  await expect(second.getByText('Gate: passed')).toBeVisible();
  await expect(first.getByTestId('ai-review-score')).toHaveText(/Score \d+/);
  await first.getByRole('button', { name: 'Details' }).click();
  const rights = first.getByTestId('gate-check-source_rights');
  await expect(rights).toContainText('Needs a person');
  await expect(rights).toContainText('Record the source licence');
  await rights.getByText('Evidence').click();
  await expect(rights.locator('pre')).toContainText('discovery_only');

  // Approve both: the first is approved for its version (and stays in review: its terms no longer allow publishing),
  // the second has no gate result to approve — reported, not fatal.
  await page.getByRole('button', { name: 'Select all' }).click();
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByRole('alert')).toContainText('Write a reason first.');
  await page.getByLabel('Reason (recorded with each decision)').fill('Checked by hand');
  await page.getByRole('button', { name: 'Approve' }).click();
  const results = page.getByTestId('ai-review-result');
  await expect(results).toHaveCount(2);
  await expect(results.filter({ hasText: 'AI harbour 1' })).toContainText('Done');
  await expect(results.filter({ hasText: 'AI harbour 2' })).toContainText('NOT_REVIEWABLE');
  await expect(first.getByText('Gate: approved')).toBeVisible();

  // Dismiss them both.
  await page.getByRole('button', { name: 'Select all' }).click();
  await page.getByRole('button', { name: 'Dismiss' }).click();
  await expect(page.getByText('Nothing waits for review')).toBeVisible();
});

test('task 4.1: a workbench trial streams output and diagnostics, is billed, and writes no content item', async ({ page }) => {
  const headers = await asAdmin(page);
  // A model for generation: the stand-in's article answer.
  await page.goto(`${ADMIN.path}/settings/advanced/models`);
  await page.getByRole('button', { name: /new provider/i }).click();
  const form = page.getByRole('form', { name: 'New model provider' });
  for (const [label, value] of Object.entries({ Name: 'Article model', 'API root': `${MODEL}/article/v1`, Model: 'mock-article', 'API key': 'sk-article', 'Input price (USD per 1M tokens)': '1', 'Output price (USD per 1M tokens)': '2' })) {
    await form.getByLabel(label, { exact: true }).fill(value);
  }
  await form.getByRole('button', { name: 'Create' }).click();
  await expect(form).toHaveCount(0);
  const route = page.getByTestId('llm-route-generation');
  await route.getByRole('button', { name: 'Edit' }).click();
  await route.getByLabel(/Add a provider/).selectOption({ label: 'Article model' });
  await route.getByRole('button', { name: 'Save order' }).click();
  await expect(route.getByRole('button', { name: 'Edit' })).toBeVisible();

  const count = async () => {
    const res = await page.request.get('/api/v1/items/articles?limit=100', { headers });
    expect(res.status(), await res.text()).toBe(200);
    return ((await res.json()) as { data: unknown[] }).data.length;
  };
  const before = await count();

  await page.goto(`${ADMIN.path}/content/workbench`);
  await expect(page.getByRole('heading', { name: 'Prompt workbench', level: 1 })).toBeVisible();
  await page.getByLabel('Sample source document').selectOption({ label: 'Hafen two' });
  await page.getByLabel('Prompt (not saved)').fill('Rewrite for local readers; cite the source in every paragraph.');
  await page.getByLabel('Editorial policy, JSON (not saved)').fill('{"forbiddenTopics": ["gambling"]}');
  await page.getByRole('button', { name: 'Run trial' }).click();
  await expect(page.getByTestId('workbench-stage')).toHaveText('Done');
  await expect(page.getByTestId('workbench-output')).toContainText('record season for ferries');
  await expect(page.getByTestId('workbench-usage')).toContainText('mock-article');
  const diag = page.getByTestId('workbench-diagnostics');
  await expect(diag).toContainText('The gate would say');
  const uncited = page.getByTestId('workbench-uncited');
  await expect(uncited).toHaveCount(1);
  await expect(uncited).toContainText('Fishermen said the cold spring');
  await expect(uncited).toContainText('Likely from source paragraph 1');
  await expect(uncited).toContainText('cold spring delayed the first catches');

  expect(await count()).toBe(before);
  // Billed to the site: the call is in the ledger.
  const attempts = (await (await page.request.get('/api/v1/llm/attempts', { headers })).json()) as { data: Array<{ model?: string }> };
  expect(attempts.data.some((a) => a.model === 'mock-article')).toBe(true);
});

test('task 5.1: an agent-drafted flow is approved by a person and enabled', async ({ page }) => {
  const headers = await asAdmin(page);
  await page.goto(`${ADMIN.path}/content/flow-drafts`);
  const draft = page.getByTestId('flow-draft').filter({ hasText: 'Agent nightly log' });
  await expect(draft).toContainText('drafted by an agent');
  await expect(draft.getByRole('button', { name: 'Reject' })).toBeDisabled();
  await draft.getByLabel('Reason').fill('Logging only');
  await draft.getByRole('button', { name: 'Approve and enable' }).click();
  await expect(draft).toContainText('Approved');
  const flows = (await (await page.request.get('/api/v1/flows', { headers })).json()) as { data: Array<{ name: string; status: string }> };
  expect(flows.data.find((f) => f.name === 'Agent nightly log')?.status).toBe('active');
});
