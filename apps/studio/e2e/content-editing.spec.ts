import { expect, test, type Page } from '@playwright/test';
import { ADMIN, seed, signIn, useSite } from './fixtures';

/**
 * Editing content in Studio (HeoPress P04 task 9.4): a writer with a
 * restricted role edits a draft of site A; site B is not theirs; when a
 * colleague saved first, the save is refused with the conflict shown and
 * the edits kept.
 */

const itemUrl = (id: string) => `${ADMIN.path}/content/articles/${id}`;
const titleOf = (page: Page) => page.getByRole('group', { name: 'title' }).getByRole('textbox');

test('a restricted writer edits a draft on site A', async ({ page }) => {
  const s = seed();
  await useSite(page, s.sites.a);
  await signIn(page, s.people.editor.email, s.password);
  await page.goto(itemUrl(s.articles.a));
  const title = titleOf(page);
  await expect(title).toHaveValue('Draft on A');
  await title.fill('Edited on A');
  await page.getByRole('button', { name: /^save/i }).first().click();
  await expect(page.getByRole('button', { name: 'Saved' })).toBeVisible();
  await page.reload();
  await expect(titleOf(page)).toHaveValue('Edited on A');
});

test('site B is not open to a writer of site A', async ({ page }) => {
  const s = seed();
  await useSite(page, s.sites.b);
  await page.goto(`${ADMIN.path}/login`);
  await page.getByLabel(/email/i).fill(s.people.editor.email);
  await page.getByLabel(/password/i).fill(s.password);
  await page.getByRole('button', { name: /sign in|log in/i }).click();
  // Not a member of B: no session for B.
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole('alert')).toBeVisible();
  // And B's article is not reachable without one: the admin URL answers
  // "Not found" to a visitor without a session (private admin path).
  await page.goto(itemUrl(s.articles.b));
  await expect(page.getByRole('heading', { name: 'Not found' })).toBeVisible();
  await expect(page.getByText('Draft on B')).toHaveCount(0);
});

test('a session of site A cannot read or change site B', async ({ page }) => {
  const s = seed();
  await useSite(page, s.sites.a);
  await signIn(page, s.people.editor.email, s.password);
  const token = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.startsWith('heopress.session.v2|'))!;
    return (JSON.parse(localStorage.getItem(key)!) as { token: string }).token;
  });
  const asB = { authorization: `Bearer ${token}`, 'x-heopress-site': s.sites.b };
  const url = `/api/v1/items/articles/${s.articles.b}`;
  expect([401, 403]).toContain((await page.request.get(url, { headers: asB })).status());
  const patch = await page.request.patch(url, { headers: { ...asB, 'content-type': 'application/json' }, data: { data: { title: 'From A' } } });
  expect([401, 403]).toContain(patch.status());
});

test('a save after a colleague saved is refused as a conflict, keeping the edits', async ({ browser }) => {
  const s = seed();
  const mine = await browser.newPage();
  const theirs = await browser.newPage({ storageState: undefined });
  for (const [page, who] of [
    [mine, s.people.editor],
    [theirs, s.people.colleague],
  ] as const) {
    await useSite(page, s.sites.a);
    await signIn(page, who.email, s.password);
    await page.goto(itemUrl(s.articles.a));
    await expect(titleOf(page)).not.toHaveValue('');
  }
  await titleOf(theirs).fill('Colleague was first');
  await theirs.getByRole('button', { name: /^save/i }).first().click();
  await expect(theirs.getByRole('button', { name: 'Saved' })).toBeVisible();

  await titleOf(mine).fill('My late edit');
  const refused = mine.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().includes(s.articles.a));
  await mine.getByRole('button', { name: /^save/i }).first().click();
  expect((await refused).status()).toBe(409);
  await expect(mine.getByTestId('save-error')).toContainText('someone changed this item');
  await expect(titleOf(mine)).toHaveValue('My late edit');
});
