import { describe, expect, it } from 'vitest';
import { apiKeyToolGroups, parseScope } from '../agent-access-service';
import { MCP_TOOLS, renderToolReference } from '../mcp-tool-catalog';
import { McpToolRunner, stripIdentityArguments } from '../mcp-tool-runner';
import { redirectUriMatches, redirectUriProblem, validateClientMetadata } from '../oauth-clients';

/** HeoPress P10 tasks 1.1, 1.4, 1.5, 2.1, 2.3: the pure rules of the agent MCP endpoint. */

describe('redirect URI rules', () => {
  it('accepts https, loopback http and private-use schemes', () => {
    for (const ok of ['https://claude.example.com/cb', 'http://127.0.0.1:5000/cb', 'http://localhost/cb', 'http://[::1]:9/cb', 'cursor://anysphere.cursor/oauth']) {
      expect(redirectUriProblem(ok), ok).toBeNull();
    }
  });
  it('refuses http to other hosts, dangerous schemes, fragments and user info', () => {
    for (const bad of ['http://example.com/cb', 'javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'https://example.com/cb#x', 'https://u:p@example.com/cb', 'nonsense']) {
      expect(redirectUriProblem(bad), bad).not.toBeNull();
    }
  });
  it('matches exactly, or a loopback http URI on another port', () => {
    expect(redirectUriMatches(['http://127.0.0.1:1/cb'], 'http://127.0.0.1:4242/cb')).toBe(true);
    expect(redirectUriMatches(['http://127.0.0.1:1/cb'], 'http://127.0.0.1:4242/other')).toBe(false);
    expect(redirectUriMatches(['https://a.example.com/cb'], 'https://a.example.com/cb/')).toBe(false);
    expect(redirectUriMatches(['https://a.example.com/cb'], 'https://a.example.com/cb')).toBe(true);
  });
  it('refuses grants other than code + refresh and secrets in unknown methods', () => {
    expect(() => validateClientMetadata({ redirect_uris: ['https://a.example.com/cb'], grant_types: ['client_credentials'] })).toThrow();
    expect(() => validateClientMetadata({ redirect_uris: ['https://a.example.com/cb'], response_types: ['token'] })).toThrow();
    expect(validateClientMetadata({ redirect_uris: ['https://a.example.com/cb'] }).tokenEndpointAuthMethod).toBe('none');
  });
});

describe('scopes and groups', () => {
  it('parses mcp:* scopes and refuses unknown ones', () => {
    expect(parseScope('mcp:read mcp:content')).toEqual(['read', 'content']);
    expect(parseScope('')).toBeNull();
    expect(() => parseScope('admin')).toThrow();
  });
  it('an API key without MCP tool groups is read-only', () => {
    expect(apiKeyToolGroups({})).toEqual(['read']);
    expect(apiKeyToolGroups({ mcpToolGroups: ['content', 'bogus'] })).toEqual(['content']);
  });
});

describe('identity arguments', () => {
  it('removes identity claims at the top level and in data', () => {
    const { args, removed } = stripIdentityArguments({ siteId: 's', userId: 'u', data: { title: 't', user_created: 'x' } });
    expect(args).toEqual({ siteId: 's', data: { title: 't' } });
    expect(removed).toEqual(['userId', 'data.user_created']);
  });
});

describe('tool catalog', () => {
  it('every write declares how it is constrained', () => {
    for (const t of MCP_TOOLS) {
      const props = (t.inputSchema.properties ?? {}) as Record<string, unknown>;
      const required = (t.inputSchema.required ?? []) as string[];
      if (t.scope === 'site') expect(required, t.name).toContain('siteId');
      else expect(required, t.name).toContain('scope');
      if (t.effect === 'update') expect(required, t.name).toContain('expectedVersion');
      if (t.effect === 'create') expect(required, t.name).toContain('idempotencyKey');
      expect(t.name).toMatch(/^[a-z_]{1,64}$/);
      void props;
    }
    expect(renderToolReference()).toContain('## `plans_submit`');
  });

  it('no tool approves a plan', () => {
    expect(MCP_TOOLS.some((t) => /approv/i.test(t.name))).toBe(false);
  });

  it('a principal sees only the tools of its groups', () => {
    const runner = new McpToolRunner({
      db: {} as never,
      access: {} as never,
      dispatch: async () => ({ status: 200, body: {} }),
      audit: async () => undefined,
      principal: { kind: 'pat', userId: 'u', email: null, apiKeyId: null, grantId: 'g', siteIds: ['a'], toolGroups: ['read'] },
    });
    expect(runner.listTools().every((t) => t.group === 'read')).toBe(true);
  });
});
