/**
 * Runtime extension points (HeoPress P12): jobs, public endpoints, content-event subscriptions, pre-publish hooks and
 * private storage. A plugin registers each definition from its default export:
 *
 * ```ts
 * export default (ctx: PluginContext) => {
 *   ctx.extensionPoints.register('jobs', defineJob({ name: 'rescan', schedule: { everyMinutes: 60 }, run: async (job) => … }));
 *   ctx.extensionPoints.register('endpoints', defineEndpoint({ name: 'subscribe', kind: 'form', handle: async (req) => … }));
 *   ctx.extensionPoints.register('events', defineSubscription({ name: 'on-publish', collections: ['articles'], handle: … }));
 *   ctx.extensionPoints.register('events', definePrePublishHook({ name: 'require-summary', check: (item) => … }));
 *   return {};
 * };
 * ```
 *
 * Each point needs its capability (`ext:jobs`, `ext:endpoints`, `ext:events`); a subscription also needs
 * `cdc:subscribe:<collection>`. Limits are the host's: a plugin may ask for less, never for more.
 */

/** The context of one job run. */
export interface JobRunContext {
  readonly siteId: string;
  /** `schedule`, `retry`, `continuation`, `queue` or `manual`. */
  readonly trigger: string;
  /** The payload of a queued run (`ctx.jobs.enqueue(name, payload)`). */
  readonly payload: unknown;
  /** Progress saved by the previous batch; null on a fresh run. */
  readonly progress: unknown;
  /** Save progress now: a run cut short by a limit resumes from here. */
  checkpoint(progress: unknown): Promise<void>;
  /** End this batch and have the next one scheduled; it receives `progress`. */
  continueLater(progress: unknown): void;
  /** Aborted when the run is terminated (time or request limit, plugin disabled, site kill switch). */
  readonly signal: AbortSignal;
  /** Milliseconds left before the run is terminated. */
  timeLeft(): number;
}

export interface JobDefinition {
  /** `[a-z][a-z0-9-]*`, at most 40. */
  name: string;
  /** Run every N minutes (5 – 10080). Without it the job only runs when queued. */
  schedule?: { everyMinutes: number };
  /** Per-run duration (ms, default 30 000, at most 120 000). */
  maxDurationMs?: number;
  /** Outbound requests per run (default 20, at most 100). */
  maxRequests?: number;
  /** Retries after a failed run (default 3, at most 5). */
  maxRetries?: number;
  run(ctx: JobRunContext): Promise<void> | void;
}

export function defineJob(def: JobDefinition): JobDefinition & { kind: 'job' } {
  return { ...def, kind: 'job' };
}

export interface EndpointRequest {
  method: string;
  /** Form fields or parsed JSON. */
  body: unknown;
  /** The verified origin of a form request; null for a callback. */
  origin: string | null;
}

export interface EndpointDefinition {
  name: string;
  /**
   * `form`: a browser form; the request's origin must be one of the site's approved origins (its domains, site URL and
   * static deployment addresses). `callback`: a server notification signed with the plugin's secret on the site
   * (`X-HeoPress-Timestamp`, `X-HeoPress-Nonce`, `X-HeoPress-Signature: v1=<hex HMAC-SHA256(secret, "ts.nonce.body")>`).
   */
  kind: 'form' | 'callback';
  /** `POST` (default) and/or `PUT`. */
  methods?: Array<'POST' | 'PUT'>;
  /** Body limit (bytes, default 16 KiB, at most 64 KiB). */
  maxBodyBytes?: number;
  /** Requests per minute per client address (default 30, at most 120). */
  ratePerMinute?: number;
  maxDurationMs?: number;
  maxRequests?: number;
  handle(req: EndpointRequest, ctx: { siteId: string; signal: AbortSignal }): Promise<{ status?: number; body?: unknown } | void> | { status?: number; body?: unknown } | void;
}

export function defineEndpoint(def: EndpointDefinition): EndpointDefinition {
  return def;
}

/** A content change, by reference: read the item through `ctx.items` if you need it. */
export interface PluginEvent {
  /** Stable: use it to make side effects idempotent (delivery is at least once). */
  id: string;
  siteId: string;
  collection: string;
  itemId: string;
  operation: 'create' | 'update' | 'delete';
  changedFields: string[] | null;
  itemVersion: number | null;
  occurredAt: string;
}

export interface SubscriptionDefinition {
  name: string;
  /** Collections (each also needs `cdc:subscribe:<collection>`, or `cdc:subscribe:*`). */
  collections: string[];
  operations?: Array<'create' | 'update' | 'delete'>;
  /** `head` (default): events from the first run on; `start`: every retained event. */
  startFrom?: 'head' | 'start';
  maxDurationMs?: number;
  maxRequests?: number;
  handle(event: PluginEvent, ctx: { siteId: string; idempotencyKey: string; attempt: number; signal: AbortSignal }): Promise<void> | void;
}

export function defineSubscription(def: SubscriptionDefinition): SubscriptionDefinition & { kind: 'subscription' } {
  return { ...def, kind: 'subscription' };
}

/** The item as it would be published (frozen: a hook cannot change it). */
export interface PrePublishItem {
  readonly collection: string;
  readonly itemId: string | null;
  readonly status: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface PrePublishHookDefinition {
  name: string;
  /** Collections it looks at (default: all). */
  collections?: string[];
  /** Time to answer (ms, default 3000, at most 5000); no answer in time is a veto. */
  timeoutMs?: number;
  /**
   * Return nothing to let the publish go ahead, or `{ veto: "<reason>" }` to refuse it. Any other answer — content, an
   * attempt to change the item, an error — is a veto as well. Change content afterwards through `ctx.items`, as a new version.
   */
  check(item: PrePublishItem): Promise<void | { veto: string }> | void | { veto: string };
}

export function definePrePublishHook(def: PrePublishHookDefinition): PrePublishHookDefinition & { kind: 'pre-publish' } {
  return { ...def, kind: 'pre-publish' };
}

/** A stored document of the plugin's private storage. */
export interface StoredDocument {
  id: string;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** One namespace the manifest declares under `storage` (per site and plugin; not content, never published). */
export interface StorageCollection {
  get(id: string): Promise<StoredDocument | null>;
  put(id: string, data: Record<string, unknown>): Promise<StoredDocument>;
  delete(id: string): Promise<boolean>;
  /** `where` filters on fields of a declared index (a prefix of one). */
  query(q?: {
    where?: Record<string, string | number | boolean | null>;
    limit?: number;
    after?: string;
    order?: 'id' | 'recent';
  }): Promise<{ documents: StoredDocument[]; next: string | null }>;
  count(where?: Record<string, string | number | boolean | null>): Promise<number>;
}
