# `@heopress/sdk`

Typed JavaScript/TypeScript client for a running [HeoPress](https://heopress.example) CMS — REST commands, GraphQL helper, realtime subscriptions, and TypeScript type generation.

```bash
npm install @heopress/sdk
# or
pnpm add @heopress/sdk
```

## Quick start

```ts
import { createHeoPressClient, readItems } from '@heopress/sdk'

const client = createHeoPressClient({
  url: 'https://api.mysite.heopress.example',
  siteId: 'site_abc123',
  token: process.env.HEOPRESS_TOKEN!,
})

const articles = await client.request(
  readItems('articles', {
    filter: { status: { _eq: 'published' } },
    sort: ['-created_at'],
    limit: 10,
  }),
)
```

## What you get

| Surface | Entry | Notes |
| --- | --- | --- |
| Transport | `createHeoPressClient` | Tree-shakeable `request` / `rawRequest` / `with` |
| REST commands | `@heopress/sdk` REST exports | `readItems`, CDC, agents, search, … |
| Legacy façade | `legacyRest()` | Namespaced API if you prefer not to import commands |
| GraphQL | GraphQL helper | Against the CMS GraphQL endpoint |
| Realtime | `RealtimeClient` | WebSocket subscriptions |
| Typegen | `generateTypes` | Produce TS types from a live schema |
| SEO helpers | `seo` exports | Delivery helpers for meta/structured data |

The client is a **transport**, not a façade: you import only the commands you use. There is no `login()` — pass a Bearer token (and optional `refreshToken`) you already hold.

## Requirements

- A running HeoPress CMS (Docker image, Cloudflare Worker, or local monorepo `pnpm cms:dev`)
- Node.js 18+ / modern browsers / Cloudflare Workers (`fetch`-compatible runtimes)

## Docs

- [JavaScript SDK](https://docs.heopress.example/en/sdk/javascript)
- [Typegen](https://docs.heopress.example/en/sdk/typegen)
- [Next.js quickstart](https://docs.heopress.example/en/tutorials/nextjs-quickstart)

## Related packages

| Package | Role |
| --- | --- |
| [`@heopress/contracts`](https://www.npmjs.com/package/@heopress/contracts) | Shared Zod schemas / policy & field DSLs |
| [`@heopress/extension-sdk`](https://www.npmjs.com/package/@heopress/extension-sdk) | Author hooks, endpoints, UI extensions |
| [`@heopress/mcp-server`](https://www.npmjs.com/package/@heopress/mcp-server) | Stdio MCP server for AI assistants |

## License

Apache-2.0 — part of the [HeoPress](https://github.com/web-casa/HeoPress) monorepo.
