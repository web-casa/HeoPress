/**
 * Domain verification (HeoPress P04, spec sites/domain-routing "域名验证后生效",
 * "域名归属与可信 Host").
 *
 * A custom domain serves nothing until it is verified. Each claim — one site,
 * one hostname — gets its own random token with an expiry, and proves
 * control of the domain in one of two ways:
 *
 *   - `dns_txt`: a TXT record `_heopress-challenge.<hostname>` containing the
 *     token;
 *   - `http_file`: `http://<hostname>/.well-known/heopress-verification.txt`
 *     serving the token. Fetched through the outbound boundary (P03) as a
 *     user-supplied address: no private networks, no metadata endpoints,
 *     bounded size and time, redirects re-checked.
 *
 * The token is bound to the claim: another site claiming the same hostname
 * has a different token, so copying someone's record does not verify it,
 * and an expired token verifies nothing. Several sites may claim a hostname
 * while pending; whoever verifies it first owns it (`site_domains`
 * partial unique index on active hostnames).
 */
import { randomBytes } from 'node:crypto';
import { resolveTxt } from 'node:dns/promises';
import { and, eq } from 'drizzle-orm';
import { outboundFetch } from '@heopress/runtime/node';
import { siteDomains, type Database } from '@heopress/database';
import type { DomainVerificationRecord } from '@heopress/contracts/schemas';
import { runSiteTransaction } from '../rls-transaction';
import { assertSiteRulesTerminate, lockAddressSpace, RedirectConflictError } from '../site-network/site-rules';

export const CHALLENGE_LABEL = '_heopress-challenge';
export const HTTP_VERIFICATION_PATH = '/.well-known/heopress-verification.txt';
export const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type DomainRow = typeof siteDomains.$inferSelect;

export function newVerificationToken(): string {
  return `heopress-verify-${randomBytes(20).toString('hex')}`;
}

/** What the operator has to publish for this claim. */
export function verificationRecords(row: Pick<DomainRow, 'hostname' | 'verificationMethod' | 'verificationToken'>): DomainVerificationRecord[] {
  if (!row.verificationToken) return [];
  return row.verificationMethod === 'http_file'
    ? [
        {
          type: 'HTTP',
          name: `http://${row.hostname}${HTTP_VERIFICATION_PATH}`,
          value: row.verificationToken,
          purpose: 'Serve this text at this URL, then verify.',
        },
      ]
    : [
        {
          type: 'TXT',
          name: `${CHALLENGE_LABEL}.${row.hostname}`,
          value: row.verificationToken,
          purpose: 'Add this TXT record, then verify.',
        },
      ];
}

/** How a claim is checked; replaced in tests. */
export interface DomainProbe {
  txt(name: string): Promise<string[]>;
  httpFile(url: string): Promise<string | null>;
}

export const defaultDomainProbe: DomainProbe = {
  async txt(name) {
    try {
      return (await resolveTxt(name)).map((chunks) => chunks.join(''));
    } catch {
      return [];
    }
  },
  async httpFile(url) {
    try {
      const res = await outboundFetch(url, { purpose: 'user', timeoutMs: 10_000, maxResponseBytes: 4096, maxRedirects: 2 });
      return res.ok ? (await res.text()).trim() : null;
    } catch {
      return null;
    }
  },
};

/** The probe the routes use; tests swap `current`. */
export const domainProbe: { current: DomainProbe } = { current: defaultDomainProbe };

export type VerifyOutcome =
  | { verified: true; row: DomainRow }
  | { verified: false; row: DomainRow; reason: 'TOKEN_EXPIRED' | 'NOT_FOUND_YET' | 'DOMAIN_TAKEN' | 'REDIRECT_CONFLICT' };

/**
 * Check one pending claim of `siteId` and activate it when its own token is
 * published. Activation is a conditional update (still pending, same token),
 * and the partial unique index refuses it when another site already holds
 * the hostname.
 */
export async function verifyDomainClaim(
  db: Database,
  siteId: string,
  row: DomainRow,
  probe: DomainProbe = defaultDomainProbe,
  now: Date = new Date(),
): Promise<VerifyOutcome> {
  if (!row.verificationToken || !row.verificationExpiresAt || row.verificationExpiresAt.getTime() <= now.getTime()) {
    return { verified: false, row, reason: 'TOKEN_EXPIRED' };
  }
  const token = row.verificationToken;
  const found =
    row.verificationMethod === 'http_file'
      ? (await probe.httpFile(`http://${row.hostname}${HTTP_VERIFICATION_PATH}`)) === token
      : (await probe.txt(`${CHALLENGE_LABEL}.${row.hostname}`)).includes(token);
  if (!found) return { verified: false, row, reason: 'NOT_FOUND_YET' };
  try {
    // A language entry joins the site's address space when it goes live: under the settings lock, and only
    // if the site's redirects still provably terminate there (HeoPress P05, design R36).
    const updated = await runSiteTransaction(db, siteId, async (tx) => {
      // Always first (settings → domain row): the row read before the probe may be stale — a language may have been set meanwhile.
      await lockAddressSpace(tx, siteId);
      const [one] = await tx
        .update(siteDomains)
        .set({ status: 'active', verifiedAt: now, statusReason: null, updatedAt: now })
        .where(
          and(
            eq(siteDomains.id, row.id),
            eq(siteDomains.siteId, siteId),
            eq(siteDomains.status, 'pending'),
            eq(siteDomains.verificationToken, token),
          ),
        )
        .returning();
      if (one?.entryLocale) await assertSiteRulesTerminate(tx, siteId);
      return one;
    });
    return updated ? { verified: true, row: updated } : { verified: false, row, reason: 'NOT_FOUND_YET' };
  } catch (err) {
    if (isUniqueViolation(err)) return { verified: false, row, reason: 'DOMAIN_TAKEN' };
    if (err instanceof RedirectConflictError) return { verified: false, row, reason: 'REDIRECT_CONFLICT' };
    throw err;
  }
}

export function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 3; e = (e as { cause?: unknown }).cause, depth++) {
    if ((e as { code?: unknown }).code === '23505') return true;
  }
  return false;
}
