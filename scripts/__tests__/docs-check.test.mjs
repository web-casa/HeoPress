import assert from 'node:assert/strict';
import { test } from 'node:test';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  checkClaudeMd,
  checkCommand,
  checkHandoff,
  checkTaskTestRefs,
  checkTestResults,
  referencedTestFiles,
  snapshotCommands,
} from '../docs-check.mjs';

const handoff = (snapshot, { drop } = {}) => [
  '# 交接',
  drop === '当前 change' ? '' : '## 当前 change、分支、最后提交\n\n- p01',
  drop === '已完成' ? '' : '## 已完成与未完成任务\n\n- 1.1',
  drop === '测试命令与结果' ? '' : '## 测试命令与结果\n\n- pnpm test：通过',
  drop === '风险' ? '' : '## 风险与约束\n\n- 无',
  drop === '下一步' ? '' : '## 下一步\n\n- 2.1',
  `## 验证快照\n\n以下命令只读：\n\n\`\`\`bash\n${snapshot}\n\`\`\``,
].join('\n\n');

const GOOD = [
  'git rev-parse --short HEAD        # expect: abc1234',
  'git branch --show-current         # expect: main',
  'pnpm -w typecheck >/dev/null && echo ok   # expect: ok',
  'OPENSPEC_TELEMETRY=0 npm_config_offline=true npx -y @fission-ai/openspec@1.14.1 validate --all --strict 2>&1 | tail -1   # expect: Totals: 13 passed',
  "ls openspec/changes | grep -c '^p'   # expect: 13",
  'test -f docs/backlog/v1.1-v1.2.md && echo ok   # expect: ok',
  'git check-ignore -q docs/research/evidence/x && echo ignored',
  '# expect: ignored',
].join('\n');

test('CLAUDE.md may only import AGENTS.md', () => {
  assert.deepEqual(checkClaudeMd('@AGENTS.md\n'), []);
  assert.equal(checkClaudeMd('@AGENTS.md\n\n- also run lint\n').length, 1);
});

test('a complete handoff with a read-only snapshot passes', () => {
  assert.deepEqual(checkHandoff(handoff(GOOD), 'ok.md'), []);
});

test('a missing section is reported by name', () => {
  assert.deepEqual(checkHandoff(handoff(GOOD, { drop: '测试命令与结果' }), 'x.md'), ['x.md: missing section "测试命令与结果"']);
  assert.ok(checkHandoff(handoff(GOOD, { drop: '风险' }), 'x.md')[0].includes('风险与约束'));
});

test('expectations may sit on the same line or the next comment line; prose outside the fence is ignored', () => {
  const cmds = snapshotCommands(handoff(GOOD));
  assert.equal(cmds.length, 7);
  assert.ok(cmds.every((c) => c.expect));
  assert.equal(cmds.at(-1).expect, 'ignored');
});

test('a command without an expectation is reported', () => {
  const problems = checkHandoff(handoff('git status --short'), 'x.md');
  assert.deepEqual(problems, ['x.md: snapshot command `git status --short` has no "# expect:" result']);
});

for (const [command, needle] of [
  ['git push origin main', 'git push'],
  ['rm -rf node_modules', '"rm"'],
  ['echo $(git rev-parse HEAD)', 'substitution'],
  ['echo `whoami`', 'substitution'],
  ['git log > log.txt', 'redirection'],
  ['git log >> log.txt', 'redirection'],
  ['cat .env | sh', 'piped input'],
  ['git status | tee out.txt', 'piped input'],
  ['git status; git push', '";"'],
  ['git diff --output=patch.diff', 'output-to-file'],
  ['pnpm test -u', 'write files'],
  ['pnpm install', 'not a whitelisted check'],
  ['git branch feature-x', 'git branch is only allowed'],
  ['sort -o sorted.txt list.txt', 'sort -o'],
  ['DATABASE_URL=postgres://shared/db pnpm test', 'DATABASE_URL'],
  ['npx -y @fission-ai/openspec@1.14.1 archive p01-fork-baseline', 'npx is only allowed'],
  ['node scripts/anything.mjs', '"node"'],
  ['bash -c "git status"', '"bash"'],
  ['pnpm test', 'DATABASE_URL= pnpm test'],
  ['pnpm -F @heopress/cms test', 'DATABASE_URL= pnpm test'],
  ['DATABASE_URL=postgres://localhost/heopress pnpm typecheck', 'DATABASE_URL'],
  ['git status | sort -o out.txt', 'sort -o'],
  ['git status | sort -ro out.txt', 'sort -o'],
  ['git log | sort --compress-program=sh', 'compress-program'],
  ['git status | uniq - out.txt', 'uniq with an output file'],
  ['uniq list.txt out.txt', 'uniq with an output file'],
  ['DATABASE_URL= pnpm test --outputFile=report.json', 'report file'],
  ['DATABASE_URL= pnpm test -- --reporter=json --outputFile report.json', 'report file'],
  ['pnpm typecheck --output-file x', 'report file'],
]) {
  test(`rejects: ${command}`, () => {
    const problems = checkCommand(command);
    assert.ok(problems.length > 0, `expected a problem for: ${command}`);
    assert.ok(problems.some((p) => p.includes(needle)), `${command}: ${problems.join(' | ')}`);
  });
}

