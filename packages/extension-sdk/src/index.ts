// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import type { StorageCollection } from './runtime';
/**
 * Extension authoring SDK. See `docs/features/extensions-system.md` for the
 * capability model. The runtime loader lives in `apps/cms/src/extensions/`.
 */
export type ExtensionType =
  | 'hook'
  | 'endpoint'
  | 'operation'
  | 'interface'
  | 'display'
  | 'layout'
  | 'panel'
  | 'module';

/** The nine extension points (ADR-0015). Using one needs the capability `ext:<point>`. */
export const EXTENSION_POINTS = [
  'collections',
  'routes',
  'source-adapters',
  'gate-checks',
  'jobs',
  'endpoints',
  'events',
  'admin-panels',
  'build-steps',
] as const;

export type ExtensionPoint = (typeof EXTENSION_POINTS)[number];

/**
 * A capability a plugin requests (HeoPress P12). The admin approves the list on install, and approves again every
 * capability an upgrade adds; the sandbox grants nothing else — official or signed plugins included. There is no
 * raw database, environment or host-file access.
 *
 * - `http:fetch:<host>` — requests to that host (`*.example.com` for its subdomains); prefer `outboundHosts`
 * - `items:read:<collection>` / `items:write:<collection>` — reading / editing drafts (`*` for every collection)
 * - `items:publish:<collection>` — setting `published` / `scheduled`; write never implies publish, and Hold and
 *   the quality gates still apply
 * - `media:read` / `media:write`, `kv:read` / `kv:write`, `secrets:<name>`
 * - `cdc:subscribe:<collection>`, `seo:structured-data`
 * - `ai:generate` — model calls through the site's model gateway (per-call ledger, site budget; never a key)
 * - `ext:<extension point>`
 */
export type Capability =
  | `http:fetch:${string}`
  | `items:read:${string}`
  | `items:write:${string}`
  | `items:publish:${string}`
  | 'media:read'
  | 'media:write'
  | 'kv:read'
  | 'kv:write'
  | `secrets:${string}`
  | `cdc:subscribe:${string}`
  | 'seo:structured-data'
  | 'ai:generate'
  | `ext:${ExtensionPoint}`;

export interface ExtensionConfigOption {
  key: string;
  type: 'string' | 'integer' | 'boolean' | 'json';
  label?: string;
  default?: unknown;
}

/**
 * The plugin manifest (`heopress-extension.json`): everything the plugin may do, declared in one place. What it
 * does not declare never takes effect. Validated by `ExtensionManifestSchema` in `@heopress/contracts/schemas`.
 */
export interface ExtensionManifest {
  name: string;
  version: string;
  type: ExtensionType;
  entry: string;
  /** Requested capabilities, e.g. `items:read:posts`, `ext:events`. */
  capabilities: Capability[];
  /** Hosts the plugin calls; each becomes `http:fetch:<host>`. Lowercase host names, no scheme, port or path. */
  outboundHosts?: string[];
  /** semver range of HeoPress the plugin runs on, e.g. `^1.0.0`; install and upgrade are refused outside it. */
  heopress?: string;
  /** Private storage namespaces and the indexes each needs (fields per index). */
  storage?: Record<string, { indexes?: string[][] }>;
  /**
   * Admin panels (need `ext:admin-panels`), rendered by the host: `table` pages list a storage namespace, `settings` is
   * the form of `settings`, widgets count a namespace. A `custom` page (its own https frontend) loads only once the
   * operator marked the plugin as trusted.
   */
  admin?: {
    pages?: Array<{ id: string; title: string; type?: 'table' | 'settings' | 'custom'; storage?: string; columns?: string[]; frontend?: string }>;
    widgets?: Array<{ id: string; title: string; type?: 'count'; storage: string }>;
    settings?: ExtensionConfigOption[];
  };
  /** Where to report vulnerabilities (e-mail or https URL). Required by the marketplace. */
  security?: { contact: string };
  config?: ExtensionConfigOption[];
  /** Auto-install during setup/reconcile (verified official `heopress-*` only). */
  autoInstall?: boolean;
  /** Whether an auto-installed extension starts enabled. */
  enabledByDefault?: boolean;
  /**
   * Structured data the extension adds to the pages of the sites it is enabled on (HeoPress P07): data, never code —
   * checked when the extension is installed, honoured once it is granted the `seo:structured-data` capability, and
   * merged into each page's one JSON-LD graph by the core, which assigns the nodes' identifiers and decides what a page
   * may carry (nothing on a page that is not indexable).
   */
  structuredData?: StructuredDataContribution[];
  /** New source types (need `ext:source-adapters`); the bundle registers each under the same id. */
  sourceAdapters?: Array<{ id: string; label: string; description?: string }>;
  /** Extra quality-gate checks (need `ext:gate-checks`); the bundle registers each under the same id. */
  gateChecks?: Array<{ id: string; label: string; description?: string; collections?: string[]; timeoutMs?: number }>;
  /** Static-build steps (need `ext:build-steps`); they run only once the operator marks the plugin as trusted. */
  buildSteps?: Array<{ id: string; label?: string; source: string; timeoutMs?: number }>;
}

