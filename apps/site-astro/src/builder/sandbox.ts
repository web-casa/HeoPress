import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';

/**
 * The build sandbox plan and probe (HeoPress v1.5, spec rendering/astro-build-sandbox).
 *
 * A build under the sandbox is one throw-away container: read-only root, only the input and output directories mounted,
 * no network, every capability dropped, cgroup limits and a container name the host can kill. This module does two things
 * and nothing else, so both are testable without a container runtime:
 *
 *   - `probeSandbox` answers whether this host can run one, and if not, what to install or enable (the answer becomes
 *     `SANDBOX_UNAVAILABLE`, never a silent fallback to the child process);
 *   - `sandboxPlan` turns a build request into the exact argv, refusing anything that would widen the boundary — a path
 *     with `:` (podman's `-v` separator), an output directory inside the input, a relative path, or a limit that was not
 *     asked for.
 *
 * The transport is the runtime's CLI against a socket (`--remote`/`-H`), so the CMS container needs neither a daemon nor
 * extra capabilities of its own: it talks to the rootless runtime the operator mounted in. Which is also why an absent
 * CLI or socket is an ordinary, reportable state rather than a crash.
 */

/** Where the runtime lives and how much of the host a build may use. */
export interface SandboxConfig {
  /** The CLI to drive (`podman`, `docker`, or an absolute path). */
  cli: string;
  /** The runtime's socket (`unix:///run/user/1000/podman/podman.sock`); empty for a local CLI. */
  socket?: string;
  /** The image holding Node, Astro and the dependencies a theme may use. */
  image: string;
  /** The runtime's container runtime (`crun`, `runc`, `runsc` for gVisor); empty for the runtime's default. */
  runtime?: string;
  limits: {
    cpus: number;
    memoryMb: number;
    pids: number;
  };
  /** Every mount must resolve under one of these (the CMS's build root); empty disables the check. */
  roots?: string[];
}

/** Why a host cannot run a sandboxed build; each has a repair an operator can act on. */
type SandboxUnavailable =
  | 'cli_missing'
  | 'cli_failed'
  | 'socket_missing'
  | 'image_missing'
  | 'cgroup_v2_missing';

export interface SandboxProbe {
  available: boolean;
  /**
   * Whether the runtime is rootless. It decides which uid a build may write as: under a rootless runtime the container's
   * root *is* the invoking host user, and any other uid maps to a subordinate one that cannot write the mounted output.
   */
  rootless?: boolean;
  /** Why it is not available (only when `available` is false). */
  reason?: SandboxUnavailable;
  /** What an operator can do about it, in the operator's language of actions ("install…", "mount…"). */
  repair?: string;
  /** The runtime version, when the CLI answered. */
  version?: string;
}

/** The smallest cgroup v2 surface a limit needs: `memory`, `pids` and `cpu` on one unified hierarchy. */
function hasCgroupV2(): boolean {
  try {
    const controllers = spawnSync('cat', ['/sys/fs/cgroup/cgroup.controllers'], { encoding: 'utf8' });
    if (controllers.status !== 0) return false;
    const names = controllers.stdout.trim().split(/\s+/);
    return ['memory', 'pids', 'cpu'].every((name) => names.includes(name));
  } catch {
    return false;
  }
}

/**
 * Whether this host can run a sandboxed build. Cached for a short while: an operator who installs the runtime should not
 * have to restart the CMS to see the build work again.
 */
export function probeSandbox(config: SandboxConfig, now: number = Date.now()): SandboxProbe {
  const cached = probeCache.get(config.cli);
  if (cached && now - cached.at < PROBE_TTL_MS) return cached.probe;
  const probe = probeNow(config);
  probeCache.set(config.cli, { at: now, probe });
  return probe;
}

const PROBE_TTL_MS = 60_000;
const probeCache = new Map<string, { at: number; probe: SandboxProbe }>();

