import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { checkNotices, MODIFIED_LIST, NOTICE_MARKER } from '../check-modification-notices.mjs';

/** Temporary directories this file made: removed when it ends (they used to pile up in the system temp directory). */
const madeDirs = [];
after(() => {
  for (const dir of madeDirs) fs.rmSync(dir, { recursive: true, force: true });
});
const tempDir = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  madeDirs.push(dir);
  return dir;
};

// Run from a git hook (`git commit` → husky → these tests), the environment names the repository being
// committed to (GIT_DIR, GIT_INDEX_FILE, …): every git command here — in the fixtures and in the scripts
// under test — would act on it instead of the fixture repositories. Dropped before any test runs.
for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key];

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** A tiny "upstream" repository with one commit, then local modifications. */
function fixture() {
  const root = tempDir('heopress-notices-');
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'fixture@example.com');
  git(root, 'config', 'user.name', 'fixture');
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  write('src/a.ts', '// Copyright 2024 LumiBase Contributors\nexport const name = "lumibase";\n');
  write('scripts/run.sh', '#!/usr/bin/env sh\necho lumibase\n');
  write('config.json', '{ "name": "lumibase" }\n');
  write('docs/guide.md', '# LumiBase\n');
  write('moved/same.ts', 'export const same = 1;\n');
  write('LICENSE', 'Apache License\nCopyright 2024-present LumiBase Contributors\n' + 'apache terms line\n'.repeat(40));
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'upstream');
  const base = git(root, 'rev-parse', 'HEAD');
  // Local modifications.
  write('src/a.ts', '// Copyright 2024 LumiBase Contributors\nexport const name = "heopress";\n');
  write('scripts/run.sh', '#!/usr/bin/env sh\necho heopress\n');
  write('config.json', '{ "name": "heopress" }\n');
  fs.mkdirSync(path.join(root, 'renamed'), { recursive: true });
  fs.renameSync(path.join(root, 'moved/same.ts'), path.join(root, 'renamed/same.ts'));
  // The upstream license moves aside and LICENSE is replaced by a different text.
  fs.mkdirSync(path.join(root, 'LICENSES'), { recursive: true });
  fs.copyFileSync(path.join(root, 'LICENSE'), path.join(root, 'LICENSES/Apache-2.0.txt'));
  write('LICENSE', 'GNU AFFERO GENERAL PUBLIC LICENSE\n' + 'agpl terms line\n'.repeat(40));
  git(root, 'add', '-A');
  return { root, base };
}

test('fails when modified upstream files lack the notice and the list is missing', () => {
  const { root, base } = fixture();
  const problems = checkNotices({ root, base });
  assert.ok(problems.some((p) => p.startsWith('src/a.ts: modified upstream file lacks')));
  assert.ok(problems.some((p) => p.startsWith('scripts/run.sh: modified upstream file lacks')));
  assert.ok(problems.some((p) => p.includes(`${MODIFIED_LIST} is out of date`)));
});

test('--fix adds in-file notices, keeps the shebang first and lists non-commentable files', () => {
  const { root, base } = fixture();
  assert.deepEqual(checkNotices({ root, base, fix: true }), []);
  assert.deepEqual(checkNotices({ root, base }), []);
  const a = fs.readFileSync(path.join(root, 'src/a.ts'), 'utf8');
  assert.equal(a.split('\n')[0], `// ${NOTICE_MARKER}`);
  assert.ok(a.includes('// Copyright 2024 LumiBase Contributors'));
  const sh = fs.readFileSync(path.join(root, 'scripts/run.sh'), 'utf8').split('\n');
  assert.equal(sh[0], '#!/usr/bin/env sh');
  assert.equal(sh[1], `# ${NOTICE_MARKER}`);
  const list = fs.readFileSync(path.join(root, MODIFIED_LIST), 'utf8');
  assert.ok(list.split('\n').includes('config.json'));
  assert.ok(!list.split('\n').includes('docs/guide.md'), 'unmodified files are not listed');
  assert.ok(!list.split('\n').includes('renamed/same.ts'), 'a pure move is not a modification');
});

test('deleting a fixture notice makes the check fail again', () => {
  const { root, base } = fixture();
  checkNotices({ root, base, fix: true });
  const file = path.join(root, 'src/a.ts');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(`// ${NOTICE_MARKER}\n`, ''));
  const problems = checkNotices({ root, base });
  assert.deepEqual(problems, ['src/a.ts: modified upstream file lacks the HeoPress modification notice']);
});

