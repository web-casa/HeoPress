import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkDevOnlyExceptions, checkPermissiveBoundary, checkReport, classify, declaredLicense } from '../check-licenses.mjs';

const policy = {
  allow: ['MIT', 'ISC', 'Apache-2.0', 'BSD-3-Clause', 'PostgreSQL', 'Zlib'],
  deny: ['GPL', 'AGPL', 'LGPL', 'SSPL', 'BUSL', 'BSL'],
  exceptions: [
    { package: '@img/sharp-libvips-*', license: 'LGPL-3.0-or-later', linking: 'dynamic', approvedBy: 'maintainer' },
  ],
};
const notices = {
  NOTICE: 'libvips (LGPL-3.0-or-later), shipped as @img/sharp-libvips-* and dynamically linked',
  'THIRD_PARTY_NOTICES.md': '| `@img/sharp-libvips-*` | LGPL-3.0-or-later | ... |',
};
const pkg = (name, version = '1.0.0') => ({ name, versions: [version] });

test('SPDX expressions: OR passes if any side is allowed, AND needs every term', () => {
  assert.equal(classify('MIT', policy), 'allowed');
  assert.equal(classify('(MPL-2.0 OR Apache-2.0)', policy), 'allowed');
  assert.equal(classify('MIT AND Zlib', policy), 'allowed');
  assert.equal(classify('MIT AND GPL-3.0', policy), 'denied');
  assert.equal(classify('GPL-2.0 WITH Classpath-exception-2.0', policy), 'unknown');
  assert.equal(classify('', policy), 'unknown');
});

test('SPDX parentheses and precedence are honoured', () => {
  assert.equal(classify('GPL-3.0 AND (MIT OR Apache-2.0)', policy), 'denied');
  assert.equal(classify('(MIT OR Apache-2.0) AND GPL-3.0', policy), 'denied');
  assert.equal(classify('(GPL-3.0 AND MIT) OR Apache-2.0', policy), 'allowed');
  assert.equal(classify('MIT AND (GPL-3.0 OR Apache-2.0)', policy), 'allowed');
  assert.equal(classify('MIT OR GPL-3.0 AND Zlib', policy), 'allowed');
  assert.equal(classify('GPL-3.0 OR MIT AND SSPL-1.0', policy), 'denied');
  assert.equal(classify('MIT and ISC', policy), 'allowed');
});

test('malformed SPDX expressions are not recognised', () => {
  for (const expression of ['(MIT OR Apache-2.0', 'MIT OR', 'AND MIT', 'MIT Apache-2.0', 'MIT WITH', '()']) {
    assert.equal(classify(expression, policy), 'unknown', expression);
  }
});

test('a GPL-3.0 dependency fails and is listed with its license', () => {
  const problems = checkReport({ MIT: [pkg('ok-lib')], 'GPL-3.0': [pkg('copyleft-lib', '2.1.0')] }, policy, notices);
  assert.deepEqual(problems, ['copyleft-lib@2.1.0: license "GPL-3.0" is not allowed (copyleft or source-available)']);
});

for (const license of ['AGPL-3.0-only', 'SSPL-1.0', 'BUSL-1.1']) {
  test(`${license} fails`, () => {
    assert.equal(checkReport({ [license]: [pkg('x')] }, policy, notices).length, 1);
  });
}

test('an LGPL native library on the exception list passes when described in the notices', () => {
  const report = { 'LGPL-3.0-or-later': [pkg('@img/sharp-libvips-linux-x64', '1.3.4')] };
  assert.deepEqual(checkReport(report, policy, notices), []);
});

test('an exception must be named in NOTICE and described in THIRD_PARTY_NOTICES.md', () => {
  const report = { 'LGPL-3.0-or-later': [pkg('@img/sharp-libvips-linux-x64')] };
  assert.match(checkReport(report, policy, { ...notices, 'THIRD_PARTY_NOTICES.md': 'nothing here' })[0], /not described in THIRD_PARTY_NOTICES\.md/);
  assert.match(checkReport(report, policy, { ...notices, NOTICE: 'nothing here' })[0], /not described in NOTICE/);
});

test('an exception without maintainer approval fails', () => {
  const unapproved = { ...policy, exceptions: [{ ...policy.exceptions[0], approvedBy: '' }] };
  const report = { 'LGPL-3.0-or-later': [pkg('@img/sharp-libvips-linux-x64')] };
  assert.match(checkReport(report, unapproved, notices)[0], /no maintainer approval/);
});