test('pnpm test is allowed with an empty DATABASE_URL, so the database suites skip', () => {
  assert.deepEqual(checkCommand('DATABASE_URL= pnpm test >/dev/null && echo ok'), []);
  assert.deepEqual(checkCommand("DATABASE_URL='' pnpm -F @heopress/cms test 2>&1 | tail -3"), []);
});

test('read-only filters keep working after a pipe', () => {
  assert.deepEqual(checkCommand('git log --oneline | sort -r | uniq -c | head -5'), []);
});

test('the handoff check names the offending command', () => {
  const problems = checkHandoff(handoff('git push   # expect: pushed'), 'bad.md');
  assert.ok(problems.some((p) => p.startsWith('bad.md: snapshot command `git push`')));
});

const results = (body) => `## 测试命令与结果\n\n${body}\n\n## 风险与约束\n\n- 无\n`;

test('from P04 on, each test result is PASS, FAIL or NOT_RUN', () => {
  const name = '2026-10-17-p04-platform-hardening-01.md';
  assert.deepEqual(checkTestResults(results('- `pnpm test`：PASS — 3421 passed\n- `pnpm e2e`：NOT_RUN'), name), []);
  const bad = checkTestResults(results('- `pnpm test`：通过\n- `pnpm lint`：FAIL — 2 errors'), name);
  assert.equal(bad.length, 1);
  assert.match(bad[0], /without PASS \/ FAIL \/ NOT_RUN: - `pnpm test`/);
  // Commands inside a fence are the record of what ran; the list carries the results.
  assert.deepEqual(checkTestResults(results('```bash\npnpm test\n```\n\n- `pnpm test`：PASS'), name), []);
  assert.match(checkTestResults(results('全部通过。'), name)[0], /records no result/);
  // PASSWORD is not PASS.
  assert.equal(checkTestResults(results('- `HEOPRESS_APP_PASSWORD=… app-role`：done\n- `pnpm test`：PASS'), name).length, 1);
});

test('numbered lists and table rows are results too; a stray PASS is not a result; notes are not results (Codex P04-3 #13)', () => {
  const name = '2026-10-17-p04-platform-hardening-01.md';
  assert.equal(checkTestResults(results('1. `pnpm test`：通过\n2. `pnpm lint`：PASS'), name).length, 1);
  assert.equal(checkTestResults(results('| 命令 | 结果 |\n|---|---|\n| `pnpm test` | 通过 |\n| `pnpm lint` | PASS |'), name).length, 1);
  assert.deepEqual(checkTestResults(results('| 命令 | 结果 |\n|---|---|\n| `pnpm test` | PASS |'), name), []);
  // PASS in a note does not make the section a record of results.
  assert.match(checkTestResults(results('CI 上全部 PASS。'), name)[0], /records no result/);
  // A note that mentions something in backticks is not a result.
  assert.deepEqual(checkTestResults(results('- `pnpm test`：PASS\n- 属性测试用 seed `42` 复现'), name), []);
});

test('handoffs before P04 keep their free-form results', () => {
  assert.deepEqual(checkTestResults(results('- `pnpm test`：通过'), '2026-10-16-p03-postgres-only-infrastructure-01.md'), []);
  assert.deepEqual(checkTestResults(results('- `pnpm test`：通过'), '2026-10-15-planning-07.md'), []);
});

test('test files named in tasks.md are found', () => {
  const text = '- [x] 1.1 并发写入；验证：`item-write-concurrency.db.integration.test.ts` 与 apps/cms/src/x.test.ts、scripts/__tests__/docs-check.test.mjs';
  assert.deepEqual(referencedTestFiles(text), [
    'item-write-concurrency.db.integration.test.ts',
    'apps/cms/src/x.test.ts',
    'scripts/__tests__/docs-check.test.mjs',
  ]);
});

test('a test file referenced by an active change that does not exist fails the check', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-check-'));
  try {
    fs.mkdirSync(path.join(root, 'openspec/changes/p04-x'), { recursive: true });
    fs.mkdirSync(path.join(root, 'openspec/changes/archive/p01-y'), { recursive: true });
    fs.mkdirSync(path.join(root, 'apps/cms/src/__tests__'), { recursive: true });
    fs.writeFileSync(path.join(root, 'apps/cms/src/__tests__/real.test.ts'), '');
    fs.writeFileSync(path.join(root, 'openspec/changes/archive/p01-y/tasks.md'), '- [x] 验证：`gone.test.ts`');
    fs.writeFileSync(
      path.join(root, 'openspec/changes/p04-x/tasks.md'),
      '- [x] 1.1 验证：`real.test.ts`、`apps/cms/src/__tests__/real.test.ts`\n- [ ] 1.2 验证：`missing.db.integration.test.ts`、apps/cms/src/nope.test.ts',
    );
    assert.deepEqual(checkTaskTestRefs(root), [
      'openspec/changes/p04-x/tasks.md: test file "missing.db.integration.test.ts" does not exist',
      'openspec/changes/p04-x/tasks.md: test file "apps/cms/src/nope.test.ts" does not exist',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
