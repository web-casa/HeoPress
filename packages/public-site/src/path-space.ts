import { sameLocale } from '@heopress/contracts/schemas';
import { pathOf, segmentsOf, type EngineRule, type Loc } from './redirect-engine';

/**
 * A site's external path space (HeoPress P05 tasks 3.1, 3.4, 3.5; design B,
 * R33). Pure: built from the site's content settings and active domains.
 *
 * - Subdirectory strategy: one host (the primary domain); a language is its
 *   path prefix. `default_at_root`: the default language has no prefix (its
 *   prefix, if requested, is stripped by a system rule); `all_prefixed`:
 *   every language has one, and `/` goes to the default language's root.
 * - Subdomain and domain strategies: the default language on the primary
 *   domain, every other language on its language entry domain, no prefixes.
 * - A language entry domain always means its language, whatever the
 *   strategy, and never redirects to the primary domain.
 *
 * Content paths (stored without prefix) map to external locations with
 * `externalOf`, and back with `detect`. `canonicalPath` applies the trailing
 * slash policy to a bare path.
 */

export interface SiteSpaceInput {
  defaultLanguage: string;
  availableLocales: string[];
  localeStrategy: 'subdirectory' | 'subdomain' | 'domain';
  localePrefixMode: 'default_at_root' | 'all_prefixed';
  localePrefixes: Record<string, string>;
  trailingSlash: 'always' | 'never';
  primaryHost: string;
  /** Active language entry domains: hostname → locale. */
  entryHosts: Array<{ hostname: string; locale: string }>;
}

export class SitePathSpace {
  readonly defaultLocale: string;
  private readonly prefixes = new Map<string, string>();
  private readonly localeOfPrefix = new Map<string, string>();
  private readonly hostOfLocale = new Map<string, string>();
  private readonly localeOfHost = new Map<string, string>();

  constructor(private readonly input: SiteSpaceInput) {
    this.defaultLocale = this.canonical(input.defaultLanguage) ?? input.defaultLanguage;
    for (const locale of input.availableLocales) {
      const configured = Object.entries(input.localePrefixes).find(([l]) => sameLocale(l, locale))?.[1];
      const prefix = configured ?? locale.toLowerCase();
      this.prefixes.set(locale, prefix);
      this.localeOfPrefix.set(prefix, locale);
    }
    for (const entry of input.entryHosts) {
      const locale = this.canonical(entry.locale);
      if (!locale) continue; // a language the site no longer has
      this.localeOfHost.set(entry.hostname, locale);
      if (!this.hostOfLocale.has(locale)) this.hostOfLocale.set(locale, entry.hostname);
    }
  }

  get primaryHost(): string {
    return this.input.primaryHost;
  }

  /** The site's spelling of a language tag, or null when it is not one of its languages. */
  canonical(locale: string): string | null {
    return this.input.availableLocales.find((l) => sameLocale(l, locale)) ?? null;
  }

  /** A language entry host's language (never redirected to the primary domain). */
  entryLocaleOf(host: string): string | null {
    return this.localeOfHost.get(host) ?? null;
  }

  private isDefault(locale: string): boolean {
    return sameLocale(locale, this.defaultLocale);
  }

  /** Where a content path of a language lives, or null when the language has no address (no entry domain yet). */
  externalOf(locale: string, contentPath: string): Loc | null {
    const l = this.canonical(locale);
    if (!l) return null;
    if (this.input.localeStrategy !== 'subdirectory') {
      if (this.isDefault(l)) return { host: this.input.primaryHost, path: contentPath };
      const host = this.hostOfLocale.get(l);
      return host ? { host, path: contentPath } : null;
    }
    if (this.isDefault(l) && this.input.localePrefixMode === 'default_at_root') return { host: this.input.primaryHost, path: contentPath };
    return { host: this.input.primaryHost, path: pathOf([this.prefixes.get(l)!, ...segmentsOf(contentPath)]) };
  }

  /** Every address of a content path: its canonical one, and its language entry domain's under the subdirectory strategy. */
  addressesOf(locale: string, contentPath: string): Loc[] {
    const canonical = this.externalOf(locale, contentPath);
    const l = this.canonical(locale);
    const entry = l ? this.hostOfLocale.get(l) : undefined;
    const out = canonical ? [canonical] : [];
    if (entry && !out.some((a) => a.host === entry)) out.push({ host: entry, path: contentPath });
    return out;
  }

  /**
   * A content rule as engine rules, one per address of its source. On a language entry domain a rule
   * to the same language stays on that domain; to another language it goes to that language's address.
   */
  contentRule(rule: { id: string; locale: string; fromPath: string; match: string; toLocale: string; toPath: string }): EngineRule[] {
    const toLocale = rule.toLocale || rule.locale;
    const out: EngineRule[] = [];
    for (const from of this.addressesOf(rule.locale, rule.fromPath)) {
      const onEntry = this.localeOfHost.get(from.host);
      const to = onEntry && sameLocale(onEntry, toLocale) ? { host: from.host, path: rule.toPath } : this.externalOf(toLocale, rule.toPath);
      if (!to) continue; // a language without an address: the rule cannot apply
      out.push({ id: rule.id, layer: 'content', host: from.host, toHost: to.host, from: from.path, match: rule.match as 'exact', to: to.path });
    }
    return out;
  }

  /** All hosts of the space (URL-layer rules apply on each). */
  hosts(): string[] {
    return [this.input.primaryHost, ...this.localeOfHost.keys()];
  }

  /** The language and content path a location shows, or null (no language answers there). */
  detect(loc: Loc): { locale: string; contentPath: string } | null {
    const entry = this.localeOfHost.get(loc.host);
    if (entry) return { locale: entry, contentPath: loc.path };
    if (loc.host !== this.input.primaryHost) return null;
    if (this.input.localeStrategy !== 'subdirectory') return { locale: this.defaultLocale, contentPath: loc.path };
    const [first, ...rest] = segmentsOf(loc.path);
    const prefixed = first !== undefined ? this.localeOfPrefix.get(first) : undefined;
    if (prefixed) {
      // Under default_at_root the default language's prefix is not an address (a system rule strips it).
      if (this.isDefault(prefixed) && this.input.localePrefixMode === 'default_at_root') return null;
      return { locale: prefixed, contentPath: pathOf(rest) };
    }
    return this.input.localePrefixMode === 'default_at_root' ? { locale: this.defaultLocale, contentPath: loc.path } : null;
  }

  /** The language rules of the strategy: `/` → the default root (all_prefixed), the default prefix stripped (default_at_root). */
  systemRules(): EngineRule[] {
    if (this.input.localeStrategy !== 'subdirectory') return [];
    const host = this.input.primaryHost;
    const prefix = this.prefixes.get(this.defaultLocale);
    if (!prefix) return [];
    if (this.input.localePrefixMode === 'all_prefixed') {
      return [{ id: 'system:root', layer: 'system', host, toHost: host, from: '/', match: 'exact', to: `/${prefix}` }];
    }
    return [{ id: 'system:default-prefix', layer: 'system', host, toHost: host, from: `/${prefix}`, match: 'prefix', to: '/' }];
  }

  /** The canonical form of a bare path under the trailing slash policy. */
  canonicalPath(path: string): string {
    if (path === '/') return '/';
    return this.input.trailingSlash === 'always' ? `${path}/` : path;
  }
}