/**
 * The context the host passes to a plugin's default export (`export default (ctx) => ({ ... })`). Every call is
 * checked against the approved capabilities; a refused one throws `CapabilityError` and is recorded.
 */
export interface PluginContext {
  /** Item access with the requesting user's permissions, the site boundary, Hold and gates applied. */
  readonly items: {
    list(collection: string, params?: Record<string, unknown>): Promise<unknown>;
    detail(collection: string, id: string, fields?: string[]): Promise<unknown>;
    create(collection: string, payload: { data: Record<string, unknown>; status?: string; sort?: number }): Promise<unknown>;
    patch(
      collection: string,
      id: string,
      patch: { data?: Record<string, unknown>; status?: string; sort?: number; expectedVersion?: number },
    ): Promise<unknown>;
    delete(collection: string, id: string): Promise<unknown>;
  };
  readonly media: {
    list(params?: Record<string, unknown>): Promise<unknown>;
    detail(id: string): Promise<unknown>;
    upload(file: { filename: string; contentType: string; data: Uint8Array }): Promise<unknown>;
  };
  readonly secrets: { get(name: string): Promise<string | null> };
  /** Fetch restricted to the declared hosts. */
  readonly fetch: typeof fetch;
  /** Private storage: the namespaces declared in the manifest's `storage`, of this plugin on this site. */
  readonly storage: { collection(namespace: string): StorageCollection };
  /** The plugin's declared settings on this site, as saved in its admin panel (declared default, else null). */
  readonly settings: { all(): Promise<Record<string, unknown>> };
  /** Queue a run of one of the plugin's jobs (`ext:jobs`). */
  readonly jobs: { enqueue(jobName: string, payload?: unknown): Promise<void> };
  readonly kv: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
    delete(key: string): Promise<void>;
  };
  /** Register on a declared extension point. */
  readonly extensionPoints: { register(point: ExtensionPoint, definition: unknown): void };
  /**
   * Model calls (`ai:generate`): through the site's model gateway — one ledger entry per call, the site budget, the
   * site's own models only, no tools. `key` replays a recorded answer instead of paying twice.
   */
  readonly ai: {
    generate(request: {
      messages: Array<{ role: 'user' | 'assistant'; content: string }>;
      system?: string;
      maxOutputTokens?: number;
      key?: string;
      signal?: AbortSignal;
    }): Promise<{ content: string; usage?: { inputTokens: number | null; outputTokens: number | null }; callId: string }>;
  };
  readonly meta: { readonly name: string };
}

/** What a source adapter registers on `source-adapters`: it only discovers links; the core fetches them. */
export interface SourceAdapterDefinition {
  id: string;
  discover(ctx: {
    url: string;
    maxItems: number;
    signal: AbortSignal;
    source: { id: string; name: string };
  }): Promise<Array<string | { url: string; title?: string; publishedAt?: string }>>;
}

/** What a gate check registers on `gate-checks`: a verdict on a frozen copy of the draft. */
export interface GateCheckDefinition {
  id: string;
  check(draft: Readonly<{
    siteId: string;
    collection: string;
    itemId: string;
    itemVersion: number;
    mode: string;
    locale: string | null;
    title: string;
    bodyHtml: string;
    fields: Record<string, unknown>;
    sources: Array<{ id: string; kind: string; url: string | null; licenceStatus: string | null; usageMode: string | null }>;
  }>): Promise<GateCheckVerdict> | GateCheckVerdict;
}

export interface GateCheckVerdict {
  verdict: 'passed' | 'blocked' | 'needs_review';
  evidence?: Record<string, unknown>;
  score?: number;
  suggestions?: string[];
}

/**
 * One structured-data contribution (the `StructuredDataContribution` contract). Limits: at most 8 per extension, each
 * node at most 4096 bytes of JSON; `@id` and `@context` are the core's (left out); a type the core writes (WebSite,
 * WebPage and the other page types, FAQPage, BreadcrumbList) is refused.
 */
export interface StructuredDataContribution {
  /** Unique within the extension: `[a-z][a-z0-9-]*`, at most 40. */
  key: string;
  /**
   * `site`: one node, the same on every indexable page of the site (it cannot take an item's values).
   * `item`: a node on the indexable pages of the items of `collections` (all when absent); a value
   * `{ "$field": "<name>" }` takes that public field of the item.
   */
  scope: 'site' | 'item';
  collections?: string[];
  /** A schema.org node: `@type` and properties. */
  node: Record<string, unknown>;
}

