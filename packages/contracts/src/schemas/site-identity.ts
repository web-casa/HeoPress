import { z } from 'zod';

/**
 * Whom a site speaks for (HeoPress P07 task 2.12; spec seo/page-metadata "站点身份"): an organisation, a person or a
 * local business, with its name, logo, contact details and official profiles. The site's structured data names this
 * identity (Organization, Person or LocalBusiness); a field left empty is never made up. Shared by the CMS (validation,
 * the public snapshot the rendering service reads) and Studio (the form).
 */

export const SITE_IDENTITY_KINDS = ['organization', 'person', 'local_business'] as const;
export type SiteIdentityKind = (typeof SITE_IDENTITY_KINDS)[number];

/** An absolute http(s) address with a host: what a structured-data URL may be. */
const WebUrl = z
  .string()
  .trim()
  .max(2048)
  .refine((v) => {
    try {
      const u = new URL(v);
      return (u.protocol === 'https:' || u.protocol === 'http:') && !!u.hostname && !u.username && !u.password;
    } catch {
      return false;
    }
  }, 'An absolute http(s) address.');

const Text = (max: number) => z.string().trim().max(max);

export const SiteIdentityAddressSchema = z
  .object({
    streetAddress: Text(200).default(''),
    addressLocality: Text(100).default(''),
    addressRegion: Text(100).default(''),
    postalCode: Text(20).default(''),
    /** ISO 3166-1 alpha-2, or empty. */
    addressCountry: z.string().trim().toUpperCase().regex(/^([A-Z]{2})?$/, 'A two-letter country code.').default(''),
  })
  .strict();

export const SiteIdentitySchema = z
  .object({
    kind: z.enum(SITE_IDENTITY_KINDS),
    name: Text(200).min(1),
    /** The logo (organisation, business) or picture (person): an absolute address; empty: none. */
    logo: z.union([WebUrl, z.literal('')]).default(''),
    email: z.union([z.string().trim().max(254).email(), z.literal('')]).default(''),
    telephone: z.string().trim().max(40).regex(/^[+0-9 ()./-]*$/, 'Digits, spaces and + ( ) . / - only.').default(''),
    address: SiteIdentityAddressSchema.default({ streetAddress: '', addressLocality: '', addressRegion: '', postalCode: '', addressCountry: '' }),
    /** Official profiles (social accounts, a registry entry): absolute addresses, no repeats. */
    sameAs: z
      // Stored as URLs normalise them (host case, default port, an empty path): two spellings of one address are one.
      .array(WebUrl.transform((v) => new URL(v).toString()))
      .max(20)
      .default([])
      .refine((v) => new Set(v).size === v.length, 'No repeated profile addresses.'),
  })
  .strict();

export type SiteIdentity = z.infer<typeof SiteIdentitySchema>;

/** An update: the identity and the version it was read at (0: none stored yet; a stale form is refused, not merged). */
export const SiteIdentityUpdateSchema = SiteIdentitySchema.extend({ version: z.number().int().min(0) }).strict();

/** A stored identity (or its public snapshot); null when there is none or it no longer validates: nothing is made up. */
export function effectiveSiteIdentity(stored: unknown): SiteIdentity | null {
  if (!stored || typeof stored !== 'object' || Object.keys(stored).length === 0) return null;
  const parsed = SiteIdentitySchema.safeParse(stored);
  return parsed.success ? parsed.data : null;
}
