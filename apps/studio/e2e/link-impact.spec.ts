import { expect, test, type Page } from '@playwright/test';
import { ADMIN, seed, signIn, useSite } from './fixtures';

/**
 * Change impact in Studio (HeoPress P07 task 5.5; spec seo/link-graph "变更影响预览"): before a published page with links to
 * it is deleted or moved, Studio lists the pages that may be affected and offers a redirect or updated links; going on or
 * cancelling is the editor's choice.
 */

// The generic form (`?form=full`) has delete and unpublish; the article editor's own address guard is in article-editor.spec.ts.
const itemUrl = (id: string) => `${ADMIN.path}/content/articles/${id}?form=full`;
const dialogOf = (page: Page) => page.getByRole('dialog', { name: 'Pages that may be affected' });

test.beforeEach(async ({ page }) => {
  const s = seed();
  await useSite(page, s.links.site);
  await signIn(page, ADMIN.email, ADMIN.password);
});

test('deleting a linked page: the linking page is listed; a redirect is added, then the page is deleted', async ({ page }) => {
  const s = seed();
  await page.goto(itemUrl(s.links.delete));
  await page.getByRole('button', { name: 'Delete' }).click();
  const dialog = dialogOf(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('list', { name: 'Linking pages' })).toContainText('Title impact-source');
  await expect(dialog.getByRole('list', { name: 'Linking pages' })).toContainText('/impact-delete/');
  await dialog.getByLabel("Another page's address").fill(`https://${s.links.host}/impact-dest/`);
  await dialog.getByRole('button', { name: 'Create redirect' }).click();
  await expect(dialog.getByRole('status')).toContainText('Redirect added: /impact-delete → /impact-dest');
  await dialog.getByRole('button', { name: 'Delete anyway' }).click();
  await expect(page).toHaveURL(new RegExp(`${ADMIN.path}/content/articles$`));
});

test('updating the links to another address; cancelling keeps the page', async ({ page }) => {
  const s = seed();
  await page.goto(itemUrl(s.links.update));
  await page.getByRole('button', { name: 'Delete' }).click();
  const dialog = dialogOf(page);
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Another page's address").fill(`https://${s.links.host}/impact-dest/`);
  await dialog.getByRole('button', { name: 'Update links' }).click();
  await expect(dialog.getByRole('status')).toContainText('Links updated in 1 page');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`${ADMIN.path}/content/articles/${s.links.update}`));
});

test('changing a linked page\'s address asks first; cancelling saves nothing', async ({ page }) => {
  const s = seed();
  await page.goto(itemUrl(s.links.move));
  const slug = page.getByRole('group', { name: 'slug' }).getByRole('textbox');
  await expect(slug).toHaveValue('impact-move');
  await slug.fill('impact-moved');
  await page.getByRole('button', { name: /^save/i }).first().click();
  const dialog = dialogOf(page);
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Changing this page's address");
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await page.reload();
  await expect(page.getByRole('group', { name: 'slug' }).getByRole('textbox')).toHaveValue('impact-move');
});

test('unpublishing a linked page asks first (Codex review of task 5.5); cancelling leaves it published', async ({ page }) => {
  const s = seed();
  await page.goto(itemUrl(s.links.unpublish));
  await page.getByTestId('editorial-actions').getByRole('button', { name: 'Unpublish' }).click();
  const dialog = dialogOf(page);
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Unpublishing this page');
  await expect(dialog.getByRole('list', { name: 'Linking pages' })).toContainText('/impact-unpublish/');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await page.reload();
  await expect(page.getByTestId('editorial-actions')).toContainText(/published/i);
});
