import { expect, test } from '@playwright/test';
import { ADMIN, seed, signIn, useSite } from './fixtures';

/**
 * AI traffic in Studio (HeoPress P07 task 6.2; spec analytics/ai-traffic): the figures the rendering service recorded —
 * the totals, by crawler, the page AI crawlers read most and where an assistant sent a visitor.
 */

test('an administrator sees the site\'s AI traffic: totals, crawlers, most read, AI-referred landing pages', async ({ page }) => {
  const s = seed();
  await useSite(page, s.links.site);
  await signIn(page, ADMIN.email, ADMIN.password);
  await page.goto(`${ADMIN.path}/settings/ai-traffic`);
  await expect(page.getByRole('heading', { name: 'AI traffic', level: 1 })).toBeVisible();
  const totals = page.getByRole('region', { name: 'Totals' });
  await expect(totals).toContainText('Crawler reads');
  await expect(totals).toContainText('3');
  await expect(page.getByRole('img', { name: 'AI reads and referred visits per day' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'By crawler and assistant' })).toContainText('perplexity-user');
  await expect(page.getByRole('region', { name: 'Most read by AI crawlers' })).toContainText('/impact-dest/');
  await expect(page.getByRole('region', { name: 'Where AI assistants send visitors' })).toContainText('chatgpt · 1');
});
