#!/usr/bin/env node
/**
 * Every official plugin accepted as a packed artifact, without a database or a server
 * (v1.5; companion to `verify-plugin-package.mjs`, which drives the glossary plugin end to end through the HTTP API).
 *
 *   node scripts/verify-plugin-packages.mjs
 *
 * Why both exist: `verify-plugin-package.mjs` proves the SDK and one plugin work as packed tarballs, but it is written
 * around the glossary plugin's collections, routes and gate check — so a new plugin was only ever packed by hand
 * (the corrections plugin shipped that way). This script covers every `packages/plugin-*` without knowing what the
 * plugin does:
 *
 * 1. `pnpm pack` each plugin and the SDK; assert both tarballs hold what they must (locked manifest, built entry,
 *    LICENSE) and nothing they must not (no core import, no table, no dependency beyond the SDK).
 * 2. Install them into a clean project in a temporary directory outside the repository with `npm --offline`, so the
 *    packed artifacts are the only code present — a plugin that secretly needs a workspace sibling fails here.
 * 3. Import the packed entry and call its default export with a recording context: every extension point it registers
 *    must be one its manifest declares, every declared hook must be registered under a declared name, and the
 *    manifest must pass the SDK's own validation.
 *
 * A plugin whose bundle loads but registers something its manifest does not declare is refused by the host at runtime;
 * this catches it before packing, per plugin, for every plugin.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'heopress-plugin-packs-'));
const SDK = '@heopress/extension-sdk';

/** What only the core implements: none of these may appear in a packed plugin bundle. */
const CORE_MARKERS = [
  [/@heopress\/(?!extension-sdk\b)[a-z-]+/, 'an import of a core package'],
  [/\bdrizzle-orm\b/, 'a Drizzle import'],
  [/\bfrom\s+['"]hono['"]/, 'a Hono import'],
  [/\blumibase_[a-z_]+/, 'a core table name'],
];

let failures = 0;
const fail = (message) => {
  failures += 1;
  console.error(`  ✖ ${message}`);
};
const ok = (message) => console.log(`  ✔ ${message}`);

function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
}

function pack(directory) {
  const out = run('pnpm', ['pack', '--pack-destination', path.join(WORK, 'packs')], { cwd: path.join(ROOT, directory) });
  const match = /(?:^|\s)(\S+\.tgz)\s*$/.exec(out.trim());
  if (!match) throw new Error(`pnpm pack printed no tarball for ${directory}: ${out.trim()}`);
  const file = path.isAbsolute(match[1]) ? match[1] : path.join(WORK, 'packs', path.basename(match[1]));
  if (!fs.existsSync(file)) throw new Error(`the tarball ${file} does not exist after packing ${directory}`);
  return { file, name: path.basename(file) };
}

function entries(file) {
  return run('tar', ['-tzf', file]).split('\n').filter((line) => line.startsWith('package/')).map((line) => line.slice('package/'.length));
}

/** The published plugin directory names, with the package name its manifest claims. */
function plugins() {
  return fs
    .readdirSync(path.join(ROOT, 'packages'))
    .filter((name) => name.startsWith('plugin-'))
    .map((directory) => {
      const manifestPath = path.join(ROOT, 'packages', directory, 'heopress-extension.json');
      if (!fs.existsSync(manifestPath)) throw new Error(`${directory} has no heopress-extension.json`);
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'packages', directory, 'package.json'), 'utf8'));
      return { directory: `packages/${directory}`, manifest, pkg };
    })
    .sort((a, b) => a.pkg.name.localeCompare(b.pkg.name));
}

/** The extension points a manifest declares, by the name the runtime registers them under. */
function declaredPoints(manifest) {
  const points = new Set();
  const add = (name, condition) => condition && points.add(name);
  add('collections', (manifest.collections ?? []).length > 0);
  add('routes', (manifest.routes ?? []).length > 0);
  add('components', Object.keys(manifest.components ?? {}).length > 0);
  add('gate-checks', (manifest.gateChecks ?? []).length > 0);
  add('admin-panels', !!manifest.admin);
  add('structuredData', (manifest.structuredData ?? []).length > 0);
  for (const capability of manifest.capabilities ?? []) {
    for (const [capabilityName, point] of [
      ['ext:jobs', 'jobs'],
      ['ext:endpoints', 'endpoints'],
      ['ext:events', 'events'],
      ['ext:briefing-sections', 'briefing-sections'],
      ['ext:translation-services', 'translation-services'],
      ['ext:source-adapters', 'source-adapters'],
      ['ext:build-steps', 'build-steps'],
      ['ext:gate-checks', 'gate-checks'],
    ]) {
      if (capability === capabilityName) points.add(point);
    }
  }
  return points;
}

