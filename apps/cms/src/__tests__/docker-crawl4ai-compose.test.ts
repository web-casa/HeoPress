import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { instanceCrawl4aiEndpoint } from '../services/ingest/providers/http';

/**
 * The `crawl4ai` compose profile (HeoPress P08 task 3.7; ADR-0014 §5–6), checked on the file itself — CI cannot run
 * Docker. Crawl4AI is only on the `crawler` network, which only the worker shares; the database is not on it, so
 * nothing in the Crawl4AI container can resolve or reach `postgres:5432`. The endpoint is registered for the CMS
 * without manual configuration. Manual verification on a host with Docker (docs/zh-CN/content/crawl-services.md):
 *
 *   docker compose -f docker/docker-compose.yml --profile crawl4ai up -d
 *   docker compose -f docker/docker-compose.yml exec crawl4ai python -c \
 *     "import socket; socket.create_connection(('postgres', 5432), 3)"   # expect: an error (name not resolved)
 */

const compose = readFileSync(join(__dirname, '../../../../docker/docker-compose.yml'), 'utf-8');

/** The top-level blocks of a section (`services:` / `networks:`), by two-space indentation. */
function blocks(section: string): Map<string, string> {
  const lines = compose.split('\n');
  const start = lines.findIndex((l) => l === `${section}:`);
  expect(start, `${section}: section`).toBeGreaterThanOrEqual(0);
  const out = new Map<string, string>();
  let name: string | null = null;
  let body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const m = /^ {2}([\w-]+):\s*$/.exec(line);
    if (m) {
      if (name) out.set(name, body.join('\n'));
      name = m[1]!;
      body = [];
    } else if (name) body.push(line);
  }
  if (name) out.set(name, body.join('\n'));
  return out;
}

/** The networks a service block lists (none: `default` only). */
function networksOf(block: string): string[] {
  const m = /^ {4}networks:\s*\n((?: {6}- .*\n?)+)/m.exec(block);
  if (!m) return ['default'];
  return m[1]!
    .split('\n')
    .map((l) => l.replace(/^\s*-\s*/, '').trim())
    .filter(Boolean);
}

describe('crawl4ai compose profile', () => {
  const services = blocks('services');
  const networks = blocks('networks');

  it('Crawl4AI is behind its profile, on the crawler network only, with no host port', () => {
    const c = services.get('crawl4ai')!;
    expect(c).toMatch(/profiles: \["crawl4ai"\]/);
    expect(networksOf(c)).toEqual(['crawler']);
    expect(c).not.toMatch(/^ {4}ports:/m);
    expect(c).not.toMatch(/network_mode/);
  });

  it('only the worker shares the crawler network; the database and the API are not on it', () => {
    const onCrawler = [...services].filter(([, b]) => networksOf(b).includes('crawler')).map(([n]) => n).sort();
    expect(onCrawler).toEqual(['cms-worker', 'crawl4ai']);
    expect(networksOf(services.get('postgres')!)).toEqual(['default']);
    expect(networksOf(services.get('cms')!)).toEqual(['default']);
    expect(networksOf(services.get('cms-worker')!)).toEqual(['default', 'crawler']);
  });

  it('the crawler network reaches the internet (not internal) and is a separate network', () => {
    expect(networks.has('crawler')).toBe(true);
    expect(networks.get('crawler')).not.toMatch(/internal:\s*true/);
  });

  it('the endpoint is registered automatically for the Crawl4AI service', () => {
    const m = /HEOPRESS_CRAWL4AI_ENDPOINT: \$\{HEOPRESS_CRAWL4AI_ENDPOINT-(\S+)\}/.exec(compose);
    expect(m?.[1]).toBe('http://crawl4ai:11235');
    expect(instanceCrawl4aiEndpoint({ HEOPRESS_CRAWL4AI_ENDPOINT: m![1] })).toBe('http://crawl4ai:11235');
    expect(instanceCrawl4aiEndpoint({ HEOPRESS_CRAWL4AI_ENDPOINT: '' })).toBeNull();
  });
});
