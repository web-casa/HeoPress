#!/usr/bin/env node
/**
 * Dependency license check (ADR-0008, P01 `engineering/license-compliance`).
 *
 * Every production dependency of the distributed workspace packages must carry
 * a license from the allow list in license-policy.json. GPL / AGPL / SSPL / BSL
 * and similar licenses, and dependencies without a recognisable license, fail
 * the check unless a maintainer-approved exception covers them; each exception
 * must also be named in NOTICE and described in THIRD_PARTY_NOTICES.md.
 *
 * The permissive boundary (ADR-0008 §4, P07 task 7.9; `permissiveBoundary` in the policy): the Extension
 * SDK, the theme contract and the types plugins use are Apache-2.0 and their production dependency tree,
 * walked through the installed node_modules, reaches no AGPL core package (a workspace package without its
 * own license field is under the repository's AGPL-3.0-only) and no dependency off the allow list.
 *
 * Usage:
 *   node scripts/check-licenses.mjs                 # runs `pnpm licenses list --prod --json -r`
 *   node scripts/check-licenses.mjs --input <file>  # check a saved `pnpm licenses list --json` report
 *   node scripts/check-licenses.mjs --boundary-only # only the permissive boundary
 *   options: --root <dir> --policy <file>
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function globToRegExp(pattern) {
  return new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\/]/g, '\\$&')).join('.*')}$`);
}

/**
 * Parse an SPDX license expression into a tree, keeping parentheses and
 * precedence (WITH binds tighter than AND, AND tighter than OR).
 * Returns null for an empty or malformed expression.
 */
export function parseExpression(expression) {
  const tokens = String(expression ?? '').match(/\(|\)|[^\s()]+/g) ?? [];
  let i = 0;
  const peek = () => tokens[i];
  const isOp = (t, op) => typeof t === 'string' && t.toUpperCase() === op;
  const atom = () => {
    const t = tokens[i++];
    if (t === undefined || t === ')' || isOp(t, 'AND') || isOp(t, 'OR') || isOp(t, 'WITH')) throw new Error('syntax');
    if (t === '(') {
      const inner = or();
      if (tokens[i++] !== ')') throw new Error('syntax');
      return inner;
    }
    if (isOp(peek(), 'WITH')) {
      i += 1;
      const exception = tokens[i++];
      if (exception === undefined || exception === '(' || exception === ')') throw new Error('syntax');
      return { license: t, exception };
    }
    return { license: t };
  };
  const and = () => {
    const terms = [atom()];
    while (isOp(peek(), 'AND')) { i += 1; terms.push(atom()); }
    return terms.length === 1 ? terms[0] : { and: terms };
  };
  const or = () => {
    const alternatives = [and()];
    while (isOp(peek(), 'OR')) { i += 1; alternatives.push(and()); }
    return alternatives.length === 1 ? alternatives[0] : { or: alternatives };
  };
  if (tokens.length === 0) return null;
  try {
    const tree = or();
    return i === tokens.length ? tree : null;
  } catch {
    return null;
  }
}

/** "allowed" | "denied" | "unknown" for one SPDX expression under the policy. */
export function classify(expression, policy) {
  const evaluate = (node) => {
    if (node.or) {
      const states = node.or.map(evaluate);
      if (states.includes('allowed')) return 'allowed';
      return states.includes('denied') ? 'denied' : 'unknown';
    }
    if (node.and) {
      const states = node.and.map(evaluate);
      if (states.includes('denied')) return 'denied';
      return states.every((st) => st === 'allowed') ? 'allowed' : 'unknown';
    }
    // A license exception (WITH) changes the terms; a maintainer reviews it.
    if (node.exception) return 'unknown';
    const upper = node.license.toUpperCase();
    if (policy.deny.some((d) => upper.startsWith(d.toUpperCase()))) return 'denied';
    return policy.allow.includes(node.license) ? 'allowed' : 'unknown';
  };
  const tree = parseExpression(expression);
  return tree ? evaluate(tree) : 'unknown';
}

function findException(name, license, policy) {
  return (policy.exceptions ?? []).find((e) => globToRegExp(e.package).test(name) && e.license === license);
}

/**
 * Problems for a `pnpm licenses list --json` report. `noticeFiles` maps each
 * notice file name (NOTICE, THIRD_PARTY_NOTICES.md) to its text; every
 * exception in use must be mentioned in all of them.
 */
