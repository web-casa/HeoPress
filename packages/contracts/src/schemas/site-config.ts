// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { z } from 'zod';
import { LocaleTagSchema } from './locale-tag';
import { SaveActionSchema } from './user-preferences';

/**
 * Site (tenant) configuration schemas — shared by CMS (validation) and Studio
 * (form). Mirrors the columns added to the `sites` table: identity, branding,
 * theme overrides and a raw custom-CSS escape hatch.
 *
 * Theme model (à la Directus): the site holds the GLOBAL defaults (appearance,
 * theme overrides, branding, custom CSS); per-user appearance/theme/language
 * live in `users.preferences` and override these at render time.
 */

/**
 * CSS custom properties Studio exposes as theme tokens (see
 * `apps/studio/src/index.css`). Overrides are whitelisted to this set so an
 * operator cannot inject arbitrary property names into the `:root` block.
 */
export const THEME_TOKENS = [
  '--background',
  '--foreground',
  '--primary',
  '--primary-foreground',
  '--muted',
  '--muted-foreground',
  '--accent',
  '--accent-foreground',
  '--destructive',
  '--destructive-foreground',
  '--border',
  '--input',
  '--ring',
  '--radius',
] as const;

export type ThemeToken = (typeof THEME_TOKENS)[number];

/**
 * An HSL triple as stored in Tailwind tokens, e.g. `240 5.9% 10%`. Studio wraps
 * these in `hsl(var(--token))`, so values must be the bare `H S% L%` form (no
 * `hsl(...)`, no `#hex`). `--radius` uses a length instead — handled separately.
 */
const HSL_TRIPLE = /^\d{1,3}(\.\d+)?\s+\d{1,3}(\.\d+)?%\s+\d{1,3}(\.\d+)?%$/;
/** A short CSS length for `--radius` (e.g. `0.5rem`, `8px`, `0`). */
const CSS_LENGTH = /^(0|\d{1,3}(\.\d+)?(px|rem|em))$/;

const hslTriple = z
  .string()
  .trim()
  .regex(HSL_TRIPLE, { message: 'Use an HSL triple like "240 5.9% 10%".' });

/** Map of whitelisted token → value. `--radius` accepts a length, others HSL. */
const themeOverrideMap = z
  .record(z.string(), z.string())
  .superRefine((map, ctx) => {
    for (const [token, value] of Object.entries(map)) {
      if (!THEME_TOKENS.includes(token as ThemeToken)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Unknown theme token: ${token}`,
          path: [token],
        });
        continue;
      }
      const ok = token === '--radius' ? CSS_LENGTH.test(value) : HSL_TRIPLE.test(value);
      if (!ok) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            token === '--radius'
              ? 'Use a CSS length like "0.5rem".'
              : 'Use an HSL triple like "240 5.9% 10%".',
          path: [token],
        });
      }
    }
  });

export const ThemeOverridesSchema = z.object({
  light: themeOverrideMap.optional().default({}),
  dark: themeOverrideMap.optional().default({}),
});

export const BrandingSchema = z.object({
  logoUrl: z.string().url().max(2048).optional().or(z.literal('')),
  faviconUrl: z.string().url().max(2048).optional().or(z.literal('')),
  /** Brand/accent color as an HSL triple, mapped onto `--primary`. */
  brandColor: hslTriple.optional().or(z.literal('')),
});

/**
 * Normalize a public site URL: strips trailing slashes and hash, keeps the
 * origin + path. Mirrors the setup wizard's helper so identity stays consistent.
 */
export function normalizeSiteUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.pathname === '/') {
    url.pathname = '';
  } else {
    url.pathname = url.pathname.replace(/\/+$/, '');
  }
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

const displayTitle = z
  .string()
  .transform((value) => value.replace(/[\x00-\x1f\x7f]/g, '').trim())
  .pipe(
    z
      .string()
      .min(2, { message: 'Display title must be at least 2 characters.' })
      .max(80, { message: 'Display title must be 80 characters or fewer.' }),
  );

const siteUrl = z
  .string()
  .trim()
  .min(1, { message: 'Site URL is required.' })
  .superRefine((value, ctx) => {
    try {
      const url = new URL(value);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Site URL must start with http:// or https://.',
        });
      }
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter a valid site URL.' });
    }
  })
  .transform(normalizeSiteUrl);

// HeoPress P05: the same rule as the site's content languages (valid BCP 47, canonical form).
const defaultLanguage = LocaleTagSchema;

const domain = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, {
    message: 'Enter a valid domain like cms.example.com.',
  })
  .max(253);

/** Max custom CSS payload; also rejects style/script breakout sequences. */
const customCss = z
  .string()
  .max(50_000, { message: 'Custom CSS is limited to 50,000 characters.' })
  .refine((css) => !/<\/?\s*(style|script)\b/i.test(css), {
    message: 'Custom CSS must not contain <style> or <script> tags.',
  });

/**
 * Full site configuration payload. Routes accept `.partial()` for PATCH so a
 * form can submit only the fields it changed.
 */
export const SiteConfigSchema = z.object({
  name: z.string().min(1).max(255),
  displayTitle: displayTitle.nullable(),
  siteUrl: siteUrl.nullable(),
  descriptor: z.string().max(255).nullable().or(z.literal('')),
  domain: domain.nullable().or(z.literal('')),
  defaultLanguage,
  defaultAppearance: z.enum(['auto', 'light', 'dark']),
  // Default Studio save action for editors who haven't set a personal one.
  // Per-user override lives in users.preferences.saveAction (mirrors the
  // appearance/theme inheritance model documented at the top of this file).
  defaultSaveAction: SaveActionSchema,
  branding: BrandingSchema,
  themeOverrides: ThemeOverridesSchema,
  customCss: customCss.nullable().or(z.literal('')),
});

/** PATCH payload — every top-level field optional. */
export const SiteConfigUpdateSchema = SiteConfigSchema.partial();

export type SiteConfig = z.infer<typeof SiteConfigSchema>;
export type SiteConfigUpdate = z.infer<typeof SiteConfigUpdateSchema>;
export type Branding = z.infer<typeof BrandingSchema>;
export type ThemeOverrides = z.infer<typeof ThemeOverridesSchema>;
