import { expect, test, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { ADMIN, seed, signIn, useSite } from './fixtures';

/**
 * Accessibility checklist of the eight modules (HeoPress P07a task 13.2; ADR-0019 §7): every control has a name, focus is
 * visible while tabbing, nothing scrolls sideways at 390 pixels, nothing moves under "reduce motion", and each module's
 * main action can be done from the keyboard alone.
 */

const MODULES: Array<[string, string]> = [
  ['overview', '/overview'],
  ['content', '/content'],
  ['sites', '/sites'],
  ['seo', '/seo/crawlers'],
  ['ai-traffic', '/ai-traffic'],
  ['audit', '/audit'],
  ['monitoring', '/monitoring'],
  ['settings', '/settings/general'],
];

async function open(page: Page): Promise<void> {
  await useSite(page, seed().links.site);
  await page.addInitScript(() => window.localStorage.setItem('heopress.studio.language', 'en'));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await signIn(page, ADMIN.email, ADMIN.password);
}

async function settle(page: Page, path: string): Promise<void> {
  await page.goto(`${ADMIN.path}${path}`);
  await expect(page.locator('#main-content')).toBeVisible();
  await expect(page.locator('#main-content .animate-pulse')).toHaveCount(0, { timeout: 15_000 });
}

/** Buttons, links and form controls without an accessible name (text, aria-label, aria-labelledby, title or a label). */
function unnamed(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const named = (el: Element): boolean => {
      if (el.getAttribute('aria-label')?.trim() || el.getAttribute('title')?.trim()) return true;
      const by = el.getAttribute('aria-labelledby');
      if (by && by.split(/\s+/).some((id) => document.getElementById(id)?.textContent?.trim())) return true;
      if ((el as HTMLInputElement).labels?.length) return [...(el as HTMLInputElement).labels!].some((l) => l.textContent?.trim());
      if (el instanceof HTMLInputElement && ['submit', 'button'].includes(el.type)) return !!el.value.trim();
      if (el.tagName === 'SELECT') return false;
      return !!el.textContent?.trim() || !!el.querySelector('img[alt]:not([alt=""])');
    };
    for (const el of document.querySelectorAll('button, a[href], [role="button"], [role="tab"], [role="radio"], input:not([type="hidden"]), select, textarea')) {
      const box = (el as HTMLElement).getBoundingClientRect();
      if (!box.width && !box.height) continue;
      if (!named(el)) out.push(el.outerHTML.slice(0, 140));
    }
    return out;
  });
}

test('task 13.2: every module — named controls, visible focus, no movement under "reduce motion"', async ({ page }) => {
  test.setTimeout(180_000);
  await open(page);
  for (const [name, path] of MODULES) {
    await settle(page, path);
    expect(await unnamed(page), `${name}: controls without a name`).toEqual([]);

    // Tab through the first stops: each focused element shows a ring (outline or box shadow).
    await page.locator('body').click({ position: { x: 1, y: 1 } });
    for (let i = 0; i < 12; i += 1) {
      await page.keyboard.press('Tab');
      const ring = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return 'none';
        const s = getComputedStyle(el);
        const visible = (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) || (s.boxShadow && s.boxShadow !== 'none');
        return visible ? 'ok' : `no ring on ${el.outerHTML.slice(0, 120)}`;
      });
      expect(ring === 'ok' || ring === 'none', `${name}: ${ring}`).toBe(true);
    }

    // Nothing animates once the page has settled. Under "reduce motion" every animation lasts 0.01 ms and runs once: one
    // that only just started (a skeleton shown by a refetch) does not move, so only longer ones count.
    await page.waitForTimeout(100);
    const moving = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running' && Number(a.effect?.getComputedTiming().activeDuration ?? 0) > 1).map((a) => { const el = (a.effect as KeyframeEffect | null)?.target as HTMLElement | null; return el ? `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 80)} [${(a as CSSAnimation).animationName ?? 'transition'}, ${getComputedStyle(el).animationDuration}, ${getComputedStyle(el).animationIterationCount}]` : 'animation'; }));
    expect(moving, `${name}: running animations`).toEqual([]);
  }
});

test('task 13.2: at 390 pixels nothing scrolls sideways', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  for (const [name, path] of MODULES) {
    await settle(page, path);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `${name}: page wider than the screen by ${overflow}px`).toBeLessThanOrEqual(0);
  }
});

test('task 13.2: the main actions from the keyboard alone', async ({ page }) => {
  await open(page);
  // Module rail: the shortcut "g" then the module key opens it.
  await settle(page, '/overview');
  // The shell's shortcuts are bound once its rail is up.
  await expect(page.getByRole('navigation', { name: 'Modules' })).toBeVisible();
  await page.keyboard.press('g');
  await page.keyboard.press('u');
  await expect(page).toHaveURL(new RegExp(`${ADMIN.path}/audit`));

  // Content: open the first item waiting for review from the keyboard.
  await settle(page, '/content?view=pending');
  await expect(page.getByRole('region', { name: 'Waiting for review' }).getByRole('button').first()).toBeVisible();
  await page.keyboard.press('j');
  await expect(page.getByRole('complementary').filter({ hasText: 'Title review-' })).toBeVisible();

  // SEO / GEO: pick a preset and discard it, by keyboard.
  await settle(page, '/seo/crawlers');
  await page.getByRole('radio', { name: 'Search and citation only' }).focus();
  await page.keyboard.press('Enter');
  const bar = page.getByRole('region', { name: 'Unsaved changes' });
  await expect(bar).toContainText('1 unsaved change');
  await bar.getByRole('button', { name: 'Discard' }).focus();
  await page.keyboard.press('Enter');
  await expect(bar).toHaveCount(0);

  // Settings › Appearance: switch density with the keyboard, then back.
  await settle(page, '/settings/appearance');
  await page.getByText('Compact', { exact: true }).focus();
  await page.keyboard.press('Space');
  await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
  await page.getByText('Comfortable', { exact: true }).focus();
  await page.keyboard.press('Space');
  await expect(page.locator('html')).toHaveAttribute('data-density', 'comfortable');
});

const axeSource = createRequire(import.meta.url).resolve('axe-core/axe.min.js');

type AxeViolation = { id: string; impact: string | null; nodes: Array<{ target: unknown }> };

test.describe('axe', () => {
  // axe is injected as a script tag, which Studio's own CSP (script-src 'self') blocks: the check bypasses it in this test only.
  test.use({ bypassCSP: true });

  test('task 13.5: axe finds no WCAG 2.1 A / AA violation on any module', async ({ page }) => {
  test.setTimeout(180_000);
  await open(page);
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    for (const [name, path] of MODULES) {
      await settle(page, path);
      await page.addScriptTag({ path: axeSource });
      const violations = await page.evaluate(async () => {
        const axe = (window as unknown as { axe: { run: (ctx: Document, opts: object) => Promise<{ violations: AxeViolation[] }> } }).axe;
        const result = await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } });
        return result.violations.map((v) => `${v.id} (${v.impact}): ${JSON.stringify(v.nodes.slice(0, 3).map((n) => n.target))}`);
      });
      expect(violations, `${name} (${scheme})`).toEqual([]);
    }
  }
});
});
