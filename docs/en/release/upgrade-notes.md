# Upgrade notes

What an operator has to do by hand when upgrading HeoPress. Newest first.

## Studio Carbon workspace (P07a)

### Grant `review` to the people who approve content

Approving or rejecting an item in editorial review now needs the per-collection
`review` permission, and a person: the API refuses approve and reject calls
made with an API key, whatever its scope, so agents and MCP clients can submit
items for review but never decide one (the MCP tools `approve_content` and
`reject_content` explain this instead of calling the API).

- Site administrators hold `review` on every collection already.
- Every other role — including the `member` system role — has **no** `review`
  after the upgrade. Before it, any member could approve. After upgrading, give
  `review` to the roles that should approve: Settings › Advanced › Roles &
  policies, open the policy of the role, *Add permission*, pick the collection
  and the action `review`.
- The review queue (`GET /api/v1/editorial/reviews`) lists only items of
  collections the caller may review.
- A collection that requires a separate reviewer (`requireSeparateReviewer`)
  still refuses an author approving their own item.

No data changes: `review` is a new value of the existing `action` column, and
no existing role or policy is altered.

### Old Studio addresses

Studio pages moved into eight modules (Overview, Content, Sites, SEO / GEO,
AI traffic, Audit, Logs & monitoring, Settings). Old addresses — bookmarks,
links in notes — redirect to the new place with their query string kept, under
the private admin path as before.

### Site settings and account APIs

- `PATCH /api/v1/site` (name, default language, branding) now requires site
  administration, like the other site settings. Members without it get `403`.
- `POST /api/v1/users/invite` returns only `{ id, email, status }` and
  `meta.alreadyMember`. An address that is already a member keeps its role and
  receives no new email.
- API keys store their last 4 characters (`last4`, migration
  `0095_api_key_last4`). Keys made before the upgrade have `last4: null`; the
  full key is still returned only on create and rotate.
- `GET /api/v1/permissions/me` adds `instanceAdmin`: whether the control plane
  admits the caller on every site.
- `GET /api/v1/site/canonical` lists the site's active hostnames, the primary
  one marked. Members may read it; switching stays with `/domains`.
- The Studio address `/settings/content` now opens SEO / GEO › Content rules
  (`/seo/content`).
