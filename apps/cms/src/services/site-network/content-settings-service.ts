import { and, eq, sql } from 'drizzle-orm';
import { LocalePrefixSchema, parsePermalinkPattern, sameLocale, type SiteContentSettingsInput } from '@heopress/contracts/schemas';
import { collections, siteContentSettings, sites, type Database } from '@heopress/database';
import { AuditLogger } from '../../modules/audit/logger';
import { ItemServiceError } from '../item-service-error';
import { appendItemEvent } from '../../modules/cdc/change-feed/outbox-writer';
import { runSiteTransaction, type SiteTransaction } from '../rls-transaction';
import { ensureContentSettings } from './preset-installer';
import { rebuildRoutes, routeFirstSegments, writePrefixMoves } from './content-routes';
import { isReservedSegment, readAdminSegment } from './reserved-paths';
import { loadSpace, lockAddressSpace, rejectedRuleIds } from './site-rules';
import type { SitePathSpace } from '@heopress/public-site';
import { crossSiteGroupsOf, followDefaultLocale, withTransactionRetry, writeGroupEvents } from './translation-groups';
import { activeThemeAllowsDisclosure } from '../themes/theme-service';

/**
 * A site's content settings (HeoPress P05 tasks 1.2, 1.9, 3.5; design A, F):
 * languages, time zone, site type, URL policy, permalink patterns, the
 * cross-site translation switch and the sponsored-content policy.
 *
 * - The row is updated under its own lock (`FOR UPDATE`, design §0) with a
 *   version check: a stale form is a 409, not a silent overwrite.
 * - The site's default language (`sites.default_language`) is always one of
 *   its languages; the same check guards `PATCH /site`.
 * - Language prefixes: lowercase segments, one per language, never a
 *   reserved top-level path.
 * - Sponsor policy (ADR-0016): any change needs a reason and is audited;
 *   switching a policy off also needs the risk of that switch acknowledged.
 */

export class ContentSettingsError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 404 | 409 | 422,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ContentSettingsError';
  }
}

/** What switching each sponsor policy off risks — shown before the operator confirms (ADR-0016). */
const SPONSOR_RISKS: Record<'disclosure' | 'rel', string> = {
  disclosure:
    'Without a visible disclosure, readers cannot tell sponsored content from editorial content. Advertising rules in many jurisdictions require the disclosure, and search engines may treat undisclosed sponsorship as deceptive.',
  rel:
    'Without rel="sponsored", paid links pass ranking signals. Search engines treat that as a link scheme and may penalise the site.',
};

export type ContentSettings = typeof siteContentSettings.$inferSelect;

export interface ContentSettingsDeps {
  db: Database;
  siteId: string;
  /** The operator (audit). */
  /** Who changes the settings: a user, or an API key (no user). */
  actor: { userId: string | null; apiKeyId?: string | null; email?: string | null };
}

const principalOf = (actor: ContentSettingsDeps['actor']): { type: 'user' | 'api_key' | 'system'; id: string | null } =>
  actor.userId ? { type: 'user', id: actor.userId } : actor.apiKeyId ? { type: 'api_key', id: actor.apiKeyId } : { type: 'system', id: null };

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The prefix a language uses when none is configured: its tag, lowercased. */
const defaultPrefixOf = (locale: string): string => locale.toLowerCase();

/** The settings a change event names when they changed. */
const SETTINGS_FIELDS = [
  'availableLocales',
  'timezone',
  'siteType',
  'trailingSlash',
  'localeStrategy',
  'localePrefixMode',
  'localePrefixes',
  'permalinks',
  'allowCrossSiteTranslations',
  'sponsorDisclosure',
  'sponsorRel',
] as const;

/** Refuse a change after which some stored redirect would not provably terminate (design R36). */
async function assertRulesTerminate(tx: SiteTransaction, siteId: string, space: SitePathSpace): Promise<void> {
  const rejected = await rejectedRuleIds(tx, siteId, space);
  if (rejected.size > 0) {
    throw new ContentSettingsError('REDIRECT_CONFLICT', 'With this change some redirects could loop; nothing was changed.', 409, {
      rules: [...rejected].map(([id, reason]) => ({ id, reason })),
    });
  }
}

