---
version: 2
lastUpdated: 2026-07-25T08:11:35.552Z
sourceLang: en
contentHash: 42e2b8eba52703f7
codeVerified: 2026-07-25T08:11:35.552Z
codeVerifiedHash: 42e2b8eba52703f7
codeVerifiedClaims: 2
---

# Extension Development Guide

HeoPress extensions allow you to add custom field interfaces, displays, layouts, operation types, and API routes without modifying the core codebase.

## Extension types

| Type | Description | Example |
|------|-------------|---------|
| `interface` | Custom field input UI in the Studio | Color picker, rich text, map |
| `display` | How a field value is rendered in list/detail views | Preview thumbnail, status badge |
| `layout` | Alternative list view layouts | Kanban board, calendar, map view |
| `operation` | Custom Flows operation type | Send SMS, create Stripe invoice |
| `hook` | Server-side lifecycle hooks | Validate on create, sync to CRM |
| `endpoint` | Custom API routes mounted under `/ext/:extensionId/` | Proxy to external service |

## Setup

```bash
npm create @heopress/extension my-extension
cd my-extension
npm install
```

This scaffolds a project with:

```
my-extension/
  src/
    index.ts          # Extension manifest + registration
    interface.tsx     # UI component (if interface/display/layout)
    operation.ts      # Operation handler (if operation type)
    hook.ts           # Hook handler (if hook)
    endpoint.ts       # Route handler (if endpoint)
  package.json
  tsconfig.json
  vite.config.ts      # Builds to dist/index.js (ESM)
```

## Extension manifest

Every plugin ships one manifest, `heopress-extension.json`, that declares everything it may do. It is validated
with `ExtensionManifestSchema` from `@heopress/contracts/schemas` (the marketplace uses the stricter
`MarketplaceManifestSchema`); anything not declared never takes effect at runtime.

```json
{
  "name": "acme-glossary",
  "version": "1.0.0",
  "type": "hook",
  "entry": "./dist/index.js",
  "capabilities": ["items:read:posts", "items:write:glossary", "ext:events", "ext:admin-panels"],
  "outboundHosts": ["api.example.com"],
  "storage": { "terms": { "indexes": [["slug"]] } },
  "admin": {
    "pages": [{ "id": "terms", "title": "Terms" }],
    "settings": [{ "key": "linkMode", "type": "string", "default": "first" }]
  },
  "heopress": "^1.0.0",
  "security": { "contact": "security@example.com" }
}
```

| Field | Meaning |
|---|---|
| `capabilities` | What the plugin needs (see [Capabilities](#capabilities)); the admin approves the list on install. |
| `outboundHosts` | Hosts the plugin calls; each one is the capability `http:fetch:<host>`. |
| `storage` | Private storage namespaces and their indexes. |
| `admin` | Declarative admin pages (need `ext:admin-panels`) and per-site settings. |
| `heopress` | The HeoPress version range; install and upgrade are refused outside it. |
| `security` | Where to report a vulnerability (e-mail or https URL). Required by the marketplace. |

## Interface extension

```typescript
// src/interface.tsx
import type { InterfaceProps } from '@heopress/extension-sdk'

export default function ColorPickerInterface({
  value,
  onChange,
  disabled,
  field,
}: InterfaceProps<string>) {
  return (
    <input
      type="color"
      value={value ?? '#000000'}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      style={{ width: '100%', height: '40px' }}
    />
  )
}
```

### Define the interface

```typescript
// src/index.ts
import { defineInterface } from '@heopress/extension-sdk'
import ColorPickerInterface from './interface'

export default defineInterface({
  id: 'color-picker',
  name: 'Color Picker',
  component: ColorPickerInterface,
  types: ['string'],   // Compatible field types
  group: 'standard',
  options: [],         // Interface config options shown in Studio
})
```

## Operation extension

```typescript
// src/operation.ts
import type { OperationHandler } from '@heopress/extension-sdk'

export const handler: OperationHandler = async (options, context) => {
  const { to, message } = options as { to: string; message: string }
  const { runtime, siteId } = context

  // Use runtime abstraction for external calls (HTTP)
  const response = await fetch(`https://api.sms-provider.com/send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.SMS_API_KEY}` },
    body: JSON.stringify({ to, message }),
  })

  if (!response.ok) throw new Error(`SMS failed: ${response.statusText}`)

  return { messageId: (await response.json()).id }
}
```

### Register the operation

```typescript
// src/index.ts
import { registerOperation } from '@heopress/extension-sdk'
import { handler } from './operation'

registerOperation({
  id: 'send-sms',
  name: 'Send SMS',
  icon: 'sms',
  handler,
  options: [
    { field: 'to', name: 'Phone number', interface: 'input', required: true },
    { field: 'message', name: 'Message', interface: 'textarea', required: true },
  ],
})
```

## Hook extension

```typescript
// src/hook.ts
import type { HookHandler } from '@heopress/extension-sdk'

