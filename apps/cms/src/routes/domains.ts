// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { siteDomains } from '@heopress/database';
import {
  DomainCreateSchema,
  DomainUpdateSchema,
  type DomainResource,
} from '@heopress/contracts/schemas';
import { and, eq, ne } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { deleteHostMapping, putHostMapping } from '../services/domains/host-cache';
import { checkEntryLocale, isEntryLocaleTaken, LanguageEntryError } from '../services/site-network/language-entries';
import { assertSiteRulesTerminate, lockAddressSpace, RedirectConflictError } from '../services/site-network/site-rules';
import { runSiteTransaction } from '../services/rls-transaction';
import {
  TOKEN_TTL_MS,
  domainProbe,
  isUniqueViolation,
  newVerificationToken,
  verificationRecords,
  verifyDomainClaim,
} from '../services/domains/domain-verification';

/**
 * Site domains (HeoPress P04, spec sites/domain-routing).
 *
 * - Free subdomains (`kind: 'subdomain'`, under HEOPRESS_FREE_DOMAIN_SUFFIX)
 *   are active at once.
 * - Custom domains start `pending` with the claim's own verification token
 *   (DNS TXT or HTTP file, see domain-verification.ts) and serve nothing —
 *   no content, no certificate — until `POST /:id/verify` finds the token.
 * - Exactly one primary domain per site; other active domains redirect to it,
 *   except language entries (`entryLocale`), which keep their own host.
 * - A domain can be switched off (`disabled`) and back on.
 */
export const domainsRouter = new Hono<AppEnv>();

type DomainRow = typeof siteDomains.$inferSelect;

/** Strip internal columns and shape the row for the API. */
function toResource(row: DomainRow): DomainResource {
  return {
    id: row.id,
    hostname: row.hostname,
    kind: row.kind as DomainResource['kind'],
    isPrimary: row.isPrimary,
    status: row.status as DomainResource['status'],
    statusReason: row.statusReason ?? null,
    sslStatus: row.sslStatus ?? null,
    verificationMethod: row.verificationMethod as DomainResource['verificationMethod'],
    verificationExpiresAt: row.verificationExpiresAt ? row.verificationExpiresAt.toISOString() : null,
    entryLocale: row.entryLocale ?? null,
    // While pending: where to point the domain (when the operator configured a
    // target) and the claim's token record.
    verification: {
      records:
        row.status === 'pending'
          ? [...(((row.verification ?? {}) as { records?: DomainResource['verification']['records'] }).records ?? []), ...verificationRecords(row)]
          : [],
    },
    verifiedAt: row.verifiedAt ? row.verifiedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The operator's free-subdomain suffix, or null when none is configured.
 * HeoPress has no hosted suffix of its own (the contracts' FREE_DOMAIN_SUFFIX
 * is a reserved placeholder), so an unconfigured instance offers no free
 * subdomains rather than handing out addresses nobody can reach.
 */
/** A refusal decided inside a domain transaction (rolled back, then answered). */
class DomainRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 404 | 409,
  ) {
    super(message);
  }
}

function freeSuffix(c: { env: AppEnv['Bindings'] }): string | null {
  return c.env.HEOPRESS_FREE_DOMAIN_SUFFIX?.trim() || null;
}

domainsRouter.get('/', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');
  const rows = await db.select().from(siteDomains).where(eq(siteDomains.siteId, siteId));
  return c.json({ data: rows.map(toResource) });
});

