import { z } from 'zod';

/**
 * Per-site storage profiles (HeoPress P04, spec platform/storage-profiles):
 * shared by the CMS (validation) and Studio (forms).
 *
 * `local` keeps the objects in a directory of this instance (under
 * HEOPRESS_STORAGE_DIR, one directory per profile); `s3` reaches any
 * S3-compatible service (AWS S3, R2, OSS, COS, MinIO). The secret key is
 * write-only: responses show `SECRET_MASK` when one is set.
 */

export const STORAGE_DRIVERS = ['local', 's3'] as const;
export const StorageDriverSchema = z.enum(STORAGE_DRIVERS);

/** What a configured secret looks like in a response. */
export const SECRET_MASK = '••••••••';

const httpUrl = z
  .string()
  .trim()
  .url()
  .refine((v) => /^https?:\/\//i.test(v), { message: 'Use an http(s) URL.' })
  .transform((v) => v.replace(/\/+$/, ''));

const profileFields = {
  name: z.string().trim().min(1).max(100),
  bucket: z.string().trim().min(3).max(255).nullable().optional(),
  /** Omit for AWS S3; e.g. `https://<account>.r2.cloudflarestorage.com`. */
  endpoint: httpUrl.nullable().optional(),
  region: z.string().trim().max(64).nullable().optional(),
  forcePathStyle: z.boolean().nullable().optional(),
  accessKeyId: z.string().trim().max(256).nullable().optional(),
  /** Write-only. On update: omit to keep, null to clear. */
  secretAccessKey: z.string().min(1).max(512).nullable().optional(),
  /** Where the objects are publicly reachable, e.g. `https://img.example.com`. */
  publicBaseUrl: httpUrl.nullable().optional(),
};

export const StorageProfileCreateSchema = z
  .object({ driver: StorageDriverSchema, ...profileFields })
  .superRefine((v, ctx) => {
    if (v.driver !== 's3') return;
    for (const key of ['bucket', 'accessKeyId', 'secretAccessKey'] as const) {
      if (!v[key]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `An S3 profile needs ${key}.` });
    }
  });

/** Every field optional; the driver does not change. */
export const StorageProfileUpdateSchema = z.object(profileFields).partial();

export const StorageProfileResourceSchema = z.object({
  id: z.string(),
  name: z.string(),
  driver: StorageDriverSchema,
  bucket: z.string().nullable(),
  endpoint: z.string().nullable(),
  region: z.string().nullable(),
  forcePathStyle: z.boolean().nullable(),
  accessKeyId: z.string().nullable(),
  /** `SECRET_MASK` when a secret is stored, otherwise null. Never the secret. */
  secretAccessKey: z.string().nullable(),
  publicBaseUrl: z.string().nullable(),
  /** The site writes new media to this profile. */
  bound: z.boolean(),
  /** Media objects stored in this profile (it cannot be deleted while > 0). */
  objectCount: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** Which profile the site writes new media to; null: the instance default. */
export const StorageBindingSchema = z.object({ profileId: z.string().min(1).nullable() });

/** Move the site's existing media to `profileId` (null: the default). Needs `confirm: true`. */
export const StorageMigrationSchema = z.object({
  profileId: z.string().min(1).nullable(),
  confirm: z.literal(true),
});

export type StorageDriver = z.infer<typeof StorageDriverSchema>;
export type StorageProfileCreateInput = z.infer<typeof StorageProfileCreateSchema>;
export type StorageProfileUpdateInput = z.infer<typeof StorageProfileUpdateSchema>;
export type StorageProfileResource = z.infer<typeof StorageProfileResourceSchema>;
