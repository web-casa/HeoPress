/**
 * The plugin capability grammar, manifest schema and version ranges (HeoPress P12 tasks 1.1 and 1.5;
 * `@heopress/contracts/extensions`, `@heopress/contracts/schemas`).
 */
import { describe, expect, it } from 'vitest';
import {
  allowsCollection,
  allowsHost,
  approvalCovers,
  diffCapabilities,
  groupCapabilities,
  migrateLegacyCapabilities,
  parseCapability,
  satisfiesVersionRange,
  validateCapabilities,
} from '@heopress/contracts/extensions';
import { ExtensionManifestSchema, MarketplaceManifestSchema, manifestCapabilities } from '@heopress/contracts/schemas';

describe('capability grammar', () => {
  it('parses every category, extension points included', () => {
    expect(parseCapability('http:fetch:api.example.com')).toMatchObject({ category: 'network', target: 'api.example.com' });
    expect(parseCapability('items:write:posts')).toMatchObject({ category: 'content', kind: 'items:write' });
    expect(parseCapability('items:publish:posts')).toMatchObject({ category: 'publish' });
    expect(parseCapability('secrets:api-token')).toMatchObject({ category: 'secrets', target: 'api-token' });
    expect(parseCapability('ext:gate-checks')).toMatchObject({ category: 'extension-point', target: 'gate-checks' });
    expect(parseCapability('media:write')).toMatchObject({ category: 'media' });
  });

  it('refuses raw db / env escape hatches, host-less fetch and unknown points', () => {
    for (const bad of ['db:read', 'db:write', 'env:read', 'service-account', 'queue:enqueue', 'http:fetch', 'items:read', 'ext:themes', 'http:fetch:https://x.example.com', 'http:fetch:Example.com:443']) {
      expect(parseCapability(bad), bad).toHaveProperty('error');
    }
    expect(validateCapabilities(['db:read', 'items:read:posts']).errors).toHaveLength(1);
  });

  it('host and collection checks', () => {
    expect(allowsHost(['http:fetch:api.example.com'], 'api.example.com')).toBe(true);
    expect(allowsHost(['http:fetch:api.example.com'], 'evil.example.com')).toBe(false);
    expect(allowsHost(['http:fetch:*.example.com'], 'a.example.com')).toBe(true);
    expect(allowsHost(['http:fetch:*.example.com'], 'example.com')).toBe(false);
    expect(allowsHost(['http:fetch:*.example.com'], 'badexample.com')).toBe(false);
    expect(allowsCollection(['items:write:posts'], 'write', 'posts')).toBe(true);
    expect(allowsCollection(['items:write:posts'], 'publish', 'posts')).toBe(false);
    expect(allowsCollection(['items:read:*'], 'read', 'pages')).toBe(true);
  });

  it('diff and approval', () => {
    expect(diffCapabilities(['ext:events', 'http:fetch:a.example.com'], ['ext:events', 'http:fetch:b.example.com'])).toEqual({
      added: ['http:fetch:b.example.com'], removed: ['http:fetch:a.example.com'], unchanged: ['ext:events'],
    });
    expect(approvalCovers(undefined, [])).toBe(true);
    expect(approvalCovers(undefined, ['ext:events'])).toBe(false);
    expect(approvalCovers(['ext:events', 'kv:read'], ['ext:events'])).toBe(true);
    expect(groupCapabilities(['ext:events', 'http:fetch:a.example.com']).map((g) => g.category)).toEqual(['network', 'extension-point']);
  });

  it('legacy migration narrows and never widens', () => {
    expect(migrateLegacyCapabilities(['db:read', 'env:read', 'items:read', 'http:fetch', 'http:fetch:a.example.com'], 'hook')).toEqual({
      capabilities: ['http:fetch:a.example.com', 'items:read:*', 'ext:events'],
      dropped: ['db:read', 'env:read', 'http:fetch'],
    });
  });
});

describe('plugin manifest (task 1.5)', () => {
  const base = { name: 'acme-glossary', version: '1.0.0', type: 'hook', entry: './index.js' };

  it('declares capabilities, outbound hosts, storage, admin pages / settings, version range and security contact', () => {
    const m = ExtensionManifestSchema.parse({
      ...base,
      capabilities: ['ext:events', 'ext:admin-panels', 'items:read:posts'],
      outboundHosts: ['api.example.com'],
      storage: { terms: { indexes: [['slug']] } },
      admin: { pages: [{ id: 'terms', title: 'Terms', storage: 'terms' }], settings: [{ key: 'mode', type: 'string' }] },
      heopress: '^1.0.0',
      security: { contact: 'security@example.com' },
    });
    expect(manifestCapabilities(m)).toContain('http:fetch:api.example.com');
    expect(MarketplaceManifestSchema.safeParse(m).success).toBe(true);
  });

  it('refuses invalid capabilities, admin pages without ext:admin-panels, bad ranges, hosts with a scheme', () => {
    expect(ExtensionManifestSchema.safeParse({ ...base, capabilities: ['env:read'] }).success).toBe(false);
    expect(ExtensionManifestSchema.safeParse({ ...base, admin: { pages: [{ id: 'x', title: 'X' }] } }).success).toBe(false);
    expect(ExtensionManifestSchema.safeParse({ ...base, heopress: 'not a range' }).success).toBe(false);
    expect(ExtensionManifestSchema.safeParse({ ...base, outboundHosts: ['https://api.example.com'] }).success).toBe(false);
    expect(MarketplaceManifestSchema.safeParse(base).success).toBe(false);
  });

  it('admin pages and widgets name declared storage; a custom page names its https frontend (task 3.6)', () => {
    const admin = (a: unknown, storage: unknown = { terms: { indexes: [] } }) =>
      ExtensionManifestSchema.safeParse({ ...base, capabilities: ['ext:admin-panels'], storage, admin: a }).success;
    expect(admin({ pages: [{ id: 't', title: 'T', storage: 'terms', columns: ['slug'] }], widgets: [{ id: 'n', title: 'N', storage: 'terms' }] })).toBe(true);
    expect(admin({ pages: [{ id: 't', title: 'T', storage: 'other' }] })).toBe(false);
    expect(admin({ widgets: [{ id: 'n', title: 'N', storage: 'other' }] })).toBe(false);
    expect(admin({ pages: [{ id: 's', title: 'S', type: 'settings' }] })).toBe(true);
    expect(admin({ pages: [{ id: 'c', title: 'C', type: 'custom' }] })).toBe(false);
    expect(admin({ pages: [{ id: 'c', title: 'C', type: 'custom', frontend: 'http://example.com/ui' }] })).toBe(false);
    expect(admin({ pages: [{ id: 'c', title: 'C', type: 'custom', frontend: 'https://example.com/ui' }] })).toBe(true);
  });
});

describe('HeoPress version ranges', () => {
  it.each([
    ['1.2.0', '^1.0.0', true],
    ['2.0.0', '^1.0.0', false],
    ['1.0.0-rc.4', '^1.0.0-rc.1', true],
    ['1.0.0-rc.4', '>=1.0.0', false],
    ['1.0.0-rc.4', '>=1.0.0-0', true],
    ['1.3.5', '~1.3.0', true],
    ['1.4.0', '~1.3.0', false],
    ['1.9.0', '>=1.2.0 <2.0.0', true],
    ['3.0.0', '^1.0.0 || ^3.0.0', true],
    ['1.2.3', '1.x', true],
    ['0.3.1', '^0.2.0', false],
    ['1.2.0', '*', true],
  ])('%s satisfies %s → %s', (version, range, expected) => {
    expect(satisfiesVersionRange(version, range)).toBe(expected);
  });
});
