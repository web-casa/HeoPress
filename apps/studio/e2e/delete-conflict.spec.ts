import { expect, test } from '@playwright/test';
import { ADMIN, seed, signIn, useSite } from './fixtures';

/**
 * Deleting at the version Studio shows (HeoPress P14 task 6.4; spec content/write-concurrency "基于版本的条件删除"):
 * when another session saved the item after it was opened here, the delete is refused (409), Studio says the item was
 * changed by someone else and nothing is deleted; reloading shows the change, and a delete then goes through.
 */

const itemUrl = (id: string) => `${ADMIN.path}/content/articles/${id}?form=full`;

test('a delete after another session saved is refused; reload shows the change; then it deletes', async ({ browser }) => {
  const s = seed();
  const mine = await browser.newPage();
  const theirs = await browser.newPage({ storageState: undefined });
  for (const [page, email, password] of [
    [mine, ADMIN.email, ADMIN.password],
    [theirs, s.people.colleague.email, s.password],
  ] as const) {
    await useSite(page, s.links.site);
    await signIn(page, email, password);
    await page.goto(itemUrl(s.links.deleteConflict));
    await expect(page.getByRole('group', { name: 'title', exact: true }).getByRole('textbox')).toHaveValue('Title delete-conflict');
  }
  await theirs.getByRole('group', { name: 'title', exact: true }).getByRole('textbox').fill('Changed in the other session');
  await theirs.getByRole('button', { name: /^save/i }).first().click();
  await expect(theirs.getByRole('button', { name: 'Saved' })).toBeVisible();

  const refused = mine.waitForResponse((r) => r.request().method() === 'DELETE' && r.url().includes(s.links.deleteConflict));
  await mine.getByRole('button', { name: 'Delete' }).click();
  expect((await refused).status()).toBe(409);
  const dialog = mine.getByRole('alertdialog', { name: 'Changed by someone else' });
  await expect(dialog).toContainText('Not deleted');
  await dialog.getByRole('button', { name: 'Reload the item' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(mine).toHaveURL(new RegExp(`${ADMIN.path}/content/articles/${s.links.deleteConflict}`));
  await expect(mine.getByRole('group', { name: 'title', exact: true }).getByRole('textbox')).toHaveValue('Changed in the other session');

  // At the version it now shows, the delete goes through.
  await mine.getByRole('button', { name: 'Delete' }).click();
  await expect(mine).toHaveURL(new RegExp(`${ADMIN.path}/content/articles$`));
});
