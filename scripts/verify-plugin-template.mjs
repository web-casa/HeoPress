#!/usr/bin/env node
/**
 * The plugin template builds with only the Extension SDK installed (P07 task 7.9, ADR-0008 §4).
 *
 *   node scripts/verify-plugin-template.mjs
 *
 * 1. Builds and packs (`pnpm pack`) every package of the permissive boundary (license-policy.json): each tarball must
 *    declare Apache-2.0, carry LICENSE and NOTICE and its types, and depend on no other HeoPress package.
 * 2. Copies examples/plugin-template to a throwaway directory, points its SDK dependency at the packed tarball (no
 *    workspace, no monorepo source) and installs it with npm `--offline`: the tarball is the only package installed,
 *    nothing is fetched from a registry.
 * 3. Builds it with the workspace's TypeScript (pinned by pnpm-lock.yaml; the template pins the same exact version
 *    for its users), so the check is reproducible.
 * 4. Checks every installed package: its license is on the allow list (no AGPL or other copyleft package, no unknown
 *    license) and the only HeoPress package is the Extension SDK; the built file imports no HeoPress package at run
 *    time (`import`, dynamic `import()` or `require()`).
 *
 * Runs offline. CI runs it in the `plugin-template` job.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { classify, declaredLicense } from './check-licenses.mjs';

const SDK = '@heopress/extension-sdk';
/** A HeoPress core specifier: `heopress`, `heopress/<subpath>`, the `@heopress` scope or any `@heopress/…` package. */
const isHeoPress = (name) => /^(?:heopress|@heopress)(?:\/|$)/.test(name);

/** Problems in a packed boundary package: its package.json and file list. */
export function checkPackedPackage(manifest, files, license) {
  const problems = [];
  const name = manifest.name ?? '?';
  if (declaredLicense(manifest) !== license) problems.push(`packed ${name} declares license "${declaredLicense(manifest) ?? 'missing'}", not "${license}"`);
  for (const f of ['package/LICENSE', 'package/NOTICE', 'package/dist/index.d.ts']) {
    if (!files.includes(f)) problems.push(`packed ${name} has no ${f.replace(/^package\//, '')}`);
  }
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const dep of Object.keys(manifest[field] ?? {})) {
      if (isHeoPress(dep)) problems.push(`packed ${name} ${field} names ${dep}: a plugin would install a HeoPress core package`);
    }
  }
  return problems;
}

/**
 * Problems in an installed plugin: `packages` maps each install path (`node_modules/<name>`, as npm's
 * package-lock.json keys them) to that package's package.json.
 */
export function checkInstalledTree(packages, policy) {
  const problems = [];
  for (const [where, pkg] of Object.entries(packages).sort(([a], [b]) => a.localeCompare(b))) {
    const name = pkg.name ?? where.replace(/^.*node_modules\//, '');
    const label = `${name}@${pkg.version ?? '?'} (${where})`;
    if (isHeoPress(name) && name !== SDK) problems.push(`${label}: a HeoPress package other than ${SDK} is installed`);
    const license = declaredLicense(pkg);
    const state = license ? classify(license, policy) : 'unknown';
    if (state === 'denied') problems.push(`${label}: license "${license}" is copyleft or source-available`);
    else if (state !== 'allowed') problems.push(`${label}: license "${license ?? 'missing'}" is not on the allow list`);
  }
  if (!Object.values(packages).some((p) => p.name === SDK)) problems.push(`${SDK} is not installed`);
  return problems;
}

/**
 * The code of a built file without its comments, and its string literals (quotes and backticks; a template literal
 * with `${…}` counts as computed). A small scanner, enough for compiled output: comments never hide a specifier, and
 * a `//` inside a string is not a comment.
 */
function scan(code) {
  let out = '';
  const strings = [];
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    const next = code[i + 1];
    if (c === '/' && next === '/') {
      while (i < code.length && code[i] !== '\n') i++;
    } else if (c === '/' && next === '*') {
      const end = code.indexOf('*/', i + 2);
      i = end === -1 ? code.length : end + 2;
      out += ' ';
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      let value = '';
      let computed = false;
      while (j < code.length && code[j] !== c) {
        if (code[j] === '\\') {
          value += code[j + 1] ?? '';
          j += 2;
          continue;
        }
        if (c === '`' && code[j] === '$' && code[j + 1] === '{') computed = true;
        value += code[j];
        j++;
      }
      strings.push({ value, computed });
      out += computed ? '`${}`' : `${c}${value.replace(/['"`]/g, '')}${c}`;
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return { code: out, strings };
}

/**
 * What a built file could load at run time that the template check must refuse: every string naming a HeoPress
 * core specifier (`heopress`, `heopress/…`, `@heopress`, `@heopress/…` — in any position, so a specifier assembled
 * from parts is caught by its parts), and every dynamic `import(…)` or `require(…)` whose argument is not a plain
 * string literal (a computed specifier cannot be checked).
 */
export function runtimeLoads(code) {
  const { code: bare, strings } = scan(code);
  const heopress = [...new Set(strings.filter((s) => isHeoPress(s.value)).map((s) => s.value))].sort();
  const computed = [];
  for (const m of bare.matchAll(/(?<![\w$.])(import|require)\s*\(\s*([^)]*)\)/g)) {
    const arg = m[2].trim();
    if (!/^(['"])[^'"`]*\1$/.test(arg)) computed.push(`${m[1]}(${arg.slice(0, 40)})`);
  }
  return { heopress, computed };
}

