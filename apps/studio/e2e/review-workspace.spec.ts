import { expect, test, type Page } from '@playwright/test';
import { ADMIN, seed, signIn, useSite } from './fixtures';

/**
 * The review workspace (HeoPress P07a tasks 5.3, 5.5, 5.6, 2.8; spec studio/review-workspace). The seed submits three
 * articles of the links site for review ("Title review-one" … "-three").
 */

async function asAdmin(page: Page): Promise<void> {
  await useSite(page, seed().links.site);
  await page.addInitScript(() => window.localStorage.setItem('heopress.studio.language', 'en'));
  await signIn(page, ADMIN.email, ADMIN.password);
}

test('task 5.3: view, filter and selection are in the address and survive a reload', async ({ page }) => {
  await asAdmin(page);
  await page.goto(`${ADMIN.path}/content?view=pending&q=review-two`);
  const list = page.getByRole('region', { name: 'Waiting for review' });
  await expect(list.getByRole('button', { name: /Title review-two/ })).toBeVisible();
  await expect(list.getByRole('button', { name: /Title review-one/ })).toHaveCount(0);
  await list.getByRole('button', { name: /Title review-two/ }).click();
  await expect(page).toHaveURL(/item=articles/);
  await page.reload();
  await expect(page.getByRole('button', { name: /^Waiting for review \d*$/ })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('complementary', { name: 'Title review-two' })).toBeVisible();
});

test('task 5.5: sending back needs a reason; approving selects the next item', async ({ page }) => {
  await asAdmin(page);
  await page.goto(`${ADMIN.path}/content?view=pending`);
  const list = page.getByRole('region', { name: 'Waiting for review' });
  await list.getByRole('button', { name: /Title review-three/ }).click();
  const detail = page.getByRole('complementary', { name: 'Title review-three' });
  await detail.getByRole('button', { name: 'Send back', exact: true }).click();
  await detail.getByRole('button', { name: 'Send back' }).last().click();
  await expect(detail.getByRole('alert')).toContainText('Write a reason');
  await detail.getByLabel('Why is it sent back?').fill('Add the data source');
  await detail.getByRole('button', { name: 'Send back' }).last().click();
  // Moved on to another item waiting for review.
  await expect(page.getByRole('complementary', { name: 'Title review-three' })).toHaveCount(0);
  await expect(page).toHaveURL(/item=articles/);
});

test('tasks 5.6, 2.8: with the keyboard only — overview, review workspace, approve', async ({ page }) => {
  await asAdmin(page);
  await expect(page).toHaveURL(/\/overview/);
  await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();
  await page.keyboard.press('g');
  await page.keyboard.press('c');
  await expect(page).toHaveURL(new RegExp(`${ADMIN.path}/content`));
  await page.getByRole('button', { name: /^Waiting for review \d*$/ }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('region', { name: 'Waiting for review' }).getByRole('button').first()).toBeVisible();
  await page.keyboard.press('j');
  const detail = page.getByRole('complementary').filter({ hasText: 'Title review-' });
  await expect(detail).toBeVisible();
  const title = (await detail.getByRole('heading', { level: 2 }).innerText()).trim();
  await page.keyboard.press('ControlOrMeta+Enter');
  // Failing checks first ask for a second confirmation, which also takes Enter.
  const confirm = page.getByRole('alertdialog', { name: 'Approve anyway' });
  if (await confirm.isVisible().catch(() => false)) await page.keyboard.press('Enter');
  await expect(page.getByRole('region', { name: 'Waiting for review' }).getByRole('button', { name: new RegExp(title) })).toHaveCount(0);
});
