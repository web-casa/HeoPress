/**
 * Remote plugin bundles (HeoPress P12 task 9.2): Node's module loader imports only `file:` and `data:` URLs, so a bundle
 * on a trusted origin is downloaded through the outbound boundary and imported from its bytes. Before, every remote
 * bundle failed to import in Node and no plugin ran outside the tests (which load inline `data:` bundles).
 *
 * A file of its own: the outbound boundary reads `HEOPRESS_TRUSTED_INTERNAL_ENDPOINTS` once per module instance.
 */
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Database } from '@heopress/database';
import type { Bindings } from '../../env';
import { ExtensionSandbox } from '../sandbox';
import { ExtensionVerifierService, buildSandboxVerifyOptions } from '../../services/extension-verifier';

declare global {
  // eslint-disable-next-line no-var
  var __p12remote: string[] | undefined;
}

const plugin = (tag: string) =>
  `globalThis.__p12remote = [...(globalThis.__p12remote ?? []), ${JSON.stringify(tag)}];\n` +
  `export default (ctx) => { ctx.extensionPoints.register('jobs', { name: ${JSON.stringify(tag)} }); return {}; };\n`;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** A bundle server on 127.0.0.1 answering `files` by path. */
async function serve(files: Record<string, string>): Promise<{ server: Server; origin: string }> {
  const server = createServer((req, res) => {
    const body = files[req.url ?? ''];
    if (body === undefined) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/javascript' }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

describe('ExtensionSandbox remote bundles (P12 task 9.2)', () => {
  const files = { '/good.js': plugin('good'), '/other.js': plugin('other') };
  let trusted: { server: Server; origin: string };
  let internal: { server: Server; origin: string };

  beforeAll(async () => {
    trusted = await serve(files);
    internal = await serve(files);
    // Both are bundle origins; only `trusted` is a trusted internal endpoint (loopback is internal).
    vi.stubEnv('EXTENSION_BUNDLE_ORIGINS', `${trusted.origin},${internal.origin}`);
    vi.stubEnv('HEOPRESS_TRUSTED_INTERNAL_ENDPOINTS', trusted.origin);
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    delete globalThis.__p12remote;
    await new Promise((r) => trusted.server.close(r));
    await new Promise((r) => internal.server.close(r));
  });

  const load = (bundleUrl: string, extra: Record<string, unknown> = {}) =>
    new ExtensionSandbox({}).load({ name: `remote-${bundleUrl}`, bundleUrl, capabilities: ['ext:jobs'], timeoutMs: 3_000, ...extra });

  it('downloads a bundle from a trusted origin and runs it', async () => {
    const mod = await load(`${trusted.origin}/good.js`);
    expect(mod?.registrations?.get('jobs')).toEqual([{ name: 'good' }]);
    expect(globalThis.__p12remote).toContain('good');
  });

  it('a signature-gated load runs only the signed bytes', async () => {
    const verify = async () => true;
    const signed = await load(`${trusted.origin}/good.js`, { requireSignature: true, verify, bundleSha256: sha256(files['/good.js']) });
    expect(signed).not.toBeNull();
    globalThis.__p12remote = [];
    // The server answers the loader with other bytes than were signed: refused before anything runs.
    const swapped = await load(`${trusted.origin}/other.js`, { requireSignature: true, verify, bundleSha256: sha256(files['/good.js']) });
    expect(swapped).toBeNull();
    expect(globalThis.__p12remote).toEqual([]);
  });

  it('an internal bundle origin not listed as a trusted internal endpoint is refused by the outbound boundary', async () => {
    globalThis.__p12remote = [];
    expect(await load(`${internal.origin}/good.js`)).toBeNull();
    expect(await load(`${trusted.origin}/missing.js`)).toBeNull();
    expect(globalThis.__p12remote).toEqual([]);
  });

  it('the verifier checks the bundle the sandbox will download, and the load path carries the signed digest', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    vi.spyOn(ExtensionVerifierService.prototype, 'resolveKey').mockResolvedValue({ publicKeyPem: pem, publisher: 'Example', official: true, revoked: false });
    const bytes = Buffer.from(files['/good.js']);
    const meta = {
      bundleUrl: `${trusted.origin}/good.js`,
      bundleSha256: sha256(files['/good.js']),
      signature: sign(null, bytes, privateKey).toString('base64'),
      publisherKeyId: 'example-key',
      signatureAlg: 'ed25519',
    };
    const verifier = new ExtensionVerifierService({} as Database, {} as Bindings);
    expect(await verifier.verifyByMetadata('heopress-example', meta)).toMatchObject({ ok: true, isOfficial: true });
    expect(await verifier.verifyByMetadata('heopress-example', { ...meta, bundleUrl: `${trusted.origin}/other.js` })).toMatchObject({ ok: false, reason: 'hash-mismatch' });

    const options = buildSandboxVerifyOptions({ name: 'heopress-example', isOfficial: true, ...meta }, {} as Database, {} as Bindings);
    expect(options).toMatchObject({ isOfficial: true, requireSignature: true, bundleSha256: meta.bundleSha256 });
    const mod = await new ExtensionSandbox({}).load({ name: 'heopress-example', bundleUrl: meta.bundleUrl, capabilities: ['ext:jobs'], timeoutMs: 3_000, ...options });
    expect(mod?.registrations?.get('jobs')).toEqual([{ name: 'good' }]);
  });
});
