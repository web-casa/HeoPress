import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanStaticOutput } from '../scan';

/** The static output scan (HeoPress P11 task 5.2): an output carrying a sample secret is refused. */

let dir: string;
async function fixture(files: Record<string, string>): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'heopress-scan-'));
  for (const [path, body] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), body);
  }
  return dir;
}
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

const CLEAN = {
  'index.html': '<!doctype html><html><head><link rel="canonical" href="https://www.example.com/"></head><body><a href="/about/">About</a></body></html>',
  'about/index.html': '<p>About us. We administer telescopes.</p>',
  '_astro/site.css': 'body{color:#111}',
  'robots.txt': 'User-agent: *\nAllow: /\nSitemap: https://www.example.com/sitemap.xml\n',
  '.well-known/security.txt': 'Contact: mailto:security@example.com\n',
};

describe('static output scan', () => {
  it('passes a clean output', async () => {
    expect(await scanStaticOutput(await fixture(CLEAN))).toEqual([]);
  });

  it('refuses a build whose output carries a sample secret, without echoing it', async () => {
    const secret = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
    const issues = await scanStaticOutput(await fixture({ ...CLEAN, '_astro/app.js': `const t = "${secret}";` }));
    expect(issues).toEqual([expect.objectContaining({ file: '_astro/app.js', rule: 'github-token' })]);
    expect(JSON.stringify(issues)).not.toContain(secret);
  });

  it.each([
    ['private key', 'k.txt', '-----BEGIN PRIVATE KEY-----\nMIIfake\n', 'private-key'],
    ['connection string', 'x/index.html', '<p>postgres://heo:pw123456@db.internal/heopress</p>', 'connection-string'],
    ['secret assignment', 'a.js', 'JWT_SECRET=abc', 'secret-assignment'],
    ['admin link', 'b/index.html', '<a href="https://cms.example.com/admin/items">edit</a>', 'admin-path'],
    ['API link', 'c/index.html', '<form action="/api/v1/items">', 'admin-path'],
    ['page data interface', 'd.js', 'fetch("http://127.0.0.1:4001/v1/page-data")', 'page-data-interface'],
    ['internal address', 'e/index.html', '<img src="http://10.0.0.5:9000/x.png">', 'internal-address'],
    ['database identifier', 'f.json', '{"table":"lumibase_items"}', 'database-identifier'],
  ])('refuses %s', async (_name, file, body, rule) => {
    const issues = await scanStaticOutput(await fixture({ ...CLEAN, [file]: body }));
    expect(issues.map((i) => i.rule)).toContain(rule);
  });

  it.each([
    ['.env', 'env-file'],
    ['config/.env.production', 'env-file'],
    ['package.json', 'package-config'],
    ['_astro/app.js.map', 'source-map'],
    ['certs/server.key', 'key-material'],
    ['_headers', 'platform-config'],
    ['vercel.json', 'platform-config'],
  ])('refuses a bundled %s', async (file, rule) => {
    const issues = await scanStaticOutput(await fixture({ ...CLEAN, [file]: '{}' }));
    expect(issues.map((i) => i.rule)).toContain(rule);
  });

  it('refuses the installation\'s own secrets and administration origin', async () => {
    const issues = await scanStaticOutput(await fixture({ ...CLEAN, 'g/index.html': '<p>x9-sample-installation-key</p><a href="https://studio.example.com/x">s</a>' }), {
      knownSecrets: ['x9-sample-installation-key'],
      adminOrigins: ['https://studio.example.com'],
    });
    expect(issues.map((i) => i.rule).sort()).toEqual(['admin-origin', 'installation-secret']);
  });
});
