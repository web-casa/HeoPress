import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync } from 'node:zlib';

import { buildMirrorCommit, mirrorBranch, mirrorMessage, pickRun, withCommitLock, writeIfCurrent } from '../ci-mirror.mjs';
import {
  exportCommit,
  filterModifiedList,
  findingHash,
  findTerms,
  globToRegExp,
  foldPath,
  hardLinks,
  isDraftText,
  isLicenceLike,
  isEnvFile,
  LICENSE_FILES,
  nameVariants,
  NEVER_PUBLIC,
  neverPublicIncludes,
  parseLsTree,
  parseManifest,
  parseTerms,
  redactTerms,
  selectPaths,
  unsafePaths,
} from '../public-export.mjs';

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

/**
 * The public export and the CI mirror (ADR-0010, ADR-0018): what may leave,
 * the scans that stop an export, and the bindings that keep a public CI
 * result tied to the private commit it was built from.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
/** A draft exception text as `legal/` holds it (the file itself is private: the public mirror's tests run without it). */
const EXCEPTION_DRAFT = '# HeoPress Plugin and Theme Exception — DRAFT\n\n> 状态：**草案，未经法律审阅。** 公开发布前必须由律师审阅并定稿。\n';
const MANIFEST = parseManifest(fs.readFileSync(path.join(ROOT, 'release/public-manifest.yaml'), 'utf8'));
const ID = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };

test('globs: ** spans segments, * stays within one, everything else is literal', () => {
  assert.ok(globToRegExp('apps/**').test('apps/cms/src/index.ts'));
  assert.ok(!globToRegExp('apps/**').test('appsx/a'));
  assert.ok(globToRegExp('docs/*.md').test('docs/README.md'));
  assert.ok(!globToRegExp('docs/*.md').test('docs/en/a.md'));
  assert.ok(!globToRegExp('package.json').test('packagexjson'));
});

test('never means never: no exceptions in the list; environment files are out wherever they are, but .env.example', () => {
  assert.throws(() => parseManifest('include:\n  - a/**\nnever:\n  - "!a/b"\n'), /exceptions are not allowed/);
  for (const f of ['.env', 'a/.env.local', 'apps/cms/.envrc', 'apps/cms/.environment', 'x/.env.production']) assert.ok(isEnvFile(f), f);
  assert.ok(!isEnvFile('docker/.env.example'));
  const manifest = parseManifest('include:\n  - "**"\nnever:\n  - docs/handoffs/**\n');
  const { exported } = selectPaths(['docs/handoffs/.env.example', 'docs/en/a.md', 'apps/.envrc', '.env.example'], manifest);
  assert.deepEqual(exported, ['docs/en/a.md', '.env.example']);
});

