// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { isAdminPrincipal } from '../middleware/control-plane-access-guard';
import { auditSecurityGuardDenied } from '../middleware/security-audit';
import { buildAgentNotifier } from '../modules/notifications/notify-context';
import { AccessService } from '../services/access-service';
import { AISecureHarness, CORE_SKILLS, isControlPlaneSkill } from '../services/ai-harness';
import { ConfigService } from '../services/config-service';
import { ExtensionsService } from '../services/extensions-service';
import { getContentOsFlags } from '../services/feature-flags';
import { approvalRequesterFromAuth, resolveRequestCapabilities } from '../services/governed-capabilities';
import { IntentService } from '../services/intent-service';
import { itemServiceForRequest, buildRequestPermissionContext } from '../services/item-service-factory';
import { configuredLlm, gatewayFor } from '../services/llm/bindings';
import { McpService, type McpHarnessPort } from '../services/mcp-service';
import { SchemaService } from '../services/schema-service';
import { apiKeyToolGroups } from '../services/agent-access/agent-access-service';
import { apiKeys } from '@heopress/database';
import { eq } from 'drizzle-orm';
import { ToolRegistryService } from '../services/tool-registry-service';

/**
 * MCP server endpoint — Streamable HTTP transport (content-os task 4.1;
 * Req 4.1-4.3). Mounted on the authenticated `api` chain. The capability set
 * passed to the harness is resolved from the bearer token's live RBAC bundle
 * (#472), so an MCP client can never do more than the same token could through
 * REST — and no less either, which is what `auth.roles` used to get wrong.
 *
 * Gated by the per-site `contentOs.mcp` flag (default off).
 */
export const mcpRouter = new Hono<AppEnv>();

