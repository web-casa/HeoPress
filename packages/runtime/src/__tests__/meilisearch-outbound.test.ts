import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MeiliSearchProvider } from '../adapters/docker/search';
import { parseTrustedEndpoints } from '../outbound/fetch';

/**
 * The MeiliSearch SDK's requests go through the outbound boundary (P03 task
 * 4.5; Codex review 4, #1): a trusted MeiliSearch host cannot redirect the
 * client to another internal origin or a metadata address.
 */

function listen(handler: http.RequestListener): Promise<{ server: http.Server; origin: string; hits: string[] }> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url ?? '');
    handler(req, res);
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits })),
  );
}

describe('MeiliSearchProvider transport', () => {
  let meili: Awaited<ReturnType<typeof listen>>;
  let other: Awaited<ReturnType<typeof listen>>;
  let target = '';

  beforeAll(async () => {
    other = await listen((_req, res) => res.end('{"hits":[],"estimatedTotalHits":0,"processingTimeMs":0}'));
    meili = await listen((req, res) => {
      if (req.url?.includes('/indexes/not_yet__posts/')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'Index `not_yet__posts` not found.', code: 'index_not_found', type: 'invalid_request', link: '' }));
        return;
      }
      if (req.url?.includes('/indexes/broken__posts/')) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'internal', code: 'internal', type: 'internal', link: '' }));
        return;
      }
      if (req.url?.includes('/redirect-')) {
        res.writeHead(302, { location: target });
        res.end();
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ hits: [{ id: 'a' }], estimatedTotalHits: 1, processingTimeMs: 1 }));
    });
  });

  afterAll(async () => {
    await Promise.all([meili, other].map((s) => new Promise((r) => s.server.close(r))));
  });

  it('reaches a trusted internal host', async () => {
    const provider = new MeiliSearchProvider(meili.origin, 'key', parseTrustedEndpoints(meili.origin));
    expect((await provider.search('site__posts', 'q')).hits).toEqual([{ id: 'a' }]);
  });

  it('an index that does not exist yet has nothing to find; other errors still fail', async () => {
    const provider = new MeiliSearchProvider(meili.origin, 'key', parseTrustedEndpoints(meili.origin));
    expect(await provider.search('not_yet__posts', 'q')).toEqual({ hits: [], totalHits: 0, processingTimeMs: 0 });
    expect(await provider.getIndex('not_yet__posts')).toEqual({ numberOfDocuments: 0 });
    await expect(provider.search('broken__posts', 'q')).rejects.toThrow();
  });

  it('refuses an internal host that is not trusted, before sending', async () => {
    expect(() => new MeiliSearchProvider(other.origin, 'key', parseTrustedEndpoints(''))).toThrow(/outbound request blocked/);
  });

  it('does not follow a redirect to another internal origin or a metadata address', async () => {
    const provider = new MeiliSearchProvider(`${meili.origin}/redirect-base/`, 'key', parseTrustedEndpoints(meili.origin));
    for (const to of [`${other.origin}/stolen`, 'http://169.254.169.254/latest/meta-data']) {
      target = to;
      await expect(provider.search('site__posts', 'q')).rejects.toThrow();
    }
    expect(other.hits).toEqual([]);
  });
});
