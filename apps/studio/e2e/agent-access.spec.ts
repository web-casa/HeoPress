import { createHash, randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { ADMIN, seed, signIn, useSite } from './fixtures';

/**
 * Agent authorization in Studio (HeoPress P10 tasks 1.2, 1.3; spec agents/mcp-access "OAuth 2.1 授权"): an agent
 * registers, the person approves it for one site with read-only tools on the consent page, the agent exchanges the code
 * with PKCE, and the token works on that site only. A personal access token is created and revoked on the settings page.
 */

const REDIRECT = 'http://127.0.0.1:33418/callback';

test('consent for one site and read-only tools; the token is refused on another site', async ({ page, request, baseURL }) => {
  const s = seed();
  await useSite(page, s.links.site);
  await signIn(page, ADMIN.email, ADMIN.password);

  const reg = await request.post('/api/v1/oauth/register', { data: { client_name: 'E2E agent', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' } });
  expect(reg.status()).toBe(201);
  const { client_id } = (await reg.json()) as { client_id: string };
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const resource = `${baseURL}/api/v1/agents/mcp`;
  const authorize = `/api/v1/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'e2e', resource, scope: 'mcp:read mcp:content' })}`;

  // The agent's callback is not running: capture where the browser is sent.
  let callback = '';
  await page.route('http://127.0.0.1:33418/**', async (route) => {
    callback = route.request().url();
    await route.fulfill({ status: 200, body: 'ok' });
  });

  await page.goto(authorize);
  await expect(page).toHaveURL(/\/agent-access\/consent\?request=/);
  await expect(page.getByRole('heading', { name: 'Authorize an agent' })).toBeVisible();
  await expect(page.getByText(/E2E agent asks to act for you/)).toBeVisible();
  // Publishing was not requested by the agent: it cannot be granted here.
  await expect(page.getByRole('checkbox', { name: /Publishing/ })).toBeDisabled();
  await page.getByRole('button', { name: 'Authorize' }).click();
  await expect(page.getByRole('alert')).toHaveText('Choose at least one site.');
  await page.getByRole('checkbox', { name: new RegExp(s.links.site) }).check();
  await page.getByRole('button', { name: 'Authorize' }).click();
  await expect.poll(() => callback).toContain('code=');
  const back = new URL(callback);
  expect(back.searchParams.get('state')).toBe('e2e');

  const token = await request.post('/api/v1/oauth/token', {
    form: { grant_type: 'authorization_code', code: back.searchParams.get('code')!, client_id, redirect_uri: REDIRECT, code_verifier: verifier, resource },
  });
  expect(token.status()).toBe(200);
  const { access_token, scope } = (await token.json()) as { access_token: string; scope: string };
  expect(scope).toBe('mcp:read');
  const mcp = (siteId: string) =>
    request.post('/api/v1/agents/mcp', {
      headers: { authorization: `Bearer ${access_token}` },
      data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'site_get', arguments: { siteId } } },
    });
  expect((await mcp(s.links.site)).status()).toBe(200);
  expect((await mcp(s.sites.a)).status()).toBe(403);

  // The connected agent is listed in Settings › Agent access and can be revoked there.
  await page.goto(`${ADMIN.path}/settings/agent-access`);
  const row = page.locator('[data-grant="E2E agent"]');
  await expect(row).toContainText('Read only');
  await row.getByRole('button', { name: 'Revoke' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Revoke' }).click();
  await expect(row).toHaveCount(0);
  expect((await mcp(s.links.site)).status()).toBe(401);
});

test('a personal access token is shown once and limited to its site', async ({ page, request }) => {
  const s = seed();
  await useSite(page, s.links.site);
  await signIn(page, ADMIN.email, ADMIN.password);
  await page.goto(`${ADMIN.path}/settings/agent-access`);
  await page.getByLabel('Token name').fill('E2E CLI');
  await page.getByRole('form', { name: 'New personal access token' }).getByRole('checkbox', { name: new RegExp(s.links.site) }).check();
  await page.getByRole('button', { name: 'Create token' }).click();
  const shown = page.getByLabel('Full token');
  await expect(shown).toContainText('hpo_pat_');
  const pat = (await shown.textContent())!.trim();
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('[data-grant="E2E CLI"]')).toContainText('Personal token');
  const call = (siteId: string) =>
    request.post('/api/v1/agents/mcp', { headers: { authorization: `Bearer ${pat}` }, data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'site_get', arguments: { siteId } } } });
  expect((await call(s.links.site)).status()).toBe(200);
  expect((await call(s.sites.a)).status()).toBe(403);
});
