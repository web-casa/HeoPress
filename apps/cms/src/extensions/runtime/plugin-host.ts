/**
 * The plugin host (HeoPress P12 tasks 3.1–3.7): loads a site's installed plugins for the runtime extension points and
 * reads what each registered. A plugin takes part in an extension point only when
 *
 *   - it is installed on the site, enabled, and its permissions are approved (not awaiting re-confirmation), and
 *   - it holds the point's capability (`ext:jobs`, `ext:endpoints`, `ext:events`, `ext:admin-panels`); a registration on
 *     an undeclared point is refused by the sandbox and recorded.
 *
 * A pre-publish hook also has to be declared in the manifest (`prePublishHooks`, maintainer decision 2026-10-28): one
 * registered under an undeclared name is refused and recorded, and only the declared ones make a plugin block publishing
 * when it cannot be asked (`events.ts`).
 *
 * Background work (jobs, event deliveries, public endpoints, pre-publish hooks) has no requesting user: the plugin's item
 * access goes through the site's ItemService as a system principal — its own `items:<access>:<collection>` capabilities,
 * the site boundary, Hold, publish permission (`items:publish`) and the gates still apply. Private storage is bound to the
 * site and the plugin.
 */
import { and, eq, sql } from 'drizzle-orm';
import { extensions, type Database } from '@heopress/database';
import {
  EVENT_LIMITS,
  JOB_LIMITS,
  ENDPOINT_LIMITS,
  RUNTIME_NAME,
  clampLimit,
  prePublishHooksOf,
  type ExtensionPoint,
  type ExtensionPrePublishHook,
  type PluginEndpointKind,
} from '@heopress/contracts/extensions';
import { ExtensionAdminSchema, type ExtensionAdmin } from '@heopress/contracts/schemas';
import type { Bindings } from '../../env';
import { ExtensionSandbox, type ExtensionActorDataAccess, type ExtensionSandboxDeps, type ExtensionModule } from '../sandbox';
import { buildSandboxVerifyOptions } from '../../services/extension-verifier';
import { itemServiceForSystem } from '../../services/item-service-factory';
import { AuditLogger } from '../../modules/audit/logger';
import { PluginStorage, declaredStorageOf } from './storage';

export type ExtensionRow = typeof extensions.$inferSelect;

// ─── Registrations ───────────────────────────────────────────────────────────

interface JobRunContext {
  siteId: string;
  /** Why the run started: `schedule`, `retry`, `continuation`, `queue` or `manual`. */
  trigger: string;
  /** The payload of a queued run. */
  payload: unknown;
  /** Progress saved by the previous batch (`checkpoint` / `continueLater`); null on a fresh run. */
  progress: unknown;
  /** Save progress now: a run cut short by a limit resumes from here. */
  checkpoint(progress: unknown): Promise<void>;
  /** End this batch and schedule the next one, which receives `progress`. */
  continueLater(progress: unknown): void;
  signal: AbortSignal;
  /** Milliseconds left before the run is terminated. */
  timeLeft(): number;
}

export interface PluginJob {
  name: string;
  /** Scheduled every N minutes; absent → a queued job (`ctx.jobs.enqueue`). */
  everyMinutes: number | null;
  durationMs: number;
  maxRequests: number;
  maxRetries: number;
  run(ctx: JobRunContext): Promise<unknown> | unknown;
}

interface EndpointRequest {
  method: string;
  /** Parsed body: form fields or JSON. */
  body: unknown;
  /** The verified origin of a form request; null for a callback. */
  origin: string | null;
}

interface PluginEndpoint {
  name: string;
  kind: PluginEndpointKind;
  methods: string[];
  maxBodyBytes: number;
  ratePerMinute: number;
  durationMs: number;
  maxRequests: number;
  handle(req: EndpointRequest, ctx: { siteId: string; signal: AbortSignal }): Promise<unknown> | unknown;
}

