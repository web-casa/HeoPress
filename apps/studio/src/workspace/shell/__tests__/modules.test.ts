import { describe, expect, it } from 'vitest';
import { MODULES, moduleOf, visibleModules } from '../modules';

describe('workspace modules (ADR-0019 §2)', () => {
  it('eight modules; Logs & monitoring only for site administrators', () => {
    expect(MODULES).toHaveLength(8);
    expect(visibleModules(true).map((m) => m.id)).toContain('monitoring');
    expect(visibleModules(false).map((m) => m.id)).not.toContain('monitoring');
    expect(visibleModules(false)).toHaveLength(7);
  });

  it('distinct jump letters and icons (SEO / GEO never shares the search icon)', () => {
    expect(new Set(MODULES.map((m) => m.key)).size).toBe(MODULES.length);
    expect(new Set(MODULES.map((m) => m.icon)).size).toBe(MODULES.length);
  });

  it('maps a path to its module', () => {
    expect(moduleOf('/')).toBe('overview');
    expect(moduleOf('/ai-traffic')).toBe('aiTraffic');
    expect(moduleOf('/settings/advanced/webhooks')).toBe('settings');
    expect(moduleOf('/content/articles/abc')).toBe('content');
  });
});