domainsRouter.post('/', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');
  const cache = c.get('runtime')?.cache;

  const body = await c.req.json().catch(() => ({}));
  const parsed = DomainCreateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { errors: [{ code: 'VALIDATION', message: parsed.error.message, issues: parsed.error.issues }] },
      400,
    );
  }
  const input = parsed.data;
  // Resolve the final FQDN. Subdomain labels expand under the free suffix.
  const suffix = freeSuffix(c);
  if (input.kind === 'subdomain' && !suffix) {
    return c.json(
      {
        errors: [
          {
            code: 'FREE_SUBDOMAIN_NOT_CONFIGURED',
            message: 'This instance offers no free subdomains (HEOPRESS_FREE_DOMAIN_SUFFIX is not set). Add a custom domain instead.',
          },
        ],
      },
      409,
    );
  }
  const hostname = input.kind === 'subdomain' ? `${input.hostname}.${suffix}` : input.hostname;

  const now = new Date();
  const custom = input.kind === 'custom';
  // Where a custom domain should point (A/CNAME), when the operator said so.
  const target = c.env.HEOPRESS_SAAS_FALLBACK?.trim() || (suffix ? `cname.${suffix}` : null);
  const pointRecords =
    custom && target
      ? [{ type: 'CNAME' as const, name: hostname, value: target, purpose: 'Point your domain at this HeoPress instance.' }]
      : [];
  const statusReason =
    custom && !target
      ? 'Point this domain at the HeoPress server. Set HEOPRESS_SAAS_FALLBACK to the hostname custom domains should CNAME to, and the instructions will name it.'
      : null;
  let row: DomainRow | undefined;
  try {
    // A language entry names one of the site's other languages (P05, task 3.4); a free subdomain is live at
    // once, so it joins the address space here: under the settings lock, re-checked against the redirects (R36).
    row = await runSiteTransaction(db, siteId, async (tx) => {
      // Under the settings lock in every case: the new host refreshes the site's projection, which takes it, and a site
      // deletion takes it before its domains (P07, Codex review of batch 4b).
      await lockAddressSpace(tx, siteId);
      const entryLocale = input.entryLocale
        ? await checkEntryLocale(tx as unknown as typeof db, siteId, input.entryLocale, { id: null, isPrimary: false })
        : null;
      const [one] = await tx
        .insert(siteDomains)
        .values({
          siteId,
          hostname,
          kind: input.kind,
          // Free subdomains are ours: live at once. Custom domains wait for proof.
          status: custom ? 'pending' : 'active',
          verificationMethod: input.verificationMethod ?? 'dns_txt',
          verificationToken: custom ? newVerificationToken() : null,
          verificationExpiresAt: custom ? new Date(now.getTime() + TOKEN_TTL_MS) : null,
          entryLocale,
          verification: { records: pointRecords },
          statusReason,
          verifiedAt: custom ? null : now,
        })
        .returning();
      if (one?.status === 'active' && one.entryLocale) await assertSiteRulesTerminate(tx, siteId);
      return one;
    });
  } catch (err) {
    if (err instanceof LanguageEntryError) return c.json({ errors: [{ code: err.code, message: err.message }] }, err.status);
    if (err instanceof RedirectConflictError) {
      return c.json({ errors: [{ code: err.code, message: err.message, rules: err.rules }] }, 409);
    }
    if (isEntryLocaleTaken(err)) {
      return c.json({ errors: [{ code: 'ENTRY_TAKEN', message: 'Another domain became the entry for this language.' }] }, 409);
    }
    if (isUniqueViolation(err)) {
      return c.json(
        {
          errors: [
            {
              code: 'DOMAIN_TAKEN',
              message: custom
                ? 'This site already has that domain.'
                : 'That subdomain is already in use.',
            },
          ],
        },
        409,
      );
    }
    throw err;
  }
  if (!row) {
    return c.json({ errors: [{ code: 'INTERNAL', message: 'Insert failed.' }] }, 500);
  }

  if (row.status === 'active' && cache) {
    await putHostMapping(cache, row.hostname, siteId);
  }

  return c.json({ data: toResource(row) }, 201);
});

/**
 * Check a pending custom domain's token (DNS TXT or HTTP file) and activate
 * it when found. Free subdomains are always live (the host mapping is
 * rewritten).
 */
