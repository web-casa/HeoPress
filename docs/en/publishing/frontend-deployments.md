---
version: 1
lastUpdated: 2026-11-12T07:39:12.737Z
sourceLang: zh-CN
translatedFrom: zh-CN
sourceHash: 87b5ea7b1adf9029
mtEngine: manual
syncStatus: human-translated
---

<!-- check-parity: allow bulk -->
<!-- English prose runs longer than Chinese here because every platform API step is spelled out; both sides carry the
     same sections, tables, code blocks and inline identifiers. -->

# Static frontend deployments

Sites that use the Astro engine (see "Astro static engine") can deploy their static output to their own server (VPS),
Cloudflare Pages, Vercel, or Netlify. The backend always runs on the VPS only; a deployment target hosts nothing but the
built files.

Implementation:

- `apps/cms/src/services/deployment/providers/cloudflare-pages.ts`: the Cloudflare Pages adapter (Direct Upload);
- `apps/cms/src/services/deployment/providers/vercel.ts`, `apps/cms/src/services/deployment/providers/netlify.ts`: the Vercel and Netlify adapters (including static upload);
- `apps/cms/src/services/deployment/static/contract.ts`: the static-target response contract and the runtime feature support matrix;
- `apps/cms/src/services/deployment/static/edge-negotiation.ts`: the per-platform artifacts for same-address Markdown negotiation (Cloudflare's `_worker.js`,
  Netlify's Edge Function and `netlify.toml`, the Vercel routes, the Caddy matcher) and the replay verdicts;
- `apps/cms/src/services/deployment/static/scan.ts`: the artifact scan before upload;
- `apps/cms/src/services/deployment/static/static-deployer.ts`: deployment, reconciliation after a lost confirmation, rollback, and the post-deploy health check;
- `apps/cms/src/services/deployment/static/static-site.ts`: the admin switches (enable the engine, theme, deployment target) and the view;
- Studio: Settings › Advanced › Deployment › "Static site (Astro engine)".

## Choosing a deployment target

1. Connect the target on the "Deployment" page (the token is stored encrypted and never appears in the API or the logs):
   - Cloudflare Pages: the project field takes `<账户 ID>/<项目名>` (account ID / project name); the API token needs the "Cloudflare Pages: Edit" permission;
   - Vercel: project ID or name, team projects written as `team_xxx/<项目>`; **Vercel's free Hobby plan does not allow commercial use**, and Studio warns when Vercel is selected;
   - Netlify: site ID.
2. In "Static site", tick "Build with the Astro engine", then choose a theme (`official:starter` or `operator:<名称>`) and a deployment target;
   no target means your own server. Saving requests a build immediately; after you change the target, the build that is
   already live is deployed to the new target.

## Deployment flow

1. Once a build passes validation and goes live locally as one atomic step, a deployment request is registered for that generation,
   and that revision's response contract is saved to `<root>/<siteId>/contracts/<generation>.json`.
2. A worker processes requests every 15 seconds: scan the artifacts → generate the platform configuration files → upload as a new production deployment → poll until the platform confirms it is live or reports failure.
3. `deployed_generation` / `deployed_revision` are updated only after the platform confirms the deployment is live: `publishedRevision`
   (the site's rendered revision), `activeRevision` (built locally) and `deployedRevision` (confirmed by the target) are recorded separately.
4. When an upload fails, the live site still serves the previous version; the deployment is recorded as failed with an error
   summary and the (redacted) platform logs.
5. Every deployment carries a marker (Cloudflare's `commit_message`, Vercel's `meta.heopressMarker`, Netlify's `title`). When an upload error
   or a worker exiting mid-way loses the confirmation, query the platform by the marker first: reuse that deployment if it is found,
   and request a new one only if it is not, so nothing is deployed twice.

The platform APIs (checked against the official docs and the Wrangler source on 2026-10-28):

| Platform | Upload |
|---|---|
| Cloudflare Pages | `upload-token` → `pages/assets/check-missing` → `pages/assets/upload` → `pages/assets/upsert-hashes` → `deployments` (multipart: `manifest`, `branch`, `_headers`, `_redirects`); the asset key is the first 32 hex characters of `blake3(base64 内容 + 扩展名)` |
| Vercel | `POST /v2/files` for each file (`x-vercel-digest` is a SHA-1) → `POST /v13/deployments` (`files`, `target: production`, `projectSettings.framework: null`); the routes live in `vercel.json` |
| Netlify | Digest deployment: `POST /sites/{id}/deploys` (path → SHA-1) → `PUT /deploys/{id}/files/{path}` for the files in `required` → live once the status is `ready` |

Vercel's Git trigger became a redeploy of the most recent production deployment (`deploymentId`): the previous
implementation sent only `gitSource.ref`, while the API requires the repository as well. Netlify exposes no public
build-log API, so the logs are the deployment object's `error_message` and `summary.messages`.

## Static-target response contract and feature support matrix

The page-data snapshot gains `routes`: the Classic engine answers each redirect rule's source path and each withdrawn
entry's path one by one (301 with the destination, 410). Deployment writes them per platform:

| Feature | VPS | Cloudflare Pages | Vercel | Netlify |
|---|---|---|---|---|
| noindex response header | yes | yes | yes | yes |
| Markdown copy canonical (`Link`) | yes | degraded: `_headers` allows at most 100 rules; past that the copy stays noindex but loses its `Link` | yes | yes |
| 301 redirects | yes | yes (at most 2000; past that the deployment is refused) | yes (at most 2048 routes) | yes |
| 410 for withdrawn content | yes | degraded: `_redirects` cannot answer 410, so the address answers 404 | yes | yes |
| Same-address Markdown negotiation | degraded: Caddy only matches the `Accept` header text | yes: `_worker.js` (a Pages Function) ships with the artifacts | degraded: `vercel.json` only matches the `accept` header text | degraded: an Edge Function (`netlify/edge-functions/negotiate.ts`) and the `netlify.toml` that declares it ship with the artifacts, but this deploy path only uploads files and never sends the Deploy API's edge_functions field |
| RSS / Atom | yes | yes | yes | yes |
| On-site search, draft preview, access analytics | not available | not available | not available | not available |

<!-- The zh-CN source's matrix cell still says "supported" here. The code (SUPPORT_MATRIX in contract.ts) and the
     negotiation section below say degraded, because this deploy path never sends the Deploy API's edge_functions field;
     the English page follows the code so that the sentence in "Budgets and degradation" is not contradicted.
     Translated 2026-11-12. -->

VPS generates `<root>/<siteId>/Caddyfile.static`, which you `import` inside the site block that serves the `current`
directory. Degraded items are written into the deployment record as warnings; a contract that cannot be expressed
(too many rules) refuses the deployment.

## Same-address Markdown negotiation (v1.2 P11 task 4.5)

Once a site turns on `discovery.markdownNegotiation` (off by default), the Classic engine answers at the page's **own
address** with that page's Markdown according to `Accept` (see "Markdown content negotiation" in the Classic rendering
service). A static target does not run that code, so deployment writes the same promise into each platform's own
configuration: only articles and pages that are indexable and canonical to themselves negotiate (the same indexability
verdict as the `.md` copy and the sitemap), and the answer is that page's `.md` copy.

| Target | How | Support |
|---|---|---|
| Cloudflare Pages | Ships `_worker.js` (a Pages Function in advanced mode) with the artifacts: a built-in table of negotiable paths (a table lookup, not a scan at request time), the same RFC 9110 rules as the runtime; on a hit it rewrites to that page's `.md` copy and adds the type, `noindex` and the canonical `Link`, and both variants carry `Vary: Accept`; every other request goes to the static assets unchanged | yes (bounded by the Pages Functions plan: invocations, CPU, bundle size) |
| Vercel | `vercel.json`'s `routes`: one `Vary: Accept` header route plus one rewrite route per page with `has`/`missing` conditions (`accept` contains `text/markdown`, does not contain `text/html`/`text/*`/`*/*`, and does not reject with `q=0`) | degraded: matches header **text** only, never compares `q` |
| VPS (Caddy) | In `Caddyfile.static`, one `@negotiate_md_N` per page (a CEL expression: `path(...)` and an `Accept` regex) plus a `rewrite` to the `.md`; the page address gets `header Vary "Accept"` | degraded: same as above |
| Netlify | Ships `netlify/edge-functions/negotiate.ts` (an Edge Function on the Deno runtime) with the artifacts: the same negotiable-path table and the same RFC 9110 rules; non-negotiable paths and any method other than GET/HEAD pass to the next handler unchanged, and on a hit it `context.rewrite`s to that page's `.md` copy and adds the representation headers, with `Vary: Accept` on both variants; it also generates `netlify.toml` declaring the route with `[[edge_functions]]` (`path = "/*"`, `function = "negotiate"`) | degraded (**this deploy path only uploads files and never sends the Deploy API's `edge_functions`, so a site deployed here does not register the function and does not negotiate**; it takes effect only where Netlify itself builds from a repository (a Git build) and the output contains these two files. Bounded by the Edge Functions plan: invocations, 50 ms CPU per request, 20 MB bundle) |

**What "degraded" means** (Vercel and VPS): the configuration can only read header text. Cloudflare Pages and Netlify are
code (a Pages Function / an Edge Function) and compare `q` values with the same rules as the runtime, so the table below
does not bound them.

| Request | Static target | Classic engine |
|---|---|---|
| Lists only `text/markdown` (plus types that do not override HTML) | Markdown | Markdown |
| A browser's default headers, `text/html`, `*/*`, `text/*`, no header | HTML | HTML |
| `text/markdown;q=0`, `text/markdown;q=0.000` | HTML | HTML |
| `text/markdown;q=0.9, text/html;q=0.5` | HTML (it sees both) | Markdown (`q` is higher) |
| `text/markdown, */*` | HTML | HTML (tie) |
| Any other `q` value, a malformed `q` | Not compared: present means accepted (except `q=0`) | Computed per RFC 9110 |

In other words, a static target returns Markdown only for requests that would get Markdown at runtime (the conservative
direction); the only deviation is that it may treat a request that prefers Markdown by `q` but also lists HTML as HTML.
Cloudflare Pages' `_worker.js` decides with the same rules as the runtime and is not bound by this.

**Budgets and degradation**:

- Vercel's 2048 routes: negotiation takes 1 `Vary` route + 1 rewrite route per page; pages that do not fit keep HTML (the `.md` copy stays reachable), and the deployment record carries a count warning.
- Cloudflare Pages: the 100-rule `_headers` limit is unaffected (negotiation does not go into `_headers`); when `_worker.js` exceeds 256 KiB the deployment record reminds you to check the Pages Functions bundle limit.
  The path table is an explicit list: it does not grow with requests and does not scan page data at request time.
- Netlify: the Edge Function likewise holds an explicit path table (a table lookup), and `_headers` / `_redirects` do not change because of negotiation; the platform limits are 50 ms CPU per request,
  monthly invocations per plan, and a 20 MB compressed bundle. The deploy path must actually register the Edge Functions and read the generated `netlify.toml`: this repository's Netlify deployer currently
  only uploads files and never sends `edge_functions`, so the matrix is `degraded` and not `yes`; CI does not prove that step,
  the health check below does.
- VPS: one matcher line per negotiable page plus a header block; when a site turns off `.md` copies the static target does not negotiate (there is no file to rewrite to), and the deployment record says so.
  Non-ASCII page paths appear percent-encoded in the snapshot while Caddy's `path` matcher decodes the request path first, so a page whose two forms disagree does not negotiate on VPS
  (a conservative failure the health check can find); page slugs are usually ASCII and this change does not invent a decoding rule for them.
- With negotiation off (the default) none of the rules in this section are generated, and the output is byte-identical to the output before the capability existed.

**Post-deploy health check**: CI can only prove the generated rules (the "replay" below). Real platform behaviour has to be
spot-checked after each deployment on one negotiable page with the four checks below; the target only counts as working when
all four match (for Netlify, first confirm the deployment really contains `netlify/edge-functions/negotiate.ts` and
`netlify.toml` and that the platform recognised the function — that is the precondition for `yes`):

```bash
curl -sI -H 'Accept: text/markdown' https://www.example.com/hello/
curl -sI -H 'Accept: text/html' https://www.example.com/hello/
curl -sI -H 'Accept: */*' https://www.example.com/hello/
curl -sI https://www.example.com/hello.md
```

- Check 1: `content-type: text/markdown; charset=utf-8`, `x-robots-tag: noindex`, `link: <https://www.example.com/hello/>; rel="canonical"`, `vary: accept`;
- Checks 2 and 3: an HTML type and `vary: accept`, with no `link` (check 3 must also be HTML on a target whose configuration is bounded);
- Check 4: the copy is still `text/markdown` with `noindex` and `link` (negotiation does not change the copy itself).

Before reloading, VPS validates the configuration: `caddy validate --config /etc/caddy/Caddyfile` (with this snippet `import`ed);
on failure the reload does not replace the running configuration.

**What CI can prove**: `replayEdgeNegotiation` in `apps/cms/src/services/deployment/static/edge-negotiation.ts` reads the
generated configuration back (the `vercel.json` routes, the `Caddyfile.static` matchers and `rewrite`) and executes
`_worker.js` and Netlify's `netlify/edge-functions/negotiate.ts` by their generated content in an isolated `node:vm`
context (for Netlify's stub `context`: `next()` returns the resource response for that address, `rewrite(url)` returns the
response for that URL; when `netlify.toml` does not declare the function it is treated as "no rules"), reporting which file
`(平台, 地址, Accept, 方法)` would get, which representation headers, and which response body; the cases live in
`apps/cms/src/services/deployment/static/__tests__/edge-replay.test.ts`. A property test also proves that the two
code-based targets (Cloudflare Pages, Netlify) agree with the runtime's verdict for every case. It proves the rules
themselves, not that the platform executes them — only the health check above can show that.

## Rollback

"Roll back to the previous deployment" redeploys the previous successful deployment's generation to the target and adds a
rollback record. Before going live it checks the old artifacts against the current snapshot: a file that contains a page or
file the site no longer publishes (withdrawn, unpublished, 410) refuses the rollback and needs a rebuild; the sponsorship
disclosure policy is checked against the current settings. Deployment reconciliation does not "correct" a rollback back;
the next build deploys the new version as usual.

## Artifact scan

Before upload, every file in the artifacts is read, and any of the following refuses the deployment (the live version stays
unchanged; the record lists the file and the rule, with the excerpt redacted): private keys, platform tokens, JWTs,
connection strings carrying a password, assignments such as `JWT_SECRET`, this instance's `JWT_SECRET` / `ENCRYPTION_KEY`
values; the CMS's own addresses (`HEOPRESS_PUBLIC_URL`, `HEOPRESS_STUDIO_URL`, `HEOPRESS_PREVIEW_ORIGIN`) and `/admin`,
`/studio`, `/api/v1` links; loopback and private-network addresses, the page-data API, database table names; `.env*`, `.git`,
`package.json`, source maps, key certificates, platform configuration files (`_headers`, `_redirects`, `_worker.js`,
`vercel.json`, `.vercel`, `netlify.toml`, the `netlify/` directory, `Caddyfile.static` — these are generated by the
deployer and must not ship inside the artifacts; your own `netlify/edge-functions/` is refused as a conflict).

## Post-deploy reachability health check

After a successful deployment, a reachability health check runs against the site's verified domain using P07's rules, with
the deployment target as the platform; the result (problems, and the platform-specific fix) is written to the deployment
record and shown in Studio. A site with no verified domain is recorded as skipped.

## Tests

```bash
pnpm --filter @heopress/cms exec vitest --run src/services/deployment
DATABASE_URL=<应用角色> DATABASE_OWNER_URL=<所有者> pnpm --filter @heopress/cms exec vitest --run src/__tests__/static-deploy.db.integration.test.ts
```

The smoke test against a real deployment needs credentials and does not run in CI: `apps/cms/scripts/p11-deploy-smoke.ts`
(usage in the file header).
