import { expect, test } from '@playwright/test';
import { ADMIN, seed, signIn, useSite } from './fixtures';

/**
 * AI traffic in Studio (HeoPress P07 task 6.2, P07a tasks 7.2–7.4; specs analytics/ai-traffic, studio/ai-traffic-view):
 * the figures the rendering service recorded — the totals, by crawler, the page AI crawlers read most and where an
 * assistant sent a visitor — with the period and metric in the address.
 */

test('an administrator sees the site\'s AI traffic: totals, crawlers, most read, AI-referred landing pages', async ({ page }) => {
  const s = seed();
  await useSite(page, s.links.site);
  await page.addInitScript(() => window.localStorage.setItem('heopress.studio.language', 'en'));
  await signIn(page, ADMIN.email, ADMIN.password);
  // The old address lands on the module.
  await page.goto(`${ADMIN.path}/settings/ai-traffic`);
  await expect(page).toHaveURL(new RegExp(`${ADMIN.path}/ai-traffic`));
  await expect(page.getByRole('heading', { name: 'AI traffic', level: 1 })).toBeVisible();
  const crawlerTab = page.getByRole('tab', { name: /AI crawler reads/ });
  await expect(crawlerTab).toContainText('3');
  await expect(page.getByRole('group', { name: 'AI crawler reads per day' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'By crawler and assistant' })).toContainText('perplexity-user');
  await expect(page.getByRole('region', { name: 'Most read by AI crawlers' })).toContainText('/impact-dest/');
  await expect(page.getByRole('region', { name: 'Where AI assistants send visitors' })).toContainText('chatgpt');
  // The metric and the period go into the address.
  await page.getByRole('tab', { name: /AI-referred visits/ }).click();
  await expect(page).toHaveURL(/metric=referral/);
  await page.getByRole('radio', { name: '7 days' }).click();
  await expect(page).toHaveURL(/days=7/);
  await expect(page.getByRole('group', { name: 'AI-referred visits per day' })).toBeVisible();
  // No visitor address or query string is ever shown.
  const text = await page.locator('main').innerText();
  expect(text).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  expect(text).not.toContain('utm_source');
});
