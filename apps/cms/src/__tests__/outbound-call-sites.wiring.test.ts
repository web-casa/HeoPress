import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every outbound HTTP request of the server code goes through the platform boundary (HeoPress P13 task 3.3, SSRF
 * suite of the v1 security review; AGENTS.md "任何外部 URL 抓取必须经过 SSRF 防护"; spec platform/outbound-security).
 *
 * Source scan of the server code (CMS, runtime adapters, rendering service): a global `fetch(`, `globalThis.fetch`,
 * `undici`, a value import of `node:http(s)` used as a client, `http(s).request/get` or an HTTP client library is
 * allowed only in the files listed below, each with the reason it is safe. A new raw client fails here until it uses
 * `outboundFetch` / `guardedFetch` (or is reviewed and listed).
 *
 * Evidence class: source scan of the real files. No request is made.
 */

const REPO = join(__dirname, '..', '..', '..', '..');
const ROOTS = ['apps/cms/src', 'packages/runtime/src', 'apps/site-classic/src'];

const ALLOWED: Record<string, string> = {
  'packages/runtime/src/outbound/fetch.ts': 'the boundary itself (undici agent with the connect-time lookup)',
  'packages/runtime/src/adapters/docker/storage.ts': 'S3 SDK agents built with guardedLookup and serviceEndpointPolicy',
  'apps/cms/src/services/git-snapshots/git.ts': 'https client pinned to the addresses resolveAndValidateOutboundUrl vetted',
  'apps/cms/src/routes/test-auth.ts': 'browser script inside the development-only playground page (404 in production)',
  'apps/cms/src/services/backup/drill.ts': 'replaces globalThis.fetch to refuse the network during a restore drill',
  'apps/site-classic/src/page-data.ts': 'a local server (createServer), not a client',
};

const RAW: Array<{ name: string; re: RegExp; needsNodeHttp?: boolean }> = [
  { name: 'global fetch', re: /(^|[^.\w$])fetch\(/ },
  { name: 'globalThis.fetch', re: /globalThis\.fetch\b/ },
  { name: 'undici', re: /from ['"]undici['"]|require\(['"]undici['"]\)/ },
  { name: 'node:http(s) value import', re: /^import\s+(?!type\b)[^;]*from ['"](node:)?https?['"]/ },
  // Only where node:http(s) is imported: the ingest providers' `http.request` is the boundary's client, injected.
  { name: 'http(s).request/get', re: /\bhttps?\.(request|get)\(|\bhttpsRequest\(/, needsNodeHttp: true },
  { name: 'HTTP client library', re: /from ['"](axios|got|node-fetch|superagent|request)['"]/ },
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules' || entry === 'dist' || entry === 'test-utils') continue;
      out.push(...sourceFiles(abs));
    } else if (/\.(c|m)?tsx?$/.test(entry) && !/\.(test|spec)\.(c|m)?tsx?$/.test(entry) && !entry.endsWith('.d.ts')) {
      out.push(abs);
    }
  }
  return out;
}

function rawClientUses(file: string): string[] {
  const hits: string[] = [];
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const importsNodeHttp = /^import\s+(?!type\b)[^;]*from ['"](node:)?https?['"]/m.test(text) || /require\(['"](node:)?https?['"]\)/.test(text);
  lines.forEach((line, i) => {
    const code = line.trim();
    if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return;
    for (const { name, re, needsNodeHttp } of RAW) if (re.test(line) && (!needsNodeHttp || importsNodeHttp)) hits.push(`${i + 1}: ${name}`);
  });
  return hits;
}

describe('outbound HTTP call sites', () => {
  const files = ROOTS.flatMap((root) => sourceFiles(join(REPO, root)));

  it('the scan sees the server code', () => {
    expect(files.length).toBeGreaterThan(500);
  });

  it('raw HTTP clients appear only in the reviewed files', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(REPO, file).split(sep).join('/');
      if (ALLOWED[rel]) continue;
      for (const hit of rawClientUses(file)) offenders.push(`${rel}:${hit}`);
    }
    expect(offenders, 'use outboundFetch / guardedFetch (packages/runtime/src/outbound/fetch.ts) or review and list the file').toEqual([]);
  });

  it('every reviewed file still exists and still needs its entry', () => {
    for (const rel of Object.keys(ALLOWED)) {
      expect(rawClientUses(join(REPO, rel)).length, `${rel} has no raw client any more: remove it from ALLOWED`).toBeGreaterThan(0);
    }
  });

  it('the content-facing callers reach the boundary with purpose "user"', () => {
    const guard = readFileSync(join(REPO, 'apps/cms/src/services/ssrf-guard.ts'), 'utf8');
    expect(guard.match(/purpose: 'user'/g)?.length).toBe(2);
  });
});
