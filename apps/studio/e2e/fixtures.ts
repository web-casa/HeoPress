import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, type Page } from '@playwright/test';

export const SEED_FILE = path.resolve(import.meta.dirname, '../e2e-results/.seed.json');

/** The first-time setup account (bootstrap admin) and admin path. */
export const ADMIN = { email: 'admin@e2e.example.test', password: 'E2e-Studio-Admin-1!', path: '/e2e-admin' } as const;

export interface Seed {
  sites: { a: string; b: string };
  articles: { a: string; b: string };
  people: Record<'editor' | 'colleague' | 'traveller', { id: string; email: string }>;
  password: string;
  /** The change-impact site (HeoPress P07 task 5.5): `source` links to `delete`, `update` and `move`; `dest` is another page. */
  links: { site: string; host: string; source: string; dest: string; delete: string; update: string; move: string; unpublish: string };
}

export function seed(): Seed {
  return JSON.parse(readFileSync(SEED_FILE, 'utf8')) as Seed;
}

/** Studio keeps the active site in localStorage; set it before the app loads. */
export async function useSite(page: Page, siteId: string): Promise<void> {
  await page.addInitScript((id) => window.localStorage.setItem('heopress.example.site', id), siteId);
}

/** Sign in through the real login page. */
export async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto(`${ADMIN.path}/login`);
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole('button', { name: /sign in|log in/i }).click();
  await expect(page).not.toHaveURL(/\/login/);
}
