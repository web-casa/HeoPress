// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appearanceFromPreferences, applyAppearance, bindAppearance, resolveTheme, useAppearance } from '../appearance';

describe('resolveTheme', () => {
  it('light and dark are taken as chosen, whatever the system says', () => {
    expect(resolveTheme('light', 'dark', true)).toBe('light');
    expect(resolveTheme('dark', 'light', false)).toBe('dark');
  });

  it('system follows the system setting', () => {
    expect(resolveTheme('system', 'light', true)).toBe('dark');
    expect(resolveTheme('system', 'dark', false)).toBe('light');
  });

  it('no choice: the site default, then the system', () => {
    expect(resolveTheme(undefined, 'dark', false)).toBe('dark');
    expect(resolveTheme(undefined, 'auto', true)).toBe('dark');
    expect(resolveTheme(undefined, undefined, false)).toBe('light');
  });
});

describe('appearanceFromPreferences', () => {
  it('reads studio.theme and density', () => {
    expect(appearanceFromPreferences({ studio: { theme: 'dark', density: 'compact' } })).toEqual({ theme: 'dark', density: 'compact' });
  });

  it('maps the legacy top-level theme (auto → system); studio wins over it', () => {
    expect(appearanceFromPreferences({ theme: 'auto' })).toEqual({ theme: 'system' });
    expect(appearanceFromPreferences({ theme: 'light', studio: { theme: 'dark' } })).toEqual({ theme: 'dark' });
    expect(appearanceFromPreferences({})).toEqual({});
  });
});

describe('bindAppearance', () => {
  let listener: (() => void) | undefined;
  let systemDark = false;

  afterEach(() => {
    vi.unstubAllGlobals();
    listener = undefined;
  });

  it('paints the root and repaints when the system switches or the user chooses', () => {
    vi.stubGlobal('matchMedia', () => ({
      get matches() { return systemDark; },
      addEventListener: (_: string, fn: () => void) => { listener = fn; },
      removeEventListener: () => { listener = undefined; },
    }));
    const root = document.createElement('html');
    useAppearance.setState({ theme: 'system', density: 'comfortable', siteDefault: undefined });
    const unbind = bindAppearance(root);
    expect(root.classList.contains('dark')).toBe(false);
    expect(root.dataset.density).toBe('comfortable');

    systemDark = true;
    listener?.();
    expect(root.classList.contains('dark')).toBe(true);

    useAppearance.getState().set({ theme: 'light', density: 'compact' });
    expect(root.classList.contains('dark')).toBe(false);
    expect(root.dataset.density).toBe('compact');
    expect(JSON.parse(localStorage.getItem('heopress.studio.appearance') ?? '{}')).toEqual({ theme: 'light', density: 'compact' });
    unbind();
    expect(listener).toBeUndefined();
  });

  it('applyAppearance sets the class and data attributes', () => {
    const root = document.createElement('html');
    applyAppearance(root, 'dark', 'compact');
    expect(root.className).toBe('dark');
    expect(root.dataset.theme).toBe('dark');
  });
});
