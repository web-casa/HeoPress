import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OutboundBlockedError, outboundBlockOf } from '@heopress/runtime/node';
import { guardedProbe } from '../ssrf-guard';

/**
 * `guardedProbe` (HeoPress P07 task 3.9, the reachability check's requests) as it is — not a stub: internal, loopback and
 * metadata addresses are refused before anything is sent, a local server included. Nothing leaves the machine: every
 * address here is refused at the boundary (the redirect behaviour is the boundary's own test, `returnRedirect` in
 * packages/runtime/src/__tests__/outbound.test.ts; the options this probe passes, ssrf-guard-probe-options.test.ts).
 */

let seen = 0;
let server: Server;
let port = 0;

beforeAll(async () => {
  server = createServer((_req, res) => {
    seen++;
    res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' }).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

const opts = { method: 'GET', timeoutMs: 2000, maxResponseBytes: 1024 };

describe('guardedProbe', () => {
  it('refuses loopback, private, link-local and metadata addresses and localhost, before anything is sent', async () => {
    for (const url of [`http://127.0.0.1:${port}/`, 'http://10.0.0.5/', 'http://192.168.1.2/', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/', `http://localhost:${port}/`, 'http://metadata.google.internal/']) {
      const err = await guardedProbe(url, opts).catch((e: unknown) => e);
      expect(outboundBlockOf(err), url).toBeInstanceOf(OutboundBlockedError);
      expect((outboundBlockOf(err) as OutboundBlockedError).afterResponse, url).toBe(false);
    }
    // The local server (whose answer would redirect to the metadata address) was never reached.
    expect(seen).toBe(0);
  });

  it('refuses what is not an http(s) URL, and credentials in the URL', async () => {
    await expect(guardedProbe('file:///etc/passwd', opts)).rejects.toThrow(/blocked/);
    await expect(guardedProbe('https://user:pw@example.com/', opts)).rejects.toThrow(/blocked/);
    await expect(guardedProbe('not a url', opts)).rejects.toThrow(/blocked/);
  });
});