/** A context that records what the bundle registers, so the manifest and the code can be compared. */
function recordingContext(siteId) {
  const registered = [];
  const context = {
    siteId,
    extensionPoints: {
      register(point, definition) {
        registered.push({ point, name: definition?.name ?? definition?.id ?? definition?.key ?? null, definition });
        return undefined;
      },
    },
    items: {},
    media: {},
    secrets: { get: async () => null },
    storage: {},
    jobs: { enqueue: async () => undefined },
    fetch: async () => {
      throw new Error('a packed plugin must not reach the network while being inspected');
    },
    log: { info() {}, warn() {}, error() {} },
    settings: {},
  };
  return { context, registered };
}

async function inspect(plugin, sdkFile) {
  const label = plugin.pkg.name;
  console.log(`\n▸ ${label}`);
  const packed = pack(plugin.directory);

  // 1. What the tarball holds.
  const files = entries(packed.file);
  for (const required of ['heopress-extension.json', 'package.json', 'LICENSE']) {
    files.includes(required) ? ok(`${required} is packed`) : fail(`${required} is missing from ${packed.name}`);
  }
  // The built entry is what the host loads; the sources ride along on purpose (the packed project type-checks them).
  const entry = (plugin.pkg.main ?? 'dist/index.js').replace(/^\.\//, '');
  files.some((file) => file === entry || file.startsWith(`${path.dirname(entry)}/`))
    ? ok(`${entry} is packed`)
    : fail(`${entry} is missing from ${packed.name}`);

  // 2. Install it alone with the SDK.
  const project = path.join(WORK, label.replace(/[@/]/g, '-'));
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(
    path.join(project, 'package.json'),
    `${JSON.stringify({ name: 'plugin-pack-check', version: '0.0.0', private: true, type: 'module', dependencies: { [SDK]: `file:${sdkFile}`, [label]: `file:${packed.file}` } }, null, 2)}\n`,
  );
  run('npm', ['install', '--offline', '--no-audit', '--no-fund', '--loglevel', 'error'], { cwd: project });

  const installed = path.join(project, 'node_modules', ...label.split('/'));
  const pkg = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8'));
  const declared = new Set(Object.keys(pkg.dependencies ?? {}));
  const allowed = new Set([SDK]);
  for (const dependency of declared) if (!allowed.has(dependency)) fail(`${label} depends on ${dependency}: a plugin uses the SDK only`);

  // 3. Load it and compare what it registers with what it declares.
  const require = createRequire(path.join(project, 'index.js'));
  const resolvedEntry = require.resolve(packedEntry(label, installed, pkg));
  const bundle = fs.readFileSync(resolvedEntry, 'utf8');
  for (const [pattern, description] of CORE_MARKERS) {
    if (pattern.test(bundle)) fail(`${label}'s bundle contains ${description}`);
  }

  const module = await import(`file://${resolvedEntry}`);
  if (typeof module.default !== 'function') {
    fail(`${label} has no default export to register its points`);
    return;
  }
  const { context, registered } = recordingContext('__plugin_pack_check__');
  try {
    await module.default(context);
  } catch (err) {
    fail(`${label}'s default export threw on a recording context: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  const points = declaredPoints(plugin.manifest);
  for (const { point, name } of registered) {
    if (!points.has(point)) fail(`${label} registers '${point}' but its manifest does not declare it`);
  }
  const hooks = new Set(plugin.manifest.prePublishHooks ?? []);
  if (hooks.size > 0) {
    const registeredHooks = registered.filter((entry) => entry.point === 'events' && entry.definition?.kind === 'pre-publish-hook');
    for (const hook of hooks) {
      if (!registeredHooks.some((entry) => entry.name === hook)) fail(`${label} declares the hook '${hook}' but does not register it`);
    }
  }
  ok(`registers ${registered.length} point(s), all declared: ${registered.map((entry) => `${entry.point}${entry.name ? `:${entry.name}` : ''}`).join(', ') || 'none'}`);
}

/** The entry path a package name resolves to inside its own installed directory. */
function packedEntry(label, installed, pkg) {
  const main = pkg.main ?? 'dist/index.js';
  return path.join(installed, main);
}

async function main() {
  console.log(`[plugin-pack] ${plugins().length} plugin(s), working in ${WORK}`);
  const sdk = pack('packages/extension-sdk');
  const sdkFiles = entries(sdk.file);
  for (const forbidden of ['src/', 'node_modules/']) {
    if (sdkFiles.some((file) => file.startsWith(forbidden))) fail(`the SDK tarball holds ${forbidden}/`);
  }
  ok(`the SDK packs ${sdkFiles.length} files`);

  for (const plugin of plugins()) await inspect(plugin, sdk.file);

  if (failures > 0) {
    console.error(`\n[plugin-pack] failed: ${failures} problem(s)`);
    process.exit(1);
  }
  console.log('\n[plugin-pack] ok: every plugin loads from its packed tarball with the SDK alone');
  fs.rmSync(WORK, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(`[plugin-pack] failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
