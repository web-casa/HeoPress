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
| `prePublishHooks` | The pre-publish hooks the bundle registers, by `name` (with optional `label`, `description`, `collections`); needs `ext:events`. An undeclared hook is refused; only a plugin that declares hooks blocks publishing while it fails to load. See [Runtime extension points](#runtime-extension-points). |
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
| `items:publish:<collection>` | Setting `published` or `scheduled`, and changing, unpublishing or deleting an item that is published or scheduled (that changes the live site). Write never implies publish: with `items:write` alone a plugin edits drafts only. |
| `media:read` / `media:write` | The media library. |
| `secrets:<name>` | One named secret the operator configured (`ctx.secrets.get(name)`). |
| `kv:read` / `kv:write` | The plugin's key-value store. |
| `cdc:subscribe:<collection>` | Change-feed events. |
| `seo:structured-data` | Structured-data contributions. |
| `ai:generate` | Model calls through the site's model gateway (`ctx.ai.generate`), billed per call against the site budget. |
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
- Bundles are served from the origins in `EXTENSION_BUNDLE_ORIGINS`. The CMS downloads a bundle through the
  outbound boundary and runs exactly the bytes the signature covers (a different download is refused); a bundle
  server on an internal address must also be listed in `HEOPRESS_TRUSTED_INTERNAL_ENDPOINTS`.
- Plugins installed before this model were migrated (narrowed, never widened) and must be confirmed once
  (`POST /extensions/:id/permissions/confirm`) before they can be enabled again.
- An operator can mark a plugin as trusted (`POST /extensions/:id/trust`); only a trusted plugin's own admin frontend
  pages are offered. An upgrade that changes the bundle drops the mark.

## Runtime extension points

Registered with `ctx.extensionPoints.register(point, definition)`; helpers and types are in
`packages/extension-sdk/src/runtime.ts`, the host's limits in `packages/contracts/src/extensions/runtime.ts`. The
full guide (zh-CN) is [插件开发指南](../../zh-CN/extensions/plugin-development.md).

| Point | Capability | What the host enforces |
|---|---|---|
| `jobs` (`defineJob`) | `ext:jobs` | One run at a time per site, plugin and job; per-run duration (≤ 120 s) and outbound request (≤ 100) caps; retries (≤ 5) with backoff; no new runs under the site kill switch or once disabled, and a running job is stopped. Batches continue with `job.continueLater(progress)` / `job.checkpoint(progress)`. |
| `endpoints` (`defineEndpoint`) | `ext:endpoints` | Served at `/_ext/<plugin>/<endpoint>` (static sites: the CMS address with `?site=<id>`). `form`: the origin must be one of the site's approved origins (domains, site URL, deployment URLs); a missing origin is refused. `callback`: `X-HeoPress-Timestamp`, `X-HeoPress-Nonce` and `X-HeoPress-Signature: v1=<hex HMAC-SHA256(secret, "ts.nonce.body")>` with the plugin's per-site secret; stale or replayed calls are refused. Rate limit (429) and body limit (413). |
| `events` (`defineSubscription`) | `ext:events` + `cdc:subscribe:<collection>` | Its own cursor in the event consumer framework; at-least-once delivery, retries and dead letters. |
| `events` (`definePrePublishHook`) | `ext:events` + the manifest's `prePublishHooks` | Called before an item is published, with a frozen copy: it can only veto. A veto, an attempt to change the item, an error or a timeout refuse the publish (409 `PUBLISH_VETOED`); the item is unchanged. Each hook is declared by name in `prePublishHooks` (`[{ "name": "require-summary", "collections": ["articles"] }]`; no `collections`: every collection); a hook registered under an undeclared name is refused at load and recorded (`extension_capability_denied`, `prePublishHooks:<name>`), never run. Fail closed, for declared hooks only: while an enabled plugin that declares hooks fails to load, or does not register a hook it declares, the publishes of the collections those hooks cover are refused ("plugin X failed to load; disable or fix it to publish") until it is fixed or disabled. A plugin that only subscribes to events declares none and never blocks a publish; its cursor keeps the events it misses. |
| storage (`ctx.storage.collection(ns)`) | the manifest's `storage` | Per site and plugin; only declared namespaces; queries on declared indexes; not versioned or published; kept when the plugin is disabled, exportable before deletion. |
| admin panels (manifest `admin`) | `ext:admin-panels` | Table pages, count widgets and settings rendered by Studio for the active site's members only; `custom` pages (own frontend) only for a trusted plugin. A plugin reads its saved settings with `ctx.settings.all()`. |

## Content extensions

A plugin can add its own content type and public pages (HeoPress P12, spec `extensions/content-extensions`). They
are data in the manifest, never code: the CMS installs the collections and checks the routes, and both rendering
engines render the templates from the public projection. The plugin's bundle never runs in a renderer.

```json
{
  "name": "acme/glossary",
  "capabilities": ["ext:collections", "ext:routes", "seo:structured-data"],
  "collections": [{ "name": "terms", "fields": [
    { "name": "title", "type": "string", "interface": "input" },
    { "name": "slug", "type": "string", "interface": "slug" },
    { "name": "body", "type": "text", "interface": "wysiwyg" }
  ] }],
  "routes": [
    { "id": "term", "kind": "item", "path": "/glossary/:slug", "collection": "terms", "template": "term" },
    { "id": "index", "kind": "list", "path": "/glossary", "collection": "terms", "template": "index", "title": "Glossary" }
  ],
  "templates": { "classic": { "term": "…", "index": "…" }, "astro": { "term": "…", "index": "…" } },
  "components": { "badge": { "classic": "<span class=\"badge\">…</span>", "astro": "…" } },
  "structuredData": [{ "key": "publisher", "scope": "site", "node": { "@type": "Organization", "name": "Acme" } }]
}
```

- **Collections** (`ext:collections`) are installed per site under the plugin's namespace: `acme/glossary` gets
  `acme_glossary__terms` (shown as `acme_glossary.terms`). Two plugins never share a collection. Items go through the
  normal write path: versions, Hold, review and the publish guards (`items:publish:acme_glossary__terms` is still
  needed to publish). Disabling or uninstalling keeps the data. Deleting it for good is a separate action: the plugin
  disabled, an export (`GET /extensions/collections/:namespace/export`) made after the last item change, and the
  namespace typed as confirmation (`POST /extensions/collections/:namespace/purge`).
- **Routes** (`ext:routes`): an `item` route is the permalink of one of the plugin's collections (which needs a
  `slug` field); a `list` route lists its items, `pageSize` at a time, in every language. Enabling is refused with
  `409 ROUTE_CONFLICT` and the conflicting paths when a route collides with a system path, a language prefix, an
  existing item or redirect (a page at `/glossary/` conflicts with `/glossary/:slug`), a permalink or another
  plugin's route. While enabled, no other item may take its paths. The pages join the indexing decision, the
  sitemap (`"sitemap": false` keeps them out), `llms.txt` (`"llms": false`) and cache invalidation; disabling
  withdraws them from the next output (a static site at its next build).
