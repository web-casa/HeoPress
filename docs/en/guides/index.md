---
version: 1
lastUpdated: 2026-10-29T11:51:38.611Z
sourceLang: zh-CN
translatedFrom: zh-CN
sourceHash: 380d22512c4649ae
mtEngine: manual
syncStatus: human-translated
---

<!-- check-parity: allow bulk -->
<!-- Recorded by stamp-pair --allow-structure-drift on 2026-10-29T11:51:38.611Z. See commit history for rationale. -->

# HeoPress documentation

HeoPress is an AI-native open-source CMS for networks of 10–100 sites on their own domains: one instance runs many sites;
ingestion, translation, rewriting and the quality gate are done by deterministic pipelines and governed AI, and a draft
that does not meet every condition goes to human review; external agents connect over MCP, authorized per user and per
site. The backend needs one VPS and PostgreSQL 18.

Pick the entry point for your role:

| Reader | Entry point | Covers |
|---|---|---|
| Editors, site administrators, network operators | [User guide](users.md) | Studio, sites and domains, content and review, SEO / GEO, the AI content pipeline, external agents, import, publishing |
| Plugin, theme and integration developers | [Developer guide](developers.md) | Architecture, the Extension SDK and plugins, themes, REST / GraphQL / MCP, codemods, contributing |
| Operators who deploy and run an instance | [Operations guide](operations.md) | Installation, configuration, backup and restore, upgrades, data retention, frontend deployment targets, security |

## Conventions

- Simplified Chinese (`docs/zh-CN/`) is the default language and English (`docs/en/`) the second. This page and the
  three guides are kept aligned in both languages; some topic reference pages exist in Chinese only, and the English
  guides mark those links.
- `docs/en/` still holds part of the reference documentation inherited from upstream LumiBase. Where it disagrees with
  the three guides or the topic pages they link to, the guides win. The upstream Cloudflare Workers runtime has been
  removed; Redis, MinIO, MeiliSearch and imgproxy are no longer required.
- Source paths, environment variables and API routes named in the docs are checked against the code by
  `pnpm docs:i18n:verify`; the structure of the two languages is checked by `pnpm docs:i18n:parity`.

## Version and licences

- These docs describe HeoPress v1.0.0. The version history is in `CHANGELOG.md` and `release/RELEASES.md`.
- HeoPress is licensed under AGPL-3.0-only (`LICENSE`), with a commercial licence available (`COMMERCIAL-LICENSE.md`). Plugins and themes that interact with the system only through the public plugin API fall under the plugin and theme exception (`LICENSE-EXCEPTION.md`).
- The public interface packages (`@heopress/sdk`, `@heopress/extension-sdk`, `@heopress/contracts`, `@heopress/astro-kit` and others) are Apache-2.0; the `LICENSE` in each package directory is authoritative.
- HeoPress is a hard fork of upstream LumiBase (Apache-2.0); the upstream parts keep their licence and notices (`LICENSES/Apache-2.0.txt`, `NOTICE`, `UPSTREAM.md`).
- External contributions require signing the contributor licence agreement (`CLA.md`); see "Contributing" in the [Developer guide](developers.md).
