/**
 * Plugin content-event subscriptions and pre-publish hooks (HeoPress P12 task 3.4, spec extensions/runtime-extensions
 * "内容事件订阅与发布前钩子").
 *
 * **Subscriptions** are consumers of the event consumption framework (P04, operated in Studio since P11): each has its
 * own position (`plugin:<site>:<plugin>:<subscription>`), at-least-once delivery with an idempotency key, retries and a
 * dead letter. A disabled plugin's consumer is simply not run — its position stays, and once enabled again it continues
 * with the events of the time it was off. A plugin sees the events of collections it holds `cdc:subscribe:<collection>`
 * for, as references (ids, operation, changed fields), never the item's data: it reads items through its own
 * `items:read` capabilities.
 *
 * **Pre-publish hooks** can only refuse a publish. Each gets a frozen copy of the item as it would be published and
 * answers nothing (fine) or `{ veto: "<reason>" }`. Anything else — an attempt to change the item, an answer carrying
 * data, an error, running out of time — is a veto too, recorded with what happened. A plugin that wants to change content
 * writes it through the normal path afterwards, as a new version.
 *
 * A plugin declares its hooks in its manifest (`prePublishHooks`, maintainer decision 2026-10-28) and they fail closed:
 * while an enabled plugin that declares hooks cannot be asked — its bundle does not load, or it did not register a
 * declared hook — the publishes those hooks look at are refused until it is fixed or disabled. A plugin that declares no
 * hook is never loaded here and never blocks a publish (an event subscriber that fails to load only misses events, which
 * its cursor keeps); a hook it registers anyway is refused at load (`plugin-host.ts`).
 */
import { and, eq, sql } from 'drizzle-orm';
import { extensions, sites, type Database } from '@heopress/database';
import { EVENT_LIMITS, prePublishHookCovers, prePublishHooksOf } from '@heopress/contracts/extensions';
import { formatSafeError } from '@heopress/contracts/utils';
import type { ChangeEvent, EventConsumerDefinition } from '../../modules/events/consumer-runner';
import { AuditLogger } from '../../modules/audit/logger';
import { ItemServiceError } from '../../services/item-service-error';
import { parseCdcSubscribeCapabilities } from '../../modules/cdc/change-feed/extension-sender';
import { RunLimitError, withRunScope } from './run-scope';
import type { LoadedPlugin, PluginEvent, PluginHost, PrePublishSubject } from './plugin-host';

/** The consumer name of a plugin subscription on a site. */
function pluginConsumerName(siteId: string, plugin: string, subscription: string): string {
  return `plugin:${siteId}:${plugin}:${subscription}`;
}

function toPluginEvent(e: ChangeEvent): PluginEvent {
  return {
    id: e.id,
    siteId: e.siteId,
    collection: e.collection,
    itemId: e.itemId,
    operation: e.operation,
    changedFields: e.changedFields,
    itemVersion: e.itemVersion,
    occurredAt: e.occurredAt.toISOString(),
  };
}

/** The consumers of one loaded plugin's subscriptions. */
export function consumersOf(plugin: LoadedPlugin): EventConsumerDefinition[] {
  const allowed = parseCdcSubscribeCapabilities(plugin.capabilities);
  if (allowed === null) return [];
  return plugin.subscriptions.map((sub) => ({
    name: pluginConsumerName(plugin.siteId, plugin.name, sub.name),
    siteId: plugin.siteId,
    startFrom: sub.startFrom,
    maxAttempts: EVENT_LIMITS.maxAttempts,
    accepts: (event) =>
      event.resource === 'item' &&
      event.siteId === plugin.siteId &&
      sub.collections.some((c) => c === '*' || c === event.collection) &&
      (allowed === '*' || allowed.has(event.collection)) &&
      (!sub.operations || sub.operations.includes(event.operation)),
    async handle(event, ctx) {
      await withRunScope(
        { durationMs: sub.durationMs, maxRequests: sub.maxRequests, label: `subscription ${plugin.name}/${sub.name}` },
        (scope) => sub.handle(toPluginEvent(event), { siteId: plugin.siteId, idempotencyKey: ctx.idempotencyKey, attempt: ctx.attempt, signal: scope.signal }),
      );
    },
  }));
}

/** Every plugin subscription of every site, as event consumers (the worker asks again now and then). */
async function pluginEventConsumers(db: Database, host: PluginHost): Promise<EventConsumerDefinition[]> {
  const out: EventConsumerDefinition[] = [];
  const siteIds = await db
    .selectDistinct({ id: sites.id })
    .from(sites)
    .innerJoin(extensions, eq(extensions.siteId, sites.id))
    .where(and(eq(extensions.enabled, true), sql`${extensions.capabilities} @> '["ext:events"]'::jsonb`));
  for (const { id } of siteIds) {
    for (const plugin of await host.loadAll(id, 'events')) {
      try {
        out.push(...consumersOf(plugin));
      } catch (err) {
        console.error(`[plugin-events] ${plugin.name} on ${id}`, formatSafeError(err));
      }
    }
  }
  return out;
}

/** A cached view of `pluginEventConsumers` for the 1 s consumer tick. */
export function cachedPluginConsumers(db: Database, host: PluginHost, ttlMs = 15_000): () => Promise<EventConsumerDefinition[]> {
  let at = 0;
  let value: EventConsumerDefinition[] = [];
  let pending: Promise<EventConsumerDefinition[]> | null = null;
  return async () => {
    if (Date.now() - at < ttlMs) return value;
    pending ??= pluginEventConsumers(db, host)
      .then((v) => {
        value = v;
        at = Date.now();
        return v;
      })
      .catch(() => value)
      .finally(() => {
        pending = null;
      });
    return pending;
  };
}