/** The prefixes that are addresses (the default language's is not, under default_at_root). */
function addressPrefixes(
  settings: { availableLocales: string[]; localeStrategy: string; localePrefixMode: string },
  prefixes: Record<string, string>,
  defaultLanguage: string,
): string[] {
  if (settings.localeStrategy !== 'subdirectory') return [];
  return settings.availableLocales
    .filter((l) => !(settings.localePrefixMode === 'default_at_root' && sameLocale(l, defaultLanguage)))
    .map((l) => Object.entries(prefixes).find(([k]) => sameLocale(k, l))?.[1] ?? defaultPrefixOf(l));
}

/** Languages kept under the subdirectory strategy whose address prefix changed: old → new. */
function prefixMoves(current: ContentSettings, input: SiteContentSettingsInput, next: Record<string, string>, defaultLanguage: string): Array<{ from: string; to: string }> {
  if (current.localeStrategy !== 'subdirectory' || input.localeStrategy !== 'subdirectory') return [];
  const out: Array<{ from: string; to: string }> = [];
  for (const locale of input.availableLocales) {
    if (!current.availableLocales.some((l) => sameLocale(l, locale))) continue;
    const isDefault = sameLocale(locale, defaultLanguage);
    const before = isDefault && current.localePrefixMode === 'default_at_root' ? null : addressPrefixes({ ...current, availableLocales: [locale] }, current.localePrefixes ?? {}, '\u0000')[0];
    const after = isDefault && input.localePrefixMode === 'default_at_root' ? null : addressPrefixes({ ...input, availableLocales: [locale] }, next, '\u0000')[0];
    if (before && after && before !== after) out.push({ from: before, to: after });
  }
  return out;
}

/** Collections whose paths change: a new or changed pattern, or a time zone change for patterns with dates. */
function affectedCollections(current: ContentSettings, input: SiteContentSettingsInput): string[] {
  const out = new Set<string>();
  const before = current.permalinks ?? {};
  for (const [collection, pattern] of Object.entries(input.permalinks)) {
    if (before[collection] !== pattern) out.add(collection);
  }
  for (const collection of Object.keys(before)) if (!(collection in input.permalinks)) out.add(collection);
  if (current.timezone !== input.timezone) {
    for (const [collection, pattern] of Object.entries(input.permalinks)) {
      const parsed = parsePermalinkPattern(pattern);
      if (parsed.ok && parsed.segments.some((seg) => seg.kind === 'variable' && ['year', 'month', 'day'].includes(seg.name))) out.add(collection);
    }
  }
  return [...out];
}

export class ContentSettingsService {
  constructor(private readonly deps: ContentSettingsDeps) {}

  private tx<T>(fn: (tx: SiteTransaction) => Promise<T>): Promise<T> {
    // The projection flush locks the other sites of cross-site groups (P06): a deadlock is retried.
    return withTransactionRetry(this.deps.db, () => runSiteTransaction(this.deps.db, this.deps.siteId, fn));
  }

  async get(): Promise<ContentSettings> {
    return this.tx(async (tx) => {
      await ensureContentSettings(tx as unknown as Database, this.deps.siteId);
      const [row] = await tx.select().from(siteContentSettings).where(eq(siteContentSettings.siteId, this.deps.siteId));
      return row!;
    });
  }

