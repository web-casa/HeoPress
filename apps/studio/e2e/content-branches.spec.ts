import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { ADMIN, seed, signIn, useSite } from './fixtures';

/**
 * Content branches in Studio (HeoPress P10 tasks 4.1, 4.3, 4.4; spec agents/content-branches): an agent edits a branch
 * through the MCP endpoint while a person changes the same paragraph of the article; the person sees the conflict
 * with base, main and branch, chooses, and merges into a pending revision — the article itself is unchanged until the
 * branch is promoted.
 */

async function sessionHeaders(page: Page, siteId: string): Promise<Record<string, string>> {
  const token = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.startsWith('heopress.session.v2|'))!;
    return (JSON.parse(localStorage.getItem(key)!) as { token: string }).token;
  });
  return { authorization: `Bearer ${token}`, 'x-heopress-site': siteId, 'content-type': 'application/json' };
}

async function tool(request: APIRequestContext, token: string, name: string, args: Record<string, unknown>) {
  const res = await request.post('/api/v1/agents/mcp', { headers: { authorization: `Bearer ${token}` }, data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } });
  expect(res.status()).toBe(200);
  return ((await res.json()) as { result: { structuredContent: { data?: Record<string, unknown>; code?: string } } }).result.structuredContent;
}

test('a conflict on the same field is shown with both versions; the person chooses and merges into a pending revision', async ({ page }) => {
  test.setTimeout(90_000);
  const s = seed();
  const site = s.links.site;
  await useSite(page, site);
  await page.addInitScript(() => window.localStorage.setItem('heopress.studio.language', 'en'));
  await signIn(page, ADMIN.email, ADMIN.password);
  const headers = await sessionHeaders(page, site);
  const pat = await page.request.post('/api/v1/agent-access/tokens', { headers, data: { name: `branches-${Date.now()}`, siteIds: [site], toolGroups: ['read', 'content'], expiresInDays: 1 } });
  expect(pat.status()).toBe(201);
  const token = ((await pat.json()) as { data: { token: string } }).data.token;

  // The agent drafts an article and rewrites its title in a branch.
  const created = await tool(page.request, token, 'content_create', { siteId: site, collection: 'articles', data: { title: 'Branch base title', slug: `branch-${Date.now()}`, locale: 'en' }, idempotencyKey: `branch-${Date.now()}` });
  const item = created.data as { id: string; version: number };
  const branch = (await tool(page.request, token, 'branch_create', { siteId: site, collection: 'articles', id: item.id, name: 'Agent headline', idempotencyKey: `b-${item.id}` })).data as { key: string; revision: number };
  const updated = await tool(page.request, token, 'branch_update', { siteId: site, collection: 'articles', id: item.id, branch: branch.key, expectedVersion: branch.revision, data: { title: 'Agent headline' } });
  expect(updated.data, JSON.stringify(updated)).toBeTruthy();

  // Meanwhile a person changes the same field on the article.
  const patched = await page.request.patch(`/api/v1/items/articles/${item.id}`, { headers, data: { data: { title: 'Editor headline' }, expectedVersion: item.version } });
  expect(patched.status()).toBe(200);

  // The agent's merge fails with the conflict; it cannot choose.
  const diff = (await tool(page.request, token, 'branch_diff', { siteId: site, collection: 'articles', id: item.id, branch: branch.key })).data as { mainVersion: number; revision: number };
  const refused = await tool(page.request, token, 'branch_merge', { siteId: site, collection: 'articles', id: item.id, branch: branch.key, expectedVersion: diff.revision, expectedMainVersion: diff.mainVersion });
  expect(refused.code).toBe('MERGE_CONFLICT');

  await page.goto(`${ADMIN.path}/content/articles/${item.id}?form=full`);
  await page.getByRole('button', { name: 'Versions', exact: true }).click();
  await expect(page.getByText('Agent headline').first()).toBeVisible();
  await page.getByRole('button', { name: 'Compare' }).click();
  const conflicts = page.getByTestId('merge-conflicts');
  await expect(conflicts).toContainText('Field “title”');
  await expect(conflicts).toContainText('Editor headline');
  await expect(conflicts).toContainText('Agent headline');
  const merge = page.getByRole('button', { name: 'Merge', exact: true });
  await expect(merge).toBeDisabled();
  await page.getByLabel('Keep branch').check();
  await merge.click();
  await expect(page.getByRole('status')).toContainText('Merged');
  await expect(page.getByText('merged — pending')).toBeVisible();

  // Pending: the article still has the editor's title until a person promotes the branch.
  expect(JSON.stringify(await (await page.request.get(`/api/v1/items/articles/${item.id}`, { headers })).json())).toContain('Editor headline');
  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: 'Promote' }).click();
  await expect.poll(async () => JSON.stringify(await (await page.request.get(`/api/v1/items/articles/${item.id}`, { headers })).json())).toContain('Agent headline');
});
