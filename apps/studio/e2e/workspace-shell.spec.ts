import { expect, test, type Page } from '@playwright/test';
import { ADMIN, seed, signIn, useSite } from './fixtures';

/**
 * The Carbon workspace shell (HeoPress P07a, ADR-0019): module routes under
 * the private admin path, old addresses, the ⌘K palette, the narrow-screen
 * drawer and the saved appearance.
 */

const MODULES: Array<[string, string]> = [
  ['/overview', 'Overview'],
  ['/content', 'Content'],
  ['/sites', 'Sites'],
  ['/seo', 'SEO / GEO'],
  ['/ai-traffic', 'AI traffic'],
  ['/audit', 'Audit'],
  ['/monitoring', 'Logs & monitoring'],
  ['/settings/general', 'Settings'],
];

async function asAdmin(page: Page): Promise<void> {
  await useSite(page, seed().links.site);
  await page.addInitScript(() => window.localStorage.setItem('heopress.studio.language', 'en'));
  await signIn(page, ADMIN.email, ADMIN.password);
}

test('task 2.3: every module renders under the admin path, its rail entry selected', async ({ page }) => {
  await asAdmin(page);
  await expect(page).toHaveURL(new RegExp(`${ADMIN.path}/overview$`));
  for (const [path, label] of MODULES) {
    await page.goto(`${ADMIN.path}${path}`);
    const nav = page.getByRole('navigation', { name: 'Modules' });
    await expect(nav.getByRole('link', { name: label })).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('main#main-content')).not.toBeEmpty();
    await expect(page.getByText(/not found/i)).toHaveCount(0);
  }
});

test('task 2.4: an old AI traffic address with a query lands on the new view, query kept', async ({ page }) => {
  await asAdmin(page);
  await page.goto(`${ADMIN.path}/settings/ai-traffic?days=30`);
  await expect(page).toHaveURL(new RegExp(`${ADMIN.path}/ai-traffic\\?days=30$`));
  await expect(page.getByRole('navigation', { name: 'Modules' }).getByRole('link', { name: 'AI traffic' })).toHaveAttribute('aria-current', 'page');
  await page.goto(`${ADMIN.path}/files`);
  await expect(page).toHaveURL(new RegExp(`${ADMIN.path}/content/media$`));
});

test('task 2.5: ⌘K → type → Enter jumps to the view; focus returns after Esc', async ({ page }) => {
  await asAdmin(page);
  // The shortcut is bound once the shell is up.
  await expect(page.getByRole('navigation', { name: 'Modules' })).toBeVisible();
  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByRole('dialog', { name: 'Search' });
  await expect(palette).toBeVisible();
  await page.keyboard.type('Internal links');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`${ADMIN.path}/audit/links$`));

  const search = page.getByRole('navigation', { name: 'Modules' }).getByRole('button', { name: 'Search' });
  await search.focus();
  await page.keyboard.press('Enter');
  await expect(palette).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(palette).toBeHidden();
  await expect(search).toBeFocused();
});

test('task 2.2: at 390px the drawer opens from the menu, traps focus, closes on Esc and switches modules without sideways scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await asAdmin(page);
  const menu = page.getByRole('button', { name: 'Menu' });
  await menu.click();
  const drawer = page.getByRole('dialog', { name: 'Menu' });
  await expect(drawer).toBeVisible();
  for (let i = 0; i < 30; i += 1) await page.keyboard.press('Tab');
  expect(await drawer.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(menu).toBeFocused();

  await menu.click();
  await page.getByRole('dialog', { name: 'Menu' }).getByRole('link', { name: 'Audit' }).click();
  await expect(page).toHaveURL(new RegExp(`${ADMIN.path}/audit$`));
  await expect(page.getByRole('dialog', { name: 'Menu' })).toBeHidden();
  for (const [path] of MODULES) {
    await page.goto(`${ADMIN.path}${path}`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, path).toBeLessThanOrEqual(0);
  }
});

test('task 1.2: theme and density follow the account into another browser', async ({ page, browser }) => {
  await asAdmin(page);
  await page.goto(`${ADMIN.path}/settings/appearance`);
  await page.getByRole('main').getByText('Dark', { exact: true }).click();
  await page.getByText('Compact', { exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
  await expect(page.locator('html')).toHaveClass(/dark/);

  const other = await browser.newContext();
  const page2 = await other.newPage();
  await asAdmin(page2);
  await expect(page2.locator('html')).toHaveClass(/dark/);
  await expect(page2.locator('html')).toHaveAttribute('data-density', 'compact');

  // Put it back for the scenarios that follow.
  await page.getByRole('main').getByText('System', { exact: true }).click();
  await page.getByText('Comfortable', { exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-density', 'comfortable');
  await other.close();
});
