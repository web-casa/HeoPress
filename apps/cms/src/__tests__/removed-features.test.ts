import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import app from '../index';

/**
 * Removed features stay removed (P02 spec platform/feature-surface,
 * "已移除功能不可访问"): their endpoints answer 404 and the OpenAPI document
 * does not describe them.
 */

const ENV = { ...process.env, HEOPRESS_ENV: 'development' } as unknown as Record<string, unknown>;

// Top-level keys of `paths:` (two-space indent) and `components.schemas:`
// (four-space indent), read line by line so the test needs no YAML parser.
function openapiKeys(): { paths: string[]; schemas: string[] } {
  const lines = readFileSync(join(__dirname, '..', '..', 'openapi.yaml'), 'utf8').split('\n');
  const paths: string[] = [];
  const schemas: string[] = [];
  let top = '';
  let section = '';
  for (const line of lines) {
    if (/^\S/.test(line)) top = line.replace(/:.*$/, '');
    else if (/^  [^\s#]/.test(line)) section = line.trim().replace(/:.*$/, '');
    if (top === 'paths' && /^  \/[^\s]*:\s*$/.test(line)) paths.push(line.trim().slice(0, -1).replace(/^['"]|['"]$/g, ''));
    if (top === 'components' && section === 'schemas' && /^    [A-Za-z][\w.-]*:/.test(line)) schemas.push(line.trim().replace(/:.*$/, ''));
  }
  return { paths, schemas };
}
const openapi = openapiKeys();

describe('removed features', () => {
  it.each(['/scim/v2/Users', '/scim/v2/Groups', '/scim/v2/ServiceProviderConfig'])('%s answers 404', async (path) => {
    const res = await app.request(path, { headers: { authorization: 'Bearer scim-token' } }, ENV);
    expect(res.status).toBe(404);
  });

  it.each([
    ['SCIM', /scim/i],
    ['CDC pipelines and deployments', /^\/cdc\/(pipelines|deploy)/],
    ['Firebase sync', /firebase/i],
    ['Web Push', /^\/push(\/|$)/],
  ])('OpenAPI has no %s paths', (_name, pattern) => {
    expect(openapi.paths.filter((p) => pattern.test(p))).toEqual([]);
  });

  it('no route is registered for the removed surfaces', () => {
    // Unknown /api/v1 paths still pass auth first (401 without a session), so
    // the route table is the direct evidence that nothing serves them.
    const paths = app.routes.map((r) => r.path);
    expect(paths.length).toBeGreaterThan(100);
    for (const removed of [/^\/api\/v1\/push(\/|$)/, /^\/scim/, /^\/api\/v1\/scim-tokens/, /firebase-sync/, /^\/api\/v1\/cdc\/(pipelines|deploy)/]) {
      expect(paths.filter((p) => removed.test(p)), String(removed)).toEqual([]);
    }
    expect(paths.some((p) => p.startsWith('/api/v1/cdc/events'))).toBe(true);
  });

  it('OpenAPI has no schemas for the removed features', () => {
    const names = openapi.schemas;
    expect(names.filter((n) => /scim|firebase|^CdcPipeline|^CdcDeploy|CdcConnector/i.test(n))).toEqual([]);
  });

  it('OpenAPI keeps the Change Feed', () => {
    expect(openapi.paths.length).toBeGreaterThan(50);
    expect(openapi.paths).toEqual(expect.arrayContaining(['/cdc/events', '/cdc/subscriptions']));
    expect(openapi.schemas.length).toBeGreaterThan(20);
  });
});
