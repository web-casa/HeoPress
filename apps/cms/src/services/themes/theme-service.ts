import { createHash } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import {
  notifications,
  roles,
  siteContentSettings,
  sites,
  siteThemes,
  themeAssets,
  themes,
  themeVersions,
  type Database,
  type ThemeAssetEntry,
  type ThemeChecks,
  userSites,
} from '@heopress/database';
import { runThemeChecks, STARTER_THEMES, THEME_CHECKS_VERSION, type StarterName } from '@heopress/public-site';
import { AuditLogger } from '../../modules/audit/logger';
import { appendItemEvent } from '../../modules/cdc/change-feed/outbox-writer';
import { runSiteTransaction, type SiteTransaction } from '../rls-transaction';
import { lockContentSettingsExclusive, withTransactionRetry } from '../site-network/translation-groups';

/**
 * Site themes (HeoPress P06 tasks 2.3, 2.4, 2.7; design §5, R6, R23, R34): immutable versions, checked before
 * they can go live, and the site's pointer to its active one.
 *
 *   - `createVersion`: templates and assets in, one transaction: the theme (by name), the version, its
 *     assets, sealed by the database (`heopress_seal_theme_version`), and the pre-publication checks
 *     (static checks and smoke rendering of every page type, disclosure off and on) for its content hash.
 *   - `activate`: publish a version, switch to another or roll back to an earlier one — the same act. Under
 *     the site's settings row (exclusively, the lock the sponsor policy is changed under), the version's
 *     checks are confirmed current and passing, and, while explicit sponsor disclosure is on, its
 *     disclosure slots too; otherwise nothing changes. The pointer, the audit record, the `theme` event
 *     and (through the projection gate) the render version change in one transaction.
 *   - A site without an active version renders with the built-in theme.
 */

type Tx = SiteTransaction;

export class ThemeServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 404 | 409 | 413 | 422,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export interface ThemeActor {
  userId: string | null;
  apiKeyId?: string | null;
  email?: string | null;
}

export interface ThemeVersionInput {
  /** The theme's name (a version belongs to one theme of the site). */
  name: string;
  templates: Record<string, string>;
  assets?: Array<{ path: string; contentType: string; base64: string }>;
}

const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ASSET_PATH = /^[a-z0-9_-]+(\/[a-z0-9_-]+)*\.[a-z0-9]+$/;
const MAX_TEMPLATES = 200;
const MAX_TEMPLATE_CHARS = 200_000;
const MAX_ASSETS = 200;
const MAX_ASSET_BYTES = 2 * 1024 * 1024;
const MAX_VERSION_BYTES = 20 * 1024 * 1024;
/** What an asset may be: served from the site's own domain, so nothing that runs as a document. */
const ASSET_TYPES: Record<string, string[]> = {
  'text/css': ['css'],
  'text/javascript': ['js', 'mjs'],
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/gif': ['gif'],
  'image/webp': ['webp'],
  'image/avif': ['avif'],
  'image/svg+xml': ['svg'],
  'image/x-icon': ['ico'],
  'font/woff2': ['woff2'],
  'font/woff': ['woff'],
};

const principalOf = (actor: ThemeActor) =>
  actor.apiKeyId ? { type: 'api_key' as const, id: actor.apiKeyId } : actor.userId ? { type: 'user' as const, id: actor.userId } : { type: 'system' as const, id: 'system' };

/** Checks for a version's current content, done again when missing or by an older checker. */
async function currentChecks(version: typeof themeVersions.$inferSelect): Promise<ThemeChecks> {
  const c = version.checks;
  if (c && c.validator === THEME_CHECKS_VERSION && c.contentHash === version.contentHash) return c;
  const result = await runThemeChecks(version.templates, version.assets, version.id);
  return { ...result, contentHash: version.contentHash!, checkedAt: new Date().toISOString() };
}

/**
 * Whether the site's active theme version may stay active with explicit disclosure on (the built-in theme
 * may). Called under the settings row lock by the settings update that switches disclosure on.
 */
