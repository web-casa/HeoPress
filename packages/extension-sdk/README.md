# `@heopress/extension-sdk`

Types and helpers for building [HeoPress](https://heopress.example) extensions — hooks, endpoints, UI interfaces, and change-feed subscribers.

```bash
npm install @heopress/extension-sdk
# or
pnpm add @heopress/extension-sdk
```

## Quick start

```ts
import { defineHook, defineInterface, defineCdcSubscriber } from '@heopress/extension-sdk'

export const onItemCreate = defineHook({
  on: 'items.create',
  async handler({ payload, ctx }) {
    ctx.logger.info('item created', { id: payload.id })
  },
})

export const colorPicker = defineInterface({
  id: 'color-picker',
  name: 'Color Picker',
  types: ['string'],
  group: 'selection',
  component: (props) => {
    // return your UI element; Studio mounts this in the field editor
    return props.value
  },
})

export const onPostsChange = defineCdcSubscriber({
  collections: ['posts'],
  operations: ['create', 'update'],
  payloadMode: 'reference',
  async handler({ events, ctx }) {
    for (const event of events) {
      ctx.logger.info('cdc event', { id: event.id, itemId: event.itemId })
    }
  },
})
```

## Extension types

| Type | Purpose |
| --- | --- |
| `hook` | Sync lifecycle handlers (`items.create`, …) |
| `endpoint` | Custom HTTP routes inside the CMS |
| `operation` | Flow/automation operations |
| `interface` / `display` / `layout` / `panel` / `module` | Studio UI surfaces |
| CDC subscriber | Async change-feed consumer (at-least-once, idempotent on `event.id`) |

## Manifest and capabilities

Declare everything in `heopress-extension.json` (`ExtensionManifest`): `capabilities`, `outboundHosts`, private
`storage` and its indexes, `admin` pages and settings, the `heopress` version range and a `security` contact.

Capabilities (`Capability`) are fine-grained: `http:fetch:<host>`, `items:read|write|publish:<collection>`,
`media:read|write`, `secrets:<name>`, `kv:read|write`, `cdc:subscribe:<collection>`, `seo:structured-data`, and
`ext:<point>` for each extension point you use (`EXTENSION_POINTS`). The admin approves them on install and approves
again whatever an upgrade adds. The sandbox enforces them: there is no raw database or environment access, writing
a collection never implies publishing it, and outside development mode only signed bundles are installed.

## Docs

- [Extensions system](https://docs.heopress.example/en/features/extensions-system) (see repo `docs/features/extensions-system.md`)
- Example: `examples/extension-color-picker` in the monorepo

## Related packages

| Package | Role |
| --- | --- |
| [`@heopress/sdk`](https://www.npmjs.com/package/@heopress/sdk) | Typed REST / realtime client |
| [`@heopress/contracts`](https://www.npmjs.com/package/@heopress/contracts) | Shared Zod schemas / policy & field DSLs |
| [`@heopress/mcp-server`](https://www.npmjs.com/package/@heopress/mcp-server) | Stdio MCP server for AI assistants |

## License

Apache-2.0 — part of the [HeoPress](https://github.com/web-casa/HeoPress) monorepo.
