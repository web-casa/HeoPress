import { describe, expect, it } from 'vitest';
import { countSetting, defaultRenderWorkers } from '../settings';

/** The rendering service's numeric settings (HeoPress P13 task 3.2). */
describe('rendering service settings', () => {
  it('render threads: the usable CPUs less one for the event loop, from 2 to 8', () => {
    expect(defaultRenderWorkers(1)).toBe(2);
    expect(defaultRenderWorkers(2)).toBe(2);
    expect(defaultRenderWorkers(4)).toBe(3);
    expect(defaultRenderWorkers(8)).toBe(7);
    expect(defaultRenderWorkers(64)).toBe(8);
    expect(defaultRenderWorkers()).toBeGreaterThanOrEqual(2);
  });
  it('a whole number within bounds, the default when unset or blank, an error otherwise', () => {
    expect(countSetting({}, 'X', 3, 1, 64)).toBe(3);
    expect(countSetting({ X: '  ' }, 'X', 3, 1, 64)).toBe(3);
    expect(countSetting({ X: ' 6 ' }, 'X', 3, 1, 64)).toBe(6);
    for (const bad of ['0', '65', '2.5', '-1', 'four', '1e1', '0x10']) expect(() => countSetting({ X: bad }, 'X', 3, 1, 64), bad).toThrow(/X must be a whole number from 1 to 64/);
  });
});
