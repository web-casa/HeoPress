---
version: 3
lastUpdated: 2026-10-29T13:23:31.882Z
sourceLang: zh-CN
translatedFrom: zh-CN
sourceHash: 0141093549c4b170
mtEngine: manual
syncStatus: human-translated
---

<!-- check-parity: allow bulk -->
<!-- Recorded by stamp-pair --allow-structure-drift on 2026-10-29T11:51:38.707Z. See commit history for rationale. -->

# Operations guide

For operators who deploy and run a HeoPress instance: installation, configuration, backup and restore, upgrades, data
retention, frontend deployment targets and security. Using the features is in the [User guide](users.md), extending
HeoPress in the [Developer guide](developers.md).

## 1. Deployment shape

v1.0 runs on **one VPS** with Docker Compose (multi-instance high-availability deployments are not supported):

| Service | Role |
|---|---|
| `postgres` | The PostgreSQL 18 database image (with pgvector and the zhparser Chinese tokenizer; see [Database image](../deployment/database-image.md)) |
| `cms` | API and Studio (`HEOPRESS_PROCESS_ROLE=web`) |
| `cms-worker` | Background work: queues, scheduled jobs, event consumers, backups and cleanup (`HEOPRESS_PROCESS_ROLE=worker`) |
| `site-classic` | The public sites' rendering service, reading the public projection through a read-only database role |
| `caddy` | Reverse proxy and TLS: certificates for the admin domain and every site domain (site domains on demand) |

The Compose files are under `docker/`: `docker/docker-compose.yml` is the base, production adds `docker/docker-compose.prod.yml`,
and TLS and site domains add `docker/docker-compose.tls.yml` and `docker/docker-compose.domains.yml`.
S3-compatible object storage and MeiliSearch are optional; by default media is on the local file system and search uses PostgreSQL.

Hardware: the minimum runnable deployment is 2 vCPU / 4 GB of memory with local storage; v1's scale acceptance is
measured on a fixed 4 vCPU / 8 GB (100 sites with 1,000 articles each, see section 9).

## 2. Installation

One command installs everything on a clean Ubuntu 24.04: Docker, the database image, the application, Caddy and the first
administrator. The script starts the database and the application first (with no public entry point), creates the first
administrator and checks that it can sign in, and starts Caddy last; secrets are written to files with mode 600, and
the installation log and output contain no password. On an existing installation the script changes nothing.
Steps, options and the files it leaves: [One-command installation](../../zh-CN/operations/install.md) (Chinese).

After installing, check:

- Studio is served only under the private admin path on the admin domain; the admin path returns 404 on public site domains. See [Private Admin Path](../deployment/private-admin-path.md).
- `/health/live` checks only that the process is alive, `/health/ready` that its dependencies are ready, and `/health` returns every health check.
- After a site domain is added and verified, its certificate is issued on the first visit. See [Custom domains and on-demand TLS](../deployment/custom-domains.md).

## 3. Configuration

All configuration is instance-level environment variables (the Compose env file). Secrets stay on the server and never
reach Git, logs or the frontend.

| Topic | Document |
|---|---|
| Every environment variable | [Environment variables](../deployment/environment-variables.md) |
| Production go-live checklist | [Production Deployment Checklist](../DEPLOYMENT-CHECKLIST.md) |
| Object storage (S3, R2, OSS, MinIO and others) | [Object storage](../deployment/object-storage.md) |
| Model providers and the instance default model | [Model providers](../deployment/model-providers.md) |
| The encryption key (`ENCRYPTION_KEY`) and its rotation | [Encryption Key Operations](../operations/encryption-keys.md) |
| External crawl services | [Crawl services](../../zh-CN/content/crawl-services.md) (Chinese) |

## 4. Backup and restore

With `HEOPRESS_BACKUP_TARGET` set (a local directory or S3-compatible storage), the worker backs up on schedule: the
database as a daily full backup plus hourly incrementals (small VPSs can choose full-only `pg_dump`), media as
incremental per-object sync, and configuration files only when encrypted. Every backup has a SHA-256 manifest and
optional encryption; whole restore chains are kept for 14 days / 8 weeks; a weekly drill restores the latest backup.

