import { and, eq, ne, sql } from 'drizzle-orm';
import { sameLocale } from '@heopress/contracts/schemas';
import { siteContentSettings, siteDomains, sites, type Database } from '@heopress/database';
import { inSiteScope } from '../site-scope';

/**
 * Language entry domains (HeoPress P05 task 3.4; design B): a site's domain
 * that enters it in one language (`en.example.com`, `example.cn`) and is
 * never redirected to the primary domain.
 *
 * A language entry names one of the site's languages (stored in the site's
 * spelling), not its default language (that one lives on the primary
 * domain), and each language has at most one entry domain that is not
 * switched off; the primary domain is never a language entry.
 */

export class LanguageEntryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 409 | 422,
  ) {
    super(message);
  }
}

/** The entry locale to store for a domain (the site's spelling), or a LanguageEntryError. */
export async function checkEntryLocale(
  db: Database,
  siteId: string,
  entryLocale: string,
  domain: { id: string | null; isPrimary: boolean },
): Promise<string> {
  // The site's settings and domains are read in the site's scope (HeoPress P14, ADR-0023).
  const scoped = inSiteScope(db, siteId);
  if (domain.isPrimary) {
    throw new LanguageEntryError('PRIMARY_DOMAIN', 'The primary domain serves the default language; it cannot be a language entry.', 422);
  }
  const [site] = await scoped.select({ defaultLanguage: sites.defaultLanguage }).from(sites).where(eq(sites.id, siteId));
  const [settings] = await scoped.select({ availableLocales: siteContentSettings.availableLocales }).from(siteContentSettings).where(eq(siteContentSettings.siteId, siteId));
  const languages = settings?.availableLocales?.length ? settings.availableLocales : [site!.defaultLanguage];
  const locale = languages.find((l) => sameLocale(l, entryLocale));
  if (!locale) throw new LanguageEntryError('LOCALE_NOT_AVAILABLE', `"${entryLocale}" is not one of the site's languages.`, 422);
  if (sameLocale(locale, site!.defaultLanguage)) {
    throw new LanguageEntryError('DEFAULT_LOCALE', 'The default language lives on the primary domain; choose another language.', 422);
  }
  const others = await scoped
    .select({ hostname: siteDomains.hostname, locale: siteDomains.entryLocale })
    .from(siteDomains)
    .where(
      and(
        eq(siteDomains.siteId, siteId),
        ne(siteDomains.status, 'disabled'),
        sql`${siteDomains.entryLocale} IS NOT NULL`,
        domain.id ? ne(siteDomains.id, domain.id) : sql`true`,
      ),
    );
  const taken = others.find((o) => sameLocale(o.locale!, locale));
  if (taken) throw new LanguageEntryError('ENTRY_TAKEN', `${taken.hostname} is already the entry domain for "${locale}".`, 409);
  return locale;
}

/** Whether a write failed on the one-entry-per-language index (a concurrent registration won). */
export function isEntryLocaleTaken(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 3; e = (e as { cause?: unknown }).cause, depth++) {
    const pg = e as { code?: unknown; constraint_name?: unknown; constraint?: unknown };
    if (pg.code === '23505' && (pg.constraint_name ?? pg.constraint) === 'site_domains_site_entry_locale_unique') return true;
  }
  return false;
}