test('the real manifest keeps the development process, review records and secrets out, and the code in', () => {
  const files = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  const privateRecords = ['release/private-terms.txt', 'release/gitleaks-reviewed', 'release/opaque-reviewed', 'release/private-releases.jsonl', 'release/private-notes.json', 'release/private/x.md'];
  const extra = ['docker/.env', 'apps/cms/.env.production', 'apps/cms/.envrc', ...privateRecords, ...LICENSE_FILES];
  assert.deepEqual(neverPublicIncludes(MANIFEST, [...files, ...extra]), []);
  const { exported } = selectPaths([...files, ...extra], MANIFEST);
  for (const f of exported) {
    assert.ok(!/^(docs\/(handoffs|research|reviews|review-agent|decisions|backlog|benchmarks)|openspec\/changes|\.claude|\.agents)\//.test(f), `exported: ${f}`);
    assert.ok(!privateRecords.includes(f), `exported: ${f}`);
    assert.ok(!isEnvFile(f), `exported: ${f}`);
    // The plugin and theme exception draft (pending legal review) never leaves; its reviewed text is LICENSE-EXCEPTION.md.
    assert.ok(!f.startsWith('legal/'), `exported: ${f}`);
  }
  // In the private repository the draft is there (and left out above); the public mirror never has it.
  if (fs.existsSync(path.join(ROOT, 'legal/PLUGIN-AND-THEME-EXCEPTION.md'))) {
    assert.ok(files.includes('legal/PLUGIN-AND-THEME-EXCEPTION.md'), 'the draft is in the private repository');
  }
  assert.deepEqual(nameVariants(files, MANIFEST), []);
  for (const must of ['apps/cms/src/index.ts', 'package.json', 'pnpm-lock.yaml', '.github/workflows/ci.yml', 'openspec/config.yaml', '.env.example', 'docker/.env.example', 'release/public-manifest.yaml', 'release/RELEASES.md', ...LICENSE_FILES]) {
    assert.ok(exported.includes(must), `missing: ${must}`);
  }
});

test('the manifest is read strictly: unknown keys and stray lines are errors', () => {
  assert.throws(() => parseManifest('include:\n  - a\nother:\n  - b\n'), /unknown key/);
  assert.throws(() => parseManifest('include:\na\n'), /cannot read/);
  assert.throws(() => parseManifest('never:\n  - a\n'), /nothing to include/);
});

test('private terms are found in path names, link targets, UTF-16 and NUL-separated text — not only plain UTF-8', () => {
  const dir = tempDir('terms-');
  const term = 'real-site.example';
  fs.writeFileSync(path.join(dir, 'plain.md'), 'hello\nOur server is at Real-Site.example\n');
  fs.writeFileSync(path.join(dir, 'utf16.txt'), Buffer.from('REAL-SITE.example', 'utf16le'));
  fs.writeFileSync(path.join(dir, 'utf16be.txt'), Buffer.from('REAL-SITE.example', 'utf16le').swap16());
  fs.writeFileSync(path.join(dir, 'nul.bin'), Buffer.concat([Buffer.from([0, 1]), Buffer.from('real-site.example'), Buffer.from([0])]));
  fs.writeFileSync(path.join(dir, 'real-site.example.md'), 'nothing here');
  fs.symlinkSync('../real-site.example/x', path.join(dir, 'link'));
  // An odd length (a stray byte) must not switch the UTF-16 readings off.
  fs.writeFileSync(path.join(dir, 'utf16be-odd.bin'), Buffer.concat([Buffer.from('real-site.example', 'utf16le').swap16(), Buffer.from([0])]));
  fs.writeFileSync(path.join(dir, 'utf16le-shifted.bin'), Buffer.concat([Buffer.from([7]), Buffer.from('real-site.example', 'utf16le')]));
  const files = ['plain.md', 'utf16.txt', 'utf16be.txt', 'nul.bin', 'real-site.example.md', 'link', 'utf16be-odd.bin', 'utf16le-shifted.bin'];
  const hits = findTerms(dir, files, parseTerms(`# comment\n${term}  # inline\n`));
  for (const f of files) assert.ok(hits.some((h) => h.startsWith(redactTerms(f, [term]))), `not found in ${f}: ${hits.join(', ')}`);
  // Not even in a path: a file named after the term is reported as `[term #1].md`.
  assert.ok(hits.includes('[term #1].md (path, term #1)'), hits.join(', '));
  assert.ok(!hits.some((h) => h.toLowerCase().includes(term)), 'the report must not repeat the term');
});

/** A throwaway repository with a manifest, reviewed lists and a stub gitleaks writing a JSON report. */
function fixtureRepo({ leakLine = null, term = '', reviewed = '', scanned = true } = {}) {
  const dir = tempDir('export-');
  const repo = path.join(dir, 'repo');
  for (const d of ['release', 'docs/handoffs', 'src']) fs.mkdirSync(path.join(repo, d), { recursive: true });
  fs.writeFileSync(path.join(repo, 'release/public-manifest.yaml'), 'include:\n  - src/**\n  - docs/**\nnever:\n  - docs/handoffs/**\n  - release/**\n');
  fs.writeFileSync(path.join(repo, 'release/private-terms.txt'), `# terms\n${term}\n`);
  fs.writeFileSync(path.join(repo, 'release/gitleaks-reviewed'), reviewed);
  fs.writeFileSync(path.join(repo, 'src/a.ts'), 'export const token = "placeholder";\n');
  fs.writeFileSync(path.join(repo, 'docs/handoffs/h.md'), 'private\n');
  const git = (args) => execFileSync('git', args, { cwd: repo, env: { ...process.env, ...ID } });
  git(['init', '-q']);
  git(['add', '-A']);
  git(['commit', '-qm', 'fixture']);
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const report = leakLine ? `[{"File":"src/a.ts","StartLine":${leakLine},"RuleID":"generic-api-key"}]` : '[]';
  // A stand-in for gitleaks: writes its report where asked, like the real one.
  fs.writeFileSync(
    path.join(bin, 'gitleaks'),
    // It refuses to run without --ignore-gitleaks-allow (inline allow comments must never silence a finding) and
    // without a configuration and ignore path of its own (the tree must not configure its scanner).
    `#!/bin/sh\nfor need in --ignore-gitleaks-allow --config --gitleaks-ignore-path; do case " $* " in *" $need "*) ;; *) echo "missing $need" >&2; exit 2;; esac; done\nwhile [ $# -gt 0 ]; do if [ "$1" = "--report-path" ]; then shift; printf '%s' '${report}' > "$1"; fi; shift; done\n${scanned ? 'echo "INF scanned ~42 bytes (42 bytes) in 1ms" >&2\n' : ''}exit 0\n`,
    { mode: 0o755 },
  );
  return { repo, out: path.join(dir, 'out'), bin, git };
}

const withPath = (bin, fn) => {
  const prev = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${prev}`;
  try {
    return fn();
  } finally {
    process.env.PATH = prev;
  }
};

test('an export writes exactly the commit\'s whitelisted files (not the working tree)', () => {
  const { repo, out, bin } = fixtureRepo();
  fs.writeFileSync(path.join(repo, 'src/uncommitted.ts'), 'x');
  const result = withPath(bin, () => exportCommit({ root: repo, out }));
  assert.equal(result.files, 1);
  assert.deepEqual(fs.readdirSync(out, { recursive: true }).sort(), ['src', path.join('src', 'a.ts')]);
});

test('a reviewed gitleaks finding stays reviewed only while its line is unchanged', () => {
  const id = findingHash('src/a.ts', 'generic-api-key', 'export const token = "placeholder";');
  const ok = fixtureRepo({ leakLine: 1, reviewed: `${id}  src/a.ts:1\n` });
  assert.equal(withPath(ok.bin, () => exportCommit({ root: ok.repo, out: ok.out })).files, 1);
  // The same place, its line changed (it could now hold a real secret): a new finding.
  const changed = fixtureRepo({ leakLine: 1, reviewed: `${id}  src/a.ts:1\n` });
  fs.writeFileSync(path.join(changed.repo, 'src/a.ts'), 'export const token = "changed";\n');
  changed.git(['commit', '-qam', 'swap']);
  assert.throws(() => withPath(changed.bin, () => exportCommit({ root: changed.repo, out: changed.out })), /gitleaks findings not reviewed/);
});

test('a private term, a link leaving the export, an unscannable file, a missing scanner or a submodule stops the export', () => {
  const termed = fixtureRepo({ term: 'export const' });
  assert.throws(() => withPath(termed.bin, () => exportCommit({ root: termed.repo, out: termed.out })), /private terms in the export:\n {2}src\/a\.ts:1/);

  const linked = fixtureRepo();
  fs.symlinkSync('../../etc/passwd', path.join(linked.repo, 'src/escape'));
  linked.git(['add', '-A']);
  linked.git(['commit', '-qm', 'link']);
  assert.throws(() => withPath(linked.bin, () => exportCommit({ root: linked.repo, out: linked.out })), /symbolic links leaving the export/);

  // Anything but plain UTF-8 text needs a content review — a format no list knows (Brotli here) included.
  const packed = fixtureRepo({ term: 'real-site.example' });
  fs.writeFileSync(path.join(packed.repo, 'src/a.br'), brotliCompressSync(Buffer.from('real-site.example '.repeat(10))));
  packed.git(['add', '-A']);
  packed.git(['commit', '-qm', 'brotli']);
  assert.throws(() => withPath(packed.bin, () => exportCommit({ root: packed.repo, out: packed.out })), /cannot be scanned[\s\S]*src\/a\.br/);

  // Links that each look fine but chain out of the export; a dangling link.
  const chained = fixtureRepo();
  fs.mkdirSync(path.join(chained.repo, 'src/d'));
  fs.symlinkSync('..', path.join(chained.repo, 'src/d/up'));
  fs.symlinkSync('d/up/../../..', path.join(chained.repo, 'src/out'));
  fs.symlinkSync('missing', path.join(chained.repo, 'src/dangling'));
  chained.git(['add', '-A']);
  chained.git(['commit', '-qm', 'links']);
  const linkError = (() => {
    try {
      withPath(chained.bin, () => exportCommit({ root: chained.repo, out: chained.out }));
      return '';
    } catch (err) {
      return err.message;
    }
  })();
  assert.match(linkError, /symbolic links leaving the export/);
  assert.match(linkError, /src\/out -> d\/up\/\.\.\/\.\.\/\.\./);
  assert.match(linkError, /src\/dangling -> missing \(dangling\)/);
  assert.doesNotMatch(linkError, /src\/d\/up ->/);

  // gitleaks absent (git still on PATH): the scanner's own failure, not git's.
  const noScanner = fixtureRepo();
  const gitDir = path.dirname(execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim());
  const prev = process.env.PATH;
  process.env.PATH = gitDir;
  try {
    // Reported as not completed — never as passed.
    assert.throws(() => exportCommit({ root: noScanner.repo, out: noScanner.out }), /gitleaks did not run .*the secret scan is NOT completed/);
  } finally {
    process.env.PATH = prev;
  }

  const sub = fixtureRepo();
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sub.repo, encoding: 'utf8' }).trim();
  sub.git(['update-index', '--add', '--cacheinfo', `160000,${head},src/vendor`]);
  sub.git(['commit', '-qm', 'submodule']);
  assert.throws(() => withPath(sub.bin, () => exportCommit({ root: sub.repo, out: sub.out })), /submodules cannot be exported/);
});

test('the list of modified upstream files names only what is exported (its comments kept)', () => {
  const list = '# header\n# more\nHeoPress.code-workspace\napps/a.ts\ndocs/review-agent/x.md\n';
  assert.equal(filterModifiedList(list, new Set(['apps/a.ts'])), '# header\n# more\napps/a.ts\n');
});

test('mirror branches hide the private branch name; the message carries only the private SHA', () => {
  assert.match(mirrorBranch('feat/real-site.example-launch'), /^ci\/b-[0-9a-f]{20}$/);
  assert.notEqual(mirrorBranch('feat/中文'), mirrorBranch('feat/日本'));
  assert.throws(() => mirrorBranch('HEAD'));
  const sha = 'a'.repeat(40);
  assert.equal(mirrorMessage(sha), `ci: mirror of a private commit (ADR-0018)\n\nPrivate-Commit: ${sha}\n`);
  assert.throws(() => mirrorMessage('fix: real-site.example'));
});

test('the mirror commit holds exactly the export, under a fixed identity; any difference stops it', () => {
  const { repo, out, bin } = fixtureRepo();
  const { entries, sha } = withPath(bin, () => exportCommit({ root: repo, out }));
  const gitDir = path.join(tempDir('mirror-'), 'm.git');
  execFileSync('git', ['init', '-q', '--bare', gitDir]);
  const built = buildMirrorCommit({ gitDir, out, entries, sha });
  const message = execFileSync('git', ['--git-dir', gitDir, 'log', '-1', '--format=%an <%ae>%n%B', built.commit], { encoding: 'utf8' });
  assert.match(message, /^HeoPress CI mirror <ci-mirror@heopress\.invalid>\nci: mirror of a private commit/);
  // A tree that is not the export (a file changed after exporting) is refused.
  fs.writeFileSync(path.join(out, 'src/a.ts'), 'tampered');
  const other = path.join(tempDir('mirror-'), 'm.git');
  execFileSync('git', ['init', '-q', '--bare', other]);
  assert.throws(() => buildMirrorCommit({ gitDir: other, out, entries, sha }), /differs from the export/);
});

test('the report takes only the push run of the recorded mirror commit on its branch, latest attempt', () => {
  const record = { mirrorSha: 'm1', branch: 'ci/b-1' };
  const base = { head_sha: 'm1', event: 'push', head_branch: 'ci/b-1', path: '.github/workflows/ci.yml', run_number: 5, run_attempt: 1 };
  const runs = [
    { ...base, id: 1 },
    { ...base, id: 2, run_attempt: 2 },
    { ...base, id: 3, event: 'pull_request', run_number: 9 },
    { ...base, id: 4, head_branch: 'main', run_number: 9 },
    { ...base, id: 5, head_sha: 'other', run_number: 9 },
    { ...base, id: 6, path: '.github/workflows/other.yml', run_number: 9 },
  ];
  assert.equal(pickRun(runs, record)?.id, 2);
  assert.equal(pickRun([runs[2]], record), null);
});

test('status writes of one private commit are serialised by its lock', async () => {
  const stateDir = tempDir('mirror-state-');
  const events = [];
  const step = (name, ms) =>
    withCommitLock(
      'c'.repeat(40),
      async () => {
        events.push(`${name} in`);
        await new Promise((r) => setTimeout(r, ms));
        events.push(`${name} out`);
      },
      { stateDir },
    );
  await Promise.all([step('a', 50), step('b', 10)]);
  // Never interleaved: one finishes before the other starts.
  assert.ok(
    JSON.stringify(events) === JSON.stringify(['a in', 'a out', 'b in', 'b out']) || JSON.stringify(events) === JSON.stringify(['b in', 'b out', 'a in', 'a out']),
    events.join(', '),
  );
  assert.deepEqual(fs.readdirSync(path.join(stateDir, 'locks')), []);
});

test('nothing is written through a link: a modified-files list pointing outside is refused and its target left as it was', () => {
  const r = fixtureRepo();
  const outside = path.join(path.dirname(r.repo), 'outside.txt');
  fs.writeFileSync(outside, 'keep me\n');
  fs.mkdirSync(path.join(r.repo, 'docs/LICENSES'), { recursive: true });
  // The fixture exports docs/**: a list at the exported path, as a link to a file outside.
  fs.writeFileSync(path.join(r.repo, 'release/public-manifest.yaml'), 'include:\n  - src/**\n  - docs/**\n  - LICENSES/**\nnever:\n  - docs/handoffs/**\n  - release/**\n');
  fs.mkdirSync(path.join(r.repo, 'LICENSES'));
  fs.symlinkSync(outside, path.join(r.repo, 'LICENSES/HEOPRESS-MODIFIED-FILES.txt'));
  r.git(['add', '-A']);
  r.git(['commit', '-qm', 'link list']);
  assert.throws(() => withPath(r.bin, () => exportCommit({ root: r.repo, out: r.out })), /symbolic links leaving the export/);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'keep me\n');
});

test('a report writes only for the push it started from — by generation, even with the same mirror SHA', async () => {
  const stateDir = tempDir('mirror-state-');
  const sha = 'd'.repeat(40);
  let stored = { generation: 'g1', mirrorSha: 'm1' };
  const writes = [];
  const opts = { read: () => stored, lockOptions: { stateDir } };
  assert.equal(await writeIfCurrent(sha, { generation: 'g1', mirrorSha: 'm1' }, () => writes.push('g1'), opts), true);
  // Mirrored again: same mirror SHA, new generation. The old report's error must not land.
  stored = { generation: 'g2', mirrorSha: 'm1' };
  assert.equal(await writeIfCurrent(sha, { generation: 'g1', mirrorSha: 'm1' }, () => writes.push('stale'), opts), false);
  assert.deepEqual(writes, ['g1']);
});

test('a lock released while another waits is taken, not an error', async () => {
  const stateDir = tempDir('mirror-state-');
  const sha = 'e'.repeat(40);
  const lock = path.join(stateDir, 'locks', `${sha}.lock`);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, '');
  // Released shortly after the waiter first finds it taken.
  setTimeout(() => fs.rmSync(lock, { force: true }), 30);
  const realStat = fs.statSync;
  let raced = false;
  fs.statSync = (p, ...rest) => {
    if (p === lock && !raced) {
      raced = true;
      fs.rmSync(lock, { force: true }); // the holder lets go between open('wx') and stat
    }
    return realStat(p, ...rest);
  };
  try {
    assert.equal(await withCommitLock(sha, async () => 'ran', { stateDir }), 'ran');
  } finally {
    fs.statSync = realStat;
  }
});

const exportError = (r, opts = {}) => {
  try {
    withPath(r.bin, () => exportCommit({ root: r.repo, out: r.out, ...opts }));
  } catch (err) {
    return err.message;
  }
  return assert.fail('expected the export to stop');
};
const recommit = (r, manifest) => {
  fs.writeFileSync(path.join(r.repo, 'release/public-manifest.yaml'), manifest);
  r.git(['add', '-A']);
  r.git(['commit', '-qm', 'manifest']);
};

test('7.1: a manifest that includes docs/handoffs/** fails the export and names the never-public category — even with no never list of its own', () => {
  const r = fixtureRepo();
  // The fixture's own `never` list no longer names the handoffs: the built-in category still does.
  recommit(r, 'include:\n  - src/**\n  - docs/handoffs/**\nnever:\n  - release/**\n');
  assert.match(exportError(r), /release\/public-manifest\.yaml includes never-public paths[\s\S]*include "docs\/handoffs\/\*\*" is in the never-public category docs\/handoffs\/\*\*/);
  assert.ok(!fs.existsSync(path.join(r.out, 'src')), 'nothing is written');
  assert.ok(NEVER_PUBLIC.includes('docs/handoffs/**'));
});

test('7.1: includes naming never-public content in other ways fail too; a broad directory include only drops it', () => {
  const m = (include) => ({ include, never: [] });
  assert.match(neverPublicIncludes(m(['openspec/changes/p07/**'])).join(), /never-public category openspec\/changes\/\*\*/);
  assert.match(neverPublicIncludes(m(['release/private-terms.txt'])).join(), /never-public category release\/private-terms\.txt/);
  assert.match(neverPublicIncludes(m(['release/private-releases.jsonl'])).join(), /never-public category/);
  assert.match(neverPublicIncludes(m(['docker/.env*'])).join(), /names environment files/);
  // A wildcard segment spanning a never-public directory is caught against the commit's files.
  assert.match(neverPublicIncludes(m(['docs/*/**']), ['docs/handoffs/a.md']).join(), /include "docs\/\*\/\*\*" matches docs\/handoffs\/a\.md/);
  assert.match(neverPublicIncludes(m(['apps/*/.env.local']), ['apps/cms/.env.local']).join(), /matches apps\/cms\/\.env\.local, in the never-public category environment files/);
  // `<dir>/**` spanning never paths is the whitelist working: those paths are dropped, not an error.
  assert.deepEqual(neverPublicIncludes(m(['release/**', 'docs/**', '**', '.env.example', 'docker/.env.example']), ['release/private-terms.txt', 'docs/handoffs/a.md', 'docker/.env']), []);
  const { exported } = selectPaths(['release/private-terms.txt', 'release/private-releases.jsonl', 'release/RELEASES.md', 'docs/decisions/a.md', 'docs/en/a.md'], m(['release/**', 'docs/**']));
  assert.deepEqual(exported, ['release/RELEASES.md', 'docs/en/a.md']);
});

const hasGitleaks = !spawnSync('gitleaks', ['version']).error;

test(
  '7.2: with gitleaks itself, an example secret and a private domain are found and reported by file and line only',
  { skip: hasGitleaks ? false : 'gitleaks is not installed: the real secret scan is NOT completed here (without it the export stops, see the scanner test)' },
  () => {
    const term = 'ops-farm.example.com'; // invented: never the real private list
    const r = fixtureRepo({ term });
    // Built at run time, so this file holds no secret-shaped literal; random-looking, as a real token is.
    const token = `ghp_${createHash('sha256').update('heopress fixture').digest('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 36)}`;
    fs.writeFileSync(path.join(r.repo, 'src/config.ts'), `export const region = 'eu';\nexport const token = '${token}';\nexport const origin = 'https://${term}/';\n`);
    r.git(['add', '-A']);
    r.git(['commit', '-qm', 'secret and domain']);
    // The real scanner: no stub on PATH.
    let message = '';
    try {
      exportCommit({ root: r.repo, out: r.out });
    } catch (err) {
      message = err.message;
    }
    assert.match(message, /private terms in the export:\n {2}src\/config\.ts:3 \(term #1\)/);
    assert.match(message, /gitleaks findings not reviewed[\s\S]*src\/config\.ts:2 github-pat \(review id [0-9a-f]{64}\)/);
    assert.ok(!message.includes(token) && !message.includes(token.slice(4, 20)), 'the secret is not repeated');
    assert.ok(!message.includes(term), 'the private term is not repeated');
  },
);

test('7.2: a gitleaks configuration or ignore file in the tree stops the export (it could silence the scan)', () => {
  for (const name of ['src/.gitleaksignore', 'src/.gitleaks.toml']) {
    const r = fixtureRepo();
    fs.writeFileSync(path.join(r.repo, name), 'x\n');
    r.git(['add', '-A']);
    r.git(['commit', '-qm', 'scanner config']);
    assert.match(exportError(r), /scanner configuration in the tree[\s\S]*src\/\.gitleaks/);
  }
});

test('7.6: unsafe path names and hard links are refused', () => {
  assert.deepEqual(unsafePaths(['a/b.ts', '/etc/x', 'a/../b', 'a/./b', 'a//b', 'x/.git/config', 'x/.GIT/HEAD', 'a\\b', 'a\u0001b', '.github/x', '.gitignore']), [
    '/etc/x',
    'a/../b',
    'a/./b',
    'a//b',
    'x/.git/config',
    'x/.GIT/HEAD',
    'a\\b',
    'a\u0001b',
  ]);
  const dir = tempDir('hard-');
  fs.writeFileSync(path.join(dir, 'a'), 'x');
  fs.writeFileSync(path.join(dir, 'b'), 'y');
  fs.linkSync(path.join(dir, 'a'), path.join(tempDir('hard-out-'), 'a'));
  assert.deepEqual(hardLinks(dir, ['a', 'b']), ['a']);
});

test('7.6: environment files never leave, but .env.example at the root and in docker/', () => {
  const r = fixtureRepo();
  for (const f of ['.env.example', 'docker/.env.example', '.env', 'docker/.env', 'docker/.env.production', 'src/.envrc', '.env.local']) {
    fs.mkdirSync(path.dirname(path.join(r.repo, f)), { recursive: true });
    fs.writeFileSync(path.join(r.repo, f), 'KEY=value\n');
  }
  recommit(r, 'include:\n  - src/**\n  - docker/**\n  - .env.example\nnever:\n  - release/**\n');
  const { exported } = withPath(r.bin, () => exportCommit({ root: r.repo, out: r.out }));
  assert.deepEqual(exported.sort(), ['.env.example', 'docker/.env.example', 'src/a.ts']);
  // Named by the manifest, an environment file is a manifest error.
  const named = fixtureRepo();
  recommit(named, 'include:\n  - src/**\n  - .env.local\nnever:\n  - release/**\n');
  assert.match(exportError(named), /include "\.env\.local" names environment files/);
});

test('7.7: a release export without every final licence file stops; the CI mirror export does not require them', () => {
  const withLicences = () => {
    const r = fixtureRepo();
    fs.mkdirSync(path.join(r.repo, 'LICENSES'), { recursive: true });
    for (const f of LICENSE_FILES) fs.writeFileSync(path.join(r.repo, f), `${f}: final text\n`);
    recommit(r, `include:\n  - src/**\n${LICENSE_FILES.map((f) => `  - ${f}\n`).join('')}never:\n  - release/**\n`);
    return r;
  };
  const complete = withLicences();
  assert.equal(withPath(complete.bin, () => exportCommit({ root: complete.repo, out: complete.out, requireLicenses: true })).files, 1 + LICENSE_FILES.length);
  for (const f of LICENSE_FILES) {
    const r = withLicences();
    fs.rmSync(path.join(r.repo, f));
    r.git(['commit', '-qam', `drop ${f}`]);
    assert.match(exportError(r, { requireLicenses: true }), new RegExp(`licence files a release must carry[\\s\\S]*${f.replace(/[.]/g, '\\.')} \\(missing\\)`), f);
    // The CI mirror exports it all the same.
    assert.ok(withPath(r.bin, () => exportCommit({ root: r.repo, out: path.join(tempDir('ci-'), 'out') })).files > 0);
  }
  // The exception draft (or any licence marked as a draft) counts as missing.
  const draft = withLicences();
  fs.writeFileSync(path.join(draft.repo, 'LICENSE-EXCEPTION.md'), EXCEPTION_DRAFT);
  fs.writeFileSync(path.join(draft.repo, 'CLA.md'), '<!-- release: draft -->\n# CLA\n');
  draft.git(['commit', '-qam', 'drafts']);
  const message = exportError(draft, { requireLicenses: true });
  assert.match(message, /LICENSE-EXCEPTION\.md \(a draft/);
  assert.match(message, /CLA\.md \(a draft/);
  // The rule: a final text carries no draft marker anywhere — the title, a status block, a note in the body.
  for (const draftText of [
    '# 草案\n',
    '# Final\n\nthis draft was reviewed\n',
    '# CLA\n\n> Status: draft, pending legal review.\n',
    '# CLA\n\nPending legal review.\n',
    '# CLA\n\nStatus: pending outside counsel review\n',
    '# CLA\n\nStatus: pending final legal review\n',
    '# CLA\n\nAwaiting review by the maintainer.\n',
    '# CLA\n\nawaiting final counsel review\n',
    '# CLA\n\nThis text is under review.\n',
    '# CLA\n\nUnder legal review.\n',
    '# CLA\n\nNot final.\n',
    '# CLA\n\nThis version is not yet final.\n',
    '# CLA\n\nStatus: not finalized; pending signature\n',
    '# CLA\n\nThis text is not yet finalised.\n',
    '# CLA\n\nStatus: under final independent external counsel review\n',
    '# 说明\n\n本文件待公司法务与外部律师共同审阅后定稿。\n',
    '# 说明\n\n正在审核中。\n',
    '# 说明\n\n未经外部律师与公司法务的联合审核。\n',
    '# CLA\n\nStatus: for external counsel review\n',
    '# CLA\n\nStatus: pending signature\n',
    '# CLA\n\nThis agreement is subject to final review by counsel.\n',
    '# CLA\n\nSubject to approval by the maintainer.\n',
    '# CLA\n\nTo be reviewed before publication.\n',
    '# CLA\n\nUnsigned draft.\n',
    '# 说明\n\n未经法律审阅。\n',
    '# 说明\n\n本文件未定稿。\n',
    '<!-- release: draft -->\n# X\n',
  ]) {
    assert.ok(isDraftText(draftText), draftText);
  }
  assert.ok(!isDraftText('# HeoPress Contributor License Agreement\n\nYou grant us a licence.\n'));
  // "pending" and "review" on different lines are not a status.
  assert.ok(!isDraftText('# Terms\n\nPatent claims pending.\n\nWe review contributions.\n'));
  // The real drafts stay drafts even with their first-line marker removed (the status block still says so) — while
  // they are drafts, in the private repository (the public mirror leaves them out; a final text has no marker at all).
  for (const f of ['CLA.md', 'COMMERCIAL-LICENSE.md']) {
    const file = path.join(ROOT, f);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    if (!text.includes('<!-- release: draft -->')) continue;
    assert.ok(isDraftText(text.replace('<!-- release: draft -->\n', '')), f);
  }
  // The real licence texts that are final are not taken for drafts.
  for (const f of ['LICENSE', 'NOTICE', 'LICENSES/Apache-2.0.txt']) assert.ok(!isDraftText(fs.readFileSync(path.join(ROOT, f), 'utf8')), f);
});

/** A fixture exporting `src/**`, `release/**` and `apps/**`, with `files` (path → content) committed. */
const repoWith = (files) => {
  const r = fixtureRepo();
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(r.repo, f)), { recursive: true });
    fs.writeFileSync(path.join(r.repo, f), text);
  }
  recommit(r, 'include:\n  - src/**\n  - release/**\n  - apps/**\n  - docs/**\nnever:\n  - docs/handoffs/**\n');
  return r;
};

