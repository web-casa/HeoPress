---
version: 1
lastUpdated: 2026-10-29T11:51:38.645Z
sourceLang: zh-CN
translatedFrom: zh-CN
sourceHash: 87414264a4daf3fd
mtEngine: manual
syncStatus: human-translated
---

<!-- check-parity: allow bulk -->
<!-- Recorded by stamp-pair --allow-structure-drift on 2026-10-29T11:51:38.645Z. See commit history for rationale. -->

# User guide

For editors, site administrators and network operators: running many sites from Studio, from ingestion and AI
processing through review to publishing. Each section says what a feature does and where its limits are, then links to
the detailed topic page. Deploying and running an instance is in the [Operations guide](operations.md).

## 1. Signing in and Studio

Studio is the admin interface. It is served only under the **private admin path** (created at install, for example
`https://admin.example.com/<admin-path>/`); the public site domains have no admin entry at all.
The first administrator (the bootstrap administrator) is created by the installer, and its credentials are written only
to a credentials file on the server; see [Installation](../../zh-CN/operations/install.md) (Chinese).

Studio has eight modules: Overview, Content, Sites, SEO / GEO, AI traffic, Audit, Logs & monitoring and Settings. The
site switcher in the header sets the current site; "All sites" is a read-only summary. The interface is available in
Simplified Chinese and English. `⌘K` / `Ctrl K` searches and jumps; `?` lists the shortcuts.

- Modules and common actions: [Studio](../../zh-CN/studio/README.md) (Chinese)
- Members, roles, API and keys, notifications and other settings: [Settings](../../zh-CN/studio/settings.md), [Notifications](../../zh-CN/studio/notifications.md) (Chinese)

## 2. Sites and domains

- **New sites**: only the bootstrap administrator creates and deletes sites. A new site gets the preset collections
  (articles, pages, categories, tags, authors) and its creator becomes its administrator.
- **Content settings**: each site has its own language, time zone, permalinks (per collection), trailing slash and
  site type; a migrated site can bulk-import its redirects. See [Site network content model](../../zh-CN/content/site-network-model.md) (Chinese).
- **Editorial profile**: each site has one versioned profile of audience, tone, terminology, citation policy and
  off-limits topics; AI jobs and external agents read the version in force.
  See [Editorial profiles](../../zh-CN/content/editorial-profiles.md) (Chinese).
- **Domains and certificates**: a site administrator adds domains to a site; a domain serves only after its ownership
  is verified, and its certificate is issued on the first visit.
  See [Custom domains and on-demand TLS](../deployment/custom-domains.md).
- **Languages**: each language version of a piece of content is its own item, linked through a translation group (which
  may span sites and domains); there are three URL strategies, and the language of a request is decided by its domain
  and path only. See [Translation groups](../../zh-CN/i18n/translation-groups.md), [Locale routing](../../zh-CN/i18n/locale-routing.md), [Translation freshness](../../zh-CN/i18n/translation-freshness.md) (Chinese).

## 3. Content and review

- **Article editor**: three columns (outline, body, inspector) with a block editor; with object storage configured, images and videos can be uploaded into the body. A save is based on the version you opened, so someone else's earlier save is never silently overwritten.
- **Review workspace**: views such as Inbox, My drafts, Awaiting review and Scheduled. Approving and returning a
  draft are done by a person in Studio only; API keys, agents and MCP tools are always refused.
  See [Content and review workspace](../../zh-CN/studio/content.md) (Chinese).
- **Hold and scheduling**: an item can be put on Hold (no automated process will publish it) or given a future
  publication time.
- **Preview**: signed, time-limited links preview a draft or an unpublished theme version in the site's real design;
  previews are never indexed or cached. See [Draft and theme preview](../../zh-CN/rendering/preview.md) (Chinese).
- **Sponsored content**: sponsored items carry a uniform label and disclosure, output by the system; a theme cannot
  remove them.

## 4. SEO / GEO

For every site HeoPress outputs standard, verifiable signals: title and description templates, canonical, hreflang,
robots directives and an AI crawler policy, JSON-LD structured data, sharded sitemaps, `llms.txt`, Markdown copies
and IndexNow pings. These make pages easier to crawl and understand; **they promise no ranking, indexing or AI
citation**.

- Each setting, its effect and its limits: [SEO / GEO guide](../../zh-CN/seo/seo-geo-guide.md), [SEO / GEO in Studio](../../zh-CN/studio/seo-geo.md) (Chinese)
- Site audit, internal link graph and change-impact preview: [Links, audit and change impact](../../zh-CN/seo/links-and-audit.md), [Audit](../../zh-CN/studio/audit.md) (Chinese)
- AI crawler visits and AI referral traffic: [AI traffic](../../zh-CN/studio/ai-traffic.md) (Chinese)

## 5. The AI content pipeline

The path of an AI draft: **source → fetch and deduplication → pipeline processing (translate, rewrite, write) →
quality gate → automatic publishing or human review**. The pipeline never publishes directly; a draft that fails any
condition goes to the review queue, and automatic publishing never bypasses Hold, the kill switch, the quality gate or
the source's licence. Overview: [AI content pipeline and quality gate](../../zh-CN/content/ai-pipeline-quality-gate.md) (Chinese).

