import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  NPM_REGISTRY,
  ScannerConfigInTree,
  gitleaksScan,
  gitleaksScannedBytes,
  runAudit,
  runGitleaks,
  runTrivy,
  scannerConfigFiles,
  scannerEnv,
  withoutAuditIgnores,
  workspaceWithoutAuditIgnores,
} from '../security-scanners.mjs';

/**
 * P07 task 8.1: the scanned tree cannot configure (and so silence) the scan of itself. Scanner configuration files in
 * the tree fail the scan; the scanners run with configuration from outside the tree and without the environment
 * variables that configure them. Stub scanners record how they were started; the real gitleaks runs when installed.
 */
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const script = path.join(repo, 'scripts/security-scanners.mjs');
const made = [];
after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});
const tempDir = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
};

/** A tree to scan: some source, optionally scanner configuration files. */
function tree(files = {}) {
  const dir = tempDir('heopress-scan-tree-');
  for (const [rel, text] of Object.entries({ 'src/a.ts': 'export const a = 1;\n', ...files })) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

/** A stub scanner: records argv, cwd, the files it was pointed at and the environment, then behaves as `body` says. */
function stub(body) {
  const dir = tempDir('heopress-scan-stub-');
  const log = path.join(dir, 'log.json');
  const bin = path.join(dir, 'scanner');
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
const at = (f) => (a.includes(f) ? a[a.indexOf(f) + 1] : undefined);
const read = (f) => (f && fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);
fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({ args: a, cwd: process.cwd(), env: process.env,
  config: read(at('--config')), ignore: at('--ignorefile') ? read(at('--ignorefile')) : null,
  ignorePath: at('--gitleaks-ignore-path'), files: fs.readdirSync('.'),
  pkg: read('package.json') }));
${body}
`,
    { mode: 0o755 },
  );
  return { bin, log: () => JSON.parse(fs.readFileSync(log, 'utf8')) };
}

const inside = (dir, p) => path.resolve(p).startsWith(`${fs.realpathSync(dir)}${path.sep}`) || path.resolve(p).startsWith(`${dir}${path.sep}`);

test('scanner configuration files anywhere in the tree are found (but not under node_modules or .git)', () => {
  const dir = tree({
    '.gitleaks.toml': '',
    'docs/.gitleaksignore': '',
    'docker/.trivyignore': '',
    'trivy.yaml': '',
    'x/.trivyignore.yaml': '',
    'node_modules/pkg/.trivyignore': '',
    '.git/trivy.yaml': '',
  });
  assert.deepEqual(scannerConfigFiles(dir), ['.gitleaks.toml', 'docker/.trivyignore', 'docs/.gitleaksignore', 'trivy.yaml', 'x/.trivyignore.yaml']);
  assert.deepEqual(scannerConfigFiles(tree()), []);
});

test('the command fails (not completes, never passes) when the tree holds scanner configuration', () => {
  for (const [command, file] of [['gitleaks', '.gitleaksignore'], ['gitleaks', 'src/.gitleaks.toml'], ['trivy', '.trivyignore'], ['trivy', 'trivy.yaml'], ['audit', 'trivy.yml']]) {
    const dir = tree({ [file]: 'anything\n' });
    const output = path.join(tempDir('heopress-scan-out-'), 'github-output');
    const res = spawnSync(process.execPath, [script, command, '--dir', dir, '--report', path.join(dir, 'r.json'), '--image', 'x:scan', '--bin', '/nonexistent'], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: output },
    });
    assert.equal(res.status, 1, `${command} with ${file}`);
    assert.match(res.stderr, new RegExp(`scanner configuration in the tree[\\s\\S]*${file.replace(/\./g, '\\.')}`));
    assert.equal(fs.readFileSync(output, 'utf8'), 'status=failed\n');
  }
});

test('gitleaks runs with a configuration and an empty ignore directory from outside the tree, and without GITLEAKS_*', () => {
  const dir = tree();
  const s = stub(`fs.writeFileSync(at('--report-path'), '[]'); console.error('INF scanned ~1234 bytes (1.2 KB) in 3ms');`);
  const report = path.join(tempDir('heopress-scan-out-'), 'gitleaks.json');
  const prev = { ...process.env };
  process.env.GITLEAKS_CONFIG = path.join(dir, 'allow-all.toml');
  process.env.GITLEAKS_CONFIG_TOML = '[allowlist]\npaths = [".*"]';
  try {
    runGitleaks({ dir, report, bin: s.bin });
  } finally {
    for (const k of ['GITLEAKS_CONFIG', 'GITLEAKS_CONFIG_TOML']) if (prev[k] === undefined) delete process.env[k];
  }
  const seen = s.log();
  assert.equal(fs.realpathSync(seen.cwd), fs.realpathSync(dir));
  for (const flag of ['--ignore-gitleaks-allow', '--redact', '--no-banner']) assert.ok(seen.args.includes(flag), flag);
  assert.equal(seen.config, '[extend]\nuseDefault = true\n');
  assert.ok(!inside(dir, seen.args[seen.args.indexOf('--config') + 1]), 'the configuration is outside the tree');
  assert.ok(!inside(dir, seen.ignorePath), 'the ignore directory is outside the tree');
  assert.equal(seen.env.GITLEAKS_CONFIG, undefined);
  assert.equal(seen.env.GITLEAKS_CONFIG_TOML, undefined);
  assert.equal(fs.readFileSync(report, 'utf8'), '[]');
});

test('gitleaks that fails, writes no report or scans nothing is not completed', () => {
  const dir = tree();
  const report = path.join(tempDir('heopress-scan-out-'), 'gitleaks.json');
  assert.throws(() => runGitleaks({ dir, report, bin: stub('process.exit(1);').bin }), /gitleaks failed \(exit 1\)/);
  assert.throws(() => runGitleaks({ dir, report, bin: stub(`fs.writeFileSync(at('--report-path'), '[]');`).bin }), /did not report scanning anything/);
  assert.throws(() => runGitleaks({ dir, report, bin: stub(`fs.writeFileSync(at('--report-path'), '[]'); console.error('scanned ~0 bytes');`).bin }), /did not report scanning anything/);
  assert.throws(() => runGitleaks({ dir, report, bin: path.join(dir, 'no-such-gitleaks') }), /did not run/);
  assert.equal(gitleaksScannedBytes('\u001b[90m12:02AM\u001b[0m \u001b[32mINF\u001b[0m \u001b[1mscanned ~66205165 bytes (66.21 MB) in 4.53s\u001b[0m'), 66205165);
});

const hasGitleaks = !spawnSync('gitleaks', ['version']).error;

test(
  'with gitleaks itself: a .gitleaks.toml allowing everything and GITLEAKS_CONFIG do not silence a secret; a .gitleaksignore would, so it is refused',
  { skip: hasGitleaks ? false : 'gitleaks is not installed: the real scan is NOT run here (CI installs it)' },
  () => {
    // Built at run time, so this file holds no secret-shaped literal.
    const token = `ghp_${createHash('sha256').update('heopress fixture').digest('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 36)}`;
    const allowAll = '[extend]\nuseDefault = true\n[allowlist]\npaths = [\'\'\'.*\'\'\']\nregexes = [\'\'\'.*\'\'\']\n';
    const dir = tree({ 'src/config.ts': `export const region = 'eu';\nexport const token = '${token}';\n`, '.gitleaks.toml': allowAll });
    const report = path.join(tempDir('heopress-scan-out-'), 'gitleaks.json');
    const found = () => JSON.parse(fs.readFileSync(report, 'utf8')).map((f) => [f.File.replace(/^\.\//, ''), f.RuleID, f.StartLine]);
    const prev = process.env.GITLEAKS_CONFIG;
    process.env.GITLEAKS_CONFIG = path.join(dir, '.gitleaks.toml');
    try {
      // The trusted invocation itself, without the refusal in front of it: the tree's configuration has no effect.
      gitleaksScan({ dir, report });
      assert.deepEqual(found(), [['src/config.ts', 'github-pat', 2]]);
      assert.ok(!fs.readFileSync(report, 'utf8').includes(token), 'the report is redacted');
      // gitleaks reads <scanned dir>/.gitleaksignore whatever --gitleaks-ignore-path says: it would silence the finding …
      fs.writeFileSync(path.join(dir, '.gitleaksignore'), 'src/config.ts:github-pat:2\n');
      gitleaksScan({ dir, report });
      assert.deepEqual(found(), []);
      // … so the scan refuses a tree holding one (or any scanner configuration) before running.
      assert.throws(() => runGitleaks({ dir, report }), (err) => err instanceof ScannerConfigInTree && /\.gitleaks\.toml/.test(err.message) && /\.gitleaksignore/.test(err.message));
    } finally {
      if (prev === undefined) delete process.env.GITLEAKS_CONFIG;
      else process.env.GITLEAKS_CONFIG = prev;
    }
  },
);

test('Trivy runs in a directory of its own with an empty configuration and ignore file from outside the tree, without TRIVY_*', () => {
  const dir = tree({ 'trivy.yaml': 'severity: [LOW]\n', '.trivyignore': 'CVE-2026-0001\n' });
  const s = stub(`fs.writeFileSync(at('--output'), '{}');`);
  const report = path.join(tempDir('heopress-scan-out-'), 'trivy.json');
  process.env.TRIVY_IGNOREFILE = path.join(dir, '.trivyignore');
  try {
    runTrivy({ image: 'heopress-cms:scan', report, bin: s.bin });
    // With the checkout given, its scanner configuration is refused before Trivy runs.
    assert.throws(() => runTrivy({ dir, image: 'heopress-cms:scan', report, bin: s.bin }), ScannerConfigInTree);
  } finally {
    delete process.env.TRIVY_IGNOREFILE;
  }
  const seen = s.log();
  assert.ok(!inside(dir, seen.cwd) && path.resolve(seen.cwd) !== path.resolve(dir), 'not run in the tree');
  assert.deepEqual(seen.files, [], 'its working directory holds no trivy.yaml or .trivyignore');
  assert.equal(seen.config, '{}\n');
  assert.equal(seen.ignore, '');
  assert.equal(seen.env.TRIVY_IGNOREFILE, undefined);
  assert.deepEqual(seen.args.slice(-1), ['heopress-cms:scan']);
  assert.ok(!seen.args.includes('--ignore-unfixed'), 'vulnerabilities without a fix are reported too');
  assert.deepEqual(seen.args.slice(seen.args.indexOf('--severity'), seen.args.indexOf('--severity') + 2), ['--severity', 'HIGH,CRITICAL']);
  assert.throws(() => runTrivy({ image: 'x', report, bin: stub('process.exit(1);').bin }), /Trivy failed \(exit 1\)/);
  assert.throws(() => runTrivy({ image: 'x', report, bin: stub('').bin }), /wrote no report/);
});

test('pnpm audit runs on the lockfile alone: no project audit ignores, no .npmrc, the public registry, no npm_config_*', () => {
  const dir = tree({
    'package.json': JSON.stringify({ name: 'x', pnpm: { overrides: { a: '1' }, auditConfig: { ignoreGhsas: ['GHSA-1'], ignoreCves: ['CVE-1'] } } }),
    'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
    'pnpm-workspace.yaml': 'packages:\n  - "apps/*"\n\nauditConfig:\n  ignoreGhsas:\n    - "GHSA-1"\n  ignoreCves:\n    - CVE-1\n',
    '.npmrc': 'registry=https://registry.example.com/\naudit-level=critical\n',
  });
  const s = stub(`process.stdout.write(JSON.stringify({ advisories: {}, metadata: { vulnerabilities: {}, totalDependencies: 1 } })); process.exit(1);`);
  const report = path.join(tempDir('heopress-scan-out-'), 'audit.json');
  process.env.npm_config_registry = 'https://registry.example.com/';
  try {
    runAudit({ dir, report, bin: s.bin });
  } finally {
    delete process.env.npm_config_registry;
  }
  const seen = s.log();
  assert.deepEqual(seen.files.sort(), ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']);
  assert.deepEqual(JSON.parse(seen.pkg).pnpm, { overrides: { a: '1' } });
  assert.ok(seen.args.includes(`--registry=${NPM_REGISTRY}`) && seen.args.includes('--audit-level=high') && seen.args.includes('--json'));
  assert.equal(seen.env.npm_config_registry, undefined);
  // A non-zero exit is not the verdict: the report is kept for the checker.
  assert.match(fs.readFileSync(report, 'utf8'), /totalDependencies/);
  assert.equal(workspaceWithoutAuditIgnores('packages:\n  - "apps/*"\n\nauditConfig:\n  ignoreGhsas:\n    - "GHSA-1"\n\noverrides:\n  a: 1\n'), 'packages:\n  - "apps/*"\n\noverrides:\n  a: 1\n');
  assert.deepEqual(JSON.parse(withoutAuditIgnores('{"pnpm":{"auditConfig":{"ignoreCves":["CVE-1"]}}}')), { pnpm: {} });
  assert.throws(() => runAudit({ dir: tree(), report, bin: s.bin }), /package\.json is missing/);
});

test('the scanner environment drops what configures gitleaks, Trivy and npm, and keeps the rest', () => {
  const env = scannerEnv({ PATH: '/bin', HOME: '/h', GITLEAKS_CONFIG: 'x', TRIVY_SEVERITY: 'LOW', npm_config_registry: 'r', NPM_CONFIG_AUDIT_LEVEL: 'c', PNPM_HOME: '/p' });
  assert.deepEqual(env, { PATH: '/bin', HOME: '/h', PNPM_HOME: '/p' });
});
