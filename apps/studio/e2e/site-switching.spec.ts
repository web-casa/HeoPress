import { expect, test, type Page, type Route, type WebSocketRoute } from '@playwright/test';
import { ADMIN, seed, signIn, useSite } from './fixtures';

/**
 * Switching sites in Studio (HeoPress P04 tasks 9.4 and 9.10), with a person
 * who writes on both A and B: the switch reloads Studio on the other site and
 * nothing of the old one follows (its late responses, its requests); a reload
 * stays there; two tabs of one browser keep their own site; two tabs renewing
 * the same session at once are not signed out; a save still pending is
 * declared unknown and switching can be declined; quick switches back and
 * forth end consistent and signed in.
 */

const itemUrl = (id: string) => `${ADMIN.path}/content/articles/${id}`;
const titleOf = (page: Page) => page.getByRole('group', { name: 'title' }).getByRole('textbox');
const switcher = (page: Page) => page.getByLabel('Switch site');
const bell = (page: Page) => page.locator('#notifications-bell');
/** A realtime notification frame as the server sends it. */
const notificationFrame = (id: string, title: string) =>
  JSON.stringify({
    type: 'notification',
    notification: { id, kind: 'test', severity: 'info', title, body: 'e2e', entityId: id, ts: new Date().toISOString() },
  });

async function switchTo(page: Page, siteId: string): Promise<void> {
  await switcher(page).selectOption(siteId);
  await page.waitForURL((url) => url.pathname === ADMIN.path);
  await expect(switcher(page)).toHaveValue(siteId);
}

/** The site header of every API request the page makes from now on. */
function recordSites(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (req) => {
    const site = req.headers()['x-heopress-site'];
    if (new URL(req.url()).pathname.startsWith('/api/') && site) seen.push(site);
  });
  return seen;
}

