# `heopress`

[HeoPress](https://heopress.example) in one package — the JS/TS client plus the `heopress` CLI: generate TypeScript types from a live schema, check that your setup can reach the CMS, scaffold a project.

> **This is the client, not the server.** It talks to a HeoPress CMS you are
> already running. To run the CMS itself, use the image
> `ghcr.io/web-casa/heopress-cms` or the [monorepo](https://github.com/web-casa/HeoPress) —
> see [Deployment overview](https://docs.heopress.example/en/docs/deployment/overview).

```bash
npm install heopress
```

```ts
import { createHeoPressClient, readItems } from 'heopress';

const client = createHeoPressClient({ url: 'https://api.mysite.heopress.example', token, siteId });
const { data } = await client.request(readItems('articles', { limit: 10 }));
```

The library entry re-exports [`@heopress/sdk`](https://www.npmjs.com/package/@heopress/sdk) (REST + GraphQL + realtime, isomorphic ESM) — same client, one name to install. The CLI can also be run without installing:

```bash
npx heopress --help
```

## Commands

| Command | What it does |
| --- | --- |
| `heopress types` | Generate TypeScript types from a running CMS |
| `heopress doctor` | Report resolved configuration and probe connectivity |

## Connection settings

Resolved with precedence **flag > environment > `heopress.config.json`**:

| Setting | Flag | Environment | Config file |
| --- | --- | --- | --- |
| CMS base URL | `--url` | `HEOPRESS_URL` | `url` |
| Site / tenant id | `--site` | `HEOPRESS_SITE_ID` | `siteId` |
| Bearer token | `--token` | `HEOPRESS_TOKEN` | — |

The token is deliberately **not** readable from the config file — that file is meant to be committed. A `token` key there is rejected with an error rather than silently ignored.

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

The file is looked up from the working directory upward, so it works from any package inside a monorepo.

## `heopress types`

Fetches the collection manifest from `GET /api/v1/typegen/schema` and writes TypeScript definitions.

```bash
heopress types                                # -> heopress-types.d.ts
heopress types --out src/heopress-types.d.ts  # custom path (directories are created)
heopress types --include articles,authors     # subset of collections
heopress types --no-branded                   # plain string ids
heopress types --import-from @heopress/sdk    # module the generated file imports from (default: heopress)
heopress types --stdout                       # print instead of writing
```

The generated file imports its helper types from `heopress` by default — the package you already have installed. Use `--import-from` (or `typegen.importFrom` in the config file) if your project depends on `@heopress/sdk` directly.

Output is **deterministic** — no timestamp, host, or site id in the header — so the file can be committed and verified in CI:

```yaml
- run: npx heopress types --check
```

`--check` exits non-zero when the committed file is missing or stale, and never writes anything.

## `heopress doctor`

```
✔ node         v22.22.2
✔ config       /path/to/heopress.config.json
✔ url          http://localhost:1989 (from heopress.config.json)
✔ siteId       site_abc123 (from heopress.config.json)
✔ token        tok_••••••••3f (from environment)
✔ health       reachable — status: healthy
✔ schema       12 collections readable
```

Exits non-zero if any check fails. Tokens are masked — a short prefix is kept so you can tell *which* token was picked up without the value reaching CI logs.

## Requirements

Node.js 22+.

## Links

- Documentation — <https://docs.heopress.example>
- Issues — <https://github.com/web-casa/HeoPress/issues>

Apache-2.0
