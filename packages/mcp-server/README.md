# `@heopress/mcp-server`

Stdio [Model Context Protocol](https://modelcontextprotocol.io) server for [HeoPress](https://heopress.example). Lets AI assistants (Claude Code, Cursor, Windsurf, …) manage collections, fields, items, editorial workflow, releases, insights, and more against a running CMS over REST.

```bash
npm install -g @heopress/mcp-server
# or run without installing:
npx @heopress/mcp-server
# binary name:
heopress-mcp
```

## Configure

Point the server at your CMS with environment variables:

| Variable | Required | Example |
| --- | --- | --- |
| `HEOPRESS_URL` | Yes | `https://api.mysite.heopress.example` or `http://localhost:1989` |
| `HEOPRESS_SITE_ID` | Yes | `site_abc123` |
| `HEOPRESS_TOKEN` | Yes | Bearer token with the roles you want the agent to inherit |

Example MCP client config:

```json
{
  "mcpServers": {
    "heopress": {
      "command": "npx",
      "args": ["-y", "@heopress/mcp-server"],
      "env": {
        "HEOPRESS_URL": "https://api.mysite.heopress.example",
        "HEOPRESS_SITE_ID": "site_abc123",
        "HEOPRESS_TOKEN": "<token>"
      }
    }
  }
}
```

A ready-made snippet lives in the monorepo at [`docs/en/agent-setup/mcp-config.json`](https://github.com/web-casa/HeoPress/blob/main/docs/en/agent-setup/mcp-config.json).

## What tools are available

Fixed CRUD + read-only groups registered by the stdio server, including:

- **Collections / fields / items** — list, get, create, update, delete, schema diff/apply
- **Insights** — dashboards, panels, ad-hoc aggregate queries (read-only)
- **Editorial** — reviews, approve/reject
- **Releases** — create, update, publish
- **Deployments** — read-only targets, deployments, logs
- **Shares, translation memory, presets, flows, site**

The token's roles are the permission floor: the MCP client can never do more than that same token can through the REST API.

> HeoPress also exposes a **governed HTTP MCP endpoint** at `POST /api/v1/mcp` inside the CMS (feature-flagged). That path runs through the agent harness (HITL, autonomy, veto). This package is the **standalone stdio** server for local editor integration — a passthrough, not the harness.

## Docs

- [MCP overview](https://docs.heopress.example/en/mcp/)
- [Agent setup](https://docs.heopress.example/en/agent-setup/)

## Related packages

| Package | Role |
| --- | --- |
| [`@heopress/sdk`](https://www.npmjs.com/package/@heopress/sdk) | Typed REST / realtime client |
| [`@heopress/extension-sdk`](https://www.npmjs.com/package/@heopress/extension-sdk) | Author extensions |
| [`@heopress/contracts`](https://www.npmjs.com/package/@heopress/contracts) | Shared Zod schemas / policy & field DSLs |

## License

Apache-2.0 — part of the [HeoPress](https://github.com/web-casa/HeoPress) monorepo.
