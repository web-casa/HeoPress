// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
/**
 * ExtensionSandbox — isolated execution environment for CMS extensions.
 *
 * Loads an extension bundle from a trusted origin and hands it a capability-checked context. Only the
 * capabilities an admin approved (the row's `capabilities`, HeoPress P12 extensions/permissions) are usable;
 * everything else is refused with a CapabilityError and recorded through `onDenied`:
 *
 *  - `http:fetch:<host>`                    — outbound HTTP to that host only (SSRF boundary still applies)
 *  - `items:read|write:<collection>`        — actor-scoped item access through the host ItemService
 *  - `items:publish:<collection>`           — setting `published` / `scheduled`, and changing or deleting an item
 *                                             that is published or scheduled; writing never implies it
 *  - `media:read|write`                     — the media library (when the host provides it)
 *  - `secrets:<name>`                       — one named secret (when the host provides a resolver)
 *  - `kv:read|write`                        — the plugin key-value store
 *  - `ai:generate`                          — model calls through the site's model gateway (per-call ledger, site
 *                                             budget); the plugin never sees a provider key
 *  - `ext:<extension point>`                — registering on an extension point; an exported `hooks` /
 *                                             `handler` / `cdcSubscriber` / `ui` needs `ext:events` /
 *                                             `ext:endpoints` / `ext:events` / `ext:admin-panels`
 *
 * There is no raw database, environment or host-file access, for official plugins as for any other.
 *
 * Usage:
 *   const sandbox = new ExtensionSandbox(env, { actorDataAccess, onDenied });
 *   const ext = await sandbox.load({ bundleUrl, capabilities, name });
 */

import { outboundFetch } from '@heopress/runtime/node';
import {
  EXTENSION_POINTS,
  PUBLISH_STATUSES,
  allowsCollection,
  allowsHost,
  declaresExtensionPoint,
  sha256Hex,
  type ExtensionPoint,
} from '@heopress/contracts/extensions';
import { validateOutboundUrl } from '../services/ssrf-guard';
import { VersionConflictError } from '../services/item-service-error';
import { currentRunScope } from './runtime/run-scope';
import { formatSafeError } from '@heopress/contracts/utils';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ExtensionCapability =
  | `http:fetch:${string}`
  | `items:read:${string}`
  | `items:write:${string}`
  | `items:publish:${string}`
  | 'media:read'
  | 'media:write'
  | `secrets:${string}`
  | 'kv:read'
  | 'kv:write'
  | 'ai:generate'
  | `ext:${ExtensionPoint}`;

export interface ExtensionHookContext {
  collection: string;
  item?: Record<string, unknown>;
  patch?: Record<string, unknown>;
  itemId?: string;
  userId?: string | null;
  siteId?: string;
}

export type HookFn = (ctx: ExtensionHookContext) => Promise<void | Record<string, unknown>>;

export interface ExtensionActorDataAccess {
  list: (collection: string, params?: Record<string, unknown>) => Promise<unknown>;
  detail: (collection: string, id: string, fields?: string[]) => Promise<unknown>;
  create: (collection: string, payload: { data: Record<string, unknown>; status?: string; sort?: number }) => Promise<unknown>;
  /** `expectedVersion`: the item version the change is based on (required since P04). */
  patch: (
    collection: string,
    id: string,
    patch: { data?: Record<string, unknown>; status?: string; sort?: number; expectedVersion?: number },
  ) => Promise<unknown>;
  delete: (collection: string, id: string) => Promise<unknown>;
}

/** Media library access the host may lend a plugin (`media:read` / `media:write`). */
interface ExtensionMediaAccess {
  list: (params?: Record<string, unknown>) => Promise<unknown>;
  detail: (id: string) => Promise<unknown>;
  upload: (file: { filename: string; contentType: string; data: Uint8Array }) => Promise<unknown>;
}

/** A model call a plugin asks for (`ai:generate`, HeoPress P12 task 4.4): text in, text out — no tools, no keys. */
interface ExtensionAiRequest {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  system?: string;
  maxOutputTokens?: number;
  /** A stable identity for replay (the same key returns the recorded answer, billed once). */
  key?: string;
  signal?: AbortSignal;
}

interface ExtensionAiResponse {
  content: string;
  usage?: { inputTokens: number | null; outputTokens: number | null };
  /** The ledger call id (for the plugin's own records). */
  callId: string;
}

