#!/usr/bin/env node
/**
 * The security scanners, run with configuration from outside the scanned tree (P07 task 8.1, ADR-0017 §5).
 *
 * A tree must not be able to configure the scan of itself: gitleaks reads `.gitleaks.toml` and `.gitleaksignore`
 * from the scanned directory (the latter whatever `--gitleaks-ignore-path` says) and `GITLEAKS_CONFIG*` from the
 * environment; Trivy reads `trivy.yaml` and `.trivyignore`
 * from its working directory and `TRIVY_*` from the environment; pnpm reads `.npmrc`, `npm_config_*` and the audit
 * ignores (`pnpm.auditConfig`) of the project. So:
 *
 * - a scanner configuration file anywhere in the tree (`SCANNER_CONFIG_FILES`) fails the scan, as it stops the
 *   public export;
 * - gitleaks runs with its default rules from a configuration file written outside the tree, an empty ignore
 *   directory and `--ignore-gitleaks-allow`; Trivy with an empty configuration file and an empty ignore file from
 *   outside the tree, in a directory of its own; both without any `GITLEAKS_*` / `TRIVY_*` variable;
 * - `pnpm audit` runs in a directory holding only the root `package.json`, `pnpm-lock.yaml` and
 *   `pnpm-workspace.yaml`, with every audit ignore removed (an advisory the project ignores is reported and needs
 *   an exception), against the public npm registry, without any `npm_config_*` variable.
 *
 * A scan that does not complete (the scanner cannot run, fails, or scans nothing) is "not completed", never a pass.
 *
 * Usage (the security workflow; scripts/check-security-scan.mjs then judges the report):
 *   node scripts/security-scanners.mjs audit    --dir <tree> --report <file>
 *   node scripts/security-scanners.mjs gitleaks --dir <tree> --report <file> [--bin <gitleaks>]
 *   node scripts/security-scanners.mjs trivy    --dir <tree> --image <ref> --report <file> [--bin <trivy>]
 * Exit status: 0 the report is written, 1 scanner configuration in the tree (failed), 2 not completed. With
 * GITHUB_OUTPUT set, a failure writes `status=<failed|not-completed>` to it.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { workspaceWithoutAuditIgnores } from './pnpm-audit-config.mjs';

export { workspaceWithoutAuditIgnores };

/** Files that configure a scanner from inside the scanned tree (they could silence it). */
export const SCANNER_CONFIG_FILES = new Set([
  '.gitleaks.toml',
  '.gitleaksignore',
  '.trivyignore',
  '.trivyignore.yaml',
  'trivy.yaml',
  'trivy.yml',
]);

/**
 * A scanner configuration file name, compared as a case-insensitive file system would see it (Unicode NFKC, lower
 * case, without trailing dots and spaces): `.GITLEAKS.TOML` or `.trivyignore.` is the same file elsewhere.
 */
export function isScannerConfigName(name) {
  return SCANNER_CONFIG_FILES.has(name.normalize('NFKC').toLowerCase().replace(/[. ]+$/, ''));
}

export const NPM_REGISTRY = 'https://registry.npmjs.org/';
/** The gitleaks configuration of every scan: its default rules, nothing from the tree. */
export const GITLEAKS_CONFIG = '[extend]\nuseDefault = true\n';

/** Scanner configuration files in `dir` (relative, `/`-separated), skipping `.git` and `node_modules`. */
export function scannerConfigFiles(dir) {
  const found = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (e.name !== '.git' && e.name !== 'node_modules') walk(r);
      } else if (isScannerConfigName(e.name)) found.push(r);
    }
  };
  walk('');
  return found.sort();
}

/** The environment of a scanner: without any variable that configures gitleaks, Trivy or npm / pnpm. */
export function scannerEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (/^(GITLEAKS_|TRIVY_|NPM_CONFIG_|PNPM_CONFIG_)/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/** gitleaks over the current directory with a configuration and an (empty) ignore directory from outside the tree. */
export function gitleaksArgs({ report, config, ignoreDir }) {
  return [
    'dir', '.', '--no-banner', '--redact', '--ignore-gitleaks-allow', '--exit-code', '0',
    '--config', config, '--gitleaks-ignore-path', ignoreDir, '--report-format', 'json', '--report-path', report,
  ];
}

/** Trivy over an image: high and critical vulnerabilities (fixed or not), configuration and ignore file from outside. */
export function trivyArgs({ image, report, config, ignoreFile }) {
  return [
    'image', '--scanners', 'vuln', '--severity', 'HIGH,CRITICAL', '--format', 'json', '--output', report,
    '--exit-code', '0', '--timeout', '15m', '--config', config, '--ignorefile', ignoreFile, image,
  ];
}

export function pnpmAuditArgs() {
  return ['audit', '--audit-level=high', '--json', `--registry=${NPM_REGISTRY}`];
}

/** `package.json` text without pnpm's audit ignores (`pnpm.auditConfig`). */
export function withoutAuditIgnores(pkgText) {
  const pkg = JSON.parse(pkgText);
  if (pkg.pnpm) delete pkg.pnpm.auditConfig;
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

/** The number of bytes gitleaks reports it scanned (its log line `scanned ~N bytes`), or null. */
export function gitleaksScannedBytes(log) {
  // eslint-disable-next-line no-control-regex
  const m = /scanned ~?(\d+) bytes/.exec(String(log).replace(/\u001b\[[0-9;]*m/g, ''));
  return m ? Number(m[1]) : null;
}

class NotCompleted extends Error {}

/** A scanner configuration file in the tree: the scan fails (it is not merely incomplete). */
export class ScannerConfigInTree extends Error {}

/**
 * Refuse a tree holding scanner configuration. This is the defence that matters for `.gitleaksignore`: gitleaks 8.30
 * reads `<scanned dir>/.gitleaksignore` whatever `--gitleaks-ignore-path` says.
 */
export function refuseScannerConfig(dir) {
  const found = scannerConfigFiles(dir);
  if (found.length) throw new ScannerConfigInTree(`scanner configuration in the tree (it could silence the scan; remove it):\n  ${found.join('\n  ')}`);
}

function scratch(fn) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'heopress-scan-'));
  try {
    return fn(work);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function spawn(bin, args, opts) {
  const run = spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: scannerEnv(), ...opts });
  if (run.error) throw new NotCompleted(`${path.basename(bin)} did not run (${run.error.message})`);
  return run;
}

