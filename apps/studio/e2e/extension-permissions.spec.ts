import { expect, test, type Page } from '@playwright/test';
import { ADMIN, seed, signIn, useSite } from './fixtures';

/**
 * Plugin permissions (HeoPress P12 task 1.2; spec extensions/permissions "安装与升级审批"): installing shows every
 * requested capability and needs the admin's approval; an upgrade adding an outbound host shows the diff, and the
 * old version keeps running until the admin approves it. The e2e server runs in development mode, where an unsigned
 * bundle is accepted.
 */

async function open(page: Page, language: 'en' | 'zh-CN' = 'en'): Promise<{ token: string; site: string }> {
  const site = seed().links.site;
  await useSite(page, site);
  await page.addInitScript((lang) => window.localStorage.setItem('heopress.studio.language', lang), language);
  await signIn(page, ADMIN.email, ADMIN.password);
  const token = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.startsWith('heopress.session.v2|'))!;
    return (JSON.parse(localStorage.getItem(key)!) as { token: string }).token;
  });
  return { token, site };
}

test('install shows the requested permissions; an upgrade adding a host waits for approval with its diff', async ({ page }) => {
  const { token, site } = await open(page);
  const name = `e2e-plugin-${Date.now().toString(36)}`;
  await page.goto(`${ADMIN.path}/settings/extensions`);

  const form = page.getByRole('form', { name: 'Install a plugin' });
  await form.getByLabel('Name').fill(name);
  await form.getByLabel('Bundle URL').fill('https://example.com/e2e-plugin-v1.js');
  await form.getByLabel('Capabilities (one per line)').fill('items:read:articles\next:events');
  await form.getByLabel('Outbound hosts (one per line)').fill('api.example.com');
  await form.getByRole('button', { name: 'Review permissions' }).click();

  // The approval dialog lists every capability, grouped, as sentences.
  const dialog = page.getByRole('dialog', { name: `Install ${name}?` });
  await expect(dialog.getByText('Send requests to api.example.com')).toBeVisible();
  await expect(dialog.getByText('Read items of articles')).toBeVisible();
  await expect(dialog.getByText('Receive content events and hooks')).toBeVisible();
  await dialog.getByRole('button', { name: 'Approve and install' }).click();
  await expect(dialog).toHaveCount(0);

  const card = page.getByTestId(`extension-${name}`);
  await expect(card).toContainText('v1.0.0');
  await expect(card.locator('[data-capability="http:fetch:api.example.com"]')).toBeVisible();

  // A new version adds an outbound host: staged, not applied.
  const headers = { authorization: `Bearer ${token}`, 'x-heopress-site': site, 'content-type': 'application/json' };
  const list = (await (await page.request.get('/api/v1/extensions', { headers })).json()) as { data: Array<{ id: string; name: string }> };
  const id = list.data.find((e) => e.name === name)!.id;
  const staged = await page.request.post(`/api/v1/extensions/${id}/upgrade`, {
    headers,
    data: {
      version: '1.1.0',
      bundleUrl: 'https://example.com/e2e-plugin-v2.js',
      capabilities: ['items:read:articles', 'ext:events'],
      manifest: { outboundHosts: ['api.example.com', 'cdn.example.com'] },
    },
  });
  expect(staged.status(), await staged.text()).toBe(200);
  expect(((await staged.json()) as { data: { status: string } }).data.status).toBe('pending-approval');

  await page.reload();
  await expect(card).toContainText('v1.0.0');
  const pending = card.getByTestId('pending-upgrade');
  await expect(pending).toContainText('Version 1.1.0 is waiting: it requests 1 new permission.');
  await pending.getByRole('button', { name: 'Review upgrade' }).click();

  const upgrade = page.getByRole('dialog', { name: `Upgrade ${name} to 1.1.0?` });
  const added = upgrade.locator('[data-capability="http:fetch:cdn.example.com"]');
  await expect(added).toContainText('New');
  await expect(added).toContainText('Send requests to cdn.example.com');
  await expect(upgrade.locator('[data-capability="http:fetch:api.example.com"]')).not.toContainText('New');
  await upgrade.getByRole('button', { name: 'Approve and upgrade' }).click();
  await expect(upgrade).toHaveCount(0);

  await expect(card).toContainText('v1.1.0');
  await expect(card.getByTestId('pending-upgrade')).toHaveCount(0);
  await expect(card.locator('[data-capability="http:fetch:cdn.example.com"]')).toBeVisible();
});

test('zh-CN: the approval dialog is translated', async ({ page }) => {
  await open(page, 'zh-CN');
  await page.goto(`${ADMIN.path}/settings/extensions`);
  const form = page.getByRole('form', { name: '安装插件' });
  await form.getByLabel('名称').fill(`e2e-zh-${Date.now().toString(36)}`);
  await form.getByLabel('包地址').fill('https://example.com/e2e-zh.js');
  await form.getByLabel('能力（每行一个）').fill('items:publish:articles');
  await form.getByRole('button', { name: '查看权限' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('发布 articles 的条目')).toBeVisible();
  await expect(dialog.getByRole('heading', { name: '发布' })).toBeVisible();
  await dialog.getByRole('button', { name: '取消' }).click();
  await expect(dialog).toHaveCount(0);
});
