import { expect, test } from '@playwright/test';
import { ADMIN, signIn, useSite } from './fixtures';

/**
 * Content settings, the sponsored-content policy (HeoPress P05 task 1.9;
 * spec content/site-network-model "关闭两个开关"): an administrator turns
 * both switches off; the page shows the risk of each and asks first;
 * cancelling saves nothing; confirming saves, with the reason.
 */

test('turning both sponsor switches off shows both risks, saves only once confirmed', async ({ page }) => {
  await useSite(page, '__default__');
  await signIn(page, ADMIN.email, ADMIN.password);
  await page.goto(`${ADMIN.path}/settings/content`);
  await expect(page.getByRole('heading', { name: 'Content', level: 1 })).toBeVisible();

  const disclosure = page.getByLabel(/Show a disclosure/);
  const rel = page.getByLabel(/Mark links as sponsored/);
  await expect(disclosure).toBeChecked();
  await expect(rel).toBeChecked();
  await disclosure.uncheck();
  await rel.uncheck();
  const save = page.getByRole('button', { name: 'Save', exact: true });
  // No reason, no save.
  await expect(save).toBeDisabled();
  await page.getByLabel('Reason for the change').fill('Trial without labels');
  await save.click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('No disclosure');
  await expect(dialog).toContainText('No rel="sponsored"');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel(/Show a disclosure/)).toBeChecked();

  await page.getByLabel(/Show a disclosure/).uncheck();
  await page.getByLabel(/Mark links as sponsored/).uncheck();
  await page.getByLabel('Reason for the change').fill('Trial without labels');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  // Keyboard: the dialog takes focus (on Cancel) and Escape cancels it.
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: /I understand the risks/ }).click();
  await expect(page.getByText('Saved. Sponsored items will be updated.')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel(/Show a disclosure/)).not.toBeChecked();
  await expect(page.getByLabel(/Mark links as sponsored/)).not.toBeChecked();
});

test('cross-site translations: off by default, the risk is spelled out, turning it on saves', async ({ page }) => {
  await useSite(page, '__default__');
  await signIn(page, ADMIN.email, ADMIN.password);
  await page.goto(`${ADMIN.path}/settings/content`);
  const section = page.getByRole('region', { name: 'Cross-site translations' });
  const allow = section.getByLabel(/Allow translation groups with other sites/);
  await expect(allow).not.toBeChecked();
  await expect(section.getByRole('note')).toContainText('ADR-0009');
  const save = section.getByRole('button', { name: 'Save cross-site setting' });
  await expect(save).toBeDisabled();
  await allow.check();
  await save.click();
  await expect(section.getByRole('status')).toContainText('Saved.');
  await page.reload();
  await expect(page.getByRole('region', { name: 'Cross-site translations' }).getByLabel(/Allow translation groups/)).toBeChecked();
  // Back off, as the other tests expect.
  await page.getByRole('region', { name: 'Cross-site translations' }).getByLabel(/Allow translation groups/).uncheck();
  await page.getByRole('button', { name: 'Save cross-site setting' }).click();
  await expect(page.getByRole('region', { name: 'Cross-site translations' }).getByRole('status')).toContainText('Saved.');
});
