#!/usr/bin/env node
/**
 * The Extension SDK and the glossary plugin accepted as packed artifacts (P12 task 9.2, ADR-0017).
 *
 *   node scripts/verify-plugin-package.mjs
 *
 * Needs a migrated, empty, disposable database (`DATABASE_URL`, the application role; `HEOPRESS_E2E_DISPOSABLE_DB=true`)
 * and the built CMS (`pnpm --filter @heopress/cms build` → apps/cms/dist/serve.cjs). CI runs it in the `plugin-package`
 * job.
 *
 * 1. Builds and packs (`pnpm pack`) `@heopress/extension-sdk` and `@heopress/plugin-glossary`. The SDK tarball must hold
 *    only its built files, LICENSE and NOTICE (no source, no core implementation: no dependency, no import, none of the
 *    core's modules or tables); the plugin tarball must hold a self-contained bundle and its manifest.
 * 2. Installs both tarballs into a clean project in a temporary directory outside the repository with npm `--offline`
 *    (no workspace, no monorepo source alias): they are the only packages installed. Type-checks the plugin's shipped
 *    source against the installed SDK alone.
 * 3. Starts the built CMS against the database, with an official publisher key generated for this run and a bundle
 *    server on 127.0.0.1 as the trusted bundle origin; then, over the HTTP API as an administrator:
 *    install (signed; a tampered signature is refused) → execute (a published article's terms are linked by the
 *    plugin's event subscription) → upgrade (a newer packed version requesting one more capability waits for approval,
 *    then runs: the CMS downloads its bundle) → disable (nothing is linked any more; the term collection stays) →
 *    uninstall (the plugin is gone, its data stays until exported and purged).
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runtimeLoads } from './verify-plugin-template.mjs';

const SDK = '@heopress/extension-sdk';
const PLUGIN = '@heopress/plugin-glossary';
const NAME = 'heopress-glossary';
const NAMESPACE = 'heopress_glossary';
const TERMS = `${NAMESPACE}__terms`;
/** The key id setup registers as the official publisher key (apps/cms/src/modules/setup/official-extensions.ts). */
const OFFICIAL_KEY_ID = 'heopress-official-v1';
/** The capability the upgrade adds (it needs the admin's approval). */
const ADDED_CAPABILITY = 'items:read:pages';

