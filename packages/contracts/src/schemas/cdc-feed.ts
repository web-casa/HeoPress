// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { z } from 'zod';

/**
 * Change Feed Zod schemas + cursor codec
 * (spec: `docs/legacy/kiro-specs/cdc-extension-integration`).
 *
 * Cursor convention: the feed is ordered by the composite keyset
 * `(occurred_at, id)` — event PKs are nanoid (matching the audit-table
 * convention; no uuidv7 dependency), so the id alone carries no order.
 * A cursor is the opaque base64url token of `"<occurredAtMs>:<eventId>"`,
 * shared by the pull API (`meta.nextCursor`), ack, and replay so consumers
 * never construct or interpret the pair themselves.
 */

export const CDC_FEED_SCHEMA_VERSION = 1;

export const CdcOperationSchema = z.enum(['create', 'update', 'delete']);
/**
 * Resource kind an event describes. `item` is content-row changes (the v1
 * default); `collection`/`field` are schema changes; `setting` is site config.
 * The envelope `type` is `<plural>.<operation>` — see {@link cdcEventType}.
 */
/** `content_version`: a named version (branch) of an item (HeoPress P04). */
// HeoPress P05 adds the site network's own resources (design H): translation groups, content routes,
// redirects and a site's content settings.
export const CdcResourceSchema = z.enum([
  'item',
  'collection',
  'field',
  'setting',
  'content_version',
  'translation_group',
  'content_route',
  'redirect',
  'site_content_settings',
  // A site's active theme version changed (HeoPress P06 task 2.3): its rendered pages are stale.
  'theme',
  // A site's SEO / GEO settings changed (HeoPress P07 task 1.4): pages and discovery files follow them.
  'site_seo_settings',
  // Whom a site speaks for changed (HeoPress P07 task 2.12): its structured data follows.
  'site_identity',
]);
export const CdcActorTypeSchema = z.enum(['user', 'api_key', 'agent', 'system']);
export const CdcSourceSchema = z.enum(['api', 'agent', 'flow', 'system']);
export const CdcPayloadModeSchema = z.enum(['reference', 'snapshot']);
export const CdcSubscriptionKindSchema = z.enum(['pull', 'webhook', 'extension']);
export const CdcSubscriptionStatusSchema = z.enum(['active', 'paused', 'dead', 'stale']);

export interface CdcCursor {
  /** Epoch milliseconds of the event's `occurred_at` (keyset major key). */
  occurredAtMs: number;
  /** Event id (nanoid) — deterministic tie-breaker within the same ms. */
  eventId: string;
  /**
   * The event's position (HeoPress P04): transaction id (decimal text) and
   * sequence number. Readers order by it. Cursors issued before P04 have
   * none and are resolved through their event id.
   */
  position?: { txid: string; seq: number };
}

const CURSOR_SEPARATOR = ':';

/** base64url without padding — WebCrypto-era safe on Workers and Node. */
function toBase64Url(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(input: string): string | null {
  try {
    const b64 = input.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(b64);
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/** Separates the position from the event id (not in the nanoid alphabet). */
const POSITION_SEPARATOR = '|';

export function encodeCdcCursor(cursor: CdcCursor): string {
  const position = cursor.position ? `${POSITION_SEPARATOR}${cursor.position.txid}.${cursor.position.seq}` : '';
  return toBase64Url(`${cursor.occurredAtMs}${CURSOR_SEPARATOR}${cursor.eventId}${position}`);
}

const POSITION = /^(0|[1-9][0-9]{0,19})\.(0|[1-9][0-9]{0,18})$/;

const BASE64URL_TOKEN = /^[A-Za-z0-9_-]+$/;
const DECIMAL_MS = /^(0|[1-9][0-9]*)$/;

/**
 * Returns null on any malformed token — callers map that to 400.
 *
 * Only the exact token `encodeCdcCursor` would produce is accepted. `atob`
 * alone is too lenient: it takes the standard-base64 alphabet (`+`, `/`, `=`),
 * and `Number()` reads whitespace or `''` as `0`, so a token such as `Czo+`
 * (`"\v:>"`) decoded to `{ occurredAtMs: 0, eventId: '>' }` — a garbage cursor
 * silently read as "from the beginning". The final round-trip check keeps any
 * other non-canonical spelling out as well.
 */
export function decodeCdcCursor(token: string): CdcCursor | null {
  if (!BASE64URL_TOKEN.test(token)) return null;
  const raw = fromBase64Url(token);
  if (raw === null) return null;
  const sep = raw.indexOf(CURSOR_SEPARATOR);
  if (sep <= 0 || sep === raw.length - 1) return null;
  const msText = raw.slice(0, sep);
  if (!DECIMAL_MS.test(msText)) return null;
  const ms = Number(msText);
  const rest = raw.slice(sep + 1);
  const bar = rest.indexOf(POSITION_SEPARATOR);
  const eventId = bar === -1 ? rest : rest.slice(0, bar);
  // An empty event id is a point in time (a replay "from T"): valid only
  // with the exact position it stands for (Codex review P04-3 #4).
  if (!Number.isSafeInteger(ms) || (eventId.length === 0 && bar === -1)) return null;
  const cursor: CdcCursor = { occurredAtMs: ms, eventId };
  if (bar !== -1) {
    const m = POSITION.exec(rest.slice(bar + 1));
    if (!m) return null;
    const seq = Number(m[2]);
    if (!Number.isSafeInteger(seq)) return null;
    cursor.position = { txid: m[1]!, seq };
  }
  return encodeCdcCursor(cursor) === token ? cursor : null;
}

export const CdcCursorTokenSchema = z
  .string()
  .min(1)
  .refine((token) => decodeCdcCursor(token) !== null, {
    message: 'Malformed cursor token',
  });

/**
 * Delivery envelope (design §4). `id` is the idempotency key; `cursor` is
 * this event's own keyset token so consumers can ack mid-batch. `data` is
 * present only in snapshot mode and is already masked.
 */
/** Maps a resource kind to the plural namespace used in the envelope `type`. */
export const CDC_RESOURCE_TYPE_PREFIX = {
  item: 'items',
  collection: 'collections',
  field: 'fields',
  setting: 'settings',
  content_version: 'versions',
  translation_group: 'translation_groups',
  content_route: 'content_routes',
  redirect: 'redirects',
  site_content_settings: 'site_content_settings',
  theme: 'themes',
  site_seo_settings: 'site_seo_settings',
  site_identity: 'site_identity',
} as const satisfies Record<z.infer<typeof CdcResourceSchema>, string>;

/** Builds the envelope `type` string, e.g. `('collection','update') → 'collections.update'`. */
export function cdcEventType(
  resource: z.infer<typeof CdcResourceSchema>,
  operation: z.infer<typeof CdcOperationSchema>,
): string {
  return `${CDC_RESOURCE_TYPE_PREFIX[resource]}.${operation}`;
}

export const EventEnvelopeSchema = z.object({
  id: z.string().min(1),
  // Every resource kind's namespace (HeoPress P07, Codex review of batch 5a: the site network's kinds were left out).
  type: z.string().regex(new RegExp(`^(${Object.values(CDC_RESOURCE_TYPE_PREFIX).join('|')})\\.(create|update|delete)$`)),
  schemaVersion: z.number().int().min(1),
  siteId: z.string().min(1),
  collection: z.string().min(1),
  itemId: z.string().min(1),
  operation: CdcOperationSchema,
  occurredAt: z.string().datetime(),
  actor: z.object({
    type: CdcActorTypeSchema,
    id: z.string().min(1).optional(),
  }),
  source: CdcSourceSchema,
  changedFields: z.array(z.string()).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  cursor: CdcCursorTokenSchema,
});

export const CdcSubscriptionCreateSchema = z
  .object({
    name: z.string().min(1).max(128),
    kind: CdcSubscriptionKindSchema,
    collections: z.array(z.string().min(1)).default([]),
    operations: z.array(CdcOperationSchema).default([]),
    payload_mode: CdcPayloadModeSchema.default('reference'),
    webhook_id: z.string().min(1).optional(),
    extension_name: z.string().min(1).optional(),
  })
  .superRefine((sub, ctx) => {
    if (sub.kind === 'webhook' && !sub.webhook_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['webhook_id'],
        message: 'webhook_id is required for kind=webhook',
      });
    }
    if (sub.kind === 'extension' && !sub.extension_name) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['extension_name'],
        message: 'extension_name is required for kind=extension',
      });
    }
  });