export function checkReport(report, policy, noticeFiles) {
  const problems = [];
  for (const [license, packages] of Object.entries(report)) {
    for (const pkg of packages) {
      const label = `${pkg.name}@${(pkg.versions ?? []).join(',')}`;
      const state = classify(license, policy);
      if (state === 'allowed') continue;
      const exception = findException(pkg.name, license, policy);
      if (exception) {
        if (!String(exception.approvedBy ?? '').trim()) {
          problems.push(`${label} (${license}): exception for "${exception.package}" has no maintainer approval (approvedBy)`);
        }
        const mention = exception.package.replace(/\*.*$/, '');
        for (const [file, text] of Object.entries(noticeFiles)) {
          if (!text.includes(mention)) problems.push(`${label} (${license}): exception "${exception.package}" is not described in ${file}`);
        }
        continue;
      }
      problems.push(
        state === 'denied'
          ? `${label}: license "${license}" is not allowed (copyleft or source-available)`
          : `${label}: license "${license}" is not recognised; a maintainer must review it and add an exception`,
      );
    }
  }
  return problems.sort();
}

/**
 * Problems in the record of development-only dependencies under a non-allowed license
 * (`devOnlyExceptions`): they are never shipped, so the production report does not cover them, but
 * each must name the package, its license, its scope, the maintainer's approval and where it was decided.
 */
export function checkDevOnlyExceptions(policy) {
  const problems = [];
  for (const [i, e] of (policy.devOnlyExceptions ?? []).entries()) {
    for (const field of ['package', 'license', 'scope', 'reason', 'approvedBy', 'decision']) {
      if (!String(e?.[field] ?? '').trim()) problems.push(`devOnlyExceptions[${i}] (${e?.package ?? '?'}): ${field} is missing`);
    }
    if (e?.license && classify(e.license, policy) === 'denied') problems.push(`devOnlyExceptions[${i}] (${e.package}): license "${e.license}" is denied even for development`);
  }
  return problems;
}

/** The SPDX expression a package.json declares (`license`, a `{ type }` object or the legacy `licenses` list), or null. */
export function declaredLicense(pkg) {
  if (typeof pkg?.license === 'string' && pkg.license.trim()) return pkg.license.trim();
  if (typeof pkg?.license?.type === 'string' && pkg.license.type.trim()) return pkg.license.type.trim();
  const legacy = (Array.isArray(pkg?.licenses) ? pkg.licenses : [])
    .map((l) => (typeof l === 'string' ? l : l?.type))
    .filter((l) => typeof l === 'string' && l.trim());
  if (legacy.length === 1) return legacy[0];
  return legacy.length > 1 ? `(${legacy.join(' OR ')})` : null;
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

/** The directory of package `name` as Node resolves it from `fromDir` (node_modules up the real path), or null. */
function resolvePackageDir(fromDir, name) {
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return fs.realpathSync(candidate);
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The production dependency tree of the package in `dir` (`dependencies`, `peerDependencies`,
 * `optionalDependencies`; never `devDependencies`), resolved through the installed node_modules.
 * A package outside any node_modules is a local (workspace) package: without its own license field it
 * is under the repository's license (`rootLicense`). Returns the packages reached (with the chain that
 * reaches them) and the dependencies that are declared but not installed. An optional dependency that is not
 * installed here (another platform's, say) counts as missing too: a consumer elsewhere may get it, and its license
 * cannot be checked; only an optional peer dependency (`peerDependenciesMeta`) may be absent.
 */
export function dependencyTree(dir, { rootLicense = null } = {}) {
  const start = fs.realpathSync(dir);
  const seen = new Map();
  const missing = [];
  const queue = [{ dir: start, chain: [] }];
  while (queue.length > 0) {
    const { dir: current, chain } = queue.shift();
    const pkg = readJson(path.join(current, 'package.json'));
    const label = `${pkg.name}@${pkg.version}`;
    const optional = new Set(Object.entries(pkg.peerDependenciesMeta ?? {}).filter(([, m]) => m?.optional).map(([n]) => n));
    const names = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
    ]);
    for (const name of [...names].sort()) {
      const resolved = resolvePackageDir(current, name);
      if (!resolved) {
        if (!optional.has(name)) missing.push([...chain, label, name].join(' > '));
        continue;
      }
      if (seen.has(resolved)) continue;
      const dep = readJson(path.join(resolved, 'package.json'));
      const local = !resolved.split(path.sep).includes('node_modules');
      const own = declaredLicense(dep);
      seen.set(resolved, {
        name: dep.name,
        version: dep.version,
        license: own ?? (local ? rootLicense : null),
        inherited: !own && local,
        local,
        private: dep.private === true,
        chain: [...chain, label, `${dep.name}@${dep.version}`],
      });
      queue.push({ dir: resolved, chain: [...chain, label] });
    }
  }
  return { packages: [...seen.values()], missing };
}

const APACHE_LICENSE_TEXT = /Apache License\s+Version 2\.0/;

/**
 * Problems at the permissive boundary of ADR-0008 §4 (`permissiveBoundary` in the policy): the Extension
 * SDK, the theme contract and the types plugins use are published under their own license (Apache-2.0)
 * so that independent extensions are not bound by the AGPL. Each listed package must declare that
 * license, carry its text in a LICENSE file (it goes into the published tarball), not be private, and
 * reach no package — workspace or third-party — whose license is not on the allow list: an AGPL core
 * package, a copyleft dependency or one without a recognisable license fails. Policy exceptions do not
 * apply here.
 */
