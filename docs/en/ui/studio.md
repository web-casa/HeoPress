# Studio

Studio is HeoPress's admin interface (ADR-0019, the "Carbon" design). It has a module rail on the left, a panel for the
module's sections, and the main area. On narrow screens the rail and the panel open as a drawer from the top bar. The
interface is available in Simplified Chinese and English (Settings › Appearance); theme and density are saved to the
account.

## Modules

| Module | Address | Shortcut | What it holds |
|---|---|---|---|
| Overview | `/overview` | `G` `O` | What needs attention on this site, or a read-only summary across your sites |
| Content | `/content` | `G` `C` | Review workspace, article editor, collections, media, translations |
| Sites | `/sites` | `G` `S` | Network topology, site list, domains |
| SEO / GEO | `/seo` | `G` `E` | Search appearance, AI crawler policy, machine-readable output, canonical domain, site identity, root files, redirects |
| AI traffic | `/ai-traffic` | `G` `A` | AI crawler visits and AI referrals |
| Audit | `/audit` | `G` `U` | Triage of site audit issues; internal links |
| Logs & monitoring | `/monitoring` | `G` `L` | Service status and a read-only event stream (site administrators) |
| Settings | `/settings` | `G` `,` | General, appearance, members & permissions, API & keys, license, advanced |

Every address sits under the server's private admin path (for example `/<admin-path>/overview`). Addresses of the
previous Studio redirect to their new place, query string kept.

## Working in Studio

- `⌘K` / `Ctrl K` searches and jumps to any view; `?` lists the shortcuts; `J` / `K` move through lists.
- Unsaved changes are asked about before leaving a page, a section or the site.
- Sections you may not open are not listed; opening one by its address says why.
- The article editor opens items of article collections: the preset `articles` collection and any collection marked
  "Edit as article" in Data model. Other collections use the generic form.
- With "reduce motion" set in the operating system, Studio does not animate.

## For developers

- New interface code lives in `apps/studio/src/workspace/`; its text is in `apps/studio/src/i18n/{zh-CN,en}/*.json`,
  one file per namespace, both languages with the same keys. Pages carried over from LumiBase are listed in the
  backlog for translation.
- Screenshot tests replay a recorded API (`apps/studio/e2e-visual/`): `pnpm --filter @heopress/studio visual`.
- The first screen's JavaScript budget and its measurement are described in the P07a benchmark notes.
