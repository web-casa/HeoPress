import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkInstalledTree, checkPackedPackage, checkToolPin, runtimeLoads } from '../verify-plugin-template.mjs';

// P07 task 7.9: what the plugin-template job accepts after installing the packed SDK alone.
const policy = { allow: ['MIT', 'Apache-2.0', 'ISC'], deny: ['GPL', 'AGPL', 'LGPL', 'SSPL', 'BUSL'] };
const sdk = { name: '@heopress/extension-sdk', version: '1.0.0', license: 'Apache-2.0' };
const ts = { name: 'typescript', version: '5.9.3', license: 'Apache-2.0' };

test('the SDK and permissive tooling pass', () => {
  assert.deepEqual(checkInstalledTree({ 'node_modules/@heopress/extension-sdk': sdk, 'node_modules/typescript': ts }, policy), []);
});

test('an AGPL package, a HeoPress core package or an unlicensed package in the plugin tree fails', () => {
  const problems = checkInstalledTree(
    {
      'node_modules/@heopress/extension-sdk': sdk,
      'node_modules/@heopress/database': { name: '@heopress/database', version: '1.0.0', license: 'AGPL-3.0-only' },
      'node_modules/left': { name: 'left', version: '1.0.0' },
    },
    policy,
  );
  assert.deepEqual(problems, [
    '@heopress/database@1.0.0 (node_modules/@heopress/database): a HeoPress package other than @heopress/extension-sdk is installed',
    '@heopress/database@1.0.0 (node_modules/@heopress/database): license "AGPL-3.0-only" is copyleft or source-available',
    'left@1.0.0 (node_modules/left): license "missing" is not on the allow list',
  ]);
});

test('a plugin tree without the SDK fails', () => {
  assert.deepEqual(checkInstalledTree({ 'node_modules/typescript': ts }, policy), ['@heopress/extension-sdk is not installed']);
});

test('a packed boundary package must be Apache-2.0, carry LICENSE, NOTICE and types, and depend on no HeoPress package', () => {
  const files = ['package/package.json', 'package/LICENSE', 'package/NOTICE', 'package/dist/index.d.ts', 'package/dist/index.js'];
  assert.deepEqual(checkPackedPackage(sdk, files, 'Apache-2.0'), []);
  assert.deepEqual(checkPackedPackage({ name: '@heopress/contracts', license: 'Apache-2.0' }, files.filter((f) => !f.endsWith('NOTICE')), 'Apache-2.0'), [
    'packed @heopress/contracts has no NOTICE',
  ]);
  assert.deepEqual(
    checkPackedPackage({ ...sdk, license: 'AGPL-3.0-only', dependencies: { '@heopress/contracts': '1', heopress: '1' } }, ['package/dist/index.d.ts'], 'Apache-2.0'),
    [
      'packed @heopress/extension-sdk declares license "AGPL-3.0-only", not "Apache-2.0"',
      'packed @heopress/extension-sdk has no LICENSE',
      'packed @heopress/extension-sdk has no NOTICE',
      'packed @heopress/extension-sdk dependencies names @heopress/contracts: a plugin would install a HeoPress core package',
      'packed @heopress/extension-sdk dependencies names heopress: a plugin would install a HeoPress core package',
    ],
  );
});

test('a built plugin may not load a HeoPress package at run time, in any module syntax', () => {
  assert.deepEqual(runtimeLoads("const x = 1;\nexport default { on: 'items.create' };\n"), { heopress: [], computed: [] });
  const loads = [
    "import { a } from '@heopress/contracts';",
    'export * from "@heopress/sdk";',
    "const b = import('@heopress/database');",
    "const c = require( '@heopress/runtime' );",
    "import 'heopress';",
    "const d = require('left-pad');",
  ];
  assert.deepEqual(runtimeLoads(loads.join('\n')), {
    heopress: ['@heopress/contracts', '@heopress/database', '@heopress/runtime', '@heopress/sdk', 'heopress'],
    computed: [],
  });
});

test('subpath, scope and assembled HeoPress specifiers and computed dynamic loads are refused; comments are not code', () => {
  const code = [
    "const p = ['@heopress', 'sdk'].join('/');",
    'const m = await import(p);',
    "const core = require('heopress/' + 'dist/index.js');",
    "const t = require(`heopress/${'x'}`);",
    "const s = require('heopress/dist/server.js');",
    "// import('@heopress/commented-out') and require(name) in a comment are not loads",
    "/* require('@heopress/also-a-comment') */",
    "const url = 'https://example.com/a//b'; // a // inside a string is not a comment",
    "const meta = import.meta.url;",
  ].join('\n');
  const { heopress, computed } = runtimeLoads(code);
  assert.deepEqual(heopress, ['@heopress', 'heopress/', "heopress/${'x'}", 'heopress/dist/server.js']);
  assert.deepEqual(computed, ['import(p)', "require('heopress/' + 'dist/index.js')", 'require(`${}`)']);
});

test('HeoPress package names: the scope, the core package and its subpaths, not look-alikes', () => {
  const policyAll = { allow: ['MIT', 'Apache-2.0'], deny: [] };
  const tree = (name) => ({ [`node_modules/${name}`]: { name, version: '1.0.0', license: 'MIT' }, 'node_modules/@heopress/extension-sdk': sdk });
  assert.equal(checkInstalledTree(tree('heopress'), policyAll).length, 1);
  assert.equal(checkInstalledTree(tree('@heopress/cms'), policyAll).length, 1);
  assert.deepEqual(checkInstalledTree(tree('heopress-theme-x'), policyAll), []);
});

test('the template pins the TypeScript its build is verified with, exactly', () => {
  assert.deepEqual(checkToolPin({ devDependencies: { typescript: '5.9.3' } }, '5.9.3'), []);
  assert.equal(checkToolPin({ devDependencies: { typescript: '^5.6.2' } }, '5.9.3').length, 1);
  assert.equal(checkToolPin({}, '5.9.3').length, 1);
});