export const onArticleCreate: HookHandler = async (event, context) => {
  const { item } = event
  const { runtime } = context

  // Validate: title must be at least 5 words
  const wordCount = item.title?.split(' ').length ?? 0
  if (wordCount < 5) {
    throw new Error('Article title must be at least 5 words.')
  }
}
```

### Register the hook

```typescript
registerHook('item.create:articles', onArticleCreate)
```

Available hook events: `item.create:*`, `item.update:*`, `item.delete:*`, `auth.login`, `schema.change`.

## Security model

Plugins run in a capability sandbox. They get only what the admin approved, and nothing more because they are
official or signed:

- no raw database access, no environment variables, no host files — `db:read`, `db:write`, `service-account`,
  `env:read` and `queue:enqueue` no longer exist;
- items are read and written through the host's item service, with the requesting user's permissions, the site
  boundary, Hold and the quality gates applied;
- network requests go only to declared hosts, through the SSRF-guarded outbound boundary;
- a refused call throws `CapabilityError` and is recorded.

### Capabilities

| Capability | Grants |
|---|---|
| `http:fetch:<host>` | Requests to that host (`*.example.com`: its subdomains). |
| `items:read:<collection>` / `items:write:<collection>` | Reading / editing drafts of the collection (`*`: all). |
| `items:publish:<collection>` | Setting `published` or `scheduled`. Write never implies publish. |
| `media:read` / `media:write` | The media library. |
| `secrets:<name>` | One named secret the operator configured (`ctx.secrets.get(name)`). |
| `kv:read` / `kv:write` | The plugin's key-value store. |
| `cdc:subscribe:<collection>` | Change-feed events. |
| `seo:structured-data` | Structured-data contributions. |
| `ext:<point>` | Registering on an extension point: `collections`, `routes`, `source-adapters`, `gate-checks`, `jobs`, `endpoints`, `events`, `admin-panels`, `build-steps`. |

Exporting `hooks` or a `cdcSubscriber` needs `ext:events`, a `handler` needs `ext:endpoints`, a `ui` needs
`ext:admin-panels`; an export on an undeclared point is dropped (the rest of the plugin still loads).
`ctx.extensionPoints.register(point, definition)` is refused the same way.

### Install, upgrade and signatures

- Installing shows every requested capability; the admin approves them (`approvedCapabilities`).
- An upgrade that adds a capability is staged: the admin sees the diff and approves it
  (`POST /extensions/:id/upgrade/approve`); until then the installed version keeps running.
- Outside development mode (`HEOPRESS_ENV=development`) only bundles signed by a registered, unrevoked publisher
  key are installed or loaded.
- Plugins installed before this model were migrated (narrowed, never widened) and must be confirmed once
  (`POST /extensions/:id/permissions/confirm`) before they can be enabled again.

## Building and publishing

```bash
# Build the extension bundle
npm run build
# Output: dist/index.js (ESM, signed with your private key)

# Sign the bundle (required everywhere but development mode)
npm run sign -- --key ./signing-key.pem

# Test locally
heopress extension install ./dist/index.js --local

# Publish to Marketplace
heopress extension publish --token $MARKETPLACE_TOKEN
```

The marketplace also requires **build provenance**: a statement `{ repository, commit, workflow, bundleSha256 }`
signed with the same key (over `canonicalProvenance` from `@heopress/contracts/extensions`). The repository must be
the one registered for the publisher key, and the digest the signed bundle's.

## Local development in Studio

```bash
# Install your local extension in Studio dev mode
pnpm -F @heopress/studio dev

# In another terminal
heopress extension install ./my-extension/dist/index.js --local --watch
```

The Studio's hot reload picks up extension changes automatically in dev mode.

## Sending email from an extension

Extensions do **not** talk to SMTP or an email API directly. HeoPress ships a
shared **EmailService** that owns the transport (SMTP / MailChannels) and a
template + layout store. An extension only decides *who* to mail and *which
template* to use, then calls the core endpoint:

```ts
await ctx.fetch(`${baseUrl}/api/v1/email/send`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'x-site-id': siteId },
  body: JSON.stringify({ to: ['x@y.z'], templateKey: 'teammate_invite', variables: { name: 'Sam' } }),
});
```

Declare the HeoPress host in `outboundHosts` and the API token as a secret
(`secrets:heopress-api-token`, read with `ctx.secrets.get`). Author templates in Studio → Settings → Email,
or configure the transport purely by env. Full reference:
[`features/email-service.md`](../features/email-service.md). Working example:
[`examples/extension-email-setup`](../../../examples/extension-email-setup/README.md).

## Resources

- `packages/extension-sdk/src/index.ts` — the whole SDK surface: TypeScript types for
  every extension API (`ExtensionManifest`, `HookDefinition`, `InterfaceDefinition`, …)
  plus the `define*` helpers (`defineHook`, `defineInterface`, …)
- Example extensions: `apps/studio/src/interfaces/` (built-in interfaces as reference)
