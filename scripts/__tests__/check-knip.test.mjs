import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compareToBaseline, findingKeys } from '../check-knip.mjs';

const report = {
  issues: [
    {
      file: 'apps/studio/src/a.tsx',
      owners: [],
      files: [{ name: 'apps/studio/src/a.tsx' }],
      exports: [{ name: 'A', line: 3, col: 1, pos: 10 }],
      duplicates: [[{ name: 'default', line: 9 }, { name: 'A', line: 3 }]],
      dependencies: [],
    },
    { file: 'packages/x/package.json', owners: [], dependencies: [{ name: 'zod', line: 5 }] },
  ],
};

test('findings become stable keys without line numbers', () => {
  assert.deepEqual(findingKeys(report), [
    'dependencies packages/x/package.json zod',
    'duplicates apps/studio/src/a.tsx A|default',
    'exports apps/studio/src/a.tsx A',
    'files apps/studio/src/a.tsx apps/studio/src/a.tsx',
  ]);
});

test('only findings missing from the baseline fail; fixed ones are reported', () => {
  const baseline = ['exports apps/studio/src/a.tsx A', 'exports apps/studio/src/b.tsx B'];
  const current = ['exports apps/studio/src/a.tsx A', 'dependencies packages/x/package.json zod'];
  assert.deepEqual(compareToBaseline(current, baseline), {
    added: ['dependencies packages/x/package.json zod'],
    fixed: ['exports apps/studio/src/b.tsx B'],
  });
});
