// The one-command installer (HeoPress P13 task 3.1): arguments, refusals before anything is changed, and the
// invariants the end-to-end runs (CI job `install`, docker/scripts/sim-vps-install.sh) rely on. The installation
// itself is exercised there, not here.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const installer = path.join(root, 'docker/install.sh');
const source = fs.readFileSync(installer, 'utf8');
const accept = fs.readFileSync(path.join(root, 'docker/scripts/accept-install.sh'), 'utf8');

function run(args, env = {}) {
  return spawnSync('bash', [installer, ...args], {
    encoding: 'utf8',
    // Never touches the system log: a refusal happens before the log is opened, or the log goes here.
    env: { PATH: process.env.PATH, HOME: process.env.HOME, HEOPRESS_INSTALL_LOG: '/dev/null', ...env },
  });
}

describe('docker/install.sh', () => {
  it('installs the release of this tree by default (version:sync keeps them equal)', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.match(source, new RegExp(`^DEFAULT_VERSION='${pkg.version.replace(/\./g, '\\.')}'$`, 'm'));
  });

  it('prints its usage with --help', () => {
    const r = run(['--help']);
    assert.equal(r.status, 0);
    for (const option of ['--admin-domain', '--acme-email', '--source', '--build', '--tls', '--image-archive', '--extra-compose']) {
      assert.ok(r.stdout.includes(option), `usage lists ${option}`);
    }
  });

  for (const [args, message] of [
    [[], /--admin-domain is required/],
    [['--admin-domain', 'https://admin.example.com/'], /must be a hostname/],
    [['--admin-domain', 'localhost', '--tls', 'internal'], /must be a hostname/],
    [['--admin-domain', 'admin.example.com'], /--acme-email is required/],
    [['--admin-domain', 'admin.example.com', '--tls', 'self'], /--tls is acme or internal/],
    [['--admin-domain', 'admin.example.com', '--tls', 'internal', '--dir', 'relative'], /absolute path/],
    [['--admin-domain', 'admin.example.com', '--tls', 'internal', '--version', 'latest'], /not a release version/],
    [['--admin-domain', 'admin.example.com', '--tls', 'internal', '--https-port', '70000'], /not a port/],
    [['--admin-domain', 'admin.example.com', '--frobnicate'], /unknown option/],
  ]) {
    it(`refuses ${JSON.stringify(args)} with exit 2`, () => {
      const r = run(args);
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stderr, message);
    });
  }

  it('refuses to run as an ordinary user before changing anything', { skip: process.getuid?.() === 0 }, () => {
    const r = run(['--admin-domain', 'admin.example.com', '--acme-email', 'ops@example.com']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /run as root/);
  });

  it('never traces commands and generates every secret at install time', () => {
    for (const [name, text] of [['install.sh', source], ['accept-install.sh', accept]]) {
      assert.doesNotMatch(text, /set -[a-zA-Z]*x|set -o xtrace|bash -x/, `${name} must not trace commands (secrets)`);
    }
    // No development default reaches an installation.
    assert.doesNotMatch(source, /heopress_dev|dev_secret_key|heopress_render_dev/);
    for (const key of ['POSTGRES_PASSWORD', 'JWT_SECRET', 'ENCRYPTION_KEY', 'HEOPRESS_RENDER_PASSWORD', 'HEOPRESS_INTERNAL_SECRET']) {
      assert.match(source, new RegExp(`echo "${key}=\\$`), `${key} is written from a generated value`);
    }
    // Secrets go to files only: root-only modes, and the summary names the file instead of the values.
    assert.match(source, /^umask 077$/m);
    assert.match(source, /chmod 600 -- "\$env_file"/);
    assert.match(source, /chmod 600 -- "\$credentials_file"/);
    assert.doesNotMatch(source, /say[^\n]*\$admin_password|echo[^\n]*\$admin_password[^\n]*\|/);
  });

  it('refuses an existing installation with exit 3 before it writes anything', () => {
    const first = source.indexOf('already_installed "$conf_file"');
    assert.ok(first > 0);
    for (const write of ['mkdir -p -- "$install_dir"', '> "$env_file"', 'install_docker_packages docker-ce']) {
      assert.ok(source.indexOf(write) > first, `${write} comes after the existing-installation check`);
    }
    assert.match(source, /already_installed\(\) \{[\s\S]*?exit 3/);
  });

  it('uses only Compose files that exist, and keeps the administration off the site domains', () => {
    for (const file of source.matchAll(/\$src\/(docker\/[A-Za-z0-9_./-]+)/g)) {
      assert.ok(fs.existsSync(path.join(root, file[1])), `${file[1]} exists`);
    }
    const domains = fs.readFileSync(path.join(root, 'docker/Caddyfile.domains'), 'utf8');
    assert.match(domains, /@admin path \/admin \/admin\/\* \/api \/api\/\*\s+respond @admin 404/);
    assert.match(domains, /@internal path \/internal \/internal\/\*\s+respond @internal 404/);
  });

  it('is run end to end by the CI job `install` with its acceptance', () => {
    const ci = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
    const job = ci.slice(ci.indexOf('\n  install:\n'));
    assert.ok(job.length > 0, 'ci.yml has an install job');
    assert.match(job, /runs-on: ubuntu-24\.04/);
    assert.match(job, /sudo bash docker\/install\.sh/);
    assert.match(job, /docker\/scripts\/accept-install\.sh \/opt\/heopress --/);
  });
});
