// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import {
  activity,
  contentIntents,
  extensions as extensionsTable,
  items,
  itemIdempotencyKeys,
  relations,
  revisions,
  scopeSite,
  materializedCollections,
  type Database,
  siteContentSettings,
} from '@heopress/database';
import { refreshPhysicalTable, type MaterializeConfig } from './materialize-service';
import { dispatchItemEvent } from './flow-dispatch';
import { and, asc, desc, eq, gt, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { SchemaService } from './schema-service';
import { validateItem } from './validation';
import {
  type CacheProvider,
  type EdgeCacheProvider,
  type SearchProvider,
  type QueueProvider,
  type RealtimeProvider,
} from '@heopress/runtime';
import { PermissionService, type CompiledPermission, type PermissionAction } from './permission-service';
import { applyFieldMask, evaluate, type MagicContext } from './permission-dsl';
import type { PolicyRule } from '@heopress/contracts';
import { CryptoService, DecryptionError, SingleKeyProvider, type CryptoContext } from './crypto-service';
import {
  newEnvelopeRecordCipher,
  openEnvelopeRecordCipher,
  sharedRecordCipher,
  type RecordCipher,
} from './crypto/record-cipher';
import { readEnvelopeSetting } from './crypto/envelope-settings';
import {
  assertEditorialGate,
  editorialStateFromStatus,
  type EditorialState,
} from './editorial-service';
import type { KeyProvider } from '@heopress/runtime';
import { nanoid } from 'nanoid';
import { ExtensionSandbox, type ExtensionActorDataAccess } from '../extensions/sandbox';
import { HookDispatcher } from '../extensions/hook-dispatcher';
import { buildSandboxVerifyOptions } from './extension-verifier';
import type { Bindings } from '../env';
import {
  OutboxWriter,
  type OutboxActor,
} from '../modules/cdc/change-feed/outbox-writer';
import { CDC_DISPATCH_QUEUE } from '../modules/cdc/change-feed/dispatcher';
import type { CdcOperation } from '@heopress/contracts/schemas';
import { AuditLogger } from '../modules/audit/logger';
import { writeFieldAccessLog as enqueueFieldAccessLog } from '../modules/audit/field-access';
import { WriteCoalescer } from './load-guard-service';
import type { PrimaryKeyType, StorageMode } from './schema-service';
import { formatSafeError } from '@heopress/contracts/utils';
import {
  dispatchItemRevalidation,
  invalidateItemsTag,
} from './content-invalidation';
import { runItemWriteTransaction, runSiteTransaction } from './rls-transaction';
import { hasOpenLicenceHold } from './ingest/licence-lapse';

const BULK_INSERT_CHUNK = 100;

export function bulkMaxItems(env?: Record<string, string | undefined>): number {
  const raw = env?.HEOPRESS_BULK_MAX ?? process.env.HEOPRESS_BULK_MAX ?? '500';
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 500;
}

/**
 * ItemService — generic CRUD over the `items` JSONB store, driven by the
 * SchemaService manifest. Handles list/detail/create/update/delete + bulk
 * with multi-tenant scoping and pluggable filter/sort/paginate. Permissions
 * (Phase C) wrap this service with row/field masks.
 */

export interface ListItemsParams {
  fields?: string[];
  deep?: DeepQuery;
  filter?: ItemFilter;
  sort?: string[];
  limit?: number;
  offset?: number;
  status?: string | null;
  /**
   * Whether to run the `count(*)` total (high-load-cache-readiness Req 5).
   * Defaults to `true` to preserve the historical response shape; callers that
   * don't render a total (infinite scroll, delivery) pass `false` to skip the
   * extra aggregate query. When `false`, `meta.total` is omitted.
   */
  withTotal?: boolean;
}

export type ItemFilterOp =
  | '_eq'
  | '_neq'
  | '_in'
  | '_nin'
  | '_gt'
  | '_gte'
  | '_lt'
  | '_lte'
  | '_contains'
  | '_starts_with'
  | '_ends_with'
  | '_null'
  | '_nnull'
  // JSON field-search (json-field-search Req 3): containment + key-existence.
  | '_json_contains'
  | '_has_key'
  | '_has_any_keys'
  | '_has_all_keys';

/** Recursive tree-shaped filter, e.g. `{ _and: [ { status: { _eq: 'published' } } ] }`. */
export interface ItemFilter {
  _and?: ItemFilter[];
  _or?: ItemFilter[];
  [key: string]:
    | { [op in ItemFilterOp]?: unknown }
    | ItemFilter[]
    | undefined;
}

export interface ItemRow {
  id: string;
  siteId: string;
  collectionId: string;
  status: string;
  data: Record<string, unknown>;
  sort: number;
  userCreated: string | null;
  userUpdated: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface DeepRelationOptions {
  fields?: string[];
  limit?: number;
}

export type DeepQuery = Record<string, DeepRelationOptions>;

/**
 * Relation aliases that must never be used as object keys: reading or writing
 * them walks the prototype chain (`obj['__proto__']` resolves to
 * `Object.prototype`), which turns a user-controlled `deep[<alias>][...]` query
 * param into a prototype-pollution sink. No real relation is ever named these.
 */
const UNSAFE_ALIASES = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Per-record crypto threading for {@link ItemService.processCrypto}.
 * - `dekWrapped` (read): the record's stored wrapped DEK; non-null selects the
 *   envelope cipher for that record.
 * - `wrappedDek` (write, out): set by an encrypt pass to the wrapped DEK to
 *   persist on the row (envelope mode), or null in shared-key mode.
 */
interface CryptoRecordOpts {
  dekWrapped?: string | null;
  wrappedDek?: string | null;
}

import { AiResultSupersededError, ItemServiceError, VersionConflictError, versionRequired } from './item-service-error';
import { assignBlockIds, BlockError, blockFieldsOf, replaceHtmlBlock, replaceRowBlock, type BlockFieldKind } from './block-ids';
import { lockContentSettingsShared, rebuildRoutes, syncContentRoute } from './site-network/content-routes';
import { SPONSOR_FIELDS, sponsorMarkingDiffers } from './site-network/sponsored-items';
import { allocateItemNumber, firstPublishColumns } from './site-network/publish-time';
import {
  assertMayPublishInGroup,
  assertMembershipUnchanged,
  followItemLocale,
  itemLocale,
  lockMembership,
  onMemberDeleted,
  onMemberRemoved,
  withTransactionRetry,
  writeGroupEvents,
} from './site-network/translation-groups';
import { changedSharedFields, isGroupSource, recordSharedSyncs, sharedFieldsOf, triggerOf } from './site-network/shared-fields';
import { recordTargetWrite } from './site-network/freshness';
import { assertNotBoundSingleWrite } from './auto-publish/locale-set';
// Registers the public projection flush that every site transaction runs before committing (P06).
import './site-network/public-projection';
import { assertPublishAllowed } from './publish-guard';

export { AiResultSupersededError, ItemServiceError, VersionConflictError, versionRequired };

/** Inside a write's transaction: the version moved (the 409 is built after the rollback). */
class VersionMoved extends Error {
  constructor(public readonly currentVersion: number) {
    super('version moved');
  }
}

/** An `Idempotency-Key` and the hash of the request it was sent with (P04). */
export interface IdempotencyInput {
  key: string;
  requestHash: string;
}

/** How long a key stands for its write. */
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export type BulkOp = 'create' | 'update' | 'publish' | 'delete';
type BulkItemStatus = 'succeeded' | 'unchanged' | 'blocked' | 'conflict' | 'failed';

/** One entry's outcome in a bulk request (P04). `index` is its position in the request. */
export interface BulkItemResult {
  index: number;
  id: string | null;
  status: BulkItemStatus;
  code?: string;
  message?: string;
  item?: unknown;
}

/** Codes that mean a rule held the entry back, rather than an error. */
const BULK_BLOCKED_CODES = new Set(['ITEM_HELD', 'PINNED_BY_HUMAN', 'EDITORIAL_GATE_REQUIRED']);

function bulkFailure(err: unknown): Pick<BulkItemResult, 'status' | 'code' | 'message'> {
  if (err instanceof VersionConflictError) return { status: 'conflict', code: err.code, message: err.message };
  if (err instanceof ItemServiceError) {
    return { status: BULK_BLOCKED_CODES.has(err.code) ? 'blocked' : 'failed', code: err.code, message: err.message };
  }
  // A key taken concurrently (unique violation), possibly wrapped by Drizzle.
  for (let e: unknown = err, depth = 0; e && depth < 3; e = (e as { cause?: unknown }).cause, depth++) {
    if ((e as { code?: unknown }).code === '23505') {
      return { status: 'failed', code: 'DUPLICATE_ID', message: 'An item with this id already exists.' };
    }
  }
  // Unknown errors are not echoed: they may carry internals.
  console.error('[items] bulk entry failed', formatSafeError(err));
  return { status: 'failed', code: 'INTERNAL', message: 'The entry could not be processed.' };
}

interface PrimaryKeyStrategyInput {
  field?: string | null;
  type?: string | null;
  storageMode?: string | null;
}

export interface PrimaryKeyResolution {
  field: string;
  type: PrimaryKeyType;
  storageMode: StorageMode;
  id: string | undefined;
}

/**
 * Provenance carried onto every revision written by this service instance.
 * Human callers omit it (defaults to authorType 'human'); the AI harness
 * sets an agent provenance with the executing run id before invoking skills.
 */
export interface ItemProvenance {
  /**
   * `integration` (P04): an API key — a program, not a person and not an
   * agent run. Its edits do not pin fields and do not supersede AI results.
   */
  authorType: 'human' | 'agent' | 'integration';
  runId?: string | null;
  model?: string | null;
  constitutionHash?: string | null;
  /** Source references (URLs, item ids, memory ids) used by the agent. */
  sources?: unknown[] | null;
  /** Agent self-reported confidence in [0, 1]. */
  confidence?: number | null;
}

export interface ItemServiceDeps {
  db: Database;
  /** Optional cache used by SchemaService for compiled manifests. */
  cache?: CacheProvider;
  /**
   * Optional HTTP edge cache. Supplied so a content write can reach the copy
   * stored at the edge, not just the application cache (#392).
   */
  edgeCache?: EdgeCacheProvider;
  /**
   * Negative-cache TTL (seconds) forwarded to SchemaService (Req 19.5).
   * Resolved from the runtime env by the caller — see the note on
   * `SchemaServiceDeps.negativeCacheTtl` for why it is not read from
   * `process.env` inside the service.
   */
  negativeCacheTtl?: number;
  /** Optional search provider for auto-indexing content on create/update/delete. */
  search?: SearchProvider;
  /** Optional queue provider for enqueuing background jobs. */
  queue?: QueueProvider;
  siteId: string;
  /**
   * HeoPress P09 task 3.7: this write is part of a required-language-set publish or unpublish (or a recorded
   * single-language exception), so the set guard does not refuse it.
   */
  localeSetWrite?: boolean;
  /** Caller user id; written to revisions/activity for audit. */
  userId?: string | null;
  /** Optional MagicContext to enable permission filtering (Phase C). */
  permissionCtx?: MagicContext;
  /** Optional base64 AES-GCM key for field encryption (legacy single-key path). */
  encryptionKey?: string;
  /**
   * Optional runtime KeyProvider enabling key versioning/rotation. When
   * provided it takes precedence over `encryptionKey`.
   */
  keyProvider?: KeyProvider;
  /**
   * Runtime realtime provider (ADR-002). When provided, item mutations are
   * published through it (the in-process Docker hub).
   */
  realtime?: RealtimeProvider;
  /**
   * Environment bindings passed to ExtensionSandbox for capability-gated access.
   * When omitted, extension hooks are skipped.
   */
  extensionEnv?: Record<string, unknown>;
  /** Internal guard for actor-scoped extension item access to avoid recursive hooks. */
  suppressExtensionHooks?: boolean;
  /** Revision provenance; defaults to `{ authorType: 'human' }` when omitted. */
  provenance?: ItemProvenance;
  /**
   * The database for work after the write commits (flow dispatch) when `db` is a transaction handle
   * (HeoPress P05, design R27). Defaults to `db`.
   */
  rootDb?: Database;
  /**
   * Change Feed actor override (spec cdc-extension-integration, Req 1.1).
   * Lets the request factory attribute outbox events to an API key
   * (`{ type: 'api_key', id }`) — ItemService itself only knows `userId`.
   * When omitted the actor is derived: agent provenance → agent, userId →
   * user, otherwise system.
   */
  cdcActor?: OutboxActor;
}

const STRUCTURAL_FIELDS = new Set([
  'id',
  'status',
  'sort',
  'user_created',
  'user_updated',
  'created_at',
  'updated_at',
]);

const WRITABLE_STRUCTURAL_FIELDS = ['status', 'sort'] as const;

type RelationMetadata = typeof relations.$inferSelect;

// JSON field-search limits (json-field-search Req 5).
const MAX_PATH_DEPTH = 8;
const MAX_SEGMENT_LEN = 64;
const MAX_FILTER_CLAUSES = 100;
const SEGMENT_RE = /^[A-Za-z0-9_]+$/;

/**
 * Validate + split a field reference into path segments. A dotted key (e.g.
 * `metadata.author.country`) addresses nested JSONB; a single segment keeps the
 * existing top-level behavior. Throws INVALID_FILTER on any unsafe / malformed
 * segment so nothing unvalidated reaches SQL (json-field-search Req 5, 6).
 */
export function resolveFieldPath(name: string): string[] {
  const segments = name.split('.');
  if (segments.length > MAX_PATH_DEPTH) {
    throw new ItemServiceError('INVALID_FILTER', 'Filter path is too deep.');
  }
  for (const seg of segments) {
    if (seg.length === 0 || seg.length > MAX_SEGMENT_LEN || !SEGMENT_RE.test(seg)) {
      throw new ItemServiceError('INVALID_FILTER', `Invalid path segment "${seg}".`);
    }
  }
  return segments;
}

/**
 * Bind a validated path as a Postgres `text[]` for `#>` / `#>>`. The array
 * literal is passed as a single BOUND parameter (`'{a,b}'` → `::text[]`), not a
 * positional record — segments have already passed the strict allow-list, so no
 * special character can appear inside the braces.
 */
function bindArrayLiteral(segments: string[]): SQL {
  const literal = `{${segments.join(',')}}`;
  return sql`${literal}::text[]`;
}

/**
 * Coerce a `_has_any_keys`/`_has_all_keys` value to a bound `text[]` SQL. Each
 * key is a bound parameter inside `array[...]::text[]` (user values, so they
 * must stay parameterized — never inlined). Rejects non-string arrays.
 */
function asKeyArray(raw: unknown, op: string): SQL {
  if (!Array.isArray(raw) || raw.length === 0 || !raw.every((v) => typeof v === 'string')) {
    throw new ItemServiceError('INVALID_FILTER', `Operator "${op}" expects a non-empty array of strings.`);
  }
  const bound = (raw as string[]).map((k) => sql`${k}`);
  return sql`array[${sql.join(bound, sql`, `)}]::text[]`;
}

/** Reserved data keys that map to structural columns rather than JSONB. */
function fieldExpression(name: string, mode: 'text' | 'json' = 'text'): SQL {
  switch (name) {
    case 'id':
      return items.id as unknown as SQL;
    case 'status':
      return items.status as unknown as SQL;
    case 'sort':
      return items.sort as unknown as SQL;
    case 'user_created':
      return items.userCreated as unknown as SQL;
    case 'user_updated':
      return items.userUpdated as unknown as SQL;
    case 'created_at':
      return items.createdAt as unknown as SQL;
    case 'updated_at':
      return items.updatedAt as unknown as SQL;
    default: {
      // JSONB access. `name` may be a dotted path into nested JSON.
      const segments = resolveFieldPath(name);
      if (segments.length === 1) {
        // Top-level — unchanged. Drizzle keeps the key a bound parameter.
        return mode === 'json' ? sql`${items.data}->${segments[0]}` : sql`${items.data}->>${segments[0]}`;
      }
      // Nested path via #> / #>>, which take a text[]. Every segment has already
      // passed the strict `^[A-Za-z0-9_]+$` allow-list in resolveFieldPath, so
      // building the array literal cannot inject (no quotes/braces/commas can
      // appear in a segment). `bindArrayLiteral` produces a parameter-bound
      // `'{a,b}'::text[]` rather than a positional record.
      const pathArray = bindArrayLiteral(segments);
      return mode === 'json' ? sql`${items.data}#>${pathArray}` : sql`${items.data}#>>${pathArray}`;
    }
  }
}

function buildFilter(filter?: ItemFilter): SQL | undefined {
  if (!filter) return undefined;
  const clauses: SQL[] = [];

  if (filter._and?.length) {
    const sub = filter._and
      .map(buildFilter)
      .filter((c): c is SQL => c !== undefined);
    if (sub.length) clauses.push(sql.join(sub, sql` and `));
  }

  if (filter._or?.length) {
    const sub = filter._or
      .map(buildFilter)
      .filter((c): c is SQL => c !== undefined);
    if (sub.length) clauses.push(sql`(${sql.join(sub, sql` or `)})`);
  }

  for (const [key, value] of Object.entries(filter)) {
    if (key === '_and' || key === '_or') continue;
    if (!value || typeof value !== 'object') continue;
    const expr = fieldExpression(key);
    for (const [op, raw] of Object.entries(value as Record<string, unknown>)) {
      if (clauses.length >= MAX_FILTER_CLAUSES) {
        throw new ItemServiceError('INVALID_FILTER', 'Filter has too many clauses.');
      }
      switch (op as ItemFilterOp) {
        // ── JSON containment / key-existence (json-field-search Req 3) ──
        // Use the json-mode expression (-> / #>) and jsonb_* functions rather
        // than the ?/?|/?& operators (which collide with the driver's
        // parameter placeholder). Value/keys are bound parameters.
        case '_json_contains':
          clauses.push(sql`${fieldExpression(key, 'json')} @> ${JSON.stringify(raw)}::jsonb`);
          break;
        case '_has_key':
          clauses.push(sql`jsonb_exists(${fieldExpression(key, 'json')}, ${String(raw)})`);
          break;
        case '_has_any_keys':
          clauses.push(sql`jsonb_exists_any(${fieldExpression(key, 'json')}, ${asKeyArray(raw, op)})`);
          break;
        case '_has_all_keys':
          clauses.push(sql`jsonb_exists_all(${fieldExpression(key, 'json')}, ${asKeyArray(raw, op)})`);
          break;
        case '_eq':
          clauses.push(sql`${expr} = ${raw}`);
          break;
        case '_neq':
          clauses.push(sql`${expr} <> ${raw}`);
          break;
        case '_in':
          clauses.push(sql`${expr} = any(${raw as unknown[]})`);
          break;
        case '_nin':
          clauses.push(sql`${expr} <> all(${raw as unknown[]})`);
          break;
        case '_gt':
          clauses.push(sql`${expr} > ${raw}`);
          break;
        case '_gte':
          clauses.push(sql`${expr} >= ${raw}`);
          break;
        case '_lt':
          clauses.push(sql`${expr} < ${raw}`);
          break;
        case '_lte':
          clauses.push(sql`${expr} <= ${raw}`);
          break;
        case '_contains':
          clauses.push(sql`${expr} ilike ${'%' + String(raw) + '%'}`);
          break;
        case '_starts_with':
          clauses.push(sql`${expr} ilike ${String(raw) + '%'}`);
          break;
        case '_ends_with':
          clauses.push(sql`${expr} ilike ${'%' + String(raw)}`);
          break;
        case '_null':
          clauses.push(raw ? sql`${expr} is null` : sql`${expr} is not null`);
          break;
        case '_nnull':
          clauses.push(raw ? sql`${expr} is not null` : sql`${expr} is null`);
          break;
        default:
          throw new ItemServiceError('INVALID_FILTER', `Unknown operator "${op}".`);
      }
    }
  }

  if (!clauses.length) return undefined;
  return sql.join(clauses, sql` and `);
}

function buildSort(sort?: string[]): SQL[] {
  if (!sort?.length) return [desc(items.updatedAt)];
  return sort.map((token) => {
    const dir = token.startsWith('-') ? desc : asc;
    const name = token.replace(/^[-+]/, '');
    return dir(fieldExpression(name) as never);
  });
}

export class ItemService {
  private readonly schemaService: SchemaService;
  private readonly permissions: PermissionService | null;
  private readonly cryptoService: CryptoService | null;
  /** KEK provider for envelope mode (wrap/unwrap per-record DEKs). */
  private readonly keyProvider: KeyProvider | null;
  private hookDispatcher: HookDispatcher | null = null;
  private outboxWriter: OutboxWriter | null = null;
  private provenance: ItemProvenance;
  private writeCoalescer: WriteCoalescer | null = null;
  /** Memoized per-site envelope-write decision (resolved at most once). */
  private envelopeWritePromise: Promise<boolean> | null = null;

  constructor(private readonly deps: ItemServiceDeps) {
    this.provenance = deps.provenance ?? { authorType: 'human' };
    this.schemaService = new SchemaService({
      db: deps.db,
      siteId: deps.siteId,
      cache: deps.cache,
      negativeCacheTtl: deps.negativeCacheTtl,
    });
    this.permissions = deps.permissionCtx
      ? new PermissionService({ db: deps.db, cache: deps.cache, ctx: deps.permissionCtx })
      : null;
    this.keyProvider = deps.keyProvider
      ? deps.keyProvider
      : deps.encryptionKey
        ? new SingleKeyProvider(deps.encryptionKey)
        : null;
    this.cryptoService = this.keyProvider ? new CryptoService(this.keyProvider) : null;
  }

  /**
   * The same service bound to a different principal's row/field rules.
   *
   * Exists for work that is **authorised by one principal and triggered by
   * another** — an approval being executed after a human approves it (#472).
   * The action must run under the requester's rules, not the approver's, so the
   * executing service has to be rebound at that moment.
   *
   * Every other dependency is carried over deliberately. Constructing a fresh
   * `ItemService` from `{ db, siteId }` alone would silently drop the cache,
   * search, queue, key provider and extension environment, so writes would stop
   * invalidating tags and stop indexing — a regression that looks like nothing at
   * the call site and shows up as stale reads later (DoD §2b).
   *
   * `siteId` comes from the context, so a context for another tenant cannot be
   * used to widen this service's scope; the caller checks tenancy first, and this
   * keeps the two from disagreeing.
   */
  withPermissionContext(permissionCtx: MagicContext): ItemService {
    const next = new ItemService({ ...this.deps, siteId: permissionCtx.siteId, permissionCtx });
    next.setProvenance(this.provenance);
    return next;
  }

  /**
   * Whether new writes for this site should use envelope (per-record DEK) mode.
   * Driven by the `encryption.envelope` setting (operator-controlled, not a raw
   * env flag); memoized so a batch write reads the setting at most once.
   */
  private envelopeWriteEnabled(): Promise<boolean> {
    if (!this.envelopeWritePromise) {
      this.envelopeWritePromise = readEnvelopeSetting(this.deps.db, this.deps.siteId)
        .then((s) => s.enabled)
        .catch(() => false);
    }
    return this.envelopeWritePromise;
  }

  /**
   * Overrides revision provenance for subsequent writes. Called by the AI
   * harness once the executing run is known (the run is created after this
   * service instance is constructed).
   */
  setProvenance(provenance: ItemProvenance): void {
    this.provenance = provenance;
  }

  /** Set only inside `applySharedSync`: the one write that may change a translation's shared fields (P05, design R3). */
  private sharedSyncWrite = false;
  /** While set, work after a write waits here for the caller's outer transaction to commit (design R23). */
  private afterCommitSink: Array<() => Promise<void>> | null = null;

  /**
   * Create inside the caller's transaction (HeoPress P05: a translation draft created, joined and mapped
   * at once): `db` is that transaction; the work after the write waits in `afterCommit` for its commit.
   */
  async createInTransaction(
    collectionName: string,
    payload: Parameters<ItemService['create']>[1],
    afterCommit: Array<() => Promise<void>>,
  ): Promise<{ id: string; version: number }> {
    this.afterCommitSink = afterCommit;
    try {
      return (await this.create(collectionName, payload)) as { id: string; version: number };
    } finally {
      this.afterCommitSink = null;
    }
  }

  /**
   * Update inside the caller's transaction (HeoPress P12: a site import, a batch activation): `db` is that
   * transaction; the work after the write waits in `afterCommit` for its commit (nothing runs for a dry run that
   * rolls back).
   */
  async patchInTransaction(
    collectionName: string,
    id: string,
    patch: Parameters<ItemService['patch']>[2],
    afterCommit: Array<() => Promise<void>>,
  ): Promise<{ id: string; version: number }> {
    this.afterCommitSink = afterCommit;
    try {
      return (await this.patch(collectionName, id, patch)) as unknown as { id: string; version: number };
    } finally {
      this.afterCommitSink = null;
    }
  }

  /** What follows a create once it is committed: realtime, flows, consumers, the after hook, caches. */
  private async afterCreateWork(collectionName: string, itemId: string, data: Record<string, unknown>, awaitHook: boolean, hooks?: HookDispatcher | null): Promise<void> {
    await this.publishRealtimeEvent(collectionName, 'create', itemId);
    await this.dispatchFlowEvent(collectionName, 'create', itemId, data);
    this.wakeConsumers();
    const dispatcher = hooks === undefined ? await this.getHookDispatcher() : hooks;
    const after = dispatcher?.dispatch('items.create.after', { collection: collectionName, item: data, itemId, userId: this.deps.userId ?? null, siteId: this.deps.siteId }).catch(() => {});
    if (awaitHook) await after;
    await this.afterWriteInvalidation(collectionName);
  }

  /** What follows an update once it is committed: realtime, flows, consumers, the after hook, caches. */
  private async afterUpdateWork(
    collectionName: string,
    itemId: string,
    data: Record<string, unknown>,
    awaitHook: boolean,
    hooks?: HookDispatcher | null,
  ): Promise<void> {
    await this.publishRealtimeEvent(collectionName, 'update', itemId);
    await this.dispatchFlowEvent(collectionName, 'update', itemId, data);
    this.wakeConsumers();
    const dispatcher = hooks === undefined ? await this.getHookDispatcher() : hooks;
    const after = dispatcher?.dispatch('items.update.after', { collection: collectionName, item: data, itemId, userId: this.deps.userId ?? null, siteId: this.deps.siteId }).catch(() => {});
    // Normally fire-and-forget; awaited when the work runs in a transaction of its own.
    if (awaitHook) await after;
    await this.afterWriteInvalidation(collectionName);
  }

  /**
   * Write a shared field sync's values to a translation group member (HeoPress P05, design R3): an
   * ordinary update of the item at its current version — this principal's permissions, the Hold and
   * publish guards, a new version and change event — except that it may change shared fields.
   * Internal: no route passes it.
   */
  async applySharedSync(
    collectionName: string,
    id: string,
    values: Record<string, unknown>,
    /** Work after the write (realtime, flows, caches) goes here, run by the caller after its transaction commits. */
    afterCommit: Array<() => Promise<void>>,
  ): Promise<void> {
    const [row] = await this.deps.db
      .select({ version: items.version })
      .from(items)
      .where(and(scopeSite(items.siteId, this.deps.siteId), eq(items.id, id), isNull(items.deletedAt)))
      .limit(1);
    if (!row) throw new ItemServiceError('NOT_FOUND', `Item "${id}" not found.`, 404);
    // Not a person's edit (design R3): recorded as an integration write, so it neither pins fields nor
    // supersedes AI results; the principal's permissions still decide.
    const provenance = this.provenance;
    this.sharedSyncWrite = true;
    this.afterCommitSink = afterCommit;
    this.provenance = { authorType: 'integration', sources: [{ type: 'shared_field_sync' }] };
    try {
      await this.patch(collectionName, id, { data: values, expectedVersion: row.version });
    } finally {
      this.sharedSyncWrite = false;
      this.afterCommitSink = null;
      this.provenance = provenance;
    }
  }

  /** Resolve permission for the active principal; returns null when denied. */
  private async perm(collectionName: string, action: PermissionAction) {
    if (!this.permissions) return null;
    const granted = await this.permissions.canAccess(collectionName, action);
    if (!granted) {
      throw new ItemServiceError('FORBIDDEN', `Action "${action}" on "${collectionName}" is not allowed.`, 403);
    }
    return granted;
  }

  /**
   * Lazily load the HookDispatcher for this site's enabled extensions.
   * Cached after first call; re-loaded if extensions change (evict from sandbox).
   */
  private async getHookDispatcher(): Promise<HookDispatcher | null> {
    if (this.deps.suppressExtensionHooks) return null;
    if (!this.deps.extensionEnv) return null;
    if (this.hookDispatcher) return this.hookDispatcher;
    try {
      const rows = await this.deps.db
        .select()
        .from(extensionsTable)
        .where(
          and(
            eq(extensionsTable.siteId, this.deps.siteId),
            eq(extensionsTable.enabled, true),
            eq(extensionsTable.type, 'hook'),
          ),
        );
      const sandbox = new ExtensionSandbox(this.deps.extensionEnv as never, {
        actorDataAccess: this.actorDataAccess(),
        // A refused capability use is recorded (HeoPress P12 extensions/permissions).
        onDenied: async (event) => {
          const actorEmail =
            typeof this.deps.permissionCtx?.user?.email === 'string'
              ? this.deps.permissionCtx.user.email
              : null;
          await new AuditLogger({ db: this.deps.db, siteId: this.deps.siteId }).write({
            event: 'extension_capability_denied',
            actorEmail,
            ip: this.deps.permissionCtx?.ip ?? null,
            userAgent: this.deps.permissionCtx?.headers?.['user-agent'] ?? null,
            requestId: null,
            metadata: {
              extensionName: event.extensionName,
              capability: event.capability,
              operation: event.operation,
              siteId: this.deps.siteId,
              userId: this.deps.userId ?? null,
            },
          });
        },
      });
      this.hookDispatcher = new HookDispatcher(sandbox, rows, undefined, (ext) =>
        buildSandboxVerifyOptions(ext, this.deps.db, this.deps.extensionEnv as unknown as Bindings),
      );
    } catch {
      /* non-critical — return null if extensions can't be loaded */
    }
    return this.hookDispatcher;
  }

  /**
   * Append a Change Feed outbox event for a committed mutation (spec
   * cdc-extension-integration, Req 1.2–1.6). Sits in the same post-mutation
   * side-effect cluster as indexing/realtime/flows; the writer never throws
   * (a failed insert emits a `cdc_event_write_failed` audit warning instead
   * — Req 1.3) and returns immediately for sites without the feed enabled.
   */
  /** Who an idempotency key belongs to: keys are per caller. */
  private idempotencyScope(): string {
    if (this.deps.cdcActor?.type === 'api_key') return `api_key:${this.deps.cdcActor.id}`;
    if (this.deps.userId) return `user:${this.deps.userId}`;
    return 'system';
  }

  /**
   * The write an idempotency key already stands for (P04, task 9.2), within
   * the retention day: `{ itemId }` when the same request was committed,
   * IDEMPOTENCY_KEY_REUSED (422) when the key was used for another request,
   * null when it is new.
   */
  async findIdempotent(idempotency: IdempotencyInput): Promise<{ collection: string; itemId: string } | null> {
    const [row] = await this.deps.db
      .select()
      .from(itemIdempotencyKeys)
      .where(
        and(
          eq(itemIdempotencyKeys.siteId, this.deps.siteId),
          eq(itemIdempotencyKeys.scope, this.idempotencyScope()),
          eq(itemIdempotencyKeys.key, idempotency.key),
          gt(itemIdempotencyKeys.createdAt, new Date(Date.now() - IDEMPOTENCY_TTL_MS)),
        ),
      )
      .limit(1);
    if (!row) return null;
    if (row.requestHash !== idempotency.requestHash) {
      throw new ItemServiceError(
        'IDEMPOTENCY_KEY_REUSED',
        'This Idempotency-Key was already used for a different request.',
        422,
      );
    }
    return { collection: row.collection, itemId: row.itemId };
  }

  private async recordIdempotency(
    tx: Pick<Database, 'insert' | 'execute'>,
    collection: string,
    itemId: string,
    idempotency: IdempotencyInput,
  ): Promise<void> {
    // A concurrent request with the same key loses here and rolls back; an
    // expired record of the key is taken over (Codex review P04-2 #12).
    const claimed = await (tx as Pick<Database, 'execute'>).execute(sql`
      INSERT INTO lumibase_item_idempotency_keys (site_id, scope, key, request_hash, collection, item_id)
      VALUES (${this.deps.siteId}, ${this.idempotencyScope()}, ${idempotency.key}, ${idempotency.requestHash}, ${collection}, ${itemId})
      ON CONFLICT (site_id, scope, key) DO UPDATE
         SET request_hash = EXCLUDED.request_hash, collection = EXCLUDED.collection, item_id = EXCLUDED.item_id, created_at = now()
       WHERE lumibase_item_idempotency_keys.created_at <= now() - make_interval(secs => ${IDEMPOTENCY_TTL_MS / 1000})
      RETURNING key`);
    if ((claimed as unknown as unknown[]).length === 0) {
      throw Object.assign(new Error('idempotency key already used'), { code: '23505' });
    }
  }

  private eventWriter(): OutboxWriter {
    this.outboxWriter ??= new OutboxWriter({
      db: this.deps.db,
      siteId: this.deps.siteId,
      cache: this.deps.cache,
      getSensitiveFields: async (coll) => {
        const compiled = await this.schemaService.getCompiled(coll);
        return new Set(
          (compiled?.fields ?? [])
            .filter((f) => f.classification === 'pii' || f.classification === 'phi')
            .map((f) => f.name),
        );
      },
    });
    return this.outboxWriter;
  }

  /**
   * Write the Change Feed event for this change in the change's own
   * transaction (HeoPress P04, ADR-0011): if the event cannot be written the
   * whole change rolls back. `payload` is the plaintext post-change snapshot
   * (masked before storage), null on delete.
   */
  private async writeEvent(
    tx: Pick<Database, 'insert'>,
    collection: string,
    operation: CdcOperation,
    itemId: string,
    payload: Record<string, unknown> | null,
    itemVersion: number | null,
    changedFields?: string[] | null,
    sensitiveFields?: ReadonlySet<string>,
  ): Promise<void> {
    const actor: OutboxActor =
      this.provenance.authorType === 'agent'
        ? { type: 'agent', id: this.provenance.runId ?? null }
        : this.deps.cdcActor ??
          (this.deps.userId
            ? { type: 'user', id: this.deps.userId }
            : { type: 'system' });
    const source =
      this.provenance.authorType === 'agent'
        ? ('agent' as const)
        : actor.type === 'system'
          ? ('system' as const)
          : ('api' as const);
    await this.eventWriter().writeInTransaction(
      tx,
      { collection, itemId, operation, payload, changedFields, itemVersion },
      actor,
      source,
      sensitiveFields,
    );
  }

  /** pii/phi fields of a collection — resolve before a write's transaction (see writeInTransaction). */
  private async sensitiveFieldsOf(collectionName: string): Promise<Set<string>> {
    const compiled = await this.schemaService.getCompiled(collectionName);
    return new Set(
      (compiled?.fields ?? []).filter((f) => f.classification === 'pii' || f.classification === 'phi').map((f) => f.name),
    );
  }

  /** After commit: wake the event consumers (latency only — they also poll). */
  private wakeConsumers(): void {
    this.deps.queue?.enqueue(CDC_DISPATCH_QUEUE, 'dispatch', { siteId: this.deps.siteId }).catch(() => {});
  }

  private actorDataAccess(): ExtensionActorDataAccess {
    const buildService = () =>
      new ItemService({
        ...this.deps,
        suppressExtensionHooks: true,
      });
    return {
      list: (collection, params) => buildService().list(collection, params as ListItemsParams | undefined),
      detail: (collection, id, fields) => buildService().detail(collection, id, fields),
      create: (collection, payload) => buildService().create(collection, payload),
      patch: (collection, id, patch) =>
        buildService().patch(collection, id, { ...patch, expectedVersion: patch.expectedVersion }),
      delete: (collection, id) => buildService().softDelete(collection, id),
    };
  }

  private async resolveCollection(name: string) {
    // Route through SchemaService.getCompiled so collection-name probes share
    // the positive schema cache AND the negative tombstone (Req 19.5 / 19.12).
    const compiled = await this.schemaService.getCompiled(name);
    if (!compiled) {
      throw new ItemServiceError('NOT_FOUND', `Collection "${name}" not found.`, 404);
    }
    return {
      id: compiled.id,
      name: compiled.name,
      primaryKeyField: compiled.primaryKeyField,
      primaryKeyType: compiled.primaryKeyType,
      storageMode: compiled.storageMode,
      meta: compiled.meta,
    };
  }

  async list(collectionName: string, params: ListItemsParams = {}) {
    const coll = await this.resolveCollection(collectionName);
    const perm = await this.perm(collectionName, 'read');
    const permClause = this.permissions?.whereFor(perm) ?? undefined;
    const where = and(
      scopeSite(items.siteId, this.deps.siteId),
      eq(items.collectionId, coll.id),
      isNull(items.deletedAt),
      params.status ? eq(items.status, params.status) : undefined,
      buildFilter(params.filter),
      permClause,
    );

    const limit = Math.min(params.limit ?? 25, 200);
    const offset = params.offset ?? 0;

    const rows = await this.deps.db
      .select()
      .from(items)
      .where(where)
      .orderBy(...buildSort(params.sort))
      .limit(limit)
      .offset(offset);

    // `count(*)` is opt-out (Req 5): skip the extra aggregate when the caller
    // doesn't need a total. Default preserves the historical behaviour.
    const withTotal = params.withTotal ?? true;
    let total: number | undefined;
    if (withTotal) {
      const totals = await this.deps.db
        .select({ count: sql<number>`count(*)::int` })
        .from(items)
        .where(where);
      total = totals[0]?.count ?? 0;
    }

    const knownFields = (await this.schemaService.getCompiled(collectionName))?.fields.map((f) => f.name) ?? [];
    const masked = perm && this.permissions
      ? rows.map((r) => this.permissions!.maskItem(perm, r as ItemRow, knownFields))
      : rows;

    const degraded = this.degradedReadEnabled(coll);
    const decrypted: ItemRow[] = [];
    for (const r of masked) {
      r.data = await this.processCrypto(
        collectionName,
        r.data as Record<string, unknown>,
        'decrypt',
        (r as ItemRow).id,
        false,
        degraded,
        undefined,
        { dekWrapped: (r as Record<string, unknown>).dekWrapped as string | null },
      );
      decrypted.push(r as ItemRow);
    }
    const expanded = params.fields || params.deep
      ? await this.expandRelationFields(collectionName, decrypted, params.fields ?? [], params.deep)
      : decrypted;
    const data = expanded.map((r) => (params.fields ? projectFields(r, params.fields) : r));

    return {
      data,
      meta: total === undefined ? { limit, offset } : { total, limit, offset },
    };
  }

  async detail(collectionName: string, id: string, fields?: string[], deep?: DeepQuery) {
    const perm = await this.perm(collectionName, 'read');
    const permClause = this.permissions?.whereFor(perm) ?? undefined;
    const coll = await this.resolveCollection(collectionName);
    const [row] = await this.deps.db
      .select()
      .from(items)
      .where(
        and(
          scopeSite(items.siteId, this.deps.siteId),
          eq(items.collectionId, coll.id),
          eq(items.id, id),
          isNull(items.deletedAt),
          permClause,
        ),
      )
      .limit(1);
    if (!row) throw new ItemServiceError('NOT_FOUND', `Item "${id}" not found.`, 404);
    const knownFields = (await this.schemaService.getCompiled(collectionName))?.fields.map((f) => f.name) ?? [];
    const masked = perm && this.permissions ? this.permissions.maskItem(perm, row as ItemRow, knownFields) : row;
    masked.data = await this.processCrypto(collectionName, masked.data as Record<string, unknown>, 'decrypt', (masked as ItemRow).id, false, false, undefined, { dekWrapped: (masked as Record<string, unknown>).dekWrapped as string | null });
    if (!fields && !deep) return masked;
    const [expanded] = await this.expandRelationFields(collectionName, [masked as ItemRow], fields ?? [], deep);
    return fields ? projectFields(expanded ?? masked as ItemRow, fields) : expanded ?? masked;
  }

  /**
   * Throws unless the principal may update this item: 403 without the collection's update grant,
   * 404 when its row rule hides the item (HeoPress P05: changing a translation group needs this on
   * every item involved, design D).
   */
  async assertMayUpdate(collectionName: string, id: string, fields: string[] = []): Promise<void> {
    const coll = await this.resolveCollection(collectionName);
    const perm = await this.perm(collectionName, 'update');
    // The fields it would write (a shared field sync), when given.
    if (fields.length > 0) {
      assertWritablePermissionFields(perm, await this.getKnownWritableFields(collectionName), Object.fromEntries(fields.map((f) => [f, null])), {});
    }
    const permClause = this.permissions?.whereFor(perm) ?? undefined;
    const [row] = await this.deps.db
      .select({ id: items.id })
      .from(items)
      .where(and(scopeSite(items.siteId, this.deps.siteId), eq(items.collectionId, coll.id), eq(items.id, id), isNull(items.deletedAt), permClause))
      .limit(1);
    if (!row) throw new ItemServiceError('NOT_FOUND', `Item "${id}" not found.`, 404);
  }

  async create(
    collectionName: string,
    payload: {
      data: Record<string, unknown>;
      status?: string;
      sort?: number;
      publishAt?: string | Date | null;
      unpublishAt?: string | Date | null;
      /**
       * The item's first publish time, given (P05, design R19): an import's original date. Only a site
       * administrator may give it — the route checks. Recorded as `set` and audited.
       */
      publishedAt?: Date | null;
    },
    opts: { idempotency?: IdempotencyInput; actorEmail?: string | null } = {},
  ) {
    const coll = await this.resolveCollection(collectionName);
    const primaryKey = resolvePrimaryKey({
      field: coll.primaryKeyField,
      type: coll.primaryKeyType,
      storageMode: coll.storageMode,
    }, payload.data ?? {});
    const perm = await this.perm(collectionName, 'create');
    const knownFields = await this.getKnownWritableFields(collectionName);
    assertWritablePermissionFields(perm, knownFields, payload.data ?? {}, {
      status: payload.status,
      sort: payload.sort,
    });
    const withPresets = this.permissions?.applyPresets(perm, payload.data ?? {}) ?? payload.data ?? {};
    const status = payload.status ?? 'draft';
    const sort = payload.sort ?? 0;
    const createSnapshot = buildPermissionSnapshot({
      data: withPresets,
      status,
      sort,
      userCreated: this.deps.userId ?? null,
      userUpdated: this.deps.userId ?? null,
    });
    if (perm && this.permissions && !this.permissions.matches(perm, createSnapshot)) {
      throw new ItemServiceError('FORBIDDEN', 'Item violates create rule.', 403);
    }

    // Before hook — extensions can mutate data before insert.
    const hooks = await this.getHookDispatcher();
    const hookCtx = await hooks?.dispatch('items.create.before', {
      collection: collectionName,
      item: withPresets,
      userId: this.deps.userId ?? null,
      siteId: this.deps.siteId,
    }) ?? { collection: collectionName, item: withPresets };
    const hookedData = (hookCtx.item as Record<string, unknown>) ?? withPresets;

    // Stable block IDs (P04) for rich-text and repeater fields.
    const data = assignBlockIds(await this.runValidation(collectionName, hookedData, false), await this.blockFields(collectionName));
    const finalCreateSnapshot = buildPermissionSnapshot({
      data,
      status,
      sort,
      userCreated: this.deps.userId ?? null,
      userUpdated: this.deps.userId ?? null,
    });
    if (perm && this.permissions && !this.permissions.matches(perm, finalCreateSnapshot)) {
      throw new ItemServiceError('FORBIDDEN', 'Item violates create rule.', 403);
    }
    this.assertPermissionValidation(perm, finalCreateSnapshot);
    // Allocate the record id up front so AAD-bound encryption can reference it
    // before the row is flushed (Req 2.3). Matches the schema's nanoid default.
    const recordId = primaryKey.id ?? nanoid();
    const { publishAt, unpublishAt } = normalizePublishWindow(payload.publishAt, payload.unpublishAt);
    const cryptoOut: CryptoRecordOpts = {};
    const encryptedData = await this.processCrypto(collectionName, data, 'encrypt', recordId, true, false, undefined, cryptoOut);
    if (primaryKey.id) {
      await this.assertItemIdAvailable(coll.id, primaryKey.id);
    }
    const sensitive = await this.sensitiveFieldsOf(collectionName);
    const row = await runSiteTransaction(this.deps.db, this.deps.siteId, async (tx) => {
      // The site's content settings first (P05, design §0): the item's path is computed against them.
      await lockContentSettingsShared(tx, this.deps.siteId);
      const number = await allocateItemNumber(tx, this.deps.siteId, coll.id);
      const [inserted] = await tx
        .insert(items)
        .values({
          id: recordId,
          siteId: this.deps.siteId,
          collectionId: coll.id,
          data: encryptedData,
          status,
          sort,
          publishAt,
          unpublishAt,
          dekWrapped: cryptoOut.wrappedDek ?? null,
          userCreated: this.deps.userId ?? null,
          userUpdated: this.deps.userId ?? null,
          number,
          ...(payload.publishedAt ? { publishedAt: payload.publishedAt, publishedAtSource: 'set' } : firstPublishColumns(null, status, new Date())),
        })
        .returning();
      if (!inserted) throw new ItemServiceError('CREATE_FAILED', 'Failed to insert item.');
      if (payload.publishedAt) {
        await new AuditLogger({ db: this.deps.db, siteId: this.deps.siteId }).writeInTransaction(tx, {
          siteId: this.deps.siteId,
          event: 'item_published_at_set',
          actorEmail: opts.actorEmail ?? null,
          metadata: { operator: this.deps.userId ?? null, collection: coll.name, itemId: inserted.id, before: null, after: { publishedAt: payload.publishedAt.toISOString(), source: 'set' } },
        });
      }
      await syncContentRoute(tx, this.deps.siteId, inserted.id, { wasPublished: false });
      await tx.insert(revisions).values({
        siteId: this.deps.siteId,
        collectionId: coll.id,
        itemId: inserted.id,
        delta: { before: null, after: encryptedData },
        userId: this.deps.userId ?? null,
        authorType: this.provenance.authorType,
        createdByRunId: this.provenance.runId ?? null,
        model: this.provenance.model ?? null,
        constitutionHash: this.provenance.constitutionHash ?? null,
        sources: this.provenance.sources ?? null,
        confidence: this.provenance.confidence ?? null,
      });
      await tx.insert(activity).values({
        siteId: this.deps.siteId,
        action: 'create',
        userId: this.deps.userId ?? null,
        collection: coll.name,
        itemId: inserted.id,
        payload: { data: payload.data },
      });
      await this.writeEvent(tx, collectionName, 'create', inserted.id, data, inserted.version, null, sensitive);
      if (opts.idempotency) await this.recordIdempotency(tx, collectionName, inserted.id, opts.idempotency);
      return inserted;
    });
    row.data = await this.processCrypto(collectionName, row.data as Record<string, unknown>, 'decrypt', row.id, false, false, undefined, { dekWrapped: cryptoOut.wrappedDek ?? null });
    if (this.afterCommitSink) {
      // Inside a caller's transaction (a translation draft): after it commits, in a site-scoped transaction of its own.
      const rootDb = this.deps.rootDb ?? this.deps.db;
      const created = row;
      this.afterCommitSink.push(() =>
        runSiteTransaction(
          rootDb,
          this.deps.siteId,
          async (tx) => {
            const after = new ItemService({ ...this.deps, db: tx as unknown as Database, rootDb: undefined });
            await after.afterCreateWork(collectionName, created.id, created.data as Record<string, unknown>, true);
          },
          // Realtime, flows, hooks, caches: never repeated by a retry (the write itself is committed already).
          { retry: false },
        ),
      );
    } else {
      await this.afterCreateWork(collectionName, row.id, row.data as Record<string, unknown>, false, hooks);
    }
    // No item-id tombstone to forget here: nothing writes `neg:{site}:item:*`.
    // Item-by-id reads are all authenticated, and Req 19.8 forbids serving a
    // tombstone to a credentialed request — so the read side cannot be wired as
    // design §14.5/§14.7 originally sketched. Dropping the key on every create
    // was a Redis round-trip that deleted something no code path ever wrote.
    return row;
  }

  async patch(
    collectionName: string,
    id: string,
    patch: Partial<{
      data: Record<string, unknown>;
      status: string;
      sort: number;
      publishAt: string | Date | null;
      unpublishAt: string | Date | null;
    }> & {
      /**
       * The item version this update is based on (P04). Required: without it
       * the update is refused (428); when the item has moved on, nothing is
       * written and a VersionConflictError (409) is thrown.
       */
      expectedVersion: number | undefined;
      /** Recorded with the write (P04, task 9.2); see `findIdempotent`. */
      idempotency?: IdempotencyInput;
      /** Why (P05): required when a published item's sponsor marking changes; audited. */
      reason?: string;
    },
  ) {
    const { expectedVersion } = patch;
    if (expectedVersion === undefined) throw versionRequired();
    const coll = await this.resolveCollection(collectionName);
    const perm = await this.perm(collectionName, 'update');
    const permClause = this.permissions?.whereFor(perm) ?? undefined;
    const knownFields = await this.getKnownWritableFields(collectionName);
    assertWritablePermissionFields(perm, knownFields, patch.data ?? {}, {
      status: patch.status,
      sort: patch.sort,
    });
    
    const [rawRow] = await this.deps.db
      .select()
      .from(items)
      .where(
        and(
          scopeSite(items.siteId, this.deps.siteId),
          eq(items.collectionId, coll.id),
          eq(items.id, id),
          isNull(items.deletedAt),
          permClause,
        ),
      )
      .limit(1);
    if (!rawRow) throw new ItemServiceError('NOT_FOUND', `Item "${id}" not found.`, 404);
    if (rawRow.version !== expectedVersion) {
      throw await this.conflict(coll.name, id, expectedVersion, rawRow.version);
    }

    // Law Zero: agents never overwrite fields a human pinned.
    const pinnedFields = Array.isArray(rawRow.pinnedFields)
      ? (rawRow.pinnedFields as string[])
      : [];
    if (patch.data) {
      const blocked = blockedPinnedFields(
        pinnedFields,
        Object.keys(patch.data),
        this.provenance.authorType,
      );
      if (blocked.length > 0) {
        throw new ItemServiceError(
          'PINNED_BY_HUMAN',
          `Field(s) pinned by a human edit: ${blocked.join(', ')}. Release the pin to allow agent writes.`,
          403,
        );
      }
    }

    const currentData = await this.processCrypto(collectionName, rawRow.data as Record<string, unknown>, 'decrypt', id, true, false, undefined, { dekWrapped: (rawRow as Record<string, unknown>).dekWrapped as string | null });

    const merged: Record<string, unknown> = patch.data
      ? { ...currentData, ...patch.data }
      : currentData;

    if (patch.data) {
      await this.runValidation(collectionName, patch.data, true);
    }

    // Before hook — extensions can mutate patch data before update.
    const hooks = await this.getHookDispatcher();
    const hookCtx = await hooks?.dispatch('items.update.before', {
      collection: collectionName,
      patch: patch.data,
      itemId: id,
      userId: this.deps.userId ?? null,
      siteId: this.deps.siteId,
    }) ?? { collection: collectionName };
    const hookPatch = hookCtx.patch as Record<string, unknown> | undefined;
    if (hookPatch) {
      await this.runValidation(collectionName, hookPatch, true);
    }
    // Stable block IDs (P04): new blocks get IDs, copies get new ones.
    const blockFieldMap = await this.blockFields(collectionName);
    const finalData = assignBlockIds(hookPatch ? { ...merged, ...hookPatch } : merged, blockFieldMap);
    // A published item's sponsor marking changes only with a reason (P05 task 1.9, design F): kept as is
    // whatever the site's policy, and audited with the before and after values.
    const sponsorChanged = sponsorMarkingDiffers(finalData, currentData);
    if (sponsorChanged && rawRow.status === 'published' && !patch.reason?.trim()) {
      throw new ItemServiceError('REASON_REQUIRED', 'Changing the sponsor marking of a published item needs a reason.', 422);
    }
    const finalStatus = patch.status ?? rawRow.status;
    const finalSort = patch.sort ?? rawRow.sort;
    // Editorial gate (Req 8.2): on collections with editorialWorkflow=true, an
    // item may only reach `published` via the approved/scheduled state. A
    // direct draft→published through patch is rejected.
    if (
      finalStatus === 'published' &&
      rawRow.status !== 'published' &&
      (coll.meta as Record<string, unknown> | null)?.editorialWorkflow === true
    ) {
      const current =
        (rawRow.editorialState as EditorialState | null) ?? editorialStateFromStatus('draft');
      try {
        assertEditorialGate(current, 'published');
      } catch {
        throw new ItemServiceError(
          'EDITORIAL_GATE_REQUIRED',
          'Item must be approved before it can be published.',
          409,
        );
      }
    }
    // The publish guard (P04): a held item is never published, by any path.
    assertPublishAllowed(
      { status: rawRow.status, hold: rawRow.hold },
      { nextStatus: finalStatus, changesContent: patch.data !== undefined || hookPatch !== undefined },
    );
    this.assertPermissionValidation(perm, buildPermissionSnapshot({
      id: rawRow.id,
      data: finalData,
      status: finalStatus,
      sort: finalSort,
      userCreated: rawRow.userCreated,
      userUpdated: this.deps.userId ?? null,
      createdAt: rawRow.createdAt,
      updatedAt: new Date(),
    }));
    // Validate the resulting Publish_Window against existing values (Req 7.2).
    const hasSchedulePatch = patch.publishAt !== undefined || patch.unpublishAt !== undefined;
    const effectiveWindow = hasSchedulePatch
      ? normalizePublishWindow(
          patch.publishAt !== undefined ? patch.publishAt : rawRow.publishAt,
          patch.unpublishAt !== undefined ? patch.unpublishAt : rawRow.unpublishAt,
        )
      : null;
    const cryptoOut: CryptoRecordOpts = {};
    const encryptedFinal = await this.processCrypto(collectionName, finalData, 'encrypt', id, true, false, undefined, cryptoOut);

    // Law Zero: human edits on intent-governed collections pin the fields
    // they touched so the reconciler never argues with a person.
    const nextPinned = patch.data
      ? computeNextPinnedFields(
          pinnedFields,
          Object.keys(patch.data),
          this.provenance.authorType,
          await this.isIntentGoverned(coll.name),
        )
      : pinnedFields;

    const sensitive = await this.sensitiveFieldsOf(collectionName);
    // A category's new slug moves the paths of its articles: the settings row exclusively, from the start (design R2).
    // Judged on the final data: a before hook may change the slug too.
    const movesArticles = coll.name === 'categories' && finalData.slug !== currentData.slug;
    const [row] = await withTransactionRetry(this.deps.db, () => runSiteTransaction(this.deps.db, this.deps.siteId, async (tx) => {
      if (movesArticles) await tx.execute(sql`SELECT 1 FROM ${siteContentSettings} WHERE ${siteContentSettings.siteId} = ${this.deps.siteId} FOR UPDATE`);
      else await lockContentSettingsShared(tx, this.deps.siteId);
      // A member's group next (design §0, D): publishing and its language are checked against the group.
      const group = await lockMembership(tx, this.deps.siteId, id);
      const locale = group ? await itemLocale(tx, this.deps.siteId, finalData) : null;
      if (group && finalStatus === 'published' && rawRow.status !== 'published') await assertMayPublishInGroup(tx, group, locale!);
      // The site's required language set (P09 task 3.7): its members publish and unpublish together, not one by one.
      if (group && !this.deps.localeSetWrite) await assertNotBoundSingleWrite(tx, this.deps.siteId, id, rawRow.status, finalStatus);
      // Shared fields follow the group's source (design D): another member never changes them itself.
      const sharedFields = group ? sharedFieldsOf(coll.meta) : [];
      const sharedChanged = changedSharedFields(sharedFields, currentData, finalData);
      if (group && sharedChanged.length > 0 && !isGroupSource(group) && !this.sharedSyncWrite) {
        throw new ItemServiceError(
          'SHARED_FIELD_FROM_SOURCE',
          `${sharedChanged.join(', ')} ${sharedChanged.length > 1 ? 'are' : 'is'} shared in the translation group and taken from its source${group.group.sourceItemId ? '' : ' (set a source first)'}.`,
          422,
        );
      }
      const [updated] = await tx
        .update(items)
        .set({
          ...firstPublishColumns(rawRow, finalStatus, new Date()),
          data: encryptedFinal,
          status: finalStatus,
          sort: finalSort,
          pinnedFields: nextPinned,
          dekWrapped: cryptoOut.wrappedDek ?? null,
          ...(effectiveWindow
            ? { publishAt: effectiveWindow.publishAt, unpublishAt: effectiveWindow.unpublishAt }
            : {}),
          version: expectedVersion + 1,
          userUpdated: this.deps.userId ?? null,
          updatedAt: new Date(),
        })
        .where(
          and(
            scopeSite(items.siteId, this.deps.siteId),
            eq(items.collectionId, coll.id),
            eq(items.id, id),
            isNull(items.deletedAt),
            // The atomic check: a concurrent writer that got there first has
            // already moved the version, and this matches no row.
            eq(items.version, expectedVersion),
            permClause,
          ),
        )
        .returning();
      if (!updated) {
        const [now] = await tx
          .select({ version: items.version })
          .from(items)
          .where(and(scopeSite(items.siteId, this.deps.siteId), eq(items.id, id), isNull(items.deletedAt)))
          .limit(1);
        if (now && now.version !== expectedVersion) {
          // Built after the rollback: no second connection while this one is held.
          throw new VersionMoved(now.version);
        }
        throw new ItemServiceError('UPDATE_FAILED', 'Failed to update item.');
      }
      // The item's row is locked now: a group it joined meanwhile was not checked above (start over).
      await assertMembershipUnchanged(tx, this.deps.siteId, id, group);
      if (group && (await followItemLocale(tx, group, locale!, finalStatus === 'published'))) {
        await writeGroupEvents(tx, group.group, ['locale'], this.deps.cdcActor);
      }
      // A translation's mapped blocks: new hashes; a person's edit marks them (sticky; design E).
      if (group) {
        await recordTargetWrite(tx, this.deps.siteId, id, blockFieldMap, currentData, finalData, this.provenance.authorType === 'human' && !this.sharedSyncWrite);
      }
      // The source's new shared values go to the other members (intents, same transaction; design R4).
      if (group && sharedChanged.length > 0 && isGroupSource(group)) {
        await recordSharedSyncs(tx, group.group, { itemId: id, version: updated.version, data: finalData }, sharedFields, triggerOf(this.deps.cdcActor, this.deps.userId));
      }
      await tx.insert(revisions).values({
        siteId: this.deps.siteId,
        collectionId: coll.id,
        itemId: id,
        itemVersion: updated.version,
        delta: { before: rawRow.data as Record<string, unknown>, after: encryptedFinal },
        userId: this.deps.userId ?? null,
        authorType: this.provenance.authorType,
        createdByRunId: this.provenance.runId ?? null,
        model: this.provenance.model ?? null,
        constitutionHash: this.provenance.constitutionHash ?? null,
        sources: this.provenance.sources ?? null,
        confidence: this.provenance.confidence ?? null,
      });
      await tx.insert(activity).values({
        siteId: this.deps.siteId,
        action: 'update',
        userId: this.deps.userId ?? null,
        collection: coll.name,
        itemId: id,
        payload: { patch },
      });
      const addedPins = nextPinned.filter((field) => !pinnedFields.includes(field));
      if (addedPins.length > 0) {
        await tx.insert(activity).values({
          siteId: this.deps.siteId,
          action: 'pin',
          userId: this.deps.userId ?? null,
          collection: coll.name,
          itemId: id,
          payload: { fields: addedPins },
        });
      }
      if (sponsorChanged && rawRow.status === 'published') {
        await new AuditLogger({ db: this.deps.db, siteId: this.deps.siteId }).writeInTransaction(tx, {
          siteId: this.deps.siteId,
          event: 'item_sponsor_changed',
          metadata: {
            // Who: the user, the API key or the agent behind the write.
            operator: this.deps.userId ?? null,
            actor: this.deps.cdcActor ?? (this.deps.userId ? { type: 'user', id: this.deps.userId } : { type: 'system', id: null }),
            collection: coll.name,
            itemId: id,
            reason: patch.reason!.trim(),
            before: Object.fromEntries(SPONSOR_FIELDS.map((f) => [f, currentData[f] ?? null])),
            after: Object.fromEntries(SPONSOR_FIELDS.map((f) => [f, finalData[f] ?? null])),
          },
        });
      }
      await syncContentRoute(tx, this.deps.siteId, id, { wasPublished: rawRow.status === 'published' });
      if (movesArticles) {
        const { conflicts } = await rebuildRoutes(tx, this.deps.siteId, { primaryCategoryId: id });
        if (conflicts.length > 0) {
          throw new ItemServiceError('PATH_TAKEN', `With this slug ${conflicts.length} article(s) would share a path with another item (${conflicts[0]!.path}).`, 409);
        }
      }
      await this.writeEvent(tx, collectionName, 'update', id, finalData, updated.version, Object.keys(patch.data ?? {}), sensitive);
      if (patch.idempotency) await this.recordIdempotency(tx, collectionName, id, patch.idempotency);
      return [updated] as const;
    })).catch(async (err: unknown) => {
      if (err instanceof VersionMoved) throw await this.conflict(coll.name, id, expectedVersion, err.currentVersion);
      throw err;
    });

    if (!row) throw new ItemServiceError('UPDATE_FAILED', 'Failed to update item.');
    row.data = await this.processCrypto(collectionName, row.data as Record<string, unknown>, 'decrypt', row.id, false, false, undefined, { dekWrapped: cryptoOut.wrappedDek ?? null });
    if (this.afterCommitSink) {
      // Inside a caller's transaction (a shared field sync): after it commits, in a transaction of its
      // own scoped to the site (design R23, R27) — flows, hooks and caches read through it, never through
      // the committed transaction's handle. The after hook is awaited there, so it ends with it.
      const rootDb = this.deps.rootDb ?? this.deps.db;
      this.afterCommitSink.push(() =>
        runSiteTransaction(
          rootDb,
          this.deps.siteId,
          async (tx) => {
            const after = new ItemService({ ...this.deps, db: tx as unknown as Database, rootDb: undefined });
            await after.afterUpdateWork(collectionName, row.id, row.data as Record<string, unknown>, true);
          },
          // Realtime, flows, hooks, caches: never repeated by a retry (the write itself is committed already).
          { retry: false },
        ),
      );
    } else {
      await this.afterUpdateWork(collectionName, row.id, row.data as Record<string, unknown>, false, hooks);
    }
    return row;
  }

  private async runValidation(
    collectionName: string,
    data: Record<string, unknown>,
    partial: boolean,
  ): Promise<Record<string, unknown>> {
    const compiled = await this.schemaService.getCompiled(collectionName);
    if (!compiled) return data;
    const result = validateItem(compiled.fields, data, { partial });
    if (!result.ok) {
      throw new ItemServiceError(
        'VALIDATION',
        result.issues.map((i) => `${i.field}: ${i.message}`).join('; '),
        400,
      );
    }
    return result.data;
  }

  async replace(
    collectionName: string,
    id: string,
    body: { data: Record<string, unknown>; status?: string; sort?: number; expectedVersion: number | undefined; reason?: string },
  ) {
    return this.patch(collectionName, id, {
      data: body.data,
      status: body.status,
      sort: body.sort,
      expectedVersion: body.expectedVersion,
      reason: body.reason,
    });
  }

  /**
   * The error for an update based on `baseVersion` when the item is at
   * `currentVersion`. For an agent's write, a person's revision in between
   * makes it a superseded AI result (P04): audited, never written back.
   * Otherwise — a person's own stale save, or only other agents in between —
   * it is a plain version conflict.
   */
  private async conflict(
    collectionName: string,
    itemId: string,
    baseVersion: number,
    currentVersion: number,
    db: Pick<Database, 'select'> = this.deps.db,
  ): Promise<VersionConflictError> {
    const allChanged = await this.changedFieldsSince(itemId, baseVersion, db);
    // The caller only learns about fields it may read; the audit keeps all.
    const changedFields = await this.readableOnly(collectionName, allChanged);
    if (this.provenance.authorType !== 'agent') return new VersionConflictError(currentVersion, changedFields);
    const [human] = await db
      .select({ id: revisions.id })
      .from(revisions)
      .where(
        and(
          scopeSite(revisions.siteId, this.deps.siteId),
          eq(revisions.itemId, itemId),
          gt(revisions.itemVersion, baseVersion),
          eq(revisions.authorType, 'human'),
        ),
      )
      .limit(1);
    if (!human) return new VersionConflictError(currentVersion, changedFields);
    // Outside the write's transaction: the record must survive its rollback.
    await new AuditLogger({ db: this.deps.db, siteId: this.deps.siteId }).write({
      event: 'ai_result_superseded',
      actorEmail: null,
      ip: this.deps.permissionCtx?.ip ?? null,
      userAgent: null,
      requestId: null,
      metadata: {
        collection: collectionName,
        itemId,
        runId: this.provenance.runId ?? null,
        baseVersion,
        currentVersion,
        changedFields: allChanged,
      },
    });
    return new AiResultSupersededError(currentVersion, changedFields);
  }

  /** `fields` narrowed to those the caller may read (all of them without RBAC). */
  private async readableOnly(collectionName: string, fields: string[]): Promise<string[]> {
    if (!this.permissions || fields.length === 0) return fields;
    let perm: Awaited<ReturnType<ItemService['perm']>>;
    try {
      perm = await this.perm(collectionName, 'read');
    } catch {
      return [];
    }
    if (!perm || (perm.fields.length === 1 && perm.fields[0] === '*')) return fields;
    const allowed = new Set(applyFieldMask(fields, perm.fields));
    return fields.filter((f) => allowed.has(f));
  }

  /**
   * Data fields changed by revisions after `sinceVersion` (for a 409 body).
   * Field names only — values may be encrypted and are not the caller's to
   * see through a conflict.
   */
  private async changedFieldsSince(itemId: string, sinceVersion: number, db: Pick<Database, 'select'> = this.deps.db): Promise<string[]> {
    const rows = await db
      .select({ delta: revisions.delta })
      .from(revisions)
      .where(
        and(
          scopeSite(revisions.siteId, this.deps.siteId),
          eq(revisions.itemId, itemId),
          gt(revisions.itemVersion, sinceVersion),
        ),
      );
    const changed = new Set<string>();
    for (const { delta } of rows) {
      const { before, after } = (delta ?? {}) as { before?: Record<string, unknown> | null; after?: Record<string, unknown> };
      for (const key of new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])) {
        if (JSON.stringify(before?.[key]) !== JSON.stringify(after?.[key])) changed.add(key);
      }
    }
    return [...changed].sort();
  }

  async softDelete(collectionName: string, id: string) {
    const coll = await this.resolveCollection(collectionName);
    const perm = await this.perm(collectionName, 'delete');
    const permClause = this.permissions?.whereFor(perm) ?? undefined;

    const [rawRow] = await this.deps.db
      .select({ id: items.id })
      .from(items)
      .where(
        and(
          scopeSite(items.siteId, this.deps.siteId),
          eq(items.collectionId, coll.id),
          eq(items.id, id),
          isNull(items.deletedAt),
          permClause,
        ),
      )
      .limit(1);
    if (!rawRow) throw new ItemServiceError('NOT_FOUND', `Item "${id}" not found.`, 404);

    // Before hook — extension can cancel by throwing.
    const hooks = await this.getHookDispatcher();
    await hooks?.dispatch('items.delete.before', {
      collection: collectionName,
      itemId: id,
      userId: this.deps.userId ?? null,
      siteId: this.deps.siteId,
    });

    // The delete and its change event commit together (P04).
    const row = await withTransactionRetry(this.deps.db, () => runSiteTransaction(this.deps.db, this.deps.siteId, async (tx) => {
      await lockContentSettingsShared(tx, this.deps.siteId);
      const group = await lockMembership(tx, this.deps.siteId, id);
      const [deleted] = await tx
        .update(items)
        .set({ deletedAt: new Date(), userUpdated: this.deps.userId ?? null, version: sql`${items.version} + 1` })
        .where(
          and(
            scopeSite(items.siteId, this.deps.siteId),
            eq(items.collectionId, coll.id),
            eq(items.id, id),
            isNull(items.deletedAt),
            permClause,
          ),
        )
        .returning({ id: items.id, version: items.version });
      if (deleted) {
        // A deleted source leaves its group without a source; the member row stays (design R9, R18).
        await assertMembershipUnchanged(tx, this.deps.siteId, id, group);
        if (group) await onMemberDeleted(tx, group, this.deps.cdcActor);
        // A deleted item frees its path (P05).
        await syncContentRoute(tx, this.deps.siteId, id, { wasPublished: false });
        await this.writeEvent(tx, collectionName, 'delete', id, null, deleted.version);
      }
      return deleted;
    }));
    if (!row) throw new ItemServiceError('NOT_FOUND', `Item "${id}" not found.`, 404);
    await this.writeActivity('delete', coll.name, id, {});
    await this.publishRealtimeEvent(collectionName, 'delete', id);
    await this.dispatchFlowEvent(collectionName, 'delete', id, {});
    this.wakeConsumers();
    // After hook — fire-and-forget.
    hooks?.dispatch('items.delete.after', { collection: collectionName, itemId: id, userId: this.deps.userId ?? null, siteId: this.deps.siteId }).catch(() => {});
    await this.afterWriteInvalidation(collectionName);
    return { ok: true } as const;
  }

  /**
   * Collect and decrypt every item matching a subject filter for a SAR export
   * (Req 13). Decrypts internally (admin scope) but forces field-access
   * auditing of pii/phi reads (Req 13.2), and includes latest-revision
   * provenance (Req 13.3). Site-scoped (Req 13.4).
   */
  async exportSubject(
    collectionName: string,
    filter: Record<string, unknown>,
  ): Promise<{ records: Array<Record<string, unknown>>; count: number }> {
    const coll = await this.resolveCollection(collectionName);
    const rows = await this.deps.db
      .select()
      .from(items)
      .where(
        and(
          scopeSite(items.siteId, this.deps.siteId),
          eq(items.collectionId, coll.id),
          isNull(items.deletedAt),
          sql`${items.data} @> ${JSON.stringify(filter)}::jsonb`,
        ),
      );

    const records: Array<Record<string, unknown>> = [];
    for (const row of rows) {
      const data = await this.processCrypto(
        collectionName,
        row.data as Record<string, unknown>,
        'decrypt',
        row.id,
        true, // internal: bypass the read_decrypted perm gate (admin SAR)
        false,
        true, // force field-access audit (Req 13.2)
        { dekWrapped: (row as Record<string, unknown>).dekWrapped as string | null },
      );
      const [rev] = await this.deps.db
        .select({
          authorType: revisions.authorType,
          model: revisions.model,
          sources: revisions.sources,
          createdAt: revisions.createdAt,
        })
        .from(revisions)
        .where(and(scopeSite(revisions.siteId, this.deps.siteId), eq(revisions.itemId, row.id)))
        .orderBy(desc(revisions.createdAt))
        .limit(1);
      records.push({
        id: row.id,
        collection: collectionName,
        status: row.status,
        data,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        provenance: rev ?? null,
      });
    }
    return { records, count: records.length };
  }

  /**
   * Permanently remove an item and (via FK cascade) its revisions (Req 11.2).
   * Used by erasure/retention — bypasses soft-delete. Audit trails in
   * `audit_log` / `field_access_log` are intentionally NOT cascaded (Req 11.3).
   * Returns true when a row was removed.
   */
  async hardDelete(collectionName: string, id: string): Promise<boolean> {
    const coll = await this.resolveCollection(collectionName);
    // The delete and its change event commit together (P04).
    const deleted = await withTransactionRetry(this.deps.db, () => runSiteTransaction(this.deps.db, this.deps.siteId, async (tx) => {
      // Settings first (P05, design §0): a running route rebuild finishes before the item (and its route) goes.
      await lockContentSettingsShared(tx, this.deps.siteId);
      // Its membership goes with it (design R9): the group loses the member, and its source if it was one.
      const group = await lockMembership(tx, this.deps.siteId, id);
      await tx.select({ id: items.id }).from(items).where(and(scopeSite(items.siteId, this.deps.siteId), eq(items.id, id))).for('update');
      await assertMembershipUnchanged(tx, this.deps.siteId, id, group);
      if (group) await onMemberRemoved(tx, group, this.deps.cdcActor);
      const rows = await tx
        .delete(items)
        .where(and(scopeSite(items.siteId, this.deps.siteId), eq(items.collectionId, coll.id), eq(items.id, id)))
        .returning({ id: items.id, version: items.version });
      if (rows[0]) await this.writeEvent(tx, collectionName, 'delete', id, null, rows[0].version + 1);
      return rows;
    }));
    if (deleted.length === 0) return false;
    this.wakeConsumers();
    return true;
  }

  /**
   * Set or confirm an item's first publish time (HeoPress P05; design R19,
   * R25; spec "历史发布日期未知"): a site administrator's call — the route
   * checks. `publishedAt` is the date to record (an import's original date);
   * `null` confirms the date the item has (`estimated` → `set`, unchanged).
   * Either way `published_at_source` becomes `set`, the change is audited,
   * and the item's route follows in the same transaction — a published item
   * whose date path moves leaves a 301 from the old path.
   */
  async setPublishedAt(
    collectionName: string,
    id: string,
    input: { publishedAt: Date | null; expectedVersion: number | undefined; actorEmail?: string | null },
  ): Promise<{ id: string; version: number; publishedAt: Date | null; publishedAtSource: string }> {
    const { expectedVersion } = input;
    if (expectedVersion === undefined) throw versionRequired();
    if (input.publishedAt && Number.isNaN(input.publishedAt.getTime())) throw new ItemServiceError('VALIDATION', 'publishedAt is not a valid date.', 400);
    const coll = await this.resolveCollection(collectionName);
    const result = await runSiteTransaction(this.deps.db, this.deps.siteId, async (tx) => {
      await lockContentSettingsShared(tx, this.deps.siteId);
      const [row] = await tx
        .select({ status: items.status, version: items.version, publishedAt: items.publishedAt, publishedAtSource: items.publishedAtSource })
        .from(items)
        .where(and(scopeSite(items.siteId, this.deps.siteId), eq(items.collectionId, coll.id), eq(items.id, id), isNull(items.deletedAt)))
        .for('update');
      if (!row) throw new ItemServiceError('NOT_FOUND', `Item "${id}" not found.`, 404);
      if (row.version !== expectedVersion) throw new VersionMoved(row.version);
      const publishedAt = input.publishedAt ?? row.publishedAt;
      if (!publishedAt) throw new ItemServiceError('VALIDATION', 'The item has no publish date to confirm; give one.', 422);
      const [updated] = await tx
        .update(items)
        .set({ publishedAt, publishedAtSource: 'set', version: expectedVersion + 1, userUpdated: this.deps.userId ?? null, updatedAt: new Date() })
        .where(and(scopeSite(items.siteId, this.deps.siteId), eq(items.id, id), eq(items.version, expectedVersion)))
        .returning({ id: items.id, version: items.version, publishedAt: items.publishedAt, publishedAtSource: items.publishedAtSource });
      await new AuditLogger({ db: this.deps.db, siteId: this.deps.siteId }).writeInTransaction(tx, {
        siteId: this.deps.siteId,
        event: 'item_published_at_set',
        actorEmail: input.actorEmail ?? null,
        metadata: {
          operator: this.deps.userId ?? null,
          collection: coll.name,
          itemId: id,
          before: { publishedAt: row.publishedAt?.toISOString() ?? null, source: row.publishedAtSource },
          after: { publishedAt: publishedAt.toISOString(), source: 'set' },
        },
      });
      await syncContentRoute(tx, this.deps.siteId, id, { wasPublished: row.status === 'published' });
      await this.writeEvent(tx, collectionName, 'update', id, null, updated!.version, ['published_at']);
      return updated!;
    }).catch(async (err: unknown) => {
      if (err instanceof VersionMoved) throw await this.conflict(coll.name, id, expectedVersion, err.currentVersion);
      throw err;
    });
    this.wakeConsumers();
    await this.afterWriteInvalidation(collectionName);
    return { ...result, publishedAtSource: result.publishedAtSource ?? 'set' };
  }

  /**
   * Crypto-shred a record by destroying its wrapped DEK (Req 11.2, envelope
   * mode). The row remains but its ciphertext becomes unrecoverable.
   */
  async cryptoShred(collectionName: string, id: string): Promise<boolean> {
    const coll = await this.resolveCollection(collectionName);
    // The shred and its change event commit together (P04): derived copies
    // (search, caches) learn that the content is gone.
    const updated = await runItemWriteTransaction(this.deps.db, this.deps.siteId, async (tx) => {
      const rows = await tx
        .update(items)
        .set({ dekWrapped: null, updatedAt: new Date(), version: sql`${items.version} + 1` })
        .where(and(scopeSite(items.siteId, this.deps.siteId), eq(items.collectionId, coll.id), eq(items.id, id)))
        .returning({ id: items.id, version: items.version });
      if (rows[0]) await this.writeEvent(tx, collectionName, 'update', id, null, rows[0].version, ['$encryption']);
      return rows;
    });
    if (updated.length > 0) this.wakeConsumers();
    return updated.length > 0;
  }

  /**
   * Bulk create / update / publish / delete with a result per entry (P04,
   * spec content/write-concurrency "批量操作逐条结果"). Entries are applied
   * one by one (creates in one insert), so one entry failing never undoes
   * another's success. Each result is `succeeded`, `unchanged` (publishing
   * an item that already is), `blocked` (hold, human pin, editorial gate),
   * `conflict` (version) or `failed`, with the error code.
   *
   * `update` and `publish` entries carry their own `expectedVersion`.
   */
  async bulk(
    collectionName: string,
    op: BulkOp,
    payload: Array<Record<string, unknown>>,
    opts?: { bulkMax?: number },
  ): Promise<BulkItemResult[]> {
    const max = opts?.bulkMax ?? bulkMaxItems();
    if (payload.length > max) {
      throw new ItemServiceError(
        'BULK_TOO_LARGE',
        `Bulk batch exceeds limit of ${max} items.`,
        413,
      );
    }
    // A missing collection or no permission at all fails the whole request.
    await this.resolveCollection(collectionName);
    await this.perm(collectionName, op === 'create' ? 'create' : op === 'delete' ? 'delete' : 'update');

    if (op === 'create') return this.bulkCreate(collectionName, payload);

    const out: BulkItemResult[] = [];
    for (const [index, entry] of payload.entries()) {
      const id = typeof entry.id === 'string' ? entry.id : null;
      if (!id) {
        out.push({ index, id: null, status: 'failed', code: 'VALIDATION', message: 'Each entry needs an `id`.' });
        continue;
      }
      try {
        if (op === 'update') {
          // `id` addresses the item and `expectedVersion` is its base version;
          // neither is item data (the id used to be written into it).
          // `$reason` (P05) is the entry's reason, e.g. for a published item's sponsor marking.
          const { expectedVersion, id: _id, $reason, ...data } = entry;
          const item = await this.patch(collectionName, id, {
            data,
            expectedVersion: typeof expectedVersion === 'number' ? expectedVersion : undefined,
            ...(typeof $reason === 'string' ? { reason: $reason } : {}),
          });
          out.push({ index, id, status: 'succeeded', item });
        } else if (op === 'publish') {
          const expectedVersion = typeof entry.expectedVersion === 'number' ? entry.expectedVersion : undefined;
          const current = await this.currentStatus(collectionName, id);
          if (current?.status === 'published' && expectedVersion !== undefined && current.version === expectedVersion) {
            out.push({ index, id, status: 'unchanged', code: 'ALREADY_PUBLISHED' });
            continue;
          }
          const item = await this.patch(collectionName, id, { status: 'published', expectedVersion });
          out.push({ index, id, status: 'succeeded', item });
        } else {
          await this.softDelete(collectionName, id);
          out.push({ index, id, status: 'succeeded' });
        }
      } catch (err) {
        out.push({ index, id, ...bulkFailure(err) });
      }
    }
    return out;
  }

  /** Status and version of one item in this site and collection, or null. */
  private async currentStatus(collectionName: string, id: string): Promise<{ status: string; version: number } | null> {
    const coll = await this.resolveCollection(collectionName);
    const [row] = await this.deps.db
      .select({ status: items.status, version: items.version })
      .from(items)
      .where(and(scopeSite(items.siteId, this.deps.siteId), eq(items.collectionId, coll.id), eq(items.id, id), isNull(items.deletedAt)))
      .limit(1);
    return row ?? null;
  }

  /**
   * Bulk create with chunked multi-row INSERT inside one transaction; side
   * effects run once after commit (high-load Req 16.4).
   */
  private async bulkCreate(
    collectionName: string,
    payload: Array<Record<string, unknown>>,
  ) {
    const coll = await this.resolveCollection(collectionName);
    const perm = await this.perm(collectionName, 'create');
    const knownFields = await this.getKnownWritableFields(collectionName);

    type Prepared = {
      recordId: string;
      encryptedData: Record<string, unknown>;
      status: string;
      sort: number;
      publishAt: Date | null;
      unpublishAt: Date | null;
      wrappedDek: string | null;
      rawData: Record<string, unknown>;
    };
    const blockFields = await this.blockFields(collectionName);
    const bulkSensitive = await this.sensitiveFieldsOf(collectionName);
    const requestedIds = new Set<string>();
    const prepared: Array<Prepared & { index: number }> = [];
    const results: BulkItemResult[] = [];

    for (const [index, entry] of payload.entries()) {
      try {
        const primaryKey = resolvePrimaryKey(
          {
            field: coll.primaryKeyField,
            type: coll.primaryKeyType,
            storageMode: coll.storageMode,
          },
          entry ?? {},
        );
        const withPresets = this.permissions?.applyPresets(perm, entry ?? {}) ?? entry ?? {};
        const status = 'draft';
        const sort = 0;
        assertWritablePermissionFields(perm, knownFields, withPresets, { status, sort });
        const data = assignBlockIds(await this.runValidation(collectionName, withPresets, false), blockFields);
        const recordId = primaryKey.id ?? nanoid();
        const { publishAt, unpublishAt } = normalizePublishWindow(null, null);
        const cryptoOut: CryptoRecordOpts = {};
        const encryptedData = await this.processCrypto(
          collectionName,
          data,
          'encrypt',
          recordId,
          true,
          false,
          undefined,
          cryptoOut,
        );
        if (primaryKey.id) {
          if (requestedIds.has(primaryKey.id)) {
            throw new ItemServiceError('DUPLICATE_ID', `Id "${primaryKey.id}" appears more than once in this request.`, 409);
          }
          requestedIds.add(primaryKey.id);
          await this.assertItemIdAvailable(coll.id, primaryKey.id);
        }
        prepared.push({
          index,
          recordId,
          encryptedData,
          status,
          sort,
          publishAt,
          unpublishAt,
          wrappedDek: cryptoOut.wrappedDek ?? null,
          rawData: data,
        });
      } catch (err) {
        // An invalid entry is reported; the valid ones are still created.
        results.push({ index, id: null, ...bulkFailure(err) });
      }
    }
    if (prepared.length === 0) return results.sort((a, b) => a.index - b.index);

    const insertChunk = async (tx: Parameters<Parameters<Database['transaction']>[0]>[0], chunk: typeof prepared): Promise<ItemRow[]> => {
      const inserted: ItemRow[] = [];
      {
        await lockContentSettingsShared(tx, this.deps.siteId);
        const numbers: number[] = [];
        for (let k = 0; k < chunk.length; k++) numbers.push(await allocateItemNumber(tx, this.deps.siteId, coll.id));
        const itemRows = await tx
          .insert(items)
          .values(
            chunk.map((p, k) => ({
              id: p.recordId,
              siteId: this.deps.siteId,
              collectionId: coll.id,
              data: p.encryptedData,
              status: p.status,
              sort: p.sort,
              publishAt: p.publishAt,
              unpublishAt: p.unpublishAt,
              dekWrapped: p.wrappedDek,
              userCreated: this.deps.userId ?? null,
              userUpdated: this.deps.userId ?? null,
              number: numbers[k],
              ...firstPublishColumns(null, p.status, new Date()),
            })),
          )
          .returning();
        inserted.push(...(itemRows as ItemRow[]));
        for (const p of chunk) await syncContentRoute(tx, this.deps.siteId, p.recordId, { wasPublished: false });

        await tx.insert(revisions).values(
          chunk.map((p) => ({
            siteId: this.deps.siteId,
            collectionId: coll.id,
            itemId: p.recordId,
            delta: { before: null, after: p.encryptedData },
            userId: this.deps.userId ?? null,
            authorType: this.provenance.authorType,
            createdByRunId: this.provenance.runId ?? null,
            model: this.provenance.model ?? null,
            constitutionHash: this.provenance.constitutionHash ?? null,
            sources: this.provenance.sources ?? null,
            confidence: this.provenance.confidence ?? null,
          })),
        );
        await tx.insert(activity).values(
          chunk.map((p) => ({
            siteId: this.deps.siteId,
            action: 'create',
            userId: this.deps.userId ?? null,
            collection: coll.name,
            itemId: p.recordId,
            payload: { data: p.rawData },
          })),
        );
        // Each created item's change event, in the same transaction (P04).
        for (const p of chunk) await this.writeEvent(tx, collectionName, 'create', p.recordId, p.rawData, 1, null, bulkSensitive);
      }
      return inserted;
    };

    // One transaction for the batch; if it fails (e.g. a key taken
    // concurrently), each entry is retried alone so one bad entry never
    // undoes the others (Codex review P04-1).
    let rows: ItemRow[];
    try {
      rows = await runSiteTransaction(this.deps.db, this.deps.siteId, async (tx) => {
        const all: ItemRow[] = [];
        for (let i = 0; i < prepared.length; i += BULK_INSERT_CHUNK) {
          all.push(...(await insertChunk(tx, prepared.slice(i, i + BULK_INSERT_CHUNK))));
        }
        return all;
      });
    } catch {
      rows = [];
      for (const p of prepared) {
        try {
          rows.push(...(await runSiteTransaction(this.deps.db, this.deps.siteId, (tx) => insertChunk(tx, [p]))));
        } catch (err) {
          results.push({ index: p.index, id: null, ...bulkFailure(err) });
        }
      }
    }

    const indexOf = new Map(prepared.map((p) => [p.recordId, p.index]));
    for (const row of rows) {
      const decrypted = await this.processCrypto(
        collectionName,
        row.data as Record<string, unknown>,
        'decrypt',
        row.id,
        false,
        false,
      );
      row.data = decrypted;
      results.push({ index: indexOf.get(row.id) ?? -1, id: row.id, status: 'succeeded', item: row });
      await this.publishRealtimeEvent(collectionName, 'create', row.id);
      await this.dispatchFlowEvent(collectionName, 'create', row.id, decrypted);
    }
    if (rows.length > 0) this.wakeConsumers();
    await this.afterWriteInvalidation(collectionName);
    // No item-id tombstone to forget: `negativeItemKey` was removed because
    // nothing ever writes `neg:{site}:item:*` — item-by-id reads all sit behind
    // auth and Req 19.8 forbids serving a tombstone to a credentialed request.
    // In `bulk()` the dead call was also one Redis DEL *per row*, so a 500-row
    // insert spent 500 round-trips deleting keys that never existed.
    return results.sort((a, b) => a.index - b.index);
  }

  async listRevisions(collectionName: string, itemId: string) {
    const coll = await this.resolveCollection(collectionName);
    return this.deps.db
      .select()
      .from(revisions)
      .where(
        and(
          scopeSite(revisions.siteId, this.deps.siteId),
          eq(revisions.collectionId, coll.id),
          eq(revisions.itemId, itemId),
        ),
      )
      .orderBy(desc(revisions.createdAt));
  }

  async revertRevision(collectionName: string, itemId: string, revisionId: string, expectedVersion: number | undefined, reason?: string) {
    const [rev] = await this.deps.db
      .select()
      .from(revisions)
      .where(
        and(
          scopeSite(revisions.siteId, this.deps.siteId),
          eq(revisions.id, revisionId),
          eq(revisions.itemId, itemId),
        ),
      )
      .limit(1);
    if (!rev) throw new ItemServiceError('NOT_FOUND', 'Revision not found.', 404);

    const snapshot = (rev.delta as { after?: Record<string, unknown> }).after ?? {};
    return this.replace(collectionName, itemId, { data: snapshot, expectedVersion, reason });
  }

  // ---------- internals ----------

  /** Rich-text and repeater fields of the collection, which hold blocks (P04). */
  private async blockFields(collectionName: string): Promise<Map<string, BlockFieldKind>> {
    const compiled = await this.schemaService.getCompiled(collectionName);
    return blockFieldsOf(compiled?.fields ?? []);
  }

  private async getKnownWritableFields(collectionName: string): Promise<string[]> {
    const compiled = await this.schemaService.getCompiled(collectionName);
    const dataFields = compiled?.fields.map((f) => f.name) ?? [];
    return [...dataFields, ...WRITABLE_STRUCTURAL_FIELDS];
  }

  private async expandRelationFields(
    collectionName: string,
    rows: ItemRow[],
    fields: string[],
    deep?: DeepQuery,
  ): Promise<ItemRow[]> {
    const selections = parseRelationFieldSelections(fields, deep);
    if (rows.length === 0 || selections.length === 0) return rows;
    const relationRows = await this.deps.db
      .select()
      .from(relations)
      .where(
        and(
          scopeSite(relations.siteId, this.deps.siteId),
          sql`(${relations.manyCollection} = ${collectionName} or ${relations.oneCollection} = ${collectionName})`,
        ),
      );

    for (const rel of relationRows) {
      const alias = relationAlias(rel);
      const selected = selections.find((selection) => selection.alias === alias);
      if (!selected) continue;
      if (rel.type === 'm2o' && rel.manyCollection === collectionName) {
        await this.expandManyToOne(rows, rel, selected);
        continue;
      }
      if (rel.type === 'o2m' && rel.oneCollection === collectionName) {
        await this.expandOneToMany(rows, rel, selected);
        continue;
      }
      if (rel.type === 'm2m' && rel.manyCollection === collectionName) {
        await this.expandManyToMany(rows, rel, selected);
      }
    }
    return rows;
  }

  private async expandManyToOne(
    rows: ItemRow[],
    rel: RelationMetadata,
    selected: RelationFieldSelection,
  ): Promise<void> {
    const alias = relationAlias(rel);
    const foreignIds = uniqueStrings(rows.map((row) => row.data?.[rel.manyField]));
    if (foreignIds.length === 0) {
      assignRelation(rows, alias, () => null);
      return;
    }
    const byId = await this.loadRelatedByIds(rel.oneCollection, foreignIds, selected.fields);
    assignRelation(rows, alias, (row) => {
      const foreignId = row.data?.[rel.manyField];
      return typeof foreignId === 'string' ? byId.get(foreignId) ?? null : null;
    });
  }

  private async expandOneToMany(
    rows: ItemRow[],
    rel: RelationMetadata,
    selected: RelationFieldSelection,
  ): Promise<void> {
    const alias = relationAlias(rel);
    const parentIds = uniqueStrings(rows.map((row) => row.id));
    if (parentIds.length === 0) {
      assignRelation(rows, alias, () => []);
      return;
    }
    const relatedCollection = await this.resolveCollection(rel.manyCollection);
    const relatedPerm = await this.perm(rel.manyCollection, 'read');
    const relatedRows = await this.loadRowsByJsonField(
      relatedCollection.id,
      rel.manyField,
      parentIds,
      this.permissions?.whereFor(relatedPerm) ?? undefined,
    );
    const projected = await this.projectRelatedRows(rel.manyCollection, relatedRows, relatedPerm, selected.fields);
    const byParent = new Map<string, Record<string, unknown>[]>();
    for (const related of relatedRows) {
      const parentId = related.data?.[rel.manyField];
      if (typeof parentId !== 'string') continue;
      const list = byParent.get(parentId) ?? [];
      const projection = projected.get(related.id);
      if (projection) list.push(projection);
      byParent.set(parentId, list);
    }
    assignRelation(rows, alias, (row) => limitArray(byParent.get(row.id) ?? [], selected.limit));
  }

  private async expandManyToMany(
    rows: ItemRow[],
    rel: RelationMetadata,
    selected: RelationFieldSelection,
  ): Promise<void> {
    const alias = relationAlias(rel);
    if (!rel.junctionCollection || !rel.junctionManyField || !rel.junctionOneField) {
      assignRelation(rows, alias, () => []);
      return;
    }
    const sourceIds = uniqueStrings(rows.map((row) => row.id));
    if (sourceIds.length === 0) {
      assignRelation(rows, alias, () => []);
      return;
    }
    const junctionCollection = await this.resolveCollection(rel.junctionCollection);
    const junctionRows = await this.loadRowsByJsonField(
      junctionCollection.id,
      rel.junctionManyField,
      sourceIds,
    );
    const targetIds = uniqueStrings(junctionRows.map((row) => row.data?.[rel.junctionOneField!]));
    const targetById = targetIds.length > 0
      ? await this.loadRelatedByIds(rel.oneCollection, targetIds, selected.fields)
      : new Map<string, Record<string, unknown>>();
    const bySource = new Map<string, Record<string, unknown>[]>();
    for (const junction of junctionRows) {
      const sourceId = junction.data?.[rel.junctionManyField];
      const targetId = junction.data?.[rel.junctionOneField];
      if (typeof sourceId !== 'string' || typeof targetId !== 'string') continue;
      const target = targetById.get(targetId);
      if (!target) continue;
      const list = bySource.get(sourceId) ?? [];
      list.push(target);
      bySource.set(sourceId, list);
    }
    assignRelation(rows, alias, (row) => limitArray(bySource.get(row.id) ?? [], selected.limit));
  }

  private async loadRowsByJsonField(
    collectionId: string,
    field: string,
    values: string[],
    permissionClause?: SQL,
  ): Promise<ItemRow[]> {
    if (values.length === 0) return [];
    return (await this.deps.db
      .select()
      .from(items)
      .where(
        and(
          scopeSite(items.siteId, this.deps.siteId),
          eq(items.collectionId, collectionId),
          inArray(sql`${items.data}->>${field}`, values),
          isNull(items.deletedAt),
          permissionClause,
        ),
      )) as ItemRow[];
  }

  private async loadRelatedByIds(
    collectionName: string,
    ids: string[],
    fields: string[],
  ): Promise<Map<string, Record<string, unknown>>> {
    const relatedCollection = await this.resolveCollection(collectionName);
    const relatedPerm = await this.perm(collectionName, 'read');
    const relatedPermClause = this.permissions?.whereFor(relatedPerm) ?? undefined;
    const relatedRows = await this.deps.db
      .select()
      .from(items)
      .where(
        and(
          scopeSite(items.siteId, this.deps.siteId),
          eq(items.collectionId, relatedCollection.id),
          inArray(items.id, ids),
          isNull(items.deletedAt),
          relatedPermClause,
        ),
      );
    return this.projectRelatedRows(collectionName, relatedRows as ItemRow[], relatedPerm, fields);
  }

  private async projectRelatedRows(
    collectionName: string,
    rows: ItemRow[],
    perm: CompiledPermission | null,
    fields: string[],
  ): Promise<Map<string, Record<string, unknown>>> {
    const knownFields = (await this.schemaService.getCompiled(collectionName))?.fields.map((f) => f.name) ?? [];
    const byId = new Map<string, Record<string, unknown>>();
    for (const row of rows) {
      const masked = perm && this.permissions
        ? this.permissions.maskItem(perm, row, knownFields)
        : row;
      masked.data = await this.processCrypto(collectionName, masked.data as Record<string, unknown>, 'decrypt', masked.id, false, false, undefined, { dekWrapped: (masked as unknown as Record<string, unknown>).dekWrapped as string | null });
      byId.set(masked.id, projectRelatedRow(masked, fields));
    }
    return byId;
  }

  private async assertItemIdAvailable(collectionId: string, id: string): Promise<void> {
    const [existing] = await this.deps.db
      .select({ id: items.id })
      .from(items)
      .where(
        and(
          scopeSite(items.siteId, this.deps.siteId),
          eq(items.collectionId, collectionId),
          eq(items.id, id),
        ),
      )
      .limit(1);
    if (existing) {
      assertPrimaryKeyAvailable(id, true);
    }
  }

  private assertPermissionValidation(
    perm: CompiledPermission | null,
    snapshot: Record<string, unknown>,
  ): void {
    if (!perm || !Object.keys(perm.validation).length) return;
    if (evaluate(perm.validation as PolicyRule, snapshot, this.deps.permissionCtx ?? defaultMagicContext(this.deps.siteId))) return;
    throw new ItemServiceError('FORBIDDEN', 'Item violates permission validation rule.', 403);
  }

  // Search sync runs on the change events (HeoPress P04): see
  // `searchSyncConsumer` in content-indexing-worker.ts.

  /**
   * Publish an item mutation event to SiteRoom for realtime fan-out.
   * Non-critical: errors are caught and logged, never blocking the main response.
   *
   * SECURITY (spec realtime-subscriptions Req 2, §fan-out): a studio
   * collection-broadcast reaches every session subscribed to `collection`,
   * whose per-collection read grant and field mask are NOT re-evaluated at the
   * hub. So the event carries ONLY the change signal (`collection`/`action`/
   * `itemId`) — never `row.data`. The Studio client treats it as an
   * invalidation trigger and re-fetches through the permission-enforced
   * `/items` API, which applies row RBAC + field masking. This makes
   * fan-out masking correct by construction: no row content ever crosses the
   * wire (or sits in hub/DO memory) without going through authorization.
   */
  private async publishRealtimeEvent(
    collection: string,
    action: 'create' | 'update' | 'delete',
    itemId: string,
  ): Promise<void> {
    const event = {
      type: 'event' as const,
      plane: 'studio' as const,
      collection,
      action,
      itemId,
      // Empty payload: subscribers re-fetch under their own RBAC (see doc-block).
      // Never `row.data` — that would bypass per-subscriber field masking.
      payload: null,
      actorUserId: this.deps.userId ?? undefined,
    };
    try {
      if (this.deps.realtime) {
        await this.deps.realtime.publish(this.deps.siteId, event);
      }
    } catch (err) {
      // Realtime fan-out is non-critical — log and continue.
      console.error('[item-service] realtime publish failed', { collection, itemId, err: formatSafeError(err) });
    }
  }

  /**
   * Fan a committed item mutation out to matching event-triggered flows
   * (visual-flow-builder Req 1). Only the enqueue happens here — execution is
   * the flow-events consumer's job — and `dispatchItemEvent` never throws, so
   * flow automation can never fail a content write.
   */
  private async dispatchFlowEvent(
    collection: string,
    action: 'create' | 'update' | 'delete',
    itemId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!this.deps.queue) return;
    await dispatchItemEvent(
      { db: this.deps.rootDb ?? this.deps.db, siteId: this.deps.siteId, queue: this.deps.queue },
      { collection, action, itemId, payload },
    );
  }

  private async processCrypto(
    collectionName: string,
    data: Record<string, unknown>,
    mode: 'encrypt' | 'decrypt',
    recordId: string,
    internal = false,
    degraded = false,
    auditAccess?: boolean,
    opts?: CryptoRecordOpts,
  ): Promise<Record<string, unknown>> {
    if (!this.cryptoService || !this.keyProvider) return data;
    if (!data) return data;
    const compiled = await this.schemaService.getCompiled(collectionName);
    if (!compiled) return data;

    const encryptedFields = compiled.fields.filter((f) => f.encrypted).map((f) => f.name);
    if (encryptedFields.length === 0) return data;

    // pii/phi fields whose decrypted reads must be audited (Req 6.1).
    const sensitiveFields = new Set(
      compiled.fields
        .filter((f) => f.classification === 'pii' || f.classification === 'phi')
        .map((f) => f.name),
    );

    let canDecrypt = internal;
    if (mode === 'decrypt' && !internal) {
      try {
        const perm = await this.perm(collectionName, 'read_decrypted');
        canDecrypt = !!perm;
      } catch {
        canDecrypt = false;
      }
    }

    // Resolve one cipher per record (Req 4.5). Writes follow the per-site
    // setting; reads are self-describing — the record's stored wrapped DEK is
    // the single source of truth, so a row keeps decrypting after the site
    // toggles modes. A missing KEK on an envelope read fails closed.
    const out = { ...data };
    let cipher: RecordCipher;
    if (mode === 'encrypt') {
      cipher = (await this.envelopeWriteEnabled())
        ? await newEnvelopeRecordCipher(this.keyProvider, this.deps.siteId, recordId)
        : sharedRecordCipher(this.cryptoService);
      if (opts) opts.wrappedDek = cipher.wrappedDek;
    } else if (opts?.dekWrapped) {
      try {
        cipher = await openEnvelopeRecordCipher(
          this.keyProvider,
          this.deps.siteId,
          recordId,
          opts.dekWrapped,
        );
      } catch (err) {
        // Unwrap failed (KEK rotated away / crypto-shredded). Fail closed for
        // every encrypted field, mirroring the per-field handling below.
        if (canDecrypt) {
          for (const f of encryptedFields) {
            if (out[f] === undefined || out[f] === null) continue;
            await this.auditDecryptionFailure(collectionName, f, recordId, err);
            if (degraded) {
              out[f] = null;
              (out as Record<string, unknown>)._decryptError = true;
            } else {
              throw new ItemServiceError('DECRYPTION_FAILED', `Failed to decrypt field "${f}".`, 500);
            }
          }
        } else {
          for (const f of encryptedFields) if (out[f] != null) out[f] = '***';
        }
        return out;
      }
    } else {
      cipher = sharedRecordCipher(this.cryptoService);
    }

    const accessedSensitive: string[] = [];
    for (const f of encryptedFields) {
      const value = out[f];
      if (value === undefined || value === null) continue;
      const ctx: CryptoContext = {
        siteId: this.deps.siteId,
        collection: collectionName,
        field: f,
        recordId,
      };
      if (mode === 'encrypt') {
        out[f] = await cipher.encrypt(value, ctx);
      } else if (canDecrypt) {
        try {
          out[f] = await cipher.decrypt(value as string, ctx);
          if (sensitiveFields.has(f)) accessedSensitive.push(f);
        } catch (err) {
          // Fail-closed (Req 1): never substitute a placeholder for a real
          // decryption failure. Audit, then either propagate (single-item) or
          // degrade the single field (list reads with the opt-in flag).
          await this.auditDecryptionFailure(collectionName, f, recordId, err);
          if (degraded) {
            out[f] = null;
            (out as Record<string, unknown>)._decryptError = true;
          } else if (err instanceof DecryptionError) {
            throw new ItemServiceError(
              'DECRYPTION_FAILED',
              `Failed to decrypt field "${f}".`,
              500,
            );
          } else {
            throw err;
          }
        }
      } else {
        out[f] = '***';
      }
    }
    // Audit successful decrypted reads of pii/phi fields (Req 6.1, 6.2). Only
    // for non-internal reads — internal decrypts (e.g. read-modify-write) are
    // not "access" by an actor. Flushed before the response returns.
    // Audit decrypted pii/phi reads. Defaults to actor reads (!internal); SAR
    // forces it on even for internal decrypts (Req 13.2).
    const doAudit = auditAccess ?? !internal;
    if (mode === 'decrypt' && doAudit && accessedSensitive.length > 0) {
      await this.writeFieldAccessLog(collectionName, [recordId], accessedSensitive);
    }
    return out;
  }

  /**
   * Append a Field_Access_Log entry for decrypted pii/phi reads (Req 6).
   * Never records decrypted values. Best-effort: a logging failure must not
   * break the read, but the write is awaited so single-item reads flush first.
   */
  private async writeFieldAccessLog(
    collection: string,
    recordIds: string[],
    fields: string[],
  ): Promise<void> {
    try {
      const actor =
        (typeof this.deps.permissionCtx?.user?.email === 'string'
          ? this.deps.permissionCtx.user.email
          : null) ??
        this.deps.userId ??
        null;
      await enqueueFieldAccessLog(
        { db: this.deps.rootDb ?? this.deps.db, siteId: this.deps.siteId, queue: this.deps.queue },
        {
          collection,
          recordIds,
          fields,
          actor,
          action: 'read_decrypted',
          requestId: null,
        },
      );
    } catch (err) {
      console.error('[item-service] field access log write failed', formatSafeError(err));
    }
  }

  /**
   * Records a `decryption_failed` audit entry. Never includes ciphertext, key
   * material, or plaintext (Req 1.2, 1.3).
   */
  private async auditDecryptionFailure(
    collection: string,
    field: string,
    recordId: string,
    err: unknown,
  ): Promise<void> {
    const keyId = err instanceof DecryptionError ? err.keyId : undefined;
    const actorEmail =
      typeof this.deps.permissionCtx?.user?.email === 'string'
        ? this.deps.permissionCtx.user.email
        : null;
    await new AuditLogger({ db: this.deps.db, siteId: this.deps.siteId }).write({
      event: 'decryption_failed',
      actorEmail,
      ip: this.deps.permissionCtx?.ip ?? null,
      userAgent: this.deps.permissionCtx?.headers?.['user-agent'] ?? null,
      requestId: null,
      metadata: { siteId: this.deps.siteId, collection, field, recordId, keyId },
    });
  }

  /** Whether a collection opts into degraded reads on decryption failure (Req 1.4). */
  private degradedReadEnabled(coll: { meta?: unknown }): boolean {
    const meta = coll.meta as Record<string, unknown> | null | undefined;
    return meta?.degradedReadOnFailure === true;
  }

  /**
   * Starts a write-coalescing window (Load Guard, Req 9.1). While active,
   * per-write invalidation work (materialized-view refresh) is deferred and
   * deduplicated per collection; `flushCoalescedWrites` runs it once per
   * collection at the tool-call boundary. The harness wraps every skill
   * handler in a window so a batch of N writes to one collection costs one
   * refresh instead of N.
   */
  beginWriteCoalescing(): void {
    this.writeCoalescer = new WriteCoalescer();
  }

  /** Flushes deferred invalidations; returns the refreshed collections. */
  async flushCoalescedWrites(): Promise<string[]> {
    if (!this.writeCoalescer) return [];
    const collections = this.writeCoalescer.flush();
    this.writeCoalescer = null;
    for (const collection of collections) {
      await this.triggerMaterializeRefresh(collection);
      await this.invalidateContentCache(collection);
    }
    return collections;
  }

  /** Per-write invalidation: immediate normally, deferred while coalescing. */
  private async afterWriteInvalidation(collectionName: string): Promise<void> {
    if (this.writeCoalescer) {
      this.writeCoalescer.record(collectionName);
      return;
    }
    await this.triggerMaterializeRefresh(collectionName);
    await this.invalidateContentCache(collectionName);
  }

  /** Tag purge + ISR revalidation after published content changes (Req 8). */
  private async invalidateContentCache(collectionName: string): Promise<void> {
    await invalidateItemsTag(
      this.deps.cache,
      this.deps.siteId,
      collectionName,
      this.deps.edgeCache,
    );
    await dispatchItemRevalidation({
      db: (this.deps.rootDb ?? this.deps.db),
      queue: this.deps.queue,
      siteId: this.deps.siteId,
      collection: collectionName,
    });
  }

  private async triggerMaterializeRefresh(collectionName: string): Promise<void> {
    try {
      const mcs = await (this.deps.rootDb ?? this.deps.db)
        .select()
        .from(materializedCollections)
        .where(
          and(
            eq(materializedCollections.siteId, this.deps.siteId),
            eq(materializedCollections.collection, collectionName)
          )
        );

      for (const mc of mcs) {
        const config: MaterializeConfig = {
          id: mc.id,
          siteId: this.deps.siteId,
          collection: mc.collection,
          target: mc.target,
          refreshStrategy: mc.refreshStrategy,
          projection: mc.projection as { fields: string[]; orderBy?: string },
          filter: mc.filter as Record<string, unknown>,
        };

        if (this.deps.queue) {
          await this.deps.queue.enqueue('materialize-refresh', 'refresh', { config });
        } else {
          await refreshPhysicalTable((this.deps.rootDb ?? this.deps.db), config);
        }
      }
    } catch (err) {
      console.error('[item-service] materialize trigger failed', { collectionName, err: formatSafeError(err) });
    }
  }

  /** True when an active content intent governs this collection (Law Zero). */
  private async isIntentGoverned(collectionName: string): Promise<boolean> {
    try {
      const [intent] = await this.deps.db
        .select({ id: contentIntents.id })
        .from(contentIntents)
        .where(
          and(
            eq(contentIntents.siteId, this.deps.siteId),
            eq(contentIntents.collection, collectionName),
            eq(contentIntents.status, 'active'),
          ),
        )
        .limit(1);
      return Boolean(intent);
    } catch {
      // Intent lookup must never block a human write.
      return false;
    }
  }

  /** Lists pinned fields for an item. */
  async listPins(collectionName: string, id: string): Promise<{ pinnedFields: string[] }> {
    const coll = await this.resolveCollection(collectionName);
    await this.perm(collectionName, 'read');
    const [row] = await this.deps.db
      .select({ pinnedFields: items.pinnedFields })
      .from(items)
      .where(
        and(
          scopeSite(items.siteId, this.deps.siteId),
          eq(items.collectionId, coll.id),
          eq(items.id, id),
          isNull(items.deletedAt),
        ),
      )
      .limit(1);
    if (!row) throw new ItemServiceError('NOT_FOUND', `Item "${id}" not found.`, 404);
    return { pinnedFields: Array.isArray(row.pinnedFields) ? (row.pinnedFields as string[]) : [] };
  }

  /**
   * Releases a human pin, handing the field back to agents. Audited with
   * the releasing actor (Req 8.4).
   */
  async releasePin(collectionName: string, id: string, field: string): Promise<{ pinnedFields: string[] }> {
    const coll = await this.resolveCollection(collectionName);
    await this.perm(collectionName, 'update');
    const { pinnedFields } = await this.listPins(collectionName, id);
    if (!pinnedFields.includes(field)) {
      throw new ItemServiceError('NOT_PINNED', `Field "${field}" is not pinned.`, 404);
    }
    const next = pinnedFields.filter((f) => f !== field);
    await runItemWriteTransaction(this.deps.db, this.deps.siteId, async (tx) => {
      const rows = await tx
        .update(items)
        .set({ pinnedFields: next, updatedAt: new Date(), version: sql`${items.version} + 1` })
        .where(
          and(
            scopeSite(items.siteId, this.deps.siteId),
            eq(items.collectionId, coll.id),
            eq(items.id, id),
            isNull(items.deletedAt),
          ),
        )
        .returning({ version: items.version });
      if (rows[0]) await this.writeEvent(tx, collectionName, 'update', id, null, rows[0].version, ['pinnedFields']);
    });
    await this.writeActivity('pin.release', coll.name, id, { field });
    return { pinnedFields: next };
  }

  /**
   * Replace one block, addressed by its stable ID (P04, spec
   * content/block-identity "按区块定位修改"): only that block changes; the
   * other blocks and their IDs stay as they are. Version-checked like any
   * update. `block` is one HTML element for a rich-text field, or the row
   * object for a repeater field.
   */
  async patchBlock(
    collectionName: string,
    id: string,
    field: string,
    blockId: string,
    block: unknown,
    expectedVersion: number | undefined,
  ) {
    if (expectedVersion === undefined) throw versionRequired();
    const kind = (await this.blockFields(collectionName)).get(field);
    if (!kind) throw new ItemServiceError('NOT_A_BLOCK_FIELD', `Field "${field}" does not hold blocks.`, 400);
    const current = (await this.detail(collectionName, id)) as { data?: Record<string, unknown>; version: number };
    if (current.version !== expectedVersion) {
      throw await this.conflict(collectionName, id, expectedVersion, current.version);
    }
    const value = current.data?.[field];
    let next: unknown;
    try {
      if (kind === 'html') {
        if (typeof block !== 'string') throw new BlockError('INVALID_BLOCK', 'A rich-text block is one HTML element (a string).', 400);
        next = replaceHtmlBlock(typeof value === 'string' ? value : '', blockId, block);
      } else {
        if (!block || typeof block !== 'object' || Array.isArray(block)) {
          throw new BlockError('INVALID_BLOCK', 'A repeater block is one row (an object).', 400);
        }
        next = replaceRowBlock(Array.isArray(value) ? value : [], blockId, block as Record<string, unknown>);
      }
    } catch (err) {
      if (err instanceof BlockError) throw new ItemServiceError(err.code, err.message, err.status);
      throw err;
    }
    return this.patch(collectionName, id, { data: { [field]: next }, expectedVersion });
  }

  /**
   * Put an item on hold, or release it (P04, spec content/write-concurrency).
   * A held item is never published, by any path (publish-guard.ts). Anyone
   * who may update the item can set a hold; only a person — not an API key,
   * not an agent — who may publish it can release it. Version-checked like
   * any other change.
   */
  async setHold(
    collectionName: string,
    id: string,
    hold: boolean,
    expectedVersion: number | undefined,
  ): Promise<{ id: string; hold: boolean; version: number }> {
    if (expectedVersion === undefined) throw versionRequired();
    const coll = await this.resolveCollection(collectionName);
    const perm = await this.perm(collectionName, 'update');
    const permClause = this.permissions?.whereFor(perm) ?? undefined;
    if (!hold) await this.assertMayReleaseHold(collectionName, coll.id, id, perm, permClause);
    // A hold set because the item's source licence lapsed (HeoPress P08 task 1.6) is released only by restoring the
    // item from the licence review, which checks the licence is effective again.
    if (!hold && (await runSiteTransaction(this.deps.db, this.deps.siteId, (tx) => hasOpenLicenceHold(tx, this.deps.siteId, id)))) {
      throw new ItemServiceError('LICENCE_REVIEW_OPEN', 'This item was hidden because its source licence lapsed: restore it from the licence review.', 409);
    }

    // The hold change and its event commit together (P04).
    const row = await runItemWriteTransaction(this.deps.db, this.deps.siteId, async (tx) => {
      const [changed] = await tx
        .update(items)
        .set({ hold, version: expectedVersion + 1, userUpdated: this.deps.userId ?? null, updatedAt: new Date() })
        .where(
          and(
            scopeSite(items.siteId, this.deps.siteId),
            eq(items.collectionId, coll.id),
            eq(items.id, id),
            isNull(items.deletedAt),
            eq(items.version, expectedVersion),
            permClause,
          ),
        )
        .returning({ id: items.id, hold: items.hold, version: items.version });
      if (changed) await this.writeEvent(tx, collectionName, 'update', id, null, changed.version, ['hold']);
      return changed;
    });
    if (!row) {
      const [now] = await this.deps.db
        .select({ version: items.version })
        .from(items)
        .where(and(scopeSite(items.siteId, this.deps.siteId), eq(items.collectionId, coll.id), eq(items.id, id), isNull(items.deletedAt), permClause))
        .limit(1);
      if (!now) throw new ItemServiceError('NOT_FOUND', `Item "${id}" not found.`, 404);
      throw new VersionConflictError(now.version, await this.changedFieldsSince(id, expectedVersion));
    }
    await this.writeActivity(hold ? 'hold.set' : 'hold.release', coll.name, id, {});
    this.wakeConsumers();
    await this.afterWriteInvalidation(collectionName);
    return row;
  }

  /**
   * Releasing a hold is a person's decision: a signed-in user (not an API
   * key, not an anonymous or front-end principal) acting directly (not
   * through an agent), who may publish the item (update permission that
   * allows setting `status` to `published`).
   */
  private async assertMayReleaseHold(
    collectionName: string,
    collectionId: string,
    id: string,
    perm: Awaited<ReturnType<ItemService['perm']>>,
    permClause: SQL | undefined,
  ): Promise<void> {
    const ctx = this.deps.permissionCtx;
    const human =
      this.provenance.authorType === 'human' &&
      !!ctx?.userId &&
      !ctx.apiKey &&
      ctx.principal !== 'api_key' &&
      ctx.principal !== 'anonymous' &&
      ctx.principal !== 'frontend';
    if (!human) {
      throw new ItemServiceError(
        'HOLD_RELEASE_REQUIRES_PERSON',
        'Only a person with publish permission can release a hold; API keys and agents cannot.',
        403,
      );
    }
    // The full publish check: `status` writable, and the item as it would be
    // once published passes the update rule's validation (Codex review P04-1).
    const [row] = await this.deps.db
      .select()
      .from(items)
      .where(and(scopeSite(items.siteId, this.deps.siteId), eq(items.collectionId, collectionId), eq(items.id, id), isNull(items.deletedAt), permClause))
      .limit(1);
    if (!row) throw new ItemServiceError('NOT_FOUND', `Item "${id}" not found.`, 404);
    try {
      const knownFields = await this.getKnownWritableFields(collectionName);
      assertWritablePermissionFields(perm, knownFields, {}, { status: 'published' });
      const data = await this.processCrypto(collectionName, row.data as Record<string, unknown>, 'decrypt', id, true, false, undefined, {
        dekWrapped: row.dekWrapped,
      });
      this.assertPermissionValidation(
        perm,
        buildPermissionSnapshot({
          id: row.id,
          data,
          status: 'published',
          sort: row.sort,
          userCreated: row.userCreated,
          userUpdated: this.deps.userId ?? null,
          createdAt: row.createdAt,
          updatedAt: new Date(),
        }),
      );
    } catch {
      throw new ItemServiceError(
        'HOLD_RELEASE_REQUIRES_PUBLISH',
        'Releasing a hold needs permission to publish this item.',
        403,
      );
    }
  }

  private async writeRevision(
    collectionId: string,
    itemId: string,
    after: Record<string, unknown>,
    before: Record<string, unknown> | null,
  ) {
    await this.deps.db.insert(revisions).values({
      siteId: this.deps.siteId,
      collectionId,
      itemId,
      delta: { before, after },
      userId: this.deps.userId ?? null,
      authorType: this.provenance.authorType,
      createdByRunId: this.provenance.runId ?? null,
      model: this.provenance.model ?? null,
      constitutionHash: this.provenance.constitutionHash ?? null,
      sources: this.provenance.sources ?? null,
      confidence: this.provenance.confidence ?? null,
    });
  }

  private async writeActivity(
    action: string,
    collectionName: string,
    itemId: string | null,
    payload: Record<string, unknown>,
  ) {
    await this.deps.db.insert(activity).values({
      siteId: this.deps.siteId,
      action,
      userId: this.deps.userId ?? null,
      collection: collectionName,
      itemId,
      payload,
    });
  }
}

