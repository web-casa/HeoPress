import { expect, test, type Page } from '@playwright/test';
import { ADMIN, seed, signIn, useSite } from './fixtures';

/**
 * The SEO / GEO module (HeoPress P07a tasks 8.2–8.4; spec studio/seo-settings), on the seed's links site: the bootstrap
 * administrator, and the editor as a member without site administration.
 */

async function open(page: Page, email: string = ADMIN.email, password: string = ADMIN.password): Promise<void> {
  await useSite(page, seed().links.site);
  await page.addInitScript(() => window.localStorage.setItem('heopress.studio.language', 'en'));
  await signIn(page, email, password);
}

const SECTIONS: Array<[string, string]> = [
  ['/seo', 'Search appearance'],
  ['/seo/crawlers', 'AI crawler policy'],
  ['/seo/machine', 'Machine-readable output'],
  ['/seo/canonical', 'Canonical domain'],
  ['/seo/identity', 'Site identity'],
  ['/seo/root-files', 'Root files'],
  ['/seo/redirects', 'Redirects'],
];

test('task 8.2: a member sees every section, with its controls off and the reason', async ({ page }) => {
  await open(page, seed().people.editor.email, seed().password);
  for (const [path, title] of SECTIONS) {
    await page.goto(`${ADMIN.path}${path}`);
    const section = page.getByRole('region', { name: title });
    await expect(section.getByRole('heading', { name: title, level: 1 })).toBeVisible();
    await expect(section.getByRole('note')).toContainText('needs site administrator rights');
    // A disabled fieldset turns every control off.
    await expect(section.locator('fieldset input, fieldset select, fieldset textarea, fieldset button').first()).toBeDisabled();
  }
  // Disabled for real: the preset cannot be picked.
  await page.goto(`${ADMIN.path}/seo/crawlers`);
  await expect(page.getByRole('radio', { name: 'Block all' })).toBeDisabled();
});

test('task 8.3: the preview follows the policy at once; the stored policy changes only on save', async ({ page, context }) => {
  await open(page);
  await page.goto(`${ADMIN.path}/seo/crawlers`);
  await page.getByRole('radio', { name: 'Block all' }).click();
  const meaning = page.getByRole('region', { name: 'What this means for AI' });
  await expect(meaning).toContainText("AI assistants will not read and cite this site's articles");
  // What robots.txt is written from is unchanged: another tab reads the stored policy.
  const other = await context.newPage();
  await other.goto(`${ADMIN.path}/seo/crawlers`);
  await expect(other.getByRole('radio', { name: 'Allow all' })).toHaveAttribute('aria-checked', 'true');

  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('robots.txt');
  await other.reload();
  await expect(other.getByRole('radio', { name: 'Block all' })).toHaveAttribute('aria-checked', 'true');
  // Back to the seed's policy for the other scenarios.
  await other.getByRole('radio', { name: 'Allow all' }).click();
  await other.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(other.getByRole('status')).toContainText('robots.txt');
  await other.close();
});

test('task 8.4: discarding restores both changes; errors block saving; leaving asks first', async ({ page }) => {
  await open(page);
  await page.goto(`${ADMIN.path}/seo`);
  const template = page.getByLabel('Title template');
  const index = page.getByLabel('Let search engines index this site');
  const before = await template.inputValue();
  await template.fill('{title} — Links');
  await index.uncheck();
  const bar = page.getByRole('region', { name: 'Unsaved changes' });
  await expect(bar).toContainText('2 unsaved changes');
  await expect(page.getByRole('region', { name: 'Search result preview' })).toContainText('asked not to index');
  await bar.getByRole('button', { name: 'Discard' }).click();
  await expect(template).toHaveValue(before);
  await expect(index).toBeChecked();
  await expect(bar).toHaveCount(0);

  await template.fill('no placeholder');
  await expect(page.getByText('Include {title}')).toBeVisible();
  await expect(bar.getByRole('button', { name: 'Fix 1 error first' })).toBeDisabled();

  // Leaving with unsaved changes asks; staying keeps them.
  page.once('dialog', (d) => void d.dismiss());
  await page.getByRole('link', { name: 'AI crawlers' }).click();
  await expect(page).toHaveURL(new RegExp(`${ADMIN.path}/seo$`));
  await expect(template).toHaveValue('no placeholder');
  await bar.getByRole('button', { name: 'Discard' }).click();

  await page.goto(`${ADMIN.path}/seo/canonical`);
  const host = page.getByRole('combobox', { name: 'Canonical domain' });
  await expect(host).toHaveValue(seed().links.host);
  await host.fill('nowhere.example.com');
  await expect(page.getByText('This domain is not bound to this site.')).toBeVisible();
  await expect(bar.getByRole('button', { name: 'Fix 1 error first' })).toBeDisabled();
  await bar.getByRole('button', { name: 'Discard' }).click();
});
