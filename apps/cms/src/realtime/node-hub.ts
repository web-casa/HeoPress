// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
/**
 * Node WebSocket hub — the Docker/self-hosted analog of the SiteRoom Durable
 * Object. It attaches a `ws` server to the existing Node HTTP server and drives
 * realtime sessions from the in-process realtime hub shared with the runtime's
 * `DockerRealtimeProvider` (so `runtime.realtime.publish()` reaches live WS
 * sessions on this process).
 *
 * Auth mirrors the Cloudflare route exactly: the client connects to
 * `/api/v1/realtime?ticket=<jwt>`, the ticket is verified here, and the session
 * principal (plane / userId / subjectId / channel allowlist) is derived from the
 * SIGNED ticket — never from the query string beyond the ticket itself.
 *
 * This module is Node-only (imports `ws` and `node:http`) and must never be
 * imported from the Cloudflare Workers bundle.
 */

import type { Server as HttpServer, IncomingMessage } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { jwtVerify } from 'jose';
import { nanoid } from 'nanoid';
import { parseClientMessage, type RealtimeEvent } from '@heopress/contracts';
import type { RealtimeEventLike } from '@heopress/runtime';
// Type-only, so nothing is emitted — but this module is Node-only anyway
// (dynamically imported by `serve.ts`).
import type { InProcessRealtimeHub } from '@heopress/runtime/docker';
import { canSubscribe, shouldDeliver, toWireMessage } from './fan-out';

const REALTIME_PATH = '/api/v1/realtime';
const HEARTBEAT_INTERVAL_MS = 30_000;
const IDLE_TIMEOUT_MS = 90_000;
const RATE_LIMIT_PER_SEC = 20;

interface NodeSession {
  ws: WebSocket;
  siteId: string;
  plane: 'studio' | 'public';
  userId?: string;
  subjectId?: string;
  subscriptions: Set<string>;
  filters: Map<string, Record<string, unknown>>;
  channels: Set<string>;
  allowedChannels: Set<string>;
  allowedCollections: Set<string>;
  unsubscribeHub: () => void;
  lastPong: number;
  msgCount: number;
  msgWindowStart: number;
  /** This session's id, and what it says it has open (HeoPress P07a: Studio presence on the Node hub). */
  sessionId: string;
  presence?: { collection?: string; itemId?: string; meta?: Record<string, unknown>; lastSeen: string };
}

export interface NodeHubOptions {
  server: HttpServer;
  hub: InProcessRealtimeHub;
  jwtSecret: string;
  /**
   * Max concurrent sessions per public subject (multi-tab/device cap). A subject
   * exceeding this is rejected with WS close 1013 ("try again later"). 0 or
   * undefined disables the cap. Studio sessions are not limited here.
   */
  maxConnectionsPerSubject?: number;
}

/**
 * Attach the realtime WebSocket server to a Node HTTP server. Returns a
 * `close()` to tear it down (used in tests).
 */