/**
 * Law Zero (override-is-law) helpers. Pure functions so pin semantics can be
 * property-tested in isolation.
 */

/** Returns the patched fields that are blocked for agents by a human pin. */
export function blockedPinnedFields(
  pinnedFields: readonly string[],
  patchKeys: readonly string[],
  authorType: ItemProvenance['authorType'],
): string[] {
  if (authorType !== 'agent') return [];
  const pinned = new Set(pinnedFields);
  return patchKeys.filter((key) => pinned.has(key));
}

/**
 * Computes the next pin set after a write. Human edits on intent-governed
 * collections pin the touched fields; agent writes never alter pins.
 */
export function computeNextPinnedFields(
  pinnedFields: readonly string[],
  patchKeys: readonly string[],
  authorType: ItemProvenance['authorType'],
  intentGoverned: boolean,
): string[] {
  if (authorType !== 'human' || !intentGoverned) return [...pinnedFields];
  return [...new Set([...pinnedFields, ...patchKeys])];
}

export function assertWritablePermissionFields(
  perm: CompiledPermission | null,
  knownFields: string[],
  data: Record<string, unknown>,
  structural: Partial<Record<(typeof WRITABLE_STRUCTURAL_FIELDS)[number], unknown>> = {},
): void {
  if (!perm || (perm.fields.length === 1 && perm.fields[0] === '*')) return;

  const allowed = new Set(applyFieldMask(knownFields, perm.fields));
  const attempted = [
    ...Object.keys(data),
    ...Object.entries(structural)
      .filter(([, value]) => value !== undefined)
      .map(([key]) => key),
  ];
  const denied = attempted.filter((field) => !allowed.has(field));
  if (denied.length) {
    throw new ItemServiceError(
      'FORBIDDEN',
      `Permission does not allow writing field(s): ${denied.join(', ')}.`,
      403,
    );
  }
}

