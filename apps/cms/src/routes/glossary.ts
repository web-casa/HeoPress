/**
 * A site's translation glossary (HeoPress v1.4, spec `ai/site-glossary`).
 *
 *   GET    /api/v1/glossary            list the site's entries (`?from=&to=` language pair, `limit`, `offset`)
 *   POST   /api/v1/glossary            add an entry
 *   PATCH  /api/v1/glossary/:id        change one entry (a patch is merged with the stored row before validation)
 *   DELETE /api/v1/glossary/:id        remove one entry
 *
 * The site is always the request's (`c.get('siteId')`, set by the tenant middleware), never the body: the table's
 * `site_id NOT NULL` and the same condition on every statement are what keep one site's terminology out of another's
 * translations. Reading is for the site's members, every change for its administrators (the same split as redirects).
 *
 * The rules and their cross-field constraints live in `@heopress/contracts/schemas` (`GlossaryEntryInputSchema`) so the
 * route, the Studio and any future importer agree on what a valid entry is. A (site, pair, term) duplicate is a `409`
 * naming the existing entry; the database's unique index is the authority, and a lost race is reported as the same 409.
 */
import { and, asc, count, eq, ne } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { glossary, type Database } from '@heopress/database';
import {
  GlossaryEntryInputSchema,
  GlossaryEntryUpdateSchema,
  GlossaryListQuerySchema,
  glossaryRuleOf,
  type GlossaryEntryInput,
} from '@heopress/contracts/schemas';
import type { AppEnv } from '../env';
import { requireSiteAdmin } from '../middleware/site-admin';
import { requireSiteMember } from '../middleware/site-member';
import { AuditLogger } from '../modules/audit/logger';
import { isUniqueViolation } from '../services/domains/domain-verification';
import { runSiteTransaction, type SiteTransaction } from '../services/rls-transaction';

export const glossaryRouter = new Hono<AppEnv>();
glossaryRouter.use('*', async (c, next) => (c.req.method === 'GET' ? requireSiteMember()(c, next) : requireSiteAdmin()(c, next)));

type GlossaryRow = typeof glossary.$inferSelect;

/** What the API returns: the stored entry with its rule normalized to the three accepted values. */
function resource(row: GlossaryRow) {
  return {
    id: row.id,
    siteId: row.siteId,
    sourceLang: row.sourceLang,
    targetLang: row.targetLang,
    term: row.term,
    translation: row.translation,
    rule: glossaryRuleOf(row.rule),
    note: row.note,
    createdAt: row.createdAt.toISOString(),
  };
}

function validation(c: Context<AppEnv>, issues: ReadonlyArray<{ message: string; path: PropertyKey[] }>): Response {
  return c.json(
    { errors: issues.map((issue) => ({ code: 'VALIDATION', message: issue.message, path: issue.path.map(String) })) },
    400,
  );
}

/** The existing entry a duplicate would replace, carried out of the transaction so the refusal can name it. */
class GlossaryDuplicateError extends Error {
  constructor(
    readonly existingId: string,
    readonly term: string,
  ) {
    super(`A glossary entry for "${term}" already exists in this language pair (${existingId}).`);
    this.name = 'GlossaryDuplicateError';
  }
}

/** An entry that became invalid after merging a patch: no statement ran, so the transaction rolls back untouched. */
class GlossaryInvalidError extends Error {
  constructor(readonly issues: ReadonlyArray<{ message: string; path: PropertyKey[] }>) {
    super('The merged entry is not valid.');
    this.name = 'GlossaryInvalidError';
  }
}

function duplicate(c: Context<AppEnv>, existingId: string | null, term: string): Response {
  return c.json(
    {
      errors: [
        {
          code: 'GLOSSARY_DUPLICATE',
          message: term
            ? `A glossary entry for "${term}" already exists in this language pair.`
            : 'A glossary entry for this term already exists in this language pair.',
          existingId,
        },
      ],
    },
    409,
  );
}

