# Data retention

What HeoPress keeps for how long, and the job that removes it (ADR-0013: an engineering default, not legal advice).
Each job works site by site in the site's row-level-security scope and logs a failure as a failed run.

| Data | Kept | Removed by |
|---|---|---|
| AI traffic details (one row per AI crawler request or AI-referred visit, with an IP hash) | 7 days; the day totals stay | `crawl-hits-purge`, hourly (P07) |
| Resolved audit issues (`lumibase_audit_issue_resolutions`: rule, title, the pages' item ids, paths and titles) | 90 days after resolution | `audit-triage-purge`, daily (P07a) |
| Ignored audit issues (`lumibase_audit_issue_states`) | until the time chosen (default 90 days, at most 365); then the issue is open again | read time immediately; rows removed by `audit-triage-purge` |
| Instance events (`lumibase_system_events`: scheduled jobs, account enable / disable) | 90 days | `system-events-purge`, daily (P07a) |
| Change events confirmed by every consumer | 30 days (`HEOPRESS_RETENTION_CHANGE_EVENT_DAYS`; a site's own `cdc_feed.retentionDays` wins) | change feed maintenance |
| Raw crawl snapshots | 90 days (`HEOPRESS_RETENTION_SNAPSHOT_DAYS`); kept while content in review, an open dispute or a running task references them; then a tombstone (hash, rule version, time, reason) | `data-retention`, daily (P13) |
| AI run record bodies (the full model output of a completed call) | 90 days (`HEOPRESS_RETENTION_AI_RUN_BODY_DAYS`); provider, model, tokens and cost stay | `data-retention` |
| Backups | 14 daily, 8 weekly (`HEOPRESS_RETENTION_BACKUP_DAILY`, `HEOPRESS_RETENTION_BACKUP_WEEKLY`) | `data-retention`, through the pruner the backup module registers |

The AI traffic detail period is `HEOPRESS_RETENTION_ACCESS_DETAIL_DAYS` (default 7). Personal-data deletion requests win
over every retention reference and are written to the deletion ledger, which a restore replays before writes open
(`replayDeletionLedger`, ledger directory `HEOPRESS_DELETION_LEDGER_DIR`). The full description — snapshot holds,
erasure of snapshots, the ledger and its replay — is the Chinese page
[数据保留](../../zh-CN/operations/data-retention.md); rewriting Git history is a manual process,
[docs/ops/history-rewrite.md](../../ops/history-rewrite.md).