test('P1: a case, Unicode or trailing-dot variant of a never-public, environment or scanner file name fails the export', () => {
  const cases = {
    'release/PRIVATE-RELEASES.JSONL': /release\/PRIVATE-RELEASES\.JSONL \(a case or spelling variant of the never-public release\/private-releases\.jsonl\)/,
    'apps/.ENV.production': /apps\/\.ENV\.production \(a variant of an environment file name\)/,
    'apps/.GITLEAKS.TOML': /apps\/\.GITLEAKS\.TOML \(a variant of a scanner configuration file name\)/,
    'apps/.TRIVYIGNORE': /apps\/\.TRIVYIGNORE \(a variant of a scanner configuration file name\)/,
    'docs/Handoffs/h2.md': /docs\/Handoffs\/h2\.md \(a case or spelling variant of the never-public docs\/handoffs\/\*\*\)/,
    'docs/handoffs./h3.md': /docs\/handoffs\.\/h3\.md \(a case or spelling variant/,
    'release/ｐrivate-terms.txt': /release\/ｐrivate-terms\.txt \(a case or spelling variant of the never-public release\/private-terms\.txt\)/,
    'apps/.env.': /apps\/\.env\. \(a variant of an environment file name\)/,
  };
  for (const [file, expected] of Object.entries(cases)) {
    const r = repoWith({ [file]: 'x\n' });
    const message = exportError(r);
    assert.match(message, /names that are a variant of never-public, environment or scanner files/, file);
    assert.match(message, expected, file);
    assert.ok(!fs.existsSync(path.join(r.out, 'src')), `nothing is written (${file})`);
  }
  // The comparison folds case, Unicode compatibility forms and trailing dots and spaces; selection does too.
  assert.equal(foldPath('Release/ＰＲＩＶＡＴＥ-terms.TXT. '), 'release/private-terms.txt');
  assert.ok(isEnvFile('apps/.ENV') && isEnvFile('apps/.Env.Local') && !isEnvFile('docker/.env.example'));
  assert.deepEqual(selectPaths(['release/PRIVATE-RELEASES.JSONL', 'apps/.ENV.production', 'release/RELEASES.md'], { include: ['release/**', 'apps/**'], never: [] }).exported, ['release/RELEASES.md']);
  // The exact lower-case names are the usual case: dropped quietly, as before.
  const usual = repoWith({ 'apps/.env': 'KEY=1\n', 'release/private-notes.json': '{}\n', 'apps/ok.ts': 'export {};\n' });
  const { exported } = withPath(usual.bin, () => exportCommit({ root: usual.repo, out: usual.out }));
  assert.deepEqual(exported.sort(), ['apps/ok.ts', 'release/public-manifest.yaml', 'src/a.ts']);
});

test('P1: the legal drafts never leave — not through a broad include, on the CI mirror path or the release path; naming legal/ is an error', () => {
  const r = fixtureRepo();
  fs.mkdirSync(path.join(r.repo, 'legal'), { recursive: true });
  fs.writeFileSync(path.join(r.repo, 'legal/PLUGIN-AND-THEME-EXCEPTION.md'), EXCEPTION_DRAFT);
  fs.mkdirSync(path.join(r.repo, 'LICENSES'), { recursive: true });
  for (const f of LICENSE_FILES) fs.writeFileSync(path.join(r.repo, f), `${f}: final text\n`);
  recommit(r, 'include:\n  - "**"\nnever:\n  - docs/handoffs/**\n');
  const mirror = withPath(r.bin, () => exportCommit({ root: r.repo, out: r.out }));
  assert.ok(!mirror.exported.some((f) => f.startsWith('legal/')), mirror.exported.join(', '));
  const release = withPath(r.bin, () => exportCommit({ root: r.repo, out: path.join(tempDir('rel-'), 'out'), requireLicenses: true }));
  assert.ok(!release.exported.some((f) => f.startsWith('legal/')));
  assert.ok(release.exported.includes('LICENSE-EXCEPTION.md'));
  assert.ok(NEVER_PUBLIC.includes('legal/**'));
  const named = fixtureRepo();
  recommit(named, 'include:\n  - src/**\n  - legal/**\nnever:\n  - release/**\n');
  assert.match(exportError(named), /include "legal\/\*\*" is in the never-public category legal\/\*\*/);
});

test('P2: a gitleaks that exits 0 and writes [] but reports no scanned bytes is a scan NOT completed', () => {
  const r = fixtureRepo({ scanned: false });
  assert.match(exportError(r), /gitleaks did not report scanning anything: the secret scan is NOT completed/);
});

test('P3: paths holding tabs are parsed whole and refused as unsafe; private-term hits in paths and link targets are redacted', () => {
  assert.deepEqual(parseLsTree('100644 blob aaa\tsrc/a\tb.ts\u0000120000 blob bbb\tsrc/l\u0000'), [
    { mode: '100644', type: 'blob', object: 'aaa', file: 'src/a\tb.ts' },
    { mode: '120000', type: 'blob', object: 'bbb', file: 'src/l' },
  ]);
  const tabbed = fixtureRepo();
  fs.writeFileSync(path.join(tabbed.repo, 'src/a\tb.ts'), 'export {};\n');
  tabbed.git(['add', '-A']);
  tabbed.git(['commit', '-qm', 'tab']);
  assert.match(exportError(tabbed), /unsafe path names:\n {2}"src\/a\\tb\.ts"/);
  assert.ok(!fs.existsSync(path.join(tabbed.out, 'src')), 'nothing is checked out');

  const term = 'ops-farm.example.com'; // invented
  const named = fixtureRepo({ term });
  fs.writeFileSync(path.join(named.repo, `src/${term}.md`), 'nothing here\n');
  fs.symlinkSync(`../../${term}/x`, path.join(named.repo, 'src/out'));
  named.git(['add', '-A']);
  named.git(['commit', '-qm', 'term in names']);
  const message = exportError(named);
  assert.match(message, /symbolic links leaving the export:\n {2}src\/out -> \.\.\/\.\.\/\[term #1\]\/x/);
  assert.ok(!message.toLowerCase().includes(term), message);
  // Without the link, the path hit itself is redacted.
  fs.rmSync(path.join(named.repo, 'src/out'));
  named.git(['add', '-A']);
  named.git(['commit', '-qm', 'no link']);
  const pathHit = exportError({ ...named, out: path.join(tempDir('redact-'), 'out') });
  assert.match(pathHit, /src\/\[term #1\]\.md \(path, term #1\)/);
  assert.ok(!pathHit.toLowerCase().includes(term), pathHit);
});

test('P2: the CI mirror leaves out licence texts that are still drafts, and publishes them once final; a release refuses drafts', () => {
  const r = fixtureRepo();
  fs.writeFileSync(path.join(r.repo, 'CLA.md'), '<!-- release: draft -->\n# CLA\n\n> Status: draft, pending legal review.\n');
  fs.writeFileSync(path.join(r.repo, 'COMMERCIAL-LICENSE.md'), '# Commercial License\n\nStatus: pending outside counsel review\n');
  fs.writeFileSync(path.join(r.repo, 'NOTICE'), 'HeoPress\nCopyright the HeoPress authors.\n');
  recommit(r, 'include:\n  - src/**\n  - CLA.md\n  - COMMERCIAL-LICENSE.md\n  - NOTICE\nnever:\n  - release/**\n');
  const mirror = withPath(r.bin, () => exportCommit({ root: r.repo, out: r.out }));
  assert.deepEqual(mirror.draftLicences.sort(), ['CLA.md', 'COMMERCIAL-LICENSE.md']);
  assert.deepEqual(mirror.exported.sort(), ['NOTICE', 'src/a.ts']);
  assert.ok(!fs.existsSync(path.join(r.out, 'CLA.md')) && !fs.existsSync(path.join(r.out, 'COMMERCIAL-LICENSE.md')), 'never written');
  assert.deepEqual(mirror.entries.map((e) => e.file).sort(), ['NOTICE', 'src/a.ts']);
  // Final, the CLA is published.
  fs.writeFileSync(path.join(r.repo, 'CLA.md'), '# HeoPress Contributor License Agreement\n\nYou grant us a licence.\n');
  r.git(['commit', '-qam', 'final CLA']);
  const final = withPath(r.bin, () => exportCommit({ root: r.repo, out: path.join(tempDir('mirror-final-'), 'out') }));
  assert.ok(final.exported.includes('CLA.md'));
  assert.deepEqual(final.draftLicences, ['COMMERCIAL-LICENSE.md']);
  // A release never leaves a draft out silently: it stops.
  assert.match(exportError({ ...r, out: path.join(tempDir('rel-'), 'out') }, { requireLicenses: true }), /COMMERCIAL-LICENSE\.md \(a draft/);
});

test('P3: private release records at any depth under release/ are never public; a case variant of one fails', () => {
  const { exported } = selectPaths(
    ['release/archive/private-releases.jsonl', 'release/a/b/Private-Notes.md', 'release/archive/private/x.json', 'release/archive/RELEASES-2026.md'],
    { include: ['release/**'], never: [] },
  );
  assert.deepEqual(exported, ['release/archive/RELEASES-2026.md']);
  const nested = repoWith({ 'release/archive/private-releases.jsonl': '{}\n', 'release/archive/notes.md': 'public\n' });
  const result = withPath(nested.bin, () => exportCommit({ root: nested.repo, out: nested.out }));
  assert.ok(!result.exported.includes('release/archive/private-releases.jsonl'));
  assert.ok(result.exported.includes('release/archive/notes.md'));
  const variant = repoWith({ 'release/archive/PRIVATE-RELEASES.JSONL': '{}\n' });
  assert.match(exportError(variant), /release\/archive\/PRIVATE-RELEASES\.JSONL \(a case or spelling variant of the never-public release\/\*\*\/private\*\)/);
});

test('P2: every licence-like file is published only final — LICENSES/**, root LICENSE*/COPYING*/CLA*/COMMERCIAL*, and links to them', () => {
  for (const f of ['LICENSES/PLUGIN-AND-THEME-EXCEPTION.md', 'LICENSES/x/y.txt', 'licenses/Other.md', 'COPYING', 'Copying.txt', 'CLA-corporate.md', 'COMMERCIAL-TERMS.md', 'LICENSE-EXCEPTION.md', 'Licence.md', 'NOTICE']) {
    assert.ok(isLicenceLike(f), f);
  }
  for (const f of ['LICENSES/HEOPRESS-MODIFIED-FILES.txt', 'CLAUDE.md', 'src/cla.ts', 'README.md', 'license-policy.json', 'apps/studio/src/lib/session/claims.ts', 'docs/notices.md', 'src/license.ts']) {
    assert.ok(!isLicenceLike(f), f);
  }

  const r = fixtureRepo();
  const put = (f, text) => {
    fs.mkdirSync(path.dirname(path.join(r.repo, f)), { recursive: true });
    fs.writeFileSync(path.join(r.repo, f), text);
  };
  // The exception draft committed under LICENSES/, a root link to it, a draft COPYING; a final licence; the
  // generated list of modified files naming a source file called draft.ts (a list, not a legal text).
  put('LICENSES/PLUGIN-AND-THEME-EXCEPTION.md', EXCEPTION_DRAFT);
  fs.symlinkSync('LICENSES/PLUGIN-AND-THEME-EXCEPTION.md', path.join(r.repo, 'LICENSE-EXCEPTION.md'));
  put('COPYING', 'Status: not finalized; pending signature\n');
  put('LICENSES/Apache-2.0.txt', 'Apache License, Version 2.0\n');
  put('LICENSES/HEOPRESS-MODIFIED-FILES.txt', '# modified upstream files\nsrc/a.ts\nsrc/draft.ts\n');
  recommit(r, 'include:\n  - src/**\n  - LICENSES/**\n  - COPYING\n  - LICENSE-EXCEPTION.md\nnever:\n  - release/**\n');
  const mirror = withPath(r.bin, () => exportCommit({ root: r.repo, out: r.out }));
  assert.deepEqual(mirror.draftLicences.sort(), ['COPYING', 'LICENSE-EXCEPTION.md', 'LICENSES/PLUGIN-AND-THEME-EXCEPTION.md']);
  assert.deepEqual(mirror.exported.sort(), ['LICENSES/Apache-2.0.txt', 'LICENSES/HEOPRESS-MODIFIED-FILES.txt', 'src/a.ts']);
  for (const f of mirror.draftLicences) assert.ok(!fs.existsSync(path.join(r.out, f)) && !isLinkAt(path.join(r.out, f)), `${f} never written`);
  // A release refuses them, the link included.
  const message = exportError({ ...r, out: path.join(tempDir('rel-'), 'out') }, { requireLicenses: true });
  assert.match(message, /licence texts that are still drafts \(a release publishes final texts only\):/);
  for (const f of ['COPYING', 'LICENSE-EXCEPTION.md', 'LICENSES/PLUGIN-AND-THEME-EXCEPTION.md']) assert.ok(message.includes(`  ${f}`), `${f}: ${message}`);
  assert.ok(!message.includes('HEOPRESS-MODIFIED-FILES'), message);
});

function isLinkAt(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

test('P2: licence files at any depth (packages/sdk/LICENSE, NOTICE, COPYING, CLA, COMMERCIAL-LICENSE) are published only final', () => {
  for (const f of ['packages/sdk/LICENSE', 'packages/sdk/NOTICE', 'examples/plugin-template/LICENSE', 'packages/x/COPYING.txt', 'packages/x/LICENSE-MIT', 'apps/x/CLA.md', 'apps/x/COMMERCIAL-LICENSE.md', 'docs/LICENSE.md']) {
    assert.ok(isLicenceLike(f), f);
  }
  const r = fixtureRepo();
  const put = (f, text) => {
    fs.mkdirSync(path.dirname(path.join(r.repo, f)), { recursive: true });
    fs.writeFileSync(path.join(r.repo, f), text);
  };
  put('packages/sdk/LICENSE', 'Apache License, Version 2.0\n\nStatus: pending outside counsel review\n');
  put('packages/sdk/NOTICE', 'HeoPress SDK\nCopyright the HeoPress authors.\n');
  put('packages/sdk/src/index.ts', 'export const draft = 1;\n');
  recommit(r, 'include:\n  - src/**\n  - packages/**\nnever:\n  - release/**\n');
  const mirror = withPath(r.bin, () => exportCommit({ root: r.repo, out: r.out }));
  assert.deepEqual(mirror.draftLicences, ['packages/sdk/LICENSE']);
  assert.deepEqual(mirror.exported.sort(), ['packages/sdk/NOTICE', 'packages/sdk/src/index.ts', 'src/a.ts']);
  assert.match(exportError({ ...r, out: path.join(tempDir('rel-'), 'out') }, { requireLicenses: true }), /licence texts that are still drafts[\s\S]*packages\/sdk\/LICENSE/);
});

test('P2: the real licence texts at any depth are final but the two known drafts (the Apache texts and notices are not flagged)', () => {
  const files = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  const licenceLike = files.filter((f) => isLicenceLike(f) && fs.existsSync(path.join(ROOT, f)));
  const drafts = licenceLike.filter((f) => isDraftText(fs.readFileSync(path.join(ROOT, f), 'utf8')));
  for (const f of drafts) assert.ok(['CLA.md', 'COMMERCIAL-LICENSE.md'].includes(f), `${f} is taken for a draft`);
  for (const f of ['packages/sdk/LICENSE', 'packages/extension-sdk/LICENSE', 'packages/contracts/LICENSE']) {
    if (files.includes(f)) assert.ok(licenceLike.includes(f) && !drafts.includes(f), f);
  }
});