export interface PluginEvent {
  id: string;
  siteId: string;
  collection: string;
  itemId: string;
  operation: 'create' | 'update' | 'delete';
  changedFields: string[] | null;
  itemVersion: number | null;
  occurredAt: string;
}

interface PluginSubscription {
  name: string;
  collections: string[];
  operations: Array<'create' | 'update' | 'delete'> | null;
  startFrom: 'head' | 'start';
  durationMs: number;
  maxRequests: number;
  handle(event: PluginEvent, ctx: { siteId: string; idempotencyKey: string; attempt: number; signal: AbortSignal }): Promise<unknown> | unknown;
}

export interface PrePublishSubject {
  collection: string;
  itemId: string | null;
  /** The status the item would have after the write. */
  status: string;
  data: Record<string, unknown>;
}

interface PluginPrePublishHook {
  name: string;
  /** Collections it looks at (within the declared ones); null = every collection. */
  collections: string[] | null;
  timeoutMs: number;
  check(item: Readonly<PrePublishSubject>): Promise<unknown> | unknown;
}

const isFn = (v: unknown): v is (...args: never[]) => unknown => typeof v === 'function';
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const names = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every((x) => typeof x === 'string' && x.length > 0 && x.length <= 128) ? (v as string[]) : null;

/** Validated jobs of a load; malformed definitions are skipped (reported in `problems`). */
function readJobs(defs: readonly unknown[], problems: string[]): PluginJob[] {
  const out: PluginJob[] = [];
  for (const raw of defs) {
    const d = obj(raw);
    if (!d || typeof d.name !== 'string' || !RUNTIME_NAME.test(d.name) || !isFn(d.run)) {
      problems.push('jobs: a job needs a name ([a-z][a-z0-9-]*) and run()');
      continue;
    }
    const schedule = obj(d.schedule);
    let every: number | null = null;
    if (schedule) {
      const n = Number(schedule.everyMinutes);
      if (!Number.isInteger(n) || n < JOB_LIMITS.intervalMinutes.min || n > JOB_LIMITS.intervalMinutes.max) {
        problems.push(`jobs.${d.name}: schedule.everyMinutes is ${JOB_LIMITS.intervalMinutes.min}–${JOB_LIMITS.intervalMinutes.max}`);
        continue;
      }
      every = n;
    }
    out.push({
      name: d.name,
      everyMinutes: every,
      durationMs: clampLimit(d.maxDurationMs, JOB_LIMITS.durationMs),
      maxRequests: clampLimit(d.maxRequests, JOB_LIMITS.requests),
      maxRetries: clampLimit(d.maxRetries, JOB_LIMITS.retries),
      run: d.run as PluginJob['run'],
    });
  }
  return out;
}

function readEndpoints(defs: readonly unknown[], problems: string[]): PluginEndpoint[] {
  const out: PluginEndpoint[] = [];
  for (const raw of defs) {
    const d = obj(raw);
    if (!d || typeof d.name !== 'string' || !RUNTIME_NAME.test(d.name) || !isFn(d.handle) || (d.kind !== 'form' && d.kind !== 'callback')) {
      problems.push('endpoints: an endpoint needs a name, kind (form | callback) and handle()');
      continue;
    }
    const methods = (names(d.methods) ?? ['POST']).map((m) => m.toUpperCase()).filter((m) => m === 'POST' || m === 'PUT');
    out.push({
      name: d.name,
      kind: d.kind,
      methods: methods.length ? methods : ['POST'],
      maxBodyBytes: clampLimit(d.maxBodyBytes, ENDPOINT_LIMITS.bodyBytes),
      ratePerMinute: clampLimit(d.ratePerMinute, ENDPOINT_LIMITS.ratePerMinute),
      durationMs: clampLimit(d.maxDurationMs, ENDPOINT_LIMITS.durationMs),
      maxRequests: clampLimit(d.maxRequests, ENDPOINT_LIMITS.requests),
      handle: d.handle as PluginEndpoint['handle'],
    });
  }
  return out;
}

