import { mkdtemp, mkdir, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { probeSandbox, sandboxPlan, SandboxPlanError, socketArgs, type SandboxConfig } from '../builder/sandbox';

/**
 * The build sandbox's contract without a container runtime (HeoPress v1.5, spec rendering/astro-build-sandbox).
 *
 * The plan is the boundary: every flag asserted here is a guarantee the spec makes, so a flag that disappears from the
 * argv is a guarantee that disappeared. The probe is what makes an unavailable host a reportable state instead of a
 * silent fallback, so each way it can be unavailable has a case.
 */
let root: string;
let fake: { cli: string; script: (body: string) => Promise<string> };

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'heopress-sandbox-'));
  fake = {
    cli: join(root, 'podman-fake'),
    async script(body: string) {
      const file = join(root, `fake-${Math.random().toString(36).slice(2)}`);
      await writeFile(file, `#!/bin/sh\n${body}\n`, 'utf8');
      await chmod(file, 0o755);
      return file;
    },
  };
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const config = (over: Partial<SandboxConfig> = {}): SandboxConfig => ({
  cli: 'podman',
  image: 'heopress-astro-build:1',
  limits: { cpus: 2, memoryMb: 1024, pids: 256 },
  roots: [join(root, 'sites')],
  ...over,
});

const paths = () => ({
  inputDir: join(root, 'sites', 'a', 'in'),
  outputDir: join(root, 'sites', 'a', 'out'),
});

/** The value that follows `flag` in an argv. */
const after = (argv: string[], flag: string): string | undefined => {
  const at = argv.indexOf(flag);
  return at >= 0 ? argv[at + 1] : undefined;
};

describe('sandbox plan', () => {
  it('mounts exactly the input, the output and a tmpfs', () => {
    const { argv } = sandboxPlan(config(), paths(), { containerName: 'heopress-astro-abc123' });
    const mounts = argv.filter((_, i) => argv[i - 1] === '-v');
    expect(mounts).toEqual([
      `${join(root, 'sites', 'a', 'in')}:/in:ro`,
      `${join(root, 'sites', 'a', 'out')}:/out:rw`,
    ]);
    expect(argv.join(' ')).toContain('--tmpfs /tmp:rw');
    // Nothing else may be mounted: a stray volume is a hole.
    expect(argv.filter((a) => a === '-v' || a === '--volume' || a === '--mount')).toHaveLength(2);
  });

  it('has no network, no capabilities, a read-only root and no privilege escalation', () => {
    const { argv } = sandboxPlan(config(), paths(), { containerName: 'heopress-astro-abc123' });
    expect(after(argv, '--network')).toBe('none');
    expect(after(argv, '--cap-drop')).toBe('ALL');
    expect(after(argv, '--security-opt')).toBe('no-new-privileges');
    expect(argv).toContain('--read-only');
  });

  it('carries the resource limits, with swap held equal to memory', () => {
    const { argv } = sandboxPlan(config(), paths(), { containerName: 'heopress-astro-abc123' });
    expect(after(argv, '--cpus')).toBe('2');
    expect(after(argv, '--memory')).toBe('1024m');
    expect(after(argv, '--memory-swap')).toBe('1024m');
    expect(after(argv, '--pids-limit')).toBe('256');
  });

  it('runs the build as the given user, and never as root by omission', () => {
    const { argv } = sandboxPlan(config(), paths(), { containerName: 'heopress-astro-abc123', uid: 1000, gid: 1000 });
    expect(after(argv, '--user')).toBe('1000:1000');
  });

  it('names the container so the host can kill exactly it', () => {
    const { argv, containerName } = sandboxPlan(config(), paths(), { containerName: 'heopress-astro-x1y2z3' });
    expect(containerName).toBe('heopress-astro-x1y2z3');
    expect(after(argv, '--name')).toBe(containerName);
  });

  it('takes the runtime switch (gVisor is a flag, not a code change)', () => {
    const { argv } = sandboxPlan(config({ runtime: 'runsc' }), paths(), { containerName: 'heopress-astro-abc123' });
    expect(after(argv, '--runtime')).toBe('runsc');
  });

  it('refuses a path the runtime would read as another mount', () => {
    expect(() =>
      sandboxPlan(config(), { inputDir: join(root, 'sites', 'a:b'), outputDir: paths().outputDir }, { containerName: 'heopress-astro-a' }),
    ).toThrow(SandboxPlanError);
  });

  it('refuses a relative path, an output inside the input, and a missing limit', () => {
    expect(() => sandboxPlan(config(), { inputDir: 'in', outputDir: paths().outputDir }, { containerName: 'heopress-astro-a' })).toThrow(
      /absolute path/,
    );
    expect(() =>
      sandboxPlan(config(), { inputDir: join(root, 'sites', 'a'), outputDir: join(root, 'sites', 'a', 'out') }, { containerName: 'heopress-astro-a' }),
    ).toThrow(/must not sit inside/);
    expect(() =>
      sandboxPlan(config({ limits: { cpus: 0, memoryMb: 0, pids: 0 } }), paths(), { containerName: 'heopress-astro-a' }),
    ).toThrow(/positive/);
  });

  it('refuses a path outside the configured build root', () => {
    expect(() =>
      sandboxPlan(config(), { inputDir: '/etc', outputDir: join(root, 'sites', 'a', 'out') }, { containerName: 'heopress-astro-a' }),
    ).toThrow(/outside the configured build root/);
  });

  it('refuses a container name that is not build-shaped', () => {
    expect(() => sandboxPlan(config(), paths(), { containerName: 'x; rm -rf /' })).toThrow(SandboxPlanError);
  });
});