export interface HookContext {
  readonly siteId: string;
  readonly config: Record<string, unknown>;
  readonly logger: { info(msg: string, meta?: unknown): void; warn(msg: string, meta?: unknown): void };
  /** Sandboxed fetch; only hosts declared in `capabilities` resolve. */
  readonly fetch: typeof fetch;
  readonly errors: { ValidationError: new (msg: string) => Error };
}

export interface HookDefinition<TPayload = unknown> {
  on: string;
  handler: (input: {
    payload: TPayload;
    item?: Record<string, unknown>;
    ctx: HookContext;
  }) => Promise<void> | void;
}

export function defineHook<TPayload = unknown>(def: HookDefinition<TPayload>): HookDefinition<TPayload> {
  return def;
}

export type InterfaceGroup =
  | 'standard'
  | 'selection'
  | 'relational'
  | 'presentation'
  | 'group'
  | 'other';

export type InterfaceOptionType = 'string' | 'text' | 'integer' | 'decimal' | 'boolean' | 'json';

export interface InterfaceOption {
  field: string;
  name: string;
  type?: InterfaceOptionType;
  required?: boolean;
  schema?: Record<string, unknown>;
  meta?: {
    width?: 'half' | 'full' | 'fill';
    interface?: string;
    note?: string;
    options?: Record<string, unknown>;
  };
}

export interface InterfaceProps<TValue = unknown, TOptions = Record<string, unknown>> {
  value: TValue | null | undefined;
  field: unknown;
  disabled?: boolean;
  options?: TOptions;
  onChange: (next: TValue | null) => void;
}

export type InterfaceComponent<TValue = unknown, TOptions = Record<string, unknown>> = (
  props: InterfaceProps<TValue, TOptions>,
) => unknown;

export interface InterfaceDefinition<TValue = unknown, TOptions = Record<string, unknown>> {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  component: InterfaceComponent<TValue, TOptions>;
  types: string[];
  group?: InterfaceGroup;
  relational?: boolean;
  localTypes?: string[];
  options?: InterfaceOption[];
  recommendedDisplays?: string[];
}

export function defineInterface<TValue = unknown, TOptions = Record<string, unknown>>(
  def: InterfaceDefinition<TValue, TOptions>,
): InterfaceDefinition<TValue, TOptions> {
  return def;
}

/* ── Change Feed subscriber (spec cdc-extension-integration, Req 5.1) ────── */

/** One delivered change event; `id` is the idempotency key (at-least-once). */
export interface CdcEvent<TData = Record<string, unknown>> {
  id: string;
  /** `items.<operation>` */
  type: string;
  schemaVersion: number;
  siteId: string;
  collection: string;
  itemId: string;
  operation: 'create' | 'update' | 'delete';
  /** ISO timestamp (Postgres clock). */
  occurredAt: string;
  actor: { type: 'user' | 'api_key' | 'agent' | 'system'; id?: string };
  source: 'api' | 'agent' | 'flow' | 'system';
  changedFields?: string[];
  /** Present only when the subscription uses `payloadMode: 'snapshot'`; pii/phi masked. */
  data?: TData;
  /** Opaque keyset token for this event — resume/ack marker. */
  cursor: string;
}

export interface CdcSubscriberContext {
  readonly siteId: string;
  readonly config: Record<string, unknown>;
  readonly logger: { info(msg: string, meta?: unknown): void; warn(msg: string, meta?: unknown): void };
}

/**
 * Declares an async change-feed consumer. The host delivers batches
 * at-least-once AFTER the mutation commits (unlike sync `hooks`, this can
 * never block or abort a mutation) and only for collections covered by the
 * manifest's `cdc:subscribe:<collection>` capabilities — the host enforces
 * that filter, not the extension. Handlers MUST be idempotent on `event.id`.
 */
export interface CdcSubscriberDefinition<TData = Record<string, unknown>> {
  collections: string[];
  operations?: Array<'create' | 'update' | 'delete'>;
  payloadMode?: 'reference' | 'snapshot';
  handler: (input: { events: CdcEvent<TData>[]; ctx: CdcSubscriberContext }) => Promise<void>;
}

export function defineCdcSubscriber<TData = Record<string, unknown>>(
  def: CdcSubscriberDefinition<TData>,
): CdcSubscriberDefinition<TData> {
  return def;
}

export {
  defineJob,
  defineEndpoint,
  defineSubscription,
  definePrePublishHook,
  type JobRunContext,
  type JobDefinition,
  type EndpointRequest,
  type EndpointDefinition,
  type PluginEvent,
  type SubscriptionDefinition,
  type PrePublishItem,
  type PrePublishHookDefinition,
  type StoredDocument,
  type StorageCollection,
} from './runtime';
