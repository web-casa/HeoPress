import { z } from 'zod';

/**
 * A language tag (HeoPress P05): valid BCP 47, stored in canonical form
 * (`zh-cn` → `zh-CN`, `zh-hant-tw` → `zh-Hant-TW`). One rule for the site's
 * default language and its content languages, so a tag accepted in one place
 * is never refused in the other.
 */
export function canonicalLocale(tag: string): string | null {
  try {
    const [canonical] = Intl.getCanonicalLocales(tag.trim());
    return canonical ?? null;
  } catch {
    return null;
  }
}

export const LocaleTagSchema = z
  .string()
  .trim()
  .min(2)
  .max(35)
  .refine((v) => canonicalLocale(v) !== null, { message: 'Use a BCP 47 language tag, e.g. en, zh-CN, pt-BR, zh-Hant-TW.' })
  .transform((v) => canonicalLocale(v)!);

/** Whether two tags name the same language (canonical forms, so `iw` and `he`, `zh-cn` and `zh-CN` match). */
export function sameLocale(a: string, b: string): boolean {
  const ca = canonicalLocale(a) ?? a.trim().toLowerCase();
  const cb = canonicalLocale(b) ?? b.trim().toLowerCase();
  return ca.toLowerCase() === cb.toLowerCase();
}
