import { cp, stat } from 'node:fs/promises';
import * as fs from 'node:fs';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';
import { fileURLToPath } from 'node:url';
import git, { type GitAuth as IsoGitAuth, type GitHttpRequest, type GitHttpResponse, type HttpClient } from 'isomorphic-git';

/**
 * Git for Git snapshots (HeoPress P11 task 2.1–2.3), in process through isomorphic-git (MIT): the CMS image carries no
 * `git` program. The snapshot repository is a bare object store under the working root; nothing is checked out.
 *
 *   - https remotes go through `pinnedHttpClient`: https only, the configured host only, connected to the addresses the
 *     SSRF check vetted (the socket's DNS lookup answers with them, never asking DNS again), no redirects followed, a
 *     time limit per request.
 *   - The credential reaches isomorphic-git through its `onAuth` callback only (sent as an Authorization header), never
 *     in a URL, an argument, a file or a log line; a refused credential is not retried. Every error text leaving this
 *     module is redacted of it.
 *   - `file://` remotes (tests and local mirrors, when HEOPRESS_GIT_SNAPSHOT_ALLOW_FILE_REMOTES=true) are a bare
 *     repository on disk: objects are copied (content addressed, so copying is safe) and the branch is moved only
 *     from the commit the pass started from (a fast-forward, like a plain push).
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

interface GitRemote {
  kind: 'https' | 'file';
  url: URL;
  /** The addresses vetted by the SSRF check (https). */
  resolvedIps: string[];
}

export interface GitRemoteOptions {
  /** The local bare repository (the snapshot's object store). */
  gitdir: string;
  remote: GitRemote;
  auth?: GitAuth | null;
  timeoutMs?: number;
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

/**
 * An isomorphic-git HTTP client bound to one https host and its vetted addresses. Any other scheme or host is refused;
 * a 3xx answer is returned as is (isomorphic-git treats it as a failure), never followed.
 */
export function pinnedHttpClient(host: string, ips: string[], timeoutMs = DEFAULT_TIMEOUT_MS): HttpClient {
  if (ips.length === 0) throw new GitCommandError('git: the remote host has no vetted address', null);
  const lookup: LookupFunction = (_hostname, options, callback) => {
    const all = ips.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    if ((options as { all?: boolean }).all) (callback as unknown as (e: null, a: typeof all) => void)(null, all);
    else callback(null, all[0]!.address, all[0]!.family);
  };
  return {
    async request(req: GitHttpRequest): Promise<GitHttpResponse> {
      const url = new URL(req.url);
      if (url.protocol !== 'https:' || url.hostname !== host || url.username || url.password) {
        throw new GitCommandError('git: request outside the configured https remote refused', null);
      }
      const chunks: Buffer[] = [];
      if (req.body) for await (const c of req.body) chunks.push(Buffer.from(c));
      const body = Buffer.concat(chunks);
      return new Promise<GitHttpResponse>((resolveRes, rejectRes) => {
        const r = httpsRequest(
          url,
          {
            method: req.method ?? 'GET',
            headers: { ...(req.headers ?? {}), ...(chunks.length ? { 'content-length': String(body.length) } : {}) },
            lookup,
            servername: host,
            agent: false,
            timeout: timeoutMs,
          },
          (res) => {
            const headers: Record<string, string> = {};
            for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(', ') : v;
            resolveRes({
              url: req.url,
              method: req.method,
              statusCode: res.statusCode ?? 0,
              statusMessage: res.statusMessage ?? '',
              headers,
              body: (async function* () {
                for await (const c of res) yield new Uint8Array(c as Buffer);
              })(),
            });
          },
        );
        r.on('timeout', () => r.destroy(new Error('request timed out')));
        r.on('error', rejectRes);
        if (chunks.length) r.write(body);
        r.end();
      });
    },
  };
}

function authCallbacks(auth: GitAuth | null | undefined) {
  if (!auth) return {};
  return {
    onAuth: (): IsoGitAuth => ({ username: auth.username, password: auth.token }),
    // A refused credential is not offered again.
    onAuthFailure: (): IsoGitAuth => ({ cancel: true }),
  };
}

async function wrap<T>(what: string, auth: GitAuth | null | undefined, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof GitCommandError) throw new GitCommandError(redact(err.message, auth), err.code);
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    throw new GitCommandError(redact(`git ${what}: ${detail}`, auth), null);
  }
}

async function bareRemotePath(remote: GitRemote): Promise<string> {
  const path = fileURLToPath(remote.url);
  const head = await stat(`${path}/HEAD`).catch(() => null);
  if (!head) throw new GitCommandError('git: the remote repository was not found', null);
  return path;
}

async function resolveOrNull(gitdir: string, ref: string): Promise<string | null> {
  try {
    return await git.resolveRef({ fs, gitdir, ref });
  } catch (err) {
    if ((err as { code?: string }).code === 'NotFoundError') return null;
    throw err;
  }
}

/** Create the local bare repository if needed. */
export async function initStore(gitdir: string, branch: string): Promise<void> {
  if (await stat(`${gitdir}/HEAD`).catch(() => null)) return;
  await git.init({ fs, gitdir, bare: true, defaultBranch: branch });
}

