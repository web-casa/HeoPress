import { describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import { HeoPressApiError, type HeoPressClient } from '../client.js';
import { registerAllTools } from '../tools/index.js';

/**
 * update_item and versions (HeoPress P04 task 1.2): the tool requires the
 * version the change is based on, sends it with the PATCH, and a conflict
 * reaches the agent with the current version and the changed fields.
 */

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

function setup(patch: (path: string, body: unknown) => Promise<unknown>) {
  const tools = new Map<string, { schema: Record<string, z.ZodTypeAny>; handler: Handler }>();
  const server = {
    registerTool(name: string, config: { inputSchema?: Record<string, z.ZodTypeAny> }, handler: Handler) {
      tools.set(name, { schema: config.inputSchema ?? {}, handler });
    },
  };
  const client = { patch: vi.fn(patch) } as unknown as HeoPressClient;
  registerAllTools(server as never, client);
  return { tool: tools.get('update_item')!, client };
}

describe('MCP update_item carries the item version', () => {
  it('requires expectedVersion in its input schema', () => {
    const { tool } = setup(async () => ({}));
    expect(tool.schema['expectedVersion']!.safeParse(undefined).success).toBe(false);
    expect(tool.schema['expectedVersion']!.safeParse(0).success).toBe(false);
    expect(tool.schema['expectedVersion']!.safeParse(12).success).toBe(true);
  });

  it('sends it with the PATCH body', async () => {
    const { tool, client } = setup(async () => ({ id: 'a', version: 13 }));
    await tool.handler({ collection: 'posts', id: 'a', data: { title: 'x' }, expectedVersion: 12 });
    expect(client.patch).toHaveBeenCalledWith('/items/posts/a', { data: { title: 'x' }, expectedVersion: 12 });
  });

  it('reports a conflict with the current version and the changed fields', async () => {
    const { tool } = setup(async () => {
      throw new HeoPressApiError(409, [
        { code: 'VERSION_CONFLICT', message: 'The item changed.', meta: { currentVersion: 13, changedFields: ['title'] } } as never,
      ]);
    });
    const res = await tool.handler({ collection: 'posts', id: 'a', data: { title: 'x' }, expectedVersion: 12 });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('[VERSION_CONFLICT]');
    expect(res.content[0]!.text).toContain('current version 13; changed fields: title');
  });

  it('update_block sends the block and the version to the block endpoint', async () => {
    const tools = new Map<string, Handler>();
    const server = {
      registerTool(name: string, _config: unknown, handler: Handler) {
        tools.set(name, handler);
      },
    };
    const client = { patch: vi.fn(async () => ({ version: 5 })) } as unknown as HeoPressClient;
    registerAllTools(server as never, client);
    await tools.get('update_block')!({ collection: 'posts', id: 'a', field: 'body', blockId: 'b_1', block: '<p>x</p>', expectedVersion: 4 });
    expect(client.patch).toHaveBeenCalledWith('/items/posts/a/blocks/body/b_1', { block: '<p>x</p>', expectedVersion: 4 });
  });
});
