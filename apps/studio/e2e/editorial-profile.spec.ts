import { expect, test } from '@playwright/test';
import { ADMIN, signIn, useSite } from './fixtures';

/**
 * Editorial profile (HeoPress P05 task 2.3; spec content/editorial-profiles
 * "修改编辑策略"): an administrator writes a profile, saves it as a version,
 * puts it in effect; a change is a new version and the earlier one stays
 * readable in the history.
 */

test('an administrator creates and publishes an editorial profile version; a change is a new version', async ({ page }) => {
  await useSite(page, '__default__');
  await signIn(page, ADMIN.email, ADMIN.password);
  await page.goto(`${ADMIN.path}/settings/editorial-profile`);
  await expect(page.getByRole('heading', { name: 'Editorial profile', level: 1 })).toBeVisible();
  await expect(page.getByText('No version is in effect yet.')).toBeVisible();

  await page.getByLabel('Audience').fill('Operators of small site networks');
  await page.getByLabel('Tone').fill('Plain and direct');
  await page.getByLabel('Glossary').fill('site network = 站群');
  await page.getByLabel('Forbidden topics').fill('gambling');
  await page.getByRole('button', { name: 'Save as new version' }).click();
  await expect(page.getByText('Saved as version 1 (a draft).')).toBeVisible();

  const v1 = page.getByRole('listitem', { name: 'Version 1' });
  await v1.getByRole('button', { name: 'Put in effect' }).click();
  await expect(page.getByText('Version 1 is in effect.', { exact: false }).first()).toBeVisible();

  await page.getByLabel('Tone').fill('Warm and practical');
  await page.getByRole('button', { name: 'Save as new version' }).click();
  await expect(page.getByText('Saved as version 2 (a draft).')).toBeVisible();
  // Version 1 is still in effect and readable.
  await page.getByRole('listitem', { name: 'Version 1' }).getByRole('button', { name: /Version 1/ }).click();
  await expect(page.getByLabel('Tone')).toHaveValue('Plain and direct');
  await page.getByRole('listitem', { name: 'Version 2' }).getByRole('button', { name: 'Put in effect' }).click();
  await expect(page.getByText('Version 2 is now in effect.')).toBeVisible();
  await expect(page.getByRole('listitem', { name: 'Version 1' })).toContainText('superseded');
});
