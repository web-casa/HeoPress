---
version: 2
lastUpdated: 2026-10-29T14:08:52.949Z
sourceLang: zh-CN
translatedFrom: zh-CN
sourceHash: 7ab77f03262fc5e1
mtEngine: manual
syncStatus: human-translated
---

# Developer guide

For developers of plugins, themes and integrations, and for contributors to HeoPress itself. Using the features is
covered in the [User guide](users.md), deployment in the [Operations guide](operations.md).

## 1. Architecture overview

HeoPress is a pnpm monorepo (Node.js 24, TypeScript). Its only required external service is PostgreSQL 18: caching,
rate limiting, queues and scheduled jobs all live in the database.

| Component | Path | Role |
|---|---|---|
| CMS | `apps/cms/` | The Hono API, the Studio host and background work; one image runs in roles set by `HEOPRESS_PROCESS_ROLE` (`web`, `worker`, `all`) |
| Studio | `apps/studio/` | The admin SPA (React + Vite); it reaches the CMS only through the public contracts and the SDK |
| Rendering service | `apps/site-classic/` | The Classic engine: one process serves every site by domain and reads the public projection through a read-only database role |
| Astro build | `apps/site-astro/` | Per-site static builds for the Astro engine |
| Database | `packages/database/` | Drizzle table definitions (the single source of truth) and the generated migrations |
| Contracts | `packages/contracts/` | Zod validation, shared types, the theme page-data contract, extension point limits |
| Runtime | `packages/runtime/` | The outbound boundary and the storage, cache, queue and search adapters |
| Public site | `packages/public-site/` | The theme engine, path resolution, the starter themes |

Rules that hold throughout:

- **Multi-tenancy**: every domain table has a `site_id`; the runtimes connect as a non-owner application role (the
  row-level security policies are not yet in the default migrations); public pages never read the content tables, only
  the public projection maintained in the same transaction.
  See [Public projection and the rendering role](../../zh-CN/rendering/public-projection.md) (Chinese).
- **Change events**: every content write records its change event in the same transaction; cache invalidation,
  translation freshness, IndexNow, the internal link graph and others are event consumers.
  See [Event consumers](../architecture/event-consumers.md).
- **Outbound requests**: every HTTP request to another system goes through the single `outboundFetch` boundary (SSRF
  protection, addresses checked when connecting).
  See [Outbound requests](../security/outbound-requests.md).
- **AI and approval**: every model call goes through the site's model gateway and is accounted for; agents, API keys
  and MCP tools can neither approve drafts nor approve batch plans.

## 2. Plugins and the Extension SDK

A plugin depends only on `@heopress/extension-sdk` (Apache-2.0) and runs in a capability sandbox: no direct access to
the database, environment variables or host files; items are read and written through the host's item service with the
requesting user's permissions; network requests go only to declared hosts. On install an administrator approves each
capability the plugin asks for; an upgrade that adds a capability needs approval again; outside development mode only
bundles signed by a registered publisher key are installed and loaded.

| Extension point group | What it covers |
|---|---|
| Content | The plugin's own collections, public routes, templates and components (data in the manifest; no plugin code runs in a renderer) |
| Runtime | Scheduled and queued jobs, public form and callback endpoints, content event subscriptions, private storage, admin panels |
| Pipeline | Source adapters, quality gate checks, build steps, AI calls through the site's model gateway |
| Pre-publish hooks | Receive a frozen copy before publishing and can only veto, never change it |

- Capabilities, the manifest, signing and every extension point in full: [Extension Development Guide](../contributing/extension-dev.md), [Plugin development](../../zh-CN/extensions/plugin-development.md) (Chinese)
- Starter template: `examples/plugin-template` (depends only on the packed Extension SDK; `scripts/verify-plugin-template.mjs` checks it in CI)
- Reference plugin: the glossary plugin, `packages/plugin-glossary`
- Packaging and signing: `heopress-ext keygen`, `heopress-ext sign`, `heopress-ext verify` (`packages/extension-cli/src/cli.ts`)

## 3. Themes

