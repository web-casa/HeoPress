import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkCleanInstall, checkPluginPackage, checkSdkPackage } from '../verify-plugin-package.mjs';

// P12 task 9.2: what the plugin-package job accepts as the packed SDK, the packed plugin and the clean install.
const sdkManifest = { name: '@heopress/extension-sdk', version: '1.0.0', license: 'Apache-2.0' };
const sdkFiles = ['package/package.json', 'package/LICENSE', 'package/NOTICE', 'package/dist/index.js', 'package/dist/index.d.ts'];
const sdkCode = {
  'dist/index.js': 'function defineJob(def) { return { ...def, kind: "job" }; }\nexport { defineJob };\n',
  'dist/index.d.ts': '/** Validated by `ExtensionManifestSchema` in `@heopress/contracts/schemas`. */\nexport declare function defineJob<T>(d: T): T;\n',
};

test('the packed SDK: built files only, self-contained, no core implementation (a comment may name a core module)', () => {
  assert.deepEqual(checkSdkPackage(sdkManifest, sdkFiles, sdkCode), []);
});

test('source, dependencies, imports or core code in the packed SDK fail', () => {
  const problems = checkSdkPackage(
    { ...sdkManifest, dependencies: { '@heopress/contracts': '1.0.0' } },
    [...sdkFiles, 'package/src/index.ts'],
    {
      'dist/index.js': 'import { z } from "zod";\nconst db = drizzle(postgres(process.env.DATABASE_URL));\n',
      'dist/index.d.ts': 'import type { ItemService } from "@heopress/cms";\n',
    },
  );
  assert.deepEqual(problems, [
    'the SDK tarball holds package/src/index.ts: only the built files, LICENSE and NOTICE are published',
    'the SDK has dependencies: a plugin would install more than the SDK',
    'dist/index.js loads zod at run time: the SDK is self-contained',
    'dist/index.js contains "postgres(": core implementation does not belong in the SDK',
    'dist/index.js contains "process.env": core implementation does not belong in the SDK',
    'dist/index.d.ts contains "@heopress/cms": core implementation does not belong in the SDK',
    'dist/index.d.ts contains "ItemService": core implementation does not belong in the SDK',
  ]);
});

const pluginFiles = ['package/package.json', 'package/LICENSE', 'package/NOTICE', 'package/dist/index.js', 'package/heopress-extension.json', 'package/src/index.ts'];
const extension = { name: 'heopress-glossary', capabilities: ['ext:events'] };

test('the packed plugin: a self-contained bundle and its manifest', () => {
  assert.deepEqual(checkPluginPackage({ name: '@heopress/plugin-glossary', license: 'Apache-2.0' }, pluginFiles, 'export default () => ({});\n', extension), []);
});

test('a plugin bundle that imports at run time, ships tests or depends on a HeoPress package fails', () => {
  const problems = checkPluginPackage(
    { name: '@heopress/plugin-glossary', license: 'Apache-2.0', dependencies: { '@heopress/contracts': '1.0.0' } },
    [...pluginFiles, 'package/src/__tests__/linker.test.ts'],
    'import { x } from "@heopress/contracts";\nexport default () => x;\n',
    extension,
  );
  assert.deepEqual(problems, [
    'the plugin tarball holds a test: package/src/__tests__/linker.test.ts',
    'the plugin dependencies names @heopress/contracts: it installs no HeoPress package',
    'dist/index.js loads something at run time: the bundle is one self-contained module',
    'dist/index.js names @heopress/contracts',
  ]);
});

test('the clean project holds the two tarballs only, installed, never linked', () => {
  const sdk = { name: '@heopress/extension-sdk' };
  const plugin = { name: '@heopress/plugin-glossary' };
  assert.deepEqual(checkCleanInstall({ 'node_modules/@heopress/extension-sdk': sdk, 'node_modules/@heopress/plugin-glossary': plugin }, []), []);
  assert.deepEqual(
    checkCleanInstall({ 'node_modules/@heopress/extension-sdk': sdk, 'node_modules/@heopress/plugin-glossary': plugin, 'node_modules/@heopress/contracts': { name: '@heopress/contracts' } }, ['node_modules/@heopress/plugin-glossary']),
    [
      'the clean project installed @heopress/contracts, @heopress/extension-sdk, @heopress/plugin-glossary; expected only @heopress/extension-sdk and @heopress/plugin-glossary',
      'node_modules/@heopress/plugin-glossary is a link (a workspace or source alias), not an installed package',
    ],
  );
});
