// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import i18n from 'i18next';
import { z } from 'zod';

export const DEFAULT_PROJECT_THEME = null;

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

export const projectConfigurationSchema = z.object({
  defaultLanguage: z
    .string()
    .trim()
    .regex(/^[a-z]{2,3}(-[A-Z]{2})?$/, {
      error: () => i18n.t('setup:schemas.project.languageTag'),
    }),
  siteUrl: z
    .string()
    .trim()
    .min(1, { error: () => i18n.t('setup:schemas.project.siteUrlRequired') })
    .superRefine((value, ctx) => {
      try {
        const url = new URL(value);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: i18n.t('setup:schemas.project.siteUrlProtocol'),
          });
        }
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: i18n.t('setup:schemas.project.siteUrlInvalid'),
        });
      }
    })
    .transform(normalizeSiteUrl),
  displayTitle: z
    .string()
    .transform((value) => value.replace(/[\u0000-\u001F\u007F]/g, '').trim())
    .pipe(
      z
        .string()
        .min(2, { error: () => i18n.t('setup:schemas.project.titleMin', { count: 2 }) })
        .max(80, { error: () => i18n.t('setup:schemas.project.titleMax', { count: 80 }) }),
    ),
  theme: z.null().optional().default(DEFAULT_PROJECT_THEME),
});

export type ProjectConfigurationFormValues = z.infer<
  typeof projectConfigurationSchema
>;
