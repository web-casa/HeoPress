// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
/**
 * Agent notification broadcaster (push-noti feature; HeoPress P10 tasks 5.2, 5.6).
 *
 * The single fan-out point for operational events a human operator wants to
 * hear about: HITL approvals, L3 veto windows, agent incidents and goal/run
 * status changes. Producers call {@link emitAgentNotification} after their DB
 * write commits. Two transports:
 *
 *  - in-Studio: one realtime frame on the Node hub, addressed to the site's
 *    agent-notification channel ({@link STUDIO_AGENT_CHANNEL}). Only Studio
 *    sessions of THIS site whose signed ticket grants that channel (site
 *    administrators — the Mission Control inbox is admin-only) receive it; the
 *    hub is keyed by site, so another site's sessions never see it. Wire frame:
 *    `{ type: 'notification', payload: { source: 'agent', notification } }`.
 *  - IM / webhook channels: a delivery row per subscribed channel of the site
 *    (summary + Studio link only), tried at once and retried by the sweep.
 *
 * Studio's 60 s Mission Control poll stays as the fallback for sessions that
 * were offline; a frame makes the inbox refresh at once.
 */

import type { Database } from '@heopress/database';
import type { KeyProvider, RealtimeProvider } from '@heopress/runtime';
import type { NotificationEventKind } from '@heopress/contracts/schemas';
import { formatSafeError } from '@heopress/contracts/utils';
import { runSiteTransaction } from '../../services/rls-transaction';
import { enqueueChannelNotifications, NotificationChannelService } from './channels/channel-service';

/** Realtime channel carrying agent notifications to a site's administrator sessions. */
export const STUDIO_AGENT_CHANNEL = 'studio:agent-notifications';

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
  /** Loose env bag (HEOPRESS_PUBLIC_URL for channel links). */
  env?: Record<string, string | undefined>;
  /** Realtime provider for the in-Studio frame; omitted: no frame. */
  realtime?: RealtimeProvider;
  /** Runtime keys to open channel targets; omitted: deliveries wait for the sweep. */
  keys?: KeyProvider;
}

/** The frame payload delivered to Studio (`payload` of a `notification` wire message). */
interface AgentNotificationFramePayload {
  source: 'agent';
  notification: AgentNotification;
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
 * `void emitAgentNotification(...)`; never rejects.
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

  if (deps.realtime) {
    try {
      const payload: AgentNotificationFramePayload = { source: 'agent', notification };
      await deps.realtime.publish(deps.siteId, {
        type: 'notification',
        plane: 'studio',
        target: { channel: STUDIO_AGENT_CHANNEL },
        payload,
      });
    } catch (err) {
      console.warn('[notify] realtime publish failed', formatSafeError(err));
    }
  }

  if (input.kind === 'test') return;
  try {
    const ids = await runSiteTransaction(deps.db, deps.siteId, (tx) =>
      enqueueChannelNotifications(tx, deps.siteId, {
        event: input.kind as NotificationEventKind,
        title: input.title,
        severity: input.severity,
        path: input.deepLink ?? null,
      }),
    );
    if (ids.length && deps.keys) {
      await new NotificationChannelService({
        db: deps.db,
        siteId: deps.siteId,
        keys: deps.keys,
        publicUrl: deps.env?.HEOPRESS_PUBLIC_URL ?? null,
      }).deliverDue({ ids });
    }
  } catch (err) {
    // Never into the business operation: the rows (if written) are retried by the sweep.
    console.warn('[notify] channel enqueue/delivery failed', formatSafeError(err));
  }
}
