import assert from 'node:assert/strict';
import { test } from 'node:test';

import { allAuditIgnores, readWorkspaceAuditIgnores, workspaceWithoutAuditIgnores } from '../pnpm-audit-config.mjs';

// P07 task 8.1: the audit ignores of pnpm-workspace.yaml are found however the keys are quoted and the lists written;
// pnpm 10 reads that copy, so an ignore missed here would silence an advisory without an exception.
const BASE = 'packages:\n  - "apps/*"\n\noverrides:\n  "vite": "^8.3.2"\n';

test('plain, single- and double-quoted keys; block and flow lists; comments', () => {
  const forms = [
    'auditConfig:\n  ignoreGhsas:\n    - "GHSA-1"\n  ignoreCves:\n    - CVE-1 # reviewed\n',
    "'auditConfig':\n  'ignoreGhsas':\n    - 'GHSA-1'\n  \"ignoreCves\": [\"CVE-1\"]\n",
    '"auditConfig": # the audit ignores\n  "ignoreGhsas": [GHSA-1]\n  ignoreCves:\n  - CVE-1\n',
    'auditConfig: { ignoreGhsas: [GHSA-1], "ignoreCves": [CVE-1] }\n',
  ];
  for (const form of forms) {
    assert.deepEqual(readWorkspaceAuditIgnores(`${BASE}\n${form}`), { ignoreGhsas: ['GHSA-1'], ignoreCves: ['CVE-1'] }, form);
    const stripped = workspaceWithoutAuditIgnores(`${BASE}\n${form}\nonlyBuiltDependencies:\n  - esbuild\n`);
    assert.doesNotMatch(stripped, /GHSA-1|CVE-1|auditConfig/, form);
    assert.match(stripped, /onlyBuiltDependencies:\n {2}- esbuild/, 'what follows the block is kept');
    assert.match(stripped, /overrides:\n {2}"vite": "\^8\.3\.2"/, 'what precedes it is kept');
  }
  assert.deepEqual(readWorkspaceAuditIgnores(BASE), { ignoreGhsas: [], ignoreCves: [] });
  assert.equal(workspaceWithoutAuditIgnores(BASE), BASE);
  // A key only nested under something else is not pnpm's auditConfig.
  assert.deepEqual(readWorkspaceAuditIgnores('x:\n  auditConfig:\n    ignoreCves:\n      - CVE-1\n'), { ignoreGhsas: [], ignoreCves: [] });
});

test('what cannot be read is refused, never taken as "no ignores"', () => {
  for (const bad of [
    'auditConfig: *ignores\n',
    'auditConfig:\n  ignoreCves: *list\n',
    'auditConfig:\n  ignoreSeverity: high\n',
    'auditConfig: { ignoreCves: [CVE-1], other: 1 }\n',
    'auditConfig:\n  - CVE-1\n',
  ]) {
    assert.throws(() => readWorkspaceAuditIgnores(bad), Error, bad);
    assert.throws(() => workspaceWithoutAuditIgnores(bad), Error, bad);
  }
  assert.throws(() => workspaceWithoutAuditIgnores('auditConfig:\n  ignoreCves: [A]\nx: 1\n"auditConfig":\n  ignoreGhsas: [B]\n'), /more than one/);
});

test('the ignores of both copies, without duplicates', () => {
  const pkg = { pnpm: { auditConfig: { ignoreGhsas: ['GHSA-1'], ignoreCves: ['CVE-9'] } } };
  assert.deepEqual(allAuditIgnores(pkg, "'auditConfig':\n  ignoreGhsas: [GHSA-1, GHSA-2]\n").sort(), ['CVE-9', 'GHSA-1', 'GHSA-2']);
  assert.deepEqual(allAuditIgnores({}, ''), []);
});