| Stage | What it does | Topic page (Chinese) |
|---|---|---|
| Sources | RSS / Atom, sitemaps, list pages and single URLs; each source records the licence and permitted uses of its content, set by administrators only | [Sources](../../zh-CN/content/sources.md) |
| Fetching | The native fetcher honours robots.txt and rate-limits per host, every outbound request goes through SSRF protection, and technical failures can fall back to external crawl services | [Fetching and extraction](../../zh-CN/content/fetching.md), [Crawl services](../../zh-CN/content/crawl-services.md) |
| Deduplication | Exact deduplication, near-duplicate detection and same-event clustering | [Discovery and deduplication](../../zh-CN/content/discovery-dedup.md) |
| Processing | Block-level translation and incremental retranslation, rewriting, writing; each run records the editorial profile and prompt versions it used | [AI content pipeline](../../zh-CN/content/ai-content-pipeline.md) |
| Quality gate | Each check gives a verdict, evidence and a suggested fix; the result is bound to the checked version and must be rerun after a change | [AI quality gate](../../zh-CN/content/ai-quality-gate.md) |
| Auto-publish | By trust level: publish at once, open a veto window, queue to a publishing cadence, or send to human review | [AI auto-publish](../../zh-CN/content/ai-auto-publish.md) |
| Cost | A per-call ledger, monthly and daily site budgets, rate limits and circuit breakers; a spent budget pauses work instead of overspending | [AI cost control](../../zh-CN/content/ai-cost-control.md) |

Model providers (OpenAI-compatible services and the instance default model) are configured as described in [Model providers](../deployment/model-providers.md).

## 6. External agents (MCP)

External agents such as Claude Code and Codex work with HeoPress through the instance MCP endpoint
`POST /api/v1/agents/mcp`. A user connects with OAuth 2.1 or a personal access token; the grant is "which sites ×
which tool groups", and identity and scope come from the token only.

- **Batch operation plans**: to change two or more sites, or for a high-risk operation, an agent can only submit a plan; a person reviews, approves and executes it in Studio (Settings › Batch plans).
- **Content branches**: agents edit in a branch without touching the live site; a merge compares field by field and block by block, a person resolves conflicts, and the result is only a revision awaiting publication.
- **Official Skills**: six Skills in the repository's `skills/` directory teach agents to work by HeoPress's rules.
- **Notifications**: approval requests, veto windows, budget alerts and similar events reach Studio and WeCom, Feishu, DingTalk, Telegram or a signed webhook.

See [MCP authorization](../../zh-CN/agents/mcp-authorization.md), [MCP tool reference](../../zh-CN/agents/mcp-tools.md), [Batch operation plans](../../zh-CN/agents/batch-plans.md),
[Content branches](../../zh-CN/agents/content-branches.md), [Official Skills](../../zh-CN/agents/skills.md) (Chinese).

## 7. Import and migration

- **Astro sites**: an Astro site whose content is Markdown / MDX is converted into an import bundle, rehearsed,
  imported and activated in batches; before the switch, a URL comparison proves every old link still resolves.
  Re-running never duplicates items, and content imported before activation does not appear on the site, in sitemaps
  or in IndexNow pings. See [Astro site import](../../zh-CN/migration/astro-import.md) (Chinese).
- **Single-site export and import as a new site**: for moving or copying a site; after import its domains, scheduled
  jobs and automatic publishing are off. See [Backup and restore](../../zh-CN/operations/backup-restore.md) (Chinese).
- WordPress import is not part of v1.0.

## 8. Publishing and the public site

| Engine | Use it for | Topic page (Chinese) |
|---|---|---|
| Classic (default) | One rendering process serves every site by domain with runtime (Liquid) themes; the cache is invalidated as soon as content or the theme changes | [Classic rendering service](../../zh-CN/rendering/site-classic.md), [Page cache](../../zh-CN/rendering/page-cache.md) |
| Astro | Sites that need a highly customized design or want static output on a CDN; its SEO / GEO output is equivalent to Classic's | [Astro static engine](../../zh-CN/rendering/astro-engine.md) |

An Astro site's static output can be deployed to your own server, Cloudflare Pages, Vercel or Netlify, with rollback and
a post-deployment reachability check; the backend always runs on the VPS only.
See [Static frontend deployments](../../zh-CN/publishing/frontend-deployments.md) (Chinese).

Published content can also be exported continuously as Markdown to your Git repository, as version history and a
disaster-recovery supplement (the database stays the single source of truth). See [Git snapshot format](../../zh-CN/publishing/git-snapshots.md) (Chinese).

Themes are uploaded by version, checked and then published, and any version published before can be restored; three starter themes ship built in (news, tech, minimal), and a new site uses the built-in theme until a theme is activated.
Installing, activating and writing themes: [Theme guide](../../zh-CN/rendering/theme-guide.md) (Chinese) and the [Developer guide](developers.md).

## 9. Logs and monitoring

The Logs & monitoring module (site administrators only) shows reachability, site audits, background jobs and instance
health, plus a read-only event stream. See [Logs and monitoring](../../zh-CN/studio/monitoring.md) (Chinese).
