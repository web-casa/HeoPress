import { expect, test, type Page } from '@playwright/test';
import { ADMIN, seed, signIn, useSite } from './fixtures';

/**
 * The article editor (HeoPress P07a tasks 6.1–6.4; spec studio/article-editor). The seed's links site has the draft
 * "Title editor-one" with two H2, one H3 and a short description.
 */

async function asAdmin(page: Page, email: string = ADMIN.email, password: string = ADMIN.password): Promise<void> {
  await useSite(page, seed().links.site);
  await page.addInitScript(() => window.localStorage.setItem('heopress.studio.language', 'en'));
  await signIn(page, email, password);
}

const url = () => `${ADMIN.path}/content/articles/${seed().links.editor}`;

test('tasks 6.1, 6.4: the outline follows the body and a short description only hints', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await asAdmin(page);
  await page.goto(url());
  const outline = page.getByRole('navigation', { name: 'Outline' });
  await expect(outline.getByRole('button')).toHaveText(['First part', 'A detail', 'Second part']);
  await outline.getByRole('button', { name: 'Second part' }).click();
  await expect(outline.getByRole('button', { name: 'Second part' })).toHaveAttribute('aria-current', 'location');
  await expect(page.getByText(/characters — short/)).toBeVisible();
  // The hint does not block saving.
  await page.getByLabel('Title', { exact: true }).fill('Title editor-one, edited');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
  await page.getByRole('tab', { name: 'Indexing and citation' }).click();
  await expect(page.getByText('/editor-one.md once published')).toBeVisible();
});

test('task 6.2: a failed save keeps the edits and can be retried', async ({ page }) => {
  await asAdmin(page);
  await page.goto(url());
  await page.getByLabel('Title', { exact: true }).fill('Kept through a failure');
  await page.route('**/api/v1/items/articles/**', (route) => (route.request().method() === 'PATCH' ? route.abort('internetdisconnected') : route.continue()));
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Save failed' })).toBeVisible();
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Kept through a failure');
  await page.unroute('**/api/v1/items/articles/**');
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
});

test('tasks 6.2, 6.3: two editors see each other; a conflicting save offers a merge', async ({ page, browser }) => {
  await asAdmin(page);
  await page.goto(url());
  const other = await browser.newContext();
  const page2 = await other.newPage();
  await asAdmin(page2, seed().people.colleague.email, seed().password);
  await page2.goto(url());
  // Presence: each sees the other.
  await expect(page.getByRole('group', { name: /Also here/ })).toBeVisible({ timeout: 15_000 });
  await expect(page2.getByRole('group', { name: /Also here/ })).toBeVisible();

  await page2.getByLabel('Title', { exact: true }).fill('Their title');
  await page2.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page2.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();

  await page.getByRole('tab', { name: 'SEO' }).click();
  await page.getByRole('group', { name: 'seo_title' }).getByRole('textbox').fill('My SEO title');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const alert = page.getByRole('alert').filter({ hasText: 'Someone else saved' });
  await expect(alert).toContainText('title');
  await alert.getByRole('button', { name: 'Keep their changes and mine' }).click();
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Their title');
  await expect(page.getByRole('group', { name: 'seo_title' }).getByRole('textbox')).toHaveValue('My SEO title');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
  await other.close();
});

test('task 6.2: changing a published article\'s address asks first, as the generic form does', async ({ page }) => {
  await asAdmin(page);
  await page.goto(`${ADMIN.path}/content/articles/${seed().links.move}`);
  await page.getByRole('tab', { name: 'Properties' }).click();
  const slug = page.getByRole('group', { name: 'slug' }).getByRole('textbox');
  await expect(slug).toHaveValue('impact-move');
  await slug.fill('impact-moved-here');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Pages that may be affected' });
  await expect(dialog).toContainText("Changing this page's address");
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await page.reload();
  await page.getByRole('tab', { name: 'Properties' }).click();
  await expect(page.getByRole('group', { name: 'slug' }).getByRole('textbox')).toHaveValue('impact-move');
  // Delete, unpublish and translations are in the full form.
  await page.getByRole('link', { name: 'All fields and actions' }).click();
  await expect(page.getByRole('button', { name: 'Delete' })).toBeVisible();
});
