import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { isHistoricalDoc } from '../docs-i18n/verify-code-refs.mjs';

// Spec engineering/docs-integrity "文档引用的代码必须存在": a current doc that
// names a missing source file fails and names the doc and the path; a doc whose
// references all exist passes; planning/historical docs are excluded.

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs-i18n', 'verify-code-refs.mjs');

function run(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'heopress-code-refs-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  try {
    return spawnSync(process.execPath, [script], { env: { ...process.env, DOCS_ROOT: root }, encoding: 'utf8' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const STALE = '# Feature\n\nImplemented in `apps/cms/src/routes/no-such-route.ts`.\n';
const OK = '# Feature\n\nImplemented in `apps/cms/src/routes/health.ts`.\n';

test('a doc referencing a deleted source file fails and names doc and path', () => {
  const res = run({ 'en/features/x.md': STALE });
  assert.equal(res.status, 1);
  assert.match(res.stdout, /docs\/en\/features\/x\.md\n\s+\[file\] apps\/cms\/src\/routes\/no-such-route\.ts — file does not exist/);
});

test('a doc whose references all exist passes', () => {
  const res = run({ 'en/features/x.md': OK, 'zh-CN/features/x.md': OK });
  assert.equal(res.status, 0, res.stdout);
  assert.match(res.stdout, /findings=0/);
});

test('developer docs (docs/dev/, one language) are checked too', () => {
  const stale = run({ 'dev/release.md': STALE, 'en/features/x.md': OK });
  assert.equal(stale.status, 1);
  assert.match(stale.stdout, /docs\/dev\/release\.md\n\s+\[file\] apps\/cms\/src\/routes\/no-such-route\.ts — file does not exist/);
  const ok = run({ 'dev/release.md': OK });
  assert.equal(ok.status, 0, ok.stdout);
  assert.match(ok.stdout, /docs=1 claims=1 .*findings=0/);
});

test('planning and historical docs are excluded, and counted', () => {
  const res = run({
    'en/roadmap/plan.md': STALE,
    'en/architecture/old.md': `# Old\n\n<!-- verify-code-refs: historical -->\n${STALE}`,
  });
  assert.equal(res.status, 0, res.stdout);
  assert.match(res.stdout, /excluded-historical=2/);
  assert.equal(isHistoricalDoc('roadmap/plan.md', ''), true);
  assert.equal(isHistoricalDoc('features/x.md', '<!-- verify-code-refs: historical -->'), true);
  assert.equal(isHistoricalDoc('features/x.md', OK), false);
});
