# Data retention

What HeoPress keeps for how long, and the job that removes it (ADR-0013: an engineering default, not legal advice).
Each job works site by site in the site's row-level-security scope and logs a failure as a failed run.

| Data | Kept | Removed by |
|---|---|---|
| AI traffic details (one row per AI crawler request or AI-referred visit, with an IP hash) | 7 days; the day totals stay | `crawl-hits-purge`, hourly (P07) |
| Resolved audit issues (`lumibase_audit_issue_resolutions`: rule, title, the pages' item ids, paths and titles) | 90 days after resolution | `audit-triage-purge`, daily (P07a) |
| Ignored audit issues (`lumibase_audit_issue_states`) | until the time chosen (default 90 days, at most 365); then the issue is open again | read time immediately; rows removed by `audit-triage-purge` |
| Instance events (`lumibase_system_events`: scheduled jobs, account enable / disable) | 90 days | `system-events-purge`, daily (P07a) |
| Change events confirmed by every consumer | 30 days | change feed maintenance |

Planned, not yet implemented: raw crawl snapshots (90 days, P08), AI run prompts and outputs (90 days, P09),
backups (14 daily, 8 weekly, P13).
