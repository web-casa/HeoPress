// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { type HeoPressClient, HeoPressApiError } from '../client.js';
import { collectionNameSchema, encodePathSegment, idPathSegmentSchema } from './path.js';
import { okAfter } from './_shared.js';

function formatError(err: unknown): string {
  if (err instanceof HeoPressApiError) {
    return err.errors
      .map((e) => {
        // A version conflict tells the agent what it needs to retry: the
        // current version and which fields someone else changed.
        const meta = (e as { meta?: { currentVersion?: number; changedFields?: string[] } }).meta;
        const detail =
          e.code === 'VERSION_CONFLICT' && meta
            ? ` (current version ${meta.currentVersion}; changed fields: ${(meta.changedFields ?? []).join(', ') || 'none recorded'})`
            : '';
        return `[${e.code}] ${e.message}${detail}`;
      })
      .join('; ');
  }
  return String(err);
}

function buildQs(params: Record<string, string | number | boolean | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

export function registerItemTools(server: McpServer, client: HeoPressClient) {
  server.registerTool(
    'list_items',
    {
      description: 'List items from a collection with optional filtering, sorting, and pagination.',
      inputSchema: {
        collection: collectionNameSchema,
        limit: z.number().int().min(1).max(200).optional().default(25),
        offset: z.number().int().min(0).optional().default(0),
        status: z.enum(['draft', 'published', 'archived']).optional(),
        sort: z
          .string()
          .optional()
          .describe('Comma-separated field names; prefix with - for descending (e.g. "-created_at")'),
        fields: z
          .string()
          .optional()
          .describe('Comma-separated field names to return (e.g. "id,title,status")'),
        search: z.string().optional().describe('Full-text search across searchable fields'),
      },
    },
    async ({ collection, ...params }) => {
      try {
        const qs = buildQs(params as Record<string, string | number | boolean | undefined>);
        const data = await client.get<unknown>(`/items/${encodePathSegment(collection)}${qs}`);
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${formatError(err)}` }], isError: true };
      }
    },
  );

  server.registerTool(
    'get_item',
    {
      description: 'Get a single item by ID from a collection.',
      inputSchema: {
        collection: collectionNameSchema,
        id: idPathSegmentSchema,
        fields: z
          .string()
          .optional()
          .describe('Comma-separated field names to return'),
      },
    },
    async ({ collection, id, fields }) => {
      try {
        const qs = buildQs({ fields });
        const data = await client.get<unknown>(
          `/items/${encodePathSegment(collection)}/${encodePathSegment(id)}${qs}`,
        );
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${formatError(err)}` }], isError: true };
      }
    },
  );

  server.registerTool(
    'create_item',
    {
      description: 'Create a new item in a collection.',
      inputSchema: {
        collection: collectionNameSchema,
        data: z.record(z.string(), z.unknown()).describe('Field values for the new item'),
        status: z.enum(['draft', 'published']).optional().default('draft'),
      },
    },
    async ({ collection, data: itemData, status }) => {
      try {
        // REST `createSchema` (apps/cms/src/routes/items.ts) đòi `data: record`.
        // Trước đây handler spread field ra TOP LEVEL nên body thiếu envelope
        // `data` và REST trả 400 VALIDATION — tool này chưa từng chạy được với
        // payload thông thường. Regression: `R12` (CMS) + `S6` (stdio).
        const data = await client.post<unknown>(`/items/${encodePathSegment(collection)}`, {
          data: itemData,
          status,
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${formatError(err)}` }], isError: true };
      }
    },
  );

  server.registerTool(
    'update_item',
    {
      description: 'Partially update an item (PATCH — only provided fields are changed).',
      inputSchema: {
        collection: collectionNameSchema,
        id: idPathSegmentSchema,
        data: z.record(z.string(), z.unknown()).describe('Fields to update'),
        expectedVersion: z
          .number()
          .int()
          .min(1)
          .describe(
            'The item version this change is based on (`version` from get_item). If the item changed since, the update is refused with VERSION_CONFLICT: read it again and retry.',
          ),
        reason: z
          .string()
          .trim()
          .min(1)
          .max(1000)
          .optional()
          .describe("Why: required when the change touches a published item's sponsor marking (sponsored, sponsor_name); refused with REASON_REQUIRED otherwise."),
      },
    },
    async ({ collection, id, data: itemData, expectedVersion, reason }) => {
      try {
        // REST `patchSchema` có mọi field optional và Zod **strip** key lạ, nên
        // gửi bare `itemData` cho kết quả 200 OK với patch RỖNG — nội dung update
        // bị bỏ qua âm thầm (success-shaped no-op). Regression: `R13` + `S6`.
        const data = await client.patch<unknown>(
          `/items/${encodePathSegment(collection)}/${encodePathSegment(id)}`,
          { data: itemData, expectedVersion, ...(reason ? { reason } : {}) },
        );
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${formatError(err)}` }], isError: true };
      }
    },
  );

  server.registerTool(
    'update_block',
    {
      description:
        'Replace one block of an item by its stable ID: one HTML element for a rich-text field (blocks carry data-block-id), or one row object for a repeater field (rows carry _blockId). Only that block changes.',
      inputSchema: {
        collection: collectionNameSchema,
        id: idPathSegmentSchema,
        field: idPathSegmentSchema.describe('The rich-text or repeater field'),
        blockId: idPathSegmentSchema.describe('The block ID (data-block-id / _blockId)'),
        block: z.union([z.string(), z.record(z.string(), z.unknown())]).describe('The new block'),
        expectedVersion: z.number().int().min(1).describe('The item version this change is based on (from get_item).'),
      },
    },
    async ({ collection, id, field, blockId, block, expectedVersion }) => {
      try {
        const data = await client.patch<unknown>(
          `/items/${encodePathSegment(collection)}/${encodePathSegment(id)}/blocks/${encodePathSegment(field)}/${encodePathSegment(blockId)}`,
          { block, expectedVersion },
        );
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${formatError(err)}` }], isError: true };
      }
    },
  );

  server.registerTool(
    'delete_item',
    {
      description: 'Soft-delete an item (sets deleted_at, recoverable). Pass confirm=true.',
      inputSchema: {
        collection: collectionNameSchema,
        id: idPathSegmentSchema,
        confirm: z.literal(true).describe('Must be true to confirm deletion'),
      },
    },
    async ({ collection, id }) => {
      try {
        const response = await client.delete(
          `/items/${encodePathSegment(collection)}/${encodePathSegment(id)}`,
        );
        return okAfter(response, `Item "${id}" deleted from "${collection}".`);
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${formatError(err)}` }], isError: true };
      }
    },
  );
}
