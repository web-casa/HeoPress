# `@heopress/contracts`

Shared Zod schemas, TypeScript types, policy DSL, and field DSL for [HeoPress](https://heopress.example). Pure data/contracts layer — no Hono, React, or database runtime dependencies.

```bash
npm install @heopress/contracts
# or
pnpm add @heopress/contracts
```

## When to use this

Install `@heopress/contracts` when an external tool, CLI, linter, or codegen step needs to **validate or type** HeoPress artefacts without running the CMS:

- Validate `config` manifests / NDJSON backups
- Share policy / field DSL types with a custom admin or extension host
- Read CDC feed / extension / consent schemas from a worker or sidecar

If you are calling the CMS HTTP API from an app, prefer [`@heopress/sdk`](https://www.npmjs.com/package/@heopress/sdk) instead.

## Entry points

| Import | Contents |
| --- | --- |
| `@heopress/contracts` | Core types + re-exports |
| `@heopress/contracts/schemas` | Zod schemas (CDC, config manifest, flows, uploads, …) |
| `@heopress/contracts/policy` | Policy DSL types |
| `@heopress/contracts/field` | Field DSL types |
| `@heopress/contracts/extensions` | Extension manifest / signature helpers |
| `@heopress/contracts/version` | `BuildMetadata` |
| `@heopress/contracts/utils` | Shared logger helper |

```ts
import { extensionManifestSchema } from '@heopress/contracts/schemas'

const parsed = extensionManifestSchema.parse(JSON.parse(raw))
```

## Peer / runtime note

Depends on **Zod v4**. No other runtime deps.

## Related packages

| Package | Role |
| --- | --- |
| [`@heopress/sdk`](https://www.npmjs.com/package/@heopress/sdk) | Typed REST / realtime client |
| [`@heopress/extension-sdk`](https://www.npmjs.com/package/@heopress/extension-sdk) | Author hooks & UI extensions |
| [`@heopress/mcp-server`](https://www.npmjs.com/package/@heopress/mcp-server) | Stdio MCP server |

## License

Apache-2.0 — part of the [HeoPress](https://github.com/web-casa/HeoPress) monorepo.