domainsRouter.post('/:id/verify', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');
  const cache = c.get('runtime')?.cache;
  const row = await loadDomain(db, siteId, c.req.param('id'));
  if (!row) return c.json({ errors: [{ code: 'NOT_FOUND', message: 'Domain not found.' }] }, 404);

  if (row.kind === 'subdomain' || row.status === 'active') {
    if (row.status === 'active' && cache) await putHostMapping(cache, row.hostname, siteId);
    return c.json({ data: toResource(row) });
  }
  if (row.status !== 'pending') {
    return c.json({ errors: [{ code: 'NOT_PENDING', message: 'Only a pending domain can be verified.' }] }, 409);
  }
  const outcome = await verifyDomainClaim(db, siteId, row, domainProbe.current);
  if (!outcome.verified) {
    const message = {
      TOKEN_EXPIRED: 'The verification token has expired; request a new one (POST …/token).',
      NOT_FOUND_YET: 'The verification record was not found yet. DNS changes can take a while to appear.',
      DOMAIN_TAKEN: 'Another site already uses this domain.',
      REDIRECT_CONFLICT: "With this language entry live, some of the site's redirects could loop; fix them first (it stays pending).",
    }[outcome.reason];
    return c.json(
      { errors: [{ code: outcome.reason, message }], data: toResource(outcome.row) },
      outcome.reason === 'DOMAIN_TAKEN' || outcome.reason === 'REDIRECT_CONFLICT' ? 409 : 422,
    );
  }
  if (cache) await putHostMapping(cache, outcome.row.hostname, siteId);
  return c.json({ data: toResource(outcome.row) });
});

/** A fresh token (and expiry) for a pending claim. */
domainsRouter.post('/:id/token', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');
  const [updated] = await db
    .update(siteDomains)
    .set({
      verificationToken: newVerificationToken(),
      verificationExpiresAt: new Date(Date.now() + TOKEN_TTL_MS),
      updatedAt: new Date(),
    })
    .where(and(eq(siteDomains.id, c.req.param('id')), eq(siteDomains.siteId, siteId), eq(siteDomains.status, 'pending')))
    .returning();
  if (!updated) return c.json({ errors: [{ code: 'NOT_PENDING', message: 'No pending domain with that id.' }] }, 404);
  return c.json({ data: toResource(updated) });
});

/** Switch a domain off and on, or set its language entry. */
domainsRouter.patch('/:id', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');
  const cache = c.get('runtime')?.cache;
  const parsed = DomainUpdateSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ errors: [{ code: 'VALIDATION', message: parsed.error.message, issues: parsed.error.issues }] }, 400);
  }
  const row = await loadDomain(db, siteId, c.req.param('id'));
  if (!row) return c.json({ errors: [{ code: 'NOT_FOUND', message: 'Domain not found.' }] }, 404);
  const { status } = parsed.data;
  let updated: DomainRow | undefined;
  try {
    // A live language entry is part of the site's address space: changed under the settings lock and
    // re-checked against the site's redirects (P05, design R36). Settings first, then the domain row,
    // read again under its lock: a concurrent switch of the primary domain cannot slip in between.
    updated = await runSiteTransaction(db, siteId, async (tx) => {
      await lockAddressSpace(tx, siteId);
      const [fresh] = await tx.select().from(siteDomains).where(and(eq(siteDomains.id, row.id), eq(siteDomains.siteId, siteId))).for('update');
      if (!fresh) throw new DomainRefusal('NOT_FOUND', 'Domain not found.', 404);
      if (status === 'active' && !fresh.verifiedAt) throw new DomainRefusal('NOT_VERIFIED', 'Verify the domain first.', 409);
      if (status === 'disabled' && fresh.isPrimary) {
        throw new DomainRefusal('PRIMARY', 'Make another domain primary before switching this one off.', 409);
      }
      const entryLocale = parsed.data.entryLocale
        ? await checkEntryLocale(tx as unknown as typeof db, siteId, parsed.data.entryLocale, { id: fresh.id, isPrimary: fresh.isPrimary })
        : parsed.data.entryLocale;
      const [one] = await tx
        .update(siteDomains)
        .set({
          ...(status ? { status } : {}),
          ...(entryLocale !== undefined ? { entryLocale } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(siteDomains.id, row.id), eq(siteDomains.siteId, siteId)))
        .returning();
      if (one?.status === 'active' && one.entryLocale) await assertSiteRulesTerminate(tx, siteId);
      return one;
    });
  } catch (err) {
    if (err instanceof DomainRefusal) return c.json({ errors: [{ code: err.code, message: err.message }] }, err.status);
    if (err instanceof LanguageEntryError) return c.json({ errors: [{ code: err.code, message: err.message }] }, err.status);
    if (err instanceof RedirectConflictError) {
      return c.json({ errors: [{ code: err.code, message: err.message, rules: err.rules }] }, 409);
    }
    if (isEntryLocaleTaken(err)) {
      return c.json({ errors: [{ code: 'ENTRY_TAKEN', message: 'Another domain became the entry for this language.' }] }, 409);
    }
    if (isUniqueViolation(err)) {
      return c.json({ errors: [{ code: 'DOMAIN_TAKEN', message: 'Another site uses this domain now.' }] }, 409);
    }
    throw err;
  }
  if (cache && updated) {
    if (updated.status === 'active') await putHostMapping(cache, updated.hostname, siteId);
    else await deleteHostMapping(cache, updated.hostname);
  }
  return c.json({ data: toResource(updated ?? row) });
});

