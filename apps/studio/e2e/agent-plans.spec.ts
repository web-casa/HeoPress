import { createHmac } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { ADMIN, seed, signIn, useSite } from './fixtures';

/**
 * Batch plans in Studio (HeoPress P10 tasks 3.2–3.4; spec agents/batch-operations; ADR-0012): an agent submits a plan
 * through the MCP endpoint with its person's token; a person reviews the diff and decides in Studio.
 *
 * - solo mode: the drafter approves their own plan with an authenticator code; a high-risk plan enters the cooling-off
 *   period, is cancelled there, and never runs;
 * - team mode: the drafter cannot approve; a colleague who administers the site does, and runs it.
 */

async function sessionHeaders(page: Page, siteId: string): Promise<Record<string, string>> {
  const token = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.startsWith('heopress.session.v2|'))!;
    return (JSON.parse(localStorage.getItem(key)!) as { token: string }).token;
  });
  return { authorization: `Bearer ${token}`, 'x-heopress-site': siteId, 'content-type': 'application/json' };
}

async function personalToken(page: Page, headers: Record<string, string>, siteId: string): Promise<string> {
  const res = await page.request.post('/api/v1/agent-access/tokens', { headers, data: { name: `plans-${Date.now()}`, siteIds: [siteId], toolGroups: ['read', 'content'], expiresInDays: 1 } });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { data: { token: string } }).data.token;
}

async function tool(request: APIRequestContext, token: string, name: string, args: Record<string, unknown>) {
  const res = await request.post('/api/v1/agents/mcp', { headers: { authorization: `Bearer ${token}` }, data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } });
  expect(res.status()).toBe(200);
  return ((await res.json()) as { result: { structuredContent: { data?: Record<string, unknown>; code?: string } } }).result.structuredContent;
}

/** A draft on the links site, made by the agent, and a plan to change it. */
async function draftAndPlan(request: APIRequestContext, token: string, siteId: string, operation: 'content_update' | 'content_delete', title: string) {
  const created = await tool(request, token, 'content_create', { siteId, collection: 'articles', data: { title, slug: `plan-${Date.now()}`, locale: 'en' }, idempotencyKey: `plan-${Date.now()}-${Math.random()}` });
  const item = created.data as { id: string; version: number };
  expect(item, JSON.stringify(created)).toBeTruthy();
  const plan = await tool(request, token, 'plans_submit', {
    scope: { siteIds: [siteId] },
    operation,
    arguments: { collection: 'articles', ...(operation === 'content_update' ? { data: { title: `${title} (planned)` } } : {}) },
    perSite: { [siteId]: { id: item.id, expectedVersion: item.version } },
  });
  expect(plan.data, JSON.stringify(plan)).toBeTruthy();
  return { itemId: item.id, planId: (plan.data as { id: string }).id };
}