/** What only the core implements: none of it may appear in the published SDK. */
const CORE_MARKERS = [
  /@heopress\/(?!extension-sdk\b)[a-z-]+/,
  /\bdrizzle-orm\b/,
  /\bpostgres\b\s*\(/,
  /\blumibase_[a-z_]+/,
  /\bfrom\s+['"]hono['"]/,
  /\bItemService\b/,
  /\bExtensionSandbox\b/,
  /\bPluginHost\b/,
  /\bprocess\.env\b/,
];

/** Files the SDK tarball may hold. */
const SDK_FILES = /^package\/(package\.json|LICENSE|NOTICE|README\.md|dist\/index\.(js|cjs|d\.ts|d\.cts))$/;

/** Problems in the packed SDK: its package.json, its file list and its built code (`code`: file → text). */
export function checkSdkPackage(manifest, files, code) {
  const problems = [];
  if (manifest.name !== SDK) problems.push(`the SDK tarball is ${manifest.name ?? '?'}, not ${SDK}`);
  if (manifest.license !== 'Apache-2.0') problems.push(`the SDK declares license "${manifest.license ?? 'missing'}", not Apache-2.0`);
  for (const f of files) if (!SDK_FILES.test(f)) problems.push(`the SDK tarball holds ${f}: only the built files, LICENSE and NOTICE are published`);
  for (const f of ['package/dist/index.js', 'package/dist/index.d.ts', 'package/LICENSE', 'package/NOTICE']) {
    if (!files.includes(f)) problems.push(`the SDK tarball has no ${f.replace(/^package\//, '')}`);
  }
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies', 'bundleDependencies', 'bundledDependencies']) {
    const deps = manifest[field];
    if (deps && (Array.isArray(deps) ? deps.length : Object.keys(deps).length)) problems.push(`the SDK has ${field}: a plugin would install more than the SDK`);
  }
  for (const [file, text] of Object.entries(code)) {
    if (/\.c?js$/.test(file)) {
      const loads = runtimeLoads(text);
      const imports = [...text.matchAll(/^\s*import\s[^;]*?from\s*['"]([^'"]+)['"]/gm), ...text.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
      if (imports.length || loads.computed.length) problems.push(`${file} loads ${[...imports, ...loads.computed].join(', ')} at run time: the SDK is self-contained`);
    }
    // Code only: a comment may name a core module (e.g. where a type is validated).
    const bare = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, '');
    for (const marker of CORE_MARKERS) {
      const hit = marker.exec(bare);
      if (hit) problems.push(`${file} contains "${hit[0]}": core implementation does not belong in the SDK`);
    }
  }
  return problems;
}

/** Problems in the packed plugin: its package.json, file list, bundle and manifest. */
export function checkPluginPackage(manifest, files, bundle, extension) {
  const problems = [];
  if (manifest.license !== 'Apache-2.0') problems.push(`the plugin declares license "${manifest.license ?? 'missing'}", not Apache-2.0`);
  for (const f of ['package/dist/index.js', 'package/heopress-extension.json', 'package/LICENSE', 'package/NOTICE']) {
    if (!files.includes(f)) problems.push(`the plugin tarball has no ${f.replace(/^package\//, '')}`);
  }
  for (const f of files) if (/__tests__|\.test\.[cm]?[jt]s$/.test(f)) problems.push(`the plugin tarball holds a test: ${f}`);
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const dep of Object.keys(manifest[field] ?? {})) {
      if (/^(?:heopress|@heopress)(?:\/|$)/.test(dep)) problems.push(`the plugin ${field} names ${dep}: it installs no HeoPress package`);
    }
  }
  const loads = runtimeLoads(bundle);
  if (/^\s*import\s|\bimport\s*\(|\brequire\s*\(/m.test(bundle) || loads.computed.length) problems.push('dist/index.js loads something at run time: the bundle is one self-contained module');
  if (loads.heopress.length) problems.push(`dist/index.js names ${loads.heopress.join(', ')}`);
  if (extension?.name !== NAME) problems.push(`heopress-extension.json names ${extension?.name ?? 'nothing'}, not ${NAME}`);
  if (!Array.isArray(extension?.capabilities) || extension.capabilities.length === 0) problems.push('heopress-extension.json declares no capabilities');
  return problems;
}

/** Problems in the clean project's installed tree (`packages`: npm lock keys → package.json, `links`: symlinked paths). */
export function checkCleanInstall(packages, links) {
  const problems = [];
  const names = Object.values(packages).map((p) => p.name).sort();
  if (names.join(',') !== [SDK, PLUGIN].sort().join(',')) problems.push(`the clean project installed ${names.join(', ') || 'nothing'}; expected only ${SDK} and ${PLUGIN}`);
  for (const l of links) problems.push(`${l} is a link (a workspace or source alias), not an installed package`);
  return problems;
}

// ─── The run ─────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const serve = path.join(root, 'apps/cms/dist/serve.cjs');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required (a migrated, empty, disposable database)');
  if (process.env.HEOPRESS_E2E_DISPOSABLE_DB !== 'true') throw new Error('HEOPRESS_E2E_DISPOSABLE_DB=true is required: the run sets the database up from scratch');
  if (!fs.existsSync(serve)) throw new Error('apps/cms/dist/serve.cjs is missing: pnpm --filter @heopress/cms build');
  const tsc = path.join(root, 'node_modules/typescript/bin/tsc');

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'heopress-plugin-package-'));
  if (!path.relative(root, work).startsWith('..')) throw new Error('the clean project must be outside the repository');
  const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });
  const step = (msg) => console.log(`[plugin-package] ${msg}`);
  const fail = (msg) => {
    throw new Error(msg);
  };
  let cms = null;
  let bundleServer = null;
  const cmsLog = path.join(work, 'cms.log');
  try {
    // ── 1. pack ────────────────────────────────────────────────────────────
    const pack = (rel) => {
      const dir = path.join(root, rel);
      const dest = path.join(work, 'packs', path.basename(rel));
      fs.mkdirSync(dest, { recursive: true });
      run('pnpm', ['build'], dir);
      run('pnpm', ['pack', '--pack-destination', dest], dir);
      const tgz = fs.readdirSync(dest).find((f) => f.endsWith('.tgz'));
      if (!tgz) fail(`pnpm pack of ${rel} produced no tarball`);
      const file = path.join(dest, tgz);
      const files = run('tar', ['-tzf', file], work).split('\n').filter(Boolean);
      const read = (f) => run('tar', ['-xzOf', file, f], work);
      return { file, files, read, manifest: JSON.parse(read('package/package.json')) };
    };
    const sdk = pack('packages/extension-sdk');
    const plugin = pack('packages/plugin-glossary');
    const sdkCode = Object.fromEntries(sdk.files.filter((f) => f.startsWith('package/dist/')).map((f) => [f.replace(/^package\//, ''), sdk.read(f)]));
    const extension = JSON.parse(plugin.read('package/heopress-extension.json'));
    const problems = [
      ...checkSdkPackage(sdk.manifest, sdk.files, sdkCode),
      ...checkPluginPackage(plugin.manifest, plugin.files, plugin.read('package/dist/index.js'), extension),
    ];
    if (problems.length) fail(`packed artifacts:\n  ✖ ${problems.join('\n  ✖ ')}`);
    step(`packed ${path.basename(sdk.file)} (${sdk.files.length} files, no core implementation) and ${path.basename(plugin.file)}`);

    // The newer version an upgrade installs: the same package, version 1.0.1, one more capability, other bundle bytes.
    const next = path.join(work, 'next');
    fs.mkdirSync(next);
    run('tar', ['-xzf', plugin.file, '-C', next], work);
    const editJson = (file, fn) => fs.writeFileSync(file, `${JSON.stringify(fn(JSON.parse(fs.readFileSync(file, 'utf8'))), null, 2)}\n`);
    editJson(path.join(next, 'package/package.json'), (p) => ({ ...p, version: '1.0.1' }));
    editJson(path.join(next, 'package/heopress-extension.json'), (m) => ({ ...m, version: '1.0.1', capabilities: [...m.capabilities, ADDED_CAPABILITY] }));
    fs.appendFileSync(path.join(next, 'package/dist/index.js'), '\n// heopress-glossary 1.0.1\n');
    const nextTgz = path.join(work, 'packs', 'heopress-plugin-glossary-1.0.1.tgz');
    run('tar', ['-czf', nextTgz, '-C', next, 'package'], work);

    // ── 2. a clean project ────────────────────────────────────────────────
    const app = path.join(work, 'app');
    fs.mkdirSync(app);
    const appPkg = { name: 'glossary-acceptance', version: '0.0.0', private: true, type: 'module', dependencies: { [SDK]: `file:${sdk.file}`, [PLUGIN]: `file:${plugin.file}` } };
    fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify(appPkg, null, 2));
    const npmInstall = () => run('npm', ['install', '--offline', '--no-audit', '--no-fund', '--ignore-scripts', '--install-links', '--loglevel=error'], app);
    const checkInstall = () => {
      const lock = JSON.parse(fs.readFileSync(path.join(app, 'package-lock.json'), 'utf8'));
      const wheres = Object.keys(lock.packages ?? {}).filter((w) => w !== '');
      const packages = Object.fromEntries(wheres.map((w) => [w, JSON.parse(fs.readFileSync(path.join(app, w, 'package.json'), 'utf8'))]));
      const links = wheres.filter((w) => fs.lstatSync(path.join(app, w)).isSymbolicLink() || lock.packages[w].link);
      const found = checkCleanInstall(packages, links);
      if (found.length) fail(`clean install:\n  ✖ ${found.join('\n  ✖ ')}`);
      return packages;
    };
    npmInstall();
    checkInstall();
    // The plugin's shipped source type-checks against the installed SDK alone (its own copy, outside node_modules).
    const check = path.join(app, 'typecheck');
    fs.cpSync(path.join(app, 'node_modules', PLUGIN, 'src'), path.join(check, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(check, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ES2022', moduleResolution: 'Bundler', lib: ['ES2022', 'DOM'], strict: true, noUncheckedIndexedAccess: true, skipLibCheck: false, noEmit: true, types: [] }, include: ['src'] }),
    );
    run(process.execPath, [tsc, '-p', 'tsconfig.json'], check);
    step(`installed offline in ${path.basename(work)}/app (outside the repository): only ${SDK} and ${PLUGIN}; the plugin source type-checks against the packed SDK`);

    // ── 3. the CMS ────────────────────────────────────────────────────────
    const served = path.join(work, 'served');
    const requests = [];
    const publish = (version) => {
      const bytes = fs.readFileSync(path.join(app, 'node_modules', PLUGIN, 'dist/index.js'));
      const manifest = JSON.parse(fs.readFileSync(path.join(app, 'node_modules', PLUGIN, 'heopress-extension.json'), 'utf8'));
      if (manifest.version !== version) fail(`the installed plugin is ${manifest.version}, expected ${version}`);
      fs.mkdirSync(path.join(served, version), { recursive: true });
      fs.writeFileSync(path.join(served, version, 'index.js'), bytes);
      return { bytes, manifest };
    };
    bundleServer = createServer((req, res) => {
      const m = /^\/heopress-glossary\/(\d+\.\d+\.\d+)\/index\.js$/.exec(req.url ?? '');
      const file = m && path.join(served, m[1], 'index.js');
      if (!file || !fs.existsSync(file)) {
        res.writeHead(404).end();
        return;
      }
      requests.push(req.url);
      res.writeHead(200, { 'content-type': 'text/javascript' }).end(fs.readFileSync(file));
    });
    await new Promise((r) => bundleServer.listen(0, '127.0.0.1', r));
    const origin = `http://127.0.0.1:${bundleServer.address().port}`;

    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const signed = (bytes) => ({
      bundleSha256: createHash('sha256').update(bytes).digest('hex'),
      signature: sign(null, bytes, privateKey).toString('base64'),
      publisherKeyId: OFFICIAL_KEY_ID,
      signatureAlg: 'ed25519',
    });
    const port = Number(process.env.PLUGIN_PACKAGE_PORT ?? 1995);
    const base = `http://127.0.0.1:${port}`;
    const logFd = fs.openSync(cmsLog, 'a');
    cms = spawn(process.execPath, [serve], {
      cwd: path.join(root, 'apps/cms'),
      stdio: ['ignore', logFd, logFd],
      env: {
        ...process.env,
        PORT: String(port),
        HEOPRESS_RUNTIME: 'docker',
        // Production mode (signatures always required) on a private test stack: no database TLS, one admin origin.
        HEOPRESS_ENV: 'production',
        DATABASE_SSL_MODE: 'disable',
        CORS_ALLOWED_ORIGINS: 'https://glossary.example.com',
        JWT_SECRET: process.env.JWT_SECRET || randomBytes(24).toString('hex'),
        ENCRYPTION_KEY: randomBytes(32).toString('base64'),
        HEOPRESS_STORAGE_DIR: path.join(work, 'storage'),
        EXTENSION_BUNDLE_ORIGINS: origin,
        HEOPRESS_TRUSTED_INTERNAL_ENDPOINTS: origin,
        MARKETPLACE_PUBLIC_KEYS: JSON.stringify({ [OFFICIAL_KEY_ID]: publicKey.export({ type: 'spki', format: 'pem' }).toString() }),
        HEOPRESS_API_RATE_LIMIT: '6000',
        HEOPRESS_SETUP_STATE_RATE_LIMIT: '1000',
      },
    });
    let exited = null;
    cms.on('exit', (code) => {
      exited = code;
    });
    for (let i = 0; ; i++) {
      if (exited !== null) fail(`the CMS exited (${exited}) before it was ready`);
      const ok = await fetch(`${base}/health/ready`).then((r) => r.ok, () => false);
      if (ok) break;
      if (i > 120) fail('the CMS never became ready');
      await sleep(1000);
    }
    step(`CMS ready on ${base}; bundle origin ${origin}`);

    const site = '__default__';
    let token = '';
    const api = async (method, url, body, expected = [200, 201]) => {
      const res = await fetch(`${base}/api/v1${url}`, {
        method,
        headers: { 'content-type': 'application/json', 'x-heopress-site': site, ...(token ? { authorization: `Bearer ${token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      const json = text ? JSON.parse(text) : null;
      if (!expected.includes(res.status)) fail(`${method} ${url} answered ${res.status}: ${text.slice(0, 500)}`);
      return { status: res.status, json };
    };
    const until = async (what, probe, { timeoutMs = 120_000, everyMs = 1_000, nudge, nudgeEveryMs = 15_000 } = {}) => {
      const started = Date.now();
      let nudged = started;
      for (;;) {
        if (await probe()) return;
        if (Date.now() - started > timeoutMs) fail(`timed out waiting for ${what}`);
        if (nudge && Date.now() - nudged > nudgeEveryMs) {
          await nudge();
          nudged = Date.now();
        }
        await sleep(everyMs);
      }
    };

    const email = 'plugin-admin@example.com';
    const password = `Pkg-${randomBytes(6).toString('hex')}-1!`;
    const policy = { userMaxFailedAttempts: 5, userLockoutDurationSeconds: 900, ipMaxFailedAttempts: 20, ipLockoutDurationSeconds: 3600, lockoutWindowSeconds: 900, geoAnomalyEnabled: true, timeAnomalyEnabled: false, deviceAnomalyEnabled: true, anomalyScoreThreshold: 0.7, anomalyAction: 'notify_only', notifyChannels: ['email'], loginStallMs: 0 };
    await api('POST', '/setup/complete', { account: { email, password, firstName: 'Plugin', lastName: 'Admin' }, adminPath: '/plugin-admin', policy, project: { defaultLanguage: 'en', siteUrl: 'https://glossary.example.com', displayTitle: 'Glossary acceptance' } }, [201]);
    token = (await api('POST', '/auth/login', { email, password })).json?.data?.token ?? fail('login returned no token');

    // ── install ──
    const v1 = publish('1.0.0');
    const request = (pkg, bytes, extra = {}) => {
      const { name, version, type, entry: _entry, capabilities, ...manifest } = pkg;
      return { name, version, type, bundleUrl: `${origin}/heopress-glossary/${version}/index.js`, capabilities, manifest, ...signed(bytes), ...extra };
    };
    const tampered = { ...request(v1.manifest, v1.bytes), enabled: true, approvedCapabilities: v1.manifest.capabilities };
    tampered.signature = sign(null, Buffer.from('other bytes'), privateKey).toString('base64');
    const refused = await api('POST', '/extensions', tampered, [400]);
    if (refused.json?.errors?.[0]?.code !== 'RESERVED_NAMESPACE' && refused.json?.errors?.[0]?.code !== 'SIGNATURE_INVALID') fail(`a tampered signature was refused with ${JSON.stringify(refused.json)}`);
    const installed = (await api('POST', '/extensions', { ...request(v1.manifest, v1.bytes), enabled: true, approvedCapabilities: v1.manifest.capabilities })).json.data;
    if (!installed.enabled || !installed.isOfficial || installed.permissionsStatus !== 'approved') fail(`install: ${JSON.stringify({ enabled: installed.enabled, isOfficial: installed.isOfficial, permissionsStatus: installed.permissionsStatus })}`);
    step(`install: ${NAME}@1.0.0 enabled, official (signature verified), capabilities approved; a tampered signature was refused (${refused.json.errors[0].code})`);

    // ── execute ──
    await api('POST', `/items/${TERMS}`, { data: { title: 'Alpha', slug: 'alpha', excerpt: 'The first letter.', source_url: 'https://example.com/alpha' }, status: 'published' });
    const article = async (slug, body) => (await api('POST', '/items/articles', { data: { title: `Notes ${slug}`, slug, locale: 'en', body }, status: 'published' })).json.data;
    const bodyOf = async (id) => String((await api('GET', `/items/articles/${id}`)).json.data?.data?.body ?? '');
    const LINK = 'data-heopress-glossary="alpha"';
    const linked = async (row, label) => {
      let n = 0;
      await until(`the plugin to link the term in ${label}`, async () => (await bodyOf(row.id)).includes(LINK), {
        // A subscription starts at the head of the event log when the CMS first finds it (within its 15 s cache):
        // an edit made before that is not delivered, so the article is edited again until one is.
        nudge: async () => {
          const current = (await api('GET', `/items/articles/${row.id}`)).json.data;
          await api('PATCH', `/items/articles/${row.id}`, { data: { title: `Notes ${row.data.slug} (${++n})` }, expectedVersion: current.version });
        },
      });
    };
    const first = await article('first', '<p>Alpha comes first.</p>');
    await linked(first, 'the first article');
    step(`execute: the plugin's subscription linked the term in a published article (${await bodyOf(first.id)})`);

    // ── upgrade ──
    run('npm', ['install', '--offline', '--no-audit', '--no-fund', '--ignore-scripts', '--install-links', '--loglevel=error', `${PLUGIN}@file:${nextTgz}`], app);
    checkInstall();
    const v2 = publish('1.0.1');
    const staged = (await api('POST', `/extensions/${installed.id}/upgrade`, request(v2.manifest, v2.bytes))).json.data;
    if (staged.status !== 'pending-approval' || !staged.diff?.added?.includes(ADDED_CAPABILITY)) fail(`upgrade without approval: ${JSON.stringify({ status: staged.status, diff: staged.diff })}`);
    if (staged.extension.version !== '1.0.0') fail('a pending upgrade changed the running version');
    const upgraded = (await api('POST', `/extensions/${installed.id}/upgrade/approve`, { approvedCapabilities: v2.manifest.capabilities })).json.data;
    if (upgraded.status !== 'upgraded' || upgraded.extension.version !== '1.0.1') fail(`approve: ${JSON.stringify({ status: upgraded.status, version: upgraded.extension?.version })}`);
    const before = requests.filter((r) => r.includes('/1.0.1/')).length;
    const second = await article('second', '<p>Alpha again.</p>');
    await linked(second, 'an article published after the upgrade');
    await until('the CMS to download the 1.0.1 bundle to run it', async () => requests.filter((r) => r.includes('/1.0.1/')).length > before, { timeoutMs: 30_000 });
    step(`upgrade: 1.0.1 asked for ${ADDED_CAPABILITY} and waited for approval; approved, its bundle was downloaded and runs`);

    // ── disable ──
    await api('PATCH', `/extensions/${installed.id}`, { enabled: false });
    // Past the plugin-consumer cache (15 s), so the disabled plugin is no longer asked.
    await sleep(20_000);
    const third = await article('third', '<p>Alpha while disabled.</p>');
    await sleep(25_000);
    if ((await bodyOf(third.id)).includes(LINK)) fail('a disabled plugin still linked terms');
    const kept = (await api('GET', '/extensions/collections')).json.data;
    const termsKept = kept.find((c) => c.name === TERMS);
    if (!termsKept || termsKept.items < 1) fail(`the term collection was not kept while disabled: ${JSON.stringify(kept)}`);
    step('disable: nothing linked any more; the term collection and its items are kept');

    // ── uninstall ──
    await api('DELETE', `/extensions/${installed.id}`);
    const listed = (await api('GET', '/extensions')).json.data;
    if (listed.some((e) => e.name === NAME)) fail('the plugin is still installed after uninstall');
    const left = (await api('GET', '/extensions/collections')).json.data.find((c) => c.name === TERMS);
    if (!left || left.items < 1) fail('uninstalling deleted the term collection (it needs an export and a confirmed purge)');
    const exported = (await api('GET', `/extensions/collections/${NAMESPACE}/export`)).json.data;
    await api('POST', `/extensions/collections/${NAMESPACE}/purge`, { confirm: NAMESPACE, exportDigest: exported.digest });
    const after = (await api('GET', '/extensions/collections')).json.data;
    if (after.some((c) => c.name === TERMS)) fail('the purge left the term collection');
    step('uninstall: the plugin is gone; its collection stayed until exported and purged');

    const log = fs.readFileSync(cmsLog, 'utf8');
    if (/\[extension-sandbox\] (failed to load|refused to load) "heopress-glossary"/.test(log)) fail('the CMS logged a failed load of the plugin');
    step('ok');
  } catch (err) {
    if (fs.existsSync(cmsLog)) {
      const tail = fs.readFileSync(cmsLog, 'utf8').split('\n').slice(-80).join('\n');
      console.error(`[plugin-package] CMS log (last 80 lines):\n${tail}`);
    }
    throw err;
  } finally {
    if (cms && cms.exitCode === null) {
      cms.kill('SIGTERM');
      await Promise.race([new Promise((r) => cms.once('exit', r)), sleep(10_000)]);
      if (cms.exitCode === null) cms.kill('SIGKILL');
    }
    if (bundleServer) await new Promise((r) => bundleServer.close(r));
    fs.rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[plugin-package] FAIL: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}
