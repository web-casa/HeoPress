import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DARK, ICON_PAIRS, LIGHT, TEXT_PAIRS, TOKEN_NAMES, contrast, type Palette } from '../tokens';

const css = readFileSync(path.resolve(__dirname, '../../index.css'), 'utf8');

function cssBlock(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start).toBeGreaterThan(-1);
  return css.slice(start, css.indexOf('\n  }', start));
}

describe('Carbon tokens (ADR-0019 §3)', () => {
  it('known values: white on black is 21:1, equal colours 1:1', () => {
    expect(contrast('#FFFFFF', '#000000')).toBeCloseTo(21, 5);
    expect(contrast('#5B57E0', '#5B57E0')).toBe(1);
  });

  for (const [name, palette, selector] of [['light', LIGHT, ':root'], ['dark', DARK, '.dark']] as Array<[string, Palette, string]>) {
    it(`${name}: index.css declares every token with the same value`, () => {
      const block = cssBlock(selector);
      for (const token of TOKEN_NAMES) {
        expect(block, `--${token}`).toMatch(new RegExp(`--${token}: ${palette[token]};`, 'i'));
      }
    });

    it(`${name}: text pairings reach 4.5:1`, () => {
      for (const [fg, bg] of TEXT_PAIRS) {
        expect(contrast(palette[fg], palette[bg]), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    });

    it(`${name}: icons reach 3:1 on every surface`, () => {
      for (const [fg, bg] of ICON_PAIRS) {
        expect(contrast(palette[fg], palette[bg]), `${fg} on ${bg}`).toBeGreaterThanOrEqual(3);
      }
    });
  }
});