/**
 * Validated subscriptions and pre-publish hooks of a load. A pre-publish hook is kept only when the manifest declares its
 * name (`prePublishHooks`); an undeclared one is refused (its name lands in `refusedHooks`) and never runs. A declared
 * hook looks at no collection its declaration leaves out.
 */
function readEvents(
  defs: readonly unknown[],
  declared: readonly ExtensionPrePublishHook[],
  problems: string[],
): { subscriptions: PluginSubscription[]; prePublish: PluginPrePublishHook[]; refusedHooks: string[] } {
  const subscriptions: PluginSubscription[] = [];
  const prePublish: PluginPrePublishHook[] = [];
  const refusedHooks: string[] = [];
  const declaredByName = new Map(declared.map((h) => [h.name, h]));
  for (const raw of defs) {
    const d = obj(raw);
    if (!d || typeof d.name !== 'string' || !RUNTIME_NAME.test(d.name)) {
      problems.push('events: a definition needs a name');
      continue;
    }
    if (d.kind === 'subscription' && isFn(d.handle)) {
      const collections = names(d.collections);
      if (!collections?.length) {
        problems.push(`events.${d.name}: a subscription lists its collections`);
        continue;
      }
      const ops = names(d.operations)?.filter((o): o is 'create' | 'update' | 'delete' => ['create', 'update', 'delete'].includes(o)) ?? null;
      subscriptions.push({
        name: d.name,
        collections,
        operations: ops?.length ? ops : null,
        startFrom: d.startFrom === 'start' ? 'start' : 'head',
        durationMs: clampLimit(d.maxDurationMs, EVENT_LIMITS.handlerMs),
        maxRequests: clampLimit(d.maxRequests, EVENT_LIMITS.requests),
        handle: d.handle as PluginSubscription['handle'],
      });
    } else if (d.kind === 'pre-publish' && isFn(d.check)) {
      const declaration = declaredByName.get(d.name);
      if (!declaration) {
        problems.push(`events.${d.name}: a pre-publish hook the manifest does not declare (prePublishHooks) was refused`);
        refusedHooks.push(d.name);
        continue;
      }
      // The registration may narrow the declared collections, never widen them.
      const own = names(d.collections);
      const allowed = declaration.collections ?? null;
      const collections = !allowed ? own : !own || own.includes('*') ? allowed : own.filter((c) => allowed.includes(c));
      prePublish.push({
        name: d.name,
        collections,
        timeoutMs: clampLimit(d.timeoutMs, EVENT_LIMITS.prePublishMs),
        check: d.check as PluginPrePublishHook['check'],
      });
    } else {
      problems.push(`events.${d.name}: kind is "subscription" (with handle) or "pre-publish" (with check)`);
    }
  }
  return { subscriptions, prePublish, refusedHooks };
}

// ─── Host ────────────────────────────────────────────────────────────────────

export interface LoadedPlugin {
  row: ExtensionRow;
  siteId: string;
  name: string;
  capabilities: string[];
  module: ExtensionModule;
  storage: PluginStorage;
  jobs: PluginJob[];
  endpoints: PluginEndpoint[];
  subscriptions: PluginSubscription[];
  prePublish: PluginPrePublishHook[];
  /** Pre-publish hooks registered under a name the manifest does not declare: refused, recorded, never run. */
  refusedHooks: string[];
  /** Malformed or refused registrations that were skipped. */
  problems: string[];
}

export interface PluginHostDeps {
  db: Database;
  env?: Record<string, unknown>;
  /** Queue a plugin job run (`ctx.jobs.enqueue`); absent → enqueueing fails. */
  enqueueJob?: (job: { siteId: string; extensionName: string; jobName: string; payload: unknown }) => Promise<void>;
  /** Tests: build the sandbox (e.g. to trust `data:` bundles). */
  createSandbox?: (env: Record<string, unknown>, deps: ExtensionSandboxDeps) => ExtensionSandbox;
}