test('switching reloads Studio on the other site; nothing of the old site follows; a reload stays', async ({ page }) => {
  const s = seed();
  // The realtime connections, passed through to the server, observed at the server end.
  const sockets: Array<{ ws: WebSocketRoute; closed: boolean }> = [];
  await page.routeWebSocket(/\/api\/v1\/realtime/, (ws) => {
    const entry = { ws, closed: false };
    const server = ws.connectToServer();
    ws.onClose((code, reason) => {
      entry.closed = true;
      server.close({ code, reason });
    });
    sockets.push(entry);
  });
  // Every API request, in order, with its site.
  const requests: Array<{ path: string; site: string }> = [];
  page.on('request', (req) => {
    const path = new URL(req.url()).pathname;
    if (path.startsWith('/api/')) requests.push({ path, site: req.headers()['x-heopress-site'] ?? '' });
  });
  await useSite(page, s.sites.a);
  await signIn(page, s.people.traveller.email, s.password);
  await expect(switcher(page)).toHaveValue(s.sites.a);

  // A's article and A's notifications answer late — after the switch.
  let entered: () => void = () => undefined;
  const isHeld = new Promise<void>((r) => (entered = r));
  let answerLate: () => void = () => undefined;
  const late = new Promise<void>((r) => (answerLate = r));
  const handled: Array<Promise<void>> = [];
  const holdLate = (route: Route) => {
    const done = (async () => {
      entered();
      await late;
      await route.continue().catch(() => undefined); // the page that asked is gone
    })();
    handled.push(done);
    return done;
  };
  await page.route(`**/api/v1/items/articles/${s.articles.a}`, holdLate);
  await page.route('**/api/v1/agent/staged*', holdLate);
  await page.goto(itemUrl(s.articles.a));
  await isHeld;
  // A's live realtime connections, of this page.
  await expect.poll(() => sockets.filter((e) => !e.closed).length).toBeGreaterThan(0);
  const socketsOfA = sockets.filter((e) => !e.closed);
  // Control: a notification sent on them does show on A.
  for (const e of socketsOfA) e.ws.send(notificationFrame('n-a-live', 'Live notification of A'));
  await expect(bell(page)).toHaveAttribute('aria-label', /unread/);
  await bell(page).click();
  await expect(page.getByText('Live notification of A')).toBeVisible();
  await bell(page).click();

  await page.evaluate(() => ((window as unknown as { __oldPage?: boolean }).__oldPage = true));
  const exchanged = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/auth/switch-site');
  await switcher(page).selectOption(s.sites.b);
  await exchanged;
  const afterSwitch = requests.length;
  await page.waitForURL((url) => url.pathname === ADMIN.path);
  await expect(switcher(page)).toHaveValue(s.sites.b);
  // Release the late answers before anything else happens on the new page.
  answerLate();
  await Promise.all(handled);

  // A new document, not the old one patched: nothing of A survives.
  expect(await page.evaluate(() => (window as unknown as { __oldPage?: boolean }).__oldPage)).toBeUndefined();
  // A's realtime connection ended with its page; a message pushed on it now reaches nothing.
  await expect.poll(() => socketsOfA.every((e) => e.closed)).toBe(true);
  for (const e of socketsOfA) {
    try {
      e.ws.send(notificationFrame('n-a-late', 'Late notification of A'));
    } catch {
      /* closed */
    }
  }
  await page.waitForTimeout(300);
  await expect(bell(page)).not.toHaveAttribute('aria-label', /unread/);
  await bell(page).click();
  await expect(page.getByRole('dialog', { name: 'Notifications' })).toBeVisible();
  await expect(page.getByText('Late notification of A')).toHaveCount(0);
  await expect(page.getByText('Live notification of A')).toHaveCount(0);
  await bell(page).click();
  expect(sockets.length).toBeGreaterThan(socketsOfA.length); // B's own connection
  await expect(page.getByText('Draft on A')).toHaveCount(0);
  await expect(page.locator('input[value="Draft on A"]')).toHaveCount(0);
  await expect(switcher(page)).toHaveValue(s.sites.b);
  // Every request since the switch — its realtime ticket and notifications included — is B's.
  await expect.poll(() => requests.slice(afterSwitch).some((r) => r.path === '/api/v1/realtime/ticket')).toBe(true);
  const since = requests.slice(afterSwitch).filter((r) => r.site);
  expect(since.length).toBeGreaterThan(0);
  expect(new Set(since.map((r) => r.site))).toEqual(new Set([s.sites.b]));

  await page.goto(itemUrl(s.articles.b));
  await expect(titleOf(page)).toHaveValue('Draft on B');
  await page.reload();
  await expect(switcher(page)).toHaveValue(s.sites.b);
  await expect(titleOf(page)).toHaveValue('Draft on B');
});

test('two tabs of one browser keep their own site', async ({ context }) => {
  const s = seed();
  const one = await context.newPage();
  await useSite(one, s.sites.a);
  await signIn(one, s.people.traveller.email, s.password);
  // A new tab starts from the last one used, then lives on its own.
  const two = await context.newPage();
  await two.goto(ADMIN.path);
  await expect(switcher(two)).toHaveValue(s.sites.a);

  await switchTo(one, s.sites.b);
  await two.reload();
  await expect(switcher(two)).toHaveValue(s.sites.a);
  await two.goto(itemUrl(s.articles.a));
  await expect(titleOf(two)).not.toHaveValue('');
  await one.reload();
  await expect(switcher(one)).toHaveValue(s.sites.b);
});