/** kind is immutable after creation; status flips only between active/paused here. */
export const CdcSubscriptionPatchSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  collections: z.array(z.string().min(1)).optional(),
  operations: z.array(CdcOperationSchema).optional(),
  payload_mode: CdcPayloadModeSchema.optional(),
  status: z.enum(['active', 'paused']).optional(),
});

export const CdcAckSchema = z.object({
  cursor: CdcCursorTokenSchema,
});

export const CdcReplaySchema = z
  .object({
    cursor: CdcCursorTokenSchema.optional(),
    occurred_after: z.string().datetime().optional(),
  })
  .refine((r) => (r.cursor !== undefined) !== (r.occurred_after !== undefined), {
    message: 'Provide exactly one of cursor or occurred_after',
  });

const csvToArray = (value: unknown) =>
  typeof value === 'string' && value.length > 0 ? value.split(',') : value;

export const CdcFeedQuerySchema = z.object({
  cursor: CdcCursorTokenSchema.optional(),
  collections: z.preprocess(csvToArray, z.array(z.string().min(1)).optional()),
  operations: z.preprocess(csvToArray, z.array(CdcOperationSchema).optional()),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  /**
   * Long-poll budget in seconds (0 = return immediately). When the first read
   * is empty, the server holds the request and re-reads until an event appears
   * or the budget elapses. Capped at 25s to stay under typical edge/gateway
   * request timeouts.
   */
  wait: z.coerce.number().int().min(0).max(25).default(0),
});

/** Per-site settings under key `cdc_feed` (Req 1.5, 6.1). */
export const CdcFeedSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  /** Days a confirmed event is kept (HeoPress P04: 30 by default). */
  retentionDays: z.number().int().min(1).max(90).default(30),
});

export type CdcOperation = z.infer<typeof CdcOperationSchema>;
export type CdcResource = z.infer<typeof CdcResourceSchema>;
export type CdcActorType = z.infer<typeof CdcActorTypeSchema>;
export type CdcSource = z.infer<typeof CdcSourceSchema>;
export type CdcPayloadMode = z.infer<typeof CdcPayloadModeSchema>;
export type CdcSubscriptionKind = z.infer<typeof CdcSubscriptionKindSchema>;
export type CdcSubscriptionStatus = z.infer<typeof CdcSubscriptionStatusSchema>;
export type CdcEventEnvelope = z.infer<typeof EventEnvelopeSchema>;
export type CdcSubscriptionCreateInput = z.infer<typeof CdcSubscriptionCreateSchema>;
export type CdcSubscriptionPatchInput = z.infer<typeof CdcSubscriptionPatchSchema>;
export type CdcAckInput = z.infer<typeof CdcAckSchema>;
export type CdcReplayInput = z.infer<typeof CdcReplaySchema>;
export type CdcFeedQuery = z.infer<typeof CdcFeedQuerySchema>;
export type CdcFeedSettings = z.infer<typeof CdcFeedSettingsSchema>;
