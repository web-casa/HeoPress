import { expect, test, type Page } from '@playwright/test';
import { ADMIN, seed, signIn, useSite } from './fixtures';

/**
 * Plugin admin panels (HeoPress P12 tasks 3.5, 3.6; spec extensions/runtime-extensions "插件后台面板"). The seed installs
 * `e2e-linkcheck` on sites A, B and links, each with its own stored records. The editor writes on A only: the panel shows A's
 * records and never B's, and B's panel is refused. The plugin's own frontend page is not loaded until the operator
 * trusts the plugin.
 */

const FRONTEND = 'https://plugins.example.com/linkcheck/ui';

async function open(page: Page, site: string, email: string, password: string, language: 'en' | 'zh-CN' = 'en'): Promise<string> {
  await useSite(page, site);
  await page.addInitScript((lang) => window.localStorage.setItem('heopress.studio.language', lang), language);
  await signIn(page, email, password);
  return page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.startsWith('heopress.session.v2|'))!;
    return (JSON.parse(localStorage.getItem(key)!) as { token: string }).token;
  });
}

test('task 3.5: a member of site A sees A\'s plugin data only; site B\'s panel is refused', async ({ page }) => {
  const s = seed();
  const token = await open(page, s.sites.a, s.people.editor.email, s.password);
  await page.goto(`${ADMIN.path}/settings/plugins`);
  const card = page.getByRole('article', { name: 'Link checker' });
  await expect(card.locator('[data-widget="broken"]')).toContainText('Broken links2');
  await card.getByRole('link', { name: 'Results' }).click();
  const table = page.getByTestId('plugin-table');
  await expect(table).toContainText('https://site-a.example.com/page-1');
  await expect(table).toContainText('https://site-a.example.com/page-2');
  await expect(table).not.toContainText('site-b');
  // Settings are shown, read-only for a member without site administration.
  await page.goto(`${ADMIN.path}/settings/plugins/e2e-linkcheck/options`);
  await expect(page.getByLabel('Depth')).toHaveValue('2');
  await expect(page.getByLabel('Depth')).toBeDisabled();

  // Site B, by address: the server refuses the person who is not its member (the session is not valid there), and
  // nothing of B is returned.
  for (const path of ['/api/v1/plugins', '/api/v1/plugins/e2e-linkcheck/pages/results']) {
    const res = await page.request.get(path, { headers: { authorization: `Bearer ${token}`, 'x-heopress-site': s.sites.b } });
    expect([401, 403], path).toContain(res.status());
    expect(await res.text()).not.toContain('site-b.example.com');
  }
});

test('task 3.6: an untrusted plugin\'s own page is not loaded; after the operator trusts it, it is offered', async ({ page }) => {
  const s = seed();
  await open(page, s.links.site, ADMIN.email, ADMIN.password);
  const frontendRequests: string[] = [];
  page.on('request', (r) => {
    if (r.url().startsWith('https://plugins.example.com/')) frontendRequests.push(r.url());
  });

  await page.goto(`${ADMIN.path}/settings/plugins/e2e-linkcheck/dashboard`);
  await expect(page.getByText('This page needs the operator\'s trust')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open the plugin\'s page' })).toHaveCount(0);
  expect(await page.content()).not.toContain(FRONTEND);
  expect(frontendRequests).toEqual([]);

  // The operator marks the plugin as trusted on the Extensions page.
  await page.goto(`${ADMIN.path}/settings/advanced/extensions`);
  const ext = page.getByTestId('extension-e2e-linkcheck');
  page.once('dialog', (d) => void d.accept());
  await ext.getByRole('button', { name: 'Mark as trusted' }).click();
  await expect(ext.getByTestId('extension-trusted')).toBeVisible();

  await page.goto(`${ADMIN.path}/settings/plugins/e2e-linkcheck/dashboard`);
  await expect(page.getByRole('link', { name: 'Open the plugin\'s page' })).toHaveAttribute('href', FRONTEND);
  // It opens at the plugin's own address, never inside Studio.
  expect(frontendRequests).toEqual([]);

  // Leave the seed as it was.
  await page.goto(`${ADMIN.path}/settings/advanced/extensions`);
  await ext.getByRole('button', { name: 'Remove trust' }).click();
  await expect(ext.getByTestId('extension-trusted')).toHaveCount(0);
});

test('zh-CN: the plugin panels are translated', async ({ page }) => {
  const s = seed();
  await open(page, s.sites.a, s.people.editor.email, s.password, 'zh-CN');
  await page.goto(`${ADMIN.path}/settings/plugins/e2e-linkcheck/dashboard`);
  await expect(page.getByText('该页面需要运营者信任')).toBeVisible();
  await page.getByRole('link', { name: '← 插件' }).click();
  await expect(page.getByRole('heading', { name: '插件', level: 1 })).toBeVisible();
});