function probeNow(config: SandboxConfig): SandboxProbe {
  const version = spawnSync(config.cli, ['--version'], { encoding: 'utf8' });
  if (version.error && (version.error as NodeJS.ErrnoException).code === 'ENOENT') {
    return {
      available: false,
      reason: 'cli_missing',
      repair: `install ${config.cli} on the host, or set HEOPRESS_ASTRO_BUILD_CLI to its path`,
    };
  }
  if (version.status !== 0) {
    return {
      available: false,
      reason: 'cli_failed',
      repair: `${config.cli} is installed but did not answer --version; check it runs as the service user`,
    };
  }
  const reported = (version.stdout || '').trim().split('\n')[0] ?? '';

  if (config.socket) {
    const path = config.socket.replace(/^unix:\/\//, '');
    if (!existsSync(path)) {
      return {
        available: false,
        reason: 'socket_missing',
        repair: `start the rootless runtime and mount its socket at ${path} into this container`,
      };
    }
    try {
      if (!statSync(path).isSocket()) {
        return { available: false, reason: 'socket_missing', repair: `${path} exists but is not a socket` };
      }
    } catch {
      return { available: false, reason: 'socket_missing', repair: `${path} cannot be inspected by this user` };
    }
  }

  // A remote runtime answers about *its* images; a local one about its own. Podman has `image exists`, Docker has
  // `image inspect`; asking the wrong one would report every image as missing.
  const images = spawnSync(config.cli, [...socketArgs(config), 'image', imageProbeSubcommand(config.cli), config.image], {
    encoding: 'utf8',
  });
  if (images.status !== 0) {
    return {
      available: false,
      reason: 'image_missing',
      repair: `pull or build the build image ${config.image} (docker/astro-build/README.md)`,
      version: reported,
    };
  }

  if (!hasCgroupV2()) {
    return {
      available: false,
      reason: 'cgroup_v2_missing',
      repair: 'enable cgroup v2 on the host (unified hierarchy with the memory, pids and cpu controllers)',
      version: reported,
    };
  }

  return { available: true, version: reported, rootless: runtimeIsRootless(config) };
}

/**
 * Whether the runtime this CLI talks to is rootless. Podman answers with `Host.Security.Rootless`; Docker reports the
 * `rootless` security option. A runtime that does not answer is treated as rootful, which keeps a build from running as
 * container root on a rootful runtime.
 */
function runtimeIsRootless(config: Pick<SandboxConfig, 'cli' | 'socket'>): boolean {
  const format = config.cli.endsWith('podman') ? '{{.Host.Security.Rootless}}' : '{{json .SecurityOptions}}';
  const info = spawnSync(config.cli, [...socketArgs(config), 'info', '--format', format], { encoding: 'utf8' });
  if (info.status !== 0) return false;
  const answer = (info.stdout || '').trim().toLowerCase();
  return answer === 'true' || answer.includes('rootless');
}

/** The subcommand that answers "does this image exist" for a given CLI. */
function imageProbeSubcommand(cli: string): 'exists' | 'inspect' {
  return cli.endsWith('podman') ? 'exists' : 'inspect';
}

/** The flags that point the CLI at the runtime's socket, if one is configured. */
export function socketArgs(config: Pick<SandboxConfig, 'cli' | 'socket'>): string[] {
  if (!config.socket) return [];
  // podman and docker spell it differently; `--remote` also works for podman over `--url`.
  return config.cli.endsWith('podman') ? ['--remote', '--url', config.socket] : ['-H', config.socket];
}

export class SandboxPlanError extends Error {
  constructor(
    readonly code: 'INVALID_PATH' | 'OUTSIDE_ROOT' | 'OUTPUT_INSIDE_INPUT' | 'NO_LIMITS',
    message: string,
  ) {
    super(message);
    this.name = 'SandboxPlanError';
  }
}

export interface SandboxBuildPaths {
  /** The theme, its dependencies and the page data: mounted read-only at `/in`. */
  inputDir: string;
  /** Where the build writes its output: mounted read-write at `/out`. */
  outputDir: string;

  /** A throw-away HOME and tmp: a tmpfs, sized by `limits.memoryMb`'s partner `tmpfsMb`. */
  tmpfsMb?: number;
}

export interface SandboxPlan {
  argv: string[];
  containerName: string;
}

export interface SandboxPlanOptions {
  /** A user namespace the runtime applies (`keep-id` and friends); absent means the runtime's default. */
  userns?: string;
  /** Container environment (`-e KEY=VALUE`), already mapped to container paths. */
  env?: Record<string, string>;
  /** The command inside the container (default: the template's Astro build). */
  command?: string[];
  /** The container's working directory (default `/in`). */
  workdir?: string;
}

/** Where the prepared template's `.astro` symlink points: a tmpfs the runtime mounts over the read-only root. */
const ASTRO_CACHE_DIR = '/var/cache/astro';

const CONTAINER_NAME = /^heopress-astro-[A-Za-z0-9_-]{1,64}$/;

/**
 * The exact argv of one sandboxed build. Every flag here is a boundary: the tests assert each one, and the review of this
 * function is a review of the sandbox.
 */
export function sandboxPlan(
  config: SandboxConfig,
  paths: SandboxBuildPaths,
  identity: { containerName: string; uid?: number; gid?: number; workdir?: string },
  options: SandboxPlanOptions = {},
): SandboxPlan {
  if (!CONTAINER_NAME.test(identity.containerName)) {
    throw new SandboxPlanError('INVALID_PATH', `container name ${JSON.stringify(identity.containerName)} is not build-shaped`);
  }
  const input = checkedPath(config, paths.inputDir, 'input');
  const output = checkedPath(config, paths.outputDir, 'output');
  if (output === input || output.startsWith(`${input}${sep}`)) {
    throw new SandboxPlanError('OUTPUT_INSIDE_INPUT', 'the output directory must not sit inside the read-only input');
  }
  if (!(config.limits.cpus > 0) || !(config.limits.memoryMb > 0) || !(config.limits.pids > 0)) {
    throw new SandboxPlanError('NO_LIMITS', 'a sandboxed build needs positive cpu, memory and pids limits');
  }

  const tmpfsMb = Math.max(64, paths.tmpfsMb ?? Math.min(512, Math.round(config.limits.memoryMb / 4)));
  const argv = [
    config.cli,
    ...socketArgs(config),
    'run',
    '--rm',
    '--name',
    identity.containerName,
    // No kernel surface beyond what the build needs.
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--read-only',
    '--network',
    'none',
    // The only two host paths the build can see, plus a tmpfs it may write.
    // `:z` relabels the mounts for SELinux: an enforcing host (AlmaLinux/Rocky/RHEL) otherwise refuses the write with
    // EACCES even though the uid matches. It is a no-op on hosts without SELinux.
    '-v',
    `${input}:/in:ro,z`,
    '-v',
    `${output}:/out:rw,z`,
    '--tmpfs',
    `/tmp:rw,size=${tmpfsMb}m,mode=1777`,
    // Astro writes its content-layer cache to `<root>/.astro`. The prepared template points that at this directory (a
    // symlink), and the mount point exists in the image, so the runtime can bind it over a read-only root filesystem.
    '--tmpfs',
    `${ASTRO_CACHE_DIR}:rw,size=${Math.min(256, tmpfsMb)}m,mode=1777`,
    // cgroup v2 limits: memory and swap held equal so the build cannot page its way past the cap.
    '--cpus',
    String(config.limits.cpus),
    '--memory',
    `${config.limits.memoryMb}m`,
    '--memory-swap',
    `${config.limits.memoryMb}m`,
    '--pids-limit',
    String(config.limits.pids),
    // The build's own environment: names, paths and limits, never the CMS's variables. `HOME` and `CI` are the two every
    // build needs; the rest is mapped by the runner.
    '-e',
    'HOME=/tmp/home',
    '-e',
    'CI=1',
    ...Object.entries(options.env ?? {}).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
    '-w',
    identity.workdir ?? options.workdir ?? '/in',
    ...(identity.uid !== undefined && identity.gid !== undefined ? ['--user', `${identity.uid}:${identity.gid}`] : []),
    ...(options.userns ? ['--userns', options.userns] : []),
    ...(config.runtime ? ['--runtime', config.runtime] : []),
    config.image,
    ...(options.command ?? ['node', '/in/node_modules/astro/bin/astro.mjs', 'build', '--silent']),
  ];
  return { argv, containerName: identity.containerName };
}

/** A mount path the runtime can express and the operator allowed. */
function checkedPath(config: SandboxConfig, value: string, role: 'input' | 'output'): string {
  if (!value || !isAbsolute(value)) throw new SandboxPlanError('INVALID_PATH', `the ${role} directory must be an absolute path`);
  // `-v host:container` splits on ':', so a colon in a path would silently become another mount.
  if (value.includes(':')) throw new SandboxPlanError('INVALID_PATH', `the ${role} directory must not contain ':'`);
  if (value.includes('\u0000')) throw new SandboxPlanError('INVALID_PATH', `the ${role} directory must not contain a NUL`);
  const resolved = resolve(value);
  if (config.roots && config.roots.length > 0) {
    const inside = config.roots.some((root) => {
      const base = resolve(root);
      return resolved === base || resolved.startsWith(`${base}${sep}`);
    });
    if (!inside) throw new SandboxPlanError('OUTSIDE_ROOT', `the ${role} directory is outside the configured build root`);
  }
  return resolved;
}
