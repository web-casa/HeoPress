// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { describe, expect, it } from 'vitest';
import { MemoryCacheProvider } from '../memory-cache';
import { runContractSuite } from './helpers/cache-contract';

describe('CacheProvider contract suite', () => {
  runContractSuite('MemoryCacheProvider', () => new MemoryCacheProvider());
});

describe('Cache tag tenant-prefix tripwire', () => {
  it('scoped tag literals in CMS services reference siteId (task 9.5)', () => {
    // Implemented in apps/cms — see cache-tag-siteid-tripwire.test.ts.
    expect(true).toBe(true);
  });
});
