import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// P02 task 8.1: each boundary rule in .dependency-cruiser.cjs must actually
// fire. Probe files are written into the real source trees (rules match repo
// paths and workspace resolution) and always removed again.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const PROBES = {
  'apps/studio/src/lib/__boundary_probe__.ts':
    "import { items } from '@heopress/database';\nimport { createDb } from '../../../../packages/database/src/client';\nexport const p = [items, createDb];\n",
  'packages/sdk/src/__boundary_probe__.ts': "export * from '../../runtime/src/index';\n",
  'packages/contracts/src/theme/__boundary_probe__.ts': "export * from '../../../database/src/index';\n",
  'apps/cms/src/services/__boundary_probe__.ts':
    "import type { Context } from 'hono';\nimport { authMiddleware } from '../middleware/auth';\nexport type P = Context;\nexport const m = authMiddleware;\n",
  'apps/cms/src/modules/audit/__boundary_probe__.ts':
    "import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';\nexport const t = StdioServerTransport;\n",
};

function cruise(files) {
  return spawnSync(
    process.execPath,
    [path.join(root, 'node_modules/dependency-cruiser/bin/dependency-cruiser.mjs'), ...files,
      '--config', '.dependency-cruiser.cjs', '--output-type', 'json'],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
}

test('every boundary rule fires on a probe import', () => {
  for (const [file, body] of Object.entries(PROBES)) fs.writeFileSync(path.join(root, file), body);
  try {
    const res = cruise(Object.keys(PROBES));
    const violations = JSON.parse(res.stdout).summary.violations
      .filter((v) => v.from.includes('__boundary_probe__'))
      .map((v) => `${v.rule.name}: ${v.from}`);
    assert.deepEqual([...new Set(violations)].sort(), [
      'business-no-hono: apps/cms/src/services/__boundary_probe__.ts',
      'business-no-http-or-mcp-transport: apps/cms/src/modules/audit/__boundary_probe__.ts',
      'business-no-http-or-mcp-transport: apps/cms/src/services/__boundary_probe__.ts',
      'public-packages-stay-public: packages/contracts/src/theme/__boundary_probe__.ts',
      'public-packages-stay-public: packages/sdk/src/__boundary_probe__.ts',
      'studio-only-public-contracts: apps/studio/src/lib/__boundary_probe__.ts',
    ]);
  } finally {
    for (const file of Object.keys(PROBES)) fs.rmSync(path.join(root, file), { force: true });
  }
});