describe('socket transport', () => {
  it('speaks each CLI dialect', () => {
    expect(socketArgs({ cli: 'podman', socket: 'unix:///run/user/1000/podman/podman.sock' })).toEqual([
      '--remote',
      '--url',
      'unix:///run/user/1000/podman/podman.sock',
    ]);
    expect(socketArgs({ cli: 'docker', socket: 'unix:///var/run/docker.sock' })).toEqual(['-H', 'unix:///var/run/docker.sock']);
    expect(socketArgs({ cli: 'podman' })).toEqual([]);
  });
});

describe('sandbox probe', () => {
  it('reports a missing CLI with what to install', () => {
    const probe = probeSandbox(config({ cli: join(root, 'no-such-runtime') }));
    expect(probe.available).toBe(false);
    expect(probe.reason).toBe('cli_missing');
    expect(probe.repair).toMatch(/install/);
  });

  it('reports a CLI that does not answer', async () => {
    const cli = await fake.script('exit 3');
    const probe = probeSandbox(config({ cli }));
    expect(probe.reason).toBe('cli_failed');
  });

  it('reports a missing socket instead of pretending the runtime is local', async () => {
    const cli = await fake.script('echo "podman version 5.0.0"');
    const probe = probeSandbox(config({ cli, socket: `unix://${join(root, 'nope.sock')}` }));
    expect(probe.reason).toBe('socket_missing');
    expect(probe.repair).toMatch(/mount its socket/);
  });

  it('reports a missing image and names it', async () => {
    const cli = await fake.script('case "$1" in --version) echo "podman version 5.0.0";; image) exit 1;; *) exit 0;; esac');
    const probe = probeSandbox(config({ cli, image: 'heopress-astro-build:absent' }));
    expect(probe.reason).toBe('image_missing');
    expect(probe.repair).toContain('heopress-astro-build:absent');
  });

  it('is available when the runtime answers and the image exists', async () => {
    const cli = await fake.script('case "$1" in --version) echo "podman version 5.0.0";; *) exit 0;; esac');
    const probe = probeSandbox(config({ cli }));
    // cgroup v2 is a property of the test host; accept either outcome but require the version when available.
    if (probe.available) expect(probe.version).toContain('podman');
    else expect(probe.reason).toBe('cgroup_v2_missing');
  });
});
