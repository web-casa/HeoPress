import { create } from 'zustand';
import type { StudioPreferences } from '@heopress/contracts';

/**
 * Theme and density (ADR-0019 §5.8, p07a task 1.2). The choice lives in
 * `users.preferences.studio`; before sign-in, and as a fast first paint, the
 * last choice is kept in this browser's local storage.
 */
export type ThemeChoice = 'light' | 'dark' | 'system';
export type Density = 'comfortable' | 'compact';

export interface Appearance {
  /** `undefined`: the user never chose — the site default, then the system, decides. */
  theme?: ThemeChoice;
  density: Density;
}

const LOCAL_KEY = 'heopress.studio.appearance';

function readLocal(): Appearance {
  try {
    const raw = globalThis.localStorage?.getItem(LOCAL_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<Appearance>) : {};
    return {
      theme: isTheme(parsed.theme) ? parsed.theme : undefined,
      density: parsed.density === 'compact' ? 'compact' : 'comfortable',
    };
  } catch {
    return { density: 'comfortable' };
  }
}

function writeLocal(value: Appearance): void {
  try {
    globalThis.localStorage?.setItem(LOCAL_KEY, JSON.stringify(value));
  } catch {
    // Private mode or blocked storage: the server copy still holds the choice.
  }
}

function isTheme(value: unknown): value is ThemeChoice {
  return value === 'light' || value === 'dark' || value === 'system';
}

/**
 * The appearance stored on the server: `studio.theme`, else the legacy
 * top-level `theme` (`auto` → `system`).
 */
export function appearanceFromPreferences(prefs: { theme?: unknown; studio?: StudioPreferences } | undefined): Partial<Appearance> {
  const out: Partial<Appearance> = {};
  const studioTheme = prefs?.studio?.theme;
  const legacy = prefs?.theme === 'auto' ? 'system' : prefs?.theme;
  if (isTheme(studioTheme)) out.theme = studioTheme;
  else if (isTheme(legacy)) out.theme = legacy;
  if (prefs?.studio?.density) out.density = prefs.studio.density;
  return out;
}

/** The colour scheme to paint: the user's choice, else the site default, else the system. */
export function resolveTheme(theme: ThemeChoice | undefined, siteDefault: string | undefined, systemDark: boolean): 'light' | 'dark' {
  const choice = theme ?? (siteDefault === 'auto' ? 'system' : siteDefault);
  if (choice === 'light' || choice === 'dark') return choice;
  return systemDark ? 'dark' : 'light';
}

export function applyAppearance(root: HTMLElement, scheme: 'light' | 'dark', density: Density): void {
  root.classList.toggle('dark', scheme === 'dark');
  root.dataset.theme = scheme;
  root.dataset.density = density;
}

interface AppearanceState extends Appearance {
  siteDefault?: string;
  set(patch: Partial<Appearance>): void;
  setSiteDefault(value: string | undefined): void;
}

export const useAppearance = create<AppearanceState>((set, get) => ({
  ...readLocal(),
  set(patch) {
    set(patch);
    const { theme, density } = get();
    writeLocal({ theme, density });
  },
  setSiteDefault(value) {
    set({ siteDefault: value });
  },
}));

function systemPrefersDark(): boolean {
  return Boolean(globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches);
}

/** Paint the current appearance and keep it in step with the store and the system setting. Returns the unsubscribe. */
export function bindAppearance(root: HTMLElement = document.documentElement): () => void {
  const paint = () => {
    const { theme, density, siteDefault } = useAppearance.getState();
    applyAppearance(root, resolveTheme(theme, siteDefault, systemPrefersDark()), density);
  };
  paint();
  const unsubscribe = useAppearance.subscribe(paint);
  const media = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
  media?.addEventListener?.('change', paint);
  return () => {
    unsubscribe();
    media?.removeEventListener?.('change', paint);
  };
}