- Commands: `heopress backup run`, `list`, `verify`, `drill`, `prune`, `restore`, `finish-restore`, and per site `export-site` / `import-site`.
- The official application image has no PostgreSQL programs: run the backup commands on a host or helper container with Node 24 and the PostgreSQL 18 programs.
- Keep the backup key and the configuration separately and safely: without the key an encrypted backup cannot be restored.
- A restore replays the deletion ledger before writes open, so personal-data deletions already carried out do not come back with an old backup.

See [Backup and restore](../../zh-CN/operations/backup-restore.md) (Chinese; includes the optional pgBackRest setup).

## 5. Upgrades

`heopress upgrade` runs: compatibility check → backup → migration rehearsal on a copy of the database → maintenance mode
with every writer frozen → final backup → migration → application switch → smoke test → writes open.
A failed rehearsal never enters maintenance; a failure after entering maintenance restores the configuration, the
database and the previous application and opens writes only once that is verified; a failed restore stays in maintenance.

- Without a backup target the compatibility check fails and the upgrade does not start.
- **Once the new version has opened writes it cannot be rolled back**: restoring the old backup would lose everything written since; fix forward, or plan the data by hand.
- Plugin authors handle breaking plugin API changes with `heopress-ext codemod`.

See [Upgrades](../../zh-CN/operations/upgrades.md) (Chinese: every step and how failures are handled); the general version policy and rollback limits are in [Upgrade Operations](../operations/upgrades.md).

## 6. Data retention

Raw crawl snapshots, AI run record bodies, access details, change events and backups all have default retention
periods, adjustable with `HEOPRESS_RETENTION_*` environment variables; data still referenced by content in review, an
open dispute or a running task is not removed. Personal-data deletion requests win over every retention reference and
are written to the deletion ledger. Rewriting the history of a Git content repository has no automated interface; it is
done by hand after the owner approves.

See [Data retention](../operations/data-retention.md), [Git history rewrite (manual process)](../../ops/history-rewrite.md) (Chinese).

## 7. Frontend deployment targets

The backend always runs on the VPS only. Sites on the Astro engine can deploy their static output to your own server,
Cloudflare Pages, Vercel or Netlify; platform tokens are stored encrypted, the deployed version is updated only after
the platform confirms it is live, a failure leaves the previous version live, and you can roll back. The runtime
features a static target does not support are listed in its feature support matrix.
See [Static frontend deployments](../../zh-CN/publishing/frontend-deployments.md), [Astro static engine](../../zh-CN/rendering/astro-engine.md) (Chinese).

## 8. Monitoring

- Studio's Logs & monitoring module: reachability, site audits, background jobs and instance health (database, migrations, queues, storage and more), plus a read-only event stream. See [Logs and monitoring](../../zh-CN/studio/monitoring.md) (Chinese).
- Operational events (approval requests, budget alerts, agent incidents and more) can be pushed to IM or a webhook. See [Notifications](../../zh-CN/studio/notifications.md) (Chinese).
- An optional Prometheus / Grafana setup is under `docker/` (`docker/docker-compose.monitoring.yml`). See [Observability](../features/observability.md).

## 9. Security

- **Admin isolation**: Studio is served only under the private path on the admin domain, and public site domains have no admin entry; the rendering service reads only the public projection and sees no drafts or admin tables.
- **Outbound requests**: every external request (fetching, webhooks, deployment platforms, model services) goes through one SSRF-protected boundary. See [Outbound requests](../security/outbound-requests.md).
- **Secrets**: per-site platform tokens and model keys are sealed with the instance encryption key; no command or log prints a connection string or a secret.
- **Approval**: publishing approvals and batch plans are done by a person in Studio only; agents and API keys cannot bypass them.
- **Scans**: the public repository runs a dependency audit (`pnpm audit`), Gitleaks and Trivy image scans on every mirrored commit; exceptions are recorded in `security/exceptions.json` with an expiry date.
- **Reporting vulnerabilities**: report privately as described in `SECURITY.md` at the repository root; do not open a public issue.

Scale: v1's acceptance target is, at 100 sites with 1,000 articles each, a Classic-engine p95 below 50 ms for cache hits and below 400 ms for misses (fixed 4 vCPU / 8 GB, database and rendering on the same machine, 50 concurrent clients).
The v1 benchmark report and security review are maintainer records in the development repository and, by the release rules, are not exported to the public repository; their conclusions go into each version's release notes.
