import { expect, test } from '@playwright/test';
import { ADMIN, signIn, useSite } from './fixtures';

/**
 * The overview across sites (HeoPress P07a task 3.3; spec studio/network-summary "从概要进入修改"): a change starts on
 * the site it belongs to — Studio switches to it first, then opens the page there.
 */

test('from "All sites", reviewing on another site switches to it first, then opens its review workspace', async ({ page }) => {
  await useSite(page, '__default__');
  await page.addInitScript(() => window.localStorage.setItem('heopress.studio.language', 'en'));
  await signIn(page, ADMIN.email, ADMIN.password);
  await page.goto(`${ADMIN.path}/overview`);
  await page.getByRole('radio', { name: 'All sites' }).click();
  const reviews = page.getByRole('button', { name: /Review \d+ items?/ });
  await reviews.click();
  await page.getByRole('button', { name: /Site Links/ }).click();
  await expect(page).toHaveURL(new RegExp(`${ADMIN.path}/content\\?view=pending`));
  // The session is now the links site's: its items waiting for review are listed.
  await expect(page.getByRole('region', { name: 'Waiting for review' }).getByRole('button', { name: /Title review-/ }).first()).toBeVisible();
});
