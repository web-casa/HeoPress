import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { gitSnapshotRepos, type Database } from '@heopress/database';
import { CryptoService } from '../crypto-service';
import { runSiteTransaction } from '../rls-transaction';
import { resolveAndValidateOutboundUrl } from '../ssrf-guard';

/**
 * A site's content repository (HeoPress P11 task 2.1): remote, branch, commit identity and an access token sealed with
 * the instance key (AES-GCM, bound to the site and field). The token is write-only: reads return whether one is set and
 * its last four characters, never the value; it is never logged.
 */

const COLLECTION = 'git_snapshot_repos';
const FIELD = 'credential';

export class GitSnapshotConfigError extends Error {
  constructor(
    readonly code: 'VALIDATION' | 'CONFLICT' | 'NOT_CONFIGURED' | 'ENCRYPTION_KEY_MISSING',
    message: string,
    readonly status: 400 | 404 | 409 | 503 = 400,
  ) {
    super(message);
    this.name = 'GitSnapshotConfigError';
  }
}

/** `file://` remotes are for tests and local mirrors only. */
export const fileRemotesAllowed = (): boolean => process.env.HEOPRESS_GIT_SNAPSHOT_ALLOW_FILE_REMOTES === 'true';

const BRANCH_RE = /^(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;

const GitSnapshotConfigInput = z
  .object({
    enabled: z.boolean(),
    remoteUrl: z.string().trim().min(1).max(500),
    branch: z.string().trim().regex(BRANCH_RE).refine((b) => !b.endsWith('.lock') && !b.endsWith('/'), 'invalid branch').default('main'),
    username: z.string().trim().max(100).regex(/^[^:\s]*$/).nullable().optional(),
    /** Undefined: keep the stored token; null: remove it; a string: replace it. */
    token: z.string().min(1).max(2000).nullable().optional(),
    authorName: z.string().trim().min(1).max(100).regex(/^[^<>\n]+$/).default('HeoPress'),
    authorEmail: z.string().trim().email().max(200).default('snapshots@heopress.invalid'),
    /** The version read (optimistic concurrency); absent for the first save. */
    version: z.number().int().positive().optional(),
  })
  .strict();

/** Check a remote: `https` without user info and not on a private network; `file` only when allowed. */
export async function validateRemoteUrl(raw: string): Promise<{ kind: 'https' | 'file'; url: URL; resolvedIps: string[] }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new GitSnapshotConfigError('VALIDATION', 'The remote URL is invalid.');
  }
  if (url.protocol === 'file:') {
    if (!fileRemotesAllowed()) throw new GitSnapshotConfigError('VALIDATION', 'Only https remotes are allowed.');
    return { kind: 'file', url, resolvedIps: [] };
  }
  if (url.protocol !== 'https:') throw new GitSnapshotConfigError('VALIDATION', 'Only https remotes are allowed.');
  if (url.username || url.password) throw new GitSnapshotConfigError('VALIDATION', 'Put the access token in the token field, not in the URL.');
  if (url.search || url.hash) throw new GitSnapshotConfigError('VALIDATION', 'The remote URL must not have a query or fragment.');
  const verdict = await resolveAndValidateOutboundUrl(url.toString(), { requireDnsResolution: true });
  if (!verdict.allowed) throw new GitSnapshotConfigError('VALIDATION', `The remote is not allowed: ${verdict.reason ?? 'blocked'}`);
  return { kind: 'https', url, resolvedIps: verdict.resolvedIps ?? [] };
}

function maskHint(token: string): string {
  return token.length <= 4 ? '••••' : `••••${token.slice(-4)}`;
}

export interface GitSnapshotConfigView {
  configured: boolean;
  enabled: boolean;
  remoteUrl: string | null;
  branch: string;
  username: string | null;
  hasToken: boolean;
  tokenHint: string | null;
  authorName: string;
  authorEmail: string;
  version: number | null;
  status: {
    lastStatus: string | null;
    lastError: string | null;
    lastRunAt: string | null;
    lastPushedAt: string | null;
    lastCommitSha: string | null;
    lastReconciledAt: string | null;
    lastReport: Record<string, unknown> | null;
    pendingEvents: number;
  };
}

type Row = typeof gitSnapshotRepos.$inferSelect;

