import { expect, test, type Page } from '@playwright/test';
import { ADMIN, signIn, useSite } from './fixtures';

/**
 * Translation group panel (HeoPress P05 task 4.3; spec
 * i18n/translation-groups; design D "Studio"): an editor starts a group from
 * an article, adds its Chinese version, and the panel lists both with their
 * language, role and status; a member of the same language that would be a
 * second published version is refused with the reason shown.
 */

const sessionToken = (page: Page) =>
  page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.startsWith('heopress.session.v2|'))!;
    return (JSON.parse(localStorage.getItem(key)!) as { token: string }).token;
  });

async function createArticle(page: Page, token: string, data: Record<string, unknown>, status = 'draft'): Promise<string> {
  const res = await page.request.post('/api/v1/items/articles', {
    headers: { authorization: `Bearer ${token}`, 'x-heopress-site': '__default__', 'content-type': 'application/json' },
    data: { data, status },
  });
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data.id;
}

test('an editor groups two language versions and sees each with its role and status', async ({ page }) => {
  await useSite(page, '__default__');
  await signIn(page, ADMIN.email, ADMIN.password);
  const token = await sessionToken(page);
  const stamp = Date.now().toString(36);
  const en = await createArticle(page, token, { title: `Group source ${stamp}`, slug: `group-source-${stamp}`, locale: 'en' }, 'published');
  const zh = await createArticle(page, token, { title: `分组译文 ${stamp}`, slug: `group-zh-${stamp}`, locale: 'zh-CN' });
  const zh2 = await createArticle(page, token, { title: `第二个译文 ${stamp}`, slug: `group-zh2-${stamp}`, locale: 'zh-CN' }, 'published');

  await page.goto(`${ADMIN.path}/content/articles/${en}?form=full`);
  await page.getByRole('button', { name: 'Translation group' }).click();
  await expect(page.getByText('This item is in no translation group.')).toBeVisible();
  await page.getByRole('button', { name: /Start a group with this item as the source/ }).click();

  const members = page.getByRole('table', { name: 'Group members' });
  await expect(members.getByTestId('member-en')).toContainText('source');
  await expect(members.getByTestId('member-en')).toContainText('published');

  await page.getByLabel('Item ID').fill(zh);
  await page.getByRole('button', { name: 'Add to group' }).click();
  await expect(members.getByTestId('member-zh-CN')).toContainText(`分组译文 ${stamp}`);
  await expect(members.getByTestId('member-zh-CN')).toContainText('draft');

  // Publishing the Chinese version, then a second published Chinese item cannot join.
  await page.getByLabel('Item ID').fill(zh2);
  await page.getByRole('button', { name: 'Add to group' }).click();
  await expect(members.getByTestId('member-zh-CN')).toHaveCount(2);
  // Monaco keeps two empty live regions (role=alert) for screen readers: only alerts with text count.
  await expect(page.getByRole('alert').filter({ hasText: /\S/ })).toHaveCount(0);
  const publish = await page.request.patch(`/api/v1/items/articles/${zh}`, {
    headers: { authorization: `Bearer ${token}`, 'x-heopress-site': '__default__', 'content-type': 'application/json' },
    data: { status: 'published', expectedVersion: 1 },
  });
  expect(publish.status()).toBe(409);
  expect(((await publish.json()) as { errors: Array<{ code: string }> }).errors[0]!.code).toBe('LOCALE_ALREADY_PUBLISHED');

  // The state of each language (computed): the source published, the Chinese version a draft.
  await expect(page.getByTestId('status-en')).toContainText('published');

  // Taking a member out leaves the others.
  await members.getByRole('button', { name: 'Remove the zh-CN version from the group' }).first().click();
  await expect(members.getByTestId('member-zh-CN')).toHaveCount(1);
  await expect(members.getByTestId('member-en')).toBeVisible();
});
