---
title: HeoPress CLI
version: 7
lastUpdated: 2026-10-10T04:59:28.224Z
sourceLang: en
contentHash: 9ea8177149217720
codeVerified: 2026-10-13T19:22:01.232Z
codeVerifiedHash: 9ea8177149217720
codeVerifiedClaims: 20
---

# HeoPress CLI

> `heopress` — the JS/TS client and the CLI in one package: generate types from a live schema, check your setup, scaffold a project.

The unscoped package `heopress` (`packages/cli/`) is both a library and a CLI. Its library entry (`src/lib.ts`) re-exports `@heopress/sdk`, so a project needs one name in `dependencies` for the runtime client and the `heopress` command:

```bash
npm install heopress
```

```ts
import { createHeoPressClient, readItems } from 'heopress';
```

`@heopress/sdk` stays the underlying package — `heopress` depends on it rather than bundling it, so a project that imports both gets one copy of every class (`HeoPressError` `instanceof` checks) and one set of types. The library entry has no Node-specific code and is safe to import from browser and edge bundles.

The CLI can also be run ad hoc:

```bash
npx heopress --help
```

Node.js 22+ is required for the CLI; the launcher in `packages/cli/bin/heopress.js` refuses older runtimes before loading the ESM graph.

## Commands

| Command | What it does |
| --- | --- |
| `heopress types` | Generate TypeScript types from a running CMS |
| `heopress doctor` | Report resolved configuration and probe connectivity |

`heopress help` and `heopress version` are also accepted, as are `--help` / `-h` and `--version` / `-v`.

## Connection settings

Every command that talks to a CMS resolves three settings with precedence **flag > environment > config file**:

| Setting | Flag | Environment | `heopress.config.json` |
| --- | --- | --- | --- |
| CMS base URL | `--url` | `HEOPRESS_URL` | `url` |
| Site / tenant id | `--site` | `HEOPRESS_SITE_ID` | `siteId` |
| Bearer token | `--token` | `HEOPRESS_TOKEN` | — |

The token is deliberately **not** readable from the config file, because that file is meant to be committed. A `token` key there is rejected with an error rather than silently ignored — see `readConfigFile` in `packages/cli/src/config.ts`.

```json
{
  "url": "https://api.mysite.heopress.example",
  "siteId": "site_abc123",
  "typegen": {
    "out": "src/heopress-types.d.ts",
    "exclude": ["internal_logs"]
  }
}
```

The config file is looked up from the working directory upward until the filesystem root, so it resolves from any package inside a monorepo.

Requests are sent with `Authorization: Bearer <token>` and `X-HeoPress-Site: <siteId>` — the same headers the SDK client uses.

## `heopress types`

Fetches the collection manifest from `GET /api/v1/typegen/schema` (served by `apps/cms/src/routes/typegen.ts`) and renders it with `generateTypes` from `@heopress/sdk`.

```bash
heopress types                                # -> heopress-types.d.ts
heopress types --out src/heopress-types.d.ts  # custom path; directories are created
heopress types --include articles,authors     # only these collections
heopress types --exclude internal_logs        # skip these collections
heopress types --no-branded                   # plain string ids instead of branded ones
heopress types --import-from @heopress/sdk    # module the generated file imports from
heopress types --stdout                       # print instead of writing a file
```

The generated file imports its helper types (`ID`, `Locale`, `Brand`) from `heopress` by default (`DEFAULT_IMPORT_FROM` in `packages/cli/src/commands/types.ts`) — the package a project running this command already has installed. A project that depends on the SDK directly can point the import elsewhere with `--import-from @heopress/sdk` or `typegen.importFrom` in `heopress.config.json`; the module named must be installed in the project consuming the types.

### Deterministic output and `--check`

The generated header carries no timestamp, host, or site id. Two machines pointed at the same schema produce byte-identical files, which makes the output safe to commit and verify in CI:

```yaml
- run: npx heopress types --check
```

`--check` exits non-zero when the file is missing or stale, and never writes anything. Without `--check`, an unchanged file is left untouched rather than rewritten, so watchers do not rebuild for nothing.

## `heopress doctor`

Prints what was resolved, where each value came from, and whether the CMS answers:

```
✔ node         v22.22.2
✔ config       /path/to/heopress.config.json
✔ url          http://localhost:1989 (from heopress.config.json)
✔ siteId       site_abc123 (from heopress.config.json)
✔ token        tok_••••••••3f (from environment)
✔ health       reachable — status: healthy
✔ schema       12 collections readable
```

The health probe calls the unauthenticated `/health` endpoint (`apps/cms/src/routes/health.ts`); the schema check exercises the same authenticated request `heopress types` makes, so a green `doctor` means typegen will work. Tokens are masked: a short prefix is kept so an operator can tell which token was picked up without the value reaching CI logs.

`doctor` exits non-zero if any check fails.

## Related

- [SDK — typegen](../sdk/typegen.md) — the programmatic API behind `heopress types`
- [Local development](../deployment/local-development.md) — running the CMS and Studio this CLI points at
- [npm publishing](../release/npm-publishing.md) — how the package is released
