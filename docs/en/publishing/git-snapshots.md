---
version: 1
lastUpdated: 2026-11-12T07:39:54.260Z
sourceLang: zh-CN
translatedFrom: zh-CN
sourceHash: c610c08ef0e1b6e3
mtEngine: manual
syncStatus: human-translated
---

<!-- check-parity: allow bulk -->
<!-- Chinese packs the same rules into far fewer characters; both sides carry the same sections, fences, bullets and
     inline identifiers, and nothing is added or dropped. -->

# Git snapshot format

Published content is continuously exported as Markdown into the operator's Git content repository, as a supplement to
version history and disaster recovery. The database is the sole authority (ADR-0006): Git is not a content source, and
hand edits to the repository are overwritten by the next export or reconciliation and recorded in the repair report.

Implementation: `packages/database/src/schema/git-snapshots.ts` (the tables), `apps/cms/src/services/git-snapshots/format.ts` (paths and front matter),
`apps/cms/src/services/git-snapshots/exporter.ts` (consumers, export, reconciliation), `apps/cms/src/services/git-snapshots/config.ts` (repository configuration and credentials),
`apps/cms/src/services/git-snapshots/git.ts` (in-process Git: isomorphic-git, MIT; a pinned HTTP client and `file://` local transport).

## Configuration

Each site configures one content repository (site administrator): `GET /api/v1/site/git-snapshots` reads it,
`PUT /api/v1/site/git-snapshots` changes it, and `POST /api/v1/site/git-snapshots/reconcile` queues a reconciliation immediately.

- Remotes accept `https://` only, and the URL must not carry a username or password; the address goes through the SSRF check; the HTTP client accepts
  only the configured host and https, the socket's DNS lookup returns the address resolved during the check directly (it never asks DNS again), it does not follow
  redirects, and every request has a timeout. A `file://` remote is allowed only when `HEOPRESS_GIT_SNAPSHOT_ALLOW_FILE_REMOTES=true` (tests and local mirrors).
- Access tokens are stored encrypted with the instance key `ENCRYPTION_KEY` (AES-GCM, bound to the site and the field); the API returns only whether one is set and its last four characters, and tokens are erased from logs and error messages.
  The token travels only through isomorphic-git's `onAuth` callback as an Authorization header: never in the URL, the parameters, the on-disk configuration or the logs; rejected credentials are not retried, and the error text erases the token.
- The object store lives under `HEOPRESS_GIT_SNAPSHOT_DIR` (default `data/git-snapshots/<站点 ID>/store.git`, a bare repository that never checks files out); each export takes the current commit of the remote branch.
- Git runs inside the CMS process (isomorphic-git), and the Docker image does not include the `git` program (so the curl, LDAP and Perl vulnerabilities it brings are not in the image).
- A `file://` remote is a bare repository on disk: objects are copied (content-addressed), and the branch moves only while the remote branch is still this export's starting point (equivalent to a fast-forward push).

## Directory layout

```
websites/<primary domain>/
  _site/site.json                     public site configuration (name, language, public SEO / identity, content settings)
  _site/theme/theme.json              currently published theme version: name, version, content hash, template list, asset manifest (paths and hashes only)
  _site/theme/templates/<template path>   templates of the published theme
  YYYY/MM/<slug>/index.md             published entries (articles, pages); the year and month come from the publication time (UTC)
```

- The primary domain is the site's primary public domain; path segments are normalized (NFC, lower case, separators and
  control characters removed, no leading dot, 120 characters at most), and `..` and `.git` are refused.
- **Language collisions**: when several entries share the primary domain, year and month and slug, the entry in the site's default language keeps the path, and the
  others use `<slug>--<语言>` (for example `hello--zh-cn`); when the same language still collides, `--<条目 ID>` is appended. The same input always produces the same path.
- When the domain, slug or publication date changes, the new path is written and the old path is deleted in the same commit.
- Images and videos never enter Git, and the body keeps only the referenced URL; theme assets export their manifest only.

## Entry files

```markdown
---
id: "Xk2…"
title: "Hello"
slug: "hello"
locale: "en"
translationGroup: "grp_…"
publishedAt: "2026-10-05T12:00:00.000Z"
contentModifiedAt: "2026-10-06T12:00:00.000Z"
author: "Ada Writer"
source:
  url: "https://source.example.com/x"
  attribution: "Source Ltd"
  licenseStatus: "cc-by"
seo:
  title: null
  description: null
  canonical: null
  robots: null
---

The body (the sanitized HTML the blocks render, converted to Markdown)
```

Every value is written as a JSON string (a double-quoted YAML scalar), in a fixed field order. The source fields come from the entry's `source_url`, `source_attribution`, `source_license`,
and are `null` when there is no ingested source.

## Field allowlist and personal data (ADR-0013)

The front matter is a closed list: only the keys shown above, and no other field of the entry data is copied by name.

- Only the **public display name** is exported for an author (the author record's `name`).
- **Not exported**: email addresses, user IDs (including the author record's `user` field), IP addresses, membership data, comments, drafts, raw fetch snapshots, private source configuration, secrets.
- Site configuration comes from the public projection only, and fields whose names look like secrets (`secret`, `token`, `password`, `key` and so on) are removed on top of that.
- The commit author and committer are the configured bot identity; the commit message records only counts per operator **type** (such as `user x2`) and the event time range, never a user ID or a name.

Deleting personal data therefore normally needs no Git history rewrite. Published content in past commits stays traceable: the project does not promise that unpublishing removes it from history.

## Export and commits

1. After the `git-snapshots` event consumer receives a change to an entry, a route, site settings, a translation group or a theme, it only enqueues the site (`lumibase_git_snapshot_queue`, a 30-second window) and never waits for Git.
2. A background job takes due sites every 10 seconds and holds the site's lease: it pulls the remote branch, writes all of the site's files on top of that tree from the public projection, deletes files that are no longer published, and produces a new tree; only when the tree differs from the remote does it merge it into **one commit** and push (never a force push).
3. When a push fails (remote unavailable, refused), publishing is unaffected: the queue row stays and is retried with a gap that starts at 30 seconds and doubles up to 1 hour, and the error (with the token erased) is recorded in the site status.
   The next retry regenerates the same tree from the remote, so an already pushed commit is never produced twice; nothing is committed while the tree is unchanged.

## Reconciliation

Every day at 03:40 and on manual trigger, a reconciliation is enqueued for every enabled site (`reconcileGitSnapshots`, which other modules can call directly;
`run: true` runs it immediately and returns the report). Reconciliation is the same comparison as an ordinary export, decided by **content hash** rather than by whether a file exists:

- a file pushed last time was deleted by hand → restore it (`restored`);
- a file's content was edited by hand → overwrite it (`overwritten`);
- a file in the site's directory that does not belong to the published set → remove it (`removed-extra`).

The report is written to the site status as `lastReport` and can be read at `GET /api/v1/site/git-snapshots`.
