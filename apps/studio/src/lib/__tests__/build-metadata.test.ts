// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { describe, expect, it } from 'vitest';
import { getStudioBuildMetadata } from '../build-metadata';

describe('getStudioBuildMetadata', () => {
  it('reads Studio build metadata from Vite env values', () => {
    expect(
      getStudioBuildMetadata({
        VITE_HEOPRESS_VERSION: '1.2.3',
        VITE_HEOPRESS_GIT_SHA: 'abc123def456',
        VITE_HEOPRESS_BUILD_TIME: '2026-06-06T00:00:00.000Z',
        VITE_HEOPRESS_RELEASE_CHANNEL: 'production',
      }),
    ).toEqual({
      version: '1.2.3',
      gitSha: 'abc123def456',
      buildTime: '2026-06-06T00:00:00.000Z',
      releaseChannel: 'production',
    });
  });

  it('falls back to unknown for missing or blank env values', () => {
    expect(
      getStudioBuildMetadata({
        VITE_HEOPRESS_VERSION: '',
        VITE_HEOPRESS_GIT_SHA: '   ',
        VITE_HEOPRESS_BUILD_TIME: undefined,
      }),
    ).toEqual({
      version: 'unknown',
      gitSha: 'unknown',
      buildTime: 'unknown',
      releaseChannel: 'unknown',
    });
  });
});
