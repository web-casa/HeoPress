# `@heopress/plugin-glossary`

The official HeoPress glossary plugin (`heopress-glossary`) and the reference plugin of the extension points
(ADR-0015). It is written only against `@heopress/extension-sdk` and the capabilities its manifest declares; read it
as a worked example when writing your own plugin.

## What it does

| Feature | Extension point | How |
|---|---|---|
| Term collection `terms` (`heopress_glossary__terms`): title, slug, locale, short definition (`excerpt`), body, aliases, source | `ext:collections` | manifest `collections` |
| Term pages `/glossary/:slug` and the index `/glossary`, Classic and Astro templates | `ext:routes` | manifest `routes`, `templates` |
| `DefinedTerm` structured data on each term page | `seo:structured-data` | manifest `structuredData` |
| Theme component `tooltip`: the term's definition card | theme components | manifest `components` |
| Term links in article bodies, updated after each publish; term references recorded | `ext:events` | subscription `link-on-publish` |
| Periodic recomputation of every published article, one batch per run | `ext:jobs` | job `relink` (every 6 hours, or queued when a term changes) |
| A term definition without a source citation needs review | `ext:gate-checks` | gate check `citation` |
| Term references table, count widget, settings | `ext:admin-panels` | manifest `admin`, `storage` |

It declares **no pre-publish hook** (`prePublishHooks`), so it never blocks a publish, even when its bundle fails to
load.

### Links and tooltips

There is no render-time extension point, so the plugin writes the links into the stored body, through the normal write
path (`ctx.items.patch`: a new version, Hold, the publish guards and other plugins' pre-publish hooks apply). Each link
is `<a href="/glossary/<slug>/" title="<definition>" data-heopress-glossary="<slug>">…</a>`: the first occurrence of
each term (or alias), whole words for spaced scripts, never inside links, code, preformatted text or headings. The
marker attribute lets the plugin find and replace its own links on the next run (the public body drops it); the
`title` is the tooltip readers see. A theme can place the `tooltip` component; it renders the definition card on a
term's own page and nothing elsewhere.

Term URLs come from the plugin's settings (`locale_prefixes`, `trailing_slash`), which should match the site's
content settings.

## Build

```bash
pnpm --filter @heopress/plugin-glossary build    # dist/index.js + the templates/ sources into heopress-extension.json
node scripts/build.mjs --check                   # fails when heopress-extension.json is out of date with templates/
pnpm --filter @heopress/plugin-glossary test
```

`dist/index.js` is one ES module with no run-time import: what the host loads and a signature covers.
`heopress-extension.json` is the manifest an install or the marketplace reads.

## Licence

Apache-2.0 (see `LICENSE` and `NOTICE`).
