---
version: 9
lastUpdated: 2026-10-08T08:10:04.303Z
sourceLang: en
contentHash: 09f2a59d9751b976
codeVerified: 2026-10-08T08:10:04.303Z
codeVerifiedHash: 09f2a59d9751b976
codeVerifiedClaims: 6
---

# Dependency Overrides & Patches

This document tracks every `overrides` pin, `patchedDependencies` patch, and
`auditConfig.ignoreGhsas` exclusion, why each exists, and the condition under which it
can be safely removed.

**All three are declared twice, on purpose.** pnpm 9 — the pinned version — reads them
from the `pnpm` key in root [`package.json`](../../../package.json). pnpm 10+ reads them
from [`pnpm-workspace.yaml`](../../../pnpm-workspace.yaml) instead, warning once about
the `package.json` key before ignoring it. Keeping both means a future pnpm bump does not
silently drop the security overrides, the `gray-matter` patch, or the audit ignore
(#295). `pnpm settings:check` fails CI when the two copies drift; when pnpm 9 support
ends, delete the `pnpm` key from `package.json` and that script with it.

> **Why this file exists:** overrides and patches are invisible footguns — they silently
> change what version of a transitive dependency the whole workspace resolves. Without a
> record of *why*, a future maintainer can't tell a deliberate security pin from leftover
> cruft, and removing one can silently reintroduce a vulnerability. Update this table
> whenever you add, change, or remove an entry — **in both files**.

## How overrides work here

- **`overrides`** force a single resolved version of a package across the entire
  workspace, including transitive dependencies that requested a different (often
  vulnerable) range.
- **`patchedDependencies`** apply a local source patch to an installed package.
  Patches live in [`patches/`](../../../patches/) and are referenced by exact version.
  Regenerate with `pnpm patch <pkg>@<version>` → edit → `pnpm patch-commit <dir>`.
- **`auditConfig.ignoreGhsas`** / **`auditConfig.ignoreCves`** exclude a specific advisory
  from a local `pnpm audit`. The security scans in
  [`security.yml`](../../../.github/workflows/security.yml) and the release gate audit
  without them, so an ignored advisory is still reported there and judged against the
  exceptions. Use an ignore **only** when the advisory is structurally inapplicable to how
  we consume the package and no patched version is installable — never to silence a real
  risk. Every entry needs a row below **and** a `pnpm-audit` exception in
  [`security/exceptions.json`](../../../security/exceptions.json) (owner, covered versions,
  reason, review deadline); without one, or once its deadline has passed, the scans fail.

After changing either, run `pnpm install` so the lockfile (`pnpm-lock.yaml`) records the
new resolution / patch hash, then `pnpm settings:check` to confirm the two declarations
still agree.

## Overrides registry

| Package | Pinned to | Reason | Remove when |
| --- | --- | --- | --- |
| `js-yaml` | `^4.3.2` | [CVE-2026-53550](https://github.com/advisories/GHSA-h67p-54hq-rp68) — quadratic-complexity DoS in YAML merge-key handling (moderate), [GHSA-mxjm-jjmh-r63x](https://github.com/advisories/GHSA-mxjm-jjmh-r63x) — quadratic CPU consumption resolving `!!omap`, unpatched below `4.3.1` (high), and [GHSA-2883-xcg3-v3hh](https://github.com/advisories/GHSA-2883-xcg3-v3hh) — `maxTotalMergeKeys` does not bound CPU for empty merge sources, unpatched below `4.3.2` (high). Pulled in transitively by `gray-matter@4.0.3`, which hard-pins js-yaml 3.x. See the patch note below. | `gray-matter` (or whatever consumes it) depends on js-yaml `>=4.2.0` directly, **and** no other dependency reintroduces a 3.x range. Verify with `pnpm why js-yaml`. |
| `dompurify` | `^3.4.17` | Security advisory (resolved via Dependabot), then raised for [GHSA-8v5p-ggcr-6q56](https://github.com/advisories/GHSA-8v5p-ggcr-6q56) — an `IN_PLACE` hook removal leaves a detached subtree, allowing sanitizer bypass at `<=3.4.12` (moderate), again for [GHSA-p98j-92pf-mc4p](https://github.com/advisories/GHSA-p98j-92pf-mc4p) / [GHSA-6688-9rhm-gjv2](https://github.com/advisories/GHSA-6688-9rhm-gjv2), unpatched below `3.4.16` (low), and again for [GHSA-cg2g-xh64-v4q7](https://github.com/advisories/GHSA-cg2g-xh64-v4q7) (critical) / [GHSA-mrv2-3pqr-j5jr](https://github.com/advisories/GHSA-mrv2-3pqr-j5jr) (high), unpatched below `3.4.17` (found by the P07 nightly security scan's `pnpm audit`). | A direct/transitive consumer requires `>=3.4.17` on its own. |
| `esbuild` | `^0.28.2` | esbuild dev-server request RCE advisory (`<=0.24.2`). | All consumers (vite, tsx, etc.) require `>=0.28.2`. |
| `form-data` | `^4.0.6` | Security advisory (unsafe random boundary). | All consumers require `>=4.0.6`. |
| `postcss` | `^8.5.26` | Security advisory (resolved via Dependabot). | All consumers require `>=8.5.26`. |
| `nanoid@3` | `^3.3.17` | [GHSA-2v37-7h3g-55p8](https://github.com/advisories/GHSA-2v37-7h3g-55p8) — a custom generator loops indefinitely when `size` is zero, unpatched below `3.3.17` (high). Reached only transitively: `next` → `postcss` → `nanoid@3`. Scoped to the 3.x range so it cannot raise the floor for the 6.x line `apps/cms` and `packages/database` declare directly. | `postcss` (or whatever consumes it) requires `nanoid >=3.3.17`. Verify with `pnpm why nanoid`. |
| `undici` | `^7.30.1` | Security advisory (resolved via Dependabot), then raised for [GHSA-xjj6-f33q-929c](https://github.com/advisories/GHSA-xjj6-f33q-929c) — DoS via an unhandled error on excessive content-encodings, unpatched below `7.30.1` (high; found by the public-mirror security scan's `pnpm audit`). | All consumers require `>=7.30.1`. |
| `body-parser@2` | `^2.4.0` | [GHSA-27r3-jxmh-p828](https://github.com/advisories/GHSA-27r3-jxmh-p828) — DoS via trailing bytes after a compressed request body, unpatched below `2.4.0` (high). Reached through `packages/mcp-server` → `@modelcontextprotocol/sdk` → `express@5.2.1`. Scoped to the 2.x line. | `express` requires `body-parser >=2.4.0`. Verify with `pnpm why -r body-parser`. |
| `zod@4` | `^4.6.6` | [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) — memory exhaustion validating oversized constrained collections, unpatched below `4.6.6` (high). A `4.6.5` copy is reached through `@modelcontextprotocol/sdk`, `eslint-plugin-react-hooks` and `knip`. Scoped to the 4.x line. | Every consumer resolves `zod >=4.6.6` on its own. Verify with `pnpm why -r zod`. |
| `ws` | `^8.22.0` | Security advisory (resolved via Dependabot). Declared directly by `apps/cms` for the realtime surface. | `apps/cms` declares `>=8.22.0` itself. |
| `uuid` | `^14.0.1` | Version unification / advisory (resolved via Dependabot). Only one import site exists (`apps/cms/src/modules/audit/worker.ts`, `v7`), so the major carries little surface — but v12+ reshaped the package `exports` map, so bumping it needs a real bundle check, not just a typecheck. | Version drift across packages is no longer a concern. |
| `vite` | `^8.3.2` | Unify on one Vite major and pull esbuild past the `0.28.1` RCE advisory. **This entry is why `pnpm drift:check` exists:** it sat at `^7.3.5` while `apps/studio` and `apps/docs` both declared `^8.1.3`, and because overrides apply to direct dependencies too, both apps were built with Vite 7 for as long as their manifests claimed Vite 8. Raise this in step with the manifests or the bump is cosmetic. | The workspace no longer needs a single forced Vite major. |
| `brace-expansion@1` | `^1.1.16` | [GHSA-3jxr-9vmj-r5cp](https://github.com/advisories/GHSA-3jxr-9vmj-r5cp) — DoS via exponential-time expansion of consecutive non-expanding `{}` groups (high), backported to the 1.x line in `1.1.16`. **Dev-only** — reached through `minimatch@3` from ESLint and its plugins, so it never appears in `pnpm audit --prod`. Keyed per-major (same shape as the `nanoid@3` scope) because two incompatible majors coexist; see [Known-unfixable alerts](#known-unfixable-alerts) for why 1.x cannot be folded into 5.x. | Nothing in the tree resolves `minimatch@3` any more (`pnpm why brace-expansion -r`), at which point both `brace-expansion@*` rows collapse into one. |
| `brace-expansion@5` | `^5.0.8` | [GHSA-mh99-v99m-4gvg](https://github.com/advisories/GHSA-mh99-v99m-4gvg) — DoS via unbounded expansion length causing an OOM process crash (high), patched in `5.0.8`. **Dev-only** — reached through `minimatch@10` from `glob`, `eslint`, `@typescript-eslint/typescript-estree`. Natural drift already lifted most of the tree to `5.0.9`, but `minimatch@10.2.5` still pinned a `5.0.7` copy; this floor removes that straggler. | Same as the `@1` row. |
| `proxy-addr` | `^2.0.8` | [GHSA-jqcg-44mw-7w3h](https://github.com/advisories/GHSA-jqcg-44mw-7w3h) (critical), unpatched below `2.0.8`. Reached through `packages/mcp-server` → `@modelcontextprotocol/sdk` → `express@5.2.1`, which declares `^2.0.7`. | `express` requires `proxy-addr >=2.0.8`. Verify with `pnpm why -r proxy-addr`. |
| `seroval` | `^1.7.3` | [GHSA-97r2-qh9m-474h](https://github.com/advisories/GHSA-97r2-qh9m-474h), [GHSA-wp97-x4hv-qvhp](https://github.com/advisories/GHSA-wp97-x4hv-qvhp), [GHSA-7rv5-mrxv-xcr9](https://github.com/advisories/GHSA-7rv5-mrxv-xcr9) — `fromJSON` / `fromCrossJSON` deserialization DoS and attacker-chosen callables, unpatched below `1.6.8` (high; found by the public-mirror security scan's `pnpm audit`). Reached through `apps/studio` → `@tanstack/react-router` → `@tanstack/router-core`, which declares `^1.6.7` (no router release requires a patched version, so bumping the router does not help); the lockfile had resolved `1.6.7`. Floor set to the current `1.7.3`. Studio is a client-only SPA and never deserializes router state from the server, so the advisories were not reachable there, but the scans judge the installed version. | `@tanstack/router-core` requires `seroval >=1.6.8`. Verify with `pnpm why -r seroval`. |
| `seroval-plugins` | `^1.7.3` | **Not a security pin** — keeps `seroval-plugins` (also from `@tanstack/router-core`) on the same release line as the `seroval` override above; the two packages are released together. | Removed together with the `seroval` row. |
| `source-map-js` | `^1.2.2` | [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q) (high), unpatched below `1.2.2`. Reached through `postcss` (`next`, `vite`) and `css-tree` (`jsdom`). | `postcss` and `css-tree` require `>=1.2.2`. |
| `@graphql-tools/utils@11` | `^12.0.3` | [GHSA-7mx3-vvmw-hjmv](https://github.com/advisories/GHSA-7mx3-vvmw-hjmv) — prototype pollution in `mergeDeep` (high), affecting `<=12.0.0` with **no 11.x backport**. `graphql-yoga@5.24` (used by `apps/cms`) still declares `^11.2.0`, so this lifts that copy across a major. Scoped to the `@11` selector so 12.x consumers resolve on their own. Verified by the CMS GraphQL tests plus a `createYoga` smoke run (variables, masked errors, validation, introspection). | `graphql-yoga` declares `@graphql-tools/utils >=12.0.1`. |
| `fast-uri` | `4.1.5` | [GHSA-qw65-cvwx-89v3](https://github.com/advisories/GHSA-qw65-cvwx-89v3) / [GHSA-58mr-gqgx-xq4g](https://github.com/advisories/GHSA-58mr-gqgx-xq4g) (high, fixed by the earlier `4.1.4` pin), then [GHSA-hrr3-gc8f-f4qj](https://github.com/advisories/GHSA-hrr3-gc8f-f4qj) / [GHSA-jvvf-x445-j334](https://github.com/advisories/GHSA-jvvf-x445-j334) (moderate), unpatched below `4.1.5`. Exact pin kept from the original fix. Reached through `ajv`. | `ajv` requires `fast-uri >=4.1.5`. |
| `qs` | `^6.16.0` | [GHSA-x5fp-wj9c-mxmx](https://github.com/advisories/GHSA-x5fp-wj9c-mxmx) / [GHSA-4mjr-xmp4-gh2g](https://github.com/advisories/GHSA-4mjr-xmp4-gh2g) (moderate), unpatched below `6.16.0`. Reached through `express` in `packages/mcp-server`. | `express` (or `body-parser`) requires `qs >=6.16.0`. |
| `ip-address` | `^10.7.3` | [GHSA-rpw4-54j3-4h4q](https://github.com/advisories/GHSA-rpw4-54j3-4h4q), [GHSA-2vr4-cq9g-pvrc](https://github.com/advisories/GHSA-2vr4-cq9g-pvrc), [GHSA-j6r3-76f7-8jcv](https://github.com/advisories/GHSA-j6r3-76f7-8jcv), [GHSA-h3mg-xc3c-68pw](https://github.com/advisories/GHSA-h3mg-xc3c-68pw) (moderate), unpatched below `10.7.1`. Reached through `express-rate-limit` in `packages/mcp-server`. | `express-rate-limit` requires `ip-address >=10.7.1`. |
| `sharp` | `>=0.35.5` | [GHSA-wq5f-xc86-pv6w](https://github.com/advisories/GHSA-wq5f-xc86-pv6w) — vulnerability in the bundled librsvg dependency (high), unpatched below `0.35.5`. Reached through `next` in `apps/consumer` and `apps/landing`, and through `wrangler` → `miniflare` in `apps/cms`. Raises the existing override floor so fresh installs cannot retain `0.35.4`. | `next` and `miniflare` require `sharp >=0.35.5`. Verify with `pnpm why -r sharp`. |
| `@types/react` | `19.3.0` | **Not a security pin** — enforces React 19 types workspace-wide so Studio/Docs/Landing/`@heopress/ui` typecheck against the same major as runtime React 19. | Drift between apps is no longer a concern, or the workspace splits React majors again intentionally. |
| `@types/react-dom` | `19.3.0` | Same as `@types/react` — React 19 type consistency. Being an exact pin, it is also the second entry `pnpm drift:check` has caught: the minor-and-patch group bump raised `apps/{docs,landing,studio}` to `^19.2.7` while this pin stayed at `19.2.5`, so the lockfile importers still recorded `specifier: 19.2.5`. Raise the pin in step with the manifests. | Same as `@types/react`. |

## Audit ignore registry

There are no audit ignores at present.

| Advisory | Package | Reason | Remove when |
| --- | --- | --- | --- |

The last entry, GHSA-qwww-vcr4-c8h2 (`react-router` `7.18.1` via `apps/docs > react-router-dom`),
was dropped in P07: `apps/docs` was removed in P02 and `react-router` is no longer in the
lockfile, so the ignore covered nothing — and an ignore without an owner and a review
deadline is what the security scans now refuse.

## Known-unfixable alerts

Advisories that stay open on GitHub but have no installable fix and no effect on the
`pnpm audit --prod --audit-level high` gate. They get no [audit ignore](#audit-ignore-registry)
entry — that gate is `--prod` and these live outside the production tree — so this section
is the only record.

### GHSA-mh99-v99m-4gvg still matches `brace-expansion@1.1.16`

The advisory's affected range is `<= 5.0.7`, which by plain semver **includes every 1.x
version** — so bumping the 1.x line to `1.1.16` closes
[GHSA-3jxr-9vmj-r5cp](https://github.com/advisories/GHSA-3jxr-9vmj-r5cp) but not this one.
The only version that satisfies it is `>=5.0.8`.

**Folding 1.x into 5.x breaks ESLint.** `brace-expansion@1` exports the function itself
(`module.exports = expandTop`); the 5.x CommonJS build exports a namespace object
(`{ EXPANSION_MAX, EXPANSION_MAX_LENGTH, expand }`). `minimatch@3` — pulled in by
`eslint`, `@eslint/eslintrc`, `eslint-plugin-import`, `eslint-plugin-react`, and
`eslint-plugin-jsx-a11y` — does `require('brace-expansion')(...)`, which throws
`TypeError: m is not a function` against 5.x. Verify before revisiting:

```bash
node -e "const m=require('brace-expansion'); console.log(typeof m, Object.keys(m))"
```

**Why the residual risk is accepted:** `brace-expansion` is dev-only here (it does not
appear in `pnpm audit --prod`), and the expansion input is ESLint's own glob patterns from
repo-owned config — not attacker-controlled. The impact is a slow lint run on a
hand-crafted pattern, not a production DoS.

**Revisit when** nothing resolves `minimatch@3` any more, or upstream backports the length
cap to a `1.1.17`.

### `glib` 0.18.5 (Rust / Tauri) — GHSA-wrw7-89jp-8q8g

`apps/shell/src-tauri/Cargo.lock` pins `glib@0.18.5`; the advisory (moderate,
unsoundness in the `Iterator`/`DoubleEndedIterator` impls for `glib::VariantStrIter`)
wants `>=0.20.0`. `glib` is not a direct dependency — it arrives through the GTK stack
(`gtk`, `gdk`, `gdkx11`, `gdk-pixbuf`, `atk`, `pango`, `cairo-rs`, `gio`, `soup3`,
`webkit2gtk`, `javascriptcore-rs`, `libappindicator`), all of which pin `0.18.x`. `cargo
update -p glib` therefore cannot cross the minor, and this stack is **compiled only into
Linux builds** — the macOS (WebKit) and Windows (WebView2) targets never link it. Nothing
in `apps/shell` constructs a `VariantStrIter`.

**Revisit when** Tauri 2's Linux backend moves to the `glib` 0.20 / `gtk` 0.19+ generation.
Check with `cargo tree -i glib` after a `tauri` bump.

## Patches registry

| Patch | Why | Remove when |
|---|---|---|
| [`postgres@3.4.9`](../../../patches/postgres@3.4.9.patch) | Connection loss mid-operation (PostgreSQL restarting or briefly unreachable). Upstream postgres.js 3.4.9 writes the next statement of a reserved connection (`sql.reserve()`, the scheduler's lock session) or of a transaction (`sql.begin()`, Drizzle transactions — including the `ROLLBACK` it sends after the failed statement) to the socket it has already dropped: the write, deferred to `setImmediate`, throws `TypeError: Cannot read properties of null (reading 'write')` outside any promise and kills the process (seen in the image-runtime acceptance's db-outage check, cms-worker). Releasing such a reservation also put the closed connection back into the pool as open. The patch rejects those statements with `CONNECTION_CLOSED`, makes the release of a closed reservation a no-op, drops bytes buffered for the closed socket, and clears the cut-off statement and its server error (FATAL `57P01`) so the first statement of the reconnected session does not fail with that stale error. Regression test: `packages/runtime/src/__tests__/connection-loss.db.test.ts`. | A postgres.js release fixes reserved connections and transactions after their connection closed (the regression test passes without the patch); or the version moves, in which case the patch must be rebased or dropped (pnpm refuses to install a patch whose version is gone). |

The `gray-matter@4.0.3` patch was removed in HeoPress P02 together with `apps/docs`, its only user.

## Override drift — why `pnpm drift:check` exists

An override applies to **direct** dependencies, not just transitive ones. That
makes it possible for an override to quietly overrule what a workspace package
declares, with nothing warning about it.

This happened. `overrides.vite` was `^7.3.5` while both `apps/studio` and
`apps/docs` declared `vite: ^8.1.3`. The override won, the lockfile importer
recorded `specifier: ^7.3.5 → 7.3.6`, and both apps were built with Vite 7 for
as long as their manifests claimed Vite 8. Every "we're on Vite 8" statement in
that window was false, and no gate said so.

`pnpm settings:check` cannot catch this class: the two override copies agreed
with each other perfectly: they were only both wrong relative to the manifests.
So [`scripts/check-override-drift.mjs`](../../../scripts/check-override-drift.mjs)
fails CI when an override range does not intersect a range some workspace
package declares directly. Overrides with no direct declaration anywhere are
skipped, because that is the intended use of a security override.

The guard is dependency-free for the same reason the parity script is: a check
on install settings must not itself depend on a successful install. Its range
logic is covered by [`scripts/__tests__/check-override-drift.test.mjs`](../../../scripts/__tests__/check-override-drift.test.mjs)
(`pnpm scripts:test`), including the vite case, so the guard cannot silently
degrade into one that always passes.

**When it fires, do not silence it.** Either raise the override to meet the
manifests, or lower the manifests to admit the override. Leaving them apart is
the bug.

## Dependabot note

`js-yaml` will keep surfacing as an *unfixable* transitive alert as long as `gray-matter`
exists in the tree, because Dependabot can't upgrade `gray-matter` past 3.x's js-yaml
constraint on its own — the override + patch above are what actually resolve it. If the
recurring alert becomes noisy, dismiss it on GitHub as **"this advisory is resolved via a
pnpm override + patch"** (link this doc), rather than ignoring the package wholesale — a
blanket ignore would also hide a *future, genuinely unpatched* js-yaml advisory.