test('a dependency without a recognisable license needs maintainer review', () => {
  for (const license of ['Unknown', 'SEE LICENSE IN LICENSE.md', 'UNLICENSED']) {
    assert.match(checkReport({ [license]: [pkg('mystery')] }, policy, notices)[0], /maintainer must review/);
  }
});

test('an exception only covers its own license', () => {
  const report = { 'GPL-3.0': [pkg('@img/sharp-libvips-linux-x64')] };
  assert.match(checkReport(report, policy, notices)[0], /not allowed/);
});

test('a development-only exception needs its scope, approval and decision; a denied license is refused', () => {
  const base = { allow: ['MIT'], deny: ['GPL'] };
  const full = { package: 'axe-core', license: 'MPL-2.0', scope: 'tests', reason: 'a11y', approvedBy: 'maintainer', decision: 'design R45' };
  assert.deepEqual(checkDevOnlyExceptions({ ...base, devOnlyExceptions: [full] }), []);
  assert.deepEqual(checkDevOnlyExceptions({ ...base, devOnlyExceptions: [{ ...full, approvedBy: '' }] }), ['devOnlyExceptions[0] (axe-core): approvedBy is missing']);
  assert.equal(checkDevOnlyExceptions({ ...base, devOnlyExceptions: [{ ...full, license: 'GPL-3.0' }] }).length, 1);
});

// P07 task 7.9: the permissive boundary (ADR-0008 §4).
const APACHE = '                                 Apache License\n                           Version 2.0, January 2004\n';
const boundaryPolicy = {
  ...policy,
  permissiveBoundary: { license: 'Apache-2.0', packages: ['packages/extension-sdk', 'packages/contracts'] },
};

/** A throwaway workspace: a root under AGPL, boundary packages with LICENSE files, dependencies in nested node_modules. */
function workspace(t, { sdk = {}, contracts = {}, extra = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heopress-boundary-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (rel, body) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), typeof body === 'string' ? body : JSON.stringify(body));
  };
  write('package.json', { name: 'heopress', private: true, license: 'AGPL-3.0-only' });
  const files = ['dist', 'LICENSE', 'NOTICE'];
  write('packages/extension-sdk/package.json', { name: '@heopress/extension-sdk', version: '1.0.0', license: 'Apache-2.0', files, ...sdk });
  write('packages/extension-sdk/LICENSE', APACHE);
  write('packages/extension-sdk/NOTICE', '@heopress/extension-sdk\nCopyright 2026 The HeoPress Authors\n');
  write('packages/contracts/package.json', { name: '@heopress/contracts', version: '1.0.0', license: 'Apache-2.0', files, dependencies: { zod: '^4' }, ...contracts });
  write('packages/contracts/LICENSE', APACHE);
  write('packages/contracts/NOTICE', '@heopress/contracts\nCopyright 2026 The HeoPress Authors\n');
  write('packages/contracts/node_modules/zod/package.json', { name: 'zod', version: '4.0.0', license: 'MIT' });
  write('packages/database/package.json', { name: '@heopress/database', version: '1.0.0', private: true });
  for (const [rel, body] of Object.entries(extra)) write(rel, body);
  return dir;
}

test('the boundary packages pass when Apache-2.0, with LICENSE and only permissive dependencies', (t) => {
  assert.deepEqual(checkPermissiveBoundary(workspace(t), boundaryPolicy), []);
});

test('an AGPL core workspace package in the SDK tree fails (no license field: the repository AGPL applies)', (t) => {
  const root = workspace(t, { sdk: { dependencies: { '@heopress/database': 'workspace:*' } } });
  // pnpm links a workspace dependency into the dependant's node_modules.
  fs.mkdirSync(path.join(root, 'packages/extension-sdk/node_modules/@heopress'), { recursive: true });
  fs.symlinkSync(path.join(root, 'packages/database'), path.join(root, 'packages/extension-sdk/node_modules/@heopress/database'), 'dir');
  assert.deepEqual(checkPermissiveBoundary(root, boundaryPolicy), [
    "@heopress/extension-sdk: reaches core package @heopress/database (no license field: under the repository's AGPL-3.0-only) via @heopress/extension-sdk@1.0.0 > @heopress/database@1.0.0",
  ]);
});

test('an AGPL third-party package deep in the tree fails with the chain that reaches it', (t) => {
  const root = workspace(t, {
    extra: {
      'packages/contracts/node_modules/zod/package.json': { name: 'zod', version: '4.0.0', license: 'MIT', dependencies: { 'copyleft-lib': '1' } },
      'packages/contracts/node_modules/zod/node_modules/copyleft-lib/package.json': { name: 'copyleft-lib', version: '2.0.0', license: 'AGPL-3.0-or-later' },
    },
  });
  assert.deepEqual(checkPermissiveBoundary(root, boundaryPolicy), [
    '@heopress/contracts: reaches copyleft-lib@2.0.0 under "AGPL-3.0-or-later" (copyleft or source-available) via @heopress/contracts@1.0.0 > zod@4.0.0 > copyleft-lib@2.0.0',
  ]);
});