mcpRouter.post('/', async (c) => {
  const db = c.get('db');
  const siteId = c.get('siteId');
  const flags = await getContentOsFlags(db, siteId);
  if (!flags.mcp) {
    return c.json(
      { errors: [{ code: 'MCP_DISABLED', message: 'Enable the contentOs.mcp flag for this site to use the MCP endpoint.' }] },
      404,
    );
  }

  const runtime = c.get('runtime');
  const auth = c.get('auth');
  const llm = await configuredLlm(gatewayFor({ db, keys: runtime.keys, env: c.env as unknown as Record<string, string | undefined> }), {
    siteId,
    taskType: 'generation',
    origin: { kind: 'mcp' },
  }, ['translation']);
  const registry = new ToolRegistryService(db, siteId, CORE_SKILLS);
  const harness = new AISecureHarness({
    db,
    siteId,
    actor: { userId: auth.userId ?? null, apiKeyId: auth.apiKeyId ?? null },
    schemaService: new SchemaService({ db, siteId, cache: runtime.cache }),
    // Request-scoped ItemService so MCP-driven skills enforce the same
    // row/field RBAC as the bearer token would via the Agent API — matching
    // this router's contract that an MCP client "can never do more than the
    // same token could via the Agent API". Previously built without a
    // permissionCtx, which silently bypassed RBAC.
    itemService: itemServiceForRequest(c),
    accessService: new AccessService({ db, siteId, userId: auth.userId ?? null, cache: runtime.cache }),
    intentService: new IntentService({ db, siteId, userId: auth.userId ?? null, llm }),
    configService: new ConfigService({ db, siteId }),
    extensionsService: new ExtensionsService({
      db, siteId, userId: auth.userId ?? null, cache: runtime.cache, env: c.env,
      permissionCtx: buildRequestPermissionContext({ auth, siteId, headers: c.req.header(), ip: c.get('ip') ?? null }),
    }),
    llm,
    queue: runtime.queue,
    notify: buildAgentNotifier(c),
    // Deployment skills are part of the MCP tool surface; the KeyProvider is
    // what lets them decrypt target tokens (capabilities still gate access).
    keys: runtime.keys,
    cache: runtime.cache,
  });

  const port: McpHarnessPort = {
    listTools: async () =>
      (await registry.listTools()).map(({ name, description, inputSchema, enabled }) => ({
        name,
        description,
        inputSchema,
        enabled,
      })),
    execute: (skillName, args, capabilities, contextMessage) =>
      harness.execute(skillName, args, capabilities, contextMessage, {
        // Provenance for anything this call parks (#472), so approving it later
        // re-reads the caller's grant instead of trusting the decider's.
        requestedByPrincipal: approvalRequesterFromAuth(c.get('auth'), siteId),
      }),
  };

  const body: unknown = await c.req.json().catch(() => undefined);

  // Defense-in-depth admin backstop. The MCP surface is not listed in
  // `CONTROL_PLANE_PATHS`, so `withControlPlaneAccessGuard()` never runs for
  // it; like the Agent API, MCP relies on the harness's in-code capability +
  // HITL checks. This mirrors that guard's intent ("control-plane operations
  // stay behind an admin principal even if the in-code check is later
  // weakened") for the one MCP method that mutates state: a `tools/call`
  // targeting a control-plane skill (dangerous, schema-mutating, or `delete*`)
  // requires an admin principal before the harness ever runs. Discovery
  // (`tools/list`, `initialize`, `ping`) and safe read skills are unaffected,
  // preserving Agent-API parity for everything else.
  // Capabilities come from the live RBAC bundle, not from `auth.roles` (#472).
  // `auth.roles` holds a role *id* for a normal user and `[]` for an API key, so
  // comparing it against `items:write` could only ever match the literal
  // `'admin'` string a bootstrap/dev principal gets — the harness was
  // admin-or-nothing regardless of what the token was actually allowed to do.
  const grant = await resolveRequestCapabilities(c);

  const controlPlaneSkill = controlPlaneSkillFromCall(body);
  // The backstop now accepts either signal. `isAdminPrincipal` is kept because
  // it is the same predicate `withControlPlaneAccessGuard` uses elsewhere, and
  // `controlPlaneAdmin` is added because it is DB-derived: a real `adminAccess`
  // role passes, while an admin-policy API KEY still does not
  // (`EffectiveCapabilityService.resolveApiKey` returns `controlPlaneAdmin:
  // false` deliberately).
  if (controlPlaneSkill && !isAdminPrincipal(auth) && !grant.controlPlaneAdmin) {
    await auditSecurityGuardDenied(c, 'mcp_control_plane_skill_denied', {
      skill: controlPlaneSkill,
      reason: 'non_admin_control_plane_skill',
      roles: auth?.roles ?? [],
      principalType: auth?.type ?? 'user',
      capabilityCode: grant.code ?? null,
    });
    return c.json(
      {
        errors: [
          {
            code: 'CONTROL_PLANE_FORBIDDEN',
            message: 'Control-plane skills require an admin principal.',
          },
        ],
      },
      403,
    );
  }

  // API keys are limited to their MCP tool groups here too (HeoPress P10 task 1.3; design "迁移计划"): read-only
  // unless the key's `metadata.mcpToolGroups` names more — a write skill needs `content`, a control-plane skill
  // `settings`. The site scope is the key's own site (enforced by `withAuth`).
  const calledSkill = toolNameFromCall(body);
  if (calledSkill && auth?.type === 'api_key' && auth.apiKeyId) {
    const [key] = await db.select({ metadata: apiKeys.metadata }).from(apiKeys).where(eq(apiKeys.id, auth.apiKeyId)).limit(1);
    const groups = apiKeyToolGroups(key?.metadata);
    const skill = CORE_SKILLS[calledSkill];
    const needed = controlPlaneSkill ? 'settings' : skill && skill.requiredCapabilities.some((cap) => /:(write|update|create|delete)$/.test(cap)) ? 'content' : 'read';
    if (!groups.includes(needed)) {
      await auditSecurityGuardDenied(c, 'mcp_tool_group_denied', { skill: calledSkill, group: needed, principalType: 'api_key' });
      return c.json({ errors: [{ code: 'TOOL_GROUP_NOT_GRANTED', message: `This API key's MCP tool groups do not include "${needed}".` }] }, 403);
    }
  }

  const response = await new McpService(port).handle(body, grant.capabilities);
  if (response === null) {
    // Notification — Streamable HTTP answers 202 Accepted with no body.
    return c.body(null, 202);
  }
  return c.json(response);
});

/**
 * If `body` is a JSON-RPC `tools/call` whose target skill is a control-plane
 * operation, returns the skill name; otherwise `null`. Used by the admin
 * backstop above.
 *
 * Resolution uses the static `CORE_SKILLS` metadata (where `dangerous` and
 * `requiredCapabilities` live) plus the name-based `delete*` rule — covering
 * every governed skill. A name absent from `CORE_SKILLS` that does not start
 * with `delete` returns `null` and falls through to the harness, which denies
 * unknown skills anyway, so nothing executes unguarded.
 */
function toolNameFromCall(body: unknown): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const request = body as { method?: unknown; params?: { name?: unknown } };
  if (request.method !== 'tools/call') return null;
  const name = request.params?.name;
  return typeof name === 'string' && name.length > 0 ? name : null;
}

function controlPlaneSkillFromCall(body: unknown): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const request = body as { method?: unknown; params?: { name?: unknown } };
  if (request.method !== 'tools/call') return null;
  const name = request.params?.name;
  if (typeof name !== 'string' || name.length === 0) return null;
  const skill = CORE_SKILLS[name];
  if (skill) {
    return isControlPlaneSkill(skill, name) ? name : null;
  }
  // Unknown skill: only the name-based `delete*` rule applies.
  return name.startsWith('delete') ? name : null;
}

// The optional SSE stream of the Streamable HTTP transport is not offered;
// clients fall back to plain request/response per the MCP spec.
mcpRouter.get('/', (c) =>
  c.json(
    { errors: [{ code: 'METHOD_NOT_ALLOWED', message: 'This MCP server does not offer a server-initiated stream; POST JSON-RPC messages instead.' }] },
    405,
  ),
);