  async update(input: SiteContentSettingsInput): Promise<ContentSettings> {
    const { siteId } = this.deps;
    if (!isValidTimeZone(input.timezone)) throw new ContentSettingsError('VALIDATION', `Unknown time zone "${input.timezone}".`, 400);
    return this.tx(async (tx) => {
      await ensureContentSettings(tx as unknown as Database, siteId);
      const [current] = await tx.select().from(siteContentSettings).where(eq(siteContentSettings.siteId, siteId)).for('update');
      if (!current) throw new ContentSettingsError('NOT_FOUND', 'Site not found.', 404);
      if (current.version !== input.version) {
        throw new ContentSettingsError('VERSION_CONFLICT', 'The settings changed since they were read; reload them.', 409, { version: current.version });
      }
      const [site] = await tx.select({ defaultLanguage: sites.defaultLanguage }).from(sites).where(eq(sites.id, siteId));
      const locales = input.availableLocales;
      if (!locales.some((l) => sameLocale(l, site!.defaultLanguage))) {
        throw new ContentSettingsError('DEFAULT_LANGUAGE_MISSING', `The site's default language "${site!.defaultLanguage}" must be one of its languages.`, 422);
      }
      const prefixes = this.prefixesFor(input, await readAdminSegment(tx));
      // Prefixes are live only under the subdirectory strategy: switching to it makes all of them new.
      if (input.localeStrategy === 'subdirectory') {
        const before = current.localeStrategy === 'subdirectory' ? (current.localePrefixes ?? {}) : {};
        await this.checkPrefixesAgainstPaths(tx, prefixes, before);
      }
      await this.checkPermalinkCollections(tx, Object.keys(input.permalinks));

      const sponsorChanged = current.sponsorDisclosure !== input.sponsorDisclosure || current.sponsorRel !== input.sponsorRel;
      if (sponsorChanged) this.checkSponsorChange(current, input);
      // Explicit disclosure on: the active theme must have the disclosure slots (HeoPress P06 task 2.7; spec
      // "重新开启披露时主题缺插槽"). Checked under this row's lock, the one theme activation takes.
      if (!current.sponsorDisclosure && input.sponsorDisclosure && !(await activeThemeAllowsDisclosure(tx, siteId))) {
        throw new ContentSettingsError(
          'THEME_LACKS_DISCLOSURE_SLOT',
          'The active theme version lacks the sponsor disclosure slots: publish a theme version that has them before switching explicit disclosure on.',
          409,
        );
      }

      const [row] = await tx
        .update(siteContentSettings)
        .set({
          availableLocales: locales,
          timezone: input.timezone,
          siteType: input.siteType,
          trailingSlash: input.trailingSlash,
          localeStrategy: input.localeStrategy,
          localePrefixMode: input.localePrefixMode,
          localePrefixes: prefixes,
          permalinks: input.permalinks,
          allowCrossSiteTranslations: input.allowCrossSiteTranslations,
          sponsorDisclosure: input.sponsorDisclosure,
          sponsorRel: input.sponsorRel,
          sponsorPolicyVersion: sponsorChanged ? sql`${siteContentSettings.sponsorPolicyVersion} + 1` : current.sponsorPolicyVersion,
          version: sql`${siteContentSettings.version} + 1`,
          updatedAt: new Date(),
        })
        .where(and(eq(siteContentSettings.siteId, siteId), eq(siteContentSettings.version, current.version)))
        .returning();

      // A language's new prefix: its old addresses redirect, the rest of the path kept (design B).
      await writePrefixMoves(tx, siteId, prefixMoves(current, input, prefixes, site!.defaultLanguage), addressPrefixes(input, prefixes, site!.defaultLanguage));

      // Paths depend on the patterns and the time zone: recompute what moved, all or nothing (design R2, B).
      const affected = affectedCollections(current, input);
      if (affected.length > 0) {
        // The final rule set is checked once below; a path error of the rebuild is this request's error (a 4xx, not a 500).
        const { conflicts } = await rebuildRoutes(tx, siteId, { collections: affected }, { checkRules: false }).catch((err: unknown) => {
          if (err instanceof ItemServiceError && err.status >= 400 && err.status < 500) {
            throw new ContentSettingsError(err.code, err.message, err.status === 409 ? 409 : 422);
          }
          throw err;
        });
        if (conflicts.length > 0) {
          throw new ContentSettingsError('ROUTE_CONFLICT', 'With these settings some items would share a path; nothing was changed.', 409, { conflicts });
        }
      }

      // The whole rule set in the new path space must provably terminate (design R36): every stored rule takes effect.
      await assertRulesTerminate(tx, siteId, await loadSpace(tx, siteId, { settings: row! }));

      // The change event (design F, H): renderers re-render what the settings touch — every published
      // sponsored item when the sponsor policy moved (they enumerate them: listPublishedSponsored).
      const changedFields = SETTINGS_FIELDS.filter((f) => JSON.stringify(current[f]) !== JSON.stringify(row![f]));
      if (changedFields.length > 0) {
        await appendItemEvent(tx, {
          siteId,
          resource: 'site_content_settings',
          collection: '$site',
          itemId: siteId,
          itemVersion: row!.version,
          changedFields,
          actor: principalOf(this.deps.actor),
          source: 'api',
          payload: sponsorChanged
            ? {
                sponsor: {
                  before: { disclosure: current.sponsorDisclosure, rel: current.sponsorRel },
                  after: { disclosure: row!.sponsorDisclosure, rel: row!.sponsorRel },
                  policyVersion: row!.sponsorPolicyVersion,
                },
              }
            : null,
        });
      }

      // The cross-site switch shows or hides the other sites' members at once (spec "关闭跨站关联立即隐藏"):
      // every group shared with another site is announced to each of its sites, for their caches.
      if (current.allowCrossSiteTranslations !== row!.allowCrossSiteTranslations) {
        for (const group of await crossSiteGroupsOf(tx, siteId)) {
          await writeGroupEvents(tx, group, ['crossSite'], principalOf(this.deps.actor));
        }
      }

      if (sponsorChanged) {
        await new AuditLogger({ db: tx as unknown as Database, siteId }).writeInTransaction(tx, {
          siteId,
          event: 'site_sponsor_policy_changed',
          actorEmail: this.deps.actor.email ?? null,
          metadata: {
            operator: this.deps.actor.userId,
            actor: principalOf(this.deps.actor),
            reason: input.reason,
            riskAcknowledged: input.riskAcknowledged ?? [],
            before: { disclosure: current.sponsorDisclosure, rel: current.sponsorRel },
            after: { disclosure: input.sponsorDisclosure, rel: input.sponsorRel },
            policyVersion: row!.sponsorPolicyVersion,
          },
        });
      }
      return row!;
    });
  }

