import { Hono, type Context } from 'hono';
import { resolveCorsOrigin } from '../config/cors';
import type { AppEnv } from '../env';
import { dispatchAsAgent } from '../middleware/agent-dispatch';
import { withDb } from '../middleware/db';
import { AuditLogger } from '../modules/audit/logger';
import type { AgentPrincipal } from '../services/agent-access/agent-access-service';
import { McpToolRunner, type Dispatch } from '../services/agent-access/mcp-tool-runner';
import { DEFAULT_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from '../services/mcp-service';
import { recordSystemEvent } from '../services/ops/system-events';
import { agentAccessService, mcpResource, resourceMetadataUrl } from './agent-access';

/**
 * The agent MCP endpoint (HeoPress P10; spec agents/mcp-access, agents/site-scope): `POST /api/v1/agents/mcp`,
 * Streamable HTTP without a server stream, JSON-RPC 2.0.
 *
 * Instance-level — the sites come from the token, one per call. The caller is the token alone (OAuth access token or
 * personal access token bound to this endpoint, or a site's API key); without a valid one the answer is 401 with
 * `WWW-Authenticate: Bearer resource_metadata=…` so a client can discover the authorization server. A call outside
 * the grant's sites or tool groups, or one live RBAC refuses, is 403 (`insufficient_scope`). Bodies are capped at
 * 4 MiB (413).
 *
 * Transport checks before anything else (HeoPress P10 tasks 7.1, 7.2; docs/zh-CN/agents/mcp-compatibility.md): a
 * browser `Origin` that is neither this server's public origin nor an allowed CORS origin is refused with 403 (DNS
 * rebinding, MCP Streamable HTTP), and an `MCP-Protocol-Version` header naming a version this server does not support
 * is refused with 400. Without the header the server assumes the version negotiated at `initialize`.
 */

const MAX_MCP_BODY_BYTES = 4 * 1024 * 1024;

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
/** Server-defined: the call is outside the authorization (HTTP 403). */
const FORBIDDEN = -32003;

export const agentsMcpRouter = new Hono<AppEnv>();
agentsMcpRouter.use('*', withDb());

function unauthorized(c: Context<AppEnv>, error: string | null) {
  const params = [`resource_metadata="${resourceMetadataUrl(c)}"`];
  if (error) params.push(`error="${error}"`);
  c.header('WWW-Authenticate', `Bearer ${params.join(', ')}`);
  return c.json({ jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: 'Authentication required.' } }, 401);
}

