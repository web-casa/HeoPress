import { OAuthClientMetadataSchema } from '@modelcontextprotocol/sdk/shared/auth.js';

/**
 * Client registration rules (HeoPress P10 task 1.5; spec agents/mcp-access "实时权限与令牌生命周期": 客户端注册与元数据读取
 * SHALL 限流并执行出站校验).
 *
 * The registration shape is validated with the MCP SDK's own schema (`OAuthClientMetadataSchema`, MIT), then
 * narrowed to what this server does: authorization code + refresh token, `response_type=code`, and redirect URIs that
 * cannot send a code somewhere unexpected:
 *
 * - `https` with a host; or
 * - `http` only to a loopback host (`localhost`, `127.0.0.1`, `[::1]`; RFC 8252 §7.3 — the port may differ at
 *   authorization time); or
 * - a private-use scheme (RFC 8252 §7.1, e.g. `cursor://…`), never `javascript:`, `data:`, `file:` and the like;
 * - never a fragment, never user info.
 *
 * Nothing in the metadata (logo, client or policy URLs) is ever fetched; the only URL this server reads is a client
 * id metadata document, through the outbound guard (`agent-access-service.ts`).
 */

const FORBIDDEN_SCHEMES = new Set(['javascript', 'data', 'file', 'vbscript', 'blob', 'about', 'ws', 'wss', 'ftp', 'mailto', 'tel']);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const MAX_REDIRECT_URIS = 10;

export class ClientRegistrationError extends Error {
  constructor(
    readonly error: 'invalid_redirect_uri' | 'invalid_client_metadata',
    message: string,
  ) {
    super(message);
  }
}

/** Why `raw` is not an acceptable redirect URI, or null when it is. */
export function redirectUriProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'not a URL';
  }
  if (raw.includes('#')) return 'must not contain a fragment';
  if (url.username || url.password) return 'must not contain user info';
  const scheme = url.protocol.slice(0, -1).toLowerCase();
  if (scheme === 'https') return url.hostname ? null : 'https URI without a host';
  if (scheme === 'http') return LOOPBACK_HOSTS.has(url.hostname.toLowerCase()) ? null : 'http is allowed only for loopback hosts';
  if (FORBIDDEN_SCHEMES.has(scheme)) return `scheme "${scheme}" is not allowed`;
  return /^[a-z][a-z0-9+.-]*$/.test(scheme) ? null : 'invalid scheme';
}

/** Whether `presented` matches a registered redirect URI: exactly, or a loopback http URI on another port. */
export function redirectUriMatches(registered: readonly string[], presented: string): boolean {
  if (registered.includes(presented)) return true;
  let p: URL;
  try {
    p = new URL(presented);
  } catch {
    return false;
  }
  if (p.protocol !== 'http:' || !LOOPBACK_HOSTS.has(p.hostname.toLowerCase()) || presented.includes('#')) return false;
  return registered.some((r) => {
    try {
      const u = new URL(r);
      return u.protocol === 'http:' && u.hostname.toLowerCase() === p.hostname.toLowerCase() && u.pathname === p.pathname && u.search === p.search;
    } catch {
      return false;
    }
  });
}

export interface ValidatedClientMetadata {
  clientName: string | null;
  redirectUris: string[];
  tokenEndpointAuthMethod: 'none' | 'client_secret_basic' | 'client_secret_post';
  metadata: Record<string, unknown>;
}

/** Validate registration metadata (a DCR request body or a client id metadata document). */
export function validateClientMetadata(input: unknown): ValidatedClientMetadata {
  const parsed = OAuthClientMetadataSchema.safeParse(input);
  if (!parsed.success) {
    throw new ClientRegistrationError('invalid_client_metadata', parsed.error.issues.map((i) => `${i.path.join('.') || '/'}: ${i.message}`).join('; '));
  }
  const m = parsed.data;
  const uris = m.redirect_uris.map(String);
  if (uris.length === 0 || uris.length > MAX_REDIRECT_URIS) {
    throw new ClientRegistrationError('invalid_redirect_uri', `1–${MAX_REDIRECT_URIS} redirect URIs are required.`);
  }
  for (const uri of uris) {
    const problem = redirectUriProblem(uri);
    if (problem) throw new ClientRegistrationError('invalid_redirect_uri', `${uri}: ${problem}`);
  }
  const grantTypes = m.grant_types ?? ['authorization_code', 'refresh_token'];
  if (grantTypes.some((g) => g !== 'authorization_code' && g !== 'refresh_token')) {
    throw new ClientRegistrationError('invalid_client_metadata', 'Only the authorization_code and refresh_token grants are supported.');
  }
  if ((m.response_types ?? ['code']).some((r) => r !== 'code')) {
    throw new ClientRegistrationError('invalid_client_metadata', 'Only response_type "code" is supported.');
  }
  const method = m.token_endpoint_auth_method ?? 'none';
  if (method !== 'none' && method !== 'client_secret_basic' && method !== 'client_secret_post') {
    throw new ClientRegistrationError('invalid_client_metadata', `token_endpoint_auth_method "${method}" is not supported.`);
  }
  const keep: Record<string, unknown> = {};
  for (const key of ['client_uri', 'logo_uri', 'tos_uri', 'policy_uri', 'software_id', 'software_version', 'scope'] as const) {
    const v = m[key];
    if (typeof v === 'string' && v.length <= 2000) keep[key] = v;
  }
  const name = typeof m.client_name === 'string' ? m.client_name.trim().slice(0, 200) : '';
  return { clientName: name || null, redirectUris: uris, tokenEndpointAuthMethod: method, metadata: keep };
}
