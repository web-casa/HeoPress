import { describe, expect, it } from 'vitest';
import { astroBuildHealth } from '../routes/health';

/**
 * The build sandbox in the health response (HeoPress v1.5, spec rendering/astro-build-sandbox): an installation that
 * builds with a child process reports that it does not require the sandbox rather than a status for something it never
 * uses, and an installation that does require it reports why it is unavailable — without the probe's own failure ever
 * turning into a healthy answer.
 */
describe('build sandbox in health', () => {
  it('reports nothing to check when builds are not sandboxed', async () => {
    expect(await astroBuildHealth({} as NodeJS.ProcessEnv)).toEqual({ required: false, available: true });
  });

  it('reports availability when the sandbox is required', async () => {
    const health = await astroBuildHealth({ HEOPRESS_ASTRO_BUILD_SANDBOX: 'required' } as NodeJS.ProcessEnv, () => ({
      available: true,
    }));
    expect(health).toEqual({ required: true, available: true });
  });

  it('carries the reason when the runtime is missing', async () => {
    const health = await astroBuildHealth({ HEOPRESS_ASTRO_BUILD_SANDBOX: 'required' } as NodeJS.ProcessEnv, () => ({
      available: false,
      reason: 'cli_missing',
    }));
    expect(health).toEqual({ required: true, available: false, reason: 'cli_missing' });
  });

  it('is unavailable, not healthy, when the probe itself fails', async () => {
    const health = await astroBuildHealth({ HEOPRESS_ASTRO_BUILD_SANDBOX: 'required' } as NodeJS.ProcessEnv, () => {
      throw new Error('probe blew up');
    });
    expect(health).toEqual({ required: true, available: false, reason: 'probe_failed' });
  });
});