export function checkPermissiveBoundary(root, policy) {
  const boundary = policy.permissiveBoundary;
  if (!boundary) return [];
  const problems = [];
  const required = boundary.license;
  const rootLicense = declaredLicense(readJson(path.join(root, 'package.json')));
  for (const rel of boundary.packages ?? []) {
    const dir = path.join(root, rel);
    if (!fs.existsSync(path.join(dir, 'package.json'))) {
      problems.push(`${rel}: no package.json (permissiveBoundary lists a package that does not exist)`);
      continue;
    }
    const pkg = readJson(path.join(dir, 'package.json'));
    const label = pkg.name ?? rel;
    if (declaredLicense(pkg) !== required) problems.push(`${label}: package.json license is "${declaredLicense(pkg) ?? 'missing'}", must be "${required}"`);
    if (pkg.private === true) problems.push(`${label}: is private; a boundary package is published for extensions to depend on`);
    const licenseFile = path.join(dir, 'LICENSE');
    if (!fs.existsSync(licenseFile) || !APACHE_LICENSE_TEXT.test(fs.readFileSync(licenseFile, 'utf8'))) {
      problems.push(`${label}: LICENSE with the ${required} text is missing (it ships in the package tarball)`);
    }
    const noticeFile = path.join(dir, 'NOTICE');
    if (!fs.existsSync(noticeFile) || !fs.readFileSync(noticeFile, 'utf8').includes(pkg.name ?? '\u0000')) {
      problems.push(`${label}: NOTICE naming the package is missing (Apache-2.0 §4(d): it ships in the package tarball)`);
    }
    for (const f of ['LICENSE', 'NOTICE']) {
      if (!(pkg.files ?? []).includes(f)) problems.push(`${label}: package.json "files" does not list ${f} (the tarball must carry it)`);
    }
    const tree = dependencyTree(dir, { rootLicense });
    for (const m of tree.missing) problems.push(`${label}: dependency not installed: ${m} (run pnpm install)`);
    for (const dep of tree.packages) {
      const state = dep.license ? classify(dep.license, policy) : 'unknown';
      if (state === 'allowed' && !(dep.local && dep.private)) continue;
      const via = dep.chain.join(' > ');
      if (dep.inherited) problems.push(`${label}: reaches core package ${dep.name} (no license field: under the repository's ${dep.license}) via ${via}`);
      else if (dep.local && dep.private) problems.push(`${label}: reaches unpublished workspace package ${dep.name} via ${via}`);
      else if (state === 'denied') problems.push(`${label}: reaches ${dep.name}@${dep.version} under "${dep.license}" (copyleft or source-available) via ${via}`);
      else problems.push(`${label}: reaches ${dep.name}@${dep.version} with license "${dep.license ?? 'missing'}" that is not on the allow list via ${via}`);
    }
  }
  return problems.sort();
}

function pnpmReport(root, policy) {
  const filters = (policy.notDistributed?.paths ?? []).flatMap((p) => ['--filter', `!./${p}`]);
  const out = execFileSync('pnpm', ['licenses', 'list', '--prod', '--json', '-r', ...filters], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return JSON.parse(out);
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(arg('--root') ?? process.cwd());
  const policy = JSON.parse(fs.readFileSync(path.resolve(root, arg('--policy') ?? 'license-policy.json'), 'utf8'));
  const notices = Object.fromEntries(
    ['NOTICE', 'THIRD_PARTY_NOTICES.md'].map((file) => [file, fs.readFileSync(path.join(root, file), 'utf8')]),
  );
  const boundary = checkPermissiveBoundary(root, policy);
  const boundaryNames = (policy.permissiveBoundary?.packages ?? []).join(', ');
  if (process.argv.includes('--boundary-only')) {
    if (boundary.length > 0) {
      console.error(`[licenses] ${boundary.length} problem(s) at the permissive boundary (${boundaryNames}):`);
      for (const p of boundary) console.error(`  ✖ ${p}`);
      process.exit(1);
    }
    console.log(`[licenses] ok: permissive boundary (${boundaryNames})`);
    process.exit(0);
  }
  const input = arg('--input');
  const report = input ? JSON.parse(fs.readFileSync(path.resolve(input), 'utf8')) : pnpmReport(root, policy);
  const problems = [...checkReport(report, policy, notices), ...checkDevOnlyExceptions(policy), ...boundary];
  const total = Object.values(report).reduce((n, list) => n + list.length, 0);
  if (problems.length > 0) {
    console.error(`[licenses] ${problems.length} problem(s) in ${total} production dependencies and the permissive boundary:`);
    for (const p of problems) console.error(`  ✖ ${p}`);
    process.exit(1);
  }
  console.log(`[licenses] ok: ${total} production dependencies checked; permissive boundary (${boundaryNames}) has no AGPL or copyleft package`);
}
