import { expect, test } from '@playwright/test';
import { ADMIN, signIn, useSite } from './fixtures';

/**
 * Content sources (HeoPress P08 tasks 1.1, 1.4, 1.5; spec ingest/sources "信源定义"): an administrator adds an RSS
 * source — it starts licence unknown and discovery only, scheduled in its own time zone — records a licence revision
 * with evidence, reads the history, pauses and resumes it.
 */

test('an administrator adds a source, records its licence, reads the history, pauses and resumes it', async ({ page }) => {
  await useSite(page, '__default__');
  await signIn(page, ADMIN.email, ADMIN.password);
  await page.goto(`${ADMIN.path}/content/sources`);
  await expect(page.getByRole('heading', { name: 'Sources', level: 1 })).toBeVisible();

  await page.getByRole('button', { name: 'New source' }).click();
  const form = page.getByRole('form', { name: 'New source' });
  await form.getByLabel('Name').fill('E2E wire');
  await form.getByLabel('Type').selectOption('rss');
  await form.getByLabel('URL').fill('https://news.example.com/feed.xml');
  await form.getByLabel(/^Times of day/).fill('08:00, 20:00');
  await form.getByLabel(/^Time zone/).fill('Asia/Shanghai');
  await form.getByRole('button', { name: 'Create' }).click();
  await expect(form).toHaveCount(0);

  const row = page.locator('tr[data-source="E2E wire"]');
  await expect(row).toContainText('08:00, 20:00 (Asia/Shanghai)');
  await expect(row.getByText('Licence unknown')).toBeVisible();
  await expect(row.getByText('Discovery only')).toBeVisible();
  await expect(row.getByText('Active')).toBeVisible();
  // Discovery has not run yet: no last-run counts, no source documents (HeoPress P08 tasks 1.3, 4.x).
  await expect(row.locator('[data-last-run]')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Latest source documents' }).getByText('No source documents yet.')).toBeVisible();

  await row.getByRole('button', { name: 'Licence & terms' }).click();
  const terms = page.getByRole('form', { name: 'Licence & terms' });
  await terms.getByLabel('Licence status').selectOption('licensed');
  await terms.getByLabel('Usage').selectOption('licensed_derivative');
  await terms.getByLabel('Evidence').fill('Contract EX-2026-14');
  await terms.getByLabel('Valid until').fill('2099-01-01');
  await terms.getByRole('button', { name: 'Record revision' }).click();
  await expect(terms).toHaveCount(0);
  await expect(row.getByText('Licensed', { exact: true })).toBeVisible();
  await expect(row.getByText('Licensed derivative')).toBeVisible();

  await row.getByRole('button', { name: 'History' }).click();
  const history = page.getByRole('region', { name: 'Licence history' });
  await expect(history.locator('[data-revision]')).toHaveCount(2);
  await expect(history.getByText('Contract EX-2026-14')).toBeVisible();

  await row.getByRole('button', { name: 'Pause' }).click();
  await expect(row.getByText('Paused', { exact: true })).toBeVisible();
  await row.getByRole('button', { name: 'Resume' }).click();
  await expect(row.getByText('Active')).toBeVisible();

  // The choice holds after a reload.
  await page.reload();
  await expect(page.locator('tr[data-source="E2E wire"]').getByText('Licensed derivative')).toBeVisible();
});