/** The host's model access for one plugin on one site (absent → `ai.generate` is unavailable). */
export type ExtensionAiAccess = (extensionName: string, request: ExtensionAiRequest) => Promise<ExtensionAiResponse>;

/** A refused capability use, recorded by the host (never contains secret values). */
export interface CapabilityDeniedEvent {
  extensionName: string;
  capability: string;
  /** What was attempted, e.g. `fetch`, `items.patch`, `register`. */
  operation: string;
}

export interface ExtensionSandboxDeps {
  /** Actor-scoped item access (the request principal's permissions, Hold and gates apply). */
  actorDataAccess?: ExtensionActorDataAccess;
  mediaAccess?: ExtensionMediaAccess;
  /** Resolves a named plugin secret; absent → `secrets.get` is unavailable. */
  secrets?: (extensionName: string, name: string) => Promise<string | null>;
  /** Model calls through the site's gateway (`ai:generate`); absent → `ai.generate` is unavailable. */
  ai?: ExtensionAiAccess;
  /** Records a refused capability use (in addition to the console warning). */
  onDenied?: (event: CapabilityDeniedEvent) => void | Promise<void>;
  /**
   * The plugin's private storage (P12 task 3.7): the namespaces its manifest declares and how to open one, bound to the
   * site and the plugin by the host. Absent → `storage` is unavailable.
   */
  storage?: { namespaces: readonly string[]; open: (namespace: string) => unknown };
  /** The values of the plugin's declared settings on this site (P12 task 3.6). Absent → `settings` is unavailable. */
  settings?: () => Promise<Record<string, unknown>>;
  /** Queue a run of one of the plugin's jobs (P12 task 3.1, needs `ext:jobs`). */
  jobs?: { enqueue: (jobName: string, payload: unknown) => Promise<void> };
}

export interface ExtensionModule {
  /** Lifecycle hooks for item mutations. */
  hooks?: Partial<{
    'items.create.before': HookFn;
    'items.create.after': HookFn;
    'items.update.before': HookFn;
    'items.update.after': HookFn;
    'items.delete.before': HookFn;
    'items.delete.after': HookFn;
  }>;
  /** Endpoint handler — called when a request hits /extensions/:name/* */
  handler?: (app: unknown) => void;
  /** Interface / Display / Layout / Panel for Studio */
  ui?: {
    component?: unknown; // React component
    type?: 'interface' | 'display' | 'layout' | 'panel' | 'module';
  };
  /** Change-feed consumer (`defineCdcSubscriber`). */
  cdcSubscriber?: unknown;
  /** What the plugin registered through `ctx.extensionPoints.register` (declared points only). */
  registrations?: ReadonlyMap<ExtensionPoint, readonly unknown[]>;
}

/** Module exports and the extension point each one needs. */
const EXPORT_POINTS: ReadonlyArray<[keyof ExtensionModule, ExtensionPoint]> = [
  ['hooks', 'events'],
  ['cdcSubscriber', 'events'],
  ['handler', 'endpoints'],
  ['ui', 'admin-panels'],
];

export class CapabilityError extends Error {
  constructor(capability: string) {
    super(`Extension does not have capability: "${capability}"`);
    this.name = 'CapabilityError';
  }
}

export class SandboxLoadError extends Error {
  constructor(bundleUrl: string, cause?: unknown) {
    super(`Failed to load extension from "${bundleUrl}": ${String(cause)}`);
    this.name = 'SandboxLoadError';
  }
}

/**
 * Signature-verification gate for the load path. Returns whether the bundle is
 * trusted; the caller (route) supplies this so the sandbox stays free of DB and
 * `@heopress/contracts/extensions` imports. Resolves `true` to allow load.
 */
export type SandboxVerify = () => Promise<boolean>;

interface SandboxLoadOptions {
  /** Extension identifier (for logging). */
  name: string;
  /** URL to the extension ESM bundle. */
  bundleUrl: string;
  /** Declared capabilities from the manifest. */
  capabilities: string[];
  /** Timeout in ms before the load is aborted. Default: 5000. */
  timeoutMs?: number;
  /** Server-derived official flag — official extensions MUST verify (fail-closed). */
  isOfficial?: boolean;
  /** Force signature verification even for third-party (site policy). */
  requireSignature?: boolean;
  /**
   * Verifier invoked when `isOfficial || requireSignature`. Must return true to
   * allow the load. If required but not supplied, the load fails closed.
   */
  verify?: SandboxVerify;
  /**
   * The digest the signature covers (hex SHA-256). On a signature-gated load the bytes that run must be these bytes:
   * the verifier and the loader fetch the bundle separately, and a server could answer them differently.
   */
  bundleSha256?: string | null;
}