/** The template must pin the workspace's TypeScript exactly (what its build is verified with). */
export function checkToolPin(pkg, tscVersion) {
  const pinned = pkg.devDependencies?.typescript ?? pkg.dependencies?.typescript;
  return pinned === tscVersion ? [] : [`examples/plugin-template pins typescript "${pinned ?? 'nothing'}"; the workspace builds it with ${tscVersion}: pin it exactly`];
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const policy = JSON.parse(fs.readFileSync(path.join(root, 'license-policy.json'), 'utf8'));
  const license = policy.permissiveBoundary?.license ?? 'Apache-2.0';
  const tsc = path.join(root, 'node_modules/typescript/bin/tsc');
  const tscVersion = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/typescript/package.json'), 'utf8')).version;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'heopress-plugin-template-'));
  const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });
  try {
    const problems = [];
    let sdkTarball = null;
    for (const rel of policy.permissiveBoundary?.packages ?? []) {
      const dir = path.join(root, rel);
      const packs = path.join(work, 'packs', path.basename(rel));
      fs.mkdirSync(packs, { recursive: true });
      run('pnpm', ['build'], dir);
      run('pnpm', ['pack', '--pack-destination', packs], dir);
      const tarball = fs.readdirSync(packs).find((f) => f.endsWith('.tgz'));
      if (!tarball) throw new Error(`pnpm pack of ${rel} produced no tarball`);
      const tgz = path.join(packs, tarball);
      const files = run('tar', ['-tzf', tgz], work).split('\n').filter(Boolean);
      const manifest = JSON.parse(run('tar', ['-xzOf', tgz, 'package/package.json'], work));
      problems.push(...checkPackedPackage(manifest, files, license));
      if (manifest.name === SDK) sdkTarball = tgz;
    }
    if (!sdkTarball) throw new Error(`${SDK} is not in the permissive boundary of license-policy.json`);

    const app = path.join(work, 'plugin');
    fs.cpSync(path.join(root, 'examples/plugin-template'), app, {
      recursive: true,
      filter: (src) => !/[\\/](node_modules|dist)([\\/]|$)/.test(path.relative(root, src)),
    });
    const pkgPath = path.join(app, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    problems.push(...checkToolPin(pkg, tscVersion));
    const field = pkg.dependencies?.[SDK] ? 'dependencies' : 'devDependencies';
    if (!pkg[field]?.[SDK]) throw new Error(`examples/plugin-template does not depend on ${SDK}`);
    pkg[field][SDK] = `file:${sdkTarball}`;
    // The build uses the workspace's pinned TypeScript: the packed SDK is the only package installed.
    delete pkg.devDependencies?.typescript;
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

    run('npm', ['install', '--offline', '--no-audit', '--no-fund', '--ignore-scripts', '--loglevel=error'], app);
    run(process.execPath, [tsc, '-p', 'tsconfig.json'], app);
    for (const out of ['dist/index.js', 'dist/index.d.ts']) {
      if (!fs.existsSync(path.join(app, out))) problems.push(`the template build produced no ${out}`);
    }
    const loads = runtimeLoads(fs.readFileSync(path.join(app, 'dist/index.js'), 'utf8'));
    if (loads.heopress.length) problems.push(`dist/index.js names HeoPress packages it could load at run time: ${loads.heopress.join(', ')}`);
    if (loads.computed.length) problems.push(`dist/index.js loads a computed specifier, which cannot be checked: ${loads.computed.join(', ')}`);

    const lock = JSON.parse(fs.readFileSync(path.join(app, 'package-lock.json'), 'utf8'));
    const installed = Object.fromEntries(
      Object.keys(lock.packages ?? {})
        .filter((where) => where !== '')
        .map((where) => [where, JSON.parse(fs.readFileSync(path.join(app, where, 'package.json'), 'utf8'))]),
    );
    problems.push(...checkInstalledTree(installed, policy));
    if (problems.length > 0) {
      console.error(`[plugin-template] ${problems.length} problem(s):`);
      for (const p of problems) console.error(`  ✖ ${p}`);
      process.exitCode = 1;
      return;
    }
    const names = Object.values(installed).map((p) => `${p.name}@${p.version} (${declaredLicense(p)})`).join(', ');
    console.log(`[plugin-template] ok: boundary tarballs checked; built with TypeScript ${tscVersion} against ${path.basename(sdkTarball)} alone; installed: ${names}`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
