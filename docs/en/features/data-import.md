---
version: 1
lastUpdated: 2026-07-28T10:17:03.297Z
sourceLang: en
contentHash: 152cf39aee864f38
codeVerified: 2026-07-28T10:17:03.297Z
codeVerifiedHash: 152cf39aee864f38
codeVerifiedClaims: 4
---

# Data import

Bulk-loading many items — a migration, a seed, a one-off backfill — goes through
the **bulk items endpoint**, not one request per row. This page covers the
endpoint, the rate limit that trips large imports, and a recommended batching
approach.

## Bulk endpoint

```
POST /api/v1/items/{collection}/bulk
```

The body is an object with an operation and an array of items:

```json
{
  "op": "create",
  "items": [
    { "title": "First",  "slug": "first" },
    { "title": "Second", "slug": "second" }
  ]
}
```

| Field | Type | Notes |
|-------|------|-------|
| `op` | `"create" \| "update" \| "publish" \| "delete"` | Required. |
| `items` | array of objects | For `update`, `publish` and `delete`, each item must include its `id`; `update` and `publish` entries also carry `expectedVersion` (the item version they are based on). |

The response reports **each entry**, in input order:

```json
{
  "data": [
    { "index": 0, "id": "art_1", "status": "succeeded", "item": { "...": "..." } },
    { "index": 1, "id": "art_2", "status": "unchanged", "code": "ALREADY_PUBLISHED" },
    { "index": 2, "id": "art_3", "status": "blocked",   "code": "ITEM_HELD" },
    { "index": 3, "id": "art_4", "status": "conflict",  "code": "VERSION_CONFLICT" },
    { "index": 4, "id": "art_5", "status": "failed",    "code": "VERSION_REQUIRED" }
  ],
  "meta": { "succeeded": 1, "unchanged": 1, "blocked": 1, "conflict": 1, "failed": 1 }
}
```

| `status` | Meaning |
|---|---|
| `succeeded` | applied |
| `unchanged` | nothing to do (publishing an item that already is published at that version) |
| `blocked` | a rule held it back: `ITEM_HELD`, `PINNED_BY_HUMAN`, `EDITORIAL_GATE_REQUIRED` |
| `conflict` | `VERSION_CONFLICT`: the item changed since `expectedVersion` |
| `failed` | anything else, with its code (`VALIDATION…`, `NOT_FOUND`, `FORBIDDEN`, `VERSION_REQUIRED`, `DUPLICATE_ID` for an id repeated in the request or taken meanwhile, `INTERNAL`) |

The HTTP status is `200` when every entry succeeded or was unchanged, and
`207 Multi-Status` otherwise. One entry failing never undoes another's
success. A malformed body returns `400` with a `VALIDATION` envelope; a missing
collection or no permission for the operation at all fails the whole request.
Standard tenant (`X-HeoPress-Site`) and auth headers apply, and row-level
permissions are enforced per item.

> `op: "delete"` performs a **soft delete**, not a hard delete.

### Batching

A request takes at most **500** items (`HEOPRESS_BULK_MAX`; more returns `413
BULK_TOO_LARGE`). `bulk` is **not transactional**: entries are applied one by
one (valid `create` entries in one insert), and the response says which ones
did not go through. For large imports, send items in batches (e.g.
500–1000 per call) so you can retry a failed batch without re-sending everything
and keep each request well under the rate-limit window. Pick a batch size that
balances throughput against request duration for your data.

## Rate limit

The authenticated API is throttled to **600 requests per minute** per
principal by default (`HEOPRESS_API_RATE_LIMIT`) (see [Rate limiting](../deployment/environment-variables.md#rate-limiting)).
A naïve import that issues one request per row will hit `429` mid-run. Two
levers:

1. **Use the bulk endpoint** — one request moves a whole batch, so the same
   import costs far fewer requests.
2. **Raise the budget for the import** — set `HEOPRESS_API_RATE_LIMIT` higher
   (or `HEOPRESS_API_RATE_LIMIT=0` on a trusted, isolated import host)
   while the job runs, then restore it.

On `429`, the response carries `Retry-After` and `X-RateLimit-Reset`; a client
that honours them will pace itself automatically.

## Related

- [Environment Variables → Rate limiting](../deployment/environment-variables.md#rate-limiting)
- [Data model](../data-model.md)
