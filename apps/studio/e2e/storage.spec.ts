import { expect, test, type Page } from '@playwright/test';
import { ADMIN, seed, signIn, useSite } from './fixtures';

/**
 * Storage settings in Studio (HeoPress P04 task 6.3): an administrator
 * creates a storage profile, tests its connection and makes it where the
 * site's new media goes; an S3 profile's secret is sent once and only ever
 * shown — on the page and in API answers — as a mask.
 */

const SECRET = 'e2e-secret-value-never-shown';
const MASK = '••••••••';
const form = (page: Page) => page.getByRole('form', { name: 'New storage profile' });

async function create(page: Page, fields: Record<string, string>, driver: 'local' | 's3'): Promise<void> {
  await page.getByRole('button', { name: /new storage profile/i }).click();
  await form(page).getByLabel('Driver').selectOption(driver);
  for (const [label, value] of Object.entries(fields)) await form(page).getByLabel(label, { exact: true }).fill(value);
  await form(page).getByRole('button', { name: 'Create' }).click();
  await expect(form(page)).toHaveCount(0);
}

test('an administrator creates a storage profile, tests it and uses it for new media; secrets stay masked', async ({ page }) => {
  const s = seed();
  await useSite(page, s.sites.a);
  await signIn(page, ADMIN.email, ADMIN.password);
  // Every storage API answer, its body read in full before it is checked.
  const answers: Array<Promise<{ method: string; body: string }>> = [];
  page.on('response', (res) => {
    if (!new URL(res.url()).pathname.startsWith('/api/v1/storage-profiles')) return;
    // A body that cannot be read fails the check below (not taken for an empty one).
    answers.push(res.text().then((body) => ({ method: res.request().method(), body })));
  });
  let creations = 0;
  page.on('request', (req) => {
    if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/v1/storage-profiles') creations += 1;
  });
  await page.goto(`${ADMIN.path}/settings/storage`);
  await expect(page.getByRole('heading', { name: 'Storage' })).toBeVisible();
  await expect(page.getByTestId('storage-default').getByText('New media', { exact: true })).toBeVisible();

  // A local profile: the connection test writes, reads back and deletes a probe.
  await create(page, { Name: 'Local e2e' }, 'local');
  const local = page.locator('[data-testid^="storage-profile-"]', { hasText: 'Local e2e' });
  await local.getByRole('button', { name: /test connection/i }).click();
  await expect(local.getByRole('status')).toHaveText(/Connection works/);
  await local.getByRole('button', { name: 'Use for new media' }).click();
  await expect(local.getByText('New media', { exact: true })).toBeVisible();
  await expect(page.getByTestId('storage-default').getByText('New media', { exact: true })).toHaveCount(0);

  // An S3 profile: the secret goes in once and comes back only as a mask.
  await create(
    page,
    { Name: 'S3 e2e', Bucket: 'e2e-media', Endpoint: 'https://s3.example.com', 'Access key ID': 'AKIA-E2E', 'Secret access key': SECRET },
    's3',
  );
  const s3 = page.locator('[data-testid^="storage-profile-"]', { hasText: 'S3 e2e' });
  await expect(s3.getByText(MASK)).toBeVisible();
  await expect(page.getByText(SECRET)).toHaveCount(0);

  // The choice holds after a reload; nothing the API answered carried the secret.
  await page.reload();
  await expect(page.locator('[data-testid^="storage-profile-"]', { hasText: 'Local e2e' }).getByText('New media', { exact: true })).toBeVisible();
  const read = await Promise.all(answers);
  expect(read.some((a) => a.method === 'POST' && a.body.includes('S3 e2e'))).toBe(true); // the creation's own answer was read
  expect(read.filter((a) => a.body.includes(SECRET))).toEqual([]);
  expect(creations).toBe(2); // the secret was sent once, with its profile
  // A new form starts empty.
  await page.getByRole('button', { name: /new storage profile/i }).click();
  await expect(form(page).getByLabel('Secret access key')).toHaveValue('');
  await form(page).getByRole('button', { name: 'Cancel' }).click();

  // Back to the instance default (other scenarios keep their media there).
  await page.getByTestId('storage-default').getByRole('button', { name: 'Use for new media' }).click();
  await expect(page.getByTestId('storage-default').getByText('New media', { exact: true })).toBeVisible();
});