/** The entry a lost unique race collided with, so the 409 can still name it; null when it vanished meanwhile. */
async function existingIdFor(
  db: Database,
  siteId: string,
  entry: { sourceLang: string; targetLang: string; term: string },
): Promise<string | null> {
  const [row] = await db
    .select({ id: glossary.id })
    .from(glossary)
    .where(
      and(
        eq(glossary.siteId, siteId),
        eq(glossary.sourceLang, entry.sourceLang),
        eq(glossary.targetLang, entry.targetLang),
        eq(glossary.term, entry.term),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

function notFound(c: Context<AppEnv>): Response {
  return c.json({ errors: [{ code: 'NOT_FOUND', message: 'Glossary entry not found' }] }, 404);
}

/** One audit row belonging to the change, written inside its transaction (HeoPress P04/P10 convention). */
function audit(
  c: Context<AppEnv>,
  tx: SiteTransaction,
  event: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  const auth = c.get('auth');
  return new AuditLogger({ db: tx as unknown as Database, siteId: c.get('siteId') }).writeInTransaction(tx, {
    siteId: c.get('siteId'),
    event,
    actorEmail: auth?.email ?? null,
    ip: c.get('ip') ?? null,
    userAgent: c.get('userAgent') ?? null,
    requestId: c.get('requestId') ?? null,
    metadata,
  });
}

// ── GET /glossary ───────────────────────────────────────────────────────────

glossaryRouter.get('/', async (c) => {
  const parsed = GlossaryListQuerySchema.safeParse(c.req.query());
  if (!parsed.success) return validation(c, parsed.error.issues);
  const { from, to, limit, offset } = parsed.data;
  const siteId = c.get('siteId');

  const where = and(
    eq(glossary.siteId, siteId),
    from ? eq(glossary.sourceLang, from) : undefined,
    to ? eq(glossary.targetLang, to) : undefined,
  );
  const [rows, totalRow] = await Promise.all([
    c.get('db').select().from(glossary).where(where).orderBy(asc(glossary.term), asc(glossary.id)).limit(limit).offset(offset),
    c.get('db').select({ value: count() }).from(glossary).where(where),
  ]);

  return c.json({ data: rows.map(resource), meta: { total: totalRow[0]?.value ?? 0, limit, offset } });
});

// ── POST /glossary ──────────────────────────────────────────────────────────

glossaryRouter.post('/', async (c) => {
  const parsed = GlossaryEntryInputSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return validation(c, parsed.error.issues);
  const siteId = c.get('siteId');
  const input: GlossaryEntryInput = parsed.data;

  try {
    const created = await runSiteTransaction(c.get('db'), siteId, async (tx) => {
      const [existing] = await tx
        .select({ id: glossary.id })
        .from(glossary)
        .where(
          and(
            eq(glossary.siteId, siteId),
            eq(glossary.sourceLang, input.sourceLang),
            eq(glossary.targetLang, input.targetLang),
            eq(glossary.term, input.term),
          ),
        )
        .limit(1);
      if (existing) throw new GlossaryDuplicateError(existing.id, input.term);

      const [row] = await tx
        .insert(glossary)
        .values({
          siteId,
          sourceLang: input.sourceLang,
          targetLang: input.targetLang,
          term: input.term,
          translation: input.translation,
          rule: input.rule,
          note: input.note ?? null,
        })
        .returning();
      await audit(c, tx, 'glossary.created', { id: row!.id, ...auditFields(row!) });
      return row!;
    });
    return c.json({ data: resource(created) }, 201);
  } catch (err) {
    if (err instanceof GlossaryDuplicateError) return duplicate(c, err.existingId, err.term);
    // The unique index is the authority: a create that lost a race still answers the same 409, not a 500.
    if (isUniqueViolation(err)) {
      return duplicate(c, await existingIdFor(c.get('db'), siteId, input), input.term);
    }
    throw err;
  }
});

// ── PATCH /glossary/:id ─────────────────────────────────────────────────────

glossaryRouter.patch('/:id', async (c) => {
  const parsed = GlossaryEntryUpdateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return validation(c, parsed.error.issues);
  const siteId = c.get('siteId');
  const id = c.req.param('id');
  const patch = parsed.data;

  try {
    const updated = await runSiteTransaction(c.get('db'), siteId, async (tx) => {
      const [current] = await tx
        .select()
        .from(glossary)
        .where(and(eq(glossary.siteId, siteId), eq(glossary.id, id)))
        .for('update');
      if (!current) return null;

      // Cross-field rules cannot be checked on a patch alone: merge it with the stored row, then validate that entry.
      const merged = GlossaryEntryInputSchema.safeParse({
        sourceLang: patch.sourceLang ?? current.sourceLang,
        targetLang: patch.targetLang ?? current.targetLang,
        term: patch.term ?? current.term,
        translation: patch.translation ?? current.translation,
        rule: patch.rule ?? current.rule,
        note: patch.note === undefined ? current.note : patch.note,
      });
      if (!merged.success) throw new GlossaryInvalidError(merged.error.issues);
      const next = merged.data;

      const pairOrTermChanged =
        next.sourceLang !== current.sourceLang || next.targetLang !== current.targetLang || next.term !== current.term;
      if (pairOrTermChanged) {
        const [clash] = await tx
          .select({ id: glossary.id })
          .from(glossary)
          .where(
            and(
              eq(glossary.siteId, siteId),
              ne(glossary.id, id),
              eq(glossary.sourceLang, next.sourceLang),
              eq(glossary.targetLang, next.targetLang),
              eq(glossary.term, next.term),
            ),
          )
          .limit(1);
        if (clash) throw new GlossaryDuplicateError(clash.id, next.term);
      }

      const [row] = await tx
        .update(glossary)
        .set({
          sourceLang: next.sourceLang,
          targetLang: next.targetLang,
          term: next.term,
          translation: next.translation,
          rule: next.rule,
          note: next.note ?? null,
        })
        .where(and(eq(glossary.siteId, siteId), eq(glossary.id, id)))
        .returning();
      await audit(c, tx, 'glossary.updated', { id, before: auditFields(current), after: auditFields(row!) });
      return row!;
    });
    return updated ? c.json({ data: resource(updated) }) : notFound(c);
  } catch (err) {
    if (err instanceof GlossaryInvalidError) return validation(c, err.issues);
    if (err instanceof GlossaryDuplicateError) return duplicate(c, err.existingId, err.term);
    // A patch that raced another writer into the same (pair, term) still answers 409; the winner is not known here.
    if (isUniqueViolation(err)) return duplicate(c, null, patch.term ?? '');
    throw err;
  }
});

// ── DELETE /glossary/:id ────────────────────────────────────────────────────

glossaryRouter.delete('/:id', async (c) => {
  const siteId = c.get('siteId');
  const id = c.req.param('id');

  const removed = await runSiteTransaction(c.get('db'), siteId, async (tx) => {
    const [current] = await tx
      .select()
      .from(glossary)
      .where(and(eq(glossary.siteId, siteId), eq(glossary.id, id)))
      .for('update');
    if (!current) return null;
    await tx.delete(glossary).where(and(eq(glossary.siteId, siteId), eq(glossary.id, id)));
    await audit(c, tx, 'glossary.deleted', { id, ...auditFields(current) });
    return current;
  });

  return removed ? c.json({ data: { id } }) : notFound(c);
});

/** The part of an entry the audit trail keeps (never a whole translation body, and no secret exists here). */
function auditFields(row: GlossaryRow): Record<string, unknown> {
  return {
    sourceLang: row.sourceLang,
    targetLang: row.targetLang,
    term: row.term,
    rule: glossaryRuleOf(row.rule),
  };
}