test('removing an upstream copyright line is reported, and --fix does not paper over it', () => {
  const { root, base } = fixture();
  checkNotices({ root, base, fix: true });
  const file = path.join(root, 'src/a.ts');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('// Copyright 2024 LumiBase Contributors\n', ''));
  const expected = 'src/a.ts: upstream copyright line removed: "// Copyright 2024 LumiBase Contributors"';
  assert.ok(checkNotices({ root, base }).includes(expected));
  assert.ok(checkNotices({ root, base, fix: true }).includes(expected));
});

test('a missing base commit is a clear error, not a silent pass', () => {
  const { root } = fixture();
  assert.throws(() => checkNotices({ root, base: '0123456789abcdef0123456789abcdef01234567' }), /fetch full history/);
});

test('a file replaced wholesale is a new file: no notice, no copyright comparison', () => {
  const { root, base } = fixture();
  const problems = checkNotices({ root, base, fix: true });
  assert.deepEqual(problems, []);
  const list = fs.readFileSync(path.join(root, MODIFIED_LIST), 'utf8').split('\n');
  assert.ok(!list.includes('LICENSE'));
  assert.ok(!list.includes('LICENSES/Apache-2.0.txt'), 'an identical copy is not a modification');
});

test('template-style copyright notices without a literal year are protected too', () => {
  const root = tempDir('heopress-notices-');
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'fixture@example.com');
  git(root, 'config', 'user.name', 'fixture');
  fs.writeFileSync(path.join(root, 'Footer.tsx'), 'export const f = <p>© {new Date().getFullYear()} LumiBase</p>;\nexport const brand = "LumiBase";\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'upstream');
  const base = git(root, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(root, 'Footer.tsx'), 'export const f = <p>© {new Date().getFullYear()} HeoPress</p>;\nexport const brand = "HeoPress";\n');
  const problems = checkNotices({ root, base, fix: true });
  assert.ok(problems.some((p) => p.includes('upstream copyright line removed') && p.includes('LumiBase')));
});

test('a renamed and heavily edited small file is paired by path, not treated as new', () => {
  const root = tempDir('heopress-notices-');
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'fixture@example.com');
  git(root, 'config', 'user.name', 'fixture');
  fs.mkdirSync(path.join(root, 'packages/create-lumibase'), { recursive: true });
  fs.writeFileSync(path.join(root, 'packages/create-lumibase/compose.yml'), 'services:\n  db:\n    image: postgres:16\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'upstream');
  const base = git(root, 'rev-parse', 'HEAD');
  fs.rmSync(path.join(root, 'packages/create-lumibase'), { recursive: true });
  fs.mkdirSync(path.join(root, 'packages/create-heopress'), { recursive: true });
  fs.writeFileSync(path.join(root, 'packages/create-heopress/compose.yml'), 'services:\n  postgres:\n    image: postgres:18-alpine\n');
  git(root, 'add', '-A');
  assert.deepEqual(checkNotices({ root, base }).filter((p) => p.includes('compose.yml')), [
    'packages/create-heopress/compose.yml: modified upstream file lacks the HeoPress modification notice',
  ]);
});

test('pnpm-lock.yaml is listed, not commented: pnpm drops comments when it rewrites the lockfile', () => {
  const { root, base } = fixture();
  fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'lockfile');
  const withLock = git(root, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\nimporters: {}\n");
  assert.deepEqual(checkNotices({ root, base: withLock, fix: true }), []);
  assert.ok(!fs.readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8').includes(NOTICE_MARKER));
  assert.ok(fs.readFileSync(path.join(root, MODIFIED_LIST), 'utf8').split('\n').includes('pnpm-lock.yaml'));
});

test('generated migrations are listed, not commented: drizzle-kit owns them and the migrator hashes them', () => {
  const { root, base } = fixture();
  const sql = 'packages/database/drizzle/0000_init.sql';
  fs.mkdirSync(path.join(root, 'packages/database/drizzle'), { recursive: true });
  fs.writeFileSync(path.join(root, sql), 'CREATE TABLE "lumibase_a" ("id" text);\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'migration');
  const withMigration = git(root, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(root, sql), 'CREATE TABLE "lumibase_a" ("id" text, "b" text);\n');
  assert.deepEqual(checkNotices({ root, base: withMigration, fix: true }), []);
  assert.ok(!fs.readFileSync(path.join(root, sql), 'utf8').includes(NOTICE_MARKER));
  assert.ok(fs.readFileSync(path.join(root, MODIFIED_LIST), 'utf8').split('\n').includes(sql));
});