function viewOf(row: Row | undefined, pendingEvents: number): GitSnapshotConfigView {
  const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
  return {
    configured: !!row,
    enabled: row?.enabled ?? false,
    remoteUrl: row?.remoteUrl ?? null,
    branch: row?.branch ?? 'main',
    username: row?.username ?? null,
    hasToken: !!row?.credentialEncrypted,
    tokenHint: row?.credentialHint ?? null,
    authorName: row?.authorName ?? 'HeoPress',
    authorEmail: row?.authorEmail ?? 'snapshots@heopress.invalid',
    version: row?.version ?? null,
    status: {
      lastStatus: row?.lastStatus ?? null,
      lastError: row?.lastError ?? null,
      lastRunAt: iso(row?.lastRunAt),
      lastPushedAt: iso(row?.lastPushedAt),
      lastCommitSha: row?.lastCommitSha ?? null,
      lastReconciledAt: iso(row?.lastReconciledAt),
      lastReport: row?.lastReport ?? null,
      pendingEvents,
    },
  };
}

export class GitSnapshotConfigService {
  constructor(private readonly deps: { db: Database; siteId: string; encryptionKey?: string | null }) {}

  async get(): Promise<GitSnapshotConfigView> {
    return runSiteTransaction(this.deps.db, this.deps.siteId, async (tx) => {
      const [row] = await tx.select().from(gitSnapshotRepos).where(eq(gitSnapshotRepos.siteId, this.deps.siteId));
      const [pending] = (await tx.execute(sql`SELECT count(*)::int AS n FROM lumibase_git_snapshot_queue WHERE site_id = ${this.deps.siteId}`)) as unknown as Array<{ n: number }>;
      return viewOf(row, Number(pending?.n ?? 0));
    });
  }

  async update(body: unknown): Promise<GitSnapshotConfigView> {
    const parsed = GitSnapshotConfigInput.safeParse(body);
    if (!parsed.success) throw new GitSnapshotConfigError('VALIDATION', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    const input = parsed.data;
    await validateRemoteUrl(input.remoteUrl);
    let sealed: string | null | undefined;
    if (typeof input.token === 'string') {
      if (!this.deps.encryptionKey) throw new GitSnapshotConfigError('ENCRYPTION_KEY_MISSING', 'ENCRYPTION_KEY must be set to store a repository token.', 503);
      sealed = await sealCredential(this.deps.encryptionKey, this.deps.siteId, input.token);
    } else if (input.token === null) sealed = null;
    const { siteId } = this.deps;
    await runSiteTransaction(this.deps.db, siteId, async (tx) => {
      const [row] = await tx.select({ version: gitSnapshotRepos.version }).from(gitSnapshotRepos).where(eq(gitSnapshotRepos.siteId, siteId)).for('update');
      if (row && input.version !== row.version) throw new GitSnapshotConfigError('CONFLICT', 'The configuration changed since it was read.', 409);
      const values = {
        enabled: input.enabled,
        remoteUrl: input.remoteUrl,
        branch: input.branch,
        username: input.username ?? null,
        authorName: input.authorName,
        authorEmail: input.authorEmail,
        updatedAt: new Date(),
        ...(sealed !== undefined ? { credentialEncrypted: sealed, credentialHint: sealed && typeof input.token === 'string' ? maskHint(input.token) : null } : {}),
      };
      if (row) await tx.update(gitSnapshotRepos).set({ ...values, version: row.version + 1 }).where(eq(gitSnapshotRepos.siteId, siteId));
      else await tx.insert(gitSnapshotRepos).values({ siteId, ...values });
    });
    return this.get();
  }
}

function sealCredential(encryptionKey: string, siteId: string, token: string): Promise<string> {
  return CryptoService.fromKey(encryptionKey).encrypt(token, { siteId, collection: COLLECTION, field: FIELD, recordId: siteId });
}

export async function openCredential(encryptionKey: string, siteId: string, sealed: string): Promise<string> {
  const v = await CryptoService.fromKey(encryptionKey).decrypt(sealed, { siteId, collection: COLLECTION, field: FIELD, recordId: siteId });
  if (typeof v !== 'string') throw new Error('credential could not be opened');
  return v;
}
