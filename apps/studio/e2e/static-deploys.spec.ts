import { expect, test, type Page } from '@playwright/test';
import { ADMIN, seed, signIn, useSite } from './fixtures';

/**
 * Settings › Advanced › Deployments, the static site (HeoPress P11 task 4.3; spec publishing/frontend-deployments "选择
 * Vercel"): the Vercel Hobby notice, the Cloudflare Pages target format, turning the Astro engine on for the site with the
 * own server as target, the support matrix, and a rollback that is not offered without an earlier successful deploy.
 */

async function asAdmin(page: Page): Promise<void> {
  await useSite(page, seed().links.site);
  await page.addInitScript(() => window.localStorage.setItem('heopress.studio.language', 'en'));
  await signIn(page, ADMIN.email, ADMIN.password);
}

test('task 4.3: choosing Vercel says the Hobby plan forbids commercial use; Cloudflare Pages asks for account/project', async ({ page }) => {
  await asAdmin(page);
  await page.goto(`${ADMIN.path}/settings/advanced/deployments`);
  await page.getByRole('button', { name: 'Connect target' }).click();
  const provider = page.getByRole('combobox', { name: 'Provider' });
  await expect(provider).toHaveValue('vercel');
  await expect(page.getByRole('note')).toContainText('Hobby plan does not allow commercial use');
  await provider.selectOption('cloudflare-pages');
  await expect(page.getByRole('note')).toHaveCount(0);
  await expect(page.getByText('Format: <account id>/<project name>')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
});

test('task 4.3: the Astro engine is turned on with the own server as target; the matrix says what a static site cannot serve', async ({ page }) => {
  await asAdmin(page);
  await page.goto(`${ADMIN.path}/settings/advanced/deployments`);
  const section = page.getByRole('region', { name: 'Static site (Astro engine)' });
  await expect(section.getByText(/Published revision \d+/)).toBeVisible();
  await section.getByRole('checkbox', { name: 'Build with the Astro engine' }).check();
  await expect(section.getByRole('combobox', { name: 'Deploy to' })).toHaveValue('');
  await section.getByRole('button', { name: 'Save' }).click();
  await expect(section.getByRole('status')).toContainText('A build has been requested');
  const matrix = section.getByRole('region', { name: 'What this target can serve' });
  await expect(matrix.getByRole('listitem').filter({ hasText: 'Site search' })).toContainText('Unavailable');
  await expect(matrix.getByRole('listitem').filter({ hasText: 'Draft preview' })).toContainText('Unavailable');
  await expect(matrix.getByRole('listitem').filter({ hasText: '410 for withdrawn pages' })).toContainText('Supported');
  await expect(section.getByRole('region', { name: 'Static deploys' })).toContainText('No static deploys yet.');
  await expect(section.getByRole('button', { name: 'Roll back to previous deploy' })).toBeDisabled();
  await page.reload();
  await expect(page.getByRole('region', { name: 'Static site (Astro engine)' }).getByRole('checkbox', { name: 'Build with the Astro engine' })).toBeChecked();
});
