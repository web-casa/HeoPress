import { SitePathSpace } from './path-space';

/** The URL settings of a site as stored (content settings, or the projection's copy of them). */
export interface SpaceSettings {
  availableLocales?: string[] | null;
  localeStrategy?: string | null;
  localePrefixMode?: string | null;
  localePrefixes?: Record<string, string> | null;
  trailingSlash?: string | null;
}

/**
 * A site's path space from its default language, URL settings and active domains (HeoPress P05 design B;
 * shared by the CMS and the rendering service, P06). Without a primary domain yet, a stand-in host:
 * rules are checked all the same.
 */
export function spaceOf(
  siteId: string,
  defaultLanguage: string,
  settings: SpaceSettings | null | undefined,
  domains: Array<{ hostname: string; locale: string | null; isPrimary: boolean }>,
  primaryHost?: string,
): SitePathSpace {
  return new SitePathSpace({
    defaultLanguage,
    availableLocales: settings?.availableLocales?.length ? settings.availableLocales : [defaultLanguage],
    localeStrategy: (settings?.localeStrategy ?? 'subdirectory') as 'subdirectory',
    localePrefixMode: (settings?.localePrefixMode ?? 'default_at_root') as 'default_at_root',
    localePrefixes: settings?.localePrefixes ?? {},
    trailingSlash: (settings?.trailingSlash ?? 'always') as 'always',
    primaryHost: primaryHost ?? domains.find((d) => d.isPrimary)?.hostname ?? `primary.${siteId}.invalid`,
    entryHosts: domains.filter((d) => d.locale !== null).map((d) => ({ hostname: d.hostname, locale: d.locale! })),
  });
}