export async function activeThemeAllowsDisclosure(tx: Tx, siteId: string): Promise<boolean> {
  const [row] = await tx
    .select({ version: themeVersions })
    .from(siteThemes)
    .innerJoin(themeVersions, and(eq(themeVersions.id, siteThemes.themeVersionId), eq(themeVersions.siteId, siteThemes.siteId)))
    .where(eq(siteThemes.siteId, siteId));
  if (!row) return true;
  const checks = await currentChecks(row.version);
  if (checks !== row.version.checks) await tx.update(themeVersions).set({ checks }).where(and(eq(themeVersions.id, row.version.id), eq(themeVersions.siteId, siteId)));
  return checks.ok && checks.disclosureOk;
}

export type RecheckOutcome = 'none' | 'current' | 'passed' | 'reverted';

/**
 * A site's active theme version checked again by the current checker (HeoPress P07 task 2.4: the checks now refuse
 * theme JSON-LD; the rendering view serves only versions checked by the current checker that passed — migrations 0066–0068). A version that
 * passes stays and is served again (the render version rises); one that fails — or lacks the disclosure slots while
 * explicit disclosure is on, or carries current checks that failed — goes: the site renders with the built-in theme (the pointer is removed under the settings row, as `activate`
 * writes it; the projection gate raises the render version), a `theme` event and an audit record follow, and every
 * administrator of the site is notified. Versions checked by the current checker are left alone.
 */
export async function recheckActiveTheme(db: Database, siteId: string): Promise<RecheckOutcome> {
  return withTransactionRetry(db, () =>
    runSiteTransaction(db, siteId, async (tx) => {
      await lockContentSettingsExclusive(tx, siteId);
      const [row] = await tx
        .select({ pointer: siteThemes, version: themeVersions, name: themes.name })
        .from(siteThemes)
        .innerJoin(themeVersions, and(eq(themeVersions.id, siteThemes.themeVersionId), eq(themeVersions.siteId, siteThemes.siteId)))
        .innerJoin(themes, and(eq(themes.id, themeVersions.themeId), eq(themes.siteId, siteId)))
        .where(eq(siteThemes.siteId, siteId))
        .for('update', { of: siteThemes });
      if (!row) return 'none';
      const checks = await currentChecks(row.version);
      const [settings] = await tx.select({ disclosure: siteContentSettings.sponsorDisclosure }).from(siteContentSettings).where(eq(siteContentSettings.siteId, siteId));
      const acceptable = checks.ok && (settings?.disclosure === false || checks.disclosureOk);
      if (checks === row.version.checks && acceptable) return 'current';
      if (checks !== row.version.checks) await tx.update(themeVersions).set({ checks }).where(and(eq(themeVersions.id, row.version.id), eq(themeVersions.siteId, siteId)));
      if (acceptable) {
        // Served again (the rendering view returns a version checked by the current checker that passed): the pointer's
        // version rises, as `activate` writes it — the projection gate raises the render version, and no page cached
        // meanwhile with the built-in theme is served again.
        await tx.update(siteThemes).set({ version: sql`${siteThemes.version} + 1`, updatedAt: new Date() }).where(eq(siteThemes.siteId, siteId));
        return 'passed';
      }
      await tx.delete(siteThemes).where(eq(siteThemes.siteId, siteId));
      await appendItemEvent(tx, {
        siteId,
        resource: 'theme',
        collection: '$site',
        itemId: siteId,
        itemVersion: row.pointer.version + 1,
        changedFields: ['theme'],
        actor: { type: 'system', id: 'system' },
        source: 'system',
        payload: { theme: { versionId: null, previousVersionId: row.version.id } },
      });
      await new AuditLogger({ db: tx as unknown as Database, siteId }).writeInTransaction(tx, {
        siteId,
        event: 'theme_version_deactivated',
        actorEmail: null,
        metadata: { reason: 'checks', versionId: row.version.id, theme: row.name, number: row.version.number, validator: checks.validator, issues: checks.issues.slice(0, 20) },
      });
      const admins = await tx
        .selectDistinct({ userId: userSites.userId })
        .from(userSites)
        .innerJoin(roles, and(eq(roles.id, userSites.roleId), eq(roles.siteId, userSites.siteId)))
        .where(and(eq(userSites.siteId, siteId), eq(roles.adminAccess, true)));
      const first = checks.issues[0]?.message;
      if (admins.length) {
        await tx.insert(notifications).values(
          admins.map((a) => ({
            siteId,
            recipient: a.userId,
            subject: `Theme "${row.name}" version ${row.version.number} was switched off`,
            message: `It no longer passes the theme checks, so the site now uses the built-in theme.${first ? ` First issue: ${first}` : ''} Publish a version that passes to use your theme again.`,
          })),
        );
      }
      return 'reverted';
    }),
  );
}

