// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { HeoPressClient } from '../client.js';
import { buildQs, run } from './_shared.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { collectionNameSchema, encodePathSegment, idPathSegmentSchema } from './path.js';

/**
 * Editorial workflow tools — the review queue and its state transitions
 * (`apps/cms/src/routes/editorial.ts`). These are RBAC-gated writes, not schema
 * mutations, so they follow the same passthrough model as item CRUD: the
 * bearer token must carry the editorial permission. `approve`/`reject` are
 * consequential publish-gate decisions taken by a person in Studio (HeoPress
 * P07a): those two tools only explain that.
 */
/** The refusal both decision tools return (HeoPress P07a). */
function humanReviewRequired(collection: string, id: string): CallToolResult {
  return {
    content: [{ type: 'text', text: `Error: [HUMAN_REVIEW_REQUIRED] item "${id}" of "${collection}" must be approved or rejected by a person in HeoPress Studio; agents and MCP clients cannot decide reviews.` }],
    isError: true,
  };
}

export function registerEditorialTools(server: McpServer, client: HeoPressClient) {
  // The site's editorial profile in effect (HeoPress P05): audience, tone, glossary, citation, structure,
  // quality and publish rules, forbidden topics — what an agent writing for the site should follow.
  server.registerTool(
    'get_editorial_profile',
    {
      description:
        "Read the site's editorial profile in effect (audience, tone, glossary, citation policy, structure/quality/publish rules, forbidden topics) and its version number. Null when the site has none.",
      inputSchema: {},
    },
    async () => run(() => client.get<unknown>('/editorial-profile')),
  );

  server.registerTool(
    'list_reviews',
    {
      description: 'List the editorial review queue, optionally filtered by status or assignee.',
      inputSchema: {
        status: z.enum(['pending', 'approved', 'rejected']).optional(),
        assignedTo: z.string().max(128).optional(),
      },
    },
    async (args) =>
      run(() =>
        client.get<unknown>(
          `/editorial/reviews${buildQs(args as Record<string, string | number | boolean | undefined>)}`,
        ),
      ),
  );

  server.registerTool(
    'submit_review',
    {
      description: 'Submit an item for editorial review, optionally assigning a reviewer.',
      inputSchema: {
        collection: collectionNameSchema,
        id: idPathSegmentSchema,
        assignedTo: z.string().min(1).max(128).nullable().optional(),
        expectedVersion: z.number().int().min(1).optional().describe('The item version the decision is based on (from get_item); a newer version is refused with VERSION_CONFLICT.'),
      },
    },
    async ({ collection, id, assignedTo, expectedVersion }) =>
      run(() =>
        client.post<unknown>(
          `/editorial/${encodePathSegment(collection)}/${encodePathSegment(id)}/submit-review`,
          { assignedTo, expectedVersion },
        ),
      ),
  );

  // Approving and rejecting are a person's decision in Studio (HeoPress P07a): the API refuses API keys — the way an
  // MCP client authenticates — before any permission check, so these tools explain that instead of calling it.
  for (const [name, verb] of [['approve_content', 'Approving'], ['reject_content', 'Rejecting']] as const) {
    server.registerTool(
      name,
      {
        description: `${verb} an item in editorial review is not available to agents: a person decides reviews in HeoPress Studio. Always returns an error naming the item; use submit_review to hand an item to a reviewer.`,
        inputSchema: {
          collection: collectionNameSchema,
          id: idPathSegmentSchema,
          reason: z.string().max(2000).optional(),
          expectedVersion: z.number().int().min(1).optional(),
        },
      },
      async ({ collection, id }) => humanReviewRequired(collection, id),
    );
  }
}