- **Templates** are the default for each route in both engines. A route template is a full page: Classic Liquid that
  outputs `{% seo_head %}` once, an Astro component that places `@heopress/astro-kit/SeoHead.astro`. Both read the
  page data contract only (the View Model; `route` names the plugin route). A theme overrides one with its own
  `ext/<namespace>/<template>` template (Classic) or `heopress.astroTheme.extensionTemplates`
  (`{ "acme_glossary/term": "src/Term.astro" }`, Astro).
- **Components** (`ext:routes`) are fragments a theme may place: `{% include 'ext/acme_glossary/components/badge' %}`
  in Classic, `import Badge from 'heopress:ext/acme_glossary/badge'` in Astro. While no enabled plugin provides one,
  it renders nothing; a theme that does not place it shows no trace of the plugin.
- **No own head, script or JSON-LD.** Templates and components are refused at install when they carry a
  `<script>` (JSON-LD included), an event handler, a canonical, a robots tag, `<base>` or an iframe; Astro sources
  may import only `@heopress/astro-kit` and `heopress:ext/...`, and may not read the environment, fetch, load code
  dynamically or hydrate. Structured data goes through `structuredData` (`seo:structured-data`), merged by the core
  into the page's one graph and withdrawn when the plugin is disabled.

## Pipeline extensions

A plugin can add to the content pipeline (HeoPress P12, spec `extensions/pipeline-extensions`): a new source type, an
extra quality-gate check, a step of the static (Astro) build, and model calls. The manifest declares them; the source
adapters and gate checks are code the bundle registers under the same ids.

```json
{
  "name": "acme/jobs",
  "capabilities": ["ext:source-adapters", "http:fetch:jobs.example.com", "ext:gate-checks", "ai:generate"],
  "sourceAdapters": [{ "id": "board", "label": "Job board" }],
  "gateChecks": [{ "id": "salary", "label": "Salary stated", "collections": ["articles"], "timeoutMs": 5000 }]
}
```

