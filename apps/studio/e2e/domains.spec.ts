import { expect, test } from '@playwright/test';
import { ADMIN, signIn, useSite } from './fixtures';

/**
 * Domains page (HeoPress P04 task 5.6): an administrator adds a custom
 * domain with a language entry, sees the record to publish, and is told why
 * verification has not succeeded yet. The domain stays pending (it serves
 * nothing) until its token is found. A language entry is one of the site's
 * other languages (P05): the site gets French first.
 */

test('an administrator adds a domain, sees its record and why it is not verified yet', async ({ page }) => {
  await useSite(page, '__default__');
  await signIn(page, ADMIN.email, ADMIN.password);
  const token = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.startsWith('heopress.session.v2|'))!;
    return (JSON.parse(localStorage.getItem(key)!) as { token: string }).token;
  });
  const headers = { authorization: `Bearer ${token}`, 'x-heopress-site': '__default__', 'content-type': 'application/json' };
  const current = (await (await page.request.get('/api/v1/site/content-settings', { headers })).json()) as { data: Record<string, unknown> };
  const saved = await page.request.put('/api/v1/site/content-settings', { headers, data: { ...current.data, availableLocales: ['en', 'fr'] } });
  expect(saved.status(), await saved.text()).toBe(200);
  await page.goto(`${ADMIN.path}/settings/domains`);
  await expect(page.getByRole('heading', { name: 'Domains', level: 1 })).toBeVisible();

  await page.getByRole('button', { name: 'Setup domain' }).click();
  await page.getByLabel('Domain', { exact: true }).fill('shop.e2e.example.test');
  await page.getByLabel('Language entry (optional)').fill('fr');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByText('_heopress-challenge.shop.e2e.example.test').first()).toBeVisible();
  await page.getByRole('button', { name: 'Done' }).click();

  const row = page.getByRole('listitem', { name: 'shop.e2e.example.test' });
  await expect(row.getByText('Pending verification')).toBeVisible();
  await expect(row.getByText('Language entry: fr')).toBeVisible();
  await expect(row.getByText(/Token valid until/)).toBeVisible();
  await row.getByRole('button', { name: 'Verify' }).click();
  await expect(row.getByRole('alert')).toContainText('not found yet');
  await expect(row.getByText('Pending verification')).toBeVisible();
});