/** Bring the remote branch's objects into the local store and return its commit (null: the branch does not exist). */
export async function fetchBranch(branch: string, opts: GitRemoteOptions): Promise<string | null> {
  const ref = `refs/heads/${branch}`;
  if (opts.remote.kind === 'file') {
    return wrap('fetch', opts.auth, async () => {
      const path = await bareRemotePath(opts.remote);
      const oid = await resolveOrNull(path, ref);
      if (oid) await cp(`${path}/objects`, `${opts.gitdir}/objects`, { recursive: true, force: false, errorOnExist: false });
      return oid;
    });
  }
  const http = pinnedHttpClient(opts.remote.url.hostname, opts.remote.resolvedIps, opts.timeoutMs);
  const url = opts.remote.url.toString();
  return wrap('fetch', opts.auth, async () => {
    const refs = await git.listServerRefs({ http, url, prefix: ref, ...authCallbacks(opts.auth) });
    const head = refs.find((r) => r.ref === ref)?.oid ?? null;
    if (!head) return null;
    const res = await git.fetch({ fs, http, gitdir: opts.gitdir, url, ref: branch, remoteRef: branch, singleBranch: true, tags: false, ...authCallbacks(opts.auth) });
    return res.fetchHead ?? head;
  });
}

/** Push `commit` to the remote branch, which must still be at `expected` (null: absent). */
export async function pushBranch(branch: string, commit: string, expected: string | null, opts: GitRemoteOptions): Promise<void> {
  const ref = `refs/heads/${branch}`;
  await wrap('push', opts.auth, () => git.writeRef({ fs, gitdir: opts.gitdir, ref, value: commit, force: true }));
  if (opts.remote.kind === 'file') {
    await wrap('push', opts.auth, async () => {
      const path = await bareRemotePath(opts.remote);
      if ((await resolveOrNull(path, ref)) !== expected) throw new GitCommandError('git push: the remote branch moved (not a fast-forward)', null);
      await cp(`${opts.gitdir}/objects`, `${path}/objects`, { recursive: true, force: false, errorOnExist: false });
      await git.writeRef({ fs, gitdir: path, ref, value: commit, force: true });
    });
    return;
  }
  const http = pinnedHttpClient(opts.remote.url.hostname, opts.remote.resolvedIps, opts.timeoutMs);
  await wrap('push', opts.auth, async () => {
    const res = await git.push({ fs, http, gitdir: opts.gitdir, url: opts.remote.url.toString(), ref, remoteRef: ref, ...authCallbacks(opts.auth) });
    if (!res.ok) throw new GitCommandError(`git push: ${res.error ?? 'refused'}`, null);
  });
}

export interface TreeFile {
  oid: string;
  mode: string;
}

/** Every file of a commit's tree: path → blob id and mode. */
export async function readCommitFiles(gitdir: string, commit: string | null): Promise<Map<string, TreeFile>> {
  const out = new Map<string, TreeFile>();
  if (!commit) return out;
  const walk = async (oid: string, prefix: string): Promise<void> => {
    const { tree } = await git.readTree({ fs, gitdir, oid });
    for (const e of tree) {
      const p = prefix ? `${prefix}/${e.path}` : e.path;
      if (e.type === 'tree') await walk(e.oid, p);
      else if (e.type === 'blob') out.set(p, { oid: e.oid, mode: e.mode });
    }
  };
  const { commit: c } = await git.readCommit({ fs, gitdir, oid: commit });
  await walk(c.tree, '');
  return out;
}

export async function readBlobText(gitdir: string, oid: string): Promise<string> {
  const { blob } = await git.readBlob({ fs, gitdir, oid });
  return Buffer.from(blob).toString('utf8');
}

export const writeBlobText = (gitdir: string, content: string): Promise<string> => git.writeBlob({ fs, gitdir, blob: Buffer.from(content, 'utf8') });

/** Write the nested trees for a set of files and return the root tree id. */
export async function writeFilesTree(gitdir: string, files: Map<string, TreeFile>): Promise<string> {
  type Dir = { files: Map<string, TreeFile>; dirs: Map<string, Dir> };
  const root: Dir = { files: new Map(), dirs: new Map() };
  for (const [path, f] of files) {
    const parts = path.split('/');
    let d = root;
    for (const part of parts.slice(0, -1)) {
      if (!d.dirs.has(part)) d.dirs.set(part, { files: new Map(), dirs: new Map() });
      d = d.dirs.get(part)!;
    }
    d.files.set(parts[parts.length - 1]!, f);
  }
  const write = async (d: Dir): Promise<string> => {
    const entries: Array<{ mode: string; path: string; oid: string; type: 'blob' | 'tree' }> = [];
    for (const [name, sub] of d.dirs) entries.push({ mode: '040000', path: name, oid: await write(sub), type: 'tree' });
    for (const [name, f] of d.files) entries.push({ mode: f.mode, path: name, oid: f.oid, type: 'blob' });
    return git.writeTree({ fs, gitdir, tree: entries });
  };
  return write(root);
}

export async function treeOfCommit(gitdir: string, commit: string | null): Promise<string | null> {
  if (!commit) return null;
  return (await git.readCommit({ fs, gitdir, oid: commit })).commit.tree;
}

export function writeSnapshotCommit(
  gitdir: string,
  input: { tree: string; parent: string | null; message: string; author: { name: string; email: string }; at: Date },
): Promise<string> {
  const who = { name: input.author.name, email: input.author.email, timestamp: Math.floor(input.at.getTime() / 1000), timezoneOffset: 0 };
  return git.writeCommit({ fs, gitdir, commit: { tree: input.tree, parent: input.parent ? [input.parent] : [], author: who, committer: who, message: `${input.message}\n` } });
}
