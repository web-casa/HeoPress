---
version: 1
lastUpdated: 2026-08-02T19:14:29.861Z
sourceLang: en
contentHash: ff4339b1b2f269c5
codeVerified: 2026-08-02T19:14:34.597Z
codeVerifiedHash: ff4339b1b2f269c5
codeVerifiedClaims: 12
---

# Full-text Search

Full-text search runs on **PostgreSQL** by default; **MeiliSearch** is an
optional backend. Both sit behind the `SearchProvider` interface in
`@heopress/runtime`, so application code never needs to know which one is
active.

## Choosing a backend

| `MEILISEARCH_HOST` | Backend |
|--------------------|---------|
| unset (default) | PostgreSQL (`lumibase_search_documents`), no extra service |
| set | MeiliSearch at that URL (through the outbound boundary; list it in `HEOPRESS_TRUSTED_INTERNAL_ENDPOINTS` when it is on a private network) |

### PostgreSQL backend

- **Chinese** text is tokenized by zhparser (`heopress_zh` configuration) when
  the [HeoPress database image](../deployment/database-image.md) is used. On a
  stock PostgreSQL it falls back to substring and trigram (`pg_trgm`) matching,
  which still finds Chinese words, with coarser ranking.
- **English** uses the `english` configuration (stemming: `run` finds
  "Running"); other languages use `simple`.
- **Typos** are tolerated through trigram word similarity.
- The first searchable attribute (usually `_title`) is weighted above the rest.
  Only searchable attributes are matched, as on MeiliSearch.
- Filters accept a subset of MeiliSearch syntax: `attr = value`, `!=`, `>`,
  `>=`, `<`, `<=`, joined by `AND` / `OR`, with numbers, booleans or quoted
  strings. Anything else (`IN`, `TO`, parentheses, …) is rejected with an
  error rather than ignored.
- Diacritics are **not** folded: `ha noi` does not match "Hà Nội" on this
  backend. Use MeiliSearch where that matters.

To self-host the Docker backend on AWS (Lightsail / ECS Fargate) instead of
running it alongside the CMS, see
[Deploying MeiliSearch on AWS](../deployment/meilisearch-aws.md).

## API endpoint

`GET /api/v1/search?q=...&collection=...&filter=...&sort=...&limit=...&offset=...`

| Param | Description |
|-------|-------------|
| `q` (required) | Query string |
| `collection` | Restrict to one collection. **Omit for cross-collection (global) search.** |
| `filter` | Filter expression (MeiliSearch syntax; the PostgreSQL backend accepts the subset above) |
| `sort` | Sort directives, comma-separated (e.g. `_updatedAt:desc`) |
| `limit` | Default 20, max 200 |
| `offset` | Pagination cursor |

### Single-collection response

```jsonc
{
  "data": [ { "id": "...", "_collection": "articles", "_title": "...", "_updatedAt": "...", /* ...fields */ } ],
  "meta": { "totalHits": 12, "processingTimeMs": 3, "collection": "articles", "query": "ha noi", "limit": 20, "offset": 0 }
}
```

The requested `collection` is validated against the caller's own collections; an
unknown collection returns `404`.

### Cross-collection (global) response

When `collection` is omitted, the query fans out across every collection of the
caller's site (one scoped search each) and the hits are merged, each tagged with
its `_collection`. The fan-out is capped at 20 collections per request.

```jsonc
{
  "data": [ { "_collection": "articles", "id": "...", "_title": "..." }, { "_collection": "pages", "id": "...", "_title": "..." } ],
  "meta": { "totalHits": 7, "query": "ha noi", "collections": ["articles", "pages"], "truncated": false, "limit": 20, "offset": 0 }
}
```

This powers the Studio global command palette (⌘K).

### SDK

```typescript
import { search } from "@heopress/sdk";

// Cross-collection (global)
const { data, meta } = await client.request(search("ha noi"));
// Single collection
await client.request(search("ha noi", { collection: "articles", limit: 10 }));
```

## Vietnamese support (MeiliSearch backend)

MeiliSearch normalizes diacritics out of the box, so a query typed **without
diacritics matches text with diacritics** — `ha noi` → "Hà Nội", `da nang` →
"Đà Nẵng". No extra configuration is needed for this.

On top of that, indexes are configured (`defaultIndexSettings`) with:

- **Vietnamese stop words** (`và`, `của`, `là`, `các`, …) to improve relevance.
- **Raised typo-tolerance thresholds** (`oneTypo: 4`, `twoTypos: 8`) — Vietnamese
  has many short tokens where aggressive fuzzy matching adds noise.
- A normalized **`_title`** boosted ahead of the collection's own searchable fields.

## Auto-indexing

Indexing follows the change events (HeoPress P04): search sync is an
[event consumer](../architecture/event-consumers.md) (`searchSyncConsumer`,
registered in the worker by `serve.ts`). For every item event — create, edit,
publish, hold, delete, scheduled publish — it reads the item as it is now and
updates or removes its document, so a late or repeated event never brings an
older version back. A failing index call is retried with backoff and then
dead-lettered; `heopress reindex` rebuilds from the database.

### Reindex CLI

Rebuild indexes from the database (bootstrap a new instance, or rebuild after
changes):

```bash
heopress reindex                      # every collection of every site
heopress reindex --site <siteId>      # one site
heopress reindex --site <siteId> --collection posts
```

Requires the same env as the server (`DATABASE_URL`, `HEOPRESS_RUNTIME`, and
`MEILISEARCH_HOST` / `MEILISEARCH_API_KEY` when MeiliSearch is used).

## SearchProvider interface

```typescript
interface SearchProvider {
  index(collection: string, documents: Doc[]): Promise<void>;
  search(collection: string, query: string, options?: SearchOptions): Promise<SearchResult>;
  delete(collection: string, ids: string[]): Promise<void>;
  getIndex(collection: string): Promise<IndexInfo>;
  configureIndex(collection: string, settings: SearchIndexSettings): Promise<void>;
}

interface SearchOptions {
  filter?: string;
  sort?: string[];
  limit?: number;
  offset?: number;
  attributesToRetrieve?: string[];
}
```

On MeiliSearch, filter, sort and pagination are forwarded directly — see the
[MeiliSearch search reference](https://www.meilisearch.com/docs/reference/api/search)
for syntax. The PostgreSQL backend implements the filter subset described above.

## Multi-tenancy

The physical index name is always `{siteId}__{collection}` (see
`searchIndexName`); on PostgreSQL every statement is filtered by it. Every index/search/delete call goes through this helper, and
the `/search` route additionally validates the requested collection belongs to
the caller's site — so a tenant can neither name nor reach another tenant's index.

## Configuration

```bash
# Default: nothing to configure — search runs on PostgreSQL.

# Optional: MeiliSearch (Docker)
MEILISEARCH_HOST=http://meilisearch:7700
MEILISEARCH_API_KEY=<master key>

# Cloudflare (MeiliSearch Cloud)
MEILISEARCH_HOST=https://<your-instance>.meilisearch.io
MEILISEARCH_API_KEY=<cloud api key>
```

## Alternatives

See `apps/docs/content/guides/tooling-recommendations.md` for alternative search
backends (Typesense, Elasticsearch) — swap by writing a new `SearchProvider`
adapter.