/**
 * Coerce and validate a scheduling window (Req 7.2). Returns Date|null for each
 * bound and throws INVALID_PUBLISH_WINDOW (422) when both are set and
 * `unpublishAt <= publishAt`.
 */
export function normalizePublishWindow(
  publishAt: string | Date | null | undefined,
  unpublishAt: string | Date | null | undefined,
): { publishAt: Date | null; unpublishAt: Date | null } {
  const toDate = (v: string | Date | null | undefined): Date | null => {
    if (v === null || v === undefined) return null;
    const d = v instanceof Date ? v : new Date(v);
    if (Number.isNaN(d.getTime())) {
      throw new ItemServiceError('INVALID_PUBLISH_WINDOW', 'Invalid publish/unpublish date.', 422);
    }
    return d;
  };
  const p = toDate(publishAt);
  const u = toDate(unpublishAt);
  if (p && u && u.getTime() <= p.getTime()) {
    throw new ItemServiceError(
      'INVALID_PUBLISH_WINDOW',
      'unpublishAt must be after publishAt.',
      422,
    );
  }
  return { publishAt: p, unpublishAt: u };
}

export function resolvePrimaryKey(
  strategy: PrimaryKeyStrategyInput,
  input: Record<string, unknown>,
): PrimaryKeyResolution {
  const field = strategy.field || 'id';
  const type = normalizePrimaryKeyType(strategy.type);
  const storageMode = normalizeStorageMode(strategy.storageMode);

  if (storageMode === 'jsonb' && (type === 'integer' || type === 'bigInteger')) {
    throw new ItemServiceError(
      'UNSUPPORTED_PRIMARY_KEY',
      `${type} primary keys require materialized or physical storage mode.`,
      400,
    );
  }

  if (type === 'uuid') {
    return { field, type, storageMode, id: generateUuid() };
  }

  if (type === 'string') {
    const candidate = input[field] ?? input.id;
    if (typeof candidate !== 'string' || candidate.trim().length === 0) {
      throw new ItemServiceError(
        'PRIMARY_KEY_REQUIRED',
        `String primary key requires "${field}" in the item data.`,
        400,
      );
    }
    return { field, type, storageMode, id: candidate };
  }

  return { field, type, storageMode, id: undefined };
}

