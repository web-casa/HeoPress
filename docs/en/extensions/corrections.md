---
version: 2
lastUpdated: 2026-11-13T20:52:45.012Z
sourceLang: zh-CN
translatedFrom: zh-CN
mtEngine: manual
syncStatus: human-translated
sourceHash: 36eed0198639541c
---

# Corrections (`heopress-corrections`)

A public correction form, a moderation queue, correction records on the article and structured data. It is the first
official plugin written for readers (see item 1 of the [official plugin backlog](../../backlog/official-plugins.md) and
[ADR-0015](../../decisions/ADR-0015-plugin-boundary-and-extension-points.md)).

## What it does

Three steps, all in the site's own data:

1. **A reader submits**: a public form endpoint `/_ext/heopress-corrections/report` writes the page path, the quoted
   passage, the suggested correction and an optional comment, name and e-mail into a **draft** report in the private
   collection `heopress_corrections__reports`;
2. **An operator moderates**: in the Studio report collection, the operator changes the moderation status `status` to
   `accepted` or `rejected`;
3. **A public record and a correction block**: accepting creates a **draft** correction record in
   `heopress_corrections__notices`; the operator edits and publishes it, which puts the record on `/corrections` and
   `/corrections/:slug` and appends a correction block to the end of the corrected article's body.

One report produces at most one correction record; moderation and writing need no e-mail, external service or extra
configuration.

## Install and approve

Install the official plugin `heopress-corrections` on the extensions page, review the capabilities it declares and
enable it. It asks for no `http:fetch`, `secrets`, `ai` or `jobs` capability and declares no `prePublishHooks`, so it can
never block anyone's publishing by failing to load.

Installing creates the two collections as the site's own tables, machine names starting with `heopress_corrections__`;
disabling or uninstalling keeps the collections and their data, and enabling it again continues where it left off.

## The form a reader sees

The site's own pages post to `/_ext/heopress-corrections/report`. The host first verifies the origin (only the site's
approved origins may post), then that the body is at most `8 KiB` and that one client address posts at most `5` times a
minute.

| Field | Required | Limit (characters) |
|---|---|---|
| Page path | yes | 512 |
| Quoted passage | yes | 1000 |
| Suggested correction | yes | 2000 |
| Comment | no | 2000 |
| Name | no | 120 |
| E-mail | no | 254 |

The page path must be a path on this site: it starts with `/` and is not an external address, a `..` segment, a query, a
fragment or the reserved `/_` prefix. A `<` or `>` in the passage, the correction, the comment or the name is
**refused** (never silently cleaned), and control characters and bidi overrides are removed.

The form carries a `website` field a reader cannot see: when it is filled, the submission is dropped and the answer is
**exactly** the success answer. Every accepted submission, duplicate submission and trapped submission gets one
sentence, which confirms neither that the page exists nor that a report was recorded — the endpoint never resolves the
item a page path names.

## Moderation: one status field

Open the report collection (`heopress_corrections__reports`), change `status` to `accepted` or `rejected` in the item
form and save. That is the whole moderation step; there is no second screen.

- `accepted`: the plugin creates one **draft** correction record, titled after the target article (or after the page
  path when the article cannot be found), with a path segment derived from the report id;
- `rejected`: nothing happens and the report stays in the queue, where it can be deleted at any time;
- `pending`: nothing happens.

The Studio "publish" button only writes the item's core status (`draft`/`published`); it is not a moderation decision.
Reports are always created as `draft`, so that button is neither accepting nor rejecting.

## The correction block on the article

When a correction record is **published**, the plugin appends a block to the end of the corrected article's body:

```html
<aside data-heopress-correction="r_example"><p><strong>Correction</strong> (2026-11-14): The bridge was built in 1989.</p><blockquote><p>The bridge was built in 1998.</p></blockquote></aside>
```

The block starts with the `marker_label` setting (default `Correction`) and the record's correction date. It behaves as
follows:

- one report id means **one block** in the body: a repeated event, a second publish, or an operator's edit inside or
  outside the block never adds a second one and never overwrites the operator's wording;
- unpublishing or deleting the record removes exactly that report id's block and leaves the rest of the body alone;
- with the `write_body` setting off, the plugin does not touch the body; the record is still public (the correction then
  lives on the record page only);
- an article without a body field is left alone; when the article no longer exists the record is still created, there is
  simply nothing to write into.

The write goes through the normal item write path: a new version, revisions, change events, cache invalidation, the
publish guard and other plugins' pre-publish checks all run. Public pages drop the block's wrapper and the
`data-heopress-correction` attribute (the same policy as the glossary links) but keep the correction and quoted text.

## The gate check

The plugin declares one gate check on articles, `notice-links`: every correction block in a body must point at a
**published** correction record of this site.

- no correction block: pass;
- every block points at a published record: pass;
- a block's record is missing, still a draft, or the block's id does not look like a report id: **blocked** (the
  evidence names the missing, unpublished or malformed markers);
- the site's records cannot be read: **needs review**, never a guess that passes.

To see that verdict before publishing, use the Studio's "run the gate" action or the AI write path; **publishing an
article by hand does not run the quality gate**, so a hand-published article pointing at an unpublished record is not
stopped. That is a deliberate trade-off: a content plugin must not stop the whole site from publishing when it breaks.

## What is public, and the structured data

- `/corrections` lists the site's published correction records and `/corrections/:slug` is a record's page; both
  engines, Classic and Astro, have templates; a draft has no page and is absent from the sitemap, the feeds and the
  page data.
- A record page contributes one `CorrectionComment` structured-data node (schema.org's definition of "a correction to a
  CreativeWork"), with the correction as its text, the correction date and the corrected page as its subject.
- The report collection has no public page at all; the reporter's name, e-mail and comment, and the record's `report_id`
  and `article_id`, are hidden fields and never appear in public output.

## Personal data and retention

| Data | Public | Retention |
|---|---|---|
| Page path, quoted passage, correction | public once the record is published | deleted with the record |
| Name, e-mail, comment | no | deleted with the report |
| Decision ledger (ids only) | no | deleted with the site |

The e-mail exists for one human action, an operator contacting the reporter: the plugin sends no confirmation mail and
never writes it into logs, public pages or structured data. Reports and records are ordinary items, so deleting a report
deletes its personal data; retention and deletion follow
[ADR-0013](../../decisions/ADR-0013-data-retention-and-deletion.md). Both engines' templates use only the template
context the manifest declares, like [briefing sections](briefing-sections.md).

## Known limitations

1. Publishing an article by hand does not run the quality gate, so `notice-links` only applies on the gate paths;
2. an article page carries no `CorrectionComment` node: aggregating several corrections per article needs the "core
   schema contribution" contract (still missing in the backlog), and the plugin will not invent a fake field;
3. the corrected page in the structured data is a site-relative path (a manifest cannot compute the site origin);
4. an article is resolved from the last segment of the page path (as an id first, then as a slug), so a slug shared
   between languages may resolve to another language's article;
5. one report has one correction record: accepting it again after a rejection does not create a second one, edit the
   existing record instead;
6. unpublishing and republishing a record rebuilds the block from the record's fields, so an operator's rewrite inside
   the block is lost (edits outside it are kept);
7. manifest labels are single strings, so collection, field and setting labels are written in both languages while the
   public route titles are English only.