/** The runtime extension points a plugin's row grants (`ext:<point>`). */
export function grantsPoint(row: Pick<ExtensionRow, 'capabilities'>, point: ExtensionPoint): boolean {
  return ((row.capabilities as string[]) ?? []).includes(`ext:${point}`);
}

/** The admin declarations of a row's manifest (pages, widgets, settings); an invalid one declares nothing. */
export function adminOf(row: Pick<ExtensionRow, 'manifest'>): ExtensionAdmin {
  const parsed = ExtensionAdminSchema.safeParse((row.manifest as { admin?: unknown } | null)?.admin ?? {});
  return parsed.success ? parsed.data : { pages: [], widgets: [], settings: [] };
}

/** The values of the declared settings on the row's site: the stored value, else the declared default, else null. */
export function settingValuesOf(row: Pick<ExtensionRow, 'manifest' | 'settings'>): Record<string, unknown> {
  const stored = (row.settings as Record<string, unknown> | null) ?? {};
  const out: Record<string, unknown> = {};
  for (const s of adminOf(row).settings) out[s.key] = Object.prototype.hasOwnProperty.call(stored, s.key) ? stored[s.key] : (s.default ?? null);
  return out;
}

/** Whether a row may run at all: enabled and approved. */
export function isRunnable(row: Pick<ExtensionRow, 'enabled' | 'permissionsStatus'>): boolean {
  return row.enabled && row.permissionsStatus === 'approved';
}

export class PluginHost {
  private readonly cache = new Map<string, Promise<LoadedPlugin | null>>();

  constructor(readonly deps: PluginHostDeps) {}

  private get env(): Record<string, unknown> {
    return this.deps.env ?? (process.env as Record<string, unknown>);
  }

  /** Enabled, approved plugins of the site holding `ext:<point>` (all runnable plugins when `point` is omitted). */
  async enabledRows(siteId: string, point?: ExtensionPoint): Promise<ExtensionRow[]> {
    return this.deps.db
      .select()
      .from(extensions)
      .where(
        and(
          eq(extensions.siteId, siteId),
          eq(extensions.enabled, true),
          eq(extensions.permissionsStatus, 'approved'),
          point ? sql`${extensions.capabilities} @> ${JSON.stringify([`ext:${point}`])}::jsonb` : undefined,
        ),
      );
  }

  /** The current row of one plugin on a site (any state). */
  async row(siteId: string, name: string): Promise<ExtensionRow | null> {
    const [row] = await this.deps.db
      .select()
      .from(extensions)
      .where(and(eq(extensions.siteId, siteId), eq(extensions.name, name)))
      .limit(1);
    return row ?? null;
  }

  /** Loaded plugins of the site for a point. */
  async loadAll(siteId: string, point: ExtensionPoint): Promise<LoadedPlugin[]> {
    const out: LoadedPlugin[] = [];
    for (const row of await this.enabledRows(siteId, point)) {
      const loaded = await this.load(row);
      if (loaded) out.push(loaded);
    }
    return out;
  }

  /** Load (cached per site, plugin version, bundle and grant) a runnable plugin; null when it is not or fails. */
  load(row: ExtensionRow): Promise<LoadedPlugin | null> {
    if (!row.siteId || !isRunnable(row)) return Promise.resolve(null);
    const caps = ((row.capabilities as string[]) ?? []).slice().sort();
    const key = [row.siteId, row.name, row.version, row.bundleUrl, row.bundleSha256 ?? '', caps.join(','), JSON.stringify(row.manifest ?? {})].join('|');
    let entry = this.cache.get(key);
    if (!entry) {
      entry = this.doLoad(row, row.siteId, caps).catch(() => null);
      this.cache.set(key, entry);
      // A failed load is tried again next time.
      void entry.then((v) => {
        if (!v) this.cache.delete(key);
      });
    }
    return entry;
  }