// RFC 6238 (SHA-1, 6 digits, 30 s) for the authenticator the scenario enrolls.
function base32(secret: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secret.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}
function totp(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', base32(secret)).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0xf;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

test('solo mode: the drafter approves with an authenticator code; a cooling-off plan is cancelled and never runs', async ({ page }) => {
  test.setTimeout(120_000);
  const s = seed();
  const site = s.links.site;
  await useSite(page, site);
  await page.addInitScript(() => window.localStorage.setItem('heopress.studio.language', 'en'));
  await signIn(page, s.plans.planner.email, s.password);
  const headers = await sessionHeaders(page, site);
  const token = await personalToken(page, headers, site);

  // Enroll an authenticator (the second factor of ADR-0012).
  const setup = await page.request.post('/api/v1/me/tfa/setup', { headers, data: { password: s.password } });
  expect(setup.status()).toBe(200);
  const { secret } = ((await setup.json()) as { data: { secret: string } }).data;
  let last = Math.floor(Date.now() / 30_000);
  expect((await page.request.post('/api/v1/me/tfa/confirm', { headers, data: { secret, code: totp(secret, last) } })).status()).toBe(200);
  const nextCode = async () => {
    const step = last + 1;
    while (Math.floor(Date.now() / 30_000) + 1 < step) await page.waitForTimeout(1000);
    last = step;
    return totp(secret, step);
  };

  // 1. A low-risk update: reviewed with its diff, approved with the code, run.
  const update = await draftAndPlan(page.request, token, site, 'content_update', 'Solo plan target');
  await page.goto(`${ADMIN.path}/settings/agent-plans`);
  await expect(page.getByRole('heading', { name: 'Batch plans', level: 1 })).toBeVisible();
  await page.locator(`[data-plan="${update.planId}"]`).getByRole('link', { name: 'Update content' }).click();
  await expect(page.getByTestId('plan-tier')).toHaveText('Low');
  await expect(page.locator(`[data-preview-site="${site}"]`)).toContainText('Solo plan target (planned)');
  const approve = page.getByRole('button', { name: 'Approve' });
  await expect(approve).toBeDisabled();
  await page.getByLabel('Authenticator code').fill('000000');
  await approve.click();
  await expect(page.getByRole('alert')).toContainText('second factor');
  await page.getByLabel('Authenticator code').fill(await nextCode());
  await approve.click();
  await expect(page.getByText('Approved', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.locator(`[data-result-site="${site}"]`)).toContainText('Succeeded');
  const after = await page.request.get(`/api/v1/items/articles/${update.itemId}`, { headers });
  expect(JSON.stringify(await after.json())).toContain('Solo plan target (planned)');

  // 2. A delete is high risk even on one site: approval starts the cooling-off period; cancelling it means it never runs.
  const del = await draftAndPlan(page.request, token, site, 'content_delete', 'Solo delete target');
  await page.goto(`${ADMIN.path}/settings/agent-plans/${del.planId}`);
  await expect(page.getByTestId('plan-tier')).toHaveText('Highest');
  await expect(page.getByText('High risk', { exact: true })).toBeVisible();
  await page.getByLabel('Authenticator code').fill(await nextCode());
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByRole('status')).toContainText('Cooling-off period');
  await expect(page.getByRole('button', { name: /^Run/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Cancel plan' }).click();
  await expect(page.getByText('Cancelled', { exact: true }).first()).toBeVisible();
  await expect(page.locator(`[data-result-site="${site}"]`)).toContainText('Cancelled');
  const executed = await page.request.post(`/api/v1/agent-plans/${del.planId}/execute`, { headers });
  expect(executed.status()).toBe(409);
  expect((await page.request.get(`/api/v1/items/articles/${del.itemId}`, { headers })).status()).toBe(200);
});

test('team mode: the drafter cannot approve; a colleague approves and runs the plan', async ({ page, browser }) => {
  const s = seed();
  const site = s.links.site;
  await useSite(page, site);
  await page.addInitScript(() => window.localStorage.setItem('heopress.studio.language', 'en'));
  await signIn(page, ADMIN.email, ADMIN.password);
  const headers = await sessionHeaders(page, site);
  const setMode = (mode: 'solo' | 'team') => page.request.put('/api/v1/flow-drafts/approval-mode', { headers, data: { mode } });
  expect((await setMode('team')).status()).toBe(200);
  try {
    const token = await personalToken(page, headers, site);
    const plan = await draftAndPlan(page.request, token, site, 'content_update', 'Team plan target');
    await page.goto(`${ADMIN.path}/settings/agent-plans/${plan.planId}`);
    await expect(page.getByText(/someone other than the drafter must approve/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
    const self = await page.request.post(`/api/v1/agent-plans/${plan.planId}/approve`, { headers, data: {} });
    expect(self.status()).toBe(403);

    const other = await browser.newPage();
    await useSite(other, site);
    await other.addInitScript(() => window.localStorage.setItem('heopress.studio.language', 'en'));
    await signIn(other, s.people.colleague.email, s.password);
    await other.goto(`${ADMIN.path}/settings/agent-plans/${plan.planId}`);
    await expect(other.getByLabel('Authenticator code')).toHaveCount(0);
    await other.getByRole('button', { name: 'Approve' }).click();
    await expect(other.getByText('Approved', { exact: true }).first()).toBeVisible();
    await other.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(other.locator(`[data-result-site="${site}"]`)).toContainText('Succeeded');
    await other.close();
  } finally {
    expect((await setMode('solo')).status()).toBe(200);
  }
});
