// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { HeoPressClient } from '../client.js';
import { run } from './_shared.js';

export function registerPermissionTools(server: McpServer, client: HeoPressClient) {
  server.registerTool(
    'get_my_permissions',
    {
      description: 'Get the compiled permission bundle for the authenticated principal.',
      inputSchema: {},
    },
    async () => run(() => client.get<unknown>('/permissions/me')),
  );

  server.registerTool(
    'check_permission',
    {
      description:
        'Evaluate whether the current principal may perform an action on a collection ' +
        '(optionally against a specific item), returning { allowed, reason, fields }.',
      inputSchema: {
        collection: z.string().min(1),
        action: z.enum(['create', 'read', 'update', 'delete', 'share']),
        item: z.record(z.string(), z.unknown()).optional().describe('Item payload to evaluate row-level rules against.'),
      },
    },
    async (input) => run(() => client.post<unknown>('/permissions/check', input)),
  );
}
