#!/usr/bin/env node
/**
 * MCP conformance and demo run against a live HeoPress agent endpoint (HeoPress P10 tasks 5.3, 5.4, 7.1;
 * docs/zh-CN/agents/mcp-compatibility.md).
 *
 * Uses the pinned official MCP SDK client (Streamable HTTP) the same way an external agent does: initialize (prints
 * the negotiated protocol version), list tools, list the authorized sites, ping. With `--write <siteId>` it also runs
 * the single-site demo: create a draft (idempotent), read it back, publish it with its expected version.
 *
 *   HEOPRESS_MCP_URL=https://cms.example.com/api/v1/agents/mcp \
 *   HEOPRESS_MCP_TOKEN=<personal access token> \
 *   node apps/cms/scripts/mcp-conformance.mjs [--write <siteId>] [--collection articles] [--locale en]
 *
 * The token is read from the environment and never printed. The output is one JSON report on stdout; the exit code
 * is 0 when every step passed.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const url = process.env.HEOPRESS_MCP_URL;
const token = process.env.HEOPRESS_MCP_TOKEN;
if (!url || !token) {
  console.error('Set HEOPRESS_MCP_URL and HEOPRESS_MCP_TOKEN.');
  process.exit(2);
}
const writeSite = arg('write', null);
const collection = arg('collection', 'articles');
const locale = arg('locale', 'en');

const report = { endpoint: url, steps: [] };
const step = async (name, fn) => {
  const startedAt = Date.now();
  try {
    const detail = await fn();
    report.steps.push({ name, ok: true, ms: Date.now() - startedAt, ...(detail ? { detail } : {}) });
    return detail;
  } catch (err) {
    report.steps.push({ name, ok: false, ms: Date.now() - startedAt, error: String(err?.message ?? err).replaceAll(token, '<token>') });
    return null;
  }
};
const structured = (res) => {
  if (res.isError) throw new Error(`tool error: ${JSON.stringify(res.structuredContent ?? res.content)}`);
  return res.structuredContent;
};

const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
const client = new Client({ name: 'heopress-mcp-conformance', version: '1.0.0' });

const connected = await step('initialize', async () => {
  await client.connect(transport);
  return { protocolVersion: transport.protocolVersion ?? null, server: client.getServerVersion() ?? null };
});
if (connected) {
  await step('tools/list', async () => {
    const { tools } = await client.listTools();
    return { count: tools.length, names: tools.map((t) => t.name) };
  });
  await step('ping', async () => {
    await client.ping();
  });
  await step('sites_list', async () => {
    const out = structured(await client.callTool({ name: 'sites_list', arguments: { scope: { instance: true } } }));
    return { sites: (out?.data ?? []).map((s) => ({ id: s.id, name: s.name })) };
  });
  if (writeSite) {
    const key = `conformance-${Date.now()}`;
    const data = { title: `MCP conformance ${new Date().toISOString()}`, slug: key, locale };
    const created = await step('content_create (draft)', async () => {
      const out = structured(
        await client.callTool({
          name: 'content_create',
          arguments: { siteId: writeSite, collection, idempotencyKey: key, data },
        }),
      );
      return { id: out.data.id, version: out.data.version, status: out.data.status };
    });
    if (created) {
      await step('content_create (same idempotency key replays)', async () => {
        const again = structured(
          await client.callTool({
            name: 'content_create',
            arguments: { siteId: writeSite, collection, idempotencyKey: key, data },
          }),
        ).data;
        if (again?.id && again.id !== created.id) throw new Error('a retry created a second item');
        return { id: again?.id ?? null };
      });
      await step('content_get', async () => {
        const got = structured(await client.callTool({ name: 'content_get', arguments: { siteId: writeSite, collection, id: created.id } })).data;
        return { id: got.id, version: got.version, status: got.status };
      });
      await step('content_publish (single site, expected version)', async () => {
        const got = structured(await client.callTool({ name: 'content_get', arguments: { siteId: writeSite, collection, id: created.id } })).data;
        const out = structured(await client.callTool({ name: 'content_publish', arguments: { siteId: writeSite, collection, id: created.id, expectedVersion: got.version } }));
        return { status: out?.data?.status ?? null, version: out?.data?.version ?? null };
      });
    }
  }
  await client.close().catch(() => undefined);
}

report.ok = report.steps.every((s) => s.ok);
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