/** Promote a domain to the site's canonical (primary) hostname. */
domainsRouter.post('/:id/primary', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');
  const id = c.req.param('id');

  const row = await loadDomain(db, siteId, id);
  if (!row) return c.json({ errors: [{ code: 'NOT_FOUND', message: 'Domain not found.' }] }, 404);
  // Settings first, then the domain row read again under its lock (P05): a language set meanwhile is seen.
  let updated: DomainRow | undefined;
  try {
    updated = await runSiteTransaction(db, siteId, async (tx) => {
      await lockAddressSpace(tx, siteId);
      const [fresh] = await tx.select().from(siteDomains).where(and(eq(siteDomains.id, id), eq(siteDomains.siteId, siteId))).for('update');
      if (!fresh) throw new DomainRefusal('NOT_FOUND', 'Domain not found.', 404);
      if (fresh.status !== 'active') throw new DomainRefusal('NOT_ACTIVE', 'Only an active domain can be primary.', 409);
      if (fresh.entryLocale) throw new DomainRefusal('LANGUAGE_ENTRY', 'A language entry domain cannot be primary; clear its language first.', 409);
      // Single primary per site: clear the rest and set this one together.
      await tx
        .update(siteDomains)
        .set({ isPrimary: false, updatedAt: new Date() })
        .where(and(eq(siteDomains.siteId, siteId), ne(siteDomains.id, id)));
      const [one] = await tx
        .update(siteDomains)
        .set({ isPrimary: true, updatedAt: new Date() })
        .where(and(eq(siteDomains.id, id), eq(siteDomains.siteId, siteId), eq(siteDomains.status, 'active')))
        .returning();
      return one;
    });
  } catch (err) {
    if (err instanceof DomainRefusal) return c.json({ errors: [{ code: err.code, message: err.message }] }, err.status);
    throw err;
  }

  return c.json({ data: toResource(updated ?? row) });
});

domainsRouter.delete('/:id', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');
  const cache = c.get('runtime')?.cache;
  const id = c.req.param('id');

  const row = await loadDomain(db, siteId, id);
  if (!row) return c.json({ errors: [{ code: 'NOT_FOUND', message: 'Domain not found.' }] }, 404);

  // In a site transaction: the public hosts follow (HeoPress P06).
  // The settings lock before the domain row, the order of a site deletion (P07, Codex review of batch 4b).
  await runSiteTransaction(db, siteId, async (tx) => {
    await lockAddressSpace(tx, siteId);
    await tx.delete(siteDomains).where(and(eq(siteDomains.id, id), eq(siteDomains.siteId, siteId)));
  });
  if (cache) await deleteHostMapping(cache, row.hostname);

  return c.body(null, 204);
});

function loadDomain(
  db: AppEnv['Variables']['db'],
  siteId: string,
  id: string,
): Promise<DomainRow | undefined> {
  return db
    .select()
    .from(siteDomains)
    .where(and(eq(siteDomains.id, id), eq(siteDomains.siteId, siteId)))
    .limit(1)
    .then((rows) => rows[0]);
}
