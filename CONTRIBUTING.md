# Contributing to HeoPress

Thanks for helping. This file is the short version: what you need, what a pull request must satisfy, and where the
details live.

HeoPress is a multi-tenant Content Operating System (a CMS for a network of independent sites) under
**AGPL-3.0-only** with a commercial-licence option. Contributions are accepted under the
[Contributor License Agreement](CLA.md).

## Read first

- [Development setup and conventions](docs/en/contributing/index.md) — prerequisites, code style, testing, the PR process.
- [AGENTS.md](AGENTS.md) — the project protocol: how requirements are written (OpenSpec), how changes land, and the
  invariants a change must not break. Humans and AI agents follow the same rules.
- [SECURITY.md](SECURITY.md) — how to report a vulnerability **privately**. Never open a public issue for a security
  problem.
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) — expected behaviour in issues, discussions and reviews.

## Quick start

| Tool | Version |
| --- | --- |
| Node.js | **24 LTS** (`engines.node` is `>= 24`; 22 will not install) |
| pnpm | **9.12** (`packageManager` in `package.json`; `corepack enable` is the easiest way) |
| Docker + Compose | for the PostgreSQL 18 development database |

```bash
corepack enable
pnpm install
docker compose -f docker/docker-compose.yml up -d postgres
export DATABASE_OWNER_URL=postgresql://heopress:heopress_dev@localhost:5432/heopress
DATABASE_URL=$DATABASE_OWNER_URL pnpm db:migrate
DATABASE_URL=$DATABASE_OWNER_URL HEOPRESS_APP_PASSWORD=heopress_app_dev \
  pnpm --filter @heopress/database app-role
export DATABASE_URL=postgresql://heopress_app:heopress_app_dev@localhost:5432/heopress
pnpm dev
```

`docs/en/contributing/index.md` explains what each step does and why the development database uses the restricted
`heopress_app` role rather than the owner.

## Sign the CLA once

Before we can merge your first pull request, sign [CLA.md](CLA.md) (the agreement is how the project can keep
offering HeoPress under AGPL-3.0 *and* a commercial licence while you keep the copyright in your work). Comment on
your pull request that you have read and accept it; the maintainers record the acceptance in the repository. A pull
request without a recorded CLA acceptance cannot be merged.

## What a pull request must satisfy

- **One topic per PR.** Unrelated cleanups make a security change impossible to review.
- **Conventional commits** (`feat(studio): …`, `fix(cms): …`, `docs(api): …`), English.
- **Tests.** New or changed behaviour needs a test that fails without your change. Bug fixes need a regression test.
- **Both documentation locales.** A user-facing doc change lands in `docs/en/` and `docs/zh-CN/` in the same commit;
  `node scripts/docs-i18n/stamp-pair.mjs <path> <en|zh-CN>` records the pair. Details in the contributing guide.
- **Migrations.** Only generated migrations (`pnpm db:generate`); backward-compatible for at least one release
  (nullable/defaults first, backfill separately, destructive drops later).
- **Green CI.** The `CI` workflow (type check, unit tests, lint, static checks) and the database suites must pass.
  `main` is protected: a PR needs passing required checks and one maintainer review.
- **No secrets, no real domains.** Fixtures and docs use reserved domains (`example.com`, `example.cn`).

Run `pnpm quality:fast` before you push (workspace checks, type check, lint, unit tests); `pnpm check:all` is what
CI runs on top of that.

## Writing a change that needs a specification

Behaviour changes are specified before they are coded: an OpenSpec change under `openspec/changes/<change>/`
(`proposal.md`, `design.md`, `tasks.md`, `specs/`), validated with
`npx -y @fission-ai/openspec@1.14.1 validate <change> --strict`. The archived specifications under `openspec/specs/`
describe what the system currently promises. AGENTS.md §2–6 has the workflow.

## Project layout

| Path | Contents |
| --- | --- |
| `apps/cms` | Hono API and the CMS runtime |
| `apps/studio` | the administration SPA |
| `apps/site-classic`, `apps/site-astro` | the two public rendering engines |
| `packages/database` | Drizzle schema and migrations (the only source of truth for tables) |
| `packages/contracts`, `packages/extension-sdk` | shared schemas, types, and what plugins may use |
| `packages/runtime` | cache, queue, storage and search adapters |
| `examples/` | official plugins and themes |
| `docs/en`, `docs/zh-CN` | user, operator and developer documentation (both locales ship) |
| `openspec/` | requirements: `changes/` in progress, `specs/` the current contract |

## Questions

Open a discussion or an issue titled with the area (`cms`, `studio`, `extensions`, `docs`). For a security problem,
use the private channel in [SECURITY.md](SECURITY.md) instead.
