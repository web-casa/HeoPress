import { execFile } from 'node:child_process';

/**
 * The `git` command line for Git snapshots (HeoPress P11 task 2.1–2.3). Runs `git` with arguments only (no shell), a
 * minimal environment (never the CMS's own: its keys and database URLs stay out of the child), no user or system
 * configuration, no prompts, no redirects, only the protocols allowed, and a time limit. The credential travels in the
 * child's environment as an HTTP header (`GIT_CONFIG_*`), never in a URL, an argument or a file; every error text is
 * redacted of it before it leaves this module.
 */

export class GitCommandError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
  ) {
    super(message);
    this.name = 'GitCommandError';
  }
}

export interface GitAuth {
  username: string;
  token: string;
}

export interface GitRunOptions {
  cwd: string;
  auth?: GitAuth | null;
  /** `https` (default) or `file` (test and local remotes only). */
  allowFile?: boolean;
  /** Pin a host to vetted addresses (`host:port:ip`, git's `http.curloptResolve`): DNS is not asked again by git. */
  resolve?: string[];
  timeoutMs?: number;
  author?: { name: string; email: string };
}

const DEFAULT_TIMEOUT_MS = 60_000;

/** Remove the credential (and its Basic form) from a text. */
export function redact(text: string, auth?: GitAuth | null): string {
  let out = text;
  if (auth?.token) {
    const basic = Buffer.from(`${auth.username}:${auth.token}`).toString('base64');
    for (const secret of [auth.token, basic]) out = out.split(secret).join('***');
  }
  // Any userinfo a remote might echo.
  return out.replace(/(https?:\/\/)[^/@\s]+@/gi, '$1***@').slice(0, 500);
}

function gitEnv(opts: GitRunOptions): NodeJS.ProcessEnv {
  const config: Array<[string, string]> = [
    ['http.followRedirects', 'false'],
    ['protocol.ext.allow', 'never'],
    ['core.hooksPath', '/dev/null'],
    ['commit.gpgSign', 'false'],
    ['core.autocrlf', 'false'],
    ['init.defaultBranch', 'main'],
  ];
  if (opts.auth) {
    const basic = Buffer.from(`${opts.auth.username}:${opts.auth.token}`).toString('base64');
    config.push(['http.extraHeader', `Authorization: Basic ${basic}`]);
  }
  for (const r of opts.resolve ?? []) config.push(['http.curloptResolve', r]);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: opts.cwd,
    LANG: 'C',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ASKPASS: 'true',
    SSH_ASKPASS: 'true',
    GIT_ALLOW_PROTOCOL: opts.allowFile ? 'https:file' : 'https',
    GIT_CONFIG_COUNT: String(config.length),
  };
  config.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k;
    env[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  if (opts.author) {
    env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = opts.author.name;
    env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = opts.author.email;
  }
  return env;
}

/** Run `git <args>` and return its standard output. */
export function runGit(args: string[], opts: GitRunOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd: opts.cwd, env: gitEnv(opts), timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const code = typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : null;
          const detail = String(stderr || err.message || 'git failed').trim();
          reject(new GitCommandError(redact(`git ${args[0]}: ${detail}`, opts.auth), code));
          return;
        }
        resolve(String(stdout));
      },
    );
  });
}
