# Studio: cross-site summary API

Two read-only endpoints feed Studio's "All sites" views (overview, AI traffic, site topology). They are the one
exception to "a session sees its current site only" (spec sites/site-switching): they return identity fields and
aggregates of every site the caller may enter — never an item, title, path, member or setting.

## Access

- Only an interactive Studio session (a HeoPress login token). API keys, frontend sessions and sessions of external
  issuers get `403`.
- `/api/v1/studio` is on the Studio access gate: the current site's app access and two-step requirement apply.
- Rate limited per person (60 per minute, `429` with `Retry-After`). Each read writes one audit record
  (`studio_network_summary_read`: the person and the number of sites, no figures).
- Never cached: permissions are compiled for each request in each site's scope, so a removed membership, a
  downgraded role, a policy that starts or ends, or an IP rule apply on the next request. Responses carry
  `Cache-Control: no-store`.

## `GET /api/v1/studio/network-summary`

`data` is one entry per site the caller may enter Studio on (the same judgement as `GET /api/v1/auth/sites`).

Every entry has:

| Field | |
|---|---|
| `id`, `name` | the site |
| `primaryDomain` | the primary hostname, or `null` |
| `primaryDomainState` | `set`; `unset` (active domains, none primary); `none` (no active domain) |
| `role` | the caller's role name on that site |
| `availability` | `available`, `mfa_required` or `unavailable` |

Only `available` entries add figures:

| Field | |
|---|---|
| `computedAt` | when the figures were computed |
| `pendingReviews` | `{count, oldestWaitSeconds}` over collections where the caller holds both `review` and `read`; `"no_permission"` when there is none |
| `auditIssues` | `{error, warning, notice}`: open issues the caller may see |
| `publishedArticles` | `{count, partial}` over article collections the caller may read (`partial`: some are not readable); `"no_permission"` when none is |
| `aiCrawler7d`, `aiReferral30d`, `referralsByPlatform` | AI crawler reads (7 days), AI-referred visits (30 days), those visits by platform |
| `health` | `{status: ok|warn|bad|unknown, reasons: [{code, count?, host?, detail?}]}` — never a score |
| `lastAuditAt` | the last audit run |

- `mfa_required`: the site requires two-step verification and this login has not done it — no figure is returned.
- `unavailable`: the site did not finish within the 2-second deadline; the others are returned anyway.
  Interfaces show these two states, never zeros, and leave them out of totals.

`meta.elapsedMs` is the server time spent.

## `GET /api/v1/studio/network-summary/ai-traffic?days=7|30|90`

`data`: `{days, from, to, byDay: [{day, training, search, userFetch, referral}], totals: {crawler, referral},
previousTotals, sites, excluded: {mfaRequired, unavailable}}` summed over `available` sites only. `previousTotals`
covers the period of the same length before and is `null` when no site recorded a day there. Each `sites` entry has
the identity fields above, plus `totals` and `previousTotals` when available.

The per-site report `GET /api/v1/site/ai-traffic?days=&previous=1` gains the same `previousTotals`.
