# Vector retrieval

HeoPress stores embeddings in PostgreSQL with pgvector (P03). Vector search is
off unless `HEOPRESS_VECTOR_SEARCH=true`; then the database needs the vector
extension (the [HeoPress database image](../deployment/database-image.md)
has it) and readiness fails without it. With vector search off nothing below
is created and the base migrations never touch the extension.

## Vector spaces

Every pair of embedding model and dimension is a **vector space** with its own
table, `lumibase_vectors_<space id>`, a column of exactly that dimension
(`vector(N)`, or `halfvec(N)` above 2000 dimensions, up to 4000) and its own
HNSW index (cosine distance). Vectors of different models or dimensions never
share a table or an index and are never compared with each other.

`lumibase_vector_spaces` lists the spaces. `lumibase_vector_site_models` holds,
per site, the **active** space (used by queries), the **previous** one (kept
for rollback) and one being **built** during a model switch.

## Entries

Each entry records the site, source (`source_type`, `source_id`, chunk), the
content revision it was computed from, model, dimension, purpose and the
site's **permission generation** when it was indexed. Purposes are
`public_answer` (visitor-facing answers) and `internal_writing` (staff writing
aids); the same content may be eligible for one and not the other.

The permission generation (`lumibase_access_generations`) is bumped by database
triggers whenever a role, policy, permission, role–policy link, API-key role or
policy, or site membership of the site changes.

## Retrieval

`PgVectorStore.query({ siteIds, purpose, model, vector, verify })`:

1. `siteIds` are the sites to search (for internal writing, the user's current
   memberships, `currentMemberSites`). The verifier re-checks membership
   anyway, so a stale list cannot widen access.
2. Only sites whose active space matches the query's model and dimension are
   searched; the rest are reported as skipped.
3. Every candidate — freshly fetched or from a cache — goes through `verify`,
   which re-checks it against current records. For items
   (`itemCandidateVerifier`): the item exists, is not deleted and is at the
   embedded revision; for `public_answer` it is published, inside its publish
   window, and the site's public role may read it; for `internal_writing` the
   user is a member of the site now. In both cases the principal's current
   read permission must cover the item's row (the policy rule is evaluated
   against the row) and every field the chunk was built from (entries record
   them in `metadata.fields`; a chunk without that list needs unrestricted
   field access). Memberships, the public role and permissions are read from
   the database on every verification, never from a cache. Anything else is
   dropped; unknown source types are dropped.
4. When candidates are dropped, more are fetched with the same site, purpose
   and model filters — the criteria are never relaxed.

## Switching models

```bash
# Re-embedding code calls PgVectorStore.beginModelSwitch(site, model, dim)
# and writes entries into the new space; queries keep using the old one.
heopress vectors status --site <id>
heopress vectors activate --site <id>        # new model live, old one kept
heopress vectors rollback --site <id>        # back to the previous model
heopress vectors drop-previous --site <id>   # once the switch is final (locks the site's binding, so it cannot race a rollback)
```

## Converting JSONB embeddings

`heopress vectors convert` moves the JSONB arrays in `lumibase_ai_embeddings`
into the space of their own model and dimension. It is repeatable: a second
run rewrites the same entries and changes nothing. A site without an active
model gets the space holding most of its converted rows. Converted entries are
`internal_writing` and carry no revision, so a verifier that checks revisions
drops them until the content is re-embedded. Rows that are not numeric arrays
are counted as skipped. `lumibase_agent_memory.embedding` records no model and
is not converted.