/** The body, at most 4 MiB, counted as it is read (a missing or false Content-Length does not get around it). */
async function boundedBody(c: Context<AppEnv>): Promise<string | 'too_large'> {
  const declared = Number(c.req.header('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > MAX_MCP_BODY_BYTES) return 'too_large';
  const stream = c.req.raw.body;
  if (!stream) return '';
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_MCP_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return 'too_large';
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function dispatcher(c: Context<AppEnv>, principal: AgentPrincipal, bearer: string): Dispatch {
  const origin = new URL(c.req.url).origin;
  return async (siteId, request) => {
    const headers = new Headers({ 'x-heopress-site': siteId, ...(request.headers ?? {}) });
    // An API key acts as itself (its own header, the normal path); a person through the grant's person.
    if (principal.kind === 'api_key') headers.set('authorization', `Bearer ${bearer}`);
    const ip = c.get('ip');
    if (ip) headers.set('x-forwarded-for', ip);
    let body: BodyInit | undefined;
    if (request.raw) {
      headers.set('content-type', request.raw.contentType);
      body = request.raw.body as unknown as BodyInit;
    } else if (request.json !== undefined) {
      headers.set('content-type', 'application/json');
      body = JSON.stringify(request.json);
    }
    const req = new Request(`${origin}${request.path}`, { method: request.method, headers, body });
    const res = await dispatchAsAgent(req, principal.kind === 'api_key' ? null : { userId: principal.userId!, grantId: principal.grantId }, c.env);
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { raw: text.slice(0, 2000) };
    }
    return { status: res.status, body: parsed };
  };
}

/** An `Origin` header, when present, must be this server's public origin, the request's own, or an allowed CORS origin. */
function originAllowed(c: Context<AppEnv>): boolean {
  const origin = c.req.header('origin');
  if (origin === undefined) return true;
  const own = new Set([new URL(c.req.url).origin, new URL(mcpResource(c)).origin]);
  if (own.has(origin)) return true;
  const env = { ...(process.env as Record<string, string | undefined>), ...((c.env ?? {}) as unknown as Record<string, string | undefined>) };
  return resolveCorsOrigin(origin, { CORS_ALLOWED_ORIGINS: env.CORS_ALLOWED_ORIGINS, HEOPRESS_ENV: env.HEOPRESS_ENV } as never) === origin;
}

agentsMcpRouter.use('*', async (c, next) => {
  if (!originAllowed(c)) {
    return c.json({ jsonrpc: '2.0', id: null, error: { code: FORBIDDEN, message: 'Origin not allowed.', data: { code: 'ORIGIN_NOT_ALLOWED' } } }, 403);
  }
  const version = c.req.header('mcp-protocol-version');
  if (version !== undefined && !(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(version.trim())) {
    return c.json(
      { jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: `Unsupported MCP-Protocol-Version: ${version.slice(0, 40)}.`, data: { supported: SUPPORTED_PROTOCOL_VERSIONS } } },
      400,
    );
  }
  return next();
});

agentsMcpRouter.post('/', async (c) => {
  const header = c.req.header('authorization') ?? '';
  const bearer = /^bearer\s+/i.test(header) ? header.replace(/^bearer\s+/i, '').trim() : '';
  if (!bearer) return unauthorized(c, null);
  const access = agentAccessService(c);
  const auth = await access.authenticate(bearer, mcpResource(c));
  if (!auth.ok) return unauthorized(c, 'invalid_token');
  const principal = auth.principal;

  const raw = await boundedBody(c);
  if (raw === 'too_large') {
    return c.json({ jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: `Request body exceeds ${MAX_MCP_BODY_BYTES} bytes.` } }, 413);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return c.json({ jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'Body is not valid JSON.' } });
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || (payload as { jsonrpc?: unknown }).jsonrpc !== '2.0' || typeof (payload as { method?: unknown }).method !== 'string') {
    return c.json({ jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: 'Expected a single JSON-RPC 2.0 request object.' } });
  }
  const request = payload as { id?: string | number | null; method: string; params?: Record<string, unknown> };
  const id = request.id ?? null;
  const notification = request.id === undefined || request.method.startsWith('notifications/');
  if (notification) return c.body(null, 202);

  const db = c.get('db');
  const runner = new McpToolRunner({
    db,
    access,
    principal,
    dispatch: dispatcher(c, principal, bearer),
    audit: async (siteId, event, metadata) => {
      const ctx = { ip: c.get('ip') ?? null, userAgent: c.get('userAgent') ?? null, requestId: c.get('requestId') ?? null };
      if (siteId) {
        await new AuditLogger({ db, siteId }).write({ event, actorEmail: principal.email, ...ctx, metadata });
      } else {
        await recordSystemEvent(db, { level: 'warn', source: 'agents', event, message: event.replace(/_/g, ' '), actor: principal.userId ?? principal.apiKeyId, data: metadata });
      }
    },
  });
  const ok = (result: unknown) => c.json({ jsonrpc: '2.0', id, result });
  const rpcError = (code: number, message: string, data?: unknown) =>
    c.json({ jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } });

  switch (request.method) {
    case 'initialize': {
      const asked = request.params?.protocolVersion;
      const protocolVersion = (SUPPORTED_PROTOCOL_VERSIONS as readonly unknown[]).includes(asked) ? (asked as string) : DEFAULT_PROTOCOL_VERSION;
      return ok({ protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'heopress-agents', version: '1.0.0' } });
    }
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: runner.listTools().map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema })) });
    case 'tools/call': {
      const name = request.params?.name;
      const args = request.params?.arguments ?? {};
      if (typeof name !== 'string' || !name) return rpcError(INVALID_PARAMS, 'params.name is required');
      if (!args || typeof args !== 'object' || Array.isArray(args)) return rpcError(INVALID_PARAMS, 'params.arguments must be an object');
      const outcome = await runner.call(name, args as Record<string, unknown>);
      if (outcome.kind === 'forbidden') {
        c.header('WWW-Authenticate', `Bearer error="insufficient_scope", resource_metadata="${resourceMetadataUrl(c)}"`);
        return c.json({ jsonrpc: '2.0', id, error: { code: FORBIDDEN, message: outcome.message, data: { code: outcome.code } } }, 403);
      }
      return ok({ content: [{ type: 'text', text: JSON.stringify(outcome.value) }], structuredContent: outcome.value, isError: outcome.isError });
    }
    default:
      return rpcError(METHOD_NOT_FOUND, `Method not supported: ${request.method}`);
  }
});

agentsMcpRouter.get('/', (c) =>
  c.json({ errors: [{ code: 'METHOD_NOT_ALLOWED', message: 'No server-initiated stream; POST JSON-RPC messages instead.' }] }, 405),
);
