import { expect, test, type Page } from '@playwright/test';
import { ADMIN, seed, signIn, useSite } from './fixtures';

/**
 * Audit triage and Logs & monitoring (HeoPress P07a tasks 10.5, 11.7, 11.8; specs studio/audit-workspace,
 * studio/monitoring). The seed runs the links site's audit, which finds the link to `/impact-gone/`.
 */

async function asAdmin(page: Page): Promise<void> {
  await useSite(page, seed().links.site);
  await page.addInitScript(() => window.localStorage.setItem('heopress.studio.language', 'en'));
  await signIn(page, ADMIN.email, ADMIN.password);
}

test('task 10.5: ignoring an issue and undoing it puts it back, and the log records both', async ({ page }) => {
  await asAdmin(page);
  await page.goto(`${ADMIN.path}/audit`);
  const list = page.getByRole('region', { name: 'Open' });
  await list.getByRole('button', { name: /Broken internal link/ }).click();
  await page.getByRole('button', { name: 'Ignore issue' }).click();
  await expect(list.getByRole('button', { name: /Broken internal link/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(list.getByRole('button', { name: /Broken internal link/ })).toHaveCount(1);

  await page.goto(`${ADMIN.path}/monitoring`);
  await page.getByRole('textbox', { name: 'Search events' }).fill('audit_issue');
  const stream = page.getByRole('region', { name: 'Logs & monitoring' });
  // This scenario's two records are the newest of their kind (records an earlier run on the same database left are
  // further down); the stream looks again every 5 seconds.
  const kinds = async () =>
    (await stream.getByRole('listitem').allTextContents()).slice(0, 2).map((t) => (/audit_issue_restored/.test(t) ? 'restored' : /audit_issue_ignored/.test(t) ? 'ignored' : 'other')).sort();
  await expect.poll(kinds, { timeout: 15_000 }).toEqual(['ignored', 'restored']);
});

test('task 11.7: paused, new events wait; resumed, they come in and the selection stays', async ({ page }) => {
  await asAdmin(page);
  await page.goto(`${ADMIN.path}/monitoring`);
  const stream = page.getByRole('region', { name: 'Logs & monitoring' });
  // Only the triage records: all of them fit the first page, so the count below cannot grow by older records the next
  // poll brings in (it looks back 60 seconds) that were past the first 50 events of an unfiltered stream.
  await page.getByRole('textbox', { name: 'Search events' }).fill('audit_issue');
  await expect(stream.getByRole('listitem').first()).toBeVisible();
  await expect(stream.getByRole('listitem').filter({ hasNotText: 'audit_issue' })).toHaveCount(0);
  await stream.getByRole('listitem').first().getByRole('button').click();
  const selectedId = await stream.locator('[aria-current="true"]').getAttribute('data-event-id');
  await page.getByRole('button', { name: 'Pause' }).click();
  // Something happens on the site meanwhile, in another tab: an issue is ignored (a site record).
  const before = await stream.getByRole('listitem').count();
  // Earlier scenarios may have left ignore records: count them, so the new one is the one that must arrive.
  const ignoredBefore = await stream.getByRole('button', { name: /audit_issue_ignored/ }).count();
  const tab = await page.context().newPage();
  await tab.goto(`${ADMIN.path}/audit`);
  const open = tab.getByRole('region', { name: 'Open' });
  await open.getByRole('button', { name: /Broken internal link/ }).click();
  await tab.getByRole('button', { name: 'Ignore issue' }).click();
  await expect(open.getByRole('button', { name: /Broken internal link/ })).toHaveCount(0);
  await page.waitForTimeout(6_000);
  expect(await stream.getByRole('listitem').count()).toBe(before);
  await page.getByRole('button', { name: 'Resume' }).click();
  await expect(stream.getByRole('button', { name: /audit_issue_ignored/ })).toHaveCount(ignoredBefore + 1, { timeout: 15_000 });
  await expect(stream.locator('[aria-current="true"]')).toHaveAttribute('data-event-id', selectedId!);
  // Put the issue back for the scenarios that follow.
  await tab.goto(`${ADMIN.path}/audit?view=ignored`);
  await tab.getByRole('region', { name: 'Ignored' }).getByRole('button', { name: /Broken internal link/ }).click();
  await tab.getByRole('button', { name: 'Restore' }).click();
  await tab.close();
});

test('task 11.8: a saved filter is there in another browser after signing in', async ({ page, browser }) => {
  await asAdmin(page);
  await page.goto(`${ADMIN.path}/monitoring`);
  await page.getByRole('radio', { name: /Errors/ }).click();
  await page.getByRole('textbox', { name: 'Name' }).fill('Link errors');
  await page.getByRole('button', { name: 'Save current filter' }).click();
  await expect(page.getByRole('button', { name: 'Link errors', exact: true })).toBeVisible();

  const other = await browser.newContext();
  const page2 = await other.newPage();
  await asAdmin(page2);
  await page2.goto(`${ADMIN.path}/monitoring`);
  await page2.getByRole('button', { name: 'Link errors', exact: true }).click();
  await expect(page2.getByRole('radio', { name: /Errors/ })).toHaveAttribute('aria-checked', 'true');
  await page2.getByRole('button', { name: 'Remove Link errors' }).click();
  await other.close();
});
