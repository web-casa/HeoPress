/**
 * Carbon design tokens (ADR-0019 §3). `src/index.css` declares the same
 * values as CSS custom properties; `__tests__/tokens.test.ts` keeps the two in
 * step and checks every text and icon pairing against WCAG 2.x contrast.
 */
export const TOKEN_NAMES = [
  'bg', 'panel', 'panel-2', 'line', 'fg', 'muted', 'icon', 'accent', 'accent-fg', 'soft', 'sel',
  'ok', 'ok-soft', 'warn', 'warn-soft', 'bad', 'bad-soft', 'ai',
] as const;

export type TokenName = (typeof TOKEN_NAMES)[number];
export type Palette = Record<TokenName, string>;

export const LIGHT: Palette = {
  bg: '#F7F7F9', panel: '#FFFFFF', 'panel-2': '#F1F1F4', line: '#E4E4E9',
  fg: '#16161A', muted: '#5F5F6B', icon: '#7E7E89',
  accent: '#5B57E0', 'accent-fg': '#FFFFFF', soft: '#EEEDFD', sel: '#F0EFFE',
  ok: '#13795B', 'ok-soft': '#E2F3EC', warn: '#9A5B00', 'warn-soft': '#FBF0DC',
  bad: '#BE3A31', 'bad-soft': '#FCE8E6', ai: '#7C3AED',
};

export const DARK: Palette = {
  bg: '#0D0D10', panel: '#141417', 'panel-2': '#1B1B1F', line: '#26262C',
  fg: '#ECECF1', muted: '#9F9FAB', icon: '#75757F',
  accent: '#8A87FF', 'accent-fg': '#0D0D10', soft: '#1F1E3A', sel: '#1C1B30',
  ok: '#45CF9C', 'ok-soft': '#10261E', warn: '#F0B44F', 'warn-soft': '#2A2010',
  bad: '#FF8379', 'bad-soft': '#2E1513', ai: '#B794FF',
};

/** Text-on-surface pairings that must reach 4.5:1. */
export const TEXT_PAIRS: ReadonlyArray<[TokenName, TokenName]> = [
  ['fg', 'bg'], ['fg', 'panel'], ['fg', 'panel-2'], ['fg', 'sel'], ['fg', 'soft'],
  ['muted', 'bg'], ['muted', 'panel'], ['muted', 'panel-2'], ['muted', 'sel'],
  ['accent', 'bg'], ['accent', 'panel'], ['accent', 'soft'], ['accent', 'sel'], ['accent-fg', 'accent'],
  ['ok', 'ok-soft'], ['ok', 'panel'], ['warn', 'warn-soft'], ['warn', 'panel'], ['bad', 'bad-soft'], ['bad', 'panel'],
];

/** Non-text graphics (icons) that must reach 3:1 on every surface they sit on. */
export const ICON_PAIRS: ReadonlyArray<[TokenName, TokenName]> = [
  ['icon', 'bg'], ['icon', 'panel'], ['icon', 'panel-2'], ['icon', 'sel'], ['icon', 'soft'],
];

function channel(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

/** WCAG 2.x contrast ratio of two `#RRGGBB` colours. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
