// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { z } from 'zod';

/**
 * Custom-domain schemas — shared by CMS (validation) and Studio (form).
 * Mirrors the `site_domains` table. A site can register multiple hostnames:
 * a free `<slug>.heopress.example` subdomain and/or operator-owned custom domains
 * provisioned through Cloudflare for SaaS.
 */

/** Reserved suffix offered for free. Custom domains may NOT live under it. */
export const FREE_DOMAIN_SUFFIX = 'heopress.example';

/** A valid FQDN like `cms.example.com` (labels, lowercased, ≤253 chars). */
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

const hostname = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(HOSTNAME, { message: 'Enter a valid domain like cms.example.com.' });

export const DOMAIN_KINDS = ['subdomain', 'custom'] as const;
export const DomainKindSchema = z.enum(DOMAIN_KINDS);

/**
 * HeoPress P04 (spec sites/domain-routing): a domain serves nothing until it
 * is verified (`pending` → `active`); `disabled` switches it off. `failed`
 * remains for rows from before P04.
 */
export const DOMAIN_STATUSES = ['pending', 'active', 'disabled', 'failed'] as const;
export const DomainStatusSchema = z.enum(DOMAIN_STATUSES);

/**
 * Create a domain. `custom` requires a full FQDN that is NOT under the free
 * suffix (those are claimed via `kind: 'subdomain'`). `subdomain` takes a bare
 * label (`acme`) which the server expands to `<label>.heopress.example`.
 */
export const DOMAIN_VERIFICATION_METHODS = ['dns_txt', 'http_file'] as const;
export const DomainVerificationMethodSchema = z.enum(DOMAIN_VERIFICATION_METHODS);

/** A BCP 47-ish locale tag for a language entry domain (`en`, `zh-CN`). */
const locale = z.string().trim().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, { message: 'Use a locale like en or zh-CN.' });

export const DomainCreateSchema = z
  .object({
    kind: DomainKindSchema,
    /** FQDN for `custom`; bare DNS label for `subdomain`. */
    hostname: z.string().trim().toLowerCase().min(1).max(253),
    /** How a custom domain proves it is yours (default `dns_txt`). */
    verificationMethod: DomainVerificationMethodSchema.optional(),
    /** Register it as the site's entry for this language (kept on its own host, never redirected). */
    entryLocale: locale.nullable().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.kind === 'custom') {
      if (!HOSTNAME.test(value.hostname)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Enter a valid domain like cms.example.com.',
          path: ['hostname'],
        });
      }
      if (value.hostname === FREE_DOMAIN_SUFFIX || value.hostname.endsWith(`.${FREE_DOMAIN_SUFFIX}`)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Use kind "subdomain" to claim a ${FREE_DOMAIN_SUFFIX} address.`,
          path: ['hostname'],
        });
      }
    } else {
      // subdomain: a single DNS label (no dots).
      if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(value.hostname)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Enter a single label like "acme" (letters, numbers, hyphens).',
          path: ['hostname'],
        });
      }
    }
  });

/** One DNS record the operator must create, surfaced verbatim in the UI. */
export const DomainVerificationRecordSchema = z.object({
  /** `HTTP`: serve `value` at the URL in `name`. */
  type: z.enum(['CNAME', 'TXT', 'HTTP']),
  name: z.string(),
  value: z.string(),
  /** Why this record exists, shown as help text. */
  purpose: z.string().optional(),
});

/** Shape returned by the API for one domain row (secrets stripped). */
export const DomainResourceSchema = z.object({
  id: z.string(),
  hostname: z.string(),
  kind: DomainKindSchema,
  isPrimary: z.boolean(),
  status: DomainStatusSchema,
  statusReason: z.string().nullable(),
  verificationMethod: DomainVerificationMethodSchema,
  /** When the claim's token runs out; ask for a new one with POST …/token. */
  verificationExpiresAt: z.string().nullable(),
  entryLocale: z.string().nullable(),
  sslStatus: z.string().nullable(),
  verification: z
    .object({ records: z.array(DomainVerificationRecordSchema).default([]) })
    .default({ records: [] }),
  verifiedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const DomainUpdateSchema = z.object({
  /** Switch a domain off (`disabled`) or back on (`active`; only for a domain that was verified). */
  status: z.enum(['active', 'disabled']).optional(),
  entryLocale: locale.nullable().optional(),
});

export type DomainKind = z.infer<typeof DomainKindSchema>;
export type DomainVerificationMethod = z.infer<typeof DomainVerificationMethodSchema>;
export type DomainUpdateInput = z.infer<typeof DomainUpdateSchema>;
export type DomainStatus = z.infer<typeof DomainStatusSchema>;
export type DomainCreateInput = z.infer<typeof DomainCreateSchema>;
export type DomainVerificationRecord = z.infer<typeof DomainVerificationRecordSchema>;
export type DomainResource = z.infer<typeof DomainResourceSchema>;