export function assertPrimaryKeyAvailable(id: string, exists: boolean): void {
  if (!exists) return;
  throw new ItemServiceError('ITEM_ID_EXISTS', `Item "${id}" already exists.`, 409);
}

function normalizePrimaryKeyType(value: string | null | undefined): PrimaryKeyType {
  switch (value) {
    case 'uuid':
    case 'integer':
    case 'bigInteger':
    case 'string':
    case 'nanoid':
      return value;
    default:
      return 'nanoid';
  }
}

function normalizeStorageMode(value: string | null | undefined): StorageMode {
  switch (value) {
    case 'materialized':
    case 'physical':
    case 'external':
    case 'jsonb':
      return value;
    default:
      return 'jsonb';
  }
}

function generateUuid(): string {
  const runtimeCrypto = (globalThis as {
    crypto?: { randomUUID?: () => `${string}-${string}-${string}-${string}-${string}` };
  }).crypto;
  if (!runtimeCrypto?.randomUUID) {
    throw new ItemServiceError('UNSUPPORTED_PRIMARY_KEY', 'UUID generation requires Web Crypto randomUUID support.', 500);
  }
  return runtimeCrypto.randomUUID();
}

export function buildPermissionSnapshot(input: {
  id?: string;
  data: Record<string, unknown>;
  status: string;
  sort: number;
  userCreated?: string | null;
  userUpdated?: string | null;
  createdAt?: Date | null;
  updatedAt?: Date | null;
}): Record<string, unknown> {
  return {
    ...input.data,
    data: input.data,
    id: input.id,
    status: input.status,
    sort: input.sort,
    user_created: input.userCreated ?? null,
    user_updated: input.userUpdated ?? null,
    created_at: input.createdAt ?? null,
    updated_at: input.updatedAt ?? null,
  };
}