test('two tabs renewing the same session at once are not signed out', async ({ context }) => {
  const s = seed();
  const one = await context.newPage();
  await useSite(one, s.sites.a);
  await signIn(one, s.people.traveller.email, s.password);
  const two = await context.newPage();
  await two.goto(ADMIN.path);
  await expect(switcher(two)).toHaveValue(s.sites.a);

  // The first renewal is held until both tabs met their 401: the second tab
  // must then wait for it (one lock per session across tabs), not renew too.
  let refreshes = 0;
  let releaseRefresh: () => void = () => undefined;
  const refreshHeld = new Promise<void>((r) => (releaseRefresh = r));
  await context.route('**/api/v1/auth/refresh', async (route) => {
    refreshes += 1;
    if (refreshes === 1) await refreshHeld;
    await route.continue();
  });
  const refused: Array<Promise<void>> = [];
  for (const page of [one, two]) {
    let refuse: () => void = () => undefined;
    refused.push(new Promise<void>((r) => (refuse = r)));
    let done = false;
    await page.route(`**/api/v1/items/articles/${s.articles.a}`, async (route) => {
      if (done) return route.continue();
      done = true;
      await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ errors: [{ code: 'UNAUTHORIZED' }] }) });
      refuse();
    });
  }
  const loads = Promise.all([one.goto(itemUrl(s.articles.a)), two.goto(itemUrl(s.articles.a))]);
  await Promise.all(refused);
  await expect.poll(() => refreshes).toBe(1);
  await one.waitForTimeout(1000); // room for a second, competing renewal
  expect(refreshes).toBe(1);
  releaseRefresh();
  await loads;
  for (const page of [one, two]) {
    await expect(titleOf(page)).not.toHaveValue('');
    await expect(page).not.toHaveURL(/\/login/);
  }
  expect(refreshes).toBe(1);
  // The login was not taken for a stolen token: both still work after a reload.
  for (const page of [one, two]) {
    await page.reload();
    await expect(titleOf(page)).not.toHaveValue('');
  }
});

test('two independent logins of one person: switching the first keeps the second; signing out of the first leaves the second working', async ({ context }) => {
  const s = seed();
  // Tab 2 opens its sign-in form first, for site B: its own login (S2) comes later.
  const two = await context.newPage();
  await useSite(two, s.sites.b);
  await two.goto(`${ADMIN.path}/login`);
  await expect(two.getByLabel(/email/i)).toBeVisible();
  // Tab 1 signs in on site A (S1).
  const one = await context.newPage();
  await useSite(one, s.sites.a);
  await signIn(one, s.people.traveller.email, s.password);
  // Tab 2 signs in on its own form: a second, independent login.
  await two.getByLabel(/email/i).fill(s.people.traveller.email);
  await two.getByLabel(/password/i).fill(s.password);
  await two.getByRole('button', { name: /sign in|log in/i }).click();
  await expect(two).not.toHaveURL(/\/login/);
  await expect(switcher(two)).toHaveValue(s.sites.b);

  // Tab 1 switches to B (with S1); tab 2 is still on B with S2.
  await switchTo(one, s.sites.b);
  await two.goto(itemUrl(s.articles.b));
  await expect(titleOf(two)).not.toHaveValue('');

  // Signing out in tab 1 ends S1 only.
  const loggedOut = one.waitForResponse((res) => new URL(res.url()).pathname === '/api/v1/auth/logout');
  await one.getByRole('button', { name: 'Sign out' }).click();
  expect((await loggedOut).ok()).toBe(true);
  await expect(one).toHaveURL(/\/login/);

  // Tab 2 keeps working: requests, a forced renewal with its own refresh token, a reload.
  let refused = false;
  await two.route(`**/api/v1/items/articles/${s.articles.b}`, async (route) => {
    if (refused) return route.continue();
    refused = true;
    await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ errors: [{ code: 'UNAUTHORIZED' }] }) });
  });
  const renewed = two.waitForResponse((res) => new URL(res.url()).pathname === '/api/v1/auth/refresh');
  await two.reload();
  expect((await renewed).ok()).toBe(true);
  await expect(titleOf(two)).not.toHaveValue('');
  await expect(two).not.toHaveURL(/\/login/);
  await two.reload();
  await expect(titleOf(two)).not.toHaveValue('');
  await expect(switcher(two)).toHaveValue(s.sites.b);
});

