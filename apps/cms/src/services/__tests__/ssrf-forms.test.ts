import { describe, expect, it } from 'vitest';
import { resolveAndValidateOutboundUrl, validateOutboundUrl } from '../ssrf-guard';

/**
 * SSRF suite of the v1 security review (HeoPress P13 task 3.3, docs/reviews/v1-security.md), CMS side: the early
 * URL check (`validateOutboundUrl`) that the plugin sandbox's `fetch`, Flow `http` operations and the extension
 * verifier run before the request reaches the platform boundary (`outboundFetch`, whose own suite is
 * `packages/runtime/src/__tests__/outbound-ssrf-forms.test.ts`). It must refuse every spelling of an internal target
 * already, so a refusal is reported to the plugin or flow with a reason instead of a network error.
 */

describe('validateOutboundUrl refuses internal targets in every spelling', () => {
  it.each([
    'http://127.0.0.1/',
    'http://2130706433/',
    'http://0177.0.0.1/',
    'http://0x7f.0.0.1/',
    'http://0x7f000001/',
    'http://127.1/',
    'http://0.0.0.0/',
    'http://0/',
    'http://10.0.0.1/',
    'http://167772161/',
    'http://172.16.5.4/',
    'http://192.168.1.1/',
    'http://100.64.0.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://2852039166/',
    'http://0xa9fea9fe/',
    'http://[::1]/',
    'http://[::]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[0:0:0:0:0:ffff:127.0.0.1]/',
    'http://[::ffff:169.254.169.254]/',
    'http://[fe80::1]/',
    'http://[fc00::1]/',
    'http://[fd00:ec2::254]/',
    'http://localhost/',
    'http://LOCALHOST/',
    'http://localhost./',
    'http://api.localhost/',
    'http://metadata.google.internal/',
  ])('%s', (raw) => {
    const verdict = validateOutboundUrl(raw);
    expect(verdict.allowed, `${raw} → ${verdict.reason ?? 'allowed'}`).toBe(false);
  });

  it.each(['file:///etc/passwd', 'gopher://127.0.0.1:70/_x', 'ftp://example.com/', 'data:text/plain,x', 'dict://127.0.0.1:11211/', 'javascript:alert(1)'])(
    'refuses the scheme of %s',
    (raw) => {
      expect(validateOutboundUrl(raw).allowed).toBe(false);
    },
  );

  it('refuses credentials in the URL and allows an ordinary public URL', () => {
    expect(validateOutboundUrl('https://user:pw@example.com/').allowed).toBe(false);
    expect(validateOutboundUrl('https://example.com/feed.xml').allowed).toBe(true);
  });

  it('with DNS resolution: a public name resolving to an IPv4-mapped internal address is refused', async () => {
    const verdict = await resolveAndValidateOutboundUrl('https://mapped.example.com/', {
      resolve: async () => ['::ffff:10.0.0.9'],
      requireDnsResolution: true,
    });
    expect(verdict.allowed).toBe(false);
  });
});

/**
 * Regression (v1 security review finding S-2): the Git snapshot remote (`git-snapshots/config.ts`
 * `validateRemoteUrl`) is checked here with DNS resolution, and its client then connects to the addresses returned
 * (`pinnedHttpClient`), not through `outboundFetch`. A site administrator's remote whose name resolved to an
 * IPv4-mapped loopback address (an AAAA record `::ffff:127.0.0.1`) or to CGNAT space passed and was connected to.
 */
describe('resolveAndValidateOutboundUrl: the addresses a pinned client would connect to', () => {
  it.each([['::ffff:127.0.0.1'], ['::ffff:7f00:1'], ['::7f00:1'], ['64:ff9b::7f00:1'], ['2002:7f00:1::'], ['100.64.0.1'], ['::ffff:169.254.169.254'], ['0.0.0.0'], ['::']])(
    'a remote resolving to %s is refused',
    async (ip) => {
      const verdict = await resolveAndValidateOutboundUrl('https://git.example.com/site.git', { resolve: async () => [ip], requireDnsResolution: true });
      expect(verdict.allowed).toBe(false);
    },
  );

  it('a remote resolving to public addresses is allowed, with the addresses to pin', async () => {
    const verdict = await resolveAndValidateOutboundUrl('https://git.example.com/site.git', {
      resolve: async () => ['93.184.215.14', '2606:2800:21f:cb07:6820:80da:af6b:8b2c'],
      requireDnsResolution: true,
    });
    expect(verdict.allowed).toBe(true);
    expect(verdict.resolvedIps).toEqual(['93.184.215.14', '2606:2800:21f:cb07:6820:80da:af6b:8b2c']);
  });
});
