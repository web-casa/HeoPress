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
 *  - `items:publish:<collection>`           — setting `published` / `scheduled`; writing never implies it
 *  - `media:read|write`                     — the media library (when the host provides it)
 *  - `secrets:<name>`                       — one named secret (when the host provides a resolver)
 *  - `kv:read|write`                        — the plugin key-value store
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
  type ExtensionPoint,
} from '@heopress/contracts/extensions';
import { validateOutboundUrl } from '../services/ssrf-guard';
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
      const mod = await this.importWithTimeout(opts.bundleUrl, opts.timeoutMs ?? 5000);

      // The extension's default export must be a factory that receives ctx.
      const loaded = (typeof mod.default === 'function' ? await mod.default(ctx) : mod) as ExtensionModule | null;
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
          return actor().patch(collection, id, patch);
        },
        delete: async (collection: string, id: string) => {
          gateItems('write', collection, 'items.delete');
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

    const trustedOrigins = String(
      this.env.EXTENSION_BUNDLE_ORIGINS ??
        (typeof process !== 'undefined' ? process.env.EXTENSION_BUNDLE_ORIGINS : '') ??
        '',
    )
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean);

    if (trustedOrigins.length === 0) {
      return false;
    }

    return trustedOrigins.includes(parsed.origin);
  }

  private importWithTimeout(url: string, timeoutMs: number): Promise<Record<string, unknown>> {
    const bundleGuard = validateExtensionBundleUrl(url);
    if (!bundleGuard.allowed) {
      return Promise.reject(new SandboxLoadError(url, bundleGuard.reason));
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new SandboxLoadError(url, `load timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );

      // Dynamic import — works in both Workers (from R2/CDN URL) and browsers.
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      import(/* @vite-ignore */ url)
        .then((mod) => {
          clearTimeout(timer);
          resolve(mod as Record<string, unknown>);
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(new SandboxLoadError(url, err));
        });
    });
  }
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