function defaultMagicContext(siteId: string): MagicContext {
  return {
    userId: null,
    siteId,
    roleId: null,
    ip: null,
    headers: {},
  };
}


export interface RelationFieldSelection {
  alias: string;
  fields: string[];
  limit?: number;
}

export function parseRelationFieldSelections(fields: string[], deep: DeepQuery = {}): RelationFieldSelection[] {
  const byAlias = new Map<string, Set<string>>();
  const limits = new Map<string, number>();
  for (const token of fields) {
    const [alias, ...path] = token.split('.');
    if (!alias || UNSAFE_ALIASES.has(alias) || path.length === 0) continue;
    const field = path.join('.');
    if (!field) continue;
    const selected = byAlias.get(alias) ?? new Set<string>();
    selected.add(field);
    byAlias.set(alias, selected);
  }
  for (const [alias, options] of Object.entries(deep)) {
    if (!alias || UNSAFE_ALIASES.has(alias)) continue;
    const selected = byAlias.get(alias) ?? new Set<string>();
    const deepFields = options.fields?.length ? options.fields : ['*'];
    for (const field of deepFields) {
      if (field) selected.add(field);
    }
    byAlias.set(alias, selected);
    if (typeof options.limit === 'number') limits.set(alias, options.limit);
  }
  return [...byAlias.entries()].map(([alias, selected]) => ({
    alias,
    fields: [...selected],
    ...(limits.has(alias) ? { limit: limits.get(alias) } : {}),
  }));
}

