#!/usr/bin/env node
/**
 * The official glossary plugin on the benchmark's sites (HeoPress P12 task 10.5): `bench-p06-classic.sh` with
 * `BENCH_GLOSSARY=1` measures the same pages with the reference plugin enabled on every site.
 *
 *   node docker/scripts/bench-glossary.mjs key <dir>                          # an Ed25519 key pair for this run → <dir>
 *   node docker/scripts/bench-glossary.mjs install <cms-url> <dir> <site>...  # install, enable, three terms per site
 *
 * The bundle is the plugin's built `dist/index.js` (`pnpm --filter @heopress/plugin-glossary build`), signed with the
 * run's key, which the script registers as an official publisher key (`lumibase_publisher_keys`) before `install`.
 * It is installed as an inline bundle: the rendering service never runs plugin code; what it reads is the plugin's
 * routes, templates, components and structured data in the public projection. The terms are words the benchmark's
 * articles do not contain, so the measured pages are the P06 pages.
 */
import { createHash, createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BENCH_KEY_ID = 'heopress-bench-official';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const plugin = path.join(root, 'packages/plugin-glossary');
const email = 'smoke-admin@example.test';
const password = 'Smoke-Test-Pass-1!';

async function call(base, method, url, site, token, body) {
  const res = await fetch(`${base}/api/v1${url}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-heopress-site': site, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url} (${site}) answered ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function install(base, dir, sites) {
  const bytes = fs.readFileSync(path.join(plugin, 'dist/index.js'));
  const { name, version, type, entry: _entry, capabilities, ...manifest } = JSON.parse(fs.readFileSync(path.join(plugin, 'heopress-extension.json'), 'utf8'));
  const privateKey = createPrivateKey(fs.readFileSync(path.join(dir, 'bench-key.pem')));
  const request = {
    name,
    version,
    type,
    enabled: true,
    bundleUrl: `data:text/javascript;base64,${bytes.toString('base64')}`,
    capabilities,
    approvedCapabilities: capabilities,
    manifest,
    bundleSha256: createHash('sha256').update(bytes).digest('hex'),
    signature: sign(null, bytes, privateKey).toString('base64'),
    publisherKeyId: BENCH_KEY_ID,
    signatureAlg: 'ed25519',
  };
  for (const site of sites) {
    const token = (await call(base, 'POST', '/auth/login', site, null, { email, password })).data.token;
    const row = (await call(base, 'POST', '/extensions', site, token, request)).data;
    if (!row.enabled || !row.isOfficial) throw new Error(`${site}: the plugin is not enabled as an official plugin`);
    for (const [title, slug] of [['Zephyr', 'zephyr'], ['Quokka', 'quokka'], ['Nimbus', 'nimbus']]) {
      await call(base, 'POST', '/items/heopress_glossary__terms', site, token, {
        data: { title, slug, excerpt: `${title}, a glossary term.`, body: `<p>${title} explained.</p>`, source_url: `https://example.com/${slug}` },
        status: 'published',
      });
    }
    console.log(`[bench-glossary] ${site}: ${name}@${version} enabled (official signature), 3 terms`);
  }
}

const [mode, ...args] = process.argv.slice(2);
if (mode === 'key') {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  fs.writeFileSync(path.join(args[0], 'bench-key.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  fs.writeFileSync(path.join(args[0], 'bench-key.pub.pem'), publicKey.export({ type: 'spki', format: 'pem' }));
} else if (mode === 'install') {
  install(args[0], args[1], args.slice(2)).catch((err) => {
    console.error(`[bench-glossary] FAIL: ${err.message}`);
    process.exitCode = 1;
  });
} else {
  console.error('usage: bench-glossary.mjs key <dir> | install <cms-url> <dir> <site>...');
  process.exitCode = 2;
}