  /** Forget every loaded plugin (after an upgrade, in tests). */
  clear(): void {
    this.cache.clear();
  }

  /** The private storage of a plugin on a site (its manifest's declared namespaces). */
  storageOf(row: Pick<ExtensionRow, 'name' | 'manifest'>, siteId: string): PluginStorage {
    return new PluginStorage(this.deps.db, siteId, row.name, declaredStorageOf(row.manifest));
  }

  private actor(siteId: string): ExtensionActorDataAccess {
    const svc = () =>
      itemServiceForSystem(
        { db: this.deps.db, siteId, suppressExtensionHooks: true, provenance: { authorType: 'integration', sources: [{ type: 'plugin' }] } },
        'plugin-runtime',
      );
    return {
      list: (c, p) => svc().list(c, p as never),
      detail: (c, id, f) => svc().detail(c, id, f),
      create: (c, payload) => svc().create(c, payload),
      patch: (c, id, patch) => svc().patch(c, id, patch as never),
      delete: (c, id) => svc().softDelete(c, id),
    };
  }

  private async doLoad(row: ExtensionRow, siteId: string, capabilities: string[]): Promise<LoadedPlugin | null> {
    const storage = this.storageOf(row, siteId);
    const db = this.deps.db;
    const enqueue = this.deps.enqueueJob;
    const sandboxDeps: ExtensionSandboxDeps = {
      actorDataAccess: this.actor(siteId),
      storage: { namespaces: storage.namespaces, open: (ns) => storage.collection(ns) },
      // Read on every call: a change saved in the admin panel applies to the next run without reloading the plugin.
      settings: async () => {
        const [current] = await db
          .select({ manifest: extensions.manifest, settings: extensions.settings })
          .from(extensions)
          .where(and(eq(extensions.siteId, siteId), eq(extensions.id, row.id)))
          .limit(1);
        return settingValuesOf(current ?? row);
      },
      jobs: {
        enqueue: async (jobName, payload) => {
          if (!enqueue) throw new Error('Queued plugin jobs are not available in this process.');
          await enqueue({ siteId, extensionName: row.name, jobName, payload });
        },
      },
      onDenied: async (event) => {
        await new AuditLogger({ db, siteId }).write({
          event: 'extension_capability_denied',
          actorEmail: null,
          ip: null,
          userAgent: null,
          requestId: null,
          metadata: { extensionName: event.extensionName, capability: event.capability, operation: event.operation, siteId },
        });
      },
    };
    const sandbox = this.deps.createSandbox ? this.deps.createSandbox(this.env, sandboxDeps) : new ExtensionSandbox(this.env as never, sandboxDeps);
    const module = await sandbox.load({
      name: row.name,
      bundleUrl: row.bundleUrl,
      capabilities,
      ...buildSandboxVerifyOptions(row, db, this.env as unknown as Bindings),
    });
    if (!module) return null;
    const reg = module.registrations ?? new Map<ExtensionPoint, readonly unknown[]>();
    const problems: string[] = [];
    const events = readEvents(reg.get('events') ?? [], prePublishHooksOf(row.manifest), problems);
    const loaded: LoadedPlugin = {
      row,
      siteId,
      name: row.name,
      capabilities,
      module,
      storage,
      jobs: readJobs(reg.get('jobs') ?? [], problems),
      endpoints: readEndpoints(reg.get('endpoints') ?? [], problems),
      subscriptions: events.subscriptions,
      prePublish: events.prePublish,
      refusedHooks: events.refusedHooks,
      problems,
    };
    if (problems.length) console.warn(`[plugins] "${row.name}" on ${siteId}: ${problems.join('; ')}`);
    // An undeclared pre-publish hook is a refused registration, recorded like any other (spec extensions/permissions).
    for (const hook of events.refusedHooks) {
      await sandboxDeps.onDenied?.({ extensionName: row.name, capability: `prePublishHooks:${hook}`, operation: 'register:pre-publish' });
    }
    return loaded;
  }
}
