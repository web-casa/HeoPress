/**
 * Maintenance write freeze for HTTP (HeoPress P13 tasks 2.1, 2.3; spec ops/upgrades "升级写入冻结与数据不丢失").
 *
 * While the process write gate is frozen, every request that may write — REST, Studio, plugin endpoints, webhooks
 * and MCP tool calls that change something — is refused with 503 `MAINTENANCE` and `Retry-After`. Reads keep working:
 * GET/HEAD/OPTIONS (except OAuth callbacks, which store tokens), GraphQL queries and MCP read tools. A write admitted
 * before the freeze counts as in flight until its response is produced, so the upgrade waits for it.
 */
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../env';
import { MCP_TOOLS } from '../services/agent-access/mcp-tool-catalog';
import { processWriteGate, type WriteGate } from '../services/maintenance/write-gate';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
const READ_TOOLS = new Set(MCP_TOOLS.filter((t) => t.effect === 'read').map((t) => t.name));
/** JSON-RPC methods of the MCP endpoint that never write. */
const MCP_READ_METHODS = new Set(['initialize', 'notifications/initialized', 'ping', 'tools/list', 'resources/list', 'prompts/list']);

const MAINTENANCE_RETRY_AFTER_SECONDS = 60;

/** A GET that writes (an OAuth callback stores the provider's tokens). */
function isWritingGet(path: string): boolean {
  return /\/oauth\/[^/]+\/callback\/?$/.test(path) || path.endsWith('/oauth/callback');
}

function isGraphqlQuery(body: unknown): boolean {
  const docs = Array.isArray(body) ? body : [body];
  return docs.every((d) => {
    const q = d && typeof d === 'object' ? (d as { query?: unknown }).query : undefined;
    // Conservative: any mention of a mutation keyword is treated as a write.
    return typeof q === 'string' && !/\bmutation\b/i.test(q) && !/\bsubscription\b/i.test(q);
  });
}

function isMcpRead(body: unknown): boolean {
  const calls = Array.isArray(body) ? body : [body];
  return calls.length > 0 && calls.every((call) => {
    if (!call || typeof call !== 'object') return false;
    const { method, params } = call as { method?: unknown; params?: { name?: unknown } };
    if (typeof method !== 'string') return false;
    if (MCP_READ_METHODS.has(method)) return true;
    return method === 'tools/call' && typeof params?.name === 'string' && READ_TOOLS.has(params.name);
  });
}

async function readsOnly(path: string, request: Request): Promise<boolean> {
  const graphql = path.endsWith('/graphql');
  const mcp = path === '/api/v1/agents/mcp' || path === '/api/v1/agents/mcp/';
  if (!graphql && !mcp) return false;
  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    return false;
  }
  return graphql ? isGraphqlQuery(body) : isMcpRead(body);
}

function maintenanceResponseBody(): { errors: Array<{ code: string; message: string }> } {
  return {
    errors: [
      {
        code: 'MAINTENANCE',
        message: 'HeoPress is in maintenance (an upgrade is running): changes are paused. Reading still works; try again later.',
      },
    ],
  };
}

export function withWriteGate(gate: () => WriteGate | null = processWriteGate): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const g = gate();
    if (!g) return next();
    const path = c.req.path;
    if (SAFE.has(c.req.method) && !isWritingGet(path)) return next();
    if (g.isFrozen() && (await readsOnly(path, c.req.raw))) return next();
    const leave = g.enter();
    if (!leave) {
      c.header('Retry-After', String(MAINTENANCE_RETRY_AFTER_SECONDS));
      return c.json(maintenanceResponseBody(), 503);
    }
    try {
      await next();
    } finally {
      leave();
    }
  };
}