  /**
   * Update the site row (`PATCH /site`). A new default language must be one of the site's
   * languages — checked under the content settings row lock, the lock a settings update takes,
   * so the two cannot interleave (design A). Returns null when the site does not exist.
   */
  async updateSite(set: Record<string, unknown>): Promise<typeof sites.$inferSelect | null> {
    const { siteId } = this.deps;
    return this.tx(async (tx) => {
      // The site row change refreshes the whole site's projection, which takes this row: take it first, before the
      // site row, as a site deletion does (P07, Codex review of batch 4b).
      await lockAddressSpace(tx, siteId);
      if (typeof set.defaultLanguage === 'string') {
        const [content] = await tx
          .select({ locales: siteContentSettings.availableLocales })
          .from(siteContentSettings)
          .where(eq(siteContentSettings.siteId, siteId))
          .for('update');
        const locales = content?.locales ?? [];
        if (locales.length > 0 && !locales.some((l) => sameLocale(l, set.defaultLanguage as string))) {
          throw new ContentSettingsError(
            'DEFAULT_LANGUAGE_MISSING',
            "Add the language to the site's languages (content settings) before making it the default.",
            422,
          );
        }
      }
      const previous =
        typeof set.defaultLanguage === 'string'
          ? (await tx.select({ defaultLanguage: sites.defaultLanguage }).from(sites).where(eq(sites.id, siteId)))[0]
          : undefined;
      const [updated] = await tx.update(sites).set(set).where(eq(sites.id, siteId)).returning();
      // A new default language moves the language rules (`/` under all_prefixed, the stripped prefix): re-check them (R36).
      if (updated && typeof set.defaultLanguage === 'string' && updated.defaultLanguage !== previous?.defaultLanguage) {
        await assertRulesTerminate(tx, siteId, await loadSpace(tx, siteId));
        // Translation group members without a language of their own are in the new default language (P05, design D).
        await followDefaultLocale(tx, siteId, principalOf(this.deps.actor)).catch((err: unknown) => {
          if (err instanceof ItemServiceError) throw new ContentSettingsError(err.code, err.message, 409);
          throw err;
        });
        // Addresses depend on the default language (prefixes, language rules): renderers learn of it.
        await appendItemEvent(tx, {
          siteId,
          resource: 'site_content_settings',
          collection: '$site',
          itemId: siteId,
          itemVersion: null,
          changedFields: ['defaultLanguage'],
          source: 'api',
          actor: principalOf(this.deps.actor),
        });
      }
      return updated ?? null;
    });
  }