/** Largest bundle the sandbox downloads (the glossary plugin is ~10 KB). */
const MAX_BUNDLE_BYTES = 5 * 1024 * 1024;

/**
 * The bundle origins the operator trusts (`EXTENSION_BUNDLE_ORIGINS`, comma-separated). Without any, no remote bundle
 * loads. Shared with the signature verifier, which downloads from the same origins.
 */
export function trustedBundleOrigins(env?: Record<string, unknown>): string[] {
  return String(env?.EXTENSION_BUNDLE_ORIGINS ?? (typeof process !== 'undefined' ? process.env.EXTENSION_BUNDLE_ORIGINS : '') ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

/**
 * Download a remote bundle from a trusted bundle origin through the outbound boundary. The origin is an operator's
 * configuration, so it is a service connection: an internal bundle server is reachable only when its exact origin is
 * also listed in `HEOPRESS_TRUSTED_INTERNAL_ENDPOINTS` (ADR-0014); a redirect to another origin is checked as usual.
 */
export async function fetchBundle(url: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Uint8Array> {
  const res = await outboundFetch(url, {
    purpose: 'service',
    maxResponseBytes: MAX_BUNDLE_BYTES,
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (!res.ok) throw new Error(`bundle download answered ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Key-value store exposed to extensions as `kv`. Upstream bound a Cloudflare KV
 * namespace here; on Node nothing is bound yet, so `kv` reads return null and
 * writes are dropped (extension storage is redesigned with the P12 extension
 * points).
 */
interface ExtensionKvStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

interface SandboxEnv {
  /** Optional key-value store for extension `kv` (not bound on Node). */
  CONFIG_CACHE?: ExtensionKvStore;
  /**
   * Comma-separated list of trusted extension bundle origins. Extension
   * execution is disabled unless this allowlist is explicitly configured.
   */
  EXTENSION_BUNDLE_ORIGINS?: string;
  [key: string]: unknown;
}

// ─── Sandbox ─────────────────────────────────────────────────────────────────

export class ExtensionSandbox {
  private readonly cache = new Map<string, ExtensionModule>();

  constructor(
    private readonly env: SandboxEnv,
    private readonly deps: ExtensionSandboxDeps = {},
  ) {}

  private get actorDataAccess() {
    return this.deps.actorDataAccess;
  }

  /**
   * Load and cache an extension module.
   * Returns null if the bundle cannot be loaded (error is logged).
   */
  async load(opts: SandboxLoadOptions): Promise<ExtensionModule | null> {
    if (this.cache.has(opts.name)) {
      return this.cache.get(opts.name)!;
    }

    if (!this.isTrustedBundleUrl(opts.bundleUrl)) {
      console.error(
        `[extension-sandbox] refused to load "${opts.name}" from an untrusted bundle URL`,
      );
      return null;
    }

    // Signature gate (fail-closed for official / when signature is required).
    // Runs BEFORE import + cache so an unverifiable official bundle never
    // executes and is never cached. A missing verifier when one is required is
    // treated as a failure, not a bypass.
    if (opts.isOfficial || opts.requireSignature) {
      const ok = opts.verify ? await opts.verify() : false;
      if (!ok) {
        console.error(
          `[extension-sandbox] refused to load "${opts.name}": signature verification failed (official=${Boolean(
            opts.isOfficial,
          )})`,
        );
        return null;
      }
    }

    const caps = new Set(opts.capabilities);
    const registrations = new Map<ExtensionPoint, unknown[]>();

    // Build capability-checked proxy context passed to the extension.
    const ctx = this.buildCtx(caps, opts.name, registrations);

    try {
      const timeoutMs = opts.timeoutMs ?? 5000;
      const expectedSha256 = opts.isOfficial || opts.requireSignature ? (opts.bundleSha256 ?? null) : null;
      const mod = await this.importWithTimeout(opts.bundleUrl, timeoutMs, expectedSha256);

      // The extension's default export must be a factory that receives ctx. The load limit covers the factory too: a
      // factory that never settles must not hang the host path that loads it (a job tick across every site, a publish,
      // a gate run, a source run) — HeoPress P12 task 9.1.
      const loaded = (typeof mod.default === 'function'
        ? await settleWithin(Promise.resolve().then(() => (mod.default as (c: unknown) => unknown)(ctx)), timeoutMs, `the factory did not finish within ${timeoutMs} ms`)
        : mod) as ExtensionModule | null;
      const extensionMod: ExtensionModule = { ...(loaded ?? {}) };
      // An export on an undeclared extension point is dropped and recorded; the rest of the plugin still loads.
      for (const [key, point] of EXPORT_POINTS) {
        if (extensionMod[key] !== undefined && !declaresExtensionPoint(caps, point)) {
          delete extensionMod[key];
          this.denied({ extensionName: opts.name, capability: `ext:${point}`, operation: `export:${key}` });
        }
      }
      extensionMod.registrations = registrations;

      this.cache.set(opts.name, extensionMod);
      return extensionMod;
    } catch (err) {
      console.error(`[extension-sandbox] failed to load "${opts.name}"`, formatSafeError(err));
      return null;
    }
  }

  /** Evict an extension from the cache (e.g. after update). */
  evict(name: string): void {
    this.cache.delete(name);
  }

  /** Evict all cached extensions. */
  evictAll(): void {
    this.cache.clear();
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private denied(event: CapabilityDeniedEvent): void {
    console.warn(
      `[extension-sandbox] denied "${event.capability}" to "${event.extensionName}" (${event.operation})`,
    );
    try {
      void Promise.resolve(this.deps.onDenied?.(event)).catch(() => undefined);
    } catch {
      /* recording a denial never breaks the plugin call */
    }
  }

  private buildCtx(caps: Set<string>, name: string, registrations: Map<ExtensionPoint, unknown[]>) {
    const refuse = (capability: string, operation: string): never => {
      this.denied({ extensionName: name, capability, operation });
      throw new CapabilityError(capability);
    };
    const gate = (cap: ExtensionCapability, operation: string) => {
      if (!caps.has(cap)) refuse(cap, operation);
    };
    const gateItems = (access: 'read' | 'write' | 'publish', collection: string, operation: string) => {
      if (!allowsCollection(caps, access, collection)) refuse(`items:${access}:${collection}`, operation);
    };
    /** Writing a publish status is a publish: collection write never implies it. */
    const gatePublish = (collection: string, status: unknown, operation: string) => {
      if (typeof status === 'string' && (PUBLISH_STATUSES as readonly string[]).includes(status)) {
        gateItems('publish', collection, operation);
      }
    };
    // Inside a limited run (P12 task 3.2): a stopped, timed-out or over-budget run cannot use the context any more.
    const active = () => currentRunScope()?.assertActive();
    const actor = () => {
      active();
      if (!this.actorDataAccess) throw new Error('Actor data access is not available in this context.');
      return this.actorDataAccess;
    };
    /**
     * Changing or deleting an item that is live (published or scheduled) changes what the site shows or will show: that
     * is a publish too, so it needs `items:publish:<collection>` (P12 task 1.4) — as in the core publish guard, where a
     * content change to a published item is a publish write. A plugin with only `items:write` changes drafts only.
     * The state is read at the version the change is based on: the write applies only at that version (otherwise it
     * is a version conflict), so the item cannot go live between this check and the write.
     */
    const gateLive = async (collection: string, id: string, expectedVersion: number | undefined, operation: string) => {
      if (allowsCollection(caps, 'publish', collection)) return;
      const current = (await actor().detail(collection, id)) as { status?: unknown; version?: unknown } | null | undefined;
      const status = current?.status;
      // An unknown state is treated as live (fail closed).
      if (typeof status !== 'string' || (PUBLISH_STATUSES as readonly string[]).includes(status)) {
        refuse(`items:publish:${collection}`, operation);
      }
      if (expectedVersion !== undefined && typeof current?.version === 'number' && current.version !== expectedVersion) {
        throw new VersionConflictError(current.version, []);
      }
    };
    const media = () => {
      active();
      if (!this.deps.mediaAccess) throw new Error('Media access is not available in this context.');
      return this.deps.mediaAccess;
    };

    return {
      /**
       * Actor-scoped item access. Calls are routed through the host ItemService, so the request principal's
       * row/field/action permissions, the site boundary, Hold and the publish gates all apply on top of the
       * plugin's own `items:<access>:<collection>` capabilities.
       */
      items: {
        list: async (collection: string, params?: Record<string, unknown>) => {
          gateItems('read', collection, 'items.list');
          return actor().list(collection, params);
        },
        detail: async (collection: string, id: string, fields?: string[]) => {
          gateItems('read', collection, 'items.detail');
          return actor().detail(collection, id, fields);
        },
        create: async (collection: string, payload: { data: Record<string, unknown>; status?: string; sort?: number }) => {
          gateItems('write', collection, 'items.create');
          gatePublish(collection, payload?.status, 'items.create');
          return actor().create(collection, payload);
        },
        patch: async (
          collection: string,
          id: string,
          patch: { data?: Record<string, unknown>; status?: string; sort?: number; expectedVersion?: number },
        ) => {
          gateItems('write', collection, 'items.patch');
          gatePublish(collection, patch?.status, 'items.patch');
          await gateLive(collection, id, patch?.expectedVersion, 'items.patch');
          return actor().patch(collection, id, patch);
        },
        delete: async (collection: string, id: string) => {
          gateItems('write', collection, 'items.delete');
          await gateLive(collection, id, undefined, 'items.delete');
          return actor().delete(collection, id);
        },
      },

      /** Media library — read and write guarded separately. */
      media: {
        list: async (params?: Record<string, unknown>) => {
          gate('media:read', 'media.list');
          return media().list(params);
        },
        detail: async (id: string) => {
          gate('media:read', 'media.detail');
          return media().detail(id);
        },
        upload: async (file: { filename: string; contentType: string; data: Uint8Array }) => {
          gate('media:write', 'media.upload');
          return media().upload(file);
        },
      },

      /** Named secrets — only those declared as `secrets:<name>`. */
      secrets: {
        get: async (secretName: string) => {
          gate(`secrets:${secretName}`, 'secrets.get');
          active();
          if (!this.deps.secrets) throw new Error('Plugin secrets are not available in this context.');
          return this.deps.secrets(name, secretName);
        },
      },

      /** Outbound HTTP — only to hosts declared as `http:fetch:<host>`. */
      fetch: async (input: RequestInfo, init?: RequestInit) => {
        const url = requestInfoToUrl(input);
        let host: string;
        try {
          host = new URL(url).hostname.toLowerCase();
        } catch {
          throw new Error('Outbound URL is invalid.');
        }
        if (!allowsHost(caps, host)) refuse(`http:fetch:${host}`, 'fetch');
        const guarded = validateOutboundUrl(url);
        if (!guarded.allowed) {
          throw new Error(guarded.reason ?? 'Outbound URL is not allowed.');
        }
        // A limited run counts the request against its budget and aborts it when the run ends (P12 task 3.2).
        const scope = currentRunScope();
        scope?.chargeRequest();
        const signal = scope ? (init?.signal ? AbortSignal.any([init.signal, scope.signal]) : scope.signal) : init?.signal;
        // The full outbound boundary applies (connect-time checks, re-checked redirects, limits).
        return outboundFetch(url, { ...init, ...(signal ? { signal } : {}), purpose: 'user' });
      },

      /**
       * Private storage (P12 task 3.7): only the namespaces the manifest declares, of this plugin on this site. Another
       * plugin's storage cannot be named at all.
       */
      storage: {
        collection: (namespace: string) => {
          active();
          const store = this.deps.storage;
          if (!store) throw new Error('Plugin storage is not available in this context.');
          if (!store.namespaces.includes(namespace)) refuse(`storage:${namespace}`, 'storage.collection');
          return store.open(namespace);
        },
      },

      /** The plugin's own settings on this site, as the operator saved them in its admin panel (P12 task 3.6). */
      settings: {
        all: async (): Promise<Record<string, unknown>> => {
          active();
          if (!this.deps.settings) throw new Error('Plugin settings are not available in this context.');
          return this.deps.settings();
        },
      },

      /** Queue a run of one of the plugin's own jobs (P12 task 3.1). */
      jobs: {
        enqueue: async (jobName: string, payload?: unknown) => {
          gate('ext:jobs', 'jobs.enqueue');
          active();
          if (!this.deps.jobs) throw new Error('Plugin jobs are not available in this context.');
          return this.deps.jobs.enqueue(jobName, payload ?? null);
        },
      },

      /** KV store — read and write guarded separately. */
      kv: {
        get: async (key: string) => {
          gate('kv:read', 'kv.get');
          return this.env.CONFIG_CACHE?.get(key) ?? null;
        },
        put: async (key: string, value: string, opts?: { expirationTtl?: number }) => {
          gate('kv:write', 'kv.put');
          return this.env.CONFIG_CACHE?.put(key, value, opts);
        },
        delete: async (key: string) => {
          gate('kv:write', 'kv.delete');
          return this.env.CONFIG_CACHE?.delete(key);
        },
      },

      /**
       * Runtime registration on an extension point. Refused (and recorded) unless the manifest declares
       * `ext:<point>`; a refusal leaves the plugin's other declared capabilities untouched.
       */
      extensionPoints: {
        register: (point: ExtensionPoint, definition: unknown) => {
          if (!(EXTENSION_POINTS as readonly string[]).includes(point)) {
            throw new Error(`Unknown extension point "${String(point)}".`);
          }
          gate(`ext:${point}`, 'register');
          const list = registrations.get(point) ?? [];
          list.push(definition);
          registrations.set(point, list);
        },
      },

      /** Model calls (`ai:generate`): through the site's gateway, billed per call against the site budget. */
      ai: {
        generate: async (request: ExtensionAiRequest) => {
          gate('ai:generate', 'ai.generate');
          if (!this.deps.ai) throw new Error('Model calls are not available in this context.');
          return this.deps.ai(name, request);
        },
      },

      /** Extension metadata — always available. */
      meta: { name },
    };
  }

  private isTrustedBundleUrl(bundleUrl: string): boolean {
    let parsed: URL;
    try {
      parsed = new URL(bundleUrl);
    } catch {
      return false;
    }

    if (!['https:', 'http:'].includes(parsed.protocol)) {
      return false;
    }

    if (
      parsed.protocol === 'http:' &&
      !['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)
    ) {
      return false;
    }

    const trustedOrigins = trustedBundleOrigins(this.env);

    if (trustedOrigins.length === 0) {
      return false;
    }

    return trustedOrigins.includes(parsed.origin);
  }

  /**
   * Import a bundle within `timeoutMs`. Node's module loader imports only `file:` and `data:` URLs, so a remote bundle
   * (http/https from a trusted origin) is downloaded through the outbound boundary and imported from its bytes
   * (HeoPress P12 task 9.2: before, every remote bundle failed to import in Node, so no plugin ran outside the tests).
   * With `expectedSha256` (a signature-gated load) the bytes must be the signed ones.
   */
  private async importWithTimeout(url: string, timeoutMs: number, expectedSha256: string | null = null): Promise<Record<string, unknown>> {
    const remote = /^https?:/i.test(url);
    if (!remote) {
      const bundleGuard = validateExtensionBundleUrl(url);
      if (!bundleGuard.allowed) throw new SandboxLoadError(url, bundleGuard.reason);
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new SandboxLoadError(url, `load timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    const load = async (): Promise<Record<string, unknown>> => {
      let specifier = url;
      if (remote || expectedSha256) {
        const bytes = remote ? await fetchBundle(url, { timeoutMs, signal: controller.signal }) : dataUrlBytes(url);
        if (!bytes) throw new Error('the bundle has no readable bytes');
        if (expectedSha256 && (await sha256Hex(bytes)) !== expectedSha256.toLowerCase()) {
          throw new Error('the bundle is not the signed bundle (digest mismatch)');
        }
        if (remote) specifier = `data:text/javascript;base64,${Buffer.from(bytes).toString('base64')}`;
      }
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      return (await import(/* @vite-ignore */ specifier)) as Record<string, unknown>;
    };
    try {
      return await Promise.race([
        load().catch((err: unknown) => {
          throw err instanceof SandboxLoadError ? err : new SandboxLoadError(url, err instanceof Error ? err.message : err);
        }),
        limit,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** The bytes of a `data:text/javascript` URL (percent-encoded or base64), or null. */
function dataUrlBytes(url: string): Uint8Array | null {
  const m = /^data:text\/javascript(;charset=[^;,]+)?(;base64)?,(.*)$/is.exec(url);
  if (!m) return null;
  const body = m[3] ?? '';
  return m[2] ? new Uint8Array(Buffer.from(body, 'base64')) : new TextEncoder().encode(decodeURIComponent(body));
}

/** `promise`, or a rejection once `ms` have passed without it settling. */
function settleWithin<T>(promise: Promise<T>, ms: number, reason: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(reason)), ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

function requestInfoToUrl(input: RequestInfo): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function validateExtensionBundleUrl(raw: string): { allowed: boolean; reason?: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { allowed: false, reason: 'Extension bundle URL is invalid.' };
  }

  if (url.protocol === 'data:') {
    return { allowed: url.pathname.startsWith('text/javascript'), reason: 'Only JavaScript data URLs are allowed.' };
  }

  return validateOutboundUrl(raw);
}