/** Every site's active theme version checked again where an older checker checked it (the worker's job). */
export async function recheckActiveThemes(db: Database): Promise<Record<RecheckOutcome, string[]>> {
  const out: Record<RecheckOutcome, string[]> = { none: [], current: [], passed: [], reverted: [] };
  for (const { id } of await db.select({ id: sites.id }).from(sites).orderBy(sites.id)) {
    try {
      out[await recheckActiveTheme(db, id)].push(id);
    } catch (err) {
      // One site's failure never holds the others back; the next run tries it again.
      console.error(`[theme-recheck] site ${id} failed:`, err instanceof Error ? err.message : String(err));
    }
  }
  return out;
}

export class ThemeService {
  constructor(private readonly deps: { db: Database; siteId: string; actor: ThemeActor }) {}

  private tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withTransactionRetry(this.deps.db, () => runSiteTransaction(this.deps.db, this.deps.siteId, fn));
  }

  /** Validate and decode an upload (before any transaction). */
  private prepare(input: ThemeVersionInput) {
    if (!NAME.test(input.name)) throw new ThemeServiceError('VALIDATION', 'Theme names are lowercase letters, digits and hyphens.', 400);
    const entries = Object.entries(input.templates ?? {});
    if (entries.length === 0 || entries.length > MAX_TEMPLATES) throw new ThemeServiceError('VALIDATION', `A theme version has 1–${MAX_TEMPLATES} templates.`, 400);
    for (const [name, source] of entries) {
      if (typeof source !== 'string') throw new ThemeServiceError('VALIDATION', `Template "${name}" is not text.`, 400);
      if (source.length > MAX_TEMPLATE_CHARS) throw new ThemeServiceError('TOO_LARGE', `Template "${name}" is larger than ${MAX_TEMPLATE_CHARS} characters.`, 413);
    }
    // Count and encoded sizes first, before anything is decoded.
    const uploads = input.assets ?? [];
    if (uploads.length > MAX_ASSETS) throw new ThemeServiceError('VALIDATION', `A theme version has at most ${MAX_ASSETS} assets.`, 400);
    let encodedTotal = 0;
    for (const a of uploads) {
      if (typeof a?.base64 !== 'string' || typeof a.path !== 'string' || typeof a.contentType !== 'string') throw new ThemeServiceError('VALIDATION', 'Each asset is { path, contentType, base64 }.', 400);
      const decodedAtMost = Math.floor((a.base64.length * 3) / 4);
      if (decodedAtMost > MAX_ASSET_BYTES + 3) throw new ThemeServiceError('TOO_LARGE', `Asset "${a.path}" is larger than 2 MB.`, 413);
      encodedTotal += decodedAtMost;
      if (encodedTotal > MAX_VERSION_BYTES + 3 * uploads.length) throw new ThemeServiceError('TOO_LARGE', 'A theme version’s assets are larger than 20 MB.', 413);
    }
    const assets = uploads.map((a) => {
      if (!ASSET_PATH.test(a.path)) throw new ThemeServiceError('VALIDATION', `Asset path "${a.path}" is not a lowercase relative path with an extension.`, 400);
      const ext = a.path.slice(a.path.lastIndexOf('.') + 1);
      if (!(ASSET_TYPES[a.contentType] ?? []).includes(ext)) throw new ThemeServiceError('VALIDATION', `Asset "${a.path}": type ${a.contentType} is not allowed for .${ext}.`, 400);
      const bytes = Buffer.from(a.base64, 'base64');
      if (bytes.length > MAX_ASSET_BYTES) throw new ThemeServiceError('TOO_LARGE', `Asset "${a.path}" is larger than 2 MB.`, 413);
      return { path: a.path, contentType: a.contentType, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
    });
    if (assets.length > MAX_ASSETS) throw new ThemeServiceError('VALIDATION', `A theme version has at most ${MAX_ASSETS} assets.`, 400);
    if (assets.reduce((n, a) => n + a.bytes.length, 0) > MAX_VERSION_BYTES) throw new ThemeServiceError('TOO_LARGE', 'A theme version’s assets are larger than 20 MB.', 413);
    const paths = assets.map((a) => a.path);
    if (new Set(paths).size !== paths.length) throw new ThemeServiceError('VALIDATION', 'Asset paths must be distinct.', 400);
    assets.sort((a, b) => (a.path < b.path ? -1 : 1));
    const manifest: ThemeAssetEntry[] = assets.map((a) => ({ path: a.path, sha256: a.sha256, contentType: a.contentType, size: a.bytes.length }));
    return { templates: Object.fromEntries(entries), assets, manifest };
  }

  /**
   * Install a starter theme (P06 task 5.1) as a new version of the site's theme of that name: an ordinary
   * upload, checked and sealed; activating it is a separate step.
   */
  async installStarter(name: string) {
    const starter = Object.hasOwn(STARTER_THEMES, name) ? STARTER_THEMES[name as StarterName] : undefined;
    if (!starter) throw new ThemeServiceError('NOT_FOUND', `No starter theme "${name}" (${Object.keys(STARTER_THEMES).join(', ')}).`, 404);
    return this.createVersion({
      name: starter.name,
      templates: starter.templates,
      assets: starter.assets.map((a) => ({ path: a.path, contentType: a.contentType, base64: Buffer.from(a.text, 'utf8').toString('base64') })),
    });
  }

  /** A new, sealed, checked version (not active: `activate` publishes it). */
  async createVersion(input: ThemeVersionInput) {
    const { siteId, actor } = this.deps;
    const { templates, assets, manifest } = this.prepare(input);
    const id = nanoid();
    // Checked before the transaction (no lock held while rendering samples); bound to the content hash below.
    const result = await runThemeChecks(templates, manifest, id);
    return this.tx(async (tx) => {
      await tx.insert(themes).values({ siteId, name: input.name }).onConflictDoNothing({ target: [themes.siteId, themes.name] });
      const [theme] = await tx.select().from(themes).where(and(eq(themes.siteId, siteId), eq(themes.name, input.name))).for('update');
      const [last] = await tx
        .select({ n: sql<number>`coalesce(max(${themeVersions.number}), 0)`.mapWith(Number) })
        .from(themeVersions)
        .where(and(eq(themeVersions.themeId, theme!.id), eq(themeVersions.siteId, siteId)));
      await tx.insert(themeVersions).values({ id, siteId, themeId: theme!.id, number: (last?.n ?? 0) + 1, templates, assets: manifest, createdBy: actor.userId });
      if (assets.length) {
        await tx.insert(themeAssets).values(assets.map((a) => ({ versionId: id, siteId, path: a.path, sha256: a.sha256, contentType: a.contentType, bytes: a.bytes })));
      }
      const [sealed] = (await tx.execute(sql`SELECT heopress_seal_theme_version(${id}, ${siteId}) AS hash`)) as unknown as Array<{ hash: string }>;
      const hash = sealed!.hash;
      const checks: ThemeChecks = { ...result, contentHash: hash, checkedAt: new Date().toISOString() };
      const [row] = await tx.update(themeVersions).set({ checks }).where(and(eq(themeVersions.id, id), eq(themeVersions.siteId, siteId))).returning();
      await new AuditLogger({ db: tx as unknown as Database, siteId }).writeInTransaction(tx, {
        siteId,
        event: 'theme_version_created',
        actorEmail: actor.email ?? null,
        metadata: { versionId: id, theme: input.name, number: row!.number, contentHash: hash, checks: { ok: checks.ok, disclosureOk: checks.disclosureOk } },
      });
      return summary(row!, input.name, false);
    });
  }

  /** Every version of the site's themes, newest first, with its checks and whether it is active. */
  async list() {
    const { siteId } = this.deps;
    return this.tx(async (tx) => {
      const [pointer] = await tx.select().from(siteThemes).where(eq(siteThemes.siteId, siteId));
      const rows = await tx
        .select({ version: themeVersions, name: themes.name })
        .from(themeVersions)
        .innerJoin(themes, and(eq(themes.id, themeVersions.themeId), eq(themes.siteId, themeVersions.siteId)))
        .where(eq(themeVersions.siteId, siteId))
        .orderBy(desc(themeVersions.createdAt));
      return rows.map((r) => summary(r.version, r.name, r.version.id === pointer?.themeVersionId));
    });
  }

  /**
   * Make a version the site's active one: publish it (first time), switch to it, or roll back to it. With
   * explicit sponsor disclosure on, a version without the disclosure slots is refused and the site keeps
   * its current version (spec "披露开启时回滚到无插槽版本").
   */
  async activate(versionId: string) {
    const { siteId, actor } = this.deps;
    return this.tx(async (tx) => {
      await lockContentSettingsExclusive(tx, siteId);
      const [settings] = await tx.select({ disclosure: siteContentSettings.sponsorDisclosure }).from(siteContentSettings).where(eq(siteContentSettings.siteId, siteId));
      const [row] = await tx
        .select({ version: themeVersions, name: themes.name })
        .from(themeVersions)
        .innerJoin(themes, and(eq(themes.id, themeVersions.themeId), eq(themes.siteId, themeVersions.siteId)))
        .where(and(eq(themeVersions.id, versionId), eq(themeVersions.siteId, siteId)))
        .for('update', { of: themeVersions });
      if (!row) throw new ThemeServiceError('NOT_FOUND', 'No such theme version on this site.', 404);
      const version = row.version;
      if (!version.sealedAt) throw new ThemeServiceError('NOT_SEALED', 'This theme version was never completed.', 409);
      const checks = await currentChecks(version);
      if (checks !== version.checks) await tx.update(themeVersions).set({ checks }).where(and(eq(themeVersions.id, version.id), eq(themeVersions.siteId, siteId)));
      if (!checks.ok) throw new ThemeServiceError('THEME_CHECKS_FAILED', 'This theme version did not pass the pre-publication checks.', 422, { issues: checks.issues });
      if (settings?.disclosure !== false && !checks.disclosureOk) {
        throw new ThemeServiceError(
          'THEME_LACKS_DISCLOSURE_SLOT',
          'Explicit sponsor disclosure is on and this theme version lacks the disclosure slots (before the body, inside sponsored cards). Publish a version that has them, or switch disclosure off first.',
          409,
          { issues: checks.issues },
        );
      }
      const [previous] = await tx.select().from(siteThemes).where(eq(siteThemes.siteId, siteId)).for('update');
      const firstPublication = !version.publishedAt;
      if (firstPublication) await tx.update(themeVersions).set({ publishedAt: new Date() }).where(and(eq(themeVersions.id, version.id), eq(themeVersions.siteId, siteId)));
      const [pointer] = await tx
        .insert(siteThemes)
        .values({ siteId, themeVersionId: version.id })
        .onConflictDoUpdate({ target: siteThemes.siteId, set: { themeVersionId: version.id, version: sql`${siteThemes.version} + 1`, updatedAt: new Date() } })
        .returning();
      await appendItemEvent(tx, {
        siteId,
        resource: 'theme',
        collection: '$site',
        itemId: siteId,
        itemVersion: pointer!.version,
        changedFields: ['theme'],
        actor: principalOf(actor),
        source: 'api',
        payload: { theme: { versionId: version.id, previousVersionId: previous?.themeVersionId ?? null } },
      });
      await new AuditLogger({ db: tx as unknown as Database, siteId }).writeInTransaction(tx, {
        siteId,
        event: firstPublication ? 'theme_version_published' : 'theme_version_activated',
        actorEmail: actor.email ?? null,
        metadata: { operator: actor.userId, versionId: version.id, theme: row.name, number: version.number, previousVersionId: previous?.themeVersionId ?? null },
      });
      return summary({ ...version, checks, publishedAt: version.publishedAt ?? new Date() }, row.name, true);
    });
  }
}

function summary(v: typeof themeVersions.$inferSelect, name: string, active: boolean) {
  return {
    id: v.id,
    theme: name,
    number: v.number,
    contentHash: v.contentHash,
    assets: v.assets,
    templates: Object.keys(v.templates).sort(),
    checks: v.checks ? { ok: v.checks.ok, disclosureOk: v.checks.disclosureOk, validator: v.checks.validator, issues: v.checks.issues } : null,
    createdAt: v.createdAt,
    publishedAt: v.publishedAt,
    active,
  };
}
