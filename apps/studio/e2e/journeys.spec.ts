import { expect, test, type Page } from '@playwright/test';
import { ADMIN, seed, signIn, useSite } from './fixtures';

/**
 * User journeys from the navigation (HeoPress P07a follow-up): each starts where a person starts — the rail, a panel,
 * a button, a link in a notification — and clicks through, instead of opening the page's address. Pages reached only
 * by address passed their own tests while their way in was missing (the new article editor was one).
 */

async function signedIn(page: Page, language: 'en' | 'zh-CN' = 'en'): Promise<void> {
  await useSite(page, seed().links.site);
  await page.addInitScript((lang) => window.localStorage.setItem('heopress.studio.language', lang), language);
  // These scenarios use the outline and inspector: the panels are shown (focus mode is the default).
  await page.addInitScript(() => window.localStorage.setItem('heopress.studio.editorFocus', '0'));
  await signIn(page, ADMIN.email, ADMIN.password);
}

const rail = (page: Page, name: string, nav = 'Modules') => page.getByRole('navigation', { name: nav }).getByRole('link', { name });

test('a new article: rail › Content › New article › the article editor', async ({ page }) => {
  await signedIn(page);
  await rail(page, 'Content').click();
  await page.getByRole('link', { name: 'New article' }).first().click();
  await expect(page).toHaveURL(new RegExp(`${ADMIN.path}/content/new$`));
  const stamp = Date.now().toString(36);
  await page.getByLabel('Title', { exact: true }).fill(`Journey ${stamp}`);
  await expect(page.getByLabel('Address (slug)')).toHaveValue(`journey-${stamp}`);
  await page.getByRole('button', { name: 'Create and edit' }).click();
  // The article editor, not the generic form: its outline and inspector are there.
  await expect(page).toHaveURL(new RegExp(`${ADMIN.path}/content/articles/[^/?]+$`));
  await expect(page.getByRole('tablist')).toBeVisible();
  // Nothing typed yet: nothing to save (an empty body is not an edit).
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: /^(Submit for review|Publish)/ }).first()).toBeVisible();
});

test('content types: the panel entry, its list, and the selected view on a type', async ({ page }) => {
  await signedIn(page);
  await rail(page, 'Content').click();
  const panelLink = page.getByRole('link', { name: 'Content types' });
  await panelLink.click();
  await expect(page.getByRole('heading', { name: 'Content types', level: 1 })).toBeVisible();
  await expect(page.getByText('Pick a collection')).toHaveCount(0);
  await page.getByRole('link', { name: /^Articles/ }).click();
  await expect(page).toHaveURL(new RegExp(`${ADMIN.path}/content/articles$`));
  await expect(panelLink).toHaveAttribute('aria-current', 'page');
  // The breadcrumb goes back to Content, not to the overview.
  await page.getByRole('link', { name: 'Content', exact: true }).last().click();
  await expect(page).toHaveURL(new RegExp(`${ADMIN.path}/content$`));
});

test('an agent-run notification link opens the run history, not a missing page', async ({ page }) => {
  await signedIn(page);
  await page.goto(`${ADMIN.path}/mission-control/runs`);
  await expect(page).toHaveURL(new RegExp(`${ADMIN.path}/settings/advanced/agent-harness`));
  await expect(page.getByText(/not found/i)).toHaveCount(0);
});

test('in Chinese, the way to a new article and the content types read in Chinese', async ({ page }) => {
  await signedIn(page, 'zh-CN');
  await rail(page, '内容', '模块').click();
  await expect(page.getByRole('link', { name: '内容类型' })).toBeVisible();
  await page.getByRole('link', { name: '新建文章' }).first().click();
  await expect(page.getByRole('heading', { name: '新建文章' })).toBeVisible();
  await expect(page.getByRole('button', { name: '创建并编辑' })).toBeVisible();
  await page.getByRole('link', { name: '内容类型' }).click();
  await expect(page.getByRole('heading', { name: '内容类型', level: 1 })).toBeVisible();
});

test('Settings › Advanced › Access: the tab clicked is the one shown as selected', async ({ page }) => {
  await signedIn(page);
  await page.goto(`${ADMIN.path}/settings/advanced/access`);
  const tabs = page.getByRole('main').getByRole('link', { name: /^(Roles|Policies|Permission matrix)$/ });
  await expect(tabs.filter({ hasText: 'Roles' })).toHaveAttribute('aria-current', 'page');
  await page.getByRole('link', { name: 'Policies', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${ADMIN.path}/settings/advanced/access/policies$`));
  await expect(page.getByRole('link', { name: 'Policies', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('link', { name: 'Roles', exact: true })).not.toHaveAttribute('aria-current', 'page');
});

test('Logs & monitoring › Agents: the section clicked is the one shown as selected, at its new address', async ({ page }) => {
  await signedIn(page);
  await page.goto(`${ADMIN.path}/monitoring/agents`);
  await page.getByRole('link', { name: 'Inbox', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${ADMIN.path}/monitoring/agents/inbox$`));
  await expect(page.getByRole('link', { name: 'Inbox', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('link', { name: 'Overview', exact: true }).first()).not.toHaveAttribute('aria-current', 'page');
});

test('a member who types an Advanced address sees that the section is closed, not the page', async ({ page }) => {
  const s = seed();
  await useSite(page, s.sites.a);
  await page.addInitScript(() => window.localStorage.setItem('heopress.studio.language', 'en'));
  await signIn(page, s.people.editor.email, s.password);
  for (const path of ['/settings/advanced/data-model', '/settings/advanced/access/roles', '/settings/advanced/automation/flows']) {
    await page.goto(`${ADMIN.path}${path}`);
    await expect(page.getByRole('status').filter({ hasText: /administrator/i })).toBeVisible();
  }
});

test('⌘K reaches Settings › Advanced for an administrator', async ({ page }) => {
  await signedIn(page);
  await page.goto(`${ADMIN.path}/overview`);
  // The shortcut is bound once the shell is up; the administrator's commands once the role is known (the rail shows Logs).
  await expect(rail(page, 'Logs & monitoring')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.getByRole('dialog', { name: 'Search' })).toBeVisible();
  await page.keyboard.type('Storage');
  // The best match is offered first.
  await expect(page.getByRole('dialog', { name: 'Search' }).getByRole('option', { selected: true })).toContainText('Storage');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`${ADMIN.path}/settings/advanced/storage$`));
});