| Kind | What it is | Guide (Chinese) |
|---|---|---|
| Liquid theme (Classic engine) | Liquid templates plus static assets that see only the page-data contract (`packages/contracts/src/theme/index.ts`); the body, SEO head, sponsor disclosure and JSON-LD are output only through system tags. Uploaded, checked, published and rolled back by version | [Theme guide](../../zh-CN/rendering/theme-guide.md), [Theme engine and sandbox](../../zh-CN/rendering/theme-engine.md) |
| Astro theme (Astro engine) | A standard Astro component package whose data comes only from the page-data contract (`packages/contracts/src/theme/page-data.ts`); system content is placed with the components of `@heopress/astro-kit` | [Porting an Astro site to a theme](../../zh-CN/rendering/astro-theme-porting.md) |

The starter themes (news, tech, minimal) are in `packages/public-site/src/theme/starters.ts` and are a starting point for your own; an example Astro theme is in `examples/astro-themes`.

## 4. API, SDK and MCP

- **REST**: a JSON API under `/api/v1/`; requests carry `Authorization: Bearer <token>` and the site header `X-HeoPress-Site: <site-id>`, and responses are `{ data, meta? }` or `{ errors: [...] }`.
  The general endpoints inherited from upstream (auth, items, files, Flows and so on) are in the [Hono API Specification](../api/hono-api-spec.md);
  the endpoints HeoPress added are documented on each topic page. `docs/openapi.yaml` describes only part of the API.
- **GraphQL**: `/api/v1/graphql` (the `graphql` feature must be on).
- **Client and CLI**: `@heopress/sdk` (the JS/TS client) and the `heopress` package (client plus a type-generation CLI). See [JavaScript SDK](../sdk/javascript.md), [HeoPress CLI](../cli/index.md).
- **MCP**: external agents use `POST /api/v1/agents/mcp` (Streamable HTTP, OAuth 2.1 / personal access tokens, authorized per site and tool group).
  See [MCP authorization](../../zh-CN/agents/mcp-authorization.md), [MCP tool reference](../../zh-CN/agents/mcp-tools.md), [MCP protocol versions and client compatibility](../../zh-CN/agents/mcp-compatibility.md), [Official Skills](../../zh-CN/agents/skills.md) (Chinese).

## 5. Upgrading plugins: codemods

Breaking changes to the plugin API are listed in the release notes. The part that can be converted deterministically
is rewritten by a codemod (keeping formatting and comments); the rest is reported as manual steps:

```bash
heopress-ext codemod --list
heopress-ext codemod --dir ./my-plugin
heopress-ext codemod --dir ./my-plugin --write
```

v1.0 ships `lumibase-to-heopress` (LumiBase Extension SDK 0.x → HeoPress 1.0). The framework is in `packages/extension-cli/src/codemods/framework.ts`;
the list of changes and the exit codes are in [Upgrades](../../zh-CN/operations/upgrades.md) (Chinese).

## 6. Contributing

```bash
docker compose -f docker/docker-compose.yml up -d postgres
export DATABASE_URL=postgresql://heopress:heopress_dev@localhost:5432/heopress
pnpm install
pnpm db:migrate
pnpm dev
```

- Development protocol, code layout and conventions: `AGENTS.md` at the repository root; setup and the PR process: [Contributing Guide](../contributing/index.md), [Testing Guide](../contributing/testing.md).
- Quality commands: `pnpm quality:fast` (typecheck, lint, unit tests), `pnpm quality:pr` (the PR gate; needs an isolated PostgreSQL 18), `pnpm quality:release` (before a release), defined in `scripts/quality.mjs`.
- Database: generated migrations only (change `packages/database/src/schema/`, then `pnpm db:generate`); the `lumibase_` prefix of tables and migrations is kept by design.
- Dependencies must use permissive licences (MIT, BSD, Apache-2.0, ISC and the like), checked by `pnpm licenses:check`; modified upstream files keep their modification notice (`pnpm notices:check`).
- Docs: Chinese is the default language; when you change a paired doc, update the other language and pass `pnpm docs:i18n:parity` and `pnpm docs:i18n:verify`. See [Docs i18n](../contributing/docs-i18n.md).
- External contributions: open a PR in the public repository `web-casa/HeoPress`; it needs a signed CLA and a green public CI. The maintainers apply a reviewed PR to the development repository as a patch, keeping the author's credit, and it ships with the next release.
  The release pipeline and the backport process are described in [Public releases and external PR backports](../../dev/release.md) (Chinese), the security scans in [Security scanning](../../dev/security-scanning.md) (Chinese).