export function attachNodeRealtime(opts: NodeHubOptions): { close: () => void } {
  const { server, hub, jwtSecret } = opts;
  const maxPerSubject = opts.maxConnectionsPerSubject ?? 0;
  const secretKey = new TextEncoder().encode(jwtSecret);
  const wss = new WebSocketServer({ noServer: true });
  const sessions = new Set<NodeSession>();

  /** Count live public sessions for a subject (per-site). */
  function subjectConnectionCount(siteId: string, subjectId: string): number {
    let n = 0;
    for (const s of sessions) {
      if (s.plane === 'public' && s.siteId === siteId && s.subjectId === subjectId) n++;
    }
    return n;
  }

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    if (url.pathname !== REALTIME_PATH) return; // not ours — leave for others

    const ticket = url.searchParams.get('ticket');
    if (!ticket) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    verifyTicket(ticket, secretKey)
      .then((principal) => {
        if (!principal) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          acceptSession(ws, principal);
        });
      })
      .catch(() => {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
      });
  });

  function acceptSession(ws: WebSocket, principal: TicketPrincipal): void {
    // Enforce the per-subject connection cap (public plane only).
    if (
      maxPerSubject > 0 &&
      principal.plane === 'public' &&
      principal.subjectId &&
      subjectConnectionCount(principal.siteId, principal.subjectId) >= maxPerSubject
    ) {
      send(ws, { type: 'error', code: 'TOO_MANY_CONNECTIONS', message: 'Connection limit reached' });
      try {
        ws.close(1013, 'too many connections');
      } catch {
        /* already closed */
      }
      return;
    }

    const session: NodeSession = {
      ws,
      siteId: principal.siteId,
      plane: principal.plane,
      userId: principal.userId,
      subjectId: principal.subjectId,
      subscriptions: new Set(),
      filters: new Map(),
      channels: new Set(),
      allowedChannels: new Set(principal.channels),
      allowedCollections: new Set(principal.collections),
      unsubscribeHub: () => {},
      lastPong: Date.now(),
      msgCount: 0,
      msgWindowStart: Date.now(),
      sessionId: nanoid(12),
    };

    // Deliver published events to this session via the shared in-process hub.
    session.unsubscribeHub = hub.subscribe(principal.siteId, (event: RealtimeEventLike) => {
      deliver(session, event as RealtimeEvent);
    });

    sessions.add(session);
    send(ws, { type: 'welcome', sessionId: session.sessionId, plane: principal.plane });

    ws.on('message', (data) => onMessage(session, data.toString()));
    ws.on('close', () => teardown(session));
    ws.on('error', () => teardown(session));
    ws.on('pong', () => {
      session.lastPong = Date.now();
    });
  }

  function deliver(session: NodeSession, event: RealtimeEvent): void {
    if (
      !shouldDeliver(event, {
        plane: session.plane,
        userId: session.userId,
        subjectId: session.subjectId,
        subscriptions: session.subscriptions,
        channels: session.channels,
        filters: session.filters,
      })
    ) {
      return;
    }
    send(session.ws, toWireMessage(event));
  }

  function onMessage(session: NodeSession, raw: string): void {
    const now = Date.now();
    if (now - session.msgWindowStart > 1000) {
      session.msgCount = 0;
      session.msgWindowStart = now;
    }
    if (++session.msgCount > RATE_LIMIT_PER_SEC) {
      send(session.ws, { type: 'error', code: 'RATE_LIMITED', message: 'Too many messages' });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      send(session.ws, { type: 'error', code: 'INVALID_JSON', message: 'Invalid JSON' });
      return;
    }
    const msg = parseClientMessage(parsed);
    if (!msg) {
      send(session.ws, { type: 'error', code: 'INVALID_MESSAGE', message: 'Unknown message' });
      return;
    }

    switch (msg.type) {
      case 'subscribe':
        // Read-gate from the ticket allowlist, never trusted from the client
        // (mirrors the channel allowlist on `join`).
        if (!canSubscribe(session.allowedCollections, msg.collection)) {
          send(session.ws, {
            type: 'error',
            code: 'SUBSCRIBE_FORBIDDEN',
            message: `Not allowed to subscribe to collection: ${msg.collection}`,
          });
          break;
        }
        session.subscriptions.add(msg.collection);
        if (msg.filter) session.filters.set(msg.collection, msg.filter);
        else session.filters.delete(msg.collection);
        break;
      case 'unsubscribe':
        session.subscriptions.delete(msg.collection);
        session.filters.delete(msg.collection);
        break;
      case 'join':
        if (!session.allowedChannels.has(msg.channel)) {
          send(session.ws, {
            type: 'error',
            code: 'CHANNEL_FORBIDDEN',
            message: `Not allowed to join channel: ${msg.channel}`,
          });
          break;
        }
        session.channels.add(msg.channel);
        send(session.ws, { type: 'joined', channel: msg.channel });
        break;
      case 'leave':
        session.channels.delete(msg.channel);
        send(session.ws, { type: 'left', channel: msg.channel });
        break;
      case 'pong':
        session.lastPong = now;
        break;
      // Studio presence (HeoPress P07a task 6.3): who has which item of a collection open, shared with the other
      // Studio sessions of the same site that may read that collection. Public sessions never take part.
      case 'presence': {
        if (session.plane !== 'studio') break;
        if (msg.collection && !canSubscribe(session.allowedCollections, msg.collection)) break;
        const previous = session.presence?.collection;
        session.presence = { collection: msg.collection, itemId: msg.itemId, meta: limitMeta(msg.meta), lastSeen: new Date(now).toISOString() };
        broadcastPresence(session.siteId, msg.collection);
        if (previous && previous !== msg.collection) broadcastPresence(session.siteId, previous);
        break;
      }
    }
  }

  /** Everyone present in `collection` of `siteId`, sent to each Studio session there that may read it. */
  function broadcastPresence(siteId: string, collection: string | undefined): void {
    if (!collection) return;
    const users = [...sessions]
      .filter((s) => s.siteId === siteId && s.plane === 'studio' && s.presence?.collection === collection)
      .map((s) => ({ sessionId: s.sessionId, userId: s.userId, collection, itemId: s.presence!.itemId, meta: s.presence!.meta, lastSeen: s.presence!.lastSeen }));
    for (const s of sessions) {
      if (s.siteId !== siteId || s.plane !== 'studio' || !canSubscribe(s.allowedCollections, collection)) continue;
      send(s.ws, { type: 'presence', users });
    }
  }

  function teardown(session: NodeSession): void {
    session.unsubscribeHub();
    const was = session.presence?.collection;
    session.presence = undefined;
    sessions.delete(session);
    if (was) broadcastPresence(session.siteId, was);
    try {
      session.ws.terminate();
    } catch {
      /* already closed */
    }
  }

  // Heartbeat: ping every 30 s, disconnect sessions silent for 90 s.
  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const session of sessions) {
      if (now - session.lastPong > IDLE_TIMEOUT_MS) {
        teardown(session);
        continue;
      }
      try {
        session.ws.ping();
        send(session.ws, { type: 'ping' });
      } catch {
        teardown(session);
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
  // Don't keep the process alive for the heartbeat alone.
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  return {
    close: () => {
      clearInterval(heartbeat);
      for (const session of sessions) teardown(session);
      wss.close();
    },
  };
}

// ─── Ticket verification ────────────────────────────────────────────────────

interface TicketPrincipal {
  siteId: string;
  plane: 'studio' | 'public';
  userId?: string;
  subjectId?: string;
  channels: string[];
  /** Collection read allowlist from the signed ticket ('*' = admin bypass). */
  collections: string[];
}

async function verifyTicket(ticket: string, secretKey: Uint8Array): Promise<TicketPrincipal | null> {
  try {
    const { payload } = await jwtVerify(ticket, secretKey, { algorithms: ['HS256'] });
    const p = payload as Record<string, unknown>;
    const plane = p.plane === 'public' ? 'public' : 'studio';
    return {
      siteId: String(p.siteId ?? ''),
      plane,
      userId: plane === 'studio' ? String(p.userId ?? 'anon') : undefined,
      subjectId: plane === 'public' ? String(p.subjectId ?? '') : undefined,
      channels: Array.isArray(p.channels) ? (p.channels as string[]) : [],
      collections: Array.isArray(p.collections) ? (p.collections as string[]) : [],
    };
  } catch {
    return null;
  }
}

function send(ws: WebSocket, data: unknown): void {
  try {
    ws.send(JSON.stringify(data));
  } catch {
    /* already closed */
  }
}

/** Presence metadata kept small: at most 8 keys of short strings, numbers or booleans. */
function limitMeta(meta: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!meta) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta).slice(0, 8)) {
    if (typeof v === 'string') out[k.slice(0, 32)] = v.slice(0, 120);
    else if (typeof v === 'number' || typeof v === 'boolean') out[k.slice(0, 32)] = v;
  }
  return out;
}
