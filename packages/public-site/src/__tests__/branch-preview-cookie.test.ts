import { describe, expect, it } from 'vitest';
import { branchPreviewCookieOf, signBranchPreviewCookie, verifyBranchPreviewCookie } from '../branch-preview-cookie';

/** HeoPress P10 task 4.2: the signed branch preview cookie is bound to its site, its key and its expiry. */

const KEY = 'k'.repeat(40);
const NOW = 1_800_000_000_000;
const claims = { siteId: 'site_a', grantId: 'g1', versionId: 'v1', expiresAt: NOW / 1000 + 600 };

describe('branch preview cookie', () => {
  it('verifies for its site before expiry, and only then', () => {
    const value = signBranchPreviewCookie(KEY, claims);
    expect(value).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    expect(verifyBranchPreviewCookie(KEY, value, 'site_a', NOW)).toEqual(claims);
    expect(verifyBranchPreviewCookie(KEY, value, 'site_b', NOW)).toBeNull();
    expect(verifyBranchPreviewCookie(KEY, value, 'site_a', NOW + 601_000)).toBeNull();
    expect(verifyBranchPreviewCookie('x'.repeat(40), value, 'site_a', NOW)).toBeNull();
  });

  it('refuses an altered payload or signature and malformed values', () => {
    const value = signBranchPreviewCookie(KEY, claims);
    const [v, payload, sig] = value.split('.') as [string, string, string];
    const other = Buffer.from(JSON.stringify({ s: 'site_a', g: 'g2', b: 'v1', e: claims.expiresAt })).toString('base64url');
    expect(verifyBranchPreviewCookie(KEY, `${v}.${other}.${sig}`, 'site_a', NOW)).toBeNull();
    expect(verifyBranchPreviewCookie(KEY, `${v}.${payload}.${sig.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}`, 'site_a', NOW)).toBeNull();
    for (const bad of ['', 'v1', 'v2.a.b', `${value}x`, 'v1..']) expect(verifyBranchPreviewCookie(KEY, bad, 'site_a', NOW)).toBeNull();
  });

  it('reads its value from a Cookie header', () => {
    expect(branchPreviewCookieOf('a=1; heopress_branch_preview=v1.x.y; b=2')).toBe('v1.x.y');
    expect(branchPreviewCookieOf('heopress_preview=abc')).toBeNull();
    expect(branchPreviewCookieOf(undefined)).toBeNull();
  });
});
