# Content write safety: versions, Hold and blocks

Two rules keep several people and agents from silently undoing each other's
work (HeoPress P04, spec `content/write-concurrency`).

## Every update names its version

Each item has a `version`. An update must say which version it is based on
(`If-Match: "<version>"` or `expectedVersion`), and is written only while the
item is still at that version: otherwise 409 `VERSION_CONFLICT` with the
current version and the changed fields, and without a version 428
`VERSION_REQUIRED`. This holds for every entry point — Studio, the REST and
GraphQL APIs, the SDK, MCP tools, AI skills, extensions, Releases and the
reconciler. Details and examples: [item versions](../api/hono-api-spec.md).

Other writes follow the same rule internally: scheduled publishing and
unpublishing, the encryption workers and editorial transitions only apply to
the version they read, so a save in between wins. Editorial actions
(`submit-review`, `approve`, `reject`) also accept `expectedVersion` (or
`If-Match`): a decision is about the version the reviewer saw, and a newer
version is refused with 409 `VERSION_CONFLICT`. A conflict's
`changedFields` only names fields the caller may read.

Writes through an **API key** are recorded as `integration` revisions — a
program, not a person: they do not pin fields for intent-governed
collections and do not make an AI result "superseded".

## Late AI results

An AI task works from the version it read. If a **person** edited the item
before the result comes back, the result is not written back: the write
fails with 409 `AI_RESULT_SUPERSEDED` (same `meta` as a version conflict)
and an audit entry `ai_result_superseded` records the run, the version the
task was based on, the current version and the changed fields. If only other
agents changed it, it is an ordinary `VERSION_CONFLICT`. A person's own stale
save is always a `VERSION_CONFLICT`.

This covers agent writes through the harness and MCP, approved proposals
(the agent's `expectedVersion` travels with the proposal), the reconciler's
promotion, and the L3 veto window: a staged change records the version it
was staged on, and if a person edits the item during the window the staging
ends as `superseded` (`auto_commit_superseded`) instead of being applied; if
another agent changed it, as `auto_commit_conflict`. Neither is retried.

## Hold

A **held** item is never published, by any path:

| Path | What happens to a held item |
|---|---|
| Saving with `status: published` (Studio, API, SDK, MCP, agents) | 409 `ITEM_HELD`, nothing written |
| Changing the content of a held item that is already published | 409 `ITEM_HELD` (it would change live content); unpublishing is allowed |
| Bulk publish | the entry is reported as blocked |
| Releases | the item is a blocker in the dry run; publishing reports `ITEM_HELD` for it |
| Scheduled publishing (`publishAt`) | skipped; an activity entry `publish.skipped_hold` is written once |
| Promoting a content branch onto a published item | 409 `ITEM_HELD` |
| Later publish paths (P09 auto-publish) | must call the same guard (`services/publish-guard.ts`) |

Drafts stay editable while held.

```http
POST   /api/v1/items/:collection/:id/hold     # set   — needs update permission
DELETE /api/v1/items/:collection/:id/hold     # release — needs a person with publish permission
Content-Type: application/json

{ "expectedVersion": 4 }
```

Both are version-checked like any update and recorded in the activity log
(`hold.set`, `hold.release`). **Only a person releases a hold:** a signed-in
user acting directly (not an API key, not an agent, not a front-end user)
whose permissions allow setting `status` on the item. Anything else gets 403
(`HOLD_RELEASE_REQUIRES_PERSON` or `HOLD_RELEASE_REQUIRES_PUBLISH`). Studio
shows a Hold button next to the editorial actions.

A scheduled item whose publish time passed while it was held is published by
the next scheduler sweep after the hold is released. Clear or move `publishAt`
first if it should not go out then.

## Stable block IDs

Rich-text (`wysiwyg`) and repeater fields hold **blocks** with stable IDs
(spec `content/block-identity`), so agents can change one paragraph and
translations can line up block by block:

- **rich text:** every top-level element carries `data-block-id`
  (`<p data-block-id="b_x1y2z3a4b5">…</p>`); text directly at the top level,
  outside an element, is not a block;
- **repeater:** every row carries `_blockId`.

Every save gives new blocks an ID and keeps existing ones — editing a block's
text does not change it. An ID that appears twice keeps it only at its first
occurrence; the copy gets a new ID (editors copy the attribute when a block is
duplicated or a paragraph is split). Rich text that already has all its IDs is
stored exactly as sent; otherwise it is re-serialised once with IDs added.
Items saved before P04 get their IDs on their next save.

Replace one block by its ID — version-checked like any update; only that
block changes:

```http
PATCH /api/v1/items/:collection/:id/blocks/:field/:blockId
Content-Type: application/json

{ "block": "<p>New text</p>", "expectedVersion": 7 }
```

`block` is one HTML element for rich text, or the row object for a repeater;
the block keeps its ID. Errors: `BLOCK_NOT_FOUND` (404), `DUPLICATE_BLOCK_ID`
(409 when the stored content repeats the ID; 400 when the new block carries
another block's ID), `INVALID_BLOCK` (400, not exactly one element / not a
row), `NOT_A_BLOCK_FIELD` (400), plus the usual 409/428 for versions. The SDK
has `items(...).patchBlock(id, field, blockId, block, expectedVersion)`, MCP
the `update_block` tool and the AI harness the `updateBlock` skill.