// ─── Pre-publish hooks ───────────────────────────────────────────────────────

interface PrePublishVeto {
  extension: string;
  hook: string;
  /**
   * `veto`: the hook refused; `modified`: it tried to change the content; `timeout`; `error`; `load-failed`: the plugin
   * declares hooks but could not be loaded, so they could not be asked; `not-registered`: the loaded plugin did not
   * register a hook it declares (both fail closed).
   */
  kind: 'veto' | 'modified' | 'timeout' | 'error' | 'load-failed' | 'not-registered';
  reason: string;
}

class PrePublishVetoError extends ItemServiceError {
  constructor(readonly vetoes: PrePublishVeto[]) {
    super('PUBLISH_VETOED', `Publishing was refused by a plugin: ${vetoes.map((v) => `${v.extension}: ${v.reason}`).join('; ')}`, 409);
    this.name = 'PrePublishVetoError';
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

/** What a hook's answer means: fine, or a veto (a refusal, or anything that is not a plain answer). */
function judge(answer: unknown): { ok: true } | { ok: false; kind: 'veto' | 'modified'; reason: string } {
  if (answer === undefined || answer === null || answer === true) return { ok: true };
  if (typeof answer === 'object' && !Array.isArray(answer)) {
    const keys = Object.keys(answer as object);
    const veto = (answer as { veto?: unknown }).veto;
    if (keys.every((k) => k === 'veto') && (veto === undefined || veto === false || veto === null)) return { ok: true };
    if (keys.every((k) => k === 'veto') && typeof veto === 'string' && veto.trim()) return { ok: false, kind: 'veto', reason: veto.trim().slice(0, 500) };
    return { ok: false, kind: 'modified', reason: 'a pre-publish hook may only veto; it answered with content' };
  }
  return { ok: false, kind: 'modified', reason: 'a pre-publish hook may only veto; it answered with content' };
}

export interface PrePublishDeps {
  db: Database;
  host: PluginHost;
  siteId: string;
  actorEmail?: string | null;
}

/**
 * Run the site's pre-publish hooks for the collection; throws PrePublishVetoError (409) with every veto when any hook
 * refuses. Called before the publish transaction, never inside it. Vetoes are recorded in the audit log.
 *
 * Only the enabled plugins with `ext:events` that declare a hook covering the collection take part (and are loaded).
 */
export async function runPrePublishHooks(deps: PrePublishDeps, subject: PrePublishSubject): Promise<void> {
  const rows = (await deps.host.enabledRows(deps.siteId, 'events')).filter((row) =>
    prePublishHooksOf(row.manifest).some((h) => prePublishHookCovers(h, subject.collection)),
  );
  if (rows.length === 0) return;
  const vetoes: PrePublishVeto[] = [];
  for (const row of rows) {
    const declared = prePublishHooksOf(row.manifest).filter((h) => prePublishHookCovers(h, subject.collection));
    const plugin = await deps.host.load(row);
    if (!plugin) {
      // Fail closed (maintainer decisions 2026-10-28): a plugin that declares hooks on this collection but whose bundle
      // does not load cannot be asked — the publish is refused until it is fixed or disabled.
      vetoes.push({ extension: row.name, hook: declared.map((h) => h.name).join(','), kind: 'load-failed', reason: `plugin ${row.name} failed to load; disable or fix it to publish` });
      continue;
    }
    for (const missing of declared.filter((h) => !plugin.prePublish.some((p) => p.name === h.name))) {
      vetoes.push({ extension: row.name, hook: missing.name, kind: 'not-registered', reason: `plugin ${row.name} did not register its declared pre-publish hook "${missing.name}"; disable or fix it to publish` });
    }
    for (const hook of plugin.prePublish) {
      if (hook.collections && !hook.collections.includes(subject.collection) && !hook.collections.includes('*')) continue;
      const snapshot = deepFreeze(structuredClone(subject));
      try {
        const { value } = await withRunScope(
          { durationMs: hook.timeoutMs, maxRequests: EVENT_LIMITS.requests.default, label: `pre-publish hook ${plugin.name}/${hook.name}` },
          () => hook.check(snapshot),
        );
        const verdict = judge(value);
        if (!verdict.ok) vetoes.push({ extension: plugin.name, hook: hook.name, kind: verdict.kind, reason: verdict.reason });
      } catch (err) {
        if (err instanceof RunLimitError && err.reason === 'timeout') {
          vetoes.push({ extension: plugin.name, hook: hook.name, kind: 'timeout', reason: `did not answer within ${hook.timeoutMs} ms` });
        } else if (err instanceof TypeError && /read.only|frozen|not extensible|Cannot (assign|add|delete|define)/i.test(err.message)) {
          vetoes.push({ extension: plugin.name, hook: hook.name, kind: 'modified', reason: 'a pre-publish hook may only veto; it tried to change the content' });
        } else {
          vetoes.push({ extension: plugin.name, hook: hook.name, kind: 'error', reason: `the hook failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 300)}` });
        }
      }
    }
  }
  if (vetoes.length === 0) return;
  const audit = new AuditLogger({ db: deps.db, siteId: deps.siteId });
  for (const v of vetoes) {
    await audit
      .write({
        event: 'extension_prepublish_veto',
        actorEmail: deps.actorEmail ?? null,
        ip: null,
        userAgent: null,
        requestId: null,
        metadata: { siteId: deps.siteId, extensionName: v.extension, hook: v.hook, kind: v.kind, reason: v.reason, collection: subject.collection, itemId: subject.itemId },
      })
      .catch(() => {});
  }
  throw new PrePublishVetoError(vetoes);
}