```js
export default (ctx) => {
  ctx.extensionPoints.register('source-adapters', {
    id: 'board',
    async discover({ url, maxItems, signal, source }) {
      const res = await ctx.fetch(url, { signal }); // declared hosts only, through the outbound boundary
      const { jobs } = await res.json();
      return jobs.slice(0, maxItems).map((j) => ({ url: j.link, title: j.title, publishedAt: j.posted }));
    },
  });
  ctx.extensionPoints.register('gate-checks', {
    id: 'salary',
    check(draft) {
      // `draft` is a frozen copy: { collection, itemId, itemVersion, mode, locale, title, bodyHtml, fields, sources }.
      return /salary/i.test(draft.bodyHtml)
        ? { verdict: 'passed' }
        : { verdict: 'needs_review', evidence: { missing: 'salary' }, suggestions: ['State the salary range.'] };
    },
  });
};
```

- **Source adapters** (`ext:source-adapters`) only **discover**: `discover` returns links (a URL string or
  `{ url, title?, publishedAt? }`). The core records them once per site (normalised, tracking parameters removed,
  de-duplicated) and fetches each through the normal document pipeline (robots.txt, the outbound boundary, content
  de-duplication). The site's editors pick the type in **Sources** (`type: "plugin"`, `adapter: "acme/jobs#board"`);
  the source's address must be on one of the plugin's `http:fetch` hosts, and like every source it starts with
  licence `unknown` and usage `discovery_only`. A request to a host the plugin did not declare throws
  `CapabilityError`: the run fails as `blocked` and the refusal is recorded.
- **Gate checks** (`ext:gate-checks`) run after the core checks and are added to them; they can only make the verdict
  stricter. The verdict is `passed`, `blocked` or `needs_review` with optional `evidence` (JSON, at most 8 KB),
  `score` and `suggestions`. A check that is declared but not registered, throws, times out (`timeoutMs`, default
  5 s, at most 30 s) or gives no valid verdict counts as `needs_review`. Its result carries the rule
  `ext:<namespace>:<id>` and is never skippable by level. Enabling, disabling or changing a plugin's checks changes the
  gate policy: earlier results become stale.
- **Build steps** (`ext:build-steps`) run with the site's static build, after `astro build`: e.g. a PDF or a social
  image generator. They are trusted build code, not sandboxed plugin code, so a plugin's steps run only once the
  operator marked the plugin as trusted (marketplace plugins are not, by default); otherwise each build records them
  as skipped with the reason.

  ```json
  { "buildSteps": [{ "id": "pdf", "label": "PDF copy", "timeoutMs": 120000, "source": "import { writeFileSync } from 'node:fs'; …" }] }
  ```

  An Astro theme declares its own in `package.json`:
  `"heopress": { "astroTheme": { "buildSteps": [{ "id": "og", "script": "steps/og.mjs" }] } }`. A step runs as its
  own Node process with an environment built from nothing (no CMS secret or administrator credential):
  `HEOPRESS_PAGE_DATA_URL` / `HEOPRESS_PAGE_DATA_TOKEN` (the read-only page data interface), `HEOPRESS_BUILD_OUT_DIR`
  (the built site, read-only) and `HEOPRESS_BUILD_STEP_OUT_DIR` (where it writes; published with the build at
  `/_build/<theme | plugin namespace>/<step>/`). It may connect to the page data interface and the package registry
  only; any other host fails the build with the host named. It cannot start processes or workers, and is killed at its
  time limit (default 2 minutes, at most 10). A failing step fails the build; the live version stays.
- **Model calls** (`ai:generate`): `await ctx.ai.generate({ messages: [{ role: 'user', content: '…' }], system?,
  maxOutputTokens?, key? })` returns `{ content, usage, callId }`. The call goes through the site's model gateway with
  the `plugin` capability: one ledger entry per call, the site's monthly budget (over it the call fails with
  `BUDGET_EXCEEDED` before anything is sent), the site's own providers only — never the instance's shared key — and no
  tools. Output is capped at 4000 tokens. The same `key` replays the recorded answer instead of paying twice.

## Reference plugin: glossary

The official glossary plugin `heopress-glossary` (`packages/plugin-glossary`) uses every extension point above with
nothing but `@heopress/extension-sdk` and the capabilities its manifest declares: a term collection with term and index
routes (Classic and Astro templates), a `tooltip` component, `DefinedTerm` structured data, an event subscription that
links terms in article bodies after a publish and records the references, a batched `relink` job, a `citation` gate
check (a definition without a source needs review), and admin panels. It declares no `prePublishHooks`, so it never
blocks a publish. See its `README.md`; `apps/cms/src/__tests__/glossary-plugin.db.integration.test.ts` drives the packed
plugin end to end.

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

`node scripts/verify-plugin-package.mjs` (CI job `plugin-package`) is the acceptance of this path for the SDK and
the glossary plugin: both packed with `pnpm pack`, installed offline in a clean project outside the repository, then
installed (signed), run, upgraded, disabled and uninstalled on the built CMS in production mode.

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