export function relationAlias(rel: {
  aliasField?: string | null;
  manyField: string;
  manyCollection?: string;
  oneCollection: string;
  type?: string | null;
}): string {
  if (rel.aliasField) return rel.aliasField;
  if (rel.type === 'o2m') return rel.manyCollection ?? rel.manyField;
  if (rel.type === 'm2m') return rel.oneCollection;
  return rel.manyField.endsWith('_id') ? rel.manyField.slice(0, -3) : rel.oneCollection;
}

export function parseDeepQueryParams(searchParams: URLSearchParams): DeepQuery | undefined {
  const deep: DeepQuery = {};
  for (const [key, value] of searchParams.entries()) {
    const match = /^deep\[([^\]]+)\]\[([^\]]+)\]$/.exec(key);
    if (!match) continue;
    const [, alias, option] = match;
    if (!alias || !option) continue;
    if (UNSAFE_ALIASES.has(alias)) continue;
    const current = deep[alias] ?? {};
    if (option === 'fields') {
      current.fields = value.split(',').map((field) => field.trim()).filter(Boolean);
    } else if (option === 'limit') {
      const limit = Number.parseInt(value, 10);
      if (Number.isFinite(limit) && limit >= 0) current.limit = limit;
    }
    deep[alias] = current;
  }
  return Object.keys(deep).length > 0 ? deep : undefined;
}

