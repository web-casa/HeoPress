/**
 * The sandbox boundary of a plugin translation service (HeoPress v1.2, spec extensions/translation-services "沙箱边界").
 *
 * A service is ordinary plugin code: it reaches an external API only through the `http:fetch:<host>` capability (still
 * behind the host's outbound guard) and a key only through `secrets:<name>` resolved by the host. There is no inline key
 * field in a manifest and no db/env access, and every refused use is recorded.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CapabilityError, ExtensionSandbox, type CapabilityDeniedEvent } from '../sandbox';

/** The sandbox context as a plugin sees it. */
interface Ctx {
  fetch(url: string, init?: RequestInit): Promise<Response>;
  secrets: { get(name: string): Promise<string | null> };
  extensionPoints: { register(point: string, definition: unknown): void };
}
type Trusted = { isTrustedBundleUrl(url: string): boolean };

declare global {
  // eslint-disable-next-line no-var
  var __heopressTranslationCtx: Record<string, unknown> | undefined;
}

/** A bundle registering a translation service on the point (the registration itself is what the host later validates). */
function bundleUrl(): string {
  const source = `export default (ctx) => {
    globalThis.__heopressTranslationCtx = ctx;
    ctx.extensionPoints.register('translation-services', { id: 'deepl', translate: async (req) => req });
    return {};
  }`;
  return `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`;
}

async function loadCtx(
  capabilities: string[],
  deps: {
    onDenied?: (event: CapabilityDeniedEvent) => void;
    secrets?: (extension: string, name: string) => Promise<string | null>;
  } = {},
): Promise<Ctx> {
  globalThis.__heopressTranslationCtx = undefined;
  const sandbox = new ExtensionSandbox({}, deps);
  vi.spyOn(sandbox as unknown as Trusted, 'isTrustedBundleUrl').mockReturnValue(true);
  await sandbox.load({
    name: 'heopress-deepl',
    bundleUrl: bundleUrl(),
    capabilities,
  });
  return globalThis.__heopressTranslationCtx as unknown as Ctx;
}

describe('a translation service in the sandbox', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registers on its point with the capability, and only there', async () => {
    const onDenied = vi.fn();
    const ctx = await loadCtx(['ext:translation-services'], { onDenied });
    expect(() => ctx.extensionPoints.register('translation-services', { id: 'google' })).not.toThrow();
    expect(() => ctx.extensionPoints.register('endpoints', { name: 'x' })).toThrow(CapabilityError);
    expect(onDenied).toHaveBeenCalledWith(expect.objectContaining({ capability: 'ext:endpoints' }));
  });

  it('refuses a host the manifest did not declare, and records it', async () => {
    const onDenied = vi.fn();
    const ctx = await loadCtx(['ext:translation-services', 'http:fetch:api.deepl.example'], { onDenied });
    await expect(ctx.fetch('https://evil.example/v2/translate')).rejects.toBeInstanceOf(CapabilityError);
    expect(onDenied).toHaveBeenCalledWith(
      expect.objectContaining({ capability: 'http:fetch:evil.example', operation: 'fetch' }),
    );
  });

  it('lets a declared host through the capability check (the outbound guard still applies)', async () => {
    const ctx = await loadCtx(['ext:translation-services', 'http:fetch:127.0.0.1']);
    // The host is declared, so the refusal — if any — is the outbound boundary/SSRF guard, never a missing capability.
    await ctx.fetch('http://127.0.0.1:1/v2/translate').catch((err: unknown) => {
      expect(err).not.toBeInstanceOf(CapabilityError);
    });
  });

  it('reads a declared secret from the host and refuses any other name', async () => {
    const secrets = vi.fn().mockResolvedValue('test-key-value');
    const onDenied = vi.fn();
    const ctx = await loadCtx(['ext:translation-services', 'secrets:deepl-key'], { secrets, onDenied });
    await expect(ctx.secrets.get('deepl-key')).resolves.toBe('test-key-value');
    await expect(ctx.secrets.get('openai-key')).rejects.toBeInstanceOf(CapabilityError);
    expect(secrets).toHaveBeenCalledTimes(1);
    expect(secrets).toHaveBeenCalledWith('heopress-deepl', 'deepl-key');
    expect(onDenied).toHaveBeenCalledWith(expect.objectContaining({ capability: 'secrets:openai-key', operation: 'secrets.get' }));
  });

  it('has no db or env escape hatch on the context', async () => {
    const ctx = await loadCtx(['ext:translation-services', 'http:fetch:api.deepl.example', 'secrets:deepl-key']);
    expect(ctx).not.toHaveProperty('db');
    expect(ctx).not.toHaveProperty('env');
  });
});