  /** Every language has one prefix: configured or its lowercased tag; unique and never reserved. */
  private prefixesFor(input: SiteContentSettingsInput, adminSegment: string | null): Record<string, string> {
    const out: Record<string, string> = {};
    for (const locale of input.availableLocales) {
      const configured = Object.entries(input.localePrefixes).find(([l]) => sameLocale(l, locale))?.[1];
      const prefix = configured ?? defaultPrefixOf(locale);
      // A derived prefix obeys the same rule as a configured one (`en-US-u-ca-gregory` is too long for a path segment).
      if (!LocalePrefixSchema.safeParse(prefix).success) {
        throw new ContentSettingsError('PREFIX_REQUIRED', `"${locale}" needs an explicit prefix: "${prefix}" is not a valid path segment (2–16 lowercase letters, digits and hyphens).`, 422, { locale });
      }
      out[locale] = prefix;
    }
    const seen = new Map<string, string>();
    for (const [locale, prefix] of Object.entries(out)) {
      if (isReservedSegment(prefix, adminSegment)) {
        throw new ContentSettingsError('PREFIX_RESERVED', `"${prefix}" is a reserved path and cannot be a language prefix.`, 422, { locale, prefix, conflicts: [`/${prefix}`] });
      }
      const other = seen.get(prefix);
      if (other) throw new ContentSettingsError('PREFIX_TAKEN', `"${other}" and "${locale}" cannot share the prefix "${prefix}".`, 422, { prefix });
      seen.set(prefix, locale);
    }
    return out;
  }

  /**
   * A new language prefix may not be the first segment of an existing path (a page at `/about`
   * would be swallowed by a language `about`). Checked under the settings row lock, which every
   * route write holds in share mode, so no conflicting path appears meanwhile (design B).
   */
  private async checkPrefixesAgainstPaths(tx: SiteTransaction, prefixes: Record<string, string>, before: Record<string, string>): Promise<void> {
    const added = Object.entries(prefixes).filter(([, prefix]) => !Object.values(before).includes(prefix));
    if (added.length === 0) return;
    const taken = await routeFirstSegments(tx, this.deps.siteId);
    const conflicts = added.filter(([, prefix]) => taken.has(prefix));
    if (conflicts.length > 0) {
      throw new ContentSettingsError(
        'PREFIX_CONFLICT',
        `Language prefix ${conflicts.map(([, p]) => `"${p}"`).join(', ')} is already the start of existing paths.`,
        422,
        { conflicts: conflicts.map(([locale, prefix]) => ({ locale, prefix, path: `/${prefix}` })) },
      );
    }
  }

  private async checkPermalinkCollections(tx: SiteTransaction, names: string[]): Promise<void> {
    if (names.length === 0) return;
    const rows = await tx.select({ name: collections.name }).from(collections).where(eq(collections.siteId, this.deps.siteId));
    const known = new Set(rows.map((r) => r.name));
    const unknown = names.filter((n) => !known.has(n));
    if (unknown.length) throw new ContentSettingsError('VALIDATION', `No such collection: ${unknown.join(', ')}.`, 400);
  }

  private checkSponsorChange(current: ContentSettings, input: SiteContentSettingsInput): void {
    if (!input.reason?.trim()) {
      throw new ContentSettingsError('REASON_REQUIRED', 'Changing the sponsored-content policy needs a reason.', 422);
    }
    const switchedOff: Array<'disclosure' | 'rel'> = [];
    if (current.sponsorDisclosure && !input.sponsorDisclosure) switchedOff.push('disclosure');
    if (current.sponsorRel && !input.sponsorRel) switchedOff.push('rel');
    const missing = switchedOff.filter((r) => !(input.riskAcknowledged ?? []).includes(r));
    if (missing.length) {
      throw new ContentSettingsError('RISK_ACK_REQUIRED', 'Switching a sponsored-content policy off needs its risk acknowledged.', 422, {
        risks: Object.fromEntries(missing.map((r) => [r, SPONSOR_RISKS[r]])),
      });
    }
  }
}
