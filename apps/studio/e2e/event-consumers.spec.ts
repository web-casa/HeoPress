import { expect, test, type Page } from '@playwright/test';
import { ADMIN, seed, signIn, useSite } from './fixtures';

/**
 * Logs & monitoring › Event consumers (HeoPress P11 tasks 1.1, 1.2; spec publishing/event-consumers). The seed gives
 * the links site's `e2e-replay` consumer a dead letter and an event waiting for 20 minutes; the worker never runs it.
 */

async function asAdmin(page: Page): Promise<void> {
  await useSite(page, seed().links.site);
  await page.addInitScript(() => window.localStorage.setItem('heopress.studio.language', 'en'));
  await signIn(page, ADMIN.email, ADMIN.password);
}

test('task 1.1: backlog and dead letters are shown, and replay from a dead letter handles it again', async ({ page }) => {
  await asAdmin(page);
  await page.goto(`${ADMIN.path}/monitoring/consumers`);
  const list = page.getByRole('region', { name: 'Consumers' });
  const row = list.getByRole('row', { name: /e2e-replay/ });
  // The seed's waiting event is 20 minutes old at seeding; the scenario may run minutes later, and other scenarios add
  // events to the links site, so only the threshold flag and the failures are exact.
  await expect(row).toContainText(/\d+ min/);
  await expect(row).toContainText('Backlog over 10 minutes');
  await expect(row).toContainText('0 / 1 / 0');

  await row.getByRole('button', { name: 'e2e-replay' }).click();
  const letters = page.getByRole('region', { name: 'Dead letters of e2e-replay' });
  await expect(letters.getByRole('listitem')).toHaveCount(1);
  await expect(letters).toContainText('downstream refused the request');
  await letters.getByRole('button', { name: 'Replay from this event' }).click();
  await expect(page.getByRole('status')).toContainText(/\d+ event\(s\) will be handled again/);
  await expect(letters).toContainText('No failed events.');
  await expect(row).toContainText('0 / 0 / 0');
});

test('task 1.2: running the state reconciliation shows its report, the Git and Astro slots not configured yet', async ({ page }) => {
  await asAdmin(page);
  await page.goto(`${ADMIN.path}/monitoring/consumers`);
  const section = page.getByRole('region', { name: 'State reconciliation' });
  await section.getByRole('button', { name: 'Run reconciliation now' }).click();
  await expect(section.getByRole('row', { name: /render-cache/ })).toBeVisible({ timeout: 30_000 });
  await expect(section.getByRole('row', { name: /translation-freshness/ })).toBeVisible();
  await expect(section.getByRole('row', { name: /git-snapshots/ })).toContainText('Not configured');
  await expect(section.getByRole('row', { name: /astro-builds/ })).toContainText('Not configured');
  await expect(section).toContainText('(manual)');
});
