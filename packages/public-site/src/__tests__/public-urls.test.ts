import { describe, expect, it } from 'vitest';
import { SitePathSpace, type SiteSpaceInput } from '../path-space';
import { publicUrlOf, publicUrlsOf } from '../resolve-path';

/**
 * Every address of a content path (HeoPress P07 task 3.9: the reachability check requests each host at its own
 * addresses): the canonical one first, then a language entry domain's under the subdirectory strategy.
 */
const space = (over: Partial<SiteSpaceInput> = {}) =>
  new SitePathSpace({
    defaultLanguage: 'en',
    availableLocales: ['en', 'fr'],
    localeStrategy: 'subdirectory',
    localePrefixMode: 'default_at_root',
    localePrefixes: {},
    trailingSlash: 'always',
    primaryHost: 'example.com',
    entryHosts: [{ hostname: 'fr.example.com', locale: 'fr' }],
    ...over,
  });

describe('publicUrlsOf', () => {
  it('subdirectory: the canonical address under the prefix, then the entry domain at the content path', () => {
    expect(publicUrlsOf(space(), 'fr', '/salut')).toEqual(['https://example.com/fr/salut/', 'https://fr.example.com/salut/']);
    expect(publicUrlsOf(space(), 'fr', '/')).toEqual(['https://example.com/fr/', 'https://fr.example.com/']);
    expect(publicUrlsOf(space(), 'en', '/hello')).toEqual(['https://example.com/hello/']);
    expect(publicUrlsOf(space(), 'fr', '/salut')[0]).toBe(publicUrlOf(space(), 'fr', '/salut'));
  });

  it('domain strategy: the entry domain is the canonical address, once', () => {
    expect(publicUrlsOf(space({ localeStrategy: 'domain', trailingSlash: 'never' }), 'fr', '/salut')).toEqual(['https://fr.example.com/salut']);
  });
});