test('a save still pending when switching is declared unknown; declining stays and the save completes', async ({ page }) => {
  test.setTimeout(60_000);
  const s = seed();
  await useSite(page, s.sites.a);
  await signIn(page, s.people.traveller.email, s.password);
  await page.goto(itemUrl(s.articles.a));
  await expect(titleOf(page)).not.toHaveValue('');

  let releaseSave: () => void = () => undefined;
  const held = new Promise<void>((r) => (releaseSave = r));
  await page.route(`**/api/v1/items/articles/${s.articles.a}*`, async (route) => {
    if (route.request().method() === 'GET') return route.continue();
    await held;
    return route.continue();
  });
  await titleOf(page).fill('Saved while switching');
  await page.getByRole('button', { name: /^save/i }).first().click();

  const asked = page.waitForEvent('dialog', { timeout: 20_000 });
  await switcher(page).selectOption(s.sites.b);
  const dialog = await asked;
  expect(dialog.message()).toMatch(/still being saved and its result is unknown/);
  await dialog.dismiss();

  await expect(switcher(page)).toHaveValue(s.sites.a);
  await expect(switcher(page)).toBeEnabled();
  await expect(page).toHaveURL(new RegExp(`${itemUrl(s.articles.a)}$`));
  releaseSave();
  await expect(page.getByRole('button', { name: 'Saved' })).toBeVisible();
  await page.reload();
  await expect(titleOf(page)).toHaveValue('Saved while switching');

  // Switching anyway: the pending save is not repeated on B.
  const writes: Array<{ site: string }> = [];
  page.on('request', (req) => {
    if (req.method() === 'PATCH') writes.push({ site: req.headers()['x-heopress-site'] ?? '' });
  });
  await page.unroute(`**/api/v1/items/articles/${s.articles.a}*`);
  await page.route(`**/api/v1/items/articles/${s.articles.a}*`, async (route) => {
    if (route.request().method() === 'GET') return route.continue();
    await new Promise(() => undefined); // never answered: its result stays unknown
  });
  await titleOf(page).fill('Unknown result');
  await page.getByRole('button', { name: /^save/i }).first().click();
  await expect.poll(() => writes.length).toBe(1);
  page.once('dialog', (d) => void d.accept());
  await switchTo(page, s.sites.b);
  await page.waitForTimeout(500);
  expect(writes).toEqual([{ site: s.sites.a }]);
});

test('quick switches back and forth end consistent and signed in', async ({ page }) => {
  const s = seed();
  await useSite(page, s.sites.a);
  await signIn(page, s.people.traveller.email, s.password);
  // While a switch is under way the switcher takes no second one.
  let release: () => void = () => undefined;
  const held = new Promise<void>((r) => (release = r));
  await page.route('**/api/v1/auth/switch-site', async (route) => {
    await held;
    await route.continue();
  });
  await switcher(page).selectOption(s.sites.b);
  await expect(switcher(page)).toBeDisabled();
  release();
  await page.waitForURL((url) => url.pathname === ADMIN.path);
  await expect(switcher(page)).toHaveValue(s.sites.b);
  await page.unroute('**/api/v1/auth/switch-site');
  for (const site of [s.sites.a, s.sites.b, s.sites.a, s.sites.b]) await switchTo(page, site);
  await page.goto(itemUrl(s.articles.b));
  await expect(titleOf(page)).toHaveValue('Draft on B');
  await page.reload();
  await expect(switcher(page)).toHaveValue(s.sites.b);
  await expect(page).not.toHaveURL(/\/login/);
  // Back on A, the session of the first sign-in still works (it was reused, not replayed).
  await switchTo(page, s.sites.a);
  await page.goto(itemUrl(s.articles.a));
  await expect(titleOf(page)).not.toHaveValue('');
});