test('peer dependencies count, dev dependencies do not, and policy exceptions do not apply at the boundary', (t) => {
  const root = workspace(t, {
    sdk: { peerDependencies: { '@img/sharp-libvips-linux-x64': '1' }, devDependencies: { 'gpl-tool': '1' } },
    extra: {
      'packages/extension-sdk/node_modules/@img/sharp-libvips-linux-x64/package.json': { name: '@img/sharp-libvips-linux-x64', version: '1.0.0', license: 'LGPL-3.0-or-later' },
      'packages/extension-sdk/node_modules/gpl-tool/package.json': { name: 'gpl-tool', version: '1.0.0', license: 'GPL-3.0' },
    },
  });
  assert.deepEqual(checkPermissiveBoundary(root, boundaryPolicy), [
    '@heopress/extension-sdk: reaches @img/sharp-libvips-linux-x64@1.0.0 under "LGPL-3.0-or-later" (copyleft or source-available) via @heopress/extension-sdk@1.0.0 > @img/sharp-libvips-linux-x64@1.0.0',
  ]);
});

test('a wrong license field, a missing LICENSE, a private package, an uninstalled or unlicensed dependency fail', (t) => {
  const root = workspace(t, {
    sdk: {
      license: 'AGPL-3.0-only',
      private: true,
      dependencies: { 'not-installed': '1', mystery: '1' },
      optionalDependencies: { 'optional-absent': '1' },
      peerDependencies: { 'optional-peer': '1' },
      peerDependenciesMeta: { 'optional-peer': { optional: true } },
    },
    extra: { 'packages/extension-sdk/node_modules/mystery/package.json': { name: 'mystery', version: '0.1.0' } },
  });
  fs.rmSync(path.join(root, 'packages/contracts/LICENSE'));
  assert.deepEqual(checkPermissiveBoundary(root, boundaryPolicy), [
    '@heopress/contracts: LICENSE with the Apache-2.0 text is missing (it ships in the package tarball)',
    '@heopress/extension-sdk: dependency not installed: @heopress/extension-sdk@1.0.0 > not-installed (run pnpm install)',
    // Another platform's optional dependency may reach a consumer: unchecked is not passed. An optional peer may be absent.
    '@heopress/extension-sdk: dependency not installed: @heopress/extension-sdk@1.0.0 > optional-absent (run pnpm install)',
    '@heopress/extension-sdk: is private; a boundary package is published for extensions to depend on',
    '@heopress/extension-sdk: package.json license is "AGPL-3.0-only", must be "Apache-2.0"',
    '@heopress/extension-sdk: reaches mystery@0.1.0 with license "missing" that is not on the allow list via @heopress/extension-sdk@1.0.0 > mystery@0.1.0',
  ]);
});

test('every boundary package needs a NOTICE naming it, and LICENSE and NOTICE in its published files', (t) => {
  const root = workspace(t, { contracts: { files: ['dist', 'LICENSE'] } });
  fs.rmSync(path.join(root, 'packages/extension-sdk/NOTICE'));
  assert.deepEqual(checkPermissiveBoundary(root, boundaryPolicy), [
    '@heopress/contracts: package.json "files" does not list NOTICE (the tarball must carry it)',
    '@heopress/extension-sdk: NOTICE naming the package is missing (Apache-2.0 §4(d): it ships in the package tarball)',
  ]);
});

test('declared licenses: a string, a { type } object and the legacy licenses list', () => {
  assert.equal(declaredLicense({ license: 'MIT' }), 'MIT');
  assert.equal(declaredLicense({ license: { type: 'ISC' } }), 'ISC');
  assert.equal(declaredLicense({ licenses: [{ type: 'MIT' }, { type: 'GPL-2.0' }] }), '(MIT OR GPL-2.0)');
  assert.equal(declaredLicense({}), null);
});

test('the repository boundary holds on the installed workspace', () => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const real = JSON.parse(fs.readFileSync(path.join(repo, 'license-policy.json'), 'utf8'));
  assert.deepEqual([...real.permissiveBoundary.packages].sort(), ['packages/contracts', 'packages/extension-sdk', 'packages/sdk']);
  assert.deepEqual(checkPermissiveBoundary(repo, real), []);
});