/** Run gitleaks over `dir` into `report`: a tree holding scanner configuration is refused first. */
export function runGitleaks({ dir, report, bin = 'gitleaks' }) {
  refuseScannerConfig(dir);
  gitleaksScan({ dir, report, bin });
}

/** gitleaks over `dir` with the trusted configuration (no refusal of tree configuration: see runGitleaks). */
export function gitleaksScan({ dir, report, bin = 'gitleaks' }) {
  scratch((work) => {
    const config = path.join(work, 'gitleaks.toml');
    const ignoreDir = path.join(work, 'ignore');
    fs.mkdirSync(ignoreDir);
    fs.writeFileSync(config, GITLEAKS_CONFIG);
    const out = path.join(work, 'report.json');
    const run = spawn(bin, gitleaksArgs({ report: out, config, ignoreDir }), { cwd: dir });
    if (run.status !== 0) throw new NotCompleted(`gitleaks failed (exit ${run.status}):\n${run.stderr}`);
    const bytes = gitleaksScannedBytes(`${run.stdout}\n${run.stderr}`);
    if (!bytes) throw new NotCompleted('gitleaks did not report scanning anything');
    if (!fs.existsSync(out)) throw new NotCompleted('gitleaks wrote no report');
    fs.copyFileSync(out, report);
  });
}

/** Run Trivy over `image` into `report`, in a directory of its own; the checkout `dir` may hold no scanner configuration. */
export function runTrivy({ dir, image, report, bin = 'trivy' }) {
  if (dir) refuseScannerConfig(dir);
  scratch((work) => {
    const config = path.join(work, 'trivy.yaml');
    const ignoreFile = path.join(work, 'trivyignore');
    fs.writeFileSync(config, '{}\n');
    fs.writeFileSync(ignoreFile, '');
    const cwd = path.join(work, 'run');
    fs.mkdirSync(cwd);
    const out = path.join(work, 'report.json');
    const run = spawn(bin, trivyArgs({ image, report: out, config, ignoreFile }), { cwd });
    if (run.status !== 0) throw new NotCompleted(`Trivy failed (exit ${run.status}): the vulnerability database or the image was not available\n${run.stderr.split('\n').slice(-15).join('\n')}`);
    if (!fs.existsSync(out)) throw new NotCompleted('Trivy wrote no report');
    fs.copyFileSync(out, report);
  });
}

/** Run `pnpm audit` on the lockfile of `dir`, without the project's audit ignores or npm configuration. */
export function runAudit({ dir, report, bin = 'pnpm' }) {
  refuseScannerConfig(dir);
  scratch((work) => {
    for (const f of ['package.json', 'pnpm-lock.yaml']) {
      if (!fs.existsSync(path.join(dir, f))) throw new NotCompleted(`${f} is missing: nothing to audit`);
    }
    fs.writeFileSync(path.join(work, 'package.json'), withoutAuditIgnores(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')));
    fs.copyFileSync(path.join(dir, 'pnpm-lock.yaml'), path.join(work, 'pnpm-lock.yaml'));
    const ws = path.join(dir, 'pnpm-workspace.yaml');
    if (fs.existsSync(ws)) fs.writeFileSync(path.join(work, 'pnpm-workspace.yaml'), workspaceWithoutAuditIgnores(fs.readFileSync(ws, 'utf8')));
    // The exit status is not the verdict: non-zero for any finding (also below high) and for an unreachable
    // service alike. The report is; the checker treats anything but a complete one as not completed.
    const run = spawn(bin, pnpmAuditArgs(), { cwd: work });
    fs.writeFileSync(report, run.stdout);
  });
}

function main(argv) {
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const command = argv[0];
  const dir = path.resolve(arg('--dir') ?? '.');
  const report = arg('--report') ? path.resolve(arg('--report')) : undefined;
  const fail = (status, message) => {
    console.error(`[scan] ${command}: ${status}: ${message}`);
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `status=${status}\n`);
    process.exit(status === 'failed' ? 1 : 2);
  };
  if (!['audit', 'gitleaks', 'trivy'].includes(command) || !report || (command === 'trivy' && !arg('--image'))) {
    console.error('usage: security-scanners.mjs audit|gitleaks|trivy --dir <tree> --report <file> [--image <ref>] [--bin <scanner>]');
    process.exit(2);
  }
  try {
    if (command === 'audit') runAudit({ dir, report, bin: arg('--bin') });
    else if (command === 'gitleaks') runGitleaks({ dir, report, bin: arg('--bin') });
    else runTrivy({ dir, image: arg('--image'), report, bin: arg('--bin') });
  } catch (err) {
    fail(err instanceof ScannerConfigInTree ? 'failed' : 'not-completed', err.message);
  }
  console.log(`[scan] ${command}: report written to ${report}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
