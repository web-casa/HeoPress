// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { HeoPressClient } from '../client.js';
import { buildQs, run } from './_shared.js';
import { collectionNameSchema, encodePathSegment, idPathSegmentSchema } from './path.js';

/**
 * Editorial workflow tools — the review queue and its state transitions
 * (`apps/cms/src/routes/editorial.ts`). These are RBAC-gated writes, not schema
 * mutations, so they follow the same passthrough model as item CRUD: the
 * bearer token must carry the editorial permission. `approve`/`reject` are
 * consequential publish-gate decisions — the handler descriptions say so.
 */
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

  server.registerTool(
    'approve_content',
    {
      description: 'Approve an item in editorial review (a publish-gate decision). Optional reason is audited.',
      inputSchema: {
        collection: collectionNameSchema,
        id: idPathSegmentSchema,
        reason: z.string().max(2000).optional(),
        expectedVersion: z.number().int().min(1).optional().describe('The item version the decision is based on (from get_item); a newer version is refused with VERSION_CONFLICT.'),
      },
    },
    async ({ collection, id, reason, expectedVersion }) =>
      run(() =>
        client.post<unknown>(
          `/editorial/${encodePathSegment(collection)}/${encodePathSegment(id)}/approve`,
          { reason, expectedVersion },
        ),
      ),
  );

  server.registerTool(
    'reject_content',
    {
      description: 'Reject an item in editorial review. Optional reason is audited.',
      inputSchema: {
        collection: collectionNameSchema,
        id: idPathSegmentSchema,
        reason: z.string().max(2000).optional(),
        expectedVersion: z.number().int().min(1).optional().describe('The item version the decision is based on (from get_item); a newer version is refused with VERSION_CONFLICT.'),
      },
    },
    async ({ collection, id, reason, expectedVersion }) =>
      run(() =>
        client.post<unknown>(
          `/editorial/${encodePathSegment(collection)}/${encodePathSegment(id)}/reject`,
          { reason, expectedVersion },
        ),
      ),
  );
}
