// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
/**
 * Agent notification broadcaster (push-noti feature).
 *
 * The single fan-out point for operational events a human operator wants to
 * hear about: HITL approvals, L3 veto windows, agent incidents and goal/run
 * status changes. Producers call {@link emitAgentNotification} after their DB
 * write commits.
 *
 * HeoPress P02 removed both upstream transports: the in-app frame went through
 * the Cloudflare SiteRoom Durable Object (task 2.1) and Web Push needed VAPID
 * keys and `push_subscriptions` (task 4.3). Until P10 adds a Node in-app
 * channel, emitting is a no-op and Studio's 60 s Mission Control inbox poll is
 * how operators see these events — nothing is lost, only delayed.
 */

import type { Database } from '@heopress/database';

/** The operational event classes that produce a notification. */
export type AgentNotificationKind = 'approval' | 'veto' | 'incident' | 'goal' | 'run' | 'test';

export type AgentNotificationSeverity = 'info' | 'warning' | 'critical';

/**
 * Wire shape delivered to clients (in-app frame `notification` field, and the
 * Web Push JSON body). Kept flat and JSON-serialisable so the service worker
 * and the Studio panel can consume it without translation.
 */
export interface AgentNotification {
  /** Stable id for client-side dedupe across the two transports. */
  id: string;
  kind: AgentNotificationKind;
  severity: AgentNotificationSeverity;
  title: string;
  body: string;
  /** Admin-relative deep link, e.g. `/mission-control/inbox?entry=approval:<id>`. */
  deepLink?: string;
  /** Source entity id (approval/incident/goal/run id) for client dedupe. */
  entityId: string;
  /** ISO-8601 UTC timestamp of when the event was emitted. */
  ts: string;
}

/** What a producer supplies; `id`/`ts` are filled in by the broadcaster. */
export type AgentNotificationInput = Omit<AgentNotification, 'id' | 'ts'>;

export interface EmitNotificationDeps {
  db: Database;
  siteId: string;
  /** Loose env bag kept for the P10 in-app channel. */
  env?: Record<string, string | undefined>;
}

/** A bound notifier callback threaded into services that only hold `db`+`siteId`. */
export type AgentNotifier = (input: AgentNotificationInput) => void;

function randomId(): string {
  // crypto.randomUUID is available on Workers and Node 18+.
  try {
    return crypto.randomUUID();
  } catch {
    return `n_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }
}

/**
 * Stamp and deliver one notification. Fire-and-forget friendly: callers may
 * `void emitAgentNotification(...)`; never rejects. No transport until P10.
 */
export async function emitAgentNotification(
  deps: EmitNotificationDeps,
  input: AgentNotificationInput,
): Promise<void> {
  const notification: AgentNotification = {
    ...input,
    id: randomId(),
    ts: new Date().toISOString(),
  };

  // No transport until P10 (see the module comment).
  void deps;
  void notification;
}