/**
 * Resolve the list `filter` from query params, supporting two equivalent forms:
 *
 *   1. JSON string  — `?filter={"status":{"_eq":"published"}}`
 *   2. Bracket form  — `?filter[status][_eq]=published`
 *
 * If a JSON `filter` param is present it wins (backward-compatible). Otherwise
 * any `filter[...]` keys are folded into a nested object. Returns `undefined`
 * when no filter is supplied. Throws `SyntaxError` only for malformed JSON in
 * form (1) — callers translate that into a 400.
 *
 * Bracket values are coerced from their string form: `true`/`false` → boolean,
 * numeric strings → number, and comma-separated values under array operators
 * (`_in`, `_nin`, `_between`) → string array. Everything else stays a string.
 */
export function parseFilterQueryParams(
  searchParams: URLSearchParams,
  jsonFilter?: string,
): Record<string, unknown> | undefined {
  // Form (1): explicit JSON filter takes precedence (backward compatible).
  if (jsonFilter !== undefined && jsonFilter !== '') {
    return JSON.parse(jsonFilter) as Record<string, unknown>;
  }

  // Form (2): collect bracketed `filter[a][b]...=value` keys into a nested object.
  const root: Record<string, unknown> = {};
  let matched = false;

  for (const [key, value] of searchParams.entries()) {
    if (!key.startsWith('filter[')) continue;
    const path = parseBracketPath(key);
    if (!path) continue; // ignore a malformed key rather than 400 the whole request
    matched = true;
    setNested(root, path, coerceFilterValue(path[path.length - 1]!, value));
  }

  return matched ? root : undefined;
}

