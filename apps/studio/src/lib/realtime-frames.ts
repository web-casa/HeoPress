import type { AgentNotification, RealtimeEvent } from '@/types/realtime';

/**
 * One parser for the frames Studio reads from the Node realtime hub (HeoPress P10 task 5.6).
 *
 * The hub's notification frame is `{ type: 'notification', payload }`. An agent notification (approvals, veto
 * windows, incidents, goal and run status) has `payload = { source: 'agent', notification }`; the older
 * `{ type: 'notification', notification }` shape is still read. Anything malformed is ignored.
 */
export type ParsedFrame =
  | { kind: 'item'; event: RealtimeEvent }
  | { kind: 'agent'; notification: AgentNotification }
  | { kind: 'ping' }
  | null;

const KINDS = new Set(['approval', 'veto', 'incident', 'goal', 'run', 'test']);
const SEVERITIES = new Set(['info', 'warning', 'critical']);

function asAgentNotification(v: unknown): AgentNotification | null {
  if (!v || typeof v !== 'object') return null;
  const n = v as Record<string, unknown>;
  if (typeof n.id !== 'string' || typeof n.title !== 'string' || typeof n.entityId !== 'string') return null;
  if (!KINDS.has(String(n.kind)) || !SEVERITIES.has(String(n.severity))) return null;
  // Only an admin-relative path: never an absolute or protocol-relative URL from the wire.
  const deepLink = typeof n.deepLink === 'string' && n.deepLink.startsWith('/') && !n.deepLink.startsWith('//') ? n.deepLink : undefined;
  return {
    id: n.id,
    kind: n.kind as AgentNotification['kind'],
    severity: n.severity as AgentNotification['severity'],
    title: n.title,
    body: typeof n.body === 'string' ? n.body : '',
    deepLink,
    entityId: n.entityId,
    ts: typeof n.ts === 'string' ? n.ts : new Date().toISOString(),
  };
}

export function parseRealtimeFrame(raw: string): ParsedFrame {
  let msg: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    msg = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  if (msg.type === 'ping') return { kind: 'ping' };
  if (msg.type === 'event' && typeof msg.collection === 'string' && typeof msg.action === 'string' && typeof msg.itemId === 'string') {
    return { kind: 'item', event: msg as unknown as RealtimeEvent };
  }
  if (msg.type === 'notification') {
    const payload = msg.payload as Record<string, unknown> | undefined;
    const candidate = payload && payload.source === 'agent' ? payload.notification : msg.notification;
    const notification = asAgentNotification(candidate);
    return notification ? { kind: 'agent', notification } : null;
  }
  return null;
}