/** `filter[status][_eq]` → `['status', '_eq']`; returns null if not well-formed. */
function parseBracketPath(key: string): string[] | null {
  if (!key.startsWith('filter[')) return null;
  const segments: string[] = [];
  const re = /\[([^\]]*)\]/g;
  let m: RegExpExecArray | null;
  let lastIndex = 'filter'.length;
  while ((m = re.exec(key)) !== null) {
    if (m.index !== lastIndex) return null; // gap/garbage between segments
    if (m[1] === '') return null; // empty bracket `[]`
    segments.push(m[1]!);
    lastIndex = re.lastIndex;
  }
  if (lastIndex !== key.length) return null; // trailing garbage
  return segments.length > 0 ? segments : null;
}

function setNested(root: Record<string, unknown>, path: string[], value: unknown): void {
  let cur = root;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i]!;
    if (typeof cur[seg] !== 'object' || cur[seg] === null) cur[seg] = {};
    cur = cur[seg] as Record<string, unknown>;
  }
  cur[path[path.length - 1]!] = value;
}

const ARRAY_OPERATORS = new Set(['_in', '_nin', '_between']);

function coerceFilterValue(operator: string, raw: string): unknown {
  if (ARRAY_OPERATORS.has(operator)) {
    return raw.split(',').map((v) => coerceScalar(v.trim()));
  }
  return coerceScalar(raw);
}

function coerceScalar(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  // Keep leading-zero / overflow-ish strings as strings; only coerce clean numbers.
  if (raw !== '' && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw)) {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return raw;
}

export function projectRelatedRow(row: ItemRow, fields: string[]): Record<string, unknown> {
  if (fields.includes('*')) {
    return {
      id: row.id,
      status: row.status,
      sort: row.sort,
      user_created: row.userCreated,
      user_updated: row.userUpdated,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
      ...(row.data ?? {}),
    };
  }
  return projectFields(row, fields);
}

export function projectFields(row: ItemRow, fields: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.includes('.')) {
      assignNestedProjection(out, row.data ?? {}, f);
    } else if (STRUCTURAL_FIELDS.has(f)) {
      const map: Record<string, unknown> = {
        id: row.id,
        status: row.status,
        sort: row.sort,
        user_created: row.userCreated,
        user_updated: row.userUpdated,
        created_at: row.createdAt,
        updated_at: row.updatedAt,
      };
      out[f] = map[f];
    } else {
      out[f] = row.data?.[f];
    }
  }
  return out;
}

function assignNestedProjection(out: Record<string, unknown>, source: Record<string, unknown>, token: string): void {
  const [alias, ...pathParts] = token.split('.');
  if (!alias || pathParts.length === 0) return;
  const value = source[alias];
  const path = pathParts.join('.');
  if (path === '*') {
    out[alias] = value;
    return;
  }
  if (Array.isArray(value)) {
    const previous = Array.isArray(out[alias]) ? out[alias] as unknown[] : [];
    out[alias] = value.map((item, index) => ({
      ...(isPlainRecord(previous[index]) ? previous[index] : {}),
      ...(isPlainRecord(item) ? pickNestedValue(item, path) as Record<string, unknown> : {}),
    }));
    return;
  }
  if (!isPlainRecord(value)) {
    out[alias] = value == null ? value : {};
    return;
  }
  out[alias] = {
    ...(isPlainRecord(out[alias]) ? out[alias] : {}),
    ...(pickNestedValue(value, path) as Record<string, unknown>),
  };
}

function pickNestedValue(value: unknown, path: string): unknown {
  if (!isPlainRecord(value)) return value;
  const [head, ...tail] = path.split('.');
  if (!head) return {};
  if (tail.length === 0) return { [head]: value[head] };
  const nested = pickNestedValue(value[head], tail.join('.'));
  return { [head]: nested };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function uniqueStrings(values: unknown[]): string[] {
  return [
    ...new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0)),
  ];
}

function assignRelation(
  rows: ItemRow[],
  alias: string,
  resolve: (row: ItemRow) => unknown,
): void {
  for (const row of rows) {
    row.data = {
      ...(row.data ?? {}),
      [alias]: resolve(row),
    };
  }
}

function limitArray<T>(values: T[], limit: number | undefined): T[] {
  return typeof limit === 'number' ? values.slice(0, limit) : values;
}
